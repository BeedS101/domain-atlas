<?php
// Multi-Issuer Portable Asset Lab: visitor sessions, rate limits, public operations and read views.
//
// Public mode needs no administrator credential and offers no way to sign caller-supplied data:
//  - an issuer signs only a stored, validated asset definition after fetching it from the state
//    authority and checking it against its own pinned roster, keys, policies and limits;
//  - ownership moves only on a transfer the CURRENT OWNER signed (a key the visitor holds in the
//    browser), approved by an independently satisfied issuer quorum.
// A visitor session scopes quotas, expiry and which assets/transfers the visitor may drive; it does
// not decide who owns an asset.

const MI_ATTESTATION_VERSION = 'domain-atlas-mi-attestation/1';

// ---------------------------------------------------------------- rate limiting

function mi_who($db) {
  $row = mi_col($db->query('SELECT v FROM meta WHERE k = \'ip_salt\''));
  if ($row === false) {
    $db->prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (\'ip_salt\', ?)')->execute([bin2hex(random_bytes(16))]);
    $row = mi_col($db->query('SELECT v FROM meta WHERE k = \'ip_salt\''));
  }
  // only the connection address counts: forwarding headers are client-controlled
  $ip = isset($_SERVER['REMOTE_ADDR']) && is_string($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : 'unknown';
  return substr(hash_hmac('sha256', $ip, $row), 0, 32);
}

function mi_rate($db, $bucket, $who, $limit, $windowMs) {
  $now = txlab_now_ms();
  $db->prepare('DELETE FROM rate WHERE ts_ms < ?')->execute([$now - 3600000]);
  $st = $db->prepare('SELECT COUNT(*), MIN(ts_ms) FROM rate WHERE bucket = ? AND who = ? AND ts_ms >= ?');
  $st->execute([$bucket, $who, $now - $windowMs]);
  $r = mi_row($st, PDO::FETCH_NUM);
  if ((int) $r[0] >= $limit) {
    $retry = max(1, (int) ceil(((int) $r[1] + $windowMs - $now) / 1000));
    mi_fail(429, 'rate limit reached; try again in ' . $retry . ' seconds', ['retryAfterSeconds' => $retry]);
  }
  $db->prepare('INSERT INTO rate (bucket, who, ts_ms) VALUES (?, ?, ?)')->execute([$bucket, $who, $now]);
}

// Per-address ceiling on every API call, before any other work (also applies with public mode off).
function mi_gate($cfg) {
  $limit = $cfg['public'] !== null ? $cfg['public']['callsPerIpPerMinute'] : 120;
  mi_in_txn(function ($db) use ($limit) { mi_rate($db, 'calls', mi_who($db), $limit, 60000); });
}

// ---------------------------------------------------------------- sessions and pruning

function mi_prune($db) {
  $now = txlab_now_ms();
  $sids = $db->prepare('SELECT sid FROM sessions WHERE expires_ms < ?');
  $sids->execute([$now - 60000]);
  foreach ($sids->fetchAll(PDO::FETCH_COLUMN) as $sid) {
    $as = $db->prepare('SELECT asset_id FROM assets WHERE session_sid = ?');
    $as->execute([$sid]);
    foreach ($as->fetchAll(PDO::FETCH_COLUMN) as $aid) {
      $ts = $db->prepare('SELECT tx_id FROM transfers WHERE asset_id = ?');
      $ts->execute([$aid]);
      foreach ($ts->fetchAll(PDO::FETCH_COLUMN) as $tid) {
        $db->prepare('DELETE FROM transfer_approvals WHERE tx_id = ?')->execute([$tid]);
        $db->prepare('DELETE FROM events WHERE ref_id = ?')->execute([$tid]);
        $db->prepare('DELETE FROM transfers WHERE tx_id = ?')->execute([$tid]);
      }
      foreach (['issuance_approvals', 'transitions', 'asset_state'] as $t) $db->prepare('DELETE FROM ' . $t . ' WHERE asset_id = ?')->execute([$aid]);
      $db->prepare('DELETE FROM events WHERE ref_id = ?')->execute([$aid]);
      $db->prepare('DELETE FROM assets WHERE asset_id = ?')->execute([$aid]);
    }
    $db->prepare('DELETE FROM sessions WHERE sid = ?')->execute([$sid]);
  }
  $db->prepare('DELETE FROM events WHERE ts_ms < ?')->execute([$now - 3 * 3600000]);
}

function mi_load_session($db, $sid, $token) {
  $bad = 'invalid or expired session';
  if (!is_string($sid) || !preg_match('/^[0-9a-f]{16}$/', $sid) || !is_string($token) || !preg_match('/^[A-Za-z0-9_-]{43}$/', $token)) mi_fail(401, $bad);
  $st = $db->prepare('SELECT * FROM sessions WHERE sid = ?');
  $st->execute([$sid]);
  $row = mi_row($st);
  if (!$row || !hash_equals($row['token_hash'], hash('sha256', $token)) || (int) $row['expires_ms'] < txlab_now_ms()) mi_fail(401, $bad);
  return $row;
}

function mi_public_limits($cfg) {
  $p = $cfg['public'];
  return [
    'assetClasses' => $cfg['assetClasses'], 'sessionTtlSeconds' => $p['sessionTtlSeconds'], 'issuanceWindowSeconds' => $p['issuanceWindowSeconds'],
    'transferTtlSeconds' => $p['transferTtlSeconds'], 'maxAssetsPerSession' => $p['maxAssetsPerSession'], 'maxTransfersPerSession' => $p['maxTransfersPerSession'],
  ];
}

function mi_policy_summary($cfg) {
  return ['issuance' => $cfg['issuance'] + ['roster' => $cfg['rosterDomains']], 'transfer' => $cfg['transfer'] + ['roster' => $cfg['rosterDomains']], 'stateAuthority' => $cfg['stateAuthority']];
}

function mi_public_start() {
  $cfg = mi_require_public();
  mi_gate($cfg);
  $sid = bin2hex(random_bytes(8));
  $token = b64url_encode(random_bytes(32));
  $p = $cfg['public'];
  $expires = mi_in_txn(function ($db) use ($sid, $token, $p) {
    mi_prune($db);
    $who = mi_who($db);
    $now = txlab_now_ms();
    $active = (int) mi_col($db->query('SELECT COUNT(*) FROM sessions WHERE expires_ms >= ' . (int) $now));
    if ($active >= $p['maxSessions']) mi_fail(503, 'the demo is at capacity right now; try again in a few minutes');
    mi_rate($db, 'session', $who, $p['sessionsPerIpPerHour'], 3600000);
    $expires = $now + $p['sessionTtlSeconds'] * 1000;
    $db->prepare('INSERT INTO sessions (sid, token_hash, ip_hash, created_ms, expires_ms) VALUES (?, ?, ?, ?, ?)')->execute([$sid, hash('sha256', $token), $who, $now, $expires]);
    return $expires;
  });
  return ['sid' => $sid, 'token' => $token, 'expiresAtMs' => $expires, 'testDemo' => true, 'limits' => mi_public_limits($cfg), 'policy' => mi_policy_summary($cfg), 'domain' => $cfg['domain']];
}

function mi_public_session($sid, $token) {
  $cfg = mi_require_public();
  mi_gate($cfg);
  return mi_in_txn(function ($db) use ($cfg, $sid, $token) {
    $s = mi_load_session($db, $sid, $token);
    mi_sweep($db);
    $as = $db->prepare('SELECT asset_id, definition_json, status, created_ms FROM assets WHERE session_sid = ? ORDER BY created_ms DESC LIMIT 20');
    $as->execute([$s['sid']]);
    $assets = [];
    foreach ($as->fetchAll(PDO::FETCH_ASSOC) as $r) {
      $d = json_decode($r['definition_json'], true);
      $st = mi_state_row($db, $r['asset_id']);
      $assets[] = ['assetId' => $r['asset_id'], 'name' => $d['name'], 'status' => $r['status'], 'version' => $st ? $st['version'] : null, 'ownerKeyId' => $st ? mi_key_id($st['owner']) : null, 'createdAtMs' => (int) $r['created_ms']];
    }
    $ts = $db->prepare('SELECT tx_id, asset_id, status, created_ms FROM transfers WHERE session_sid = ? ORDER BY created_ms DESC LIMIT 20');
    $ts->execute([$s['sid']]);
    $transfers = [];
    foreach ($ts->fetchAll(PDO::FETCH_ASSOC) as $r) $transfers[] = ['txId' => $r['tx_id'], 'assetId' => $r['asset_id'], 'status' => $r['status'], 'createdAtMs' => (int) $r['created_ms']];
    return [
      'session' => ['sid' => $s['sid'], 'expiresAtMs' => (int) $s['expires_ms'], 'assetsMade' => (int) $s['assets_made'], 'transfersMade' => (int) $s['transfers_made']],
      'assets' => $assets, 'transfers' => $transfers, 'limits' => mi_public_limits($cfg), 'policy' => mi_policy_summary($cfg), 'domain' => $cfg['domain'],
    ];
  });
}

// ---------------------------------------------------------------- create an asset (state authority)

function mi_public_asset_create($sid, $token, $requestId, $ownerPub, $label, $class) {
  $cfg = mi_require_public();
  if (!is_string($requestId) || !preg_match('/^[A-Za-z0-9-]{8,64}$/', $requestId)) mi_fail(400, 'requestId must be 8-64 characters of letters, digits and dashes');
  if (!mi_pubkey_ok($ownerPub)) mi_fail(400, 'ownerPublicKey must be a raw P-256 public key (base64url)');
  $label = $label === null ? '' : $label;
  if (!mi_ascii_text($label, 40)) mi_fail(400, 'label may use letters, digits, spaces and basic punctuation, up to 40 characters');
  $class = $class === null ? $cfg['assetClasses'][0] : $class;
  if (!is_string($class) || !in_array($class, $cfg['assetClasses'], true)) mi_fail(400, 'asset class not allowed in the public test demo');
  mi_gate($cfg);
  $p = $cfg['public'];
  $id = mi_in_txn(function ($db) use ($cfg, $p, $sid, $token, $requestId, $ownerPub, $label, $class) {
    mi_prune($db);
    mi_sweep($db);
    $s = mi_load_session($db, $sid, $token);
    $sid = $s['sid'];
    $key = $sid . ':' . $requestId;
    $ex = $db->prepare('SELECT asset_id FROM assets WHERE request_id = ?');
    $ex->execute([$key]);
    $existing = mi_col($ex);
    if ($existing !== false) { mi_event($db, $existing, 'duplicate-submission', null, 'the same requestId was submitted again; no new asset was created'); return $existing; }
    $now = txlab_now_ms();
    if ((int) $s['expires_ms'] - $now < 5000) mi_fail(409, 'this session is about to expire; start a new one');
    if ((int) $s['assets_made'] >= $p['maxAssetsPerSession']) mi_fail(429, 'this session has used its ' . $p['maxAssetsPerSession'] . ' test assets; start a new session');
    mi_rate($db, 'asset', mi_who($db), $p['assetsPerIpPerHour'], 3600000);
    $n = mi_col($db->query('SELECT v FROM meta WHERE k = \'serial\''));
    $serial = ($n === false ? 0 : (int) $n) + 1;
    $db->prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (\'serial\', ?)')->execute([(string) $serial]);
    $def = mi_build_definition($cfg, $ownerPub, str_pad((string) ($serial % 1000000), 6, '0', STR_PAD_LEFT), $label, $class);
    $problem = mi_definition_problem($def);
    if ($problem !== null) mi_fail(500, 'internal: ' . $problem);
    $db->prepare('INSERT INTO assets (asset_id, session_sid, request_id, definition_json, definition_digest, status, created_ms, expires_ms) VALUES (?, ?, ?, ?, ?, \'pending\', ?, ?)')
       ->execute([$def['assetId'], $sid, $key, canonicalize($def), mi_digest($def), $def['createdAtMs'], $def['createdAtMs'] + $p['issuanceWindowSeconds'] * 1000]);
    $db->prepare('UPDATE sessions SET assets_made = assets_made + 1 WHERE sid = ?')->execute([$sid]);
    mi_event($db, $def['assetId'], 'created', $cfg['domain'], 'test asset defined; issuance needs ' . $cfg['issuance']['threshold'] . ' of ' . count($cfg['rosterDomains']) . ' issuers, ' . implode(', ', $cfg['issuance']['mandatory']) . ' mandatory');
    return $def['assetId'];
  });
  return mi_asset_view($id);
}

// ---------------------------------------------------------------- drive a decision (state authority)

function mi_issuer_ref($cfg, $domain) {
  return ['domain' => $domain, 'publicKey' => $cfg['roster'][$domain]['publicKey'], 'capabilities' => mi_capabilities()];
}

function mi_session_asset($cfg, $sid, $token, $assetId) {
  if (!mi_is_uuid($assetId)) mi_fail(400, 'invalid asset id');
  return mi_in_txn(function ($db) use ($cfg, $sid, $token, $assetId) {
    mi_sweep($db);
    $s = mi_load_session($db, $sid, $token);
    mi_rate($db, 'approve', mi_who($db), $cfg['public']['approvalsPerIpPerMinute'], 60000);
    $a = mi_load_asset($db, $assetId);
    if (!$a || $a['session_sid'] !== $s['sid']) mi_fail(404, 'no such asset in this session');
    return $a;
  });
}

function mi_public_issue_approve($sid, $token, $assetId, $domain) {
  $cfg = mi_require_public();
  if (!is_string($domain) || !in_array($domain, $cfg['rosterDomains'], true)) mi_fail(400, 'not a domain in this roster');
  mi_gate($cfg);
  $asset = mi_session_asset($cfg, $sid, $token, $assetId);
  if ($asset['status'] !== 'pending') mi_fail(409, 'the asset is ' . $asset['status'] . '; issuance approvals are no longer accepted');
  $db = mi_db();
  $dec = mi_decisions($db, 'issuance_approvals', 'asset_id', $assetId);
  if (isset($dec[$domain])) return ['domain' => $domain, 'alreadyDecided' => true, 'decision' => $dec[$domain], 'view' => mi_asset_view($assetId)];
  if ($domain === $cfg['domain']) {
    $r = mi_local_decide($cfg, 'issue', $assetId);
  } else {
    $r = mi_ask_peer($cfg, 'issue', $assetId, $asset['definition_digest'], mi_issuer_ref($cfg, $domain));
  }
  return ['domain' => $domain, 'signedBy' => $r['signedBy'], 'decision' => $r['decision'], 'view' => mi_asset_view($assetId)];
}

function mi_public_transfer_approve($sid, $token, $txId, $domain) {
  $cfg = mi_require_public();
  if (!mi_is_uuid($txId)) mi_fail(400, 'invalid transfer id');
  if (!is_string($domain) || !in_array($domain, $cfg['rosterDomains'], true)) mi_fail(400, 'not a domain in this roster');
  mi_gate($cfg);
  $tx = mi_in_txn(function ($db) use ($cfg, $sid, $token, $txId) {
    mi_sweep($db);
    $s = mi_load_session($db, $sid, $token);
    mi_rate($db, 'approve', mi_who($db), $cfg['public']['approvalsPerIpPerMinute'], 60000);
    $t = mi_load_transfer($db, $txId);
    if (!$t || $t['session_sid'] !== $s['sid']) mi_fail(404, 'no such transfer in this session');
    return $t;
  });
  if ($tx['status'] !== 'pending') mi_fail(409, 'the transfer is ' . $tx['status'] . '; approvals are no longer accepted');
  $dec = mi_decisions(mi_db(), 'transfer_approvals', 'tx_id', $txId);
  if (isset($dec[$domain])) return ['domain' => $domain, 'alreadyDecided' => true, 'decision' => $dec[$domain], 'view' => mi_transfer_view($txId)];
  if ($domain === $cfg['domain']) $r = mi_local_decide($cfg, 'transfer', $txId);
  else $r = mi_ask_peer($cfg, 'transfer', $txId, $tx['digest'], mi_issuer_ref($cfg, $domain));
  return ['domain' => $domain, 'signedBy' => $r['signedBy'], 'decision' => $r['decision'], 'view' => mi_transfer_view($txId)];
}

// ---------------------------------------------------------------- propose a transfer (state authority)

function mi_public_transfer_propose($sid, $token, $payload, $ownerAuth, $ownerSig) {
  $cfg = mi_require_public();
  if (!mi_transfer_shape_ok($payload)) mi_fail(400, 'the transfer payload is malformed');
  if (!is_array($ownerAuth) || !is_string($ownerSig) || $ownerSig === '') mi_fail(400, 'the current owner\'s authorization is required');
  mi_gate($cfg);
  $p = $cfg['public'];
  $txId = mi_in_txn(function ($db) use ($cfg, $p, $sid, $token, $payload, $ownerAuth, $ownerSig) {
    mi_prune($db);
    mi_sweep($db);
    $s = mi_load_session($db, $sid, $token);
    $now = txlab_now_ms();
    if ($payload['session'] !== $s['sid']) mi_fail(400, 'the transfer is tagged with a different session');
    $digest = mi_digest($payload);
    $existing = mi_load_transfer($db, $payload['txId']);
    if ($existing) {
      if ($existing['digest'] !== $digest) mi_fail(409, 'that transfer id is already used for a different transfer');
      mi_event($db, $payload['txId'], 'duplicate-submission', null, 'the same transfer was submitted again; no new transfer was created');
      return $payload['txId'];
    }
    $asset = mi_load_asset($db, $payload['assetId']);
    if (!$asset) mi_fail(404, 'this registry holds no such asset');
    if ($asset['status'] !== 'issued') mi_fail(409, 'the asset is ' . $asset['status'] . ', not issued: it cannot be transferred');
    $st = mi_state_row($db, $payload['assetId']);
    if ($payload['registry'] !== $cfg['domain'] || $payload['definitionDigest'] !== $asset['definition_digest']) mi_fail(400, 'the transfer names a different registry or definition');
    if ($st === null || $payload['baseVersion'] !== $st['version'] || $payload['baseStateDigest'] !== $st['stateDigest'] || $payload['fromOwner'] !== $st['owner']) {
      mi_fail(409, 'stale ownership state: the transfer was authorized against version ' . $payload['baseVersion'] . ' but the current version is ' . ($st === null ? 'none' : $st['version']) . ' and/or a different owner');
    }
    if (!mi_owner_auth_ok($ownerAuth, $payload, $digest) || !mi_verify_obj($payload['fromOwner'], $ownerAuth, $ownerSig)) mi_fail(403, 'the current owner\'s signature on this exact transfer does not verify; nobody else can authorize it');
    if (abs($ownerAuth['signedAtMs'] - $now) > TXLAB_CLOCK_SKEW_MS + 60000) mi_fail(400, 'the owner authorization timestamp is out of range');
    if ($payload['createdAtMs'] > $now + TXLAB_CLOCK_SKEW_MS || $payload['expiresAtMs'] <= $now) mi_fail(400, 'the transfer is not within its authorization window');
    if ($payload['expiresAtMs'] - $payload['createdAtMs'] > $p['transferTtlSeconds'] * 1000) mi_fail(400, 'the authorization window is longer than the ' . $p['transferTtlSeconds'] . ' seconds this domain allows');
    if ((int) $s['expires_ms'] - $now < 5000) mi_fail(409, 'this session is about to expire; start a new one');
    if ((int) $s['transfers_made'] >= $p['maxTransfersPerSession']) mi_fail(429, 'this session has used its ' . $p['maxTransfersPerSession'] . ' test transfers; start a new session');
    $pend = $db->prepare('SELECT tx_id FROM transfers WHERE asset_id = ? AND status = \'pending\'');
    $pend->execute([$payload['assetId']]);
    if (mi_col($pend) !== false) mi_fail(409, 'a transfer of this asset is already pending; only one competing transfer of a given ownership state is allowed');
    if ((int) mi_col($db->query('SELECT COUNT(*) FROM transfers WHERE status = \'pending\'')) >= $p['maxPendingTransfersGlobal']) mi_fail(503, 'the demo is busy right now; try again shortly');
    mi_rate($db, 'transfer', mi_who($db), $p['transfersPerIpPerHour'], 3600000);
    $db->prepare('INSERT INTO transfers (tx_id, asset_id, session_sid, request_id, payload_json, digest, owner_auth_json, owner_signature, base_version, status, created_ms, expires_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, \'pending\', ?, ?)')
       ->execute([$payload['txId'], $payload['assetId'], $s['sid'], $s['sid'] . ':' . $payload['txId'], canonicalize($payload), $digest, canonicalize($ownerAuth), $ownerSig, $payload['baseVersion'], $now, min($payload['expiresAtMs'], (int) $s['expires_ms'])]);
    $db->prepare('UPDATE sessions SET transfers_made = transfers_made + 1 WHERE sid = ?')->execute([$s['sid']]);
    mi_event($db, $payload['txId'], 'proposed', $cfg['domain'], 'transfer of ' . substr($payload['assetId'], 0, 8) . ' from owner ' . substr(mi_key_id($payload['fromOwner']), 0, 8) . ' to ' . substr(mi_key_id($payload['toOwner']), 0, 8) . ' over state version ' . $payload['baseVersion'] . '; the owner\'s signature verified; awaiting independent issuer approvals');
    return $payload['txId'];
  });
  return mi_transfer_view($txId);
}

// ---------------------------------------------------------------- views

function mi_events_for($db, $refs) {
  $out = [];
  foreach ($refs as $ref) {
    $st = $db->prepare('SELECT id, ts_ms, ref_id, kind, domain, detail FROM events WHERE ref_id = ? ORDER BY id LIMIT 200');
    $st->execute([$ref]);
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) $out[] = ['id' => (int) $r['id'], 'atMs' => (int) $r['ts_ms'], 'ref' => $r['ref_id'], 'kind' => $r['kind'], 'domain' => $r['domain'], 'detail' => $r['detail']];
  }
  usort($out, function ($a, $b) { return $a['id'] - $b['id']; });
  return array_slice($out, -200);
}

