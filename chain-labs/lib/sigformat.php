<?php
declare(strict_types=1);

// Signature formats of the domain key over a coin's genesis and entries.
//
// Format 1 (legacy) signs the bare 64-character hexadecimal digest or entry hash. Format 2 signs a typed message, the way approvals do,
// so a signature made for one purpose cannot be taken for another and names the coin, the position and the signer:
//
//   genesis   {type:'atlas.ledger.genesis.signature', v:1, coinId, digest, domain}
//   authority {type:'atlas.ledger.entry.authority',   v:1, coinId, index, hash, domain}
//
// "Format 2" is the signature format. The `v:1` inside a message is the version of that message object, and changes only when
// the object's fields change. A stored signature is a plain base64url string in both formats; a verifier tries format 2 and then format 1.
//
// Format 1 stays valid for what was signed before format 2 existed, and nowhere else:
//   - an entry's authority signature may be format 1 only while no earlier entry of the coin carries a format 2 authority signature
//   - a genesis signature may be format 1 only on a coin whose entry 0 is itself signed in format 1
// Nothing here reads a database; ledger.php applies these rules to a coin's log.

const SIGFORMAT_LEGACY = 'legacy';
const SIGFORMAT_V2 = 'v2';

function sigformat_genesis_bytes(string $coinId, string $digest, string $domain): string
{
    return ledger_canonical(['type' => 'atlas.ledger.genesis.signature', 'v' => 1, 'coinId' => $coinId, 'digest' => $digest, 'domain' => $domain]);
}

function sigformat_entry_bytes(string $coinId, int $index, string $hash, string $domain): string
{
    return ledger_canonical(['type' => 'atlas.ledger.entry.authority', 'v' => 1, 'coinId' => $coinId, 'index' => $index, 'hash' => $hash, 'domain' => $domain]);
}

function sigformat_is_hash(mixed $value): bool
{
    return is_string($value) && preg_match('/^[0-9a-f]{64}$/D', $value) === 1;
}

// Which format a genesis signature is in, or null when it verifies in neither.
function sigformat_genesis_kind(string $publicPem, string $coinId, string $digest, string $domain, mixed $signature): ?string
{
    if (!is_string($signature) || !sigformat_is_hash($digest)) return null;
    if (ledger_verify($publicPem, sigformat_genesis_bytes($coinId, $digest, $domain), $signature)) return SIGFORMAT_V2;
    return ledger_verify($publicPem, $digest, $signature) ? SIGFORMAT_LEGACY : null;
}

function sigformat_entry_kind(string $publicPem, string $coinId, int $index, string $hash, string $domain, mixed $signature): ?string
{
    if (!is_string($signature) || !sigformat_is_hash($hash)) return null;
    if (ledger_verify($publicPem, sigformat_entry_bytes($coinId, $index, $hash, $domain), $signature)) return SIGFORMAT_V2;
    return ledger_verify($publicPem, $hash, $signature) ? SIGFORMAT_LEGACY : null;
}

function sigformat_sign_genesis(string $privatePem, string $coinId, string $digest, string $domain): string
{
    return ledger_sign($privatePem, sigformat_genesis_bytes($coinId, $digest, $domain));
}

function sigformat_sign_entry(string $privatePem, string $coinId, int $index, string $hash, string $domain): string
{
    return ledger_sign($privatePem, sigformat_entry_bytes($coinId, $index, $hash, $domain));
}

// The ratchet for one authority signature: it is valid when it verified in a format and, if it is format 1, nothing before it was format 2.
// $previous is the format of the entry just before this one, or null for entry 0 or when it is not known.
function sigformat_entry_allowed(?string $kind, ?string $previous): bool
{
    if ($kind === null) return false;
    return !($kind === SIGFORMAT_LEGACY && $previous === SIGFORMAT_V2);
}

// A genesis signature against the format of the coin's entry 0 (null while the coin has no entry 0).
function sigformat_genesis_allowed(?string $kind, ?string $entryZero): bool
{
    if ($kind === null) return false;
    return $kind === SIGFORMAT_V2 || $entryZero !== SIGFORMAT_V2;
}

