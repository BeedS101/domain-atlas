<?php
// Domain Atlas — PHP presence: moderation authorization.
//
// Verifies the signed moderation grants described in
// docs/moderation-authorization.md and decides whether a request may use one.
// This is the PHP port of presence-server/lib-moderation.js; the two follow the
// same rules in the same order. Nothing here moderates anyone: the only
// operation implemented is roster.view (presence/moderation/roster.php).
//
// Trust comes from explicit configuration only (atlas-presence-moderation-
// config.json in this folder, or the file named by PRESENCE_MODERATION_CONFIG):
// for each domain, the issuer public keys to trust and the URL its status
// statement is fetched from. No key or URL is ever taken from a request, a
// manifest or a grant. A request is accepted only when ALL of these hold,
// checked in this order:
//
//   1. moderation is configured and enabled (otherwise 503, fail closed);
//   2. the grant names a configured domain;
//   3. the grant is signed by a key pinned for that domain, names this
//      service as its audience, is unexpired and well formed;
//   4. the operator has not revoked the grant or its moderator locally;
//   5. the request is signed by the grant's ephemeral key (proof of
//      possession), names the same grant, audience and domain, an operation
//      and world the grant allows, and is fresh;
//   6. a current issuer-signed status statement lists the moderator with the
//      operation and world in force NOW (otherwise 503, fail closed);
//   7. the request nonce has not been used with this grant.
//
// State (all in this folder, which .htaccess denies to the web): the config
// file, and atlas-presence-moderation-state.json holding the keys used to
// hash visit ids and derive roster references, spent request nonces, the
// cached status statement per domain, and failed-request counts per source.

function moderation_env_number($name, $default) {
  $v = getenv($name);
  return ($v !== false && is_numeric($v) && (float) $v > 0) ? (float) $v : $default;
}

// How old a statement may get before the next request fetches a new one.
define('MODERATION_STATUS_REFRESH_MS', moderation_env_number('MODERATION_STATUS_REFRESH_S', 15) * 1000);
// The longest statement lifetime this service accepts, whatever the issuer signs.
define('MODERATION_STATUS_MAX_TTL_MS', moderation_env_number('MODERATION_STATUS_MAX_TTL_S', 120) * 1000);
// How far a statement's or grant's issue time may differ from this clock.
define('MODERATION_CLOCK_SKEW_MS', moderation_env_number('MODERATION_CLOCK_SKEW_S', 30) * 1000);
// How far a request's timestamp may differ from this clock.
define('MODERATION_REQUEST_WINDOW_MS', moderation_env_number('MODERATION_REQUEST_WINDOW_S', 60) * 1000);
define('MODERATION_FETCH_TIMEOUT_MS', (int) moderation_env_number('MODERATION_FETCH_TIMEOUT_MS', 3000));
define('MODERATION_STATUS_MAX_BYTES', 256 * 1024);
define('MODERATION_MAX_TRACKED_GRANTS', (int) moderation_env_number('MODERATION_MAX_TRACKED_GRANTS', 5000));
define('MODERATION_MAX_NONCES_PER_GRANT', (int) moderation_env_number('MODERATION_MAX_NONCES_PER_GRANT', 1000));
define('MODERATION_FAIL_MAX', (int) moderation_env_number('MODERATION_FAIL_MAX', 20));
define('MODERATION_FAIL_WINDOW_MS', moderation_env_number('MODERATION_FAIL_WINDOW_MS', 60 * 1000));
define('MODERATION_MAX_FAIL_SOURCES', 2000);
define('MODERATION_MAX_BODY_BYTES', (int) moderation_env_number('MODERATION_MAX_BODY_BYTES', 32 * 1024));
define('MODERATION_REF_ROTATE_MS', 24 * 60 * 60 * 1000);

const MODERATION_GRANT_TYPE = 'atlas.moderation-grant';
const MODERATION_REQUEST_TYPE = 'atlas.moderation-request';
const MODERATION_STATUS_TYPE = 'atlas.moderation-status';
const MODERATION_GRANT_SIGN_CONTEXT = "atlas-moderation-grant/v1\n";
const MODERATION_POP_SIGN_CONTEXT = "atlas-moderation-pop/v1\n";
const MODERATION_STATUS_SIGN_CONTEXT = "atlas-moderation-status/v1\n";
const MODERATION_OPERATIONS = ['roster.view', 'chat.mute', 'session.kick', 'session.timeout'];
const MODERATION_MAX_GRANT_LIFETIME_MS = 600 * 1000;
const MODERATION_MAX_WORLDS = 32;
const MODERATION_GRANT_FIELDS = ['type', 'version', 'grantId', 'domain', 'audience', 'moderatorRef', 'worlds', 'operations', 'issuedAt', 'expiresAt', 'cnf'];
const MODERATION_REQUEST_FIELDS = ['type', 'version', 'grantId', 'audience', 'domain', 'world', 'operation', 'target', 'issuedAt', 'nonce'];
const MODERATION_STATUS_FIELDS = ['type', 'version', 'domain', 'audience', 'issuedAt', 'expiresAt', 'moderators'];
const MODERATION_EDGE_SPACE = '\x{0009}-\x{000d}\x{0020}\x{0085}\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}';

// ---------- small helpers (this bundle shares no code with the issuer's) ----------

