<?php
declare(strict_types=1);
/**
 * Chainblock Labs 34: spending, receipts and holdings for single authority coins. Experimental; test coins only.
 *
 * Reads:  GET coins, coin, receipt, proposal.
 * Wallet: POST challenge, holdings (public coins to anyone, private coins to a key-signed challenge), propose (an
 *         owner-signed transfer: executed at once by this domain for a single authority coin; for a multi authority coin the
 *         authority collects approvals from the other domains first and answers 202 while it waits for them).
 *         purchase (an owner-signed intent and a price credential: the authority of a coin that has a purchase policy delivers
 *         the units and spends the credential, see lib/purchase.php; 202 while a multi authority sale waits for approvals).
 *         GET head: this domain's signed statement of the newest entry it holds, for anyone comparing domains.
 * Operator (private operator token): POST open (opens a coin of the coin registry as a ledger, a multi authority coin with
 *         its partner domains and an optional faucet or purchase policy), grant (a treasury spend), recover (finishes pending
 *         multi authority proposals), compare (compares heads with the other domains and freezes the coin on a disagreement),
 *         evidence (why a coin is frozen), purchase-recover (finishes journaled sales), purchase-cancel (ends one that has no entry).
 * Domains: POST peer, a request signed by another domain of the coin (genesis, sync, approve, notify, head, freeze).
 * Storage: chain34.sqlite, the treasury key files, chainlabs-peers.json (pinned partner keys) and gold-adapter.php (returns the
 *          callables of lib/purchase.php that reach the code holding price credentials) in the private folder beside the web
 *          root, never inside it.
 */
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
function reply34(int $status, array $body): never { http_response_code($status); echo json_encode($body, JSON_UNESCAPED_SLASHES); exit; }
if (!extension_loaded('pdo_sqlite') || !extension_loaded('openssl')) reply34(503, ['ok' => false, 'error' => 'OpenSSL and PDO SQLite are required']);
if (empty($_SERVER['HTTPS']) || $_SERVER['HTTPS'] === 'off') reply34(403, ['ok' => false, 'error' => 'HTTPS required']);
$host = strtolower($_SERVER['HTTP_HOST'] ?? '');
require __DIR__.'/lib/hosts.php';
if (!chainlabs_is_host($host)) reply34(400, ['ok' => false, 'error' => 'Unrecognized host']);
require __DIR__ . '/lib/purchase.php';
require __DIR__ . '/lib/policy.php';
$root = realpath($_SERVER['DOCUMENT_ROOT'] ?? '');
$private = $root ? realpath(dirname($root) . '/chainblock-labs-private') : false;
if (!$private || str_starts_with($private . '/', $root . '/')) reply34(503, ['ok' => false, 'error' => 'Private storage unavailable']);
$config = $private . '/federation20-config.php';
if (!is_file($config)) reply34(503, ['ok' => false, 'error' => 'Operator configuration missing']);
$c = require $config;
$domainPrivate = is_array($c) ? base64_decode((string) ($c['private_pem_b64'] ?? ''), true) : false;
$admin = is_array($c) ? ($c['admin_token_hex'] ?? null) : null;
$domainKey = $domainPrivate ? openssl_pkey_get_private($domainPrivate) : false;
if (!$domainKey || !is_string($admin) || !preg_match('/^[a-f0-9]{64}$/D', $admin)) reply34(503, ['ok' => false, 'error' => 'Invalid operator configuration']);
$domainPublic = openssl_pkey_get_details($domainKey)['key'];
$peerConfig = peer_load_config($host, $private, $c, chainlabs_peer_map());
$gold = null;
if (is_file($private . '/gold-adapter.php')) {
    $adapter = require $private . '/gold-adapter.php';
    if (is_array($adapter) && is_callable($adapter['verify'] ?? null) && is_callable($adapter['revoked'] ?? null)) $gold = $adapter;
}
$node = ['domain' => $host, 'private' => $domainPrivate, 'pinned' => $peerConfig['pinned'], 'gold' => $gold];
try {
    $db = ledger_open($private . '/chain34.sqlite');
} catch (Throwable $e) {
    reply34(503, ['ok' => false, 'error' => 'Ledger storage unavailable']);
}

