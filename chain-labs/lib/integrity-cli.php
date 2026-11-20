<?php
declare(strict_types=1);
// A read-only integrity check of every coin in a domain's ledger, for the command line and cron. Not served over the web: a request for it
// gets a 404.
//
//   php integrity-cli.php [--private=DIR] [--database=NAME] [--coin=ID] [--quiet] [--json] [--strict] [--help]
//
// For each coin it reports one status, ok, warning or FAIL, from these checks:
//   - the ledger invariants (lib/ledger.php ledger_check): hashes, signatures, approvals, balances, supply, sale records
//   - the checkpoint (lib/checkpoint.php ledger_guard_check, read only): a database behind or on another history than the floor, a damaged log
//   - the journal: readable, and its newest entry is the one the database holds at that index
//   - the permanent sale closures: the closed-sales file is readable, every sale the database holds as closed is in it, and no closed
//     sale has an entry
//   - a coin whose opening was never finished, and a coin that is frozen
//
// It changes nothing: the database is opened read only, nothing is written beside it, and it never repairs, reseals, restores or accepts
// a rollback. That stays an operator's decision (docs/chain-labs-rollback-protection.md).
//
// Exit status: 0 nothing wrong (warnings are listed but do not fail unless --strict), 1 a coin has an integrity problem, 2 the check
// could not run. What it prints is coin ids, symbols, states, entry numbers and short reasons; paths, keys and tokens are never printed.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__ . '/ledger.php';

// Text for the output: no path of this machine, no key or long secret-looking string, and a bounded length.
function integrity_clean(string $text, array $hide): string
{
    foreach ($hide as $path) {
        if (is_string($path) && strlen($path) > 3) $text = str_replace($path, '<private>', $text);
    }
    $text = preg_replace('/-----BEGIN [A-Z ]+-----.*?(-----END [A-Z ]+-----|$)/s', '<key removed>', $text) ?? '';
    $text = preg_replace('~(?:/[A-Za-z0-9._-]+){3,}~', '<path>', $text) ?? '';
    $text = preg_replace('/[A-Za-z0-9_+\/=-]{80,}/', '<removed>', $text) ?? '';
    $text = preg_replace('/[^\x20-\x7e]/', ' ', $text) ?? '';
    return strlen($text) > 240 ? substr($text, 0, 237) . '...' : $text;
}

// The ledger database opened for reading only. ledger_open() would create tables and migrate, which this must never do.
function integrity_open(string $file): PDO
{
    $uri = 'file:' . str_replace(['%', '?', '#'], ['%25', '%3f', '%23'], $file) . '?mode=ro';
    $db = new PDO('sqlite:' . $uri, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5]);
    $db->exec('PRAGMA busy_timeout=5000');
    $db->exec('PRAGMA query_only=ON');
    ledger_guard_attach($db, $file . '.checkpoints');
    return $db;
}

function integrity_has_table(PDO $db, string $table): bool
{
    $q = $db->prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?");
    $q->execute([$table]);
    return $q->fetchColumn() !== false;
}

