<?php
// EXPERIMENTAL signed ledger balance receipts (chainblock-ledger38/signed-receipt-experimental).
// Off unless lib/atlas-ledger-receipts-config.json says {"enabled": true}. Independent of the
// credential-issuance switch and of its store: each has its own flag, replay nonces and limits.
//
// The endpoint signs one fixed statement: "at this moment this ledger held N minor units of this
// coin for this owner key". It builds that statement itself from
//   1. a fresh request signed by the owner (raw P-256, audience = this exact URL), and
//   2. the Labs 29 ledger databases, opened read-only from the private folder beside the document
//      root, where the Labs 29 service keeps them.
// No amount, account, credential or key from the request is ever signed or trusted. The signing
// key is the established issuer key; this file never creates one and never copies it anywhere.
//
// The ledger has no state version, so a receipt says `state: {status: no-state-version}`: it
// authenticates an observation by this issuer at `observedAt`, not a committed ledger state.
//
// Self-contained on purpose: nothing here requires lib/ledger-issuance.php.

const ATLAS_RECEIPT_HOSTS = ['evtec.co.za', 'domain-atlas.co.za'];
const ATLAS_RECEIPT_NETWORK_PREFIX = 'chainblock-labs29-';
const ATLAS_RECEIPT_CONTRACT = 'chainblock-ledger38/signed-receipt-experimental';
const ATLAS_RECEIPT_REQUEST_TYPE = 'atlas.ledger.balance-receipt.request';
const ATLAS_RECEIPT_TYPE = 'atlas.ledger.balance-receipt';
const ATLAS_RECEIPT_MAX_BODY_BYTES = 4096;
const ATLAS_RECEIPT_WINDOW_S = 120;
const ATLAS_RECEIPT_NONCE_RETAIN_S = 600;
const ATLAS_RECEIPT_NONCE_CAP = 20000;
const ATLAS_RECEIPT_LOG_CAP = 500;
const ATLAS_RECEIPT_MAX_DECIMALS = 18;

function atlas_receipt_config_file() { return __DIR__ . '/atlas-ledger-receipts-config.json'; }
function atlas_receipt_store_file() { return __DIR__ . '/atlas-ledger-receipts-store.json'; }

// {"enabled": true, "domain": "evtec.co.za"} plus optional limits. `domain` is configured, never
// taken from the Host header; the route refuses when they disagree.
function atlas_receipt_config() {
  $cfg = ['enabled' => false, 'problem' => null, 'domain' => null, 'perClientPerMinute' => 30, 'perOwnerPerHour' => 60, 'globalPerHour' => 600];
  $path = atlas_receipt_config_file();
  if (!is_file($path)) return $cfg;
  $f = json_decode((string) file_get_contents($path), true);
  if (!is_array($f) || ($f['enabled'] ?? false) !== true) return $cfg;
  $cfg['enabled'] = true;
  if (!is_string($f['domain'] ?? null) || !in_array($f['domain'], ATLAS_RECEIPT_HOSTS, true)) { $cfg['problem'] = 'domain must be one of the Labs 29 hosts'; return $cfg; }
  $cfg['domain'] = $f['domain'];
  foreach (['perClientPerMinute', 'perOwnerPerHour', 'globalPerHour'] as $k) {
    if (isset($f[$k]) && is_int($f[$k]) && $f[$k] > 0) $cfg[$k] = $f[$k];
  }
  return $cfg;
}

function atlas_receipt_fail($status, $code, $message, $extra = []) {
  send_json($status, array_merge(['ok' => false, 'code' => $code, 'error' => $message], $extra));
}

function atlas_receipt_b64url($s) {
  if (!is_string($s) || !preg_match('/^[A-Za-z0-9_-]+$/D', $s)) return null;
  $bin = base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4), true);
  return $bin !== false && rtrim(strtr(base64_encode($bin), '+/', '-_'), '=') === $s ? $bin : null;
}

