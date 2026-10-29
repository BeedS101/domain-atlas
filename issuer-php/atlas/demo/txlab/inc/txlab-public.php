<?php
// Domain Atlas - Multi-Domain Transaction Authorization Lab: public-demo mode (test only).
//
// Lets an ordinary visitor run a complete 2-of-2 transfer without administrator credentials,
// while keeping every privileged operation closed:
//
//  - Off unless config.php has publicDemo.enabled === true on that domain.
//  - Own SQLite file (txlab-public.sqlite): visitor sessions with their own test balances.
//    Nothing here reads or writes the main ledger, issuer keys or any real balance.
//  - A session is a random secret token (stored hashed) plus a public session id. Every
//    public operation is bound to one session and can only touch that session's balances
//    and transfers.
//  - There is no operation that signs caller-supplied data. The settlement domain signs
//    only a stored, validated, session-owned transfer; an approving domain signs only after
//    a request signed by the settlement domain AND its own independent fetch and validation
//    of the transfer under its own limits.
//  - Limits are enforced server-side on every domain: accounts, amount cap, short
//    lifetime, per-session and per-IP counts, global caps, session expiry and pruning.

const TXLAB_PEER_REQUEST_VERSION = 'domain-atlas-txlab-peer-request/1';
const TXLAB_PEER_REQUEST_SKEW_MS = 120000;
const TXLAB_PUBLIC_ACCOUNTS = ['alice', 'bob'];

// name => [default, min, max]
function txlab_public_defaults() {
  return [
    'aliceMinor' => [10000, 100, 100000],
    'maxAmountMinor' => [5000, 1, TXLAB_MAX_AMOUNT_MINOR],
    'sessionTtlSeconds' => [1800, 60, 7200],
    'txTtlSeconds' => [300, 5, 900],
    'maxTransfersPerSession' => [5, 1, 50],
    'maxPendingPerSession' => [2, 1, 10],
    'maxSessions' => [200, 1, 5000],
    'maxPendingGlobal' => [60, 1, 1000],
    'sessionsPerIpPerHour' => [10, 1, 1000],
    'transfersPerIpPerHour' => [30, 1, 2000],
    'transfersGlobalPerHour' => [400, 1, 20000],
    'approvalsPerIpPerMinute' => [30, 1, 600],
    'callsPerIpPerMinute' => [120, 10, 10000],
    'peerApprovalsPerHour' => [600, 1, 10000],
  ];
}

// Returns null when public mode is off. Anything other than an explicit enabled === true is off;
// an enabled block with a bad setting adds a problem, which disables the whole lab (fail closed).
function txlab_public_config($raw, &$problems) {
  if (!is_array($raw) || !isset($raw['enabled']) || $raw['enabled'] !== true) return null;
  $out = [];
  $defs = txlab_public_defaults();
  foreach ($defs as $k => $spec) {
    $v = array_key_exists($k, $raw) ? $raw[$k] : $spec[0];
    if (!is_int($v) || $v < $spec[1] || $v > $spec[2]) {
      $problems[] = 'publicDemo.' . $k . ' must be an integer between ' . $spec[1] . ' and ' . $spec[2];
      continue;
    }
    $out[$k] = $v;
  }
  foreach (array_keys($raw) as $k) {
    if ($k !== 'enabled' && !isset($defs[$k])) $problems[] = 'publicDemo has an unknown setting: ' . $k;
  }
  return $out;
}

// The non-secret limits a visitor may see.
function txlab_public_limits($cfg) {
  $p = $cfg['public'];
  return [
    'accounts' => TXLAB_PUBLIC_ACCOUNTS, 'startBalanceMinor' => $p['aliceMinor'], 'maxAmountMinor' => $p['maxAmountMinor'],
    'sessionTtlSeconds' => $p['sessionTtlSeconds'], 'txTtlSeconds' => $p['txTtlSeconds'],
    'maxTransfersPerSession' => $p['maxTransfersPerSession'], 'maxPendingPerSession' => $p['maxPendingPerSession'],
  ];
}