// ---------- activation ----------
//
// A domain signs in format 2 only after an operator activated it, and never in format 1 again. The decision is kept twice: in a hash-chained
// file in the private folder beside the database's checkpoints, written and flushed before the first signature in format 2, and in a row of
// the database. They are read together:
//   marker and row            active
//   marker only               active (a restored database lost the row)
//   row only                  unavailable: the marker was lost or removed
//   neither                   not activated, unless a coin this domain is the authority of already carries a format 2 signature: unavailable
//   a damaged marker          unavailable
// "Unavailable" refuses every signature of this domain's with a reason, so a lost or damaged record never turns into format 1. Restoring the
// whole folder, or both stores, to an older copy is the same limit as for the checkpoints (docs/chain-labs-rollback-protection.md); what
// protects a coin then is that every verifier refuses format 1 after format 2 on a coin that showed it.

const SIGFORMAT_MARKER = 'signature-format.log';

function sigformat_marker_file(PDO $db): ?string
{
    $dir = ledger_guard_dir($db);
    return $dir === null ? null : $dir . '/' . SIGFORMAT_MARKER;
}

// The lines of the marker file. A piece after the last newline is a write that was cut short (nothing was signed on it, since the
// write is flushed before the first signature), and is set aside; every complete line must hold its own sum and follow the one before.
function sigformat_marker_read(string $file): array
{
    clearstatcache(true, $file);
    if (!is_file($file)) return ['lines' => [], 'damaged' => null, 'cut' => false];
    $size = (int) filesize($file);
    if ($size > 65536) return ['lines' => [], 'damaged' => 'the file is larger than any activation record', 'cut' => false];
    $text = (string) file_get_contents($file);
    if (strlen($text) !== $size) return ['lines' => [], 'damaged' => 'the file cannot be read', 'cut' => false];
    $pieces = explode("\n", $text);
    $tail = array_pop($pieces);
    $lines = [];
    $expect = GUARD_ZERO;
    foreach ($pieces as $piece) {
        $row = guard_line($piece);
        if ($row === null) return ['lines' => [], 'damaged' => 'a line does not hold', 'cut' => false];
        if ($row['prevSum'] !== $expect) return ['lines' => [], 'damaged' => 'a line does not follow the one before it', 'cut' => false];
        $expect = $row['sum'];
        $lines[] = $row;
    }
    return ['lines' => $lines, 'damaged' => null, 'cut' => $tail !== ''];
}

