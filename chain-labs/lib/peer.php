<?php
declare(strict_types=1);
// Messages between the domains of a multi authority coin: opening a coin together, keeping each domain's copy of the log
// level, and approving entries. Each domain signs its requests; the receiver checks them against the key it pinned for that
// domain. Transport is a callable, so the same handlers run in-process in tests and over HTTPS in the endpoint.
// Include-only: a direct request gets a 404.
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; }
require_once __DIR__ . '/spend.php';

const PEER_MAX_AGE_SECONDS = 120;
const PEER_MAX_PENDING_COINS = 100;
const PEER_SYNC_PAGE = 50;
const PEER_MAX_ATTEMPTS = 12;

// A node: ['domain' => this domain, 'private' => its private key PEM, 'pinned' => [other domain => public key PEM]].
// $send is callable(string $domain, array $envelope): array, returning the decoded answer or throwing a LedgerError.

function peer_public(array $node): string
{
    $key = openssl_pkey_get_private($node['private']);
    if ($key === false) ledger_fail('bad-node', 'the node key is not usable');
    return openssl_pkey_get_details($key)['key'];
}

function peer_same_key(string $a, string $b): bool
{
    $clean = static fn(string $pem): string => preg_replace('/\s+/', '', $pem);
    return $clean($a) === $clean($b);
}