function txlab_public_schema($db) {
  $db->exec('CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    ip_hash TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    expires_ms INTEGER NOT NULL,
    total_minor INTEGER NOT NULL,
    transfers_made INTEGER NOT NULL DEFAULT 0)');
  $db->exec('CREATE TABLE IF NOT EXISTS session_accounts (
    sid TEXT NOT NULL REFERENCES sessions(sid),
    name TEXT NOT NULL,
    balance_minor INTEGER NOT NULL CHECK (balance_minor >= 0),
    PRIMARY KEY (sid, name))');
  $db->exec('CREATE TABLE IF NOT EXISTS rate (bucket TEXT NOT NULL, who TEXT NOT NULL, ts_ms INTEGER NOT NULL)');
  $db->exec('CREATE INDEX IF NOT EXISTS rate_lookup ON rate (bucket, who, ts_ms)');
}

// ---------------------------------------------------------------- guards

// Config + public mode enabled (+ settlement authority for the visitor-facing operations).
function txlab_public_require($settlementOnly = true) {
  $cfg = txlab_require_config();
  if ($cfg['public'] === null) txlab_fail(403, 'the public demo is not enabled on this domain');
  if ($settlementOnly && !$cfg['isSettlement']) txlab_fail(400, 'public transfers start at the settlement authority (' . $cfg['settlementDomain'] . ')');
  return $cfg;
}

// Rules every domain applies to a session-tagged transfer, with its OWN limits.
function txlab_public_check_payload($cfg, $payload) {
  if ($cfg['public'] === null) txlab_fail(403, 'the public demo is not enabled on this domain');
  $p = $cfg['public'];
  if (!in_array($payload['from'], TXLAB_PUBLIC_ACCOUNTS, true) || !in_array($payload['to'], TXLAB_PUBLIC_ACCOUNTS, true) || $payload['from'] === $payload['to']) {
    txlab_fail(400, 'public-demo transfers are only between the demo accounts alice and bob');
  }
  if ($payload['amountMinor'] > $p['maxAmountMinor']) {
    txlab_fail(400, 'amount exceeds this domain\'s public-demo limit of ' . $p['maxAmountMinor'] . ' minor units');
  }
  if ($payload['expiresAtMs'] - $payload['createdAtMs'] > $p['txTtlSeconds'] * 1000) {
    txlab_fail(400, 'the authorization window is longer than this domain allows for public-demo transfers');
  }
}

// ---------------------------------------------------------------- rate limiting + abuse controls