// The one accepted spelling of an owner key: the 65-byte uncompressed point, 87 characters.
function atlas_receipt_point($s) {
  if (!is_string($s) || strlen($s) !== 87) return null;
  $bin = atlas_receipt_b64url($s);
  return $bin !== null && strlen($bin) === 65 && ord($bin[0]) === 4 ? $bin : null;
}

function atlas_receipt_iso_seconds($s) {
  if (!is_string($s) || !preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/D', $s)) return null;
  $t = strtotime($s);
  return $t === false ? null : $t;
}

function atlas_receipt_account_id($network, $coin, $ownerKey) {
  return 'urn:atlas:ledger-account:' . hash('sha256', canonicalize(['coin' => $coin, 'network' => $network, 'owner' => $ownerKey, 'purpose' => 'atlas.ledger.account-id', 'v' => 1]));
}

function atlas_receipt_verify_raw($payload, $ownerKey, $signature) {
  $point = atlas_receipt_point($ownerKey);
  $sig = atlas_receipt_b64url($signature);
  if ($point === null || $sig === null || strlen($sig) !== 64) return false;
  try {
    return ecdsa_verify_raw(ec_raw_point_to_pem($point), $sig, canonicalize($payload));
  } catch (Exception $e) {
    return false;
  }
}

function atlas_receipt_exact_keys($arr, $keys) {
  return is_array($arr) && count($arr) === count($keys) && !array_diff($keys, array_keys($arr)) && !array_diff(array_keys($arr), $keys);
}

// Loads the established issuer key and nothing else: unlike load_or_create_keypair() it never
// generates one, and it requires the published key document to list this exact key as valid now.
// Returns ['privateKey', 'publicKeyB64url'], or null.
function atlas_receipt_load_signing_key($nowS) {
  $keyFile = atlas_key_file();
  $pubFile = atlas_public_key_file();
  if (!is_file($keyFile) || !is_file($pubFile)) return null;
  $priv = openssl_pkey_get_private((string) file_get_contents($keyFile));
  if ($priv === false) return null;
  $d = openssl_pkey_get_details($priv);
  if (!isset($d['ec']['x'], $d['ec']['y'])) return null;
  $pub = b64url_encode("\x04" . str_pad($d['ec']['x'], 32, "\x00", STR_PAD_LEFT) . str_pad($d['ec']['y'], 32, "\x00", STR_PAD_LEFT));
  $doc = json_decode((string) file_get_contents($pubFile), true);
  foreach (is_array($doc) && is_array($doc['keys'] ?? null) ? $doc['keys'] : [] as $k) {
    if (!is_array($k) || ($k['publicKey'] ?? null) !== $pub) continue;
    $from = atlas_receipt_iso_seconds($k['validFrom'] ?? null);
    $until = isset($k['validUntil']) ? atlas_receipt_iso_seconds($k['validUntil']) : PHP_INT_MAX;
    if ($from !== null && $until !== null && $nowS >= $from && $nowS < $until) return ['privateKey' => $priv, 'publicKeyB64url' => $pub];
  }
  return null;
}

// Reads the shared revocation list and reports one of: 'missing' (the file does not exist yet,
// the only case treated as an empty list), 'unreadable', 'malformed' or 'ok'. Anything but
// 'missing' and 'ok' means revocations cannot be consulted, and the caller must refuse to answer.
function atlas_receipt_revocation_list() {
  $path = atlas_revocations_file();
  clearstatcache(true, $path);
  if (!file_exists($path)) return ['state' => 'missing', 'ids' => []];
  $data = @file_get_contents($path);
  if ($data === false) return ['state' => 'unreadable', 'ids' => []];
  $doc = json_decode($data, true);
  if (!is_array($doc) || !isset($doc['revoked']) || !is_array($doc['revoked'])) return ['state' => 'malformed', 'ids' => []];
  $ids = [];
  foreach ($doc['revoked'] as $r) {
    if (is_array($r) && isset($r['id']) && is_string($r['id'])) $ids[$r['id']] = true;
  }
  return ['state' => 'ok', 'ids' => $ids];
}

// true / false when the list could be consulted, null when it could not (unreadable or malformed).
function atlas_receipt_is_revoked($id) {
  $list = atlas_receipt_revocation_list();
  if ($list['state'] === 'unreadable' || $list['state'] === 'malformed') return null;
  return isset($list['ids'][$id]);
}

// Spends the request nonce and applies the per-owner and global limits in one locked step.
// Returns 'ok', 'replayed', 'full', 'owner-limit' or 'global-limit'.
function atlas_receipt_admit($ownerKey, $nonce, $nowS, $cfg) {
  $file = atlas_receipt_store_file();
  if (!file_exists($file)) @touch($file);
  return atlas_admin_locked($file, ['nonces' => [], 'served' => [], 'coins' => [], 'log' => []], function ($doc) use ($ownerKey, $nonce, $nowS, $cfg) {
    $nonces = array_values(array_filter(is_array($doc['nonces'] ?? null) ? $doc['nonces'] : [], function ($n) use ($nowS) { return is_array($n) && count($n) === 2 && $n[1] > $nowS; }));
    $served = array_values(array_filter(is_array($doc['served'] ?? null) ? $doc['served'] : [], function ($i) use ($nowS) { return is_array($i) && count($i) === 2 && $nowS - $i[1] < 3600; }));
    $doc['nonces'] = $nonces;
    $doc['served'] = $served;
    $key = hash('sha256', $ownerKey . '|' . $nonce);
    foreach ($nonces as $n) { if ($n[0] === $key) return [$doc, 'replayed']; }
    if (count($nonces) >= ATLAS_RECEIPT_NONCE_CAP) return [$doc, 'full'];
    $ownerHash = hash('sha256', $ownerKey);
    $mine = 0;
    foreach ($served as $i) { if ($i[0] === $ownerHash) $mine++; }
    if ($mine >= $cfg['perOwnerPerHour']) return [$doc, 'owner-limit'];
    if (count($served) >= $cfg['globalPerHour']) return [$doc, 'global-limit'];
    $doc['nonces'][] = [$key, $nowS + ATLAS_RECEIPT_NONCE_RETAIN_S];
    $doc['served'][] = [$ownerHash, $nowS];
    return [$doc, 'ok'];
  });
}

// A coin's decimals are fixed for its identifier. The first value seen is remembered and any later
// different value is refused, so a registry row changed under a live coin never signs.
function atlas_receipt_pin_decimals($coinId, $decimals) {
  return atlas_admin_locked(atlas_receipt_store_file(), ['nonces' => [], 'served' => [], 'coins' => [], 'log' => []], function ($doc) use ($coinId, $decimals) {
    $coins = is_array($doc['coins'] ?? null) ? $doc['coins'] : [];
    if (array_key_exists($coinId, $coins)) return [$doc, $coins[$coinId] === $decimals];
    $coins[$coinId] = $decimals;
    $doc['coins'] = $coins;
    return [$doc, true];
  });
}

function atlas_receipt_record($id, $coin, $nowS) {
  atlas_admin_locked(atlas_receipt_store_file(), ['nonces' => [], 'served' => [], 'coins' => [], 'log' => []], function ($doc) use ($id, $coin, $nowS) {
    $log = is_array($doc['log'] ?? null) ? $doc['log'] : [];
    $log[] = ['at' => gmdate('Y-m-d\TH:i:s\Z', $nowS), 'id' => $id, 'coin' => $coin];
    $doc['log'] = array_slice($log, -ATLAS_RECEIPT_LOG_CAP);
    return [$doc, true];
  });
}

// The folder the Labs 29 service keeps its databases in: beside the document root, never under it.
function atlas_receipt_private_dir() {
  clearstatcache(true);
  $doc = realpath($_SERVER['DOCUMENT_ROOT'] ?? '');
  if (!$doc) return null;
  $private = realpath(dirname($doc) . '/chainblock-labs-private');
  if (!$private || strpos($private . '/', $doc . '/') === 0) return null;
  return $private;
}

function atlas_receipt_open_readonly($file) {
  if (!is_file($file)) return null;
  $db = new PDO('sqlite:file:' . $file . '?mode=ro', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5]);
  $db->exec('PRAGMA query_only=ON');
  return $db;
}