function mi_attestation($cfg, $asset, $nonce) {
  $st = mi_state_row(mi_db(), $asset['asset_id']);
  if ($st === null) return null;
  $obj = ['v' => MI_ATTESTATION_VERSION, 'assetId' => $asset['asset_id'], 'definitionDigest' => $asset['definition_digest'], 'registry' => $cfg['domain'], 'version' => $st['version'], 'owner' => $st['owner'], 'stateDigest' => $st['stateDigest'], 'nonce' => $nonce, 'asOfMs' => txlab_now_ms()];
  return ['object' => $obj, 'signature' => mi_sign_obj($cfg, $obj)];
}

function mi_discovery_report($cfg, $def, $maxAgeMs) {
  $out = [];
  foreach ($def['issuers'] as $i) {
    $ref = ['domain' => $i['domain'], 'publicKey' => isset($cfg['roster'][$i['domain']]) ? $cfg['roster'][$i['domain']]['publicKey'] : $i['publicKey'], 'capabilities' => $i['discovery']['capabilities']];
    $d = mi_discover($cfg, $ref, false, $maxAgeMs);
    $out[] = [
      'domain' => $i['domain'], 'ok' => $d['ok'], 'status' => $d['status'], 'reason' => $d['reason'], 'manifest' => $d['manifest'],
      'services' => $d['ok'] ? $d['services'] : null, 'seq' => $d['ok'] ? $d['seq'] : null, 'keyStatus' => $d['ok'] ? $d['keyStatus'] : null,
      'cached' => !empty($d['cached']), 'declared' => $i['discovery']['capabilities'],
    ];
  }
  return $out;
}