function peer_envelope(array $node, string $to, string $action, array $body, int $now): array
{
    $payload = ['type' => 'atlas.peer.request', 'v' => 1, 'from' => $node['domain'], 'to' => $to, 'action' => $action, 'body' => $body,
        'issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $now), 'nonce' => bin2hex(random_bytes(16))];
    return ['payload' => $payload, 'signature' => ledger_sign($node['private'], ledger_canonical($payload))];
}

// Checks a request from another domain: addressed to this node, from a pinned domain, recent, correctly signed and not
// seen before. Returns [sender, action, body].
function peer_open(PDO $db, array $node, array $envelope, int $now): array
{
    $payload = $envelope['payload'] ?? null;
    if (!is_array($payload) || array_is_list($payload)) ledger_fail('bad-request', 'the request has no payload');
    $fields = array_keys($payload);
    sort($fields);
    if ($fields !== ['action', 'body', 'from', 'issuedAt', 'nonce', 'to', 'type', 'v']) ledger_fail('bad-request', 'the request has the wrong fields');
    if ($payload['type'] !== 'atlas.peer.request' || $payload['v'] !== 1 || !is_string($payload['action']) || !is_array($payload['body'])) ledger_fail('bad-request', 'the request is malformed');
    if ($payload['to'] !== $node['domain']) ledger_fail('bad-request', 'the request is for another domain');
    $from = $payload['from'];
    $pinned = is_string($from) ? ($node['pinned'][$from] ?? null) : null;
    if ($pinned === null || $from === $node['domain']) ledger_fail('unknown-peer', 'the sender is not a pinned domain');
    $at = is_string($payload['issuedAt']) ? strtotime($payload['issuedAt']) : false;
    if ($at === false || abs($now - $at) > PEER_MAX_AGE_SECONDS) ledger_fail('bad-time', 'the request is not recent');
    if (!is_string($payload['nonce']) || !preg_match('/^[a-f0-9]{32}$/D', $payload['nonce'])) ledger_fail('bad-request', 'the nonce is malformed');
    if (!ledger_verify($pinned, ledger_canonical($payload), $envelope['signature'] ?? null)) ledger_fail('bad-signature', 'the request signature does not verify');
    $db->prepare('DELETE FROM ledger_peer_nonces WHERE expires_at < ?')->execute([$now]);
    try {
        $db->prepare('INSERT INTO ledger_peer_nonces(sender,nonce,expires_at) VALUES(?,?,?)')->execute([$from, $payload['nonce'], $now + 2 * PEER_MAX_AGE_SECONDS]);
    } catch (PDOException $e) {
        ledger_fail('replayed', 'this request was already received');
    }
    return [$from, $payload['action'], $payload['body']];
}

function peer_handle(PDO $db, array $node, array $envelope, int $now, callable $send): array
{
    [$from, $action, $body] = peer_open($db, $node, $envelope, $now);
    return match ($action) {
        'genesis' => peer_on_genesis($db, $node, $from, $body),
        'sync' => peer_on_sync($db, $from, $body),
        'approve' => peer_on_approve($db, $node, $from, $body, $now, $send),
        'notify' => peer_on_notify($db, $node, $from, $body, $now, $send),
        default => ledger_fail('unknown-action', 'unknown peer action'),
    };
}

// ---------- opening a coin together ----------

// A partner receives a genesis from the authority. It signs only a genesis that names itself with its own key, names
// every other domain with the key it pinned, and comes from the authority it names.
function peer_on_genesis(PDO $db, array $node, string $from, array $body): array
{
    $genesis = $body['genesis'] ?? null;
    $treasuryKey = $body['treasuryKey'] ?? null;
    $secret = $body['refSecret'] ?? null;
    if (!is_array($genesis) || !is_string($treasuryKey) || ($secret !== null && !is_string($secret))) ledger_fail('bad-genesis', 'the genesis message is malformed');
    if (($genesis['authority'] ?? null) !== $from) ledger_fail('bad-genesis', 'the genesis names another authority');
    $named = false;
    foreach (is_array($genesis['roster'] ?? null) ? $genesis['roster'] : [] as $member) {
        $domain = is_array($member) ? ($member['domain'] ?? null) : null;
        $key = is_array($member) ? ($member['key'] ?? null) : null;
        if (!is_string($domain) || !is_string($key)) ledger_fail('bad-genesis', 'the roster is malformed');
        if ($domain === $node['domain']) {
            if (!peer_same_key($key, peer_public($node))) ledger_fail('bad-genesis', 'the genesis carries another key for this domain');
            $named = true;
        } elseif (!isset($node['pinned'][$domain]) || !peer_same_key($key, $node['pinned'][$domain])) {
            ledger_fail('bad-genesis', 'the genesis carries a key that is not the one pinned for ' . $domain);
        }
    }
    if (!$named) ledger_fail('not-in-roster', 'this domain is not in the roster');
    $coinId = $genesis['coinId'] ?? null;
    $existing = is_string($coinId) && preg_match('/^[a-f0-9]{32}$/D', $coinId) ? $db->prepare('SELECT genesis_digest,state FROM ledger_coins WHERE coin_id=?') : null;
    if ($existing) {
        $existing->execute([$coinId]);
        $row = $existing->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            if ($row['genesis_digest'] !== ledger_genesis_digest($genesis)) ledger_fail('exists', 'a different coin has this id');
            return ['signature' => ledger_genesis_sign($genesis, $node['private'])];
        }
    }
    if ((int) $db->query("SELECT COUNT(*) FROM ledger_coins WHERE state='pending'")->fetchColumn() >= PEER_MAX_PENDING_COINS) ledger_fail('busy', 'too many coins are waiting for signatures');
    ledger_register($db, $genesis, $treasuryKey, $secret);
    return ['signature' => ledger_genesis_sign($genesis, $node['private'])];
}

