<?php
declare(strict_types=1);
/**
 * Chainblock Labs 35: the scanner's read routes. Experimental; test coins only.
 *
 * Everything here is GET and read-only: the ledger is opened read-only, so no route can change a coin.
 *   coins                          the coins of this domain
 *   coin&coin=ID                   genesis, state, supply, treasury, head and, for a frozen coin, why it is frozen
 *   entries&coin=ID&after=N&limit  a page of the log, oldest first, public forms with hashes and signatures
 *   entry&coin=ID&index=N          one entry
 *   account&coin=ID&ref=REF&after&limit
 *                                  an account by reference (the key itself in a public coin, a keyed hash in a private
 *                                  one) with a page of its entries
 *   domains&coin=ID                the signed head each roster domain states, and whether they agree
 * Only public forms are read. A private coin's pages carry references and amounts; the keys behind the references and the
 * private forms of the entries never leave the ledger. The page that shows all this is scan35.html.
 * Pages are at most LEDGER_PAGE_MAX entries, so a view never walks a whole coin. The domains route asks the other roster
 * domains for their heads, so its answer is kept for SCAN35_HEADS_TTL seconds.
 */
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
function reply35(int $status, array $body): never { http_response_code($status); echo json_encode($body, JSON_UNESCAPED_SLASHES); exit; }
if (!extension_loaded('pdo_sqlite') || !extension_loaded('openssl')) reply35(503, ['ok' => false, 'error' => 'OpenSSL and PDO SQLite are required']);
if (empty($_SERVER['HTTPS']) || $_SERVER['HTTPS'] === 'off') reply35(403, ['ok' => false, 'error' => 'HTTPS required']);
$host = strtolower($_SERVER['HTTP_HOST'] ?? '');
require __DIR__ . '/lib/hosts.php';
if (!chainlabs_is_host($host)) reply35(400, ['ok' => false, 'error' => 'Unrecognized host']);
require __DIR__ . '/lib/peer.php';
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') reply35(405, ['ok' => false, 'error' => 'Read only']);
$root = realpath($_SERVER['DOCUMENT_ROOT'] ?? '');
$private = $root ? realpath(dirname($root) . '/chainblock-labs-private') : false;
if (!$private || str_starts_with($private . '/', $root . '/')) reply35(503, ['ok' => false, 'error' => 'Private storage unavailable']);

const SCAN35_HEADS_TTL = 15;
const SCAN35_STATUS = ['unknown-coin' => 404, 'unknown-entry' => 404, 'unknown-account' => 404, 'bad-node' => 503];

function scan35_arg(string $name, string $pattern, ?string $default = null): string
{
    $v = $_GET[$name] ?? $default;
    if (!is_string($v) || !preg_match($pattern, $v)) reply35(400, ['ok' => false, 'error' => 'Invalid ' . $name]);
    return $v;
}

// Paging: a start after an index and a count, both whole numbers; the count is capped by the ledger.
function scan35_page(): array
{
    return [(int) scan35_arg('after', '/^-?\d{1,9}$/D', '-1'), (int) scan35_arg('limit', '/^\d{1,3}$/D', '25')];
}

// What a frozen coin's evidence may show: the kind, and for a disagreement the signed statements and public forms that prove
// it. A record of invalid history holds an entry's private form, so only its index and reason are shown.
function scan35_evidence(PDO $db, string $coinId): array
{
    $out = [];
    foreach (array_slice(ledger_evidence($db, $coinId), 0, 5) as $row) {
        $detail = is_array($row['detail']) ? $row['detail'] : [];
        $shown = ['kind' => $row['kind']];
        if ($row['kind'] === 'invalid-history') {
            $shown += ['index' => is_int($detail['index'] ?? null) ? $detail['index'] : null, 'reason' => is_string($detail['reason'] ?? null) ? substr($detail['reason'], 0, 40) : null,
                'message' => is_string($detail['message'] ?? null) ? substr($detail['message'], 0, 200) : null];
        } elseif (in_array($row['kind'], ['fork', 'rollback', 'authority-equivocation'], true) && is_array($detail['items'] ?? null) && array_is_list($detail['items'])) {
            $shown['items'] = [];
            foreach (array_slice($detail['items'], 0, 2) as $item) {
                $shown['items'][] = is_array($item) ? array_intersect_key($item, array_flip(['payload', 'signature', 'authoritySignature', 'public', 'hash'])) : null;
            }
        }
        $out[] = ['id' => $row['id'], 'createdAt' => $row['createdAt'], 'detail' => $shown];
    }
    return $out;
}

// A coin that is still waiting for the signatures of its domains has no log to show.
function scan35_coin(PDO $db, string $coinId): array
{
    $coin = ledger_coin($db, $coinId);
    if (!in_array($coin['state'], ['active', 'frozen'], true)) ledger_fail('unknown-coin', 'no such coin');
    return $coin;
}

function scan35_treasury(PDO $db, string $coinId, array $genesis): ?array
{
    $t = ledger_public_account($db, $coinId, $genesis['treasuryRef'], -1, 1);
    return $t === null ? null : ['ref' => $t['ref'], 'units' => $t['units'], 'seq' => $t['seq']];
}