// Reads the registry row and the account row, each inside its own read transaction. The two
// databases are separate SQLite files, so this is not one atomic snapshot of both.
// Returns ['status' => 'ok', 'coinId', 'decimals', 'amount'] (amount is a string of minor units),
// ['status' => 'no-coin'], ['status' => 'no-account'] or ['status' => 'unavailable'].
function atlas_receipt_read_balance($domain, $coin, $ownerKey) {
  try {
    $private = atlas_receipt_private_dir();
    if ($private === null) return ['status' => 'unavailable'];
    $registry = atlas_receipt_open_readonly($private . '/coin26.sqlite');
    $ledger = atlas_receipt_open_readonly($private . '/ledger29.sqlite');
    if ($registry === null || $ledger === null) return ['status' => 'unavailable'];

    $registry->exec('BEGIN');
    $q = $registry->prepare('SELECT id,decimals FROM coins WHERE domain=? AND symbol=?');
    $q->execute([$domain, $coin]);
    $row = $q->fetch(PDO::FETCH_ASSOC);
    $registry->exec('ROLLBACK');
    if (!$row) return ['status' => 'no-coin'];
    if (!is_string($row['id']) || $row['id'] === '') return ['status' => 'unavailable'];
    $decimals = $row['decimals'];
    if (is_string($decimals) && preg_match('/^\d{1,2}$/D', $decimals)) $decimals = (int) $decimals;
    if (!is_int($decimals) || $decimals < 0 || $decimals > ATLAS_RECEIPT_MAX_DECIMALS) return ['status' => 'unavailable'];

    $ledger->exec('BEGIN');
    $q = $ledger->prepare('SELECT amount_units FROM accounts WHERE coin_id=? AND owner_key=?');
    $q->execute([$row['id'], $ownerKey]);
    $value = $q->fetchColumn();
    $ledger->exec('ROLLBACK');
    if ($value === false) return ['status' => 'no-account'];
    $amount = is_int($value) ? (string) $value : (is_string($value) && preg_match('/^(0|[1-9][0-9]{0,39})$/D', $value) ? $value : null);
    if ($amount === null || $amount[0] === '-') return ['status' => 'unavailable'];
    return ['status' => 'ok', 'coinId' => $row['id'], 'decimals' => $decimals, 'amount' => $amount];
  } catch (Throwable $e) {
    return ['status' => 'unavailable'];
  }
}