// The authority opens a multi coin: it registers the coin, collects every partner's genesis signature, opens the coin
// and tells the partners to pick up entry 0. Safe to run again after a failure: it asks only the domains still missing.
function peer_open_multi(PDO $db, array $node, array $genesis, string $treasuryKey, ?string $refSecret, callable $send, int $now): void
{
    $coinId = $genesis['coinId'];
    $known = $db->prepare('SELECT genesis_digest FROM ledger_coins WHERE coin_id=?');
    $known->execute([$coinId]);
    $digest = $known->fetchColumn();
    if ($digest === false) ledger_register($db, $genesis, $treasuryKey, $refSecret);
    elseif ($digest !== ledger_genesis_digest($genesis)) ledger_fail('exists', 'a different coin has this id');
    $coin = ledger_coin($db, $coinId);
    if ($coin['state'] !== 'pending') ledger_fail('not-pending', 'the coin is already open');
    if ($genesis['authority'] !== $node['domain']) ledger_fail('not-authority', 'only the authority opens a coin');
    ledger_add_genesis_signature($db, $coinId, $node['domain'], ledger_genesis_sign($genesis, $node['private']));
    $have = $db->prepare('SELECT domain FROM ledger_genesis_sigs WHERE coin_id=?');
    $have->execute([$coinId]);
    $signed = array_flip($have->fetchAll(PDO::FETCH_COLUMN));
    foreach ($genesis['roster'] as $member) {
        if (isset($signed[$member['domain']])) continue;
        $answer = $send($member['domain'], peer_envelope($node, $member['domain'], 'genesis', ['genesis' => $genesis, 'treasuryKey' => $treasuryKey, 'refSecret' => $refSecret], $now));
        ledger_add_genesis_signature($db, $coinId, $member['domain'], (string) ($answer['signature'] ?? ''));
    }
    ledger_activate($db, $coinId, $node['private']);
    peer_notify_all($db, $node, $coinId, $send, $now);
}

// ---------- keeping the copies level ----------

// A roster domain serves the entries after an index, private forms included, to another roster domain.
function peer_on_sync(PDO $db, string $from, array $body): array
{
    $coinId = $body['coinId'] ?? null;
    $after = $body['after'] ?? null;
    if (!is_string($coinId) || !preg_match('/^[a-f0-9]{32}$/D', $coinId) || !is_int($after) || $after < -1) ledger_fail('bad-request', 'a coin id and an index are needed');
    $coin = ledger_coin($db, $coinId);
    if (ledger_roster_key($coin['genesis'], $from) === null) ledger_fail('not-in-roster', 'only roster domains read the full log');
    return ['records' => ledger_records_after($db, $coinId, $after, PEER_SYNC_PAGE)];
}

// Pulls the entries this copy lacks from the authority and applies each one with every check. Returns how many it applied.
function peer_catch_up(PDO $db, array $node, string $coinId, callable $send, int $now): int
{
    $coin = ledger_coin($db, $coinId);
    $authority = $coin['genesis']['authority'];
    if ($authority === $node['domain']) return 0;
    $applied = 0;
    while (true) {
        $head = ledger_head($db, $coinId)['index'];
        $answer = $send($authority, peer_envelope($node, $authority, 'sync', ['coinId' => $coinId, 'after' => $head], $now));
        $records = $answer['records'] ?? null;
        if (!is_array($records)) ledger_fail('bad-history', 'the authority sent no records');
        foreach ($records as $record) {
            $index = is_array($record) ? ($record['index'] ?? null) : null;
            if (!is_int($index) || $index > ledger_head($db, $coinId)['index'] + 1) ledger_fail('bad-history', 'the authority sent records out of order');
            if ($index > ledger_head($db, $coinId)['index']) {
                try {
                    ledger_mirror_apply($db, $coinId, $record);
                    $applied++;
                    continue;
                } catch (LedgerError $e) {
                    // Another request on this domain may have written the same entry first.
                    if (!in_array($e->reason, ['wrong-index', 'wrong-prev', 'not-pending'], true) || $index > ledger_head($db, $coinId)['index']) throw $e;
                }
            }
            if (peer_hash_at($db, $coinId, $index) !== ($record['hash'] ?? null)) ledger_fail('bad-history', 'the authority sent an entry that differs from the one already held at ' . $index);
        }
        if (count($records) < PEER_SYNC_PAGE) return $applied;
    }
}

function peer_hash_at(PDO $db, string $coinId, int $index): ?string
{
    $q = $db->prepare('SELECT hash FROM ledger_log WHERE coin_id=? AND idx=?');
    $q->execute([$coinId, $index]);
    $hash = $q->fetchColumn();
    return $hash === false ? null : $hash;
}

function peer_on_notify(PDO $db, array $node, string $from, array $body, int $now, callable $send): array
{
    $coinId = $body['coinId'] ?? null;
    if (!is_string($coinId) || !preg_match('/^[a-f0-9]{32}$/D', $coinId)) ledger_fail('bad-request', 'a coin id is needed');
    $coin = ledger_coin($db, $coinId);
    if ($coin['genesis']['authority'] !== $from) ledger_fail('not-authority', 'only the authority sends notices');
    return ['applied' => peer_catch_up($db, $node, $coinId, $send, $now), 'head' => ledger_head($db, $coinId)];
}