// The state authority's own view of an asset; any other domain relays it from the state authority
// (found through discovery) and re-verifies everything locally under its own pinned keys.
function mi_asset_view($assetId, $nonce = null) {
  $cfg = mi_require_config();
  if (!mi_is_uuid($assetId)) mi_fail(400, 'invalid asset id');
  if ($nonce !== null && (!is_string($nonce) || !preg_match('/^[0-9a-f]{32}$/', $nonce))) mi_fail(400, 'nonce must be 32 hex characters');
  if ($cfg['isState']) {
    mi_recover();
    $db = mi_db();
    $asset = mi_load_asset($db, $assetId);
    if (!$asset) mi_fail(404, 'no such asset');
    $portable = mi_portable($db, $asset);
    $ids = [$assetId];
    $trs = [];
    $q = $db->prepare('SELECT tx_id, status, payload_json, created_ms FROM transfers WHERE asset_id = ? ORDER BY created_ms');
    $q->execute([$assetId]);
    foreach ($q->fetchAll(PDO::FETCH_ASSOC) as $r) {
      $pl = json_decode($r['payload_json'], true);
      $trs[] = ['txId' => $r['tx_id'], 'status' => $r['status'], 'baseVersion' => $pl['baseVersion'], 'toKeyId' => mi_key_id($pl['toOwner']), 'createdAtMs' => (int) $r['created_ms']];
      $ids[] = $r['tx_id'];
    }
    $rejected = [];
    foreach (mi_stored_entries($db, 'issuance_approvals', 'asset_id', $assetId) as $e) if ($e['decision'] === 'reject') $rejected[] = ['domain' => $e['domain'], 'approval' => $e['approval'], 'signature' => $e['signature']];
    $st = mi_state_row($db, $assetId);
    return [
      'domain' => $cfg['domain'], 'role' => 'state-authority', 'asset' => $portable, 'status' => $asset['status'], 'failReason' => $asset['fail_reason'],
      'createdAtMs' => (int) $asset['created_ms'], 'expiresAtMs' => (int) $asset['expires_ms'],
      'live' => $st, 'verification' => mi_verify_portable($portable), 'rejections' => $rejected,
      'transfers' => $trs, 'events' => mi_events_for($db, $ids),
      'attestation' => $nonce !== null ? mi_attestation($cfg, $asset, $nonce) : null,
      'discovery' => mi_discovery_report($cfg, $asset['definition'], 15000),
    ];
  }
  $nonce = bin2hex(random_bytes(16));
  $remote = mi_fetch_state($cfg, 'asset', $assetId, $nonce);
  return mi_relayed_asset($cfg, $remote, $nonce, $assetId);
}