// The public form of the entries at these log positions, by index.
function scan35_entries_at(PDO $db, string $coinId, array $indexes): array
{
    if (!$indexes) return [];
    $rows = $db->prepare('SELECT idx,hash,public_json FROM ledger_log WHERE coin_id=? AND idx IN (' . implode(',', array_map('intval', $indexes)) . ')');
    $rows->execute([$coinId]);
    $by = [];
    foreach ($rows->fetchAll(PDO::FETCH_ASSOC) as $row) $by[(int) $row['idx']] = ['entry' => json_decode($row['public_json'], true), 'hash' => $row['hash']];
    return $by;
}

// Each roster domain's signed head next to this domain's own. The statements are returned as the domains signed them, so the
// page can check the signatures against the roster keys in the genesis itself; the verdicts here are for reading.
//   equal, behind (holds an older entry of this chain), ahead (claims entries this copy does not have),
//   fork (another entry at an index both hold), unreachable, bad-answer
function scan35_domains(PDO $db, string $private, string $host, string $coinId, int $now): array
{
    $coin = scan35_coin($db, $coinId);
    $head = ledger_head($db, $coinId);
    $cacheFile = $private . '/scan35-heads-' . $coinId . '.json';
    $cached = is_file($cacheFile) ? json_decode((string) @file_get_contents($cacheFile, false, null, 0, 262145), true) : null;
    if (is_array($cached) && is_int($cached['at'] ?? null) && $now - $cached['at'] >= 0 && $now - $cached['at'] < SCAN35_HEADS_TTL
        && ($cached['head'] ?? null) === $head && ($cached['state'] ?? null) === $coin['state'] && is_array($cached['body'] ?? null)) return ['cached' => true] + $cached['body'];

    $config = $private . '/federation20-config.php';
    $c = is_file($config) ? require $config : null;
    $pem = is_array($c) ? base64_decode((string) ($c['private_pem_b64'] ?? ''), true) : false;
    if (!$pem || !openssl_pkey_get_private($pem)) ledger_fail('bad-node', 'this domain has no usable key to ask the other domains');
    $peerConfig = peer_load_config($host, $private, $c, chainlabs_peer_map());
    $node = ['domain' => $host, 'private' => $pem, 'pinned' => $peerConfig['pinned']];
    $send = peer_http_sender($peerConfig, 4);
    $genesis = $coin['genesis'];
    $rows = [];
    foreach ($genesis['roster'] as $member) {
        $domain = $member['domain'];
        $row = ['domain' => $domain, 'authority' => $domain === $genesis['authority'], 'self' => $domain === $host, 'status' => null, 'state' => null, 'head' => null];
        if ($domain === $host) {
            $row['status'] = 'self';
            $row['state'] = $coin['state'];
            $row['head'] = peer_head_attestation($db, $node, $coinId, $now);
        } else {
            try {
                $answer = $send($domain, peer_envelope($node, $domain, 'head', ['coinId' => $coinId], $now));
                $theirs = peer_check_attestation($coin, $answer['head'] ?? null, $domain, $now);
                $row['head'] = $answer['head'];
                $row['state'] = is_string($answer['state'] ?? null) ? substr($answer['state'], 0, 20) : null;
                if ($theirs['index'] > $head['index']) $row['status'] = 'ahead';
                else $row['status'] = peer_hash_at($db, $coinId, $theirs['index']) === $theirs['hash'] ? ($theirs['index'] === $head['index'] ? 'equal' : 'behind') : 'fork';
            } catch (LedgerError $e) {
                $row['status'] = in_array($e->reason, ['peer-down', 'unknown-peer'], true) ? 'unreachable' : 'bad-answer';
            }
        }
        $rows[] = $row;
    }
    $statuses = array_column($rows, 'status');
    $summary = in_array('fork', $statuses, true) ? 'fork'
        : (array_intersect($statuses, ['unreachable', 'bad-answer']) ? 'incomplete'
        : (array_diff($statuses, ['self', 'equal']) ? 'lagging' : (count($rows) === 1 ? 'single' : 'agree')));
    $body = ['coinId' => $coinId, 'state' => $coin['state'], 'authority' => $genesis['authority'], 'threshold' => (int) $coin['threshold'], 'head' => $head,
        'summary' => $summary, 'checkedAt' => gmdate('Y-m-d\TH:i:s\Z', $now), 'domains' => $rows];
    $tmp = $cacheFile . '.' . bin2hex(random_bytes(4)) . '.tmp';
    if (@file_put_contents($tmp, json_encode(['at' => $now, 'head' => $head, 'state' => $coin['state'], 'body' => $body], JSON_UNESCAPED_SLASHES), LOCK_EX) !== false) {
        if (!@rename($tmp, $cacheFile)) @unlink($tmp);
    }
    return ['cached' => false] + $body;
}

