<?php
declare(strict_types=1);
// Rollback protection for the ledger database. Include-only: a direct request gets a 404.
//
// The SQLite file is the only copy of a single authority coin's log. Restoring an older copy of it (a backup put back, a host
// that rolled the disk back, an operator's mistake) brings back balances that were already spent, and nothing inside the file
// can tell. This keeps a second, small record of how far each coin got in a private folder beside the database, and refuses
// new entries when the database is behind it.
//
// Per coin, two append-only files of JSON lines. Every line carries the sum of the line before it, so a changed or missing
// line shows, and a line cut short by a crash is told apart from damage:
//   <coin>.log      what was about to be written and what was written, plus the decisions made after a problem
//     adopt     the head of a coin that had no checkpoint yet (a ledger from before this existed, or a new coin)
//     intent    entry N is about to be committed to the database; written before the commit, never a floor
//     commit    entry N is in the database; the floor: the database must never hold less
//     halt      the database was found behind (rollback), on another history (conflict) or the log is damaged
//     restored  the lost entries were put back and the database holds the floor again
//     accept    the operator accepted the loss; the coin stays stopped for good
//     reseal    the operator started a new checkpoint file after damage
//   <coin>.journal  every committed entry in full (both forms), so lost entries can be replayed with every check
//
// The order that makes a crash different from a rollback: the intent line is written, then the database commits, then the
// commit line. A crash after the intent leaves the database one entry ahead of the floor, and that entry is the intent's: the
// next call finishes the commit line. A database behind the floor, or holding another hash at the floor's index, cannot come
// from a crash and stops the coin.
//
// This guards against accidents and lazy restores. An operator who can restore the database can restore this folder too, which
// is why a signed head that someone else keeps is also needed (docs/chain-labs-rollback-protection.md).
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; }

const GUARD_ZERO = '0000000000000000000000000000000000000000000000000000000000000000';
const GUARD_TAIL_BYTES = 16384;
const GUARD_MAX_LINE = 1048576;
const GUARD_LOST_LISTED = 100;

// ---------- where the files are ----------

function guard_registry(): WeakMap
{
    static $registry = null;
    return $registry ??= new WeakMap();
}

// $dir is the private folder for this database's checkpoints; null switches the guard off (an in-memory database).
function ledger_guard_attach(PDO $db, ?string $dir): void
{
    guard_registry()[$db] = $dir;
}

function ledger_guard_dir(PDO $db): ?string
{
    $registry = guard_registry();
    return isset($registry[$db]) ? $registry[$db] : null;
}

function guard_file(PDO $db, string $coinId, string $kind): string
{
    $dir = ledger_guard_dir($db);
    if ($dir === null || !preg_match('/^[a-f0-9]{32}$/D', $coinId) || !in_array($kind, ['log', 'journal'], true)) throw new RuntimeException('no checkpoint location');
    return $dir . '/' . $coinId . '.' . $kind;
}

// The folder must be private: made 0700, and never inside the web root when one is known.
function guard_prepare_dir(string $dir): void
{
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) throw new RuntimeException('the checkpoint folder cannot be created');
    $real = realpath($dir);
    $root = isset($_SERVER['DOCUMENT_ROOT']) && $_SERVER['DOCUMENT_ROOT'] !== '' ? realpath((string) $_SERVER['DOCUMENT_ROOT']) : false;
    if ($real === false || ($root !== false && str_starts_with($real . '/', $root . '/'))) throw new RuntimeException('the checkpoint folder is not private');
    if (!is_writable($dir)) throw new RuntimeException('the checkpoint folder cannot be written');
}

// ---------- lines ----------

// One line, if its own sum holds.
function guard_line(string $piece): ?array
{
    $row = strlen($piece) <= GUARD_MAX_LINE ? json_decode($piece, true) : null;
    if (!is_array($row) || !is_string($row['sum'] ?? null) || !is_string($row['prevSum'] ?? null)) return null;
    $body = $row;
    unset($body['sum']);
    try { return hash_equals(hash('sha256', ledger_canonical($body)), $row['sum']) ? $row : null; } catch (Throwable $e) { return null; }
}