// Fetches a view from the state authority named in this domain's own config.
function mi_fetch_state($cfg, $op, $id, $nonce = null) {
  $issuer = mi_issuer_ref($cfg, $cfg['stateAuthority']);
  $inf = mi_inflight_enter($cfg);
  try {
    $url = mi_service_url($cfg, $issuer, MI_CAP_STATE);
    $q = '?op=' . $op . '&id=' . rawurlencode($id) . ($nonce !== null ? '&nonce=' . $nonce : '');
    $r = mi_http($cfg, 'GET', $url . $q, null, 10);
  } finally {
    mi_inflight_leave($inf);
  }
  if ($r['status'] === 404) mi_fail(404, 'the state authority holds no such item');
  if ($r['status'] !== 200 || !is_array($r['body'])) mi_fail(502, 'cannot read from the state authority ' . $cfg['stateAuthority'] . ': ' . $r['error'], ['state' => 'peer-unavailable']);
  return $r['body'];
}

function mi_relayed_asset($cfg, $remote, $nonce, $assetId) {
  if (!isset($remote['asset']) || !is_array($remote['asset'])) mi_fail(502, 'the state authority returned a malformed asset');
  $portable = $remote['asset'];
  $rep = mi_verify_portable($portable);
  $trust = isset($portable['definition']) && is_array($portable['definition']) ? mi_definition_trust_problem($cfg, $portable['definition']) : 'malformed';
  $db = mi_db();
  $mine = mi_signed_row($db, 'issue', $assetId);
  $out = [
    'domain' => $cfg['domain'], 'role' => 'approver', 'relayedFrom' => $cfg['stateAuthority'], 'asset' => $portable,
    'status' => isset($remote['status']) ? $remote['status'] : null, 'failReason' => isset($remote['failReason']) ? $remote['failReason'] : null,
    'createdAtMs' => isset($remote['createdAtMs']) ? $remote['createdAtMs'] : null, 'expiresAtMs' => isset($remote['expiresAtMs']) ? $remote['expiresAtMs'] : null,
    'live' => isset($remote['live']) ? $remote['live'] : null, 'verification' => $rep,
    'attestation' => isset($remote['attestation']) ? $remote['attestation'] : null,
    'trust' => ['ok' => $trust === null, 'problem' => $trust], 'rejections' => isset($remote['rejections']) ? $remote['rejections'] : [],
    'transfers' => isset($remote['transfers']) ? $remote['transfers'] : [], 'events' => isset($remote['events']) ? $remote['events'] : [],
    'thisDomainSigned' => $mine ? ['decision' => $mine['decision'], 'atMs' => (int) $mine['signed_ms']] : null,
    'discovery' => isset($portable['definition']['issuers']) && $trust === null ? mi_discovery_report($cfg, $portable['definition'], 15000) : [],
  ];
  $out['currentOwnership'] = mi_check_attestation($cfg, $portable, $rep, isset($remote['attestation']) ? $remote['attestation'] : null, $nonce, null);
  return $out;
}