function moderation_b64url_encode($bin) {
  return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}
function moderation_b64url_decode($str) {
  if (!is_string($str) || preg_match('/^[A-Za-z0-9_-]*$/', $str) !== 1) return null;
  $pad = strlen($str) % 4;
  if ($pad === 1) return null;
  if ($pad) $str .= str_repeat('=', 4 - $pad);
  $out = base64_decode(strtr($str, '-_', '+/'), true);
  return $out === false ? null : $out;
}
function moderation_is_list($a) {
  if (!is_array($a)) return false;
  $i = 0;
  foreach ($a as $k => $v) { if ($k !== $i) return false; $i++; }
  return true;
}
function moderation_is_object($v) {
  return is_array($v) && ($v === [] || !moderation_is_list($v));
}
function moderation_has_keys($o, $keys) {
  if (!moderation_is_object($o) || count($o) !== count($keys)) return false;
  foreach ($keys as $k) if (!array_key_exists($k, $o)) return false;
  return true;
}
function moderation_fail($status, $code, $message) {
  return ['ok' => false, 'status' => $status, 'code' => $code, 'message' => $message];
}

// Canonical JSON — the same bytes as canonicalize() in the issuer and wallet.
function moderation_json_string($s) {
  $out = '"';
  $len = strlen($s);
  for ($i = 0; $i < $len; $i++) {
    $c = $s[$i];
    $ord = ord($c);
    if ($c === '"') $out .= '\\"';
    elseif ($c === '\\') $out .= '\\\\';
    elseif ($ord === 0x08) $out .= '\\b';
    elseif ($ord === 0x0C) $out .= '\\f';
    elseif ($ord === 0x0A) $out .= '\\n';
    elseif ($ord === 0x0D) $out .= '\\r';
    elseif ($ord === 0x09) $out .= '\\t';
    elseif ($ord < 0x20) $out .= sprintf('\\u%04x', $ord);
    else $out .= $c;
  }
  return $out . '"';
}
function moderation_canonicalize($value) {
  if ($value === null) return 'null';
  if (is_bool($value)) return $value ? 'true' : 'false';
  if (is_int($value)) return (string) $value;
  if (is_float($value)) return ($value == floor($value) && abs($value) < 1e15) ? (string) (int) $value : json_encode($value);
  if (is_string($value)) return moderation_json_string($value);
  if (is_array($value)) {
    if (moderation_is_list($value)) return '[' . implode(',', array_map('moderation_canonicalize', $value)) . ']';
    $keys = array_map('strval', array_keys($value));
    sort($keys, SORT_STRING);
    $parts = [];
    foreach ($keys as $k) $parts[] = moderation_json_string($k) . ':' . moderation_canonicalize($value[$k]);
    return '{' . implode(',', $parts) . '}';
  }
  throw new Exception('canonicalize: unsupported value type');
}

// A world id: 1 to 120 code points, valid UTF-8, no control characters or
// line separators, no leading or trailing white space. Same rule as the issuers.
function moderation_valid_world_id($w) {
  if (!is_string($w) || strlen($w) > 480 || preg_match('//u', $w) !== 1) return false;
  $n = preg_match_all('/./su', $w);
  if ($n < 1 || $n > 120) return false;
  if (preg_match('/[\x00-\x1f\x7f\x{2028}\x{2029}]/u', $w) === 1) return false;
  if (preg_match('/^[' . MODERATION_EDGE_SPACE . ']|[' . MODERATION_EDGE_SPACE . ']$/u', $w) === 1) return false;
  return true;
}

// 'YYYY-MM-DDTHH:MM:SS.mmmZ' as milliseconds since the epoch, or null.
function moderation_strict_iso($s) {
  if (!is_string($s) || preg_match('/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/', $s, $m) !== 1) return null;
  $sec = gmmktime((int) $m[4], (int) $m[5], (int) $m[6], (int) $m[2], (int) $m[3], (int) $m[1]);
  if ($sec === false || gmdate('Y-m-d\TH:i:s', $sec) !== substr($s, 0, 19)) return null;
  return $sec * 1000 + (int) $m[7];
}
function moderation_iso($ms) {
  $ms = (int) $ms;
  return gmdate('Y-m-d\TH:i:s', intdiv($ms, 1000)) . sprintf('.%03dZ', $ms % 1000);
}
function moderation_now_ms() { return (int) floor(microtime(true) * 1000); }

// ---------- P-256 keys and ECDSA (raw formats, as Web Crypto produces them) ----------