// Tells every other roster domain to catch up. A domain that is down misses it and catches up on its next request.
function peer_notify_all(PDO $db, array $node, string $coinId, callable $send, int $now): void
{
    foreach (ledger_coin($db, $coinId)['genesis']['roster'] as $member) {
        if ($member['domain'] === $node['domain']) continue;
        try {
            $send($member['domain'], peer_envelope($node, $member['domain'], 'notify', ['coinId' => $coinId], $now));
        } catch (LedgerError $e) {
        }
    }
}

// ---------- approvals ----------

// A co-approver is asked to approve an entry the authority prepared. It first catches up, then runs every check against
// its own copy, not the authority's word, and signs only if its head is the one the entry extends. It never signs two
// different entries for one index while the first could still be committed.
function peer_on_approve(PDO $db, array $node, string $from, array $body, int $now, callable $send): array
{
    $coinId = $body['coinId'] ?? null;
    $prepared = $body['prepared'] ?? null;
    if (!is_string($coinId) || !preg_match('/^[a-f0-9]{32}$/D', $coinId) || !is_array($prepared)) ledger_fail('bad-request', 'a coin and a prepared entry are needed');
    $coin = ledger_coin($db, $coinId);
    if ($coin['genesis']['authority'] !== $from) ledger_fail('not-authority', 'only the authority asks for approvals');
    if (ledger_roster_key($coin['genesis'], $node['domain']) === null) ledger_fail('not-in-roster', 'this domain is not in the roster');
    peer_catch_up($db, $node, $coinId, $send, $now);
    $checked = ledger_validate_prepared($db, $coinId, $prepared, $now);
    $index = $checked['public']['index'];
    $hash = $checked['hash'];
    $at = strtotime($checked['public']['executedAt']);
    $db->exec('BEGIN IMMEDIATE');
    try {
        $prior = $db->prepare('SELECT hash,executed_at FROM ledger_approved WHERE coin_id=? AND idx=?');
        $prior->execute([$coinId, $index]);
        $row = $prior->fetch(PDO::FETCH_ASSOC);
        if ($row && $row['hash'] !== $hash && (int) $row['executed_at'] > $now - 2 * LEDGER_CLOCK_SKEW_SECONDS) {
            ledger_fail('equivocation', 'a different entry for this index was approved and could still be committed');
        }
        $db->prepare('INSERT OR REPLACE INTO ledger_approved(coin_id,idx,hash,executed_at) VALUES(?,?,?,?)')->execute([$coinId, $index, $hash, $at]);
        $db->exec('COMMIT');
    } catch (Throwable $e) {
        ledger_rollback($db);
        throw $e;
    }
    return ['decision' => 'approve', 'domain' => $node['domain'], 'signature' => ledger_sign($node['private'], ledger_approval_bytes($coinId, $index, $hash))];
}

// The authority asks the roster domains it has no approval from yet. Returns [approvals, refusals by domain]. Asking stops
// once enough approvals are in; the others catch up from the notice after the entry is written.
function peer_collect_approvals(PDO $db, array $node, string $coinId, array $prepared, array $approvals, callable $send, int $now): array
{
    $coin = ledger_coin($db, $coinId);
    $needed = (int) $coin['threshold'] - 1;
    $have = [];
    foreach ($approvals as $a) $have[$a['domain']] = true;
    $refused = [];
    foreach ($coin['genesis']['roster'] as $member) {
        if (count($approvals) >= $needed) break;
        $domain = $member['domain'];
        if ($domain === $node['domain'] || isset($have[$domain])) continue;
        try {
            $answer = $send($domain, peer_envelope($node, $domain, 'approve', ['coinId' => $coinId, 'prepared' => ['public' => $prepared['public'], 'private' => $prepared['private'], 'hash' => $prepared['hash']]], $now));
            $signature = $answer['signature'] ?? null;
            if (($answer['decision'] ?? null) !== 'approve' || ($answer['domain'] ?? null) !== $domain || !ledger_verify($member['key'], ledger_approval_bytes($coinId, $prepared['public']['index'], $prepared['hash']), $signature)) {
                $refused[$domain] = 'bad-approval';
                continue;
            }
            $approvals[] = ['domain' => $domain, 'signature' => $signature];
        } catch (LedgerError $e) {
            $refused[$domain] = $e->reason;
        }
    }
    return [$approvals, $refused];
}