function txlab_public_who($db) {
  $row = $db->query('SELECT v FROM meta WHERE k = \'ip_salt\'')->fetchColumn();
  if ($row === false) {
    $db->prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (\'ip_salt\', ?)')->execute([bin2hex(random_bytes(16))]);
    $row = $db->query('SELECT v FROM meta WHERE k = \'ip_salt\'')->fetchColumn();
  }
  // Only the connection address is used: forwarding headers are client-controlled and ignored.
  $ip = isset($_SERVER['REMOTE_ADDR']) && is_string($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : 'unknown';
  return substr(hash_hmac('sha256', $ip, $row), 0, 32);
}

// Counts a hit in a sliding window and refuses when the limit is already reached.
function txlab_public_rate($db, $bucket, $who, $limit, $windowMs) {
  $now = txlab_now_ms();
  $db->prepare('DELETE FROM rate WHERE ts_ms < ?')->execute([$now - 3600000]);
  $st = $db->prepare('SELECT COUNT(*), MIN(ts_ms) FROM rate WHERE bucket = ? AND who = ? AND ts_ms >= ?');
  $st->execute([$bucket, $who, $now - $windowMs]);
  $r = $st->fetch(PDO::FETCH_NUM);
  if ((int) $r[0] >= $limit) {
    $retry = max(1, (int) ceil(((int) $r[1] + $windowMs - $now) / 1000));
    txlab_fail(429, 'rate limit reached; try again in ' . $retry . ' seconds', ['retryAfterSeconds' => $retry]);
  }
  $db->prepare('INSERT INTO rate (bucket, who, ts_ms) VALUES (?, ?, ?)')->execute([$bucket, $who, $now]);
}

// Cheap per-address ceiling on every public call, before any other work.
function txlab_public_gate($cfg) {
  txlab_in_txn(function ($db) use ($cfg) {
    txlab_public_rate($db, 'calls', txlab_public_who($db), $cfg['public']['callsPerIpPerMinute'], 60000);
  }, 'public');
}

// Removes sessions that expired (with their transfers, approvals, receipts and events).
function txlab_public_prune($db) {
  $now = txlab_now_ms();
  $sids = $db->prepare('SELECT sid FROM sessions WHERE expires_ms < ?');
  $sids->execute([$now - 60000]);
  foreach ($sids->fetchAll(PDO::FETCH_COLUMN) as $sid) {
    $ids = $db->prepare('SELECT tx_id FROM tx WHERE substr(request_id, 1, 17) = ?');
    $ids->execute([$sid . ':']);
    foreach ($ids->fetchAll(PDO::FETCH_COLUMN) as $id) {
      foreach (['receipts', 'ledger', 'approvals', 'events'] as $t) $db->prepare('DELETE FROM ' . $t . ' WHERE tx_id = ?')->execute([$id]);
      $db->prepare('DELETE FROM tx WHERE tx_id = ?')->execute([$id]);
    }
    $db->prepare('DELETE FROM session_accounts WHERE sid = ?')->execute([$sid]);
    $db->prepare('DELETE FROM sessions WHERE sid = ?')->execute([$sid]);
  }
  // events that belong to no live transfer (the approving domain's peer signing log) age out
  $db->prepare('DELETE FROM events WHERE ts_ms < ?')->execute([$now - 3 * 3600000]);
}

// ---------------------------------------------------------------- sessions

function txlab_public_load_session($db, $sid, $token) {
  $bad = 'invalid or expired session';
  if (!is_string($sid) || !preg_match('/^[0-9a-f]{16}$/', $sid) || !is_string($token) || !preg_match('/^[A-Za-z0-9_-]{43}$/', $token)) txlab_fail(401, $bad);
  $st = $db->prepare('SELECT * FROM sessions WHERE sid = ?');
  $st->execute([$sid]);
  $row = $st->fetch(PDO::FETCH_ASSOC);
  $hash = hash('sha256', $token);
  if (!$row || !hash_equals($row['token_hash'], $hash) || (int) $row['expires_ms'] < txlab_now_ms()) txlab_fail(401, $bad);
  return $row;
}

function txlab_session_balances($db, $sid) {
  $st = $db->prepare('SELECT name, balance_minor FROM session_accounts WHERE sid = ? ORDER BY name');
  $st->execute([$sid]);
  $out = [];
  foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) $out[$r['name']] = (int) $r['balance_minor'];
  return $out;
}

function txlab_public_start() {
  $cfg = txlab_public_require();
  txlab_public_gate($cfg);
  $sid = bin2hex(random_bytes(8));
  $token = b64url_encode(random_bytes(32));
  $p = $cfg['public'];
  $expires = txlab_in_txn(function ($db) use ($sid, $token, $p) {
    txlab_public_prune($db);
    $who = txlab_public_who($db);
    $now = txlab_now_ms();
    $active = (int) $db->query('SELECT COUNT(*) FROM sessions WHERE expires_ms >= ' . (int) $now)->fetchColumn();
    if ($active >= $p['maxSessions']) txlab_fail(503, 'the demo is at capacity right now; try again in a few minutes');
    txlab_public_rate($db, 'session', $who, $p['sessionsPerIpPerHour'], 3600000);
    $expires = $now + $p['sessionTtlSeconds'] * 1000;
    $db->prepare('INSERT INTO sessions (sid, token_hash, ip_hash, created_ms, expires_ms, total_minor) VALUES (?, ?, ?, ?, ?, ?)')
       ->execute([$sid, hash('sha256', $token), $who, $now, $expires, $p['aliceMinor']]);
    $ins = $db->prepare('INSERT INTO session_accounts (sid, name, balance_minor) VALUES (?, ?, ?)');
    $ins->execute([$sid, 'alice', $p['aliceMinor']]);
    $ins->execute([$sid, 'bob', 0]);
    return $expires;
  }, 'public');
  return [
    'sid' => $sid, 'token' => $token, 'expiresAtMs' => $expires, 'testDemo' => true,
    'balances' => ['alice' => $p['aliceMinor'], 'bob' => 0], 'limits' => txlab_public_limits($cfg),
  ];
}