// Every finding of one coin: ['level' => 'warning'|'FAIL'|'info', 'code' => short name, 'text' => what is wrong]. No finding means ok.
function integrity_coin(PDO $db, string $coinId): array
{
    $found = [];
    $add = static function (string $level, string $code, string $text) use (&$found): void { $found[] = ['level' => $level, 'code' => $code, 'text' => $text]; };
    try {
        $coin = ledger_coin($db, $coinId);
    } catch (Throwable $e) {
        return [['level' => 'FAIL', 'code' => 'unreadable-coin', 'text' => 'the coin record cannot be read']];
    }
    $head = ledger_head($db, $coinId);

    if ($coin['state'] === 'pending') {
        if ($coin['mode'] === 'single') $add('warning', 'opening-unfinished', 'the coin was registered but its opening never finished; repeating the open completes it');
        else $add('info', 'waiting-for-signatures', 'the coin is waiting for the other domains to sign its genesis');
        return $found;
    }
    if ($coin['state'] === 'frozen') {
        $kinds = array_values(array_unique(array_column(ledger_evidence($db, $coinId), 'kind')));
        $add('warning', 'frozen', 'the coin is frozen' . ($kinds ? ' (' . implode(', ', array_map('strval', $kinds)) . ')' : ''));
    }

    // The ledger invariants.
    try {
        $problems = ledger_check($db, $coinId);
        foreach (array_slice($problems, 0, 10) as $p) $add('FAIL', 'invariant', (string) $p);
        if (count($problems) > 10) $add('FAIL', 'invariant', (count($problems) - 10) . ' more problems not listed');
    } catch (Throwable $e) {
        $add('FAIL', 'invariant', 'the ledger check could not finish: ' . $e->getMessage());
    }

    // The checkpoint: read only, never repairing.
    try {
        $v = ledger_guard_check($db, $coinId, false);
        if ($v['status'] === 'halted') {
            $why = (string) $v['reason'] . (isset($v['detail']['floorIndex'], $v['detail']['databaseIndex']) ? ' (the checkpoint holds entry ' . $v['detail']['floorIndex'] . ', the database ' . $v['detail']['databaseIndex'] . ')' : '');
            if ($v['accepted']) $add('warning', 'loss-accepted', 'the operator accepted this loss and the coin stays stopped: ' . $why);
            else $add('FAIL', 'checkpoint-halted', 'the checkpoint stops this coin: ' . $why);
        } elseif ($v['status'] === 'unsealed') {
            $add('warning', 'no-checkpoint', 'the coin holds entries but has no checkpoint record yet; the first entry written to it will adopt it');
        } elseif ($v['status'] === 'off') {
            $add('warning', 'checkpoint-off', 'no checkpoint folder is attached to this database');
        }
    } catch (LedgerError $e) {
        $add('FAIL', 'checkpoint-unavailable', $e->getMessage());
    } catch (Throwable $e) {
        $add('FAIL', 'checkpoint-unavailable', 'the checkpoint cannot be read');
    }

    // The journal: readable, and of the same history as the database.
    try {
        $journal = guard_file($db, $coinId, 'journal');
        $last = is_file($journal) ? guard_journal_last($journal) : null;
        if ($last !== null) {
            $held = guard_hash_at($db, $coinId, $last['index']);
            if ($held !== null && $held !== $last['hash']) $add('FAIL', 'journal-conflict', 'the journal holds another entry ' . $last['index'] . ' than the database');
        }
    } catch (RuntimeException $e) {
        $add('FAIL', 'journal-damaged', 'the journal is damaged or cannot be read');
    }

    // The permanent sale closures.
    $rows = [];
    if (integrity_has_table($db, 'ledger_closed_sales')) {
        $q = $db->prepare('SELECT request_id FROM ledger_closed_sales WHERE coin_id=?');
        $q->execute([$coinId]);
        $rows = array_fill_keys($q->fetchAll(PDO::FETCH_COLUMN), true);
    }
    $filed = null;
    try {
        $filed = guard_closed_ids($db, $coinId);
    } catch (RuntimeException $e) {
        $add('FAIL', 'closed-file-damaged', 'the closed-sales file is damaged or cannot be read');
    }
    if ($filed !== null) {
        $missing = array_diff_key($rows, $filed);
        if ($missing) $add('FAIL', 'closed-file-missing', count($missing) . ' sale(s) are closed in the database but not in the closed-sales file, so a restored database could reopen them');
        $only = array_diff_key($filed, $rows);
        if ($only) $add('warning', 'closed-in-file-only', count($only) . ' sale(s) are closed in the closed-sales file only (an interrupted closure or an older database); they stay closed');
    }
    $delivered = 0;
    foreach (array_keys($rows + ($filed ?? [])) as $requestId) {
        if (ledger_request_entry($db, $coinId, (string) $requestId) !== null) $delivered++;
    }
    if ($delivered > 0) $add('FAIL', 'closed-sale-delivered', $delivered . ' sale(s) are closed and also have an entry: delivered although closed');
    return $found;
}

function integrity_level(array $findings): string
{
    $level = 'ok';
    foreach ($findings as $f) {
        if ($f['level'] === 'FAIL') return 'FAIL';
        if ($f['level'] === 'warning') $level = 'warning';
    }
    return $level;
}

// Checks every coin (or one). Returns the structured result; the caller prints it.
function integrity_run(PDO $db, ?string $only, int $now): array
{
    $coins = [];
    $ids = $only !== null ? [$only] : $db->query('SELECT coin_id FROM ledger_coins ORDER BY coin_id')->fetchAll(PDO::FETCH_COLUMN);
    foreach ($ids as $id) {
        $id = (string) $id;
        $findings = integrity_coin($db, $id);
        $info = ['coinId' => $id, 'symbol' => '?', 'mode' => '?', 'state' => '?', 'head' => null];
        try {
            $coin = ledger_coin($db, $id);
            $info = ['coinId' => $id, 'symbol' => (string) ($coin['genesis']['symbol'] ?? '?'), 'mode' => (string) $coin['mode'], 'state' => (string) $coin['state'], 'head' => ledger_head($db, $id)['index']];
        } catch (Throwable $e) {
        }
        $coins[] = $info + ['status' => integrity_level($findings), 'findings' => $findings];
    }
    $count = fn(string $s) => count(array_filter($coins, fn($c) => $c['status'] === $s));
    return ['checkedAt' => gmdate('Y-m-d\TH:i:s\Z', $now), 'coins' => $coins, 'summary' => ['coins' => count($coins), 'ok' => $count('ok'), 'warnings' => $count('warning'), 'failures' => $count('FAIL')]];
}