// The only constructor of a signed receipt payload. Every value comes from the verified request or
// from the ledger read; nothing is copied from the request body except what was just verified.
function atlas_receipt_payload($request, $owner, $network, $coin, $account, $amount, $decimals, $observedAtS) {
  return [
    'type' => ATLAS_RECEIPT_TYPE,
    'v' => 1,
    'request' => ['nonce' => $request['nonce'], 'hash' => hash('sha256', canonicalize($request))],
    'network' => $network,
    'coin' => $coin,
    'account' => $account,
    'owner' => $owner,
    'amount' => $amount,
    'decimals' => $decimals,
    'observedAt' => gmdate('Y-m-d\TH:i:s\Z', $observedAtS),
    'state' => ['status' => 'no-state-version'],
  ];
}

function atlas_receipt_status() {
  $cfg = atlas_receipt_config();
  if (!$cfg['enabled']) atlas_receipt_fail(404, 'disabled', 'Signed balance receipts are not enabled');
  if ($cfg['problem'] !== null) atlas_receipt_fail(503, 'misconfigured', 'Signed balance receipts are misconfigured');
  $domain = $cfg['domain'];
  // Reports whether the private databases can be opened read-only, so an operator can check a host
  // before relying on it. It names no path and carries no key: discovery never appoints a signer.
  $private = atlas_receipt_private_dir();
  $readable = $private !== null && is_readable($private . '/coin26.sqlite') && is_readable($private . '/ledger29.sqlite');
  send_json(200, [
    'ok' => true,
    'contract' => ATLAS_RECEIPT_CONTRACT,
    'operation' => 'https://' . $domain . '/atlas/ledger/balance-receipt',
    'network' => ATLAS_RECEIPT_NETWORK_PREFIX . $domain,
    'requestType' => ATLAS_RECEIPT_REQUEST_TYPE,
    'receiptType' => ATLAS_RECEIPT_TYPE,
    'state' => 'no-state-version',
    'signedDiscovery' => false,
    'ledgerStorage' => $readable ? 'readable' : 'unavailable',
    'warning' => 'Experimental; a receipt authenticates an observation, not a final or spendable balance',
  ]);
}