function txlab_public_session_state($sid, $token) {
  $cfg = txlab_public_require();
  txlab_public_gate($cfg);
  return txlab_in_txn(function ($db) use ($cfg, $sid, $token) {
    $s = txlab_public_load_session($db, $sid, $token);
    $bal = txlab_session_balances($db, $s['sid']);
    $rows = $db->prepare('SELECT tx_id, payload_json, status, created_ms FROM tx WHERE substr(request_id, 1, 17) = ? ORDER BY created_ms DESC, rowid DESC LIMIT 10');
    $rows->execute([$s['sid'] . ':']);
    $list = [];
    foreach ($rows->fetchAll(PDO::FETCH_ASSOC) as $r) {
      $pl = json_decode($r['payload_json'], true);
      $list[] = ['txId' => $r['tx_id'], 'from' => $pl['from'], 'to' => $pl['to'], 'amountMinor' => $pl['amountMinor'], 'status' => $r['status'], 'createdAtMs' => (int) $r['created_ms']];
    }
    return [
      'session' => ['sid' => $s['sid'], 'expiresAtMs' => (int) $s['expires_ms'], 'transfersMade' => (int) $s['transfers_made']],
      'balances' => $bal, 'conservation' => ['totalMinor' => (int) $s['total_minor'], 'sumMinor' => array_sum($bal), 'ok' => array_sum($bal) === (int) $s['total_minor']],
      'transactions' => $list, 'limits' => txlab_public_limits($cfg),
    ];
  }, 'public');
}

// ---------------------------------------------------------------- visitor transfer (settlement authority)