// The PEM for a raw 65-byte key spelled in canonical base64url, or null when
// the text is not a valid key (wrong shape, non-canonical, or off the curve).
function moderation_key_pem($b64) {
  static $cache = [];
  if (!is_string($b64)) return null;
  if (array_key_exists($b64, $cache)) return $cache[$b64];
  $pem = null;
  if (preg_match('/^[A-Za-z0-9_-]{87}$/', $b64) === 1) {
    $raw = moderation_b64url_decode($b64);
    if ($raw !== null && strlen($raw) === 65 && ord($raw[0]) === 4 && moderation_b64url_encode($raw) === $b64) {
      $der = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200') . $raw;
      $candidate = "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
      if (openssl_pkey_get_public($candidate) !== false) $pem = $candidate;
    }
  }
  if (count($cache) > 2000) $cache = [];
  $cache[$b64] = $pem;
  return $pem;
}
function moderation_der_int($bytes32) {
  $i = 0;
  while ($i < 31 && ord($bytes32[$i]) === 0) $i++;
  $trimmed = substr($bytes32, $i);
  if (ord($trimmed[0]) & 0x80) $trimmed = "\x00" . $trimmed;
  return "\x02" . chr(strlen($trimmed)) . $trimmed;
}
function moderation_verify_sig($publicKeyB64, $signatureB64, $context, $payload) {
  $pem = moderation_key_pem($publicKeyB64);
  if ($pem === null || !is_string($signatureB64) || preg_match('/^[A-Za-z0-9_-]{86}$/', $signatureB64) !== 1) return false;
  $sig = moderation_b64url_decode($signatureB64);
  if ($sig === null || strlen($sig) !== 64) return false;
  $body = moderation_der_int(substr($sig, 0, 32)) . moderation_der_int(substr($sig, 32, 32));
  $der = "\x30" . chr(strlen($body)) . $body;
  return openssl_verify($context . moderation_canonicalize($payload), $der, $pem, OPENSSL_ALGO_SHA256) === 1;
}

// ---------- configuration ----------
//
//   { "enabled": true,
//     "audience": "https://presence.example.com",
//     "domains": { "example.com": { "issuerKeys": ["<raw P-256 key>", ...],
//                                   "statusUrl": "https://example.com/atlas/moderation/status" } },
//     "revokedModerators": ["<moderatorRef>"], "revokedGrants": ["<grantId>"] }
//
// Read on every request, so an edit (a key removed, a moderator revoked)
// applies to the next one. A file that cannot be parsed disables moderation.

function moderation_config_file() {
  $e = getenv('PRESENCE_MODERATION_CONFIG');
  return ($e !== false && $e !== '') ? $e : __DIR__ . '/atlas-presence-moderation-config.json';
}
function moderation_state_file() {
  return __DIR__ . '/atlas-presence-moderation-state.json';
}
function moderation_is_presence_origin($s) {
  return is_string($s) && strlen($s) <= 255 && preg_match('#^https?://(\[[0-9a-f:]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)(:\d{1,5})?$#', $s) === 1;
}
function moderation_status_url_ok($u) {
  if (!is_string($u) || strlen($u) > 500) return false;
  $p = parse_url($u);
  if ($p === false || !isset($p['scheme'], $p['host']) || isset($p['user']) || isset($p['pass']) || isset($p['fragment'])) return false;
  if ($p['scheme'] === 'https') return true;
  return $p['scheme'] === 'http' && in_array(strtolower($p['host']), ['localhost', '127.0.0.1', '[::1]', '::1'], true);
}
function moderation_load_config() {
  $path = moderation_config_file();
  if (!is_file($path)) return ['state' => 'missing'];
  $raw = json_decode((string) file_get_contents($path), true);
  if (!moderation_is_object($raw)) return ['state' => 'invalid'];
  if (array_key_exists('enabled', $raw) && !is_bool($raw['enabled'])) return ['state' => 'invalid'];
  if (array_key_exists('enabled', $raw) && $raw['enabled'] === false) return ['state' => 'disabled'];
  if (!isset($raw['audience']) || !moderation_is_presence_origin($raw['audience']) || !isset($raw['domains']) || !moderation_is_object($raw['domains'])) return ['state' => 'invalid'];
  $list = function ($key) use ($raw) {
    if (!array_key_exists($key, $raw)) return [];
    if (!moderation_is_list($raw[$key]) && $raw[$key] !== []) return null;
    foreach ($raw[$key] as $x) if (!is_string($x) || strlen($x) > 200) return null;
    return $raw[$key];
  };
  $revokedModerators = $list('revokedModerators');
  $revokedGrants = $list('revokedGrants');
  if ($revokedModerators === null || $revokedGrants === null) return ['state' => 'invalid'];
  $domains = [];
  foreach ($raw['domains'] as $name => $d) {
    if (!moderation_is_object($d) || !isset($d['issuerKeys']) || !moderation_is_list($d['issuerKeys']) || !count($d['issuerKeys']) || count($d['issuerKeys']) > 8) continue;
    $okKeys = true;
    foreach ($d['issuerKeys'] as $k) if (!is_string($k) || preg_match('/^[A-Za-z0-9_-]{87}$/', $k) !== 1) $okKeys = false;
    if (!$okKeys || !isset($d['statusUrl']) || !moderation_status_url_ok($d['statusUrl'])) continue;
    $domains[(string) $name] = ['issuerKeys' => array_values($d['issuerKeys']), 'statusUrl' => $d['statusUrl']];
  }
  return ['state' => 'ok', 'audience' => $raw['audience'], 'domains' => $domains, 'revokedModerators' => $revokedModerators, 'revokedGrants' => $revokedGrants];
}

// ---------- state file ----------