// The activation as the marker file and the row say it: ['state' => 'legacy'|'active'|'unavailable', 'reason' => string, 'domain' => ?string, 'at' => ?int, 'marker' => bool, 'row' => bool].
function sigformat_state(PDO $db, string $domain): array
{
    $out = ['state' => 'legacy', 'reason' => '', 'domain' => null, 'at' => null, 'marker' => false, 'row' => false];
    $bad = static function (string $why) use (&$out): array { return ['state' => 'unavailable', 'reason' => $why] + $out; };
    try {
        $row = $db->query('SELECT format,domain,activated_at FROM ledger_sig_format WHERE id=1')->fetch(PDO::FETCH_ASSOC);
    } catch (Throwable $e) {
        return $bad('the activation row cannot be read');
    }
    $out['row'] = $row !== false;
    $file = sigformat_marker_file($db);
    $mark = null;
    if ($file !== null) {
        $parsed = sigformat_marker_read($file);
        if ($parsed['damaged'] !== null) return $bad('the activation record is damaged: ' . $parsed['damaged']);
        foreach ($parsed['lines'] as $line) {
            if (($line['kind'] ?? null) !== 'activate' || ($line['format'] ?? null) !== 2 || !is_string($line['domain'] ?? null) || !is_int($line['at'] ?? null)) return $bad('the activation record holds a line this code does not know');
            if ($mark !== null && $mark['domain'] !== $line['domain']) return $bad('the activation record names more than one domain');
            $mark ??= ['domain' => $line['domain'], 'at' => $line['at']];
        }
        $out['marker'] = $mark !== null;
    }
    if ($mark !== null) {
        if ($row !== false && ($row['domain'] !== $mark['domain'] || (int) $row['format'] !== 2)) return $bad('the activation record and the database disagree');
        return ['state' => 'active', 'domain' => $mark['domain'], 'at' => $mark['at']] + $out;
    }
    if ($row !== false) return $bad('the activation record is missing: the database says format 2 was activated');
    // Neither: legacy, unless this domain's own coins already carry format 2 signatures it should have recorded. The check reads every coin of
    // this domain, so its answer is kept for as long as the log has not grown.
    static $seen = null;
    $seen ??= new WeakMap();
    try {
        $mark = [$domain, (int) $db->query('SELECT COALESCE(MAX(rowid),0) FROM ledger_log')->fetchColumn(), (int) $db->query('SELECT COUNT(*) FROM ledger_coins')->fetchColumn()];
        if (isset($seen[$db]) && $seen[$db] === $mark) return $out;
        foreach ($db->query("SELECT coin_id FROM ledger_coins WHERE state IN ('active','frozen')")->fetchAll(PDO::FETCH_COLUMN) as $coinId) {
            $coin = ledger_coin($db, (string) $coinId);
            if ($coin['genesis']['authority'] !== $domain) continue;
            $head = ledger_head($db, (string) $coinId);
            if (ledger_stored_kind($db, $coin['genesis'], (string) $coinId, (int) $head['index']) === SIGFORMAT_V2) return $bad('coin ' . $coinId . ' carries signatures in format 2 but this domain has no record of activating it');
        }
        $seen[$db] = $mark;
    } catch (Throwable $e) {
        return $bad('the coins cannot be checked against the activation record');
    }
    return $out;
}

// Whether this domain signs in format 2 as $domain. Throws signature-format-unavailable when that cannot be told, so nothing is signed.
function ledger_sig_activated(PDO $db, string $domain): bool
{
    $state = sigformat_state($db, $domain);
    if ($state['state'] === 'unavailable') ledger_fail('signature-format-unavailable', $state['reason']);
    return $state['state'] === 'active' && $state['domain'] === $domain;
}

// Records the activation: the marker line first, flushed, then the row. A crash between the two leaves the marker, which is enough.
// $recover writes a new record for a domain whose record was lost, damaged or does not agree; a damaged file is kept aside, not removed.
function sigformat_record_activation(PDO $db, string $domain, int $now, bool $recover = false): array
{
    $file = sigformat_marker_file($db);
    if ($file === null) ledger_fail('signature-format-unavailable', 'this database has no private folder to keep the activation record in');
    $state = sigformat_state($db, $domain);
    if ($state['state'] === 'active' && $state['domain'] === $domain) {
        $db->prepare('INSERT OR REPLACE INTO ledger_sig_format(id,format,domain,activated_at) VALUES(1,2,?,?)')->execute([$domain, $state['at']]);
        return ['already' => true] + sigformat_state($db, $domain);
    }
    if ($state['state'] === 'active') ledger_fail('signature-format-unavailable', 'the activation record names another domain');
    if ($state['state'] === 'unavailable' && !$recover) ledger_fail('signature-format-unavailable', $state['reason'] . '. Nothing is signed until an operator repairs it (recover).');
    if ($state['state'] === 'unavailable' && is_file($file)) {
        $aside = $file . '.damaged-' . gmdate('YmdHis', $now);
        if (!@rename($file, $aside)) ledger_fail('signature-format-unavailable', 'the damaged activation record cannot be set aside');
    }
    $parsed = sigformat_marker_read($file);
    if ($parsed['cut']) {
        // A write that was cut short never got as far as a signature; it is removed so that the record starts clean.
        $text = (string) file_get_contents($file);
        $keep = strrpos($text, "\n");
        if (@file_put_contents($file, $keep === false ? '' : substr($text, 0, $keep + 1), LOCK_EX) === false) ledger_fail('signature-format-unavailable', 'the unfinished activation record cannot be cleared');
    }
    try {
        guard_append($file, ['v' => 1, 'kind' => 'activate', 'format' => 2, 'domain' => $domain, 'at' => $now]);
    } catch (Throwable $e) {
        ledger_fail('signature-format-unavailable', 'the activation record cannot be written: ' . $e->getMessage());
    }
    $db->prepare('INSERT OR REPLACE INTO ledger_sig_format(id,format,domain,activated_at) VALUES(1,2,?,?)')->execute([$domain, $now]);
    $after = sigformat_state($db, $domain);
    if ($after['state'] !== 'active') ledger_fail('signature-format-unavailable', 'the activation could not be confirmed: ' . $after['reason']);
    return ['already' => false] + $after;
}