function integrity_main(array $argv): int
{
    $opts = ['private' => null, 'database' => 'chain34.sqlite', 'coin' => null, 'quiet' => false, 'json' => false, 'strict' => false];
    foreach (array_slice($argv, 1) as $arg) {
        if ($arg === '--help' || $arg === '-h') {
            echo "Read-only integrity check of every coin of this domain's ledger.\n"
                . "  php integrity-cli.php [--private=DIR] [--database=NAME] [--coin=ID] [--quiet] [--json] [--strict]\n"
                . "  --private   the private folder (default: chainblock-labs-private beside the web root this file is in)\n"
                . "  --database  the ledger database in it (default chain34.sqlite)\n"
                . "  --coin      check one coin\n"
                . "  --quiet     print nothing when every coin is ok\n"
                . "  --json      print the result as JSON\n"
                . "  --strict    warnings fail the run too\n"
                . "Exit status: 0 nothing wrong, 1 an integrity problem, 2 the check could not run.\n";
            return 0;
        }
        if (preg_match('/^--(private|database|coin)=(.*)$/D', $arg, $m)) { $opts[$m[1]] = $m[2]; continue; }
        if (in_array($arg, ['--quiet', '--json', '--strict'], true)) { $opts[substr($arg, 2)] = true; continue; }
        fwrite(STDERR, "integrity check could not run: unknown option\n");
        return 2;
    }
    set_time_limit(0);
    $now = time();
    $docroot = realpath(dirname(__DIR__, 2));
    $private = $opts['private'] !== null && $opts['private'] !== '' ? realpath($opts['private']) : ($docroot !== false ? realpath(dirname($docroot) . '/chainblock-labs-private') : false);
    $hide = array_filter([$private !== false ? $private : null, $docroot !== false ? $docroot : null, getenv('HOME') ?: null, $opts['private']]);
    $fail = static function (string $why) use ($hide): int {
        fwrite(STDERR, 'integrity check could not run: ' . integrity_clean($why, $hide) . "\n");
        return 2;
    };
    if ($private === false || !is_dir($private)) return $fail('the private folder was not found');
    if ($docroot !== false && str_starts_with($private . '/', $docroot . '/')) return $fail('the private folder is inside the web root');
    if (!preg_match('/^[A-Za-z0-9._-]{1,64}$/D', (string) $opts['database'])) return $fail('the database name is not valid');
    $file = $private . '/' . $opts['database'];
    if (!is_file($file) || !is_readable($file)) return $fail('the ledger database was not found or cannot be read');
    if ($opts['coin'] !== null && !preg_match('/^[a-f0-9]{32}$/D', (string) $opts['coin'])) return $fail('the coin id is not valid');
    try {
        $db = integrity_open($file);
        if (!integrity_has_table($db, 'ledger_coins')) return $fail('the database holds no ledger');
        $result = integrity_run($db, $opts['coin'], $now);
    } catch (Throwable $e) {
        return $fail($e->getMessage());
    }
    $s = $result['summary'];
    $bad = $s['failures'] > 0 || ($opts['strict'] && $s['warnings'] > 0);
    foreach ($result['coins'] as &$c) {
        foreach ($c['findings'] as &$f) $f['text'] = integrity_clean($f['text'], $hide);
        unset($f);
    }
    unset($c);
    if ($opts['json']) {
        echo json_encode($result, JSON_UNESCAPED_SLASHES) . "\n";
        return $bad ? 1 : 0;
    }
    $clean = $s['failures'] === 0 && $s['warnings'] === 0;
    if ($opts['quiet'] && $clean) return 0;
    echo 'chain labs integrity check ' . $result['checkedAt'] . "\n";
    foreach ($result['coins'] as $c) {
        if ($opts['quiet'] && $c['status'] === 'ok') continue;
        echo sprintf("%-7s %s %s %s %s head=%s\n", $c['status'], $c['coinId'], $c['symbol'], $c['mode'], $c['state'], $c['head'] ?? '?');
        foreach ($c['findings'] as $f) echo '        ' . $f['level'] . ' ' . $f['code'] . ': ' . $f['text'] . "\n";
    }
    echo 'summary: ' . $s['coins'] . ' coins, ' . $s['ok'] . ' ok, ' . $s['warnings'] . ' warnings, ' . $s['failures'] . ' failed' . ($bad ? ' - ATTENTION NEEDED' : '') . "\n";
    return $bad ? 1 : 0;
}

if (isset($_SERVER['argv'][0]) && realpath((string) $_SERVER['argv'][0]) === __FILE__) exit(integrity_main($_SERVER['argv']));
