<?php
// EXPERIMENTAL issuer-signed ledger-account references (domain-atlas-ledger-account/1.0).
// Off unless lib/atlas-ledger-issuance-config.json says {"enabled": true}. Mirrors
// issuer-server/lib-ledger-issuance.js; both answer POST /atlas/ledger/account-credential.
//
// The endpoint signs one thing: a reference saying "this owner key has an account in this coin
// on this domain's Labs 29 ledger". It signs it only after
//   1. the owner signed a fresh issuance request (raw P-256, audience = this exact URL), and
//   2. the ledger itself, asked with the owner's own signed Labs 31 listing request, returned
//      that account with the account ID this file derives independently.
// Nothing in the request is trusted as proof that the account exists, and the credential carries
// no balance. The signing key is the established issuer key; this file never creates one.

const ATLAS_LEDGER_HOSTS = ['evtec.co.za', 'domain-atlas.co.za'];
const ATLAS_LEDGER_NETWORK_PREFIX = 'chainblock-labs29-';
const ATLAS_LEDGER_CREDENTIAL = 'domain-atlas-ledger-account/1.0';
const ATLAS_LEDGER_ISSUE_TYPE = 'atlas.ledger.account.issue';
const ATLAS_LEDGER_ACCOUNTS_TYPE = 'atlas.ledger.accounts';
const ATLAS_LEDGER_MAX_BODY_BYTES = 8192;
const ATLAS_LEDGER_WINDOW_S = 120;
const ATLAS_LEDGER_NONCE_RETAIN_S = 600;
const ATLAS_LEDGER_NONCE_CAP = 20000;
const ATLAS_LEDGER_LOG_CAP = 500;
const ATLAS_LEDGER_CORE_MAX_BYTES = 65536;

function atlas_ledger_config_file() { return __DIR__ . '/atlas-ledger-issuance-config.json'; }
function atlas_ledger_store_file() { return __DIR__ . '/atlas-ledger-issuance-store.json'; }

// {"enabled": true, "domain": "evtec.co.za"} plus optional limits. `domain` is configured, never
// taken from the Host header; the route refuses when they disagree. `coreBase` exists for tests
// and accepts only a loopback http address; the real ledger is always https://<domain>.
function atlas_ledger_config() {
  $cfg = ['enabled' => false, 'problem' => null, 'domain' => null, 'coreBase' => null, 'perClientPerMinute' => 20, 'perOwnerPerHour' => 10, 'globalPerHour' => 300];
  $path = atlas_ledger_config_file();
  if (!is_file($path)) return $cfg;
  $f = json_decode((string) file_get_contents($path), true);
  if (!is_array($f) || ($f['enabled'] ?? false) !== true) return $cfg;
  $cfg['enabled'] = true;
  if (!is_string($f['domain'] ?? null) || !in_array($f['domain'], ATLAS_LEDGER_HOSTS, true)) { $cfg['problem'] = 'domain must be one of the Labs 29 hosts'; return $cfg; }
  $cfg['domain'] = $f['domain'];
  if (isset($f['coreBase'])) {
    if (!is_string($f['coreBase']) || !preg_match('#^http://(127\.0\.0\.1|localhost)(:\d{1,5})?$#D', $f['coreBase'])) { $cfg['problem'] = 'coreBase must be a loopback http address'; return $cfg; }
    $cfg['coreBase'] = $f['coreBase'];
  }
  foreach (['perClientPerMinute', 'perOwnerPerHour', 'globalPerHour'] as $k) {
    if (isset($f[$k]) && is_int($f[$k]) && $f[$k] > 0) $cfg[$k] = $f[$k];
  }
  return $cfg;
}

function atlas_ledger_fail($status, $code, $message, $extra = []) {
  send_json($status, array_merge(['ok' => false, 'code' => $code, 'error' => $message], $extra));
}

// base64url that decodes and re-encodes to the same text; anything else is not accepted.
function atlas_ledger_b64url($s) {
  if (!is_string($s) || !preg_match('/^[A-Za-z0-9_-]+$/D', $s)) return null;
  $bin = base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4), true);
  return $bin !== false && rtrim(strtr(base64_encode($bin), '+/', '-_'), '=') === $s ? $bin : null;
}