function txlab_public_transfer($sid, $token, $requestId, $from, $to, $amountMinor) {
  $cfg = txlab_public_require();
  if (!is_string($requestId) || !preg_match('/^[A-Za-z0-9-]{8,64}$/', $requestId)) txlab_fail(400, 'requestId must be 8-64 characters of letters, digits and dashes');
  if (!is_string($from) || !is_string($to) || !in_array($from, TXLAB_PUBLIC_ACCOUNTS, true) || !in_array($to, TXLAB_PUBLIC_ACCOUNTS, true) || $from === $to) {
    txlab_fail(400, 'sender and recipient must be the two demo accounts alice and bob');
  }
  $p = $cfg['public'];
  if (!is_int($amountMinor) || $amountMinor < 1 || $amountMinor > $p['maxAmountMinor']) txlab_fail(400, 'amountMinor must be an integer between 1 and ' . $p['maxAmountMinor']);
  txlab_public_gate($cfg);
  $txId = txlab_in_txn(function ($db) use ($cfg, $p, $sid, $token, $requestId, $from, $to, $amountMinor) {
    txlab_public_prune($db);
    txlab_sweep_expired($db);
    $s = txlab_public_load_session($db, $sid, $token);
    $sid = $s['sid'];
    $key = $sid . ':' . $requestId; // request ids are namespaced per session
    $ex = $db->prepare('SELECT tx_id FROM tx WHERE request_id = ?');
    $ex->execute([$key]);
    $existing = $ex->fetchColumn();
    if ($existing !== false) {
      txlab_event($db, $existing, 'duplicate-submission', null, 'the same requestId was submitted again; no new transaction was created');
      return $existing;
    }
    $now = txlab_now_ms();
    if ((int) $s['expires_ms'] - $now < 5000) txlab_fail(409, 'this session is about to expire; start a new one');
    if ((int) $s['transfers_made'] >= $p['maxTransfersPerSession']) txlab_fail(429, 'this session has used its ' . $p['maxTransfersPerSession'] . ' test transfers; start a new session');
    $pend = $db->prepare('SELECT COUNT(*) FROM tx WHERE status = \'pending\' AND substr(request_id, 1, 17) = ?');
    $pend->execute([$sid . ':']);
    if ((int) $pend->fetchColumn() >= $p['maxPendingPerSession']) txlab_fail(429, 'this session already has ' . $p['maxPendingPerSession'] . ' pending transfers; finish or wait for them to expire');
    if ((int) $db->query('SELECT COUNT(*) FROM tx WHERE status = \'pending\'')->fetchColumn() >= $p['maxPendingGlobal']) txlab_fail(503, 'the demo is busy right now; try again shortly');
    $bal = txlab_session_balances($db, $sid);
    if (!isset($bal[$from]) || $bal[$from] < $amountMinor) txlab_fail(409, 'insufficient balance: ' . $from . ' has ' . (isset($bal[$from]) ? $bal[$from] : 0) . ' minor units');
    $who = txlab_public_who($db);
    txlab_public_rate($db, 'transfer', $who, $p['transfersPerIpPerHour'], 3600000);
    txlab_public_rate($db, 'transfer', '*', $p['transfersGlobalPerHour'], 3600000);
    $expires = min($now + $p['txTtlSeconds'] * 1000, (int) $s['expires_ms']);
    $payload = [
      'v' => TXLAB_VERSION, 'type' => 'transfer', 'txId' => atlas_txlab_uuid(), 'origin' => $cfg['domain'], 'session' => $sid,
      'from' => $from, 'to' => $to, 'currency' => TXLAB_CURRENCY, 'amountMinor' => $amountMinor,
      'createdAtMs' => $now, 'expiresAtMs' => $expires, 'policy' => txlab_policy($cfg),
    ];
    $digest = txlab_digest($payload);
    $db->prepare('INSERT INTO tx (tx_id, request_id, payload_json, digest, status, created_ms, expires_ms) VALUES (?, ?, ?, ?, \'pending\', ?, ?)')
       ->execute([$payload['txId'], $key, canonicalize($payload), $digest, $now, $expires]);
    $db->prepare('UPDATE sessions SET transfers_made = transfers_made + 1 WHERE sid = ?')->execute([$sid]);
    txlab_event($db, $payload['txId'], 'created', $cfg['domain'], 'public-demo transfer ' . $from . ' -> ' . $to . ' ' . $amountMinor . ' minor units; awaiting independent approvals');
    return $payload['txId'];
  }, 'public');
  return txlab_view($txId);
}

// ---------------------------------------------------------------- visitor-requested approval