// Verifies the registry's signed, nonce-bound state attestation against the evidence chain.
function mi_check_attestation($cfg, $portable, $rep, $att, $nonce, $liveAsset) {
  $res = ['checked' => false, 'status' => 'unverified', 'reason' => null];
  if (!$rep['originalIssuanceVerified']) { $res['reason'] = 'the original issuance does not verify'; return $res; }
  $def = $portable['definition'];
  $reg = mi_issuer($def, $def['stateAuthority']['domain']);
  if (!is_array($att) || !isset($att['object'], $att['signature']) || !is_array($att['object'])) { $res['reason'] = 'the registry returned no signed state attestation'; return $res; }
  $o = $att['object'];
  if (!mi_keys_exact($o, ['asOfMs', 'assetId', 'definitionDigest', 'nonce', 'owner', 'registry', 'stateDigest', 'v', 'version']) || $o['v'] !== MI_ATTESTATION_VERSION) { $res['reason'] = 'malformed attestation'; return $res; }
  if (!mi_verify_obj($reg['publicKey'], $o, $att['signature'])) { $res['reason'] = 'the attestation is not signed by the registry key recorded in the asset'; return $res; }
  if ($o['nonce'] !== $nonce) { $res['reason'] = 'the attestation answers a different challenge (replayed)'; return $res; }
  if (abs(txlab_now_ms() - $o['asOfMs']) > MI_PEER_SKEW_MS) { $res['reason'] = 'the attestation is not fresh'; return $res; }
  if ($o['assetId'] !== $def['assetId'] || $o['definitionDigest'] !== $portable['definitionDigest'] || $o['registry'] !== $def['stateAuthority']['domain']) { $res['reason'] = 'the attestation is for a different asset'; return $res; }
  $res['checked'] = true;
  $res['asOfMs'] = $o['asOfMs'];
  $res['currentVersion'] = $o['version'];
  $res['currentOwnerKeyId'] = mi_key_id($o['owner']);
  $res['currentStateDigest'] = $o['stateDigest'];
  $own = $rep['ownership'];
  $res['importedVersion'] = $own['version'];
  $res['importedOwnerKeyId'] = $own['ownerKeyId'];
  if (!$own['chainValid']) { $res['status'] = 'unverified'; $res['reason'] = 'the ownership evidence in this copy does not verify: ' . implode('; ', $own['problems']); return $res; }
  if ($own['version'] === $o['version'] && $own['stateDigest'] === $o['stateDigest'] && $own['owner'] === $o['owner']) { $res['status'] = 'current'; return $res; }
  if ($own['version'] < $o['version']) { $res['status'] = 'stale'; $res['reason'] = 'ownership has moved on since this copy was exported; it no longer reflects the current owner'; return $res; }
  $res['status'] = 'diverged';
  $res['reason'] = 'this copy claims a state the registry does not know about';
  return $res;
}