// The one accepted spelling of an owner key: the 65-byte uncompressed point, 87 characters.
function atlas_ledger_point($s) {
  if (!is_string($s) || strlen($s) !== 87) return null;
  $bin = atlas_ledger_b64url($s);
  return $bin !== null && strlen($bin) === 65 && ord($bin[0]) === 4 ? $bin : null;
}

function atlas_ledger_iso_seconds($s) {
  if (!is_string($s) || !preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/D', $s)) return null;
  $t = strtotime($s);
  return $t === false ? null : $t;
}

// SHA-256 over the same sorted-key canonical JSON the wallet and Core use.
function atlas_ledger_account_id($network, $coin, $ownerKey) {
  return 'urn:atlas:ledger-account:' . hash('sha256', canonicalize(['coin' => $coin, 'network' => $network, 'owner' => $ownerKey, 'purpose' => 'atlas.ledger.account-id', 'v' => 1]));
}

function atlas_ledger_verify_raw($payload, $ownerKey, $signature) {
  $point = atlas_ledger_point($ownerKey);
  $sig = atlas_ledger_b64url($signature);
  if ($point === null || $sig === null || strlen($sig) !== 64) return false;
  try {
    return ecdsa_verify_raw(ec_raw_point_to_pem($point), $sig, canonicalize($payload));
  } catch (Exception $e) {
    return false;
  }
}

function atlas_ledger_exact_keys($arr, $keys) {
  return is_array($arr) && count($arr) === count($keys) && !array_diff($keys, array_keys($arr)) && !array_diff(array_keys($arr), $keys);
}

// Loads the established issuer key and nothing else: unlike load_or_create_keypair() it never
// generates one, and it requires the published key document to list this exact key as valid now.
// Returns ['privateKey', 'publicKeyB64url'], or null.
function atlas_ledger_load_signing_key($nowS) {
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
    $from = atlas_ledger_iso_seconds($k['validFrom'] ?? null);
    $until = isset($k['validUntil']) ? atlas_ledger_iso_seconds($k['validUntil']) : PHP_INT_MAX;
    if ($from !== null && $until !== null && $nowS >= $from && $nowS <= $until) return ['privateKey' => $priv, 'publicKeyB64url' => $pub];
  }
  return null;
}

// Reads the shared revocation list and reports one of: 'missing', 'unreadable', 'malformed' (not
// JSON, no list, or an entry that is not an object with an id) or 'ok'. Anything but 'ok' means
// revocations cannot be consulted, and the caller must refuse to answer.
function atlas_ledger_revocation_list() {
  $path = atlas_revocations_file();
  clearstatcache(true, $path);
  if (!file_exists($path)) return ['state' => 'missing', 'ids' => []];
  $data = @file_get_contents($path);
  if ($data === false) return ['state' => 'unreadable', 'ids' => []];
  $doc = json_decode($data, true);
  if (!is_array($doc) || !isset($doc['revoked']) || !is_array($doc['revoked'])) return ['state' => 'malformed', 'ids' => []];
  $ids = [];
  foreach ($doc['revoked'] as $r) {
    if (!is_array($r) || !isset($r['id']) || !is_string($r['id']) || $r['id'] === '') return ['state' => 'malformed', 'ids' => []];
    $ids[$r['id']] = true;
  }
  return ['state' => 'ok', 'ids' => $ids];
}

// true / false when the list could be consulted, null when it could not (missing, unreadable or malformed).
function atlas_ledger_is_revoked($id) {
  $list = atlas_ledger_revocation_list();
  if ($list['state'] !== 'ok') return null;
  return isset($list['ids'][$id]);
}