// Reads lines out of text. A piece after the last newline is a write that was cut short; a line whose own sum does not hold is
// ignored the same way, as long as the lines after it still follow the last good one. A good line that does not follow the one
// before it means something was changed or removed.
function guard_parse(string $text, bool $windowed): array
{
    $pieces = explode("\n", $text);
    $tail = array_pop($pieces);
    if ($windowed && $pieces) array_shift($pieces);
    $good = [];
    $junk = $tail !== '' ? 1 : 0;
    $expect = null;
    $corrupt = null;
    foreach ($pieces as $piece) {
        if ($piece === '') continue;
        $row = guard_line($piece);
        $ok = $row !== null;
        if (!$ok) { $junk++; continue; }
        if ($expect === null) {
            if (!$windowed && $row['prevSum'] !== GUARD_ZERO) { $corrupt = 'the first line does not begin the chain'; break; }
        } elseif ($row['prevSum'] !== $expect) {
            $corrupt = 'a line does not follow the one before it';
            break;
        }
        $good[] = $row;
        $expect = $row['sum'];
    }
    return ['lines' => $good, 'junk' => $junk, 'corrupt' => $corrupt, 'lastSum' => $expect];
}

// What a file says now. Reads from the end, growing the window until it holds the latest floor, or the whole file.
function guard_read(string $file, bool $needFloor = true): array
{
    clearstatcache(true, $file);
    if (!is_file($file)) return ['exists' => false, 'lines' => [], 'junk' => 0, 'corrupt' => null, 'lastSum' => null];
    $size = (int) filesize($file);
    $window = GUARD_TAIL_BYTES;
    while (true) {
        $from = max(0, $size - $window);
        $text = (string) file_get_contents($file, false, null, $from, $size - $from);
        $parsed = guard_parse($text, $from > 0);
        $enough = $from === 0 || ($parsed['lines'] && (!$needFloor || guard_state($parsed['lines'])['floor'] !== null));
        if ($parsed['corrupt'] !== null || $enough) return ['exists' => true] + $parsed;
        $window *= 4;
    }
}