function mi_transfer_view($txId) {
  $cfg = mi_require_config();
  if (!mi_is_uuid($txId)) mi_fail(400, 'invalid transfer id');
  if ($cfg['isState']) {
    mi_recover();
    $db = mi_db();
    $tx = mi_load_transfer($db, $txId);
    if (!$tx) mi_fail(404, 'no such transfer');
    $asset = mi_load_asset($db, $tx['asset_id']);
    $def = $asset['definition'];
    $entries = mi_stored_entries($db, 'transfer_approvals', 'tx_id', $txId);
    list($rows, $eval) = mi_check_signatures($def, $entries, $txId, $tx['digest'], $def['transferPolicy']);
    $ownerOk = mi_owner_auth_ok($tx['owner_auth'], $tx['payload'], $tx['digest']) && mi_verify_obj($tx['payload']['fromOwner'], $tx['owner_auth'], $tx['owner_signature']);
    $receipt = null;
    if ($tx['status'] === 'executed') {
      $q = $db->prepare('SELECT receipt_json, signature FROM transitions WHERE tx_id = ?');
      $q->execute([$txId]);
      $r = mi_row($q);
      if ($r) $receipt = ['receipt' => json_decode($r['receipt_json'], true), 'signature' => $r['signature']];
    }
    $stored = [];
    foreach ($entries as $e) $stored[] = ['domain' => $e['domain'], 'decision' => $e['decision'], 'approval' => $e['approval'], 'signature' => $e['signature']];
    return [
      'domain' => $cfg['domain'], 'role' => 'state-authority', 'txId' => $txId, 'assetId' => $tx['asset_id'], 'status' => $tx['status'], 'failReason' => $tx['fail_reason'],
      'payload' => $tx['payload'], 'digest' => $tx['digest'], 'createdAtMs' => (int) $tx['created_ms'], 'expiresAtMs' => (int) $tx['expires_ms'], 'finishedAtMs' => $tx['finished_ms'] === null ? null : (int) $tx['finished_ms'],
      'ownerAuthorization' => ['object' => $tx['owner_auth'], 'signature' => $tx['owner_signature'], 'verified' => $ownerOk],
      'policy' => $def['transferPolicy'], 'approvals' => $stored, 'checks' => $rows,
      'evaluation' => ['approved' => $eval['approved'], 'rejected' => $eval['rejected'], 'required' => $eval['required'], 'missingMandatory' => $eval['missingMandatory'], 'satisfied' => $eval['satisfied']],
      'receipt' => $receipt, 'events' => mi_events_for($db, [$txId]),
    ];
  }
  $remote = mi_fetch_state($cfg, 'tx', $txId);
  if (!isset($remote['payload'], $remote['digest'], $remote['assetId'])) mi_fail(502, 'the state authority returned a malformed transfer');
  $remote['relayedFrom'] = $cfg['stateAuthority'];
  $remote['role'] = 'approver';
  $remote['domain'] = $cfg['domain'];
  $mine = mi_signed_row(mi_db(), 'transfer', $txId);
  $remote['thisDomainSigned'] = $mine ? ['decision' => $mine['decision'], 'atMs' => (int) $mine['signed_ms']] : null;
  if (mi_digest($remote['payload']) !== $remote['digest']) mi_fail(502, 'the state authority returned a transfer that does not match its digest');
  return $remote;
}