// Runs $fn(&$doc) with the state file locked, creating the keys it needs.
// Whatever $fn leaves in $doc is written back.
function moderation_state_locked($fn) {
  $fh = fopen(moderation_state_file(), 'c+');
  if ($fh === false) throw new Exception('could not open the moderation state file');
  flock($fh, LOCK_EX);
  $doc = json_decode((string) stream_get_contents($fh), true);
  if (!is_array($doc)) $doc = [];
  $now = moderation_now_ms();
  if (!isset($doc['visitKey']) || !is_string($doc['visitKey'])) $doc['visitKey'] = bin2hex(random_bytes(32));
  if (!isset($doc['refKey']) || !is_string($doc['refKey']) || !isset($doc['refKeyAt']) || ($now - $doc['refKeyAt']) > MODERATION_REF_ROTATE_MS) {
    $doc['refKey'] = bin2hex(random_bytes(32));
    $doc['refKeyAt'] = $now;
    $doc['fails'] = [];
  }
  foreach (['nonces', 'status', 'fails'] as $k) if (!isset($doc[$k]) || !is_array($doc[$k])) $doc[$k] = [];
  $result = $fn($doc);
  ftruncate($fh, 0);
  rewind($fh);
  fwrite($fh, json_encode($doc, JSON_UNESCAPED_SLASHES));
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return $result;
}

// ---------- per-visit association and temporary references ----------
//
// A wallet sends one random visit id per world visit, privately, to both the
// presence join and the chat join. Only a keyed hash of it is stored, scoped to
// the domain and world, so a roster can show the two sessions as one visitor
// without any stored identifier that could be matched to a wallet, a network
// address or another visit. Old clients send none, which costs nothing here.

function moderation_visit_hash($domain, $world, $raw) {
  static $key = null;
  if (!is_string($raw) || preg_match('/^[A-Za-z0-9_-]{16,64}$/', $raw) !== 1) return null;
  if ($key === null) $key = moderation_state_locked(function (&$doc) { return $doc['visitKey']; });
  return substr(hash_hmac('sha256', "visit/v1\n" . $domain . "\n" . $world . "\n" . $raw, hex2bin($key)), 0, 32);
}
// A temporary locator for one roster entry. It is derived from a secret kept
// here (rotated daily), authorizes nothing, and means nothing outside this
// domain and world.
function moderation_participant_ref($refKey, $domain, $world, $groupKey) {
  return substr(moderation_b64url_encode(hash_hmac('sha256', "ref/v1\n" . $domain . "\n" . $world . "\n" . $groupKey, hex2bin($refKey), true)), 0, 22);
}

// ---------- grant and request verification ----------

function moderation_verify_grant($grant, $issuerKeys, $audience, $domain, $now) {
  $payload = isset($grant['payload']) ? $grant['payload'] : null;
  $proof = isset($grant['proof']) ? $grant['proof'] : null;
  if (!moderation_is_object($payload) || !moderation_is_object($proof)) return moderation_fail(400, 'bad-request', 'grant must be {payload, proof}');
  if (($proof['signerRole'] ?? null) !== 'raw-ecdsa') return moderation_fail(400, 'bad-request', 'proof.signerRole must be raw-ecdsa');
  if (!isset($proof['publicKey']) || !is_string($proof['publicKey']) || !in_array($proof['publicKey'], $issuerKeys, true)) return moderation_fail(401, 'untrusted-issuer', 'the grant is not signed by a key trusted for this domain');
  if (!moderation_verify_sig($proof['publicKey'], $proof['signature'] ?? null, MODERATION_GRANT_SIGN_CONTEXT, $payload)) return moderation_fail(401, 'bad-signature', 'the grant signature does not verify');
  if (!moderation_has_keys($payload, MODERATION_GRANT_FIELDS)) return moderation_fail(400, 'bad-request', 'the grant has missing or unknown fields');
  if ($payload['type'] !== MODERATION_GRANT_TYPE || $payload['version'] !== 1) return moderation_fail(400, 'bad-request', 'unsupported grant type or version');
  if (!is_string($payload['grantId']) || preg_match('/^[A-Za-z0-9_-]{22}$/', $payload['grantId']) !== 1) return moderation_fail(400, 'bad-request', 'grantId');
  if (!is_string($payload['moderatorRef']) || preg_match('/^[A-Za-z0-9_-]{43}$/', $payload['moderatorRef']) !== 1) return moderation_fail(400, 'bad-request', 'moderatorRef');
  if ($payload['domain'] !== $domain) return moderation_fail(403, 'wrong-domain', 'the grant is for another domain');
  if ($payload['audience'] !== $audience) return moderation_fail(403, 'wrong-audience', 'the grant is for another presence service');
  $issuedAt = moderation_strict_iso($payload['issuedAt']);
  $expiresAt = moderation_strict_iso($payload['expiresAt']);
  if ($issuedAt === null || $expiresAt === null) return moderation_fail(400, 'bad-request', 'issuedAt/expiresAt');
  if ($expiresAt <= $issuedAt || $expiresAt - $issuedAt > MODERATION_MAX_GRANT_LIFETIME_MS) return moderation_fail(400, 'bad-request', 'the grant lifetime is out of range');
  if ($now >= $expiresAt) return moderation_fail(401, 'expired', 'the grant has expired');
  if ($issuedAt > $now + MODERATION_CLOCK_SKEW_MS) return moderation_fail(401, 'not-yet-valid', 'the grant is issued in the future');
  if ($payload['worlds'] !== '*') {
    $w = $payload['worlds'];
    if (!moderation_is_list($w) || count($w) < 1 || count($w) > MODERATION_MAX_WORLDS || count(array_unique($w)) !== count($w)) return moderation_fail(400, 'bad-request', 'worlds');
    foreach ($w as $x) if (!moderation_valid_world_id($x)) return moderation_fail(400, 'bad-request', 'worlds');
  }
  $ops = $payload['operations'];
  if (!moderation_is_list($ops) || count($ops) < 1 || count($ops) > count(MODERATION_OPERATIONS) || count(array_unique($ops)) !== count($ops)) return moderation_fail(400, 'bad-request', 'operations');
  foreach ($ops as $o) if (!is_string($o) || !in_array($o, MODERATION_OPERATIONS, true)) return moderation_fail(400, 'bad-request', 'operations');
  $cnf = $payload['cnf'];
  if (!moderation_has_keys($cnf, ['alg', 'publicKey']) || $cnf['alg'] !== 'ES256' || moderation_key_pem($cnf['publicKey']) === null) return moderation_fail(400, 'bad-request', 'cnf');
  return ['ok' => true, 'payload' => $payload, 'expiresAt' => $expiresAt];
}

