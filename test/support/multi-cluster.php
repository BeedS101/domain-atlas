<?php
declare(strict_types=1);
// Shared by the multi authority and purchase tests: the test counters, and a cluster of nodes in one process, each with its
// own SQLite file and key, that talk through the same signed messages the endpoint sends over HTTPS.
require_once __DIR__ . '/../../chain-labs/lib/peer.php';

$failures = 0;
$total = 0;
function t(bool $ok, string $text, mixed $detail = null): void
{
    global $failures, $total;
    $total++;
    if (!$ok) $failures++;
    echo ($ok ? 'PASS ' : 'FAIL ') . $text . (!$ok && $detail !== null ? ' :: ' . substr(is_string($detail) ? $detail : json_encode($detail), 0, 300) : '') . "\n";
}
function refuses(callable $fn, string $reason): bool
{
    try { $fn(); } catch (LedgerError $e) { return $e->reason === $reason; } catch (Throwable $e) { return false; }
    return false;
}
function why(callable $fn): string
{
    try { $fn(); } catch (LedgerError $e) { return $e->reason . ': ' . $e->getMessage(); } catch (Throwable $e) { return get_class($e) . ': ' . $e->getMessage(); }
    return 'no error';
}

$NOW = 1800000000;
function owner(): array { $p = ledger_new_owner_key(); return ['key' => $p['key'], 'priv' => $p['private']]; }
function ec_private(): string
{
    $key = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
    openssl_pkey_export($key, $pem);
    return $pem;
}

// n nodes named a.example, b.example, ... each pinning the others' public keys.
$CLUSTER = [];
$DOWN = [];
$CALLS = [];
$ALT = null;
function cluster(int $n): array
{
    global $CLUSTER, $DOWN, $CALLS, $ALT;
    $CLUSTER = []; $DOWN = []; $CALLS = []; $ALT = null;
    $keys = [];
    for ($i = 0; $i < $n; $i++) $keys[chr(97 + $i) . '.example'] = ec_private();
    foreach ($keys as $domain => $priv) {
        $pinned = [];
        foreach ($keys as $other => $otherPriv) if ($other !== $domain) $pinned[$other] = openssl_pkey_get_details(openssl_pkey_get_private($otherPriv))['key'];
        $file = tempnam(sys_get_temp_dir(), 'multi-test-') . '.sqlite';
        $CLUSTER[$domain] = ['node' => ['domain' => $domain, 'private' => $priv, 'pinned' => $pinned], 'db' => ledger_open($file), 'file' => $file];
    }
    return array_keys($CLUSTER);
}
// The transport: delivers an envelope to the target node's handler in process, as HTTP would, unless that domain is down.
function transport(string $to, array $envelope): array
{
    global $CLUSTER, $DOWN, $CALLS, $NOW;
    $CALLS[] = [$to, $envelope['payload']['action']];
    if (!isset($CLUSTER[$to]) || !empty($DOWN[$to])) ledger_fail('peer-down', $to . ' did not answer');
    $target = $CLUSTER[$to];
    // A split-view authority answers one partner from another copy of its database.
    global $ALT;
    if ($ALT !== null && $to === 'a.example' && $envelope['payload']['from'] === $ALT['for']) $target = ['db' => $ALT['db'], 'node' => $target['node']];
    $answer = peer_handle($target['db'], $target['node'], json_decode(json_encode($envelope), true), $NOW, 'transport');
    return json_decode(json_encode($answer), true);
}
function node(string $d): array { global $CLUSTER; return $CLUSTER[$d]['node']; }
function ndb(string $d): PDO { global $CLUSTER; return $CLUSTER[$d]['db']; }
function calls(string $action): int { global $CALLS; return count(array_filter($CALLS, fn($c) => $c[1] === $action)); }

// Opens a multi coin whose roster is the first $n domains, authority a.example.
function open_coin(int $n, ?int $threshold, string $visibility = 'public', ?array $faucet = null, string $symbol = 'MUL', ?array $purchase = null): array
{
    global $CLUSTER, $NOW;
    $roster = [];
    foreach (array_slice(array_keys($CLUSTER), 0, $n) as $d) $roster[] = ['domain' => $d, 'key' => peer_public(node($d))];
    $treasury = owner();
    $secret = $visibility === 'private' ? bin2hex(random_bytes(32)) : null;
    $genesis = ledger_genesis(['symbol' => $symbol, 'name' => 'Coin ' . $symbol, 'decimals' => 2, 'maxUnits' => '1000000', 'initialUnits' => '100000', 'treasuryKey' => $treasury['key'],
        'mode' => 'multi', 'visibility' => $visibility, 'roster' => $roster, 'threshold' => $threshold, 'createdAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 3600), 'refSecret' => $secret, 'faucet' => $faucet, 'purchase' => $purchase]);
    return ['genesis' => $genesis, 'coin' => $genesis['coinId'], 'treasury' => $treasury, 'secret' => $secret, 'roster' => array_column($roster, 'domain')];
}
function open_now(array $c): void
{
    global $NOW;
    peer_open_multi(ndb('a.example'), node('a.example'), $c['genesis'], $c['treasury']['key'], $c['secret'], 'transport', $NOW);
}
function auth(string $at, array $c, array $from, string $to, string $amount, array $over = []): array
{
    global $NOW;
    $row = ledger_account_row(ndb($at), $c['coin'], $from['key']);
    $payload = array_merge(['type' => 'atlas.ledger.transfer', 'v' => 1, 'coinId' => $c['coin'], 'from' => $from['key'], 'to' => $to, 'amount' => $amount, 'baseSeq' => $row ? (int) $row['seq'] : 0,
        'baseHead' => ledger_head(ndb($at), $c['coin'])['hash'], 'nonce' => bin2hex(random_bytes(16)), 'issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 10), 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 300)], $over);
    return ['payload' => $payload, 'signature' => ledger_owner_sign($from['priv'], $payload)];
}
function pay(array $c, array $from, string $to, string $amount, array $over = []): array
{
    global $NOW;
    return peer_submit_and_execute(ndb('a.example'), node('a.example'), $c['coin'], auth('a.example', $c, $from, $to, $amount, $over), 'transport', $NOW);
}
function units(string $d, array $c, string $key): int
{
    $row = ledger_account_row(ndb($d), $c['coin'], $key);
    return $row ? (int) $row['units'] : 0;
}
function heads(array $c, array $domains): array
{
    $out = [];
    foreach ($domains as $d) $out[$d] = ledger_head(ndb($d), $c['coin'])['index'] . ':' . substr(ledger_head(ndb($d), $c['coin'])['hash'], 0, 12);
    return $out;
}
function level(array $c, array $domains): bool { return count(array_unique(heads($c, $domains))) === 1; }
function clean(array $c, array $domains): bool
{
    foreach ($domains as $d) if (ledger_check(ndb($d), $c['coin']) !== []) return false;
    return true;
}
function same_log(array $c, array $domains): bool
{
    $ref = null;
    foreach ($domains as $d) {
        $rows = ndb($d)->query("SELECT idx,hash,public_json,private_json FROM ledger_log WHERE coin_id='" . $c['coin'] . "' ORDER BY idx")->fetchAll(PDO::FETCH_ASSOC);
        if ($ref === null) $ref = $rows; elseif ($rows !== $ref) return false;
    }
    return true;
}