// ---------------------------------------------------------------- verify an imported portable asset

function mi_public_verify($asset, $online) {
  $cfg = mi_require_config();
  mi_gate($cfg);
  mi_in_txn(function ($db) use ($cfg) { mi_rate($db, 'verify', mi_who($db), $cfg['public'] !== null ? $cfg['public']['approvalsPerIpPerMinute'] : 30, 60000); });
  $rep = mi_verify_portable($asset);
  $out = ['domain' => $cfg['domain'], 'verification' => $rep, 'trust' => null, 'discovery' => [], 'currentOwnership' => ['checked' => false, 'status' => 'not-checked', 'reason' => 'portable JSON alone cannot prove current ownership; ask the registry']];
  if (!$rep['shapeOk'] || !$rep['definitionDigestOk']) return $out;
  $def = $asset['definition'];
  $t = mi_definition_trust_problem($cfg, $def);
  $out['trust'] = ['ok' => $t === null, 'problem' => $t, 'note' => $t === null ? 'the roster, keys, state authority and policies match this domain\'s own trusted configuration' : 'this domain does not pin this asset\'s issuers; keys are taken from the asset itself (trust on first use)'];
  $out['policy'] = ['issuance' => $def['issuancePolicy'], 'transfer' => $def['transferPolicy'], 'stateAuthority' => $def['stateAuthority']];
  if (!$online) return $out;
  $out['discovery'] = mi_discovery_report($cfg, $def, 0);
  if (!$rep['originalIssuanceVerified']) { $out['currentOwnership']['reason'] = 'the original issuance does not verify, so there is no ownership to check'; return $out; }
  $regDomain = $def['stateAuthority']['domain'];
  $nonce = bin2hex(random_bytes(16));
  $remote = null;
  if ($cfg['isState'] && $regDomain === $cfg['domain']) {
    $db = mi_db();
    $a = mi_load_asset($db, $def['assetId']);
    if ($a) $remote = ['asset' => mi_portable($db, $a), 'attestation' => mi_attestation($cfg, $a, $nonce)];
    else { $out['currentOwnership'] = ['checked' => false, 'status' => 'unknown-to-registry', 'reason' => 'this registry holds no such asset (it may have expired)']; return $out; }
  } else {
    $reg = mi_issuer($def, $regDomain);
    $ref = ['domain' => $regDomain, 'publicKey' => isset($cfg['roster'][$regDomain]) ? $cfg['roster'][$regDomain]['publicKey'] : $reg['publicKey'], 'capabilities' => $reg['discovery']['capabilities']];
    try {
      $inf = mi_inflight_enter($cfg);
      try {
        $url = mi_service_url($cfg, $ref, MI_CAP_STATE);
        $r = mi_http($cfg, 'GET', $url . '?op=asset&id=' . rawurlencode($def['assetId']) . '&nonce=' . $nonce, null, 10);
      } finally {
        mi_inflight_leave($inf);
      }
    } catch (TxlabError $e) {
      $out['currentOwnership'] = ['checked' => false, 'status' => 'unreachable', 'reason' => $e->getMessage()];
      return $out;
    }
    if ($r['status'] === 404) { $out['currentOwnership'] = ['checked' => false, 'status' => 'unknown-to-registry', 'reason' => 'the registry holds no such asset (it may have expired)']; return $out; }
    if ($r['status'] !== 200 || !is_array($r['body'])) { $out['currentOwnership'] = ['checked' => false, 'status' => 'unreachable', 'reason' => 'the registry could not be read: ' . $r['error']]; return $out; }
    $remote = $r['body'];
  }
  $liveRep = isset($remote['asset']) && is_array($remote['asset']) ? mi_verify_portable($remote['asset']) : null;
  if ($liveRep === null || !$liveRep['originalIssuanceVerified'] || (isset($remote['asset']['definitionDigest']) && $remote['asset']['definitionDigest'] !== $asset['definitionDigest'])) {
    $out['currentOwnership'] = ['checked' => false, 'status' => 'unverified', 'reason' => 'the registry returned evidence that does not verify for this asset'];
    return $out;
  }
  // the registry's own chain must extend the evidence in the imported copy exactly
  $imp = isset($asset['ownership']['evidence']) && is_array($asset['ownership']['evidence']) ? $asset['ownership']['evidence'] : [];
  $live = $remote['asset']['ownership']['evidence'];
  $prefixOk = $liveRep['ownership']['chainValid'];
  for ($i = 0; $prefixOk && $i < count($imp) && $i < count($live); $i++) if (canonicalize($imp[$i]) !== canonicalize($live[$i])) $prefixOk = false;
  $cur = mi_check_attestation($cfg, $asset, $rep, isset($remote['attestation']) ? $remote['attestation'] : null, $nonce, null);
  if ($cur['checked'] && (!$prefixOk || $liveRep['ownership']['version'] !== $cur['currentVersion'] || $liveRep['ownership']['stateDigest'] !== $cur['currentStateDigest'])) {
    $cur['status'] = 'diverged';
    $cur['reason'] = 'the registry\'s signed history disagrees with this copy or with its own attestation';
  }
  if ($cur['checked'] && $cur['status'] === 'stale') $cur['currentOwnerKeyId'] = mi_key_id($liveRep['ownership']['owner']);
  $out['currentOwnership'] = $cur;
  return $out;
}