// ---------- readiness ----------

// The domains this one shares a coin of several domains with, each with its coins.
function sigformat_partners(PDO $db, string $domain): array
{
    $out = [];
    foreach ($db->query("SELECT coin_id FROM ledger_coins WHERE mode='multi'")->fetchAll(PDO::FETCH_COLUMN) as $coinId) {
        $coin = ledger_coin($db, (string) $coinId);
        foreach ($coin['genesis']['roster'] as $member) if ($member['domain'] !== $domain) $out[$member['domain']][] = (string) $coinId;
    }
    ksort($out);
    return $out;
}

// Pending coins this domain proposes whose stored genesis signatures include any in format 1: opening them as they are would write a format 1
// genesis under an entry 0 in format 2, or the other way, so they are named and must be finished first or have their signatures collected again.
function sigformat_pending_legacy(PDO $db, string $domain): array
{
    $out = [];
    foreach ($db->query("SELECT coin_id FROM ledger_coins WHERE state='pending'")->fetchAll(PDO::FETCH_COLUMN) as $coinId) {
        $coin = ledger_coin($db, (string) $coinId);
        if ($coin['genesis']['authority'] !== $domain) continue;
        $rows = $db->prepare('SELECT domain,signature FROM ledger_genesis_sigs WHERE coin_id=? ORDER BY domain');
        $rows->execute([$coinId]);
        foreach ($rows->fetchAll(PDO::FETCH_ASSOC) as $row) {
            if (ledger_genesis_kind($coin['genesis'], (string) $coinId, $coin['genesis_digest'], $row['domain'], $row['signature']) === SIGFORMAT_LEGACY) $out[(string) $coinId][] = $row['domain'];
        }
    }
    return $out;
}

// Forgets the stored format 1 genesis signatures of this domain's pending coins; the next open asks for them again, in format 2.
function sigformat_discard_pending_legacy(PDO $db, string $domain): int
{
    $count = 0;
    foreach (sigformat_pending_legacy($db, $domain) as $coinId => $domains) {
        foreach ($domains as $d) {
            $db->prepare('DELETE FROM ledger_genesis_sigs WHERE coin_id=? AND domain=?')->execute([$coinId, $d]);
            $count++;
        }
    }
    return $count;
}