// ---------- executing on a multi authority coin ----------

// The entry and approvals a pending proposal already holds, if the entry still extends the head and is recent enough to
// be committed.
function peer_stored_entry(array $row, array $head, int $now): ?array
{
    $stored = $row['prepared_json'] === null ? null : json_decode($row['prepared_json'], true);
    if (!is_array($stored) || ($stored['public']['index'] ?? null) !== $head['index'] + 1 || ($stored['public']['prevHash'] ?? null) !== $head['hash']) return null;
    $at = is_string($stored['public']['executedAt'] ?? null) ? strtotime($stored['public']['executedAt']) : false;
    if ($at === false || abs($at - $now) > LEDGER_CLOCK_SKEW_SECONDS - 10) return null;
    $approvals = $row['approvals_json'] === null ? [] : json_decode($row['approvals_json'], true);
    return ['prepared' => $stored, 'approvals' => is_array($approvals) ? $approvals : []];
}

function peer_store_entry(PDO $db, string $coinId, string $digest, ?array $prepared, array $approvals): void
{
    $db->prepare("UPDATE ledger_proposals SET prepared_json=?, approvals_json=? WHERE coin_id=? AND digest=? AND status='pending'")
        ->execute([$prepared === null ? null : ledger_canonical($prepared), $prepared === null ? null : ledger_canonical($approvals), $coinId, $digest]);
}

// Executes a pending proposal of a multi authority coin on the authority: prepares the entry, asks the other roster
// domains to approve it, and writes it once the threshold is met. The entry and the approvals are stored with the proposal,
// so a crash after the approvals came in is finished by recovery without asking again, and a second process finds the
// same approvals instead of collecting its own.
function peer_execute(PDO $db, array $node, string $coinId, string $digest, callable $send, int $now): array
{
    $coin = ledger_coin($db, $coinId);
    if ($coin['mode'] !== 'multi') ledger_fail('not-multi', 'a single authority coin is executed without approvals');
    if ($coin['genesis']['authority'] !== $node['domain']) ledger_fail('not-authority', 'only the authority executes');
    $needed = (int) $coin['threshold'] - 1;
    for ($attempt = 0;; $attempt++) {
        $row = spend_proposal($db, $coinId, $digest);
        if (!$row) ledger_fail('unknown-proposal', 'no such proposal');
        if ($row['status'] === 'executed') return spend_receipt($db, $coinId, (int) $row['executed_index']);
        if ($row['status'] !== 'pending') ledger_fail('closed', 'the proposal is ' . $row['status'] . ($row['reason'] ? ': ' . $row['reason'] : ''));
        $authorization = json_decode($row['authorization_json'], true);
        try {
            $clock = max($now, ledger_head_time($db, $coinId));
            $held = peer_stored_entry($row, ledger_head($db, $coinId), $clock);
            if ($held) {
                $prepared = $held['prepared'];
                $approvals = $held['approvals'];
            } else {
                $prepared = ledger_prepare_transfer($db, $coinId, $authorization, $clock);
                $approvals = [];
                peer_store_entry($db, $coinId, $digest, $prepared, $approvals);
            }
            if (count($approvals) < $needed) {
                [$approvals, $refused] = peer_collect_approvals($db, $node, $coinId, $prepared, $approvals, $send, $now);
                peer_store_entry($db, $coinId, $digest, $prepared, $approvals);
                if (count($approvals) < $needed) {
                    // Partners that refuse because another entry for this index is being approved, or because the head has
                    // moved, are asked again once that entry is written.
                    $moved = ledger_head($db, $coinId)['index'] !== $prepared['public']['index'] - 1;
                    if ($refused && !array_diff($refused, ['equivocation', 'wrong-index', 'wrong-prev']) && $attempt < PEER_MAX_ATTEMPTS && ($moved || $attempt < 3)) {
                        peer_store_entry($db, $coinId, $digest, null, []);
                        usleep(random_int(20000, 60000) * min($attempt + 1, 4));
                        continue;
                    }
                    ledger_fail('not-enough-approvals', 'the entry has ' . (count($approvals) + 1) . ' of ' . $coin['threshold'] . ' approvals' . ($refused ? '; refused by ' . implode(', ', array_map(fn($d, $r) => $d . ' (' . $r . ')', array_keys($refused), $refused)) : ''));
                }
            }
            $done = ledger_commit($db, $coinId, $prepared, ledger_sign($node['private'], $prepared['hash']), $approvals, $clock);
            peer_notify_all($db, $node, $coinId, $send, $now);
            return spend_receipt($db, $coinId, $done['index']);
        } catch (LedgerError $e) {
            $current = spend_proposal($db, $coinId, $digest);
            if ($current && $current['status'] === 'executed') return spend_receipt($db, $coinId, (int) $current['executed_index']);
            if (in_array($e->reason, ['wrong-index', 'wrong-prev'], true) && $attempt < PEER_MAX_ATTEMPTS) {
                peer_store_entry($db, $coinId, $digest, null, []);
                usleep(random_int(10000, 40000) * min($attempt + 1, 4));
                continue;
            }
            if (in_array($e->reason, ['expired', 'stale', 'insufficient', 'replayed', 'bad-signature', 'bad-authorization', 'no-account', 'faucet-amount', 'faucet-limit'], true)) {
                spend_reject($db, $coinId, $digest, $e->reason === 'expired' ? 'expired' : 'rejected', $e->reason);
            }
            throw $e;
        }
    }
}

