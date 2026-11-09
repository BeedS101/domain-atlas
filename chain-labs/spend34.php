<?php
declare(strict_types=1);
/**
 * Chainblock Labs 34: spending, receipts and holdings for single authority coins. Experimental; test coins only.
 *
 * Reads:  GET coins, coin, receipt, proposal.
 * Wallet: POST challenge, holdings (public coins to anyone, private coins to a key-signed challenge), propose (an
 *         owner-signed transfer, executed at once by this domain for a single authority coin).
 * Operator (private operator token): POST open (opens a coin of the coin registry as a ledger), grant (a treasury spend).
 * Storage: chain34.sqlite and the treasury key files in the private folder beside the web root, never inside it.
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
require __DIR__ . '/lib/spend.php';
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
try {
    $db = ledger_open($private . '/chain34.sqlite');
} catch (Throwable $e) {
    reply34(503, ['ok' => false, 'error' => 'Ledger storage unavailable']);
}

const SPEND34_STATUS = [
    'bad-signature' => 401, 'bad-challenge' => 401, 'unknown-coin' => 404, 'unknown-proposal' => 404, 'unknown-entry' => 404,
    'stale' => 409, 'replayed' => 409, 'pending-exists' => 409, 'insufficient' => 409, 'closed' => 409, 'not-active' => 409, 'expired' => 409,
    'wrong-index' => 409, 'wrong-prev' => 409, 'key-exists' => 409, 'busy' => 429, 'needs-approvals' => 202,
];
function fail34(LedgerError $e): never
{
    reply34(SPEND34_STATUS[$e->reason] ?? 400, ['ok' => false, 'code' => $e->reason, 'error' => $e->getMessage()]);
}
function body34(): array
{
    if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 8192) reply34(413, ['ok' => false, 'error' => 'Request too large']);
    $raw = file_get_contents('php://input', false, null, 0, 8193);
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

$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';
$now = time();
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
        reply34(200, ['ok' => true] + ledger_public_coin($db, arg34('coin', '/^[a-f0-9]{32}$/D')));
    }
    if ($method === 'GET' && $action === 'receipt') {
        reply34(200, ['ok' => true, 'receipt' => spend_receipt($db, arg34('coin', '/^[a-f0-9]{32}$/D'), (int) arg34('index', '/^\d{1,9}$/D'))]);
    }
    if ($method === 'GET' && $action === 'proposal') {
        $row = spend_proposal($db, arg34('coin', '/^[a-f0-9]{32}$/D'), arg34('digest', '/^[a-f0-9]{64}$/D'));
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
            $state = spend_submit($db, $payload['coinId'], $authorization, $now);
            reply34(202, ['ok' => true, 'proposal' => $state, 'note' => 'Waiting for approvals from the other domains']);
        }
        reply34(201, ['ok' => true, 'receipt' => spend_submit_and_execute($db, $payload['coinId'], $authorization, $domainPrivate, $now)]);
    }

    // Operator actions.
    if ($action === 'open' || $action === 'grant') {
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
        if (($row['mode'] ?? 'single') !== 'single') reply34(400, ['ok' => false, 'code' => 'needs-partners', 'error' => 'A multi authority coin opens once its partner domains can sign the genesis']);
        $known = $db->prepare('SELECT 1 FROM ledger_coins WHERE coin_id=?');
        $known->execute([$coinId]);
        if ($known->fetchColumn()) reply34(409, ['ok' => false, 'code' => 'already-open', 'error' => 'This coin already has a ledger']);
        $isPrivate = ($row['visibility'] ?? 'public') === 'private';
        $secret = $isPrivate ? bin2hex(random_bytes(32)) : null;
        // A key file left by an attempt that stopped before the ledger was written is reused, never replaced.
        $treasury = is_file($private . '/treasury-' . $coinId . '.json') ? ledger_treasury_key_load($private, $coinId) : ledger_treasury_key_create($private, $coinId);
        $genesis = ledger_genesis(['coinId' => $coinId, 'symbol' => $row['symbol'], 'name' => $row['name'], 'decimals' => (int) $row['decimals'], 'maxUnits' => (string) $row['max_units'],
            'initialUnits' => (string) $row['initial_units'], 'treasuryKey' => $treasury['key'], 'mode' => 'single', 'visibility' => $isPrivate ? 'private' : 'public',
            'roster' => [['domain' => $host, 'key' => $domainPublic]], 'createdAt' => (string) $row['created_at'], 'refSecret' => $secret, 'faucet' => $m['faucet'] ?? null]);
        ledger_register($db, $genesis, $treasury['key'], $secret);
        ledger_add_genesis_signature($db, $coinId, $host, ledger_genesis_sign($genesis, $domainPrivate));
        ledger_activate($db, $coinId, $domainPrivate);
        reply34(201, ['ok' => true, 'coin' => ledger_public_coin($db, $coinId), 'treasuryRef' => $genesis['treasuryRef']]);
    }
    if ($action === 'grant') {
        $to = $m['to'] ?? null;
        $amount = $m['amount'] ?? null;
        if (!is_string($to) || !is_string($amount)) reply34(400, ['ok' => false, 'error' => 'Expected to and amount']);
        $prepared = ledger_grant($db, $coinId, ledger_treasury_key_load($private, $coinId), $to, $amount, $now);
        $coin = ledger_coin($db, $coinId);
        if ($coin['mode'] !== 'single') reply34(202, ['ok' => false, 'code' => 'needs-approvals', 'error' => 'A multi authority coin needs approvals from the other domains']);
        $done = ledger_commit($db, $coinId, $prepared, ledger_sign($domainPrivate, $prepared['hash']), [], $now);
        reply34(201, ['ok' => true, 'receipt' => spend_receipt($db, $coinId, $done['index'])]);
    }
    reply34(404, ['ok' => false, 'error' => 'Unknown action']);
} catch (LedgerError $e) {
    fail34($e);
} catch (Throwable $e) {
    reply34(500, ['ok' => false, 'error' => 'Unexpected error']);
}