function atlas_receipt_serve() {
  $cfg = atlas_receipt_config();
  if (!$cfg['enabled']) atlas_receipt_fail(404, 'disabled', 'Signed balance receipts are not enabled');
  if ($cfg['problem'] !== null) atlas_receipt_fail(503, 'misconfigured', 'Signed balance receipts are misconfigured');
  if (empty($_SERVER['HTTPS']) || $_SERVER['HTTPS'] === 'off') atlas_receipt_fail(403, 'https-required', 'HTTPS required');
  $domain = $cfg['domain'];
  if (strtolower($_SERVER['HTTP_HOST'] ?? '') !== $domain) atlas_receipt_fail(400, 'unknown-host', 'This host does not sign for that domain');
  if ($_SERVER['REQUEST_METHOD'] === 'GET') atlas_receipt_status();
  if ($_SERVER['REQUEST_METHOD'] !== 'POST') atlas_receipt_fail(405, 'unknown-operation', 'GET or POST only');
  $network = ATLAS_RECEIPT_NETWORK_PREFIX . $domain;
  $operation = 'https://' . $domain . '/atlas/ledger/balance-receipt';

  $retry = atlas_admin_limiter('ledgerReceipts', 'take', $cfg['perClientPerMinute'], 60000);
  if ($retry) { header('Retry-After: ' . (int) $retry); atlas_receipt_fail(429, 'rate-limited', 'Too many requests'); }

  $raw = read_limited_body(ATLAS_RECEIPT_MAX_BODY_BYTES);
  $body = json_decode($raw, true);
  if (!atlas_receipt_exact_keys($body, ['payload', 'proof'])) atlas_receipt_fail(400, 'malformed-request', 'Expected payload and proof');
  $p = $body['payload']; $proof = $body['proof'];
  $fields = ['type', 'v', 'audience', 'network', 'coin', 'nonce', 'issuedAt'];
  if (!atlas_receipt_exact_keys($p, $fields)) atlas_receipt_fail(400, 'malformed-request', 'Unexpected request fields');
  foreach ($fields as $f) { if ($f !== 'v' && !is_string($p[$f])) atlas_receipt_fail(400, 'malformed-request', 'Unexpected field type'); }
  if ($p['type'] !== ATLAS_RECEIPT_REQUEST_TYPE || $p['v'] !== 1) atlas_receipt_fail(400, 'malformed-request', 'Wrong request type');
  if ($p['audience'] !== $operation) atlas_receipt_fail(401, 'wrong-audience', 'Audience must be the exact receipt URL');
  if ($p['network'] !== $network) atlas_receipt_fail(400, 'unknown-network', 'Wrong network');
  if (!preg_match('/^[A-Z][A-Z0-9]{1,9}$/D', $p['coin'])) atlas_receipt_fail(400, 'malformed-request', 'Invalid coin');
  if (!preg_match('/^[a-f0-9]{32,64}$/D', $p['nonce'])) atlas_receipt_fail(400, 'malformed-request', 'Invalid nonce');
  $nowS = time();
  $ts = atlas_receipt_iso_seconds($p['issuedAt']);
  if ($ts === null) atlas_receipt_fail(400, 'malformed-request', 'Invalid timestamp');
  if (abs($nowS - $ts) > ATLAS_RECEIPT_WINDOW_S) atlas_receipt_fail(401, 'stale-request', 'Clock outside the two-minute window', ['serverTime' => gmdate('Y-m-d\TH:i:s\Z', $nowS)]);

  // Only a raw P-256 owner proof is accepted, as the Labs 29 ledger itself does.
  if (!atlas_receipt_exact_keys($proof, ['publicKey', 'signature']) || atlas_receipt_point($proof['publicKey']) === null || atlas_receipt_b64url($proof['signature']) === null) {
    atlas_receipt_fail(401, 'unsupported-proof', 'Only raw P-256 wallet proofs are supported');
  }
  $owner = $proof['publicKey'];
  if (!atlas_receipt_verify_raw($p, $owner, $proof['signature'])) atlas_receipt_fail(401, 'bad-signature', 'Owner signature invalid');

  $key = atlas_receipt_load_signing_key($nowS);
  if ($key === null) atlas_receipt_fail(503, 'issuer-key-unavailable', 'The established issuer key is not available or not valid now');

  $coin = $p['coin'];
  $account = atlas_receipt_account_id($network, $coin, $owner);
  $revoked = atlas_receipt_is_revoked($account);
  if ($revoked === null) atlas_receipt_fail(503, 'revocations-unavailable', 'The revocation list cannot be read right now');
  if ($revoked) atlas_receipt_fail(409, 'account-revoked', 'This account reference has been revoked');

  $admit = atlas_receipt_admit($owner, $p['nonce'], $nowS, $cfg);
  if ($admit === 'replayed') atlas_receipt_fail(409, 'replayed-request', 'Signed request has already been used');
  if ($admit !== 'ok') { header('Retry-After: 60'); atlas_receipt_fail($admit === 'full' ? 503 : 429, $admit === 'full' ? 'busy' : 'rate-limited', 'Receipts are limited right now'); }

  $read = atlas_receipt_read_balance($domain, $coin, $owner);
  if ($read['status'] === 'unavailable') atlas_receipt_fail(502, 'ledger-unavailable', 'The ledger could not be read');
  if ($read['status'] === 'no-coin') atlas_receipt_fail(404, 'unknown-coin', 'Coin not registered on this domain');
  if ($read['status'] === 'no-account') atlas_receipt_fail(404, 'account-not-found', 'The ledger has no account for this owner and coin');
  if (!atlas_receipt_pin_decimals($read['coinId'], $read['decimals'])) atlas_receipt_fail(502, 'ledger-mismatch', 'The coin\'s decimals changed');

  // The key must be valid at the moment of observation, which is also the moment of signing.
  $observedS = time();
  $key = atlas_receipt_load_signing_key($observedS);
  if ($key === null) atlas_receipt_fail(503, 'issuer-key-unavailable', 'The established issuer key is not available or not valid now');
  $payload = atlas_receipt_payload($p, $owner, $network, $coin, $account, $read['amount'], $read['decimals'], $observedS);
  $signature = atlas_sign($key['privateKey'], $payload);
  atlas_receipt_record($account, $coin, $observedS);
  send_json(200, ['ok' => true, 'contract' => ATLAS_RECEIPT_CONTRACT, 'payload' => $payload, 'signerKey' => $key['publicKeyB64url'], 'signature' => $signature]);
}