function peer_submit_and_execute(PDO $db, array $node, string $coinId, array $authorization, callable $send, int $now): array
{
    $state = spend_submit($db, $coinId, $authorization, $now);
    return peer_execute($db, $node, $coinId, $state['digest'], $send, $now);
}

// After a crash on the authority: expire what ran out, then finish every pending proposal that can still succeed, oldest
// first. A proposal without enough approvals stays pending.
function peer_recover(PDO $db, array $node, string $coinId, callable $send, int $now): array
{
    spend_expire($db, $coinId, $now);
    $rows = $db->prepare("SELECT digest FROM ledger_proposals WHERE coin_id=? AND status='pending' ORDER BY created_at, rowid");
    $rows->execute([$coinId]);
    $out = [];
    foreach ($rows->fetchAll(PDO::FETCH_COLUMN) as $digest) {
        try {
            $receipt = peer_execute($db, $node, $coinId, $digest, $send, $now);
            $out[$digest] = 'executed at ' . $receipt['entry']['index'];
        } catch (LedgerError $e) {
            $out[$digest] = $e->reason;
        }
    }
    return $out;
}

// ---------- configuration and HTTPS transport ----------

const PEER_HTTP_MAX_BYTES = 1048576;
const PEER_ENDPOINT = '/chain-labs/spend34.php?action=peer';

// A usable P-256 public key as PEM, or null.
function peer_clean_key(mixed $value): ?string
{
    $pem = is_string($value) ? base64_decode($value, true) : false;
    $key = is_string($pem) ? @openssl_pkey_get_public($pem) : false;
    if (!$key) return null;
    $d = openssl_pkey_get_details($key);
    return ($d['type'] ?? null) === OPENSSL_KEYTYPE_EC && ($d['ec']['curve_name'] ?? null) === 'prime256v1' ? $d['key'] : null;
}

// A peer URL override is for tests and private networks: https, or http to this machine only.
function peer_url_allowed(string $url): bool
{
    $parts = parse_url($url);
    if (!is_array($parts) || !isset($parts['host']) || isset($parts['user']) || isset($parts['fragment'])) return false;
    if (($parts['scheme'] ?? '') === 'https') return true;
    return ($parts['scheme'] ?? '') === 'http' && in_array($parts['host'], ['127.0.0.1', 'localhost', '[::1]'], true);
}