$file = $private . '/chain34.sqlite';
$action = $_GET['action'] ?? '';
try {
    if (!is_file($file)) {
        if ($action === 'coins') reply35(200, ['ok' => true, 'domain' => $host, 'coins' => []]);
        reply35(404, ['ok' => false, 'code' => 'unknown-coin', 'error' => 'no such coin']);
    }
    // Read-only: a route that tried to write would fail.
    $db = new PDO('sqlite:file:' . $file . '?mode=ro', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5]);
    $db->exec('PRAGMA busy_timeout=5000');
} catch (Throwable $e) {
    reply35(503, ['ok' => false, 'error' => 'Ledger storage unavailable']);
}

try {
    if ($action === 'coins') {
        $out = [];
        foreach ($db->query("SELECT coin_id FROM ledger_coins WHERE state IN ('active','frozen') ORDER BY coin_id LIMIT 100")->fetchAll(PDO::FETCH_COLUMN) as $id) {
            $coin = ledger_coin($db, $id);
            $g = $coin['genesis'];
            $out[] = ['coinId' => $id, 'symbol' => $g['symbol'], 'name' => $g['name'], 'decimals' => $g['decimals'], 'visibility' => $g['visibility'], 'mode' => $g['mode'],
                'state' => $coin['state'], 'authority' => $g['authority'], 'entries' => ledger_head($db, $id)['index'] + 1];
        }
        reply35(200, ['ok' => true, 'domain' => $host, 'coins' => $out]);
    }
    if ($action === 'coin') {
        $coinId = scan35_arg('coin', '/^[a-f0-9]{32}$/D');
        scan35_coin($db, $coinId);
        $view = ledger_public_coin($db, $coinId);
        $view['treasury'] = scan35_treasury($db, $coinId, $view['genesis']);
        $view['evidence'] = $view['state'] === 'frozen' ? scan35_evidence($db, $coinId) : [];
        reply35(200, ['ok' => true, 'domain' => $host, 'pageMax' => LEDGER_PAGE_MAX] + $view);
    }
    if ($action === 'entries') {
        $coinId = scan35_arg('coin', '/^[a-f0-9]{32}$/D');
        [$after, $limit] = scan35_page();
        scan35_coin($db, $coinId);
        $page = ledger_public_entries($db, $coinId, max(-1, $after), $limit);
        $head = ledger_head($db, $coinId);
        reply35(200, ['ok' => true, 'head' => $head] + $page + ['more' => $page['next'] !== null && $page['next'] < $head['index']]);
    }
    if ($action === 'entry') {
        $coinId = scan35_arg('coin', '/^[a-f0-9]{32}$/D');
        $index = (int) scan35_arg('index', '/^\d{1,9}$/D');
        scan35_coin($db, $coinId);
        $page = ledger_public_entries($db, $coinId, $index - 1, 1);
        if (!$page['entries'] || $page['entries'][0]['entry']['index'] !== $index) reply35(404, ['ok' => false, 'code' => 'unknown-entry', 'error' => 'no such entry']);
        reply35(200, ['ok' => true, 'head' => ledger_head($db, $coinId)] + $page['entries'][0]);
    }
    if ($action === 'account') {
        $coinId = scan35_arg('coin', '/^[a-f0-9]{32}$/D');
        $ref = scan35_arg('ref', '/^[A-Za-z0-9_-]{16,200}$/D');
        [$after, $limit] = scan35_page();
        $genesis = scan35_coin($db, $coinId)['genesis'];
        $account = ledger_public_account($db, $coinId, $ref, max(-1, $after), $limit);
        if ($account === null) reply35(404, ['ok' => false, 'code' => 'unknown-account', 'error' => 'no such account']);
        $at = scan35_entries_at($db, $coinId, array_column($account['entries'], 'index'));
        foreach ($account['entries'] as &$item) $item += $at[$item['index']] ?? ['entry' => null, 'hash' => null];
        unset($item);
        $more = false;
        if ($account['next'] !== null) {
            $rest = $db->prepare('SELECT 1 FROM ledger_account_entries WHERE coin_id=? AND ref=? AND pos>? LIMIT 1');
            $rest->execute([$coinId, $ref, $account['next']]);
            $more = (bool) $rest->fetchColumn();
        }
        reply35(200, ['ok' => true, 'visibility' => $genesis['visibility'], 'decimals' => $genesis['decimals'], 'symbol' => $genesis['symbol'], 'treasury' => $ref === $genesis['treasuryRef'], 'more' => $more] + $account);
    }
    if ($action === 'domains') {
        $coinId = scan35_arg('coin', '/^[a-f0-9]{32}$/D');
        reply35(200, ['ok' => true] + scan35_domains($db, $private, $host, $coinId, time()));
    }
    reply35(404, ['ok' => false, 'error' => 'Unknown action']);
} catch (LedgerError $e) {
    reply35(SCAN35_STATUS[$e->reason] ?? 400, ['ok' => false, 'code' => $e->reason, 'error' => $e->getMessage()]);
} catch (Throwable $e) {
    reply35(500, ['ok' => false, 'error' => 'Unexpected error']);
}