function moderation_verify_request($grantPayload, $envelope, $operation, $now) {
  if (!moderation_is_object($envelope) || !isset($envelope['payload']) || !moderation_is_object($envelope['payload'])) return moderation_fail(400, 'bad-request', 'request must be {payload, signature}');
  $r = $envelope['payload'];
  if (!moderation_has_keys($r, MODERATION_REQUEST_FIELDS)) return moderation_fail(400, 'bad-request', 'the request has missing or unknown fields');
  if ($r['type'] !== MODERATION_REQUEST_TYPE || $r['version'] !== 1) return moderation_fail(400, 'bad-request', 'unsupported request type or version');
  if ($r['grantId'] !== $grantPayload['grantId']) return moderation_fail(401, 'wrong-grant', 'the request names another grant');
  if ($r['audience'] !== $grantPayload['audience'] || $r['domain'] !== $grantPayload['domain']) return moderation_fail(403, 'wrong-audience', 'the request is bound to another audience or domain');
  if ($r['operation'] !== $operation || !in_array($operation, $grantPayload['operations'], true)) return moderation_fail(403, 'operation-denied', 'the operation is not granted');
  if (!moderation_valid_world_id($r['world'])) return moderation_fail(400, 'bad-request', 'world');
  if ($grantPayload['worlds'] !== '*' && !in_array($r['world'], $grantPayload['worlds'], true)) return moderation_fail(403, 'world-denied', 'the world is not granted');
  if (!is_string($r['target']) || strlen($r['target']) > 256) return moderation_fail(400, 'bad-request', 'target');
  $at = moderation_strict_iso($r['issuedAt']);
  if ($at === null || abs($now - $at) > MODERATION_REQUEST_WINDOW_MS) return moderation_fail(401, 'stale-request', 'the request timestamp is outside the allowed window');
  if (!is_string($r['nonce']) || preg_match('/^[A-Za-z0-9_-]{16,128}$/', $r['nonce']) !== 1) return moderation_fail(400, 'bad-request', 'nonce');
  if (!moderation_verify_sig($grantPayload['cnf']['publicKey'], $envelope['signature'] ?? null, MODERATION_POP_SIGN_CONTEXT, $r)) return moderation_fail(401, 'bad-pop', 'proof of possession does not verify');
  return ['ok' => true, 'request' => $r];
}

// ---------- issuer status statements ----------

// Returns the verified statement in the form it is cached in, or null.
function moderation_verify_status($env, $issuerKeys, $audience, $domain, $sentAt, $receivedAt) {
  if (!moderation_is_object($env) || !isset($env['payload'], $env['proof']) || !moderation_is_object($env['payload']) || !moderation_is_object($env['proof'])) return null;
  $payload = $env['payload'];
  $proof = $env['proof'];
  if (($proof['signerRole'] ?? null) !== 'raw-ecdsa' || !isset($proof['publicKey']) || !is_string($proof['publicKey']) || !in_array($proof['publicKey'], $issuerKeys, true)) return null;
  if (!moderation_verify_sig($proof['publicKey'], $proof['signature'] ?? null, MODERATION_STATUS_SIGN_CONTEXT, $payload)) return null;
  if (!moderation_has_keys($payload, MODERATION_STATUS_FIELDS) || $payload['type'] !== MODERATION_STATUS_TYPE || $payload['version'] !== 1) return null;
  if ($payload['domain'] !== $domain || $payload['audience'] !== $audience) return null;
  $issuedAt = moderation_strict_iso($payload['issuedAt']);
  $expiresAt = moderation_strict_iso($payload['expiresAt']);
  if ($issuedAt === null || $expiresAt === null) return null;
  $ttl = $expiresAt - $issuedAt;
  if ($ttl <= 0 || $ttl > MODERATION_STATUS_MAX_TTL_MS) return null;
  // A statement older than the allowance when it arrives is a replay.
  if ($issuedAt < $sentAt - MODERATION_CLOCK_SKEW_MS || $issuedAt > $receivedAt + MODERATION_CLOCK_SKEW_MS) return null;
  $list = $payload['moderators'];
  if (!is_array($list) || ($list !== [] && !moderation_is_list($list)) || count($list) > 2000) return null;
  $moderators = [];
  foreach ($list as $m) {
    if (!moderation_has_keys($m, ['moderatorRef', 'worlds', 'operations'])) return null;
    $ref = $m['moderatorRef'];
    if (!is_string($ref) || preg_match('/^[A-Za-z0-9_-]{43}$/', $ref) !== 1 || isset($moderators[$ref])) return null;
    if ($m['worlds'] !== '*') {
      if (!is_array($m['worlds']) || ($m['worlds'] !== [] && !moderation_is_list($m['worlds'])) || count($m['worlds']) > 256) return null;
      foreach ($m['worlds'] as $w) if (!moderation_valid_world_id($w)) return null;
    }
    if (!is_array($m['operations']) || ($m['operations'] !== [] && !moderation_is_list($m['operations'])) || count($m['operations']) > count(MODERATION_OPERATIONS)) return null;
    foreach ($m['operations'] as $o) if (!is_string($o) || !in_array($o, MODERATION_OPERATIONS, true)) return null;
    $moderators[$ref] = ['worlds' => $m['worlds'], 'operations' => $m['operations']];
  }
  // Usable for its signed lifetime, counted from when this service ASKED, so
  // the issuer's clock cannot stretch it.
  $usableUntil = min($expiresAt, $sentAt + $ttl);
  if ($receivedAt >= $usableUntil) return null;
  return ['signerKey' => $proof['publicKey'], 'issuedAt' => $issuedAt, 'sentAt' => $sentAt, 'usableUntil' => $usableUntil, 'moderators' => $moderators, 'statusUrl' => null, 'audience' => $audience];
}