const SPEND34_STATUS = [
    'bad-signature' => 401, 'bad-challenge' => 401, 'unknown-coin' => 404, 'unknown-proposal' => 404, 'unknown-entry' => 404,
    'stale' => 409, 'replayed' => 409, 'pending-exists' => 409, 'insufficient' => 409, 'closed' => 409, 'not-active' => 409, 'expired' => 409,
    'wrong-index' => 409, 'wrong-prev' => 409, 'key-exists' => 409, 'busy' => 429, 'needs-approvals' => 202,
    'unknown-peer' => 403, 'not-in-roster' => 403, 'not-authority' => 409, 'equivocation' => 409, 'exists' => 409, 'not-pending' => 409,
    'peer-down' => 502, 'peer-bad-answer' => 502, 'bad-history' => 502, 'not-enough-approvals' => 503,
    'locked' => 409, 'request-reused' => 409, 'insufficient-treasury' => 409, 'duplicate-purchase' => 409, 'purchase-key-limit' => 409, 'purchase-day-limit' => 409,
    'no-purchase-policy' => 409, 'revoked-credential' => 409, 'cannot-cancel' => 409, 'cannot-close' => 409, 'sale-closed' => 409, 'unknown-request' => 404, 'no-purchase-verifier' => 503,
];
function fail34(LedgerError $e): never
{
    reply34(SPEND34_STATUS[$e->reason] ?? 400, ['ok' => false, 'code' => $e->reason, 'error' => $e->getMessage()]);
}
function body34(int $limit = 8192): array
{
    if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $limit) reply34(413, ['ok' => false, 'error' => 'Request too large']);
    $raw = file_get_contents('php://input', false, null, 0, $limit + 1);
    if ($raw === '' || $raw === false) return [];
    $data = json_decode($raw, true);
    if (!is_array($data) || array_is_list($data)) reply34(400, ['ok' => false, 'error' => 'Invalid JSON']);
    return $data;
}
function arg34(string $name, string $pattern): string
{
    $v = $_GET[$name] ?? '';
    if (!is_string($v) || !preg_match($pattern, $v)) reply34(400, ['ok' => false, 'error' => 'Invalid ' . $name]);
    return $v;
}
function operator34(array $m, string $admin): void
{
    $t = $m['adminToken'] ?? null;
    if (!is_string($t) || !preg_match('/^[a-f0-9]{64}$/D', $t) || !hash_equals($admin, $t)) reply34(403, ['ok' => false, 'error' => 'Incorrect operator token']);
}

// A partner domain of a multi authority coin brings its copy level with the authority before it answers a read; an
// authority that does not answer leaves the copy as it is.
function catchup34(PDO $db, array $node, array $peerConfig, string $coinId, int $now): void
{
    try {
        $coin = ledger_coin($db, $coinId);
        if ($coin['mode'] !== 'multi' || $coin['genesis']['authority'] === $node['domain'] || !in_array($coin['state'], ['pending', 'active'], true)) return;
        peer_catch_up($db, $node, $coinId, peer_http_sender($peerConfig, 4), $now);
    } catch (Throwable $e) {
    }
}