// Spends the request nonce and applies the per-owner and global issuance limits in one locked
// step. Returns 'ok', 'replayed', 'full' or 'owner-limit' / 'global-limit'.
function atlas_ledger_admit($ownerKey, $nonce, $nowS, $cfg) {
  $file = atlas_ledger_store_file();
  if (!file_exists($file)) @touch($file);
  return atlas_admin_locked($file, ['nonces' => [], 'issued' => [], 'log' => []], function ($doc) use ($ownerKey, $nonce, $nowS, $cfg) {
    $nonces = array_values(array_filter(is_array($doc['nonces'] ?? null) ? $doc['nonces'] : [], function ($n) use ($nowS) { return is_array($n) && count($n) === 2 && $n[1] > $nowS; }));
    $issued = array_values(array_filter(is_array($doc['issued'] ?? null) ? $doc['issued'] : [], function ($i) use ($nowS) { return is_array($i) && count($i) === 2 && $nowS - $i[1] < 3600; }));
    $doc['nonces'] = $nonces;
    $doc['issued'] = $issued;
    $key = hash('sha256', $ownerKey . '|' . $nonce);
    foreach ($nonces as $n) { if ($n[0] === $key) return [$doc, 'replayed']; }
    if (count($nonces) >= ATLAS_LEDGER_NONCE_CAP) return [$doc, 'full'];
    $ownerHash = hash('sha256', $ownerKey);
    $mine = 0;
    foreach ($issued as $i) { if ($i[0] === $ownerHash) $mine++; }
    if ($mine >= $cfg['perOwnerPerHour']) return [$doc, 'owner-limit'];
    if (count($issued) >= $cfg['globalPerHour']) return [$doc, 'global-limit'];
    $doc['nonces'][] = [$key, $nowS + ATLAS_LEDGER_NONCE_RETAIN_S];
    $doc['issued'][] = [$ownerHash, $nowS];
    return [$doc, 'ok'];
  });
}

function atlas_ledger_record($id, $coin, $nowS) {
  atlas_admin_locked(atlas_ledger_store_file(), ['nonces' => [], 'issued' => [], 'log' => []], function ($doc) use ($id, $coin, $nowS) {
    $log = is_array($doc['log'] ?? null) ? $doc['log'] : [];
    $log[] = ['at' => gmdate('Y-m-d\TH:i:s\Z', $nowS), 'id' => $id, 'coin' => $coin];
    $doc['log'] = array_slice($log, -ATLAS_LEDGER_LOG_CAP);
    return [$doc, true];
  });
}

// Asks the ledger. The address is built here from the configured domain; the request carries only
// the owner's own signed listing request, unchanged. No redirects, bounded time and size.
// Returns ['status' => int, 'json' => array|null], or null when the ledger could not be reached.
function atlas_ledger_ask_core($cfg, $body) {
  if (!function_exists('curl_init')) return null;
  $url = ($cfg['coreBase'] ?? ('https://' . $cfg['domain'])) . '/chain-labs/accounts31.php?action=accounts';
  $headers = ['Content-Type: application/json', 'Accept: application/json', 'User-Agent: ' . ATLAS_OUTBOUND_USER_AGENT];
  if ($cfg['coreBase'] !== null) $headers[] = 'Host: ' . $cfg['domain'];
  $got = '';
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode($body, JSON_UNESCAPED_SLASHES),
    CURLOPT_HTTPHEADER => $headers,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT => 8,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
    CURLOPT_PROTOCOLS => $cfg['coreBase'] !== null ? (CURLPROTO_HTTP | CURLPROTO_HTTPS) : CURLPROTO_HTTPS,
    CURLOPT_WRITEFUNCTION => function ($c, $chunk) use (&$got) {
      if (strlen($got) + strlen($chunk) > ATLAS_LEDGER_CORE_MAX_BYTES) return 0;
      $got .= $chunk;
      return strlen($chunk);
    },
  ]);
  $ok = curl_exec($ch);
  $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
  curl_close($ch);
  if ($ok === false) return null;
  $json = json_decode($got, true);
  return ['status' => $status, 'json' => is_array($json) ? $json : null];
}