// ---------------------------------------------------------------- health

function mi_health() {
  list($cfg, $problems) = mi_load_config();
  if ($cfg === null) return ['lab' => 'multi-issuer', 'enabled' => false, 'reasons' => $problems];
  $db = mi_db();
  $m = $cfg['dir'] . '/manifest.json';
  return [
    'lab' => 'multi-issuer', 'enabled' => true, 'domain' => $cfg['domain'], 'role' => $cfg['isState'] ? 'state-authority' : 'approver',
    'stateAuthority' => $cfg['stateAuthority'], 'keyId' => $cfg['roster'][$cfg['domain']]['keyId'], 'roster' => $cfg['rosterDomains'],
    'issuance' => $cfg['issuance'], 'transfer' => $cfg['transfer'], 'publicDemo' => $cfg['public'] !== null,
    'openDiscovery' => $cfg['openDiscovery'], 'manifestPresent' => is_file($m), 'database' => (int) mi_col($db->query('SELECT 1')) === 1,
    'capabilities' => mi_capabilities(),
  ];
}

// The signed discovery manifest generated by tools/mi-admin.php (also served statically at the well-known path).
function mi_manifest_doc() {
  $cfg = mi_require_config();
  $f = $cfg['dir'] . '/manifest.json';
  if (!is_file($f)) mi_fail(404, 'no discovery manifest has been generated');
  $j = json_decode((string) file_get_contents($f), true);
  if (!is_array($j)) mi_fail(500, 'the discovery manifest is unreadable');
  return $j;
}