function txlab_public_approve($sid, $token, $txId, $domain) {
  $cfg = txlab_public_require();
  if (!is_string($txId) || !preg_match('/^[0-9a-f-]{36}$/', $txId)) txlab_fail(400, 'invalid transaction id');
  if (!is_string($domain) || !in_array($domain, $cfg['rosterDomains'], true)) txlab_fail(400, 'not a domain in this quorum');
  txlab_public_gate($cfg);
  $found = txlab_in_txn(function ($db) use ($cfg, $sid, $token, $txId) {
    txlab_sweep_expired($db);
    $s = txlab_public_load_session($db, $sid, $token);
    txlab_public_rate($db, 'approve', txlab_public_who($db), $cfg['public']['approvalsPerIpPerMinute'], 60000);
    $tx = txlab_load_tx($db, $txId);
    // a session can only drive its own transfers; anything else looks like it does not exist
    if (!$tx || !isset($tx['payload']['session']) || $tx['payload']['session'] !== $s['sid']) txlab_fail(404, 'no such transaction in this session');
    return ['tx' => $tx, 'decisions' => txlab_stored_decisions($db, $txId)];
  }, 'public');
  $tx = $found['tx'];
  if ($tx['status'] !== 'pending') txlab_fail(409, 'the transaction is ' . $tx['status'] . '; approvals are no longer accepted');
  if (isset($found['decisions'][$domain])) {
    return ['domain' => $domain, 'alreadyDecided' => true, 'decision' => $found['decisions'][$domain], 'view' => txlab_view($txId)];
  }
  if ($domain === $cfg['domain']) {
    $res = txlab_public_sign_local($cfg, $tx);
    return ['domain' => $domain, 'signedBy' => $domain, 'view' => $res];
  }
  // another domain: ask it, server to server, with a request only this domain's key can sign
  $req = [
    'v' => TXLAB_PEER_REQUEST_VERSION, 'op' => 'approve', 'txId' => $txId,
    'requester' => $cfg['domain'], 'target' => $domain, 'requestedAtMs' => txlab_now_ms(),
  ];
  $sig = txlab_sign($cfg, canonicalize($req));
  txlab_in_txn(function ($db) use ($txId, $cfg, $domain) {
    txlab_event($db, $txId, 'peer-approval-requested', $cfg['domain'], 'asked ' . $domain . ' to validate this transfer under its own rules and sign it with its own key');
  }, 'public');
  $r = txlab_peer_call($cfg, $domain, 'POST', ['op' => 'peer-approve'], ['request' => $req, 'signature' => $sig], 15);
  if ($r['status'] !== 200) {
    $msg = $domain . ($r['status'] === 0 ? ' could not be reached' : ' did not sign') . ': ' . $r['error'];
    txlab_in_txn(function ($db) use ($txId, $domain, $msg) {
      txlab_event($db, $txId, 'peer-approval-failed', $domain, $msg);
    }, 'public');
    $code = ($r['status'] >= 400 && $r['status'] < 500) ? $r['status'] : 502;
    if ($code === 401 || $code === 403) $code = 502;
    txlab_fail($code, $msg, ['state' => $r['status'] === 0 ? 'peer-unavailable' : 'peer-refused']);
  }
  return ['domain' => $domain, 'signedBy' => $domain, 'view' => txlab_view($txId)];
}

// The settlement domain signs its own approval only for a stored, valid, session-owned transfer.
function txlab_public_sign_local($cfg, $tx) {
  txlab_check_payload_against_policy($cfg, $tx['payload'], $tx['digest']);
  if (!isset($tx['payload']['session'])) txlab_fail(400, 'only public-demo transfers are signed automatically');
  if (txlab_now_ms() > $tx['payload']['expiresAtMs']) txlab_fail(409, 'the authorization window has closed');
  $approval = [
    'v' => TXLAB_APPROVAL_VERSION, 'txId' => $tx['tx_id'], 'payloadDigest' => $tx['digest'], 'approver' => $cfg['domain'],
    'decision' => 'approve', 'approvedAtMs' => txlab_now_ms(),
  ];
  return txlab_submit_approval($tx['tx_id'], $approval, txlab_sign($cfg, canonicalize($approval)));
}

// ---------------------------------------------------------------- approving domain: peer-approve

function txlab_peer_request_shape_ok($r) {
  if (!is_array($r)) return false;
  $have = array_keys($r);
  sort($have);
  if ($have !== ['op', 'requestedAtMs', 'requester', 'target', 'txId', 'v']) return false;
  return $r['v'] === TXLAB_PEER_REQUEST_VERSION && $r['op'] === 'approve' && is_string($r['txId']) && preg_match('/^[0-9a-f-]{36}$/', $r['txId'])
    && is_string($r['requester']) && is_string($r['target']) && is_int($r['requestedAtMs']);
}