// The keys this domain pins and the addresses it reaches the other domains at.
//   chainlabs-peers.json in the private folder: { "keys": { "b.example": "<base64 of the PEM public key>" },
//                                                 "urls": { "b.example": "https://b.example/chain-labs/spend34.php?action=peer" } }
// The single peer of a two-domain lab may instead use peer_public_pem_b64 of the federation configuration. The file wins.
// A key that is not a P-256 public key, or a URL that is not allowed, leaves that domain unpinned.
function peer_load_config(string $host, string $privateDir, array $federation, array $peerMap): array
{
    $pinned = [];
    $urls = [];
    $mapped = $peerMap[$host] ?? null;
    if (is_string($mapped) && $mapped !== $host && ($key = peer_clean_key($federation['peer_public_pem_b64'] ?? null)) !== null) $pinned[$mapped] = $key;
    $file = rtrim($privateDir, '/\\') . '/chainlabs-peers.json';
    $raw = is_file($file) ? @file_get_contents($file, false, null, 0, 16385) : false;
    $doc = is_string($raw) && strlen($raw) <= 16384 ? json_decode($raw, true) : null;
    if (is_array($doc)) {
        foreach (is_array($doc['keys'] ?? null) ? $doc['keys'] : [] as $domain => $value) {
            if (!is_string($domain) || $domain === $host || !preg_match('/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/D', $domain)) continue;
            if (($key = peer_clean_key($value)) !== null) $pinned[$domain] = $key;
        }
        foreach (is_array($doc['urls'] ?? null) ? $doc['urls'] : [] as $domain => $url) {
            if (isset($pinned[$domain]) && is_string($url) && strlen($url) <= 300 && peer_url_allowed($url)) $urls[$domain] = $url;
        }
    }
    return ['pinned' => $pinned, 'urls' => $urls];
}

// The transport over HTTPS: a signed envelope is posted to the other domain and its answer decoded. Only pinned domains are
// reached, redirects are not followed, and the answer is size limited. A failure is a LedgerError, so callers treat an
// unreachable domain like a refusing one.
function peer_http_sender(array $config, int $timeout = 8): callable
{
    return static function (string $domain, array $envelope) use ($config, $timeout): array {
        if (!isset($config['pinned'][$domain])) ledger_fail('unknown-peer', $domain . ' is not a pinned domain');
        $url = $config['urls'][$domain] ?? 'https://' . $domain . PEER_ENDPOINT;
        $body = '';
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true, CURLOPT_POSTFIELDS => json_encode($envelope, JSON_UNESCAPED_SLASHES),
            CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'Host: ' . $domain], CURLOPT_RETURNTRANSFER => false,
            CURLOPT_CONNECTTIMEOUT => min(5, $timeout), CURLOPT_TIMEOUT => $timeout, CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS | CURLPROTO_HTTP, CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$body): int {
                $body .= $chunk;
                return strlen($body) > PEER_HTTP_MAX_BYTES ? 0 : strlen($chunk);
            },
        ]);
        $ok = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if ($ok === false || $status === 0) ledger_fail('peer-down', $domain . ' did not answer');
        $answer = json_decode($body, true);
        if (!is_array($answer)) ledger_fail('peer-bad-answer', $domain . ' sent an answer that is not JSON (HTTP ' . $status . ')');
        if (($answer['ok'] ?? false) !== true) {
            $code = is_string($answer['code'] ?? null) && preg_match('/^[a-z0-9-]{1,40}$/D', $answer['code']) ? $answer['code'] : 'peer-refused';
            ledger_fail($code, $domain . ': ' . (is_string($answer['error'] ?? null) ? substr($answer['error'], 0, 200) : 'refused'));
        }
        $inner = $answer['answer'] ?? null;
        if (!is_array($inner)) ledger_fail('peer-bad-answer', $domain . ' sent no answer');
        return $inner;
    };
}