// Appends one line under a lock and flushes it to the disk. Returns the line written.
function guard_append(string $file, array $body): array
{
    guard_prepare_dir(dirname($file));
    $handle = @fopen($file, 'a+b');
    if (!$handle) throw new RuntimeException('a checkpoint file cannot be opened');
    try {
        if (!flock($handle, LOCK_EX)) throw new RuntimeException('a checkpoint file cannot be locked');
        $read = guard_read($file, false);
        if ($read['corrupt'] !== null) throw new RuntimeException('the checkpoint file is damaged');
        $size = (int) fstat($handle)['size'];
        $prefix = '';
        if ($size > 0) { fseek($handle, $size - 1); if (fread($handle, 1) !== "\n") $prefix = "\n"; }
        $body['prevSum'] = $read['lastSum'] ?? GUARD_ZERO;
        $line = $body + ['sum' => hash('sha256', ledger_canonical($body))];
        $text = $prefix . ledger_canonical($line) . "\n";
        if (strlen($text) > GUARD_MAX_LINE || fwrite($handle, $text) !== strlen($text)) throw new RuntimeException('a checkpoint line cannot be written');
        fflush($handle);
        if (function_exists('fsync')) fsync($handle);
        @chmod($file, 0600);
        return $line;
    } finally {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}

// Every good line of a file in order, one at a time (a journal can be large). Stops with the reason if the chain breaks.
function guard_each(string $file, callable $each): ?string
{
    if (!is_file($file)) return null;
    $handle = fopen($file, 'rb');
    if (!$handle) return 'the file cannot be read';
    $expect = null;
    $problem = null;
    while (($piece = fgets($handle, GUARD_MAX_LINE + 2)) !== false) {
        if (!str_ends_with($piece, "\n")) break;
        $piece = rtrim($piece, "\n");
        if ($piece === '') continue;
        $row = guard_line($piece);
        if ($row === null) continue;
        if ($expect !== null && $row['prevSum'] !== $expect) { $problem = 'a line does not follow the one before it'; break; }
        if ($expect === null && $row['prevSum'] !== GUARD_ZERO) { $problem = 'the first line does not begin the chain'; break; }
        $expect = $row['sum'];
        if ($each($row) === false) break;
    }
    fclose($handle);
    return $problem;
}

// ---------- what the log of a coin says ----------

// The floor is the highest entry known committed; a halt stands until a restore, and an acceptance ends the coin for good.
function guard_state(array $lines): array
{
    $floor = null;
    $halt = null;
    $intent = null;
    foreach ($lines as $line) {
        $kind = $line['kind'] ?? '';
        if (in_array($kind, ['adopt', 'commit', 'restored', 'reseal'], true) && is_int($line['index'] ?? null) && is_string($line['hash'] ?? null)) {
            if ($kind === 'reseal' || $floor === null || $line['index'] >= $floor['index']) $floor = ['index' => $line['index'], 'hash' => $line['hash']];
            if ($kind === 'restored' || $kind === 'reseal') $halt = null;
        } elseif ($kind === 'intent') {
            $intent = ['index' => $line['index'] ?? null, 'hash' => $line['hash'] ?? null];
        } elseif ($kind === 'halt') {
            $halt = ['reason' => (string) ($line['reason'] ?? 'conflict'), 'detail' => $line['detail'] ?? [], 'at' => $line['at'] ?? 0, 'accepted' => false];
        } elseif ($kind === 'accept' && $halt !== null) {
            $halt['accepted'] = true;
            $halt['acceptance'] = $line['detail'] ?? [];
        }
    }
    return ['floor' => $floor, 'halt' => $halt, 'intent' => $intent];
}

function guard_hash_at(PDO $db, string $coinId, int $index): ?string
{
    $q = $db->prepare('SELECT hash FROM ledger_log WHERE coin_id=? AND idx=?');
    $q->execute([$coinId, $index]);
    $hash = $q->fetchColumn();
    return $hash === false ? null : (string) $hash;
}

function guard_halted(string $reason, array $detail, bool $accepted = false): array
{
    return ['status' => 'halted', 'reason' => $reason, 'detail' => $detail, 'accepted' => $accepted];
}

// ---------- the journal ----------

// The newest journaled entry: [index, hash], or null.
function guard_journal_last(string $file): ?array
{
    $read = guard_read($file, false);
    if ($read['corrupt'] !== null) throw new RuntimeException('the journal is damaged');
    for ($i = count($read['lines']) - 1; $i >= 0; $i--) {
        $line = $read['lines'][$i];
        if (($line['kind'] ?? null) === 'entry' && is_int($line['index'] ?? null)) return ['index' => $line['index'], 'hash' => (string) $line['hash']];
    }
    return null;
}

// The newest entry the journal holds, or null when there is no journal or it cannot be read (the caller's other checks then decide).
function guard_journal_tail(PDO $db, string $coinId): ?array
{
    try {
        $file = guard_file($db, $coinId, 'journal');
        return is_file($file) ? guard_journal_last($file) : null;
    } catch (RuntimeException $e) {
        return null;
    }
}

// Copies the entries the journal lacks from the database, in order. Fails if the journal is of another history. One process at a time:
// two that read the same last entry would both append what follows it.
function guard_journal_sync(PDO $db, string $coinId, int $now): void
{
    $file = guard_file($db, $coinId, 'journal');
    guard_prepare_dir(dirname($file));
    $lock = @fopen($file . '.lock', 'c');
    if (!$lock || !flock($lock, LOCK_EX)) throw new RuntimeException('the journal cannot be locked');
    try {
        @chmod($file . '.lock', 0600);
        $last = guard_journal_last($file);
        $head = ledger_head($db, $coinId);
        if ($last !== null) {
            $held = guard_hash_at($db, $coinId, $last['index']);
            if ($held !== null && $held !== $last['hash']) throw new RuntimeException('the journal is of another history');
        }
        $after = $last === null ? -1 : $last['index'];
        while ($after < $head['index']) {
            $records = ledger_records_after($db, $coinId, $after, LEDGER_PAGE_MAX);
            if (!$records) break;
            foreach ($records as $record) {
                guard_append($file, ['v' => 1, 'kind' => 'entry', 'coinId' => $coinId, 'index' => $record['index'], 'hash' => $record['hash'], 'at' => $now, 'record' => $record]);
                $after = $record['index'];
            }
        }
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

// ---------- checking ----------

function guard_write_halt(PDO $db, string $coinId, string $reason, array $detail, int $now): void
{
    try {
        guard_append(guard_file($db, $coinId, 'log'), ['v' => 1, 'kind' => 'halt', 'coinId' => $coinId, 'reason' => $reason, 'detail' => $detail, 'at' => $now]);
    } catch (Throwable $e) {
        // The verdict does not depend on the line being written: the next check reaches it again.
    }
}

// Compares the database with the floor. status is one of
//   ok         the database holds the floor (or the coin has no entries yet)
//   adopted    the coin had no checkpoint and now has one (only with $repair)
//   repaired   the database was ahead of the floor by an entry whose intent was written, as after a crash, and the floor caught up
//   unsealed   no checkpoint yet; read only
//   halted     reason: rollback, conflict or checkpoint-corrupt
//   off        no checkpoint folder for this database
// With $repair false nothing is written, so a read can report the verdict without changing anything.
function ledger_guard_check(PDO $db, string $coinId, bool $repair = true, ?int $now = null): array
{
    $now ??= time();
    if (ledger_guard_dir($db) === null) return ['status' => 'off'];
    ledger_coin($db, $coinId);
    try {
        $file = guard_file($db, $coinId, 'log');
        $read = guard_read($file);
        if ($read['corrupt'] !== null) return guard_halted('checkpoint-corrupt', ['problem' => $read['corrupt']]);
        $state = guard_state($read['lines']);
        // An entry is journaled only once the database has committed it, so a journal that holds an entry the database no longer does
        // is as good a record as a commit line, and it survives a crash between the journal and the commit line. Both records are read
        // before the database's head: another process may commit and journal an entry in between, and a head read earlier than the
        // journal would then look like a rollback.
        $journaled = guard_journal_tail($db, $coinId);
        $head = ledger_head($db, $coinId);
        $floor = $state['floor'];
        if ($floor !== null && $journaled !== null && $journaled['index'] > $head['index'] && $journaled['index'] > $floor['index']) $floor = $journaled;
        // A coin stopped for a rollback runs again once the database holds the floor's entry again, however it got there (the lost
        // entries replayed, or a newer copy of the database put back).
        if ($state['halt'] !== null && $state['halt']['reason'] === 'rollback' && !$state['halt']['accepted'] && $floor !== null && $head['index'] >= $floor['index'] && guard_hash_at($db, $coinId, $floor['index']) === $floor['hash']) {
            if ($repair) guard_append($file, ['v' => 1, 'kind' => 'restored', 'coinId' => $coinId, 'index' => $floor['index'], 'hash' => $floor['hash'], 'at' => $now]);
            $state['halt'] = null;
        }
        if ($state['halt'] !== null) return guard_halted($state['halt']['reason'], $state['halt']['detail'] + ['since' => $state['halt']['at']], $state['halt']['accepted']);
        if ($floor === null) {
            if ($head['index'] < 0) return ['status' => 'ok', 'head' => $head];
            if (!$repair) return ['status' => 'unsealed', 'head' => $head];
            guard_journal_sync($db, $coinId, $now);
            guard_append($file, ['v' => 1, 'kind' => 'adopt', 'coinId' => $coinId, 'index' => $head['index'], 'hash' => $head['hash'], 'at' => $now]);
            return ['status' => 'adopted', 'head' => $head];
        }
        $detail = ['floorIndex' => $floor['index'], 'floorHash' => $floor['hash'], 'databaseIndex' => $head['index'], 'databaseHash' => $head['hash']];
        if ($head['index'] < $floor['index']) {
            if ($repair) guard_write_halt($db, $coinId, 'rollback', $detail, $now);
            return guard_halted('rollback', $detail);
        }
        $held = guard_hash_at($db, $coinId, $floor['index']);
        if ($held !== $floor['hash']) {
            $detail['databaseHashAtFloor'] = $held;
            if ($repair) guard_write_halt($db, $coinId, 'conflict', $detail, $now);
            return guard_halted('conflict', $detail);
        }
        if ($head['index'] > $floor['index']) {
            if (!$repair) return ['status' => 'ok', 'head' => $head, 'floor' => $floor, 'ahead' => $head['index'] - $floor['index']];
            guard_journal_sync($db, $coinId, $now);
            guard_append($file, ['v' => 1, 'kind' => 'commit', 'coinId' => $coinId, 'index' => $head['index'], 'hash' => $head['hash'], 'at' => $now, 'repair' => true]);
            return ['status' => 'repaired', 'head' => $head, 'floor' => $floor];
        }
        return ['status' => 'ok', 'head' => $head, 'floor' => $floor];
    } catch (LedgerError $e) {
        throw $e;
    } catch (RuntimeException $e) {
        if (str_contains($e->getMessage(), 'another history')) {
            $detail = ['problem' => $e->getMessage()];
            if ($repair) guard_write_halt($db, $coinId, 'conflict', $detail, $now);
            return guard_halted('conflict', $detail);
        }
        if (str_contains($e->getMessage(), 'damaged')) return guard_halted('checkpoint-corrupt', ['problem' => $e->getMessage()]);
        throw new LedgerError('checkpoint-unavailable', 'the checkpoint folder cannot be used: ' . $e->getMessage());
    }
}

const GUARD_CODES = ['rollback' => 'rollback-detected', 'conflict' => 'checkpoint-conflict', 'checkpoint-corrupt' => 'checkpoint-corrupt'];

// Refuses new entries on a coin whose checkpoint says the database is wrong. Entries replayed from history are still taken while
// the coin is stopped for a rollback that nobody has accepted, since that is how the lost entries come back.
function ledger_guard_require(PDO $db, string $coinId, bool $history = false): void
{
    $verdict = ledger_guard_check($db, $coinId, true);
    if ($verdict['status'] !== 'halted') return;
    if ($history && $verdict['reason'] === 'rollback' && !$verdict['accepted']) return;
    $why = $verdict['accepted'] ? ' The loss was accepted and the coin stays stopped.' : '';
    ledger_fail(GUARD_CODES[$verdict['reason']] ?? 'checkpoint-conflict', 'this coin is stopped: ' . match ($verdict['reason']) {
        'rollback' => 'the ledger database holds fewer entries than this domain has already committed (it was restored from an older copy).',
        'conflict' => 'the ledger database holds a different history from the one this domain committed.',
        default => 'the checkpoint record is damaged.',
    } . $why);
}

// Whether entries replayed from history may be written into a coin that is frozen: only while its checkpoint says the database was
// rolled back and the coin was frozen for nothing but that.
function ledger_guard_may_restore(PDO $db, string $coinId): bool
{
    try {
        $verdict = ledger_guard_check($db, $coinId, false);
    } catch (Throwable $e) {
        return false;
    }
    if ($verdict['status'] !== 'halted' || $verdict['reason'] !== 'rollback' || $verdict['accepted']) return false;
    $kinds = array_unique(array_column(ledger_evidence($db, $coinId), 'kind'));
    return !array_diff($kinds, ['rollback', 'resumed']);
}

// Whether a coin takes nothing new because of its checkpoint, without writing anything.
function ledger_guard_halted(PDO $db, string $coinId): ?string
{
    try {
        $verdict = ledger_guard_check($db, $coinId, false);
    } catch (Throwable $e) {
        return null;
    }
    return $verdict['status'] === 'halted' ? $verdict['reason'] : null;
}

// What a coin's state is shown as: a coin stopped by its checkpoint is shown as frozen, so wallets and scanners stop sending to it, while
// the database still says active.
function ledger_state_shown(PDO $db, array $coin): string
{
    return $coin['state'] === 'active' && ledger_guard_halted($db, $coin['coin_id']) !== null ? 'frozen' : $coin['state'];
}

// ---------- around a commit ----------

// Before the database commits (inside its transaction): write the intent. While a coin is stopped for a rollback, an entry
// replayed from history is let through, and must be the very entry the floor names when it reaches the floor's index.
// Returns whether this entry is part of a restore. Refuses, so nothing commits, when the intent cannot be written.
function ledger_guard_before(PDO $db, string $coinId, array $public, string $hash, bool $history, int $now): bool
{
    if (ledger_guard_dir($db) === null) return false;
    try {
        $read = guard_read(guard_file($db, $coinId, 'log'));
        $state = guard_state($read['lines']);
        if ($read['corrupt'] === null && $state['halt'] !== null && $history && $state['halt']['reason'] === 'rollback' && !$state['halt']['accepted'] && $state['floor'] !== null) {
            if ($public['index'] === $state['floor']['index'] && $hash !== $state['floor']['hash']) {
                guard_write_halt($db, $coinId, 'conflict', ['floorIndex' => $state['floor']['index'], 'floorHash' => $state['floor']['hash'], 'replayedHash' => $hash], $now);
                ledger_fail('checkpoint-conflict', 'the replayed entry is not the one this domain committed at that index');
            }
            return true;
        }
        guard_append(guard_file($db, $coinId, 'log'), ['v' => 1, 'kind' => 'intent', 'coinId' => $coinId, 'index' => $public['index'], 'hash' => $hash, 'at' => $now]);
        return false;
    } catch (LedgerError $e) {
        throw $e;
    } catch (RuntimeException $e) {
        throw new LedgerError('checkpoint-unavailable', 'the checkpoint cannot be written, so nothing new is committed: ' . $e->getMessage());
    }
}

// After the database committed: journal the entry and move the floor. It cannot fail the commit, which is done; a line that is
// not written is made up by the next check from the intent.
function ledger_guard_after(PDO $db, string $coinId, array $public, string $hash, bool $restoring, int $now): void
{
    if (ledger_guard_dir($db) === null) return;
    try {
        guard_journal_sync($db, $coinId, $now);
        $file = guard_file($db, $coinId, 'log');
        if ($restoring) {
            $state = guard_state(guard_read($file)['lines']);
            if ($state['floor'] !== null && $public['index'] === $state['floor']['index'] && $hash === $state['floor']['hash']) {
                guard_append($file, ['v' => 1, 'kind' => 'restored', 'coinId' => $coinId, 'index' => $public['index'], 'hash' => $hash, 'at' => $now]);
            }
            return;
        }
        guard_append($file, ['v' => 1, 'kind' => 'commit', 'coinId' => $coinId, 'index' => $public['index'], 'hash' => $hash, 'at' => $now]);
    } catch (Throwable $e) {
    }
}

// ---------- recovery ----------

// Replays journaled entries after the database's head, each through the checks of a mirror. The database must be on the journal's
// history. Returns [applied, status]: the coin runs again only when the database holds the floor's entry again.
function ledger_guard_replay(PDO $db, string $coinId, int $now): array
{
    $verdict = ledger_guard_check($db, $coinId, true, $now);
    if ($verdict['status'] !== 'halted' || $verdict['reason'] !== 'rollback' || $verdict['accepted']) return ['applied' => 0, 'status' => $verdict['status'], 'verdict' => $verdict];
    $head = ledger_head($db, $coinId);
    $applied = 0;
    $error = null;
    $problem = guard_each(guard_file($db, $coinId, 'journal'), function (array $line) use ($db, $coinId, &$head, &$applied, &$error) {
        if (($line['kind'] ?? null) !== 'entry' || !is_int($line['index'] ?? null) || $line['index'] <= $head['index']) return true;
        if ($line['index'] !== $head['index'] + 1) { $error = 'the journal has no entry ' . ($head['index'] + 1); return false; }
        try {
            ledger_mirror_apply($db, $coinId, $line['record']);
        } catch (LedgerError $e) {
            $error = $e->reason . ': ' . $e->getMessage();
            return false;
        }
        $head = ledger_head($db, $coinId);
        $applied++;
        return true;
    });
    $after = ledger_guard_check($db, $coinId, true, $now);
    return ['applied' => $applied, 'status' => $after['status'], 'verdict' => $after, 'error' => $error ?? $problem];
}

// The operator's acceptance that entries are lost for good. Nothing is replayed and nothing resumes: the coin is frozen in the
// database and stays stopped by its checkpoint, so the balances that came back are never spent again. $confirm must repeat the
// floor and the database head exactly as the stopped coin reports them.
function ledger_guard_accept(PDO $db, string $coinId, array $confirm, string $reason, int $now): array
{
    $verdict = ledger_guard_check($db, $coinId, true, $now);
    if ($verdict['status'] !== 'halted' || $verdict['reason'] !== 'rollback') ledger_fail('not-halted', 'only a coin stopped for a rollback can have its loss accepted');
    $d = $verdict['detail'];
    if (($confirm['floorIndex'] ?? null) !== $d['floorIndex'] || ($confirm['floorHash'] ?? null) !== $d['floorHash'] || ($confirm['databaseIndex'] ?? null) !== $d['databaseIndex']) ledger_fail('confirm-mismatch', 'the confirmation does not match what the coin reports');
    if (trim($reason) === '') ledger_fail('reason-needed', 'say why the loss is accepted');
    $lost = [];
    $journal = guard_file($db, $coinId, 'journal');
    guard_each($journal, function (array $line) use (&$lost, $d) {
        if (($line['kind'] ?? null) === 'entry' && $line['index'] > $d['databaseIndex'] && $line['index'] <= $d['floorIndex'] && count($lost) < GUARD_LOST_LISTED) {
            $p = $line['record']['public'] ?? [];
            $lost[] = ['index' => $line['index'], 'hash' => $line['hash'], 'type' => $p['type'] ?? null, 'amount' => $p['amount'] ?? null, 'executedAt' => $p['executedAt'] ?? null];
        }
        return true;
    });
    $detail = ['reason' => $reason, 'floorIndex' => $d['floorIndex'], 'floorHash' => $d['floorHash'], 'databaseIndex' => $d['databaseIndex'], 'lostCount' => $d['floorIndex'] - $d['databaseIndex'], 'lost' => $lost];
    try {
        guard_append(guard_file($db, $coinId, 'log'), ['v' => 1, 'kind' => 'accept', 'coinId' => $coinId, 'detail' => $detail, 'at' => $now]);
    } catch (RuntimeException $e) {
        ledger_fail('checkpoint-unavailable', 'the acceptance cannot be recorded: ' . $e->getMessage());
    }
    ledger_freeze($db, $coinId, 'rollback-accepted', $detail, $now);
    return $detail;
}

// A damaged checkpoint file is set aside and a new one begun from the database, but only when the database passes the checker and
// the journal holds nothing beyond it (which would mean entries are missing: restore them first). The old file is kept.
function ledger_guard_reseal(PDO $db, string $coinId, array $confirm, int $now): array
{
    $file = guard_file($db, $coinId, 'log');
    $read = guard_read($file);
    if ($read['corrupt'] === null) ledger_fail('not-damaged', 'the checkpoint file is not damaged');
    $head = ledger_head($db, $coinId);
    if (($confirm['databaseIndex'] ?? null) !== $head['index'] || ($confirm['databaseHash'] ?? null) !== $head['hash']) ledger_fail('confirm-mismatch', 'the confirmation does not match the database head');
    $problems = ledger_check($db, $coinId);
    if ($problems) ledger_fail('database-invalid', 'the database does not pass the checker: ' . $problems[0]);
    try {
        $last = guard_journal_last(guard_file($db, $coinId, 'journal'));
    } catch (RuntimeException $e) {
        $last = null;
    }
    if ($last !== null && $last['index'] > $head['index']) ledger_fail('entries-missing', 'the journal holds entries beyond the database: restore them first');
    $aside = $file . '.damaged-' . gmdate('Ymd\THis\Z', $now);
    if (!@rename($file, $aside)) ledger_fail('checkpoint-unavailable', 'the damaged file cannot be set aside');
    $journal = guard_file($db, $coinId, 'journal');
    if (is_file($journal) && guard_each($journal, fn() => true) !== null) @rename($journal, $journal . '.damaged-' . gmdate('Ymd\THis\Z', $now));
    guard_journal_sync($db, $coinId, $now);
    guard_append($file, ['v' => 1, 'kind' => 'reseal', 'coinId' => $coinId, 'index' => $head['index'], 'hash' => $head['hash'], 'at' => $now, 'previous' => basename($aside)]);
    return ['index' => $head['index'], 'hash' => $head['hash'], 'keptAs' => basename($aside)];
}

// Every coin that has a checkpoint, with its verdict, including coins the database no longer knows (a database restored from
// before they were opened). Read only.
function ledger_guard_scan(PDO $db): array
{
    $dir = ledger_guard_dir($db);
    $out = [];
    if ($dir === null || !is_dir($dir)) return $out;
    foreach (glob($dir . '/*.log') ?: [] as $file) {
        $coinId = basename($file, '.log');
        if (!preg_match('/^[a-f0-9]{32}$/D', $coinId)) continue;
        $known = $db->prepare('SELECT 1 FROM ledger_coins WHERE coin_id=?');
        $known->execute([$coinId]);
        if (!$known->fetchColumn()) {
            $state = guard_state(guard_read($file)['lines']);
            $out[$coinId] = $state['floor'] === null ? ['status' => 'ok'] : guard_halted('rollback', ['floorIndex' => $state['floor']['index'], 'floorHash' => $state['floor']['hash'], 'databaseIndex' => -1, 'coinMissing' => true]);
            continue;
        }
        $out[$coinId] = ledger_guard_check($db, $coinId, false);
    }
    return $out;
}