// Submits a signed transfer to the authority of a multi coin and collects approvals. Returns [status, body] for reply34: 201
// with the receipt, or 202 with the proposal when the other domains have not approved yet (it stays pending and recovery or
// a repeat of the request finishes it).
function execute_multi34(PDO $db, array $node, callable $send, string $coinId, array $authorization, int $now): array
{
    $state = spend_submit($db, $coinId, $authorization, $now);
    try {
        return [201, ['ok' => true, 'receipt' => peer_execute($db, $node, $coinId, $state['digest'], $send, $now)]];
    } catch (LedgerError $e) {
        if (!in_array($e->reason, ['not-enough-approvals', 'peer-down'], true)) throw $e;
        $row = spend_proposal($db, $coinId, $state['digest']);
        return [202, ['ok' => true, 'code' => 'needs-approvals', 'proposal' => $row ? spend_view($row) : $state, 'note' => $e->getMessage()]];
    }
}

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';
$now = time();
$send = peer_http_sender($peerConfig, 15);
try {
    if ($method === 'GET' && $action === 'coins') {
        $out = [];
        foreach ($db->query("SELECT coin_id FROM ledger_coins WHERE state IN ('active','frozen') ORDER BY coin_id LIMIT 100")->fetchAll(PDO::FETCH_COLUMN) as $id) {
            $coin = ledger_coin($db, $id);
            $g = $coin['genesis'];
            $out[] = ['coinId' => $id, 'symbol' => $g['symbol'], 'name' => $g['name'], 'decimals' => $g['decimals'], 'visibility' => $g['visibility'], 'mode' => $g['mode'], 'state' => $coin['state']];
        }
        reply34(200, ['ok' => true, 'domain' => $host, 'domainKey' => $domainPublic, 'coins' => $out]);
    }
    if ($method === 'GET' && $action === 'coin') {
        $coinId = arg34('coin', '/^[a-f0-9]{32}$/D');
        catchup34($db, $node, $peerConfig, $coinId, $now);
        // Whether this domain can take a Gold purchase at all, so a wallet offers Buy only where it can work.
        reply34(200, ['ok' => true] + ledger_public_coin($db, $coinId) + ['purchasesEnabled' => $gold !== null && is_callable($gold['lock'] ?? null) && is_callable($gold['release'] ?? null) && is_callable($gold['finish'] ?? null)]);
    }
    if ($method === 'GET' && $action === 'receipt') {
        $coinId = arg34('coin', '/^[a-f0-9]{32}$/D');
        catchup34($db, $node, $peerConfig, $coinId, $now);
        reply34(200, ['ok' => true, 'receipt' => spend_receipt($db, $coinId, (int) arg34('index', '/^\d{1,9}$/D'))]);
    }
    if ($method === 'GET' && $action === 'head') {
        $coinId = arg34('coin', '/^[a-f0-9]{32}$/D');
        reply34(200, ['ok' => true, 'head' => peer_head_attestation($db, $node, $coinId, $now), 'state' => ledger_coin($db, $coinId)['state']]);
    }
    if ($method === 'GET' && $action === 'proposal') {
        $coinId = arg34('coin', '/^[a-f0-9]{32}$/D');
        catchup34($db, $node, $peerConfig, $coinId, $now);
        $row = spend_proposal($db, $coinId, arg34('digest', '/^[a-f0-9]{64}$/D'));
        if (!$row) reply34(404, ['ok' => false, 'code' => 'unknown-proposal', 'error' => 'no such proposal']);
        $view = spend_view($row);
        if ($row['status'] === 'executed') $view['receipt'] = spend_receipt($db, $row['coin_id'], (int) $row['executed_index']);
        reply34(200, ['ok' => true, 'proposal' => $view]);
    }
    if ($method !== 'POST') reply34(404, ['ok' => false, 'error' => 'Unknown action']);

    if ($action === 'challenge') reply34(200, ['ok' => true] + spend_challenge_issue($db, $now));
    if ($action === 'holdings') {
        $m = body34();
        $request = $m['request'] ?? null;
        if ($request !== null && !is_array($request)) reply34(400, ['ok' => false, 'error' => 'Invalid request']);
        reply34(200, ['ok' => true] + spend_holdings($db, $host, $domainPrivate, (string) ($m['key'] ?? ''), $request, $now));
    }
    if ($action === 'propose') {
        $m = body34();
        $authorization = $m['authorization'] ?? null;
        $payload = is_array($authorization) ? ($authorization['payload'] ?? null) : null;
        if (!is_array($payload) || !is_string($payload['coinId'] ?? null) || !preg_match('/^[a-f0-9]{32}$/D', $payload['coinId'])) reply34(400, ['ok' => false, 'error' => 'Expected a signed transfer']);
        $coin = ledger_coin($db, $payload['coinId']);
        if ($coin['mode'] !== 'single') {
            if ($coin['genesis']['authority'] !== $host) reply34(409, ['ok' => false, 'code' => 'not-authority', 'error' => 'Propose to the authority of this coin', 'authority' => $coin['genesis']['authority']]);
            reply34(...execute_multi34($db, $node, $send, $payload['coinId'], $authorization, $now));
        }
        reply34(201, ['ok' => true, 'receipt' => spend_submit_and_execute($db, $payload['coinId'], $authorization, $domainPrivate, $now)]);
    }

    if ($action === 'purchase') {
        $m = body34(32768);
        $coinId = $m['coinId'] ?? null;
        if (!is_string($coinId) || !preg_match('/^[a-f0-9]{32}$/D', $coinId) || !is_array($m['intent'] ?? null) || !is_array($m['credential'] ?? null)) reply34(400, ['ok' => false, 'error' => 'Expected coinId, intent and credential']);
        if ($gold === null || !is_callable($gold['lock'] ?? null) || !is_callable($gold['release'] ?? null) || !is_callable($gold['finish'] ?? null)) reply34(503, ['ok' => false, 'code' => 'purchases-off', 'error' => 'Gold purchases are not enabled on this domain']);
        $coin = ledger_coin($db, $coinId);
        if ($coin['genesis']['authority'] !== $host) reply34(409, ['ok' => false, 'code' => 'not-authority', 'error' => 'Buy from the authority of this coin', 'authority' => $coin['genesis']['authority']]);
        try {
            $result = purchase_submit($db, $node, $gold, ledger_treasury_key_load($private, $coinId), $coinId, $m['intent'], is_callable($gold['pack'] ?? null) ? $gold['pack']($m['credential']) : $m['credential'], $coin['mode'] === 'multi' ? $send : null, $now);
        } catch (LedgerError $e) {
            // The sale is journaled and the credential held: the same request, or recovery, finishes it.
            if (!purchase_transient($e)) throw $e;
            reply34(202, ['ok' => true, 'code' => 'pending', 'note' => $e->getMessage(), 'reason' => $e->reason]);
        }
        reply34(201, ['ok' => true] + $result);
    }

    // Another domain of a coin. The request is signed with that domain's key and checked against the key pinned here.
    if ($action === 'peer') {
        $envelope = body34(65536);
        reply34(200, ['ok' => true, 'answer' => peer_handle($db, $node, $envelope, $now, peer_http_sender($peerConfig, 3))]);
    }

    // Operator actions.
    if (in_array($action, ['open', 'grant', 'recover', 'compare', 'evidence', 'purchase-recover', 'purchase-cancel'], true)) {
        $m = body34();
        operator34($m, $admin);
        $coinId = $m['coinId'] ?? null;
        if (!is_string($coinId) || !preg_match('/^[a-f0-9]{32}$/D', $coinId)) reply34(400, ['ok' => false, 'error' => 'Invalid coinId']);
    }
    if ($action === 'open') {
        $registryFile = $private . '/coin26.sqlite';
        if (!is_file($registryFile)) reply34(503, ['ok' => false, 'error' => 'Coin registry unavailable']);
        $registry = new PDO('sqlite:file:' . $registryFile . '?mode=ro', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5]);
        $q = $registry->prepare('SELECT * FROM coins WHERE id=? AND domain=?');
        $q->execute([$coinId, $host]);
        $row = $q->fetch(PDO::FETCH_ASSOC);
        if (!$row) reply34(404, ['ok' => false, 'code' => 'unknown-coin', 'error' => 'Coin not registered on this domain']);
        $multi = ($row['mode'] ?? 'single') === 'multi';
        // The purchase policy is the one the Studio checked and the operator confirmed, kept in the registry. A policy sent with the
        // request must be that same policy; none can be added or changed here.
        try {
            $policy = policy_from_row($row, policy_allowlist($private));
        } catch (LedgerError $e) {
            reply34(400, ['ok' => false, 'code' => $e->reason, 'error' => $e->getMessage()]);
        }
        if (array_key_exists('purchase', $m) && $m['purchase'] !== null && ($policy === null || ledger_canonical($m['purchase']) !== ledger_canonical($policy))) {
            reply34(400, ['ok' => false, 'code' => 'policy-mismatch', 'error' => 'The purchase policy of a coin is the one registered with it in the Coin Creation Studio']);
        }
        $known = $db->prepare('SELECT state FROM ledger_coins WHERE coin_id=?');
        $known->execute([$coinId]);
        $state = $known->fetchColumn();
        $known->closeCursor();
        if ($state !== false && !($multi && $state === 'pending')) reply34(409, ['ok' => false, 'code' => 'already-open', 'error' => 'This coin already has a ledger']);
        if ($multi) {
            // A coin that is waiting for signatures keeps its genesis and reference secret, so opening can be repeated.
            $roster = json_decode((string) $row['roster'], true);
            if (!is_array($roster) || ($roster[0] ?? null) !== $host || count($roster) < 2) reply34(400, ['ok' => false, 'error' => 'The coin record has no usable roster']);
            $unpinned = array_values(array_filter($roster, fn($d) => $d !== $host && !isset($peerConfig['pinned'][$d])));
            if ($unpinned) reply34(400, ['ok' => false, 'code' => 'needs-partners', 'error' => 'No key is pinned for: ' . implode(', ', $unpinned), 'missing' => $unpinned]);
            $treasury = is_file($private . '/treasury-' . $coinId . '.json') ? ledger_treasury_key_load($private, $coinId) : ledger_treasury_key_create($private, $coinId);
            if ($state === 'pending') {
                $held = ledger_coin($db, $coinId);
                $genesis = $held['genesis'];
                $secret = $held['ref_secret'];
            } else {
                $isPrivate = ($row['visibility'] ?? 'public') === 'private';
                $secret = $isPrivate ? bin2hex(random_bytes(32)) : null;
                $members = array_map(fn($d) => ['domain' => $d, 'key' => $d === $host ? $domainPublic : $peerConfig['pinned'][$d]], $roster);
                $genesis = ledger_genesis(['coinId' => $coinId, 'symbol' => $row['symbol'], 'name' => $row['name'], 'decimals' => (int) $row['decimals'], 'maxUnits' => (string) $row['max_units'],
                    'initialUnits' => (string) $row['initial_units'], 'treasuryKey' => $treasury['key'], 'mode' => 'multi', 'visibility' => $isPrivate ? 'private' : 'public',
                    'roster' => $members, 'threshold' => (int) $row['threshold'], 'createdAt' => (string) $row['created_at'], 'refSecret' => $secret, 'faucet' => $m['faucet'] ?? null, 'purchase' => $policy]);
            }
            peer_open_multi($db, $node, $genesis, $treasury['key'], $secret, $send, $now);
            reply34(201, ['ok' => true, 'coin' => ledger_public_coin($db, $coinId), 'treasuryRef' => $genesis['treasuryRef']]);
        }
        $isPrivate = ($row['visibility'] ?? 'public') === 'private';
        $secret = $isPrivate ? bin2hex(random_bytes(32)) : null;
        // A key file left by an attempt that stopped before the ledger was written is reused, never replaced.
        $treasury = is_file($private . '/treasury-' . $coinId . '.json') ? ledger_treasury_key_load($private, $coinId) : ledger_treasury_key_create($private, $coinId);
        $genesis = ledger_genesis(['coinId' => $coinId, 'symbol' => $row['symbol'], 'name' => $row['name'], 'decimals' => (int) $row['decimals'], 'maxUnits' => (string) $row['max_units'],
            'initialUnits' => (string) $row['initial_units'], 'treasuryKey' => $treasury['key'], 'mode' => 'single', 'visibility' => $isPrivate ? 'private' : 'public',
            'roster' => [['domain' => $host, 'key' => $domainPublic]], 'createdAt' => (string) $row['created_at'], 'refSecret' => $secret, 'faucet' => $m['faucet'] ?? null, 'purchase' => $policy]);
        ledger_register($db, $genesis, $treasury['key'], $secret);
        ledger_add_genesis_signature($db, $coinId, $host, ledger_genesis_sign($genesis, $domainPrivate));
        ledger_activate($db, $coinId, $domainPrivate);
        reply34(201, ['ok' => true, 'coin' => ledger_public_coin($db, $coinId), 'treasuryRef' => $genesis['treasuryRef']]);
    }
    if ($action === 'compare') {
        $coin = ledger_coin($db, $coinId);
        if ($coin['mode'] !== 'multi') reply34(409, ['ok' => false, 'code' => 'not-multi', 'error' => 'Only a multi authority coin has partners to compare with']);
        reply34(200, ['ok' => true] + peer_compare_heads($db, $node, $coinId, peer_http_sender($peerConfig, 5), $now));
    }
    if ($action === 'evidence') {
        reply34(200, ['ok' => true, 'state' => ledger_coin($db, $coinId)['state'], 'evidence' => ledger_evidence($db, $coinId)]);
    }
    if ($action === 'recover') {
        $coin = ledger_coin($db, $coinId);
        if ($coin['mode'] !== 'multi' || $coin['genesis']['authority'] !== $host) reply34(409, ['ok' => false, 'code' => 'not-authority', 'error' => 'Only the authority of a multi authority coin recovers']);
        reply34(200, ['ok' => true, 'results' => peer_recover($db, $node, $coinId, $send, $now)]);
    }
    if ($action === 'purchase-recover' || $action === 'purchase-cancel') {
        $coin = ledger_coin($db, $coinId);
        if ($coin['genesis']['authority'] !== $host) reply34(409, ['ok' => false, 'code' => 'not-authority', 'error' => 'Only the authority sells']);
        if ($gold === null || !is_callable($gold['release'] ?? null) || !is_callable($gold['finish'] ?? null)) reply34(503, ['ok' => false, 'code' => 'purchases-off', 'error' => 'Gold purchases are not enabled on this domain']);
        if ($action === 'purchase-cancel') {
            $requestId = $m['requestId'] ?? null;
            if (!is_string($requestId) || !preg_match('/^[a-f0-9]{32,64}$/D', $requestId)) reply34(400, ['ok' => false, 'error' => 'Invalid requestId']);
            purchase_cancel($db, $gold, $coinId, $requestId, $node, $coin['mode'] === 'multi' ? $send : null);
            reply34(200, ['ok' => true]);
        }
        reply34(200, ['ok' => true, 'results' => purchase_recover($db, $node, $gold, ledger_treasury_key_load($private, $coinId), $coinId, $coin['mode'] === 'multi' ? $send : null, $now)]);
    }
    if ($action === 'grant') {
        $to = $m['to'] ?? null;
        $amount = $m['amount'] ?? null;
        if (!is_string($to) || !is_string($amount)) reply34(400, ['ok' => false, 'error' => 'Expected to and amount']);
        $coin = ledger_coin($db, $coinId);
        if ($coin['mode'] !== 'single') {
            if ($coin['genesis']['authority'] !== $host) reply34(409, ['ok' => false, 'code' => 'not-authority', 'error' => 'Grant from the authority of this coin']);
            $authorization = ledger_grant_authorization($db, $coinId, ledger_treasury_key_load($private, $coinId), $to, $amount, $now);
            reply34(...execute_multi34($db, $node, $send, $coinId, $authorization, $now));
        }
        $prepared = ledger_grant($db, $coinId, ledger_treasury_key_load($private, $coinId), $to, $amount, $now);
        $done = ledger_commit($db, $coinId, $prepared, ledger_sign($domainPrivate, $prepared['hash']), [], $now);
        reply34(201, ['ok' => true, 'receipt' => spend_receipt($db, $coinId, $done['index'])]);
    }
    reply34(404, ['ok' => false, 'error' => 'Unknown action']);
} catch (LedgerError $e) {
    fail34($e);
} catch (Throwable $e) {
    reply34(500, ['ok' => false, 'error' => 'Unexpected error']);
}