// A plain HTTP GET: no redirects, a time limit, a size cap. Returns the body of
// a 200 response, or null.
function moderation_http_get($url) {
  if (function_exists('curl_init')) {
    $body = '';
    $tooLarge = false;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
      CURLOPT_RETURNTRANSFER => false,
      CURLOPT_FOLLOWLOCATION => false,
      CURLOPT_CONNECTTIMEOUT_MS => MODERATION_FETCH_TIMEOUT_MS,
      CURLOPT_TIMEOUT_MS => MODERATION_FETCH_TIMEOUT_MS,
      CURLOPT_HTTPHEADER => ['Accept: application/json'],
      CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
      CURLOPT_WRITEFUNCTION => function ($c, $chunk) use (&$body, &$tooLarge) {
        $body .= $chunk;
        if (strlen($body) > MODERATION_STATUS_MAX_BYTES) { $tooLarge = true; return -1; }
        return strlen($chunk);
      },
    ]);
    $ok = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return ($ok !== false && !$tooLarge && $code === 200) ? $body : null;
  }
  $ctx = stream_context_create(['http' => ['method' => 'GET', 'timeout' => MODERATION_FETCH_TIMEOUT_MS / 1000, 'follow_location' => 0, 'ignore_errors' => true, 'header' => "Accept: application/json\r\n"]]);
  $body = @file_get_contents($url, false, $ctx, 0, MODERATION_STATUS_MAX_BYTES + 1);
  if ($body === false || strlen($body) > MODERATION_STATUS_MAX_BYTES) return null;
  $line = isset($http_response_header[0]) ? $http_response_header[0] : '';
  return preg_match('#^HTTP/\S+ 200\b#', $line) === 1 ? $body : null;
}

function moderation_fetch_status($domain, $dom, $audience) {
  $url = $dom['statusUrl'] . (strpos($dom['statusUrl'], '?') === false ? '?' : '&') . 'audience=' . rawurlencode($audience);
  $sentAt = moderation_now_ms();
  $text = moderation_http_get($url);
  if ($text === null) return null;
  $receivedAt = moderation_now_ms();
  $env = json_decode($text, true);
  $verified = moderation_verify_status($env, $dom['issuerKeys'], $audience, $domain, $sentAt, $receivedAt);
  if ($verified === null) return null;
  $verified['statusUrl'] = $dom['statusUrl'];
  return $verified;
}
function moderation_statement_usable($e, $dom, $audience, $now) {
  return is_array($e) && isset($e['usableUntil'], $e['signerKey'], $e['statusUrl'], $e['audience'])
    && $now < $e['usableUntil'] && in_array($e['signerKey'], $dom['issuerKeys'], true) && $e['statusUrl'] === $dom['statusUrl'] && $e['audience'] === $audience;
}
// The statement to use for this request, or null when no current one exists
// (the caller must then refuse). A new statement is fetched whenever the
// cached one is older than MODERATION_STATUS_REFRESH_MS. If the fetch fails the
// cached one is used only until its own expiry, never beyond.
function moderation_current_status($domain, $dom, $audience) {
  $cached = moderation_state_locked(function (&$doc) use ($domain) { return isset($doc['status'][$domain]) ? $doc['status'][$domain] : null; });
  $now = moderation_now_ms();
  if (moderation_statement_usable($cached, $dom, $audience, $now) && $now - $cached['sentAt'] < MODERATION_STATUS_REFRESH_MS) return $cached;
  $fresh = moderation_fetch_status($domain, $dom, $audience);
  if ($fresh !== null) {
    moderation_state_locked(function (&$doc) use ($domain, $fresh) {
      if (!isset($doc['status'][$domain]) || !isset($doc['status'][$domain]['sentAt']) || $doc['status'][$domain]['sentAt'] <= $fresh['sentAt']) $doc['status'][$domain] = $fresh;
    });
    return $fresh;
  }
  return moderation_statement_usable($cached, $dom, $audience, moderation_now_ms()) ? $cached : null;
}