function atlas_ledger_issue_account() {
  $cfg = atlas_ledger_config();
  if (!$cfg['enabled']) atlas_ledger_fail(404, 'disabled', 'Ledger-account issuance is not enabled');
  if ($cfg['problem'] !== null) atlas_ledger_fail(503, 'misconfigured', 'Ledger-account issuance is misconfigured');
  if ($_SERVER['REQUEST_METHOD'] !== 'POST') atlas_ledger_fail(405, 'unknown-operation', 'POST only');
  if (empty($_SERVER['HTTPS']) || $_SERVER['HTTPS'] === 'off') atlas_ledger_fail(403, 'https-required', 'HTTPS required');
  $domain = $cfg['domain'];
  if (strtolower($_SERVER['HTTP_HOST'] ?? '') !== $domain) atlas_ledger_fail(400, 'unknown-host', 'This host does not issue for that domain');
  $network = ATLAS_LEDGER_NETWORK_PREFIX . $domain;
  $operation = 'https://' . $domain . '/atlas/ledger/account-credential';
  $accountsUrl = 'https://' . $domain . '/chain-labs/accounts31.php?action=accounts';

  $retry = atlas_admin_limiter('ledgerIssuance', 'take', $cfg['perClientPerMinute'], 60000);
  if ($retry) { header('Retry-After: ' . (int) $retry); atlas_ledger_fail(429, 'rate-limited', 'Too many requests'); }

  $raw = read_limited_body(ATLAS_LEDGER_MAX_BODY_BYTES);
  $body = json_decode($raw, true);
  if (!atlas_ledger_exact_keys($body, ['payload', 'proof', 'existence'])) atlas_ledger_fail(400, 'malformed-request', 'Expected payload, proof and existence');
  $p = $body['payload']; $proof = $body['proof']; $ex = $body['existence'];
  $intentFields = ['type', 'v', 'audience', 'network', 'coin', 'nonce', 'issuedAt', 'existenceNonce'];
  if (!atlas_ledger_exact_keys($p, $intentFields) || !atlas_ledger_exact_keys($ex, ['payload', 'proof']) || !is_array($ex['proof'])) atlas_ledger_fail(400, 'malformed-request', 'Unexpected fields');
  foreach ($intentFields as $f) { if ($f !== 'v' && !is_string($p[$f])) atlas_ledger_fail(400, 'malformed-request', 'Unexpected field type'); }
  if ($p['type'] !== ATLAS_LEDGER_ISSUE_TYPE || $p['v'] !== 1) atlas_ledger_fail(400, 'malformed-request', 'Wrong request type');
  if ($p['audience'] !== $operation) atlas_ledger_fail(401, 'wrong-audience', 'Audience must be the exact issuance URL');
  if ($p['network'] !== $network) atlas_ledger_fail(400, 'unknown-network', 'Wrong network');
  if (!preg_match('/^[A-Z][A-Z0-9]{1,9}$/D', $p['coin'])) atlas_ledger_fail(400, 'malformed-request', 'Invalid coin');
  if (!preg_match('/^[a-f0-9]{32,64}$/D', $p['nonce']) || !preg_match('/^[a-f0-9]{32,64}$/D', $p['existenceNonce'])) atlas_ledger_fail(400, 'malformed-request', 'Invalid nonce');
  $nowS = time();
  $ts = atlas_ledger_iso_seconds($p['issuedAt']);
  if ($ts === null) atlas_ledger_fail(400, 'malformed-request', 'Invalid timestamp');
  if (abs($nowS - $ts) > ATLAS_LEDGER_WINDOW_S) atlas_ledger_fail(401, 'stale-request', 'Clock outside the two-minute window', ['serverTime' => gmdate('Y-m-d\TH:i:s\Z', $nowS)]);

  // Only a raw P-256 owner proof is accepted: the ledger's own check cannot take a passkey assertion.
  if (!atlas_ledger_exact_keys($proof, ['signerRole', 'publicKey', 'signature']) || $proof['signerRole'] !== 'raw-ecdsa'
      || atlas_ledger_point($proof['publicKey']) === null || atlas_ledger_b64url($proof['signature']) === null) {
    atlas_ledger_fail(401, 'unsupported-proof', 'Only raw P-256 wallet proofs are supported');
  }
  $owner = $proof['publicKey'];
  if (!atlas_ledger_verify_raw($p, $owner, $proof['signature'])) atlas_ledger_fail(401, 'bad-signature', 'Owner signature invalid');

  // The pair travels together: the listing request is the owner's, for this network, and named in the signed intent.
  $lp = $ex['payload']; $lproof = $ex['proof'];
  $listFields = ['type', 'v', 'audience', 'network', 'nonce', 'issuedAt'];
  if (!atlas_ledger_exact_keys($lp, $listFields) || !atlas_ledger_exact_keys($lproof, ['publicKey', 'signature'])) atlas_ledger_fail(400, 'malformed-request', 'Unexpected listing request fields');
  foreach ($listFields as $f) { if ($f !== 'v' && !is_string($lp[$f])) atlas_ledger_fail(400, 'malformed-request', 'Unexpected listing field type'); }
  if ($lp['type'] !== ATLAS_LEDGER_ACCOUNTS_TYPE || $lp['v'] !== 1 || $lp['network'] !== $network) atlas_ledger_fail(400, 'malformed-request', 'Listing request is not for this network');
  if ($lp['audience'] !== $accountsUrl) atlas_ledger_fail(401, 'wrong-audience', 'Listing audience must be the exact ledger URL');
  if ($lp['nonce'] !== $p['existenceNonce'] || $lproof['publicKey'] !== $owner) atlas_ledger_fail(401, 'existence-proof-rejected', 'Listing request is not the one this request names');
  $lts = atlas_ledger_iso_seconds($lp['issuedAt']);
  if ($lts === null || abs($nowS - $lts) > ATLAS_LEDGER_WINDOW_S) atlas_ledger_fail(401, 'stale-request', 'Listing request outside the two-minute window', ['serverTime' => gmdate('Y-m-d\TH:i:s\Z', $nowS)]);
  if (!atlas_ledger_verify_raw($lp, $owner, $lproof['signature'])) atlas_ledger_fail(401, 'bad-signature', 'Listing request signature invalid');

  $key = atlas_ledger_load_signing_key($nowS);
  if ($key === null) atlas_ledger_fail(503, 'issuer-key-unavailable', 'The established issuer key is not available or not valid now');

  $coin = $p['coin'];
  $id = atlas_ledger_account_id($network, $coin, $owner);
  $revoked = atlas_ledger_is_revoked($id);
  if ($revoked === null) atlas_ledger_fail(503, 'revocations-unavailable', 'The revocation list cannot be read right now');
  if ($revoked) atlas_ledger_fail(409, 'account-revoked', 'This account reference has been revoked');

  $admit = atlas_ledger_admit($owner, $p['nonce'], $nowS, $cfg);
  if ($admit === 'replayed') atlas_ledger_fail(409, 'replayed-request', 'Signed request has already been used');
  if ($admit !== 'ok') { header('Retry-After: 60'); atlas_ledger_fail($admit === 'full' ? 503 : 429, $admit === 'full' ? 'busy' : 'rate-limited', 'Issuance is limited right now'); }

  $core = atlas_ledger_ask_core($cfg, ['payload' => $lp, 'proof' => $lproof]);
  if ($core === null || $core['status'] >= 500 || $core['status'] === 429 || $core['json'] === null) atlas_ledger_fail(502, 'ledger-unavailable', 'The ledger could not be asked');
  $answer = $core['json'];
  if ($core['status'] !== 200) {
    $code = is_string($answer['code'] ?? null) ? $answer['code'] : 'unknown';
    if ($core['status'] === 401) atlas_ledger_fail(401, 'existence-proof-rejected', 'The ledger refused the listing proof', ['ledgerCode' => $code]);
    atlas_ledger_fail(502, 'ledger-refused', 'The ledger refused the listing request', ['ledgerCode' => $code]);
  }
  if (($answer['ok'] ?? null) !== true || ($answer['code'] ?? null) !== 'accounts-found' || ($answer['network'] ?? null) !== $network
      || ($answer['ownerKey'] ?? null) !== $owner || !is_array($answer['accounts'] ?? null)) {
    atlas_ledger_fail(502, 'ledger-mismatch', 'The ledger answered for a different network or owner');
  }
  $found = null;
  foreach ($answer['accounts'] as $a) {
    if (is_array($a) && ($a['coin'] ?? null) === $coin) {
      if ($found !== null) atlas_ledger_fail(502, 'ledger-mismatch', 'The ledger listed one coin twice');
      $found = $a;
    }
  }
  if ($found === null) atlas_ledger_fail(404, 'account-not-found', 'The ledger has no account for this owner and coin');
  if (($found['ownerKey'] ?? null) !== $owner || ($found['network'] ?? null) !== $network || ($found['accountId'] ?? null) !== $id) {
    atlas_ledger_fail(502, 'ledger-mismatch', 'The ledger\'s account does not match the derived account ID');
  }

  $issuedAt = gmdate('Y-m-d\TH:i:s\Z', $nowS);
  $credential = [
    'credential' => ATLAS_LEDGER_CREDENTIAL,
    'id' => $id,
    'issuer' => ['domain' => $domain, 'publicKey' => $key['publicKeyB64url']],
    'ledger' => ['network' => $network, 'coin' => $coin],
    'owner' => ['publicKey' => $owner],
    'issuedAt' => $issuedAt,
  ];
  $credential['signature'] = atlas_sign($key['privateKey'], ['id' => $id, 'ledger' => $credential['ledger'], 'owner' => $credential['owner'], 'issuedAt' => $issuedAt]);
  atlas_ledger_record($id, $coin, $nowS);
  send_json(200, ['ok' => true, 'code' => 'credential-issued', 'credential' => $credential]);
}