// Runs on an approving domain. Signs only when ALL of these hold: the request carries the
// settlement domain's signature (pinned key), it is fresh and addressed to this domain, the
// transfer fetched from the settlement domain matches this domain's own policy and public
// limits, and it is a still-pending, session-tagged public-demo transfer.
function txlab_public_peer_approve($request, $signature) {
  $cfg = txlab_public_require(false);
  if ($cfg['isSettlement']) txlab_fail(400, 'the settlement authority signs through its own public flow');
  if (!txlab_peer_request_shape_ok($request) || !is_string($signature) || $signature === '') txlab_fail(400, 'malformed approval request');
  if ($request['target'] !== $cfg['domain'] || $request['requester'] !== $cfg['settlementDomain']) txlab_fail(403, 'not a request from the settlement authority to this domain');
  if (!txlab_verify_with_pinned_key($cfg, $cfg['settlementDomain'], canonicalize($request), $signature)) txlab_fail(401, 'the request is not signed by the settlement authority');
  if (abs(txlab_now_ms() - $request['requestedAtMs']) > TXLAB_PEER_REQUEST_SKEW_MS) txlab_fail(400, 'the request is stale');
  txlab_in_txn(function ($db) use ($cfg) {
    txlab_public_prune($db);
    txlab_public_rate($db, 'peer-approve', '*', $cfg['public']['peerApprovalsPerHour'], 3600000);
  }, 'public');

  $txId = $request['txId'];
  $r = txlab_peer_call($cfg, $cfg['settlementDomain'], 'GET', ['op' => 'tx', 'id' => $txId]);
  if ($r['status'] === 404) txlab_fail(404, 'no such transaction at ' . $cfg['settlementDomain']);
  if ($r['status'] !== 200 || !is_array($r['body']) || !isset($r['body']['payload'], $r['body']['digest'], $r['body']['status'])) {
    txlab_fail(502, 'cannot read the transaction from ' . $cfg['settlementDomain'] . ': ' . $r['error']);
  }
  $payload = $r['body']['payload'];
  $digest = $r['body']['digest'];
  if (!is_array($payload) || !is_string($digest) || !is_string($r['body']['status'])) txlab_fail(502, 'the settlement authority returned a malformed transaction');
  if (!isset($payload['txId']) || $payload['txId'] !== $txId) txlab_fail(400, 'the settlement authority returned a different transaction');
  txlab_check_payload_against_policy($cfg, $payload, $digest); // shape, digest, origin, quorum policy, and (session-tagged) the public limits
  if (!isset($payload['session'])) txlab_fail(400, 'only public-demo transfers are signed automatically');
  if ($r['body']['status'] !== 'pending') txlab_fail(409, 'the transaction is ' . $r['body']['status'] . ', not pending');
  if (txlab_now_ms() > $payload['expiresAtMs']) txlab_fail(409, 'the authorization window has closed');
  if (isset($r['body']['domains']) && is_array($r['body']['domains'])) {
    foreach ($r['body']['domains'] as $d) {
      if (is_array($d) && isset($d['domain'], $d['status']) && $d['domain'] === $cfg['domain'] && $d['status'] !== 'pending') {
        return ['signedBy' => $cfg['domain'], 'alreadyDecided' => true];
      }
    }
  }
  $approval = [
    'v' => TXLAB_APPROVAL_VERSION, 'txId' => $txId, 'payloadDigest' => $digest, 'approver' => $cfg['domain'],
    'decision' => 'approve', 'approvedAtMs' => txlab_now_ms(),
  ];
  $sig = txlab_sign($cfg, canonicalize($approval));
  $s = txlab_peer_call($cfg, $cfg['settlementDomain'], 'POST', ['op' => 'submit-approval'], ['id' => $txId, 'approval' => $approval, 'signature' => $sig]);
  if ($s['status'] === 0) txlab_fail(502, 'could not deliver the signed approval to ' . $cfg['settlementDomain'] . ': ' . $s['error']);
  if ($s['status'] !== 200) txlab_fail($s['status'] >= 400 && $s['status'] < 500 ? $s['status'] : 502, $cfg['settlementDomain'] . ' refused the approval: ' . $s['error']);
  txlab_in_txn(function ($db) use ($txId, $cfg) {
    txlab_event($db, $txId, 'peer-approval-signed', $cfg['domain'], 'validated the transfer independently and signed it with this domain\'s own key');
  }, 'public');
  return ['signedBy' => $cfg['domain'], 'approval' => $approval, 'signature' => $sig];
}