// ---------- replay protection and the failed-request throttle ----------

// Records (grantId, nonce) as used. Returns 'ok', 'replay' or 'busy'. Entries
// live until the grant has expired and every request it could still verify has
// fallen out of the request window.
function moderation_spend_nonce($grantId, $nonce, $grantExpiresAt, $now) {
  return moderation_state_locked(function (&$doc) use ($grantId, $nonce, $grantExpiresAt, $now) {
    foreach (array_keys($doc['nonces']) as $id) if (!isset($doc['nonces'][$id]['until']) || $doc['nonces'][$id]['until'] <= $now) unset($doc['nonces'][$id]);
    if (!isset($doc['nonces'][$grantId])) {
      if (count($doc['nonces']) >= MODERATION_MAX_TRACKED_GRANTS) return 'busy';
      $doc['nonces'][$grantId] = ['until' => $grantExpiresAt + MODERATION_REQUEST_WINDOW_MS, 'n' => []];
    }
    if (in_array($nonce, $doc['nonces'][$grantId]['n'], true)) return 'replay';
    if (count($doc['nonces'][$grantId]['n']) >= MODERATION_MAX_NONCES_PER_GRANT) return 'busy';
    $doc['nonces'][$grantId]['n'][] = $nonce;
    return 'ok';
  });
}
function moderation_source_key($doc, $addr) {
  return substr(hash_hmac('sha256', presence_source_key_material($addr), hex2bin($doc['refKey'])), 0, 16);
}
// Seconds until this source may send another moderation request, or 0.
function moderation_failure_retry_after($addr) {
  return moderation_state_locked(function (&$doc) use ($addr) {
    $now = moderation_now_ms();
    $k = moderation_source_key($doc, $addr);
    $kept = array_values(array_filter(isset($doc['fails'][$k]) ? $doc['fails'][$k] : [], function ($t) use ($now) { return $now - $t < MODERATION_FAIL_WINDOW_MS; }));
    if ($kept) $doc['fails'][$k] = $kept; else unset($doc['fails'][$k]);
    if (count($kept) < MODERATION_FAIL_MAX) return 0;
    return max(1, (int) ceil(($kept[0] + MODERATION_FAIL_WINDOW_MS - $now) / 1000));
  });
}
function moderation_note_failure($addr) {
  moderation_state_locked(function (&$doc) use ($addr) {
    $now = moderation_now_ms();
    $k = moderation_source_key($doc, $addr);
    foreach (array_keys($doc['fails']) as $o) {
      $kept = array_values(array_filter($doc['fails'][$o], function ($t) use ($now) { return $now - $t < MODERATION_FAIL_WINDOW_MS; }));
      if ($kept) $doc['fails'][$o] = $kept; else unset($doc['fails'][$o]);
    }
    $doc['fails'][$k] = array_merge(isset($doc['fails'][$k]) ? $doc['fails'][$k] : [], [$now]);
    while (count($doc['fails']) > MODERATION_MAX_FAIL_SOURCES) { reset($doc['fails']); unset($doc['fails'][key($doc['fails'])]); }
  });
}

// ---------- the entry point ----------

// $body: {grant, request}. Returns ['ok'=>true, 'domain','world','grantId',
// 'moderatorRef'] or ['ok'=>false, 'status','code','message'].
function moderation_authorize($body, $operation) {
  $now = moderation_now_ms();
  $cfg = moderation_load_config();
  if ($cfg['state'] !== 'ok') return moderation_fail(503, 'moderation-not-configured', 'moderation is not enabled on this presence service');
  if (!moderation_has_keys($body, ['grant', 'request']) || !moderation_is_object($body['grant']) || !moderation_is_object($body['request'])) return moderation_fail(400, 'bad-request', 'body must be {grant, request}');
  $claimed = isset($body['grant']['payload']) ? $body['grant']['payload'] : null;
  if (!moderation_is_object($claimed) || !isset($claimed['domain']) || !is_string($claimed['domain'])) return moderation_fail(400, 'bad-request', 'the grant has no domain');
  if (!array_key_exists($claimed['domain'], $cfg['domains'])) return moderation_fail(403, 'domain-not-configured', 'this presence service does not accept moderation for that domain');
  $dom = $cfg['domains'][$claimed['domain']];

  $g = moderation_verify_grant($body['grant'], $dom['issuerKeys'], $cfg['audience'], $claimed['domain'], $now);
  if (!$g['ok']) return $g;
  if (in_array($g['payload']['grantId'], $cfg['revokedGrants'], true) || in_array($g['payload']['moderatorRef'], $cfg['revokedModerators'], true)) return moderation_fail(403, 'revoked', 'this grant or moderator has been revoked here');

  $r = moderation_verify_request($g['payload'], $body['request'], $operation, $now);
  if (!$r['ok']) return $r;
  if ($r['request']['target'] !== '') return moderation_fail(400, 'bad-request', 'target must be empty for ' . $operation);

  $status = moderation_current_status($claimed['domain'], $dom, $cfg['audience']);
  if ($status === null) return moderation_fail(503, 'authorization-unavailable', 'the issuer\'s current authorization status could not be established');
  if (!isset($status['moderators'][$g['payload']['moderatorRef']])) return moderation_fail(403, 'moderator-inactive', 'the issuer does not list this moderator as active');
  $entry = $status['moderators'][$g['payload']['moderatorRef']];
  if (!in_array($operation, $entry['operations'], true)) return moderation_fail(403, 'operation-denied', 'the operation is not currently permitted');
  if ($entry['worlds'] !== '*' && !in_array($r['request']['world'], $entry['worlds'], true)) return moderation_fail(403, 'world-denied', 'the world is not currently permitted');

  $spent = moderation_spend_nonce($g['payload']['grantId'], $r['request']['nonce'], $g['expiresAt'], $now);
  if ($spent === 'replay') return moderation_fail(401, 'replay', 'this request has already been used');
  if ($spent === 'busy') return moderation_fail(429, 'rate-limited', 'too many requests for this grant');
  return ['ok' => true, 'domain' => $claimed['domain'], 'world' => $r['request']['world'], 'grantId' => $g['payload']['grantId'], 'moderatorRef' => $g['payload']['moderatorRef']];
}