// A readiness probe: a fresh challenge and samples signed by a throwaway key. A domain that can verify format 2 gives the right verdict on each, so
// its answer is computed, not claimed; one that cannot has no such action and refuses.
function sigformat_probe_make(): array
{
    $key = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
    openssl_pkey_export($key, $private);
    $public = openssl_pkey_get_details($key)['key'];
    $coinId = bin2hex(random_bytes(16));
    $hash = bin2hex(random_bytes(32));
    $other = bin2hex(random_bytes(32));
    $domain = 'probe.example';
    $entry = static fn(int $index, string $h): string => sigformat_sign_entry($private, $coinId, $index, $h, $domain);
    $samples = [
        ['kind' => 'entry', 'coinId' => $coinId, 'index' => 3, 'hash' => $hash, 'domain' => $domain, 'signature' => $entry(3, $hash)],
        ['kind' => 'entry', 'coinId' => $coinId, 'index' => 3, 'hash' => $hash, 'domain' => $domain, 'signature' => ledger_sign($private, $hash)],
        ['kind' => 'entry', 'coinId' => $coinId, 'index' => 3, 'hash' => $hash, 'domain' => $domain, 'signature' => sigformat_sign_genesis($private, $coinId, $hash, $domain)],
        ['kind' => 'entry', 'coinId' => $coinId, 'index' => 4, 'hash' => $hash, 'domain' => $domain, 'signature' => $entry(3, $hash)],
        ['kind' => 'entry', 'coinId' => $coinId, 'index' => 3, 'hash' => $other, 'domain' => $domain, 'signature' => $entry(3, $hash)],
        ['kind' => 'genesis', 'coinId' => $coinId, 'digest' => $hash, 'domain' => $domain, 'signature' => sigformat_sign_genesis($private, $coinId, $hash, $domain)],
        ['kind' => 'genesis', 'coinId' => $coinId, 'digest' => $hash, 'domain' => $domain, 'signature' => $entry(0, $hash)],
        ['kind' => 'ratchet', 'entry' => SIGFORMAT_LEGACY, 'previous' => SIGFORMAT_V2],
        ['kind' => 'ratchet', 'entry' => SIGFORMAT_LEGACY, 'previous' => SIGFORMAT_LEGACY],
    ];
    $expect = [SIGFORMAT_V2, SIGFORMAT_LEGACY, null, null, null, SIGFORMAT_V2, null, false, true];
    // The order is different every time, so the right answer cannot be learned in advance and repeated.
    $order = range(0, count($samples) - 1);
    shuffle($order);
    return ['challenge' => bin2hex(random_bytes(16)), 'key' => $public, 'samples' => array_map(static fn(int $i) => $samples[$i], $order), 'expect' => array_map(static fn(int $i) => $expect[$i], $order)];
}

// The verdicts on a probe's samples, from this code's own checks.
function sigformat_probe_verdicts(array $body): array
{
    $key = $body['key'] ?? null;
    $samples = $body['samples'] ?? null;
    if (!is_string($key) || strlen($key) > 1000 || !is_array($samples) || !array_is_list($samples) || count($samples) > 12) ledger_fail('bad-request', 'the probe is malformed');
    $out = [];
    foreach ($samples as $sample) {
        if (!is_array($sample)) ledger_fail('bad-request', 'the probe is malformed');
        $kind = $sample['kind'] ?? null;
        if ($kind === 'entry' && is_string($sample['coinId'] ?? null) && is_int($sample['index'] ?? null) && is_string($sample['hash'] ?? null) && is_string($sample['domain'] ?? null)) {
            $out[] = sigformat_entry_kind($key, $sample['coinId'], $sample['index'], $sample['hash'], $sample['domain'], $sample['signature'] ?? null);
        } elseif ($kind === 'genesis' && is_string($sample['coinId'] ?? null) && is_string($sample['digest'] ?? null) && is_string($sample['domain'] ?? null)) {
            $out[] = sigformat_genesis_kind($key, $sample['coinId'], $sample['digest'], $sample['domain'], $sample['signature'] ?? null);
        } elseif ($kind === 'ratchet' && in_array($sample['entry'] ?? null, [SIGFORMAT_LEGACY, SIGFORMAT_V2], true) && in_array($sample['previous'] ?? null, [SIGFORMAT_LEGACY, SIGFORMAT_V2, null], true)) {
            $out[] = sigformat_entry_allowed($sample['entry'], $sample['previous']);
        } else {
            ledger_fail('bad-request', 'the probe is malformed');
        }
    }
    return $out;
}

// The activation as an operator sees it.
function sigformat_public(array $state): array
{
    return ['state' => $state['state'], 'reason' => $state['reason'] ?? '', 'domain' => $state['domain'] ?? null,
        'activatedAt' => isset($state['at']) && is_int($state['at']) ? gmdate('Y-m-d\TH:i:s\Z', $state['at']) : null, 'record' => ['file' => (bool) ($state['marker'] ?? false), 'database' => (bool) ($state['row'] ?? false)]];
}