// ---------- the anonymous roster ----------

// The anonymous sessions of one world. Presence and chat sessions of the same
// visit (same keyed visit hash) appear as one entry. Each entry carries only: a
// temporary locator (`ref`), the display name(s), the world, when the visit
// began, whether it is in presence and/or chat, and the public avatar and chat
// sender ids every participant already sees. Never wallet keys, credentials,
// network addresses or hashes of them, connection tokens, or the visit id.
function moderation_build_roster($domain, $world) {
  $now = moderation_now_ms();
  $presence = with_presence_store_locked(function (&$doc) use ($domain, $world) {
    $key = presence_room_key($domain, $world);
    return isset($doc['rooms'][$key]) ? $doc['rooms'][$key] : [];
  });
  $chat = with_chat_store_locked(function (&$doc) use ($domain) {
    return isset($doc['domains'][$domain]['members']) ? $doc['domains'][$domain]['members'] : [];
  });
  $refKey = moderation_state_locked(function (&$doc) { return $doc['refKey']; });
  $groups = [];
  $slot = function ($key, $kind) use (&$groups) {
    $k = $key;
    for ($n = 2; isset($groups[$k]) && $groups[$k][$kind] !== null; $n++) $k = $key . '#' . $n; // one presence and one chat per visit
    if (!isset($groups[$k])) $groups[$k] = ['key' => $k, 'presence' => null, 'chat' => null];
    return $k;
  };
  foreach ($presence as $token => $m) {
    if (!is_array($m)) continue;
    $k = $slot(!empty($m['visit']) ? 'v:' . $m['visit'] : 'p:' . $token, 'presence');
    $groups[$k]['presence'] = $m;
  }
  foreach ($chat as $token => $m) {
    if (!is_array($m) || !isset($m['world']) || $m['world'] !== $world) continue;
    $k = $slot(!empty($m['visit']) ? 'v:' . $m['visit'] : 'c:' . $token, 'chat');
    $groups[$k]['chat'] = $m;
  }
  $participants = [];
  foreach ($groups as $g) {
    $times = [];
    if ($g['presence'] !== null) $times[] = isset($g['presence']['joinedAt']) ? $g['presence']['joinedAt'] : (isset($g['presence']['lastSeen']) ? $g['presence']['lastSeen'] : $now);
    if ($g['chat'] !== null) $times[] = isset($g['chat']['joinedAt']) ? $g['chat']['joinedAt'] : (isset($g['chat']['lastSeen']) ? $g['chat']['lastSeen'] : $now);
    $joined = (int) min($times);
    $entry = [
      'ref' => moderation_participant_ref($refKey, $domain, $world, $g['key']),
      'name' => $g['presence'] !== null ? $g['presence']['name'] : $g['chat']['name'],
      'world' => $world,
      'joinedAt' => moderation_iso($joined),
      'ageSeconds' => max(0, (int) floor(($now - $joined) / 1000)),
      'presence' => ['joined' => $g['presence'] !== null, 'avatarId' => $g['presence'] !== null ? $g['presence']['publicId'] : null],
      'chat' => ['joined' => $g['chat'] !== null, 'senderId' => $g['chat'] !== null ? $g['chat']['senderId'] : null],
      'linked' => $g['presence'] !== null && $g['chat'] !== null,
    ];
    if ($g['presence'] !== null && $g['chat'] !== null && $g['chat']['name'] !== $g['presence']['name']) $entry['chatName'] = $g['chat']['name'];
    $participants[] = $entry;
  }
  usort($participants, function ($a, $b) { return $a['joinedAt'] === $b['joinedAt'] ? strcmp($a['ref'], $b['ref']) : strcmp($a['joinedAt'], $b['joinedAt']); });
  return ['domain' => $domain, 'world' => $world, 'generatedAt' => moderation_iso($now), 'count' => count($participants), 'participants' => $participants];
}
