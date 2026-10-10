<?php
// GET /atlas/moderation/status?audience=<presence origin> — mirrors
// issuer-server/server.js's same route. Ungated. Returns an issuer-signed
// statement of who holds moderation authority right now, addressed to one
// configured presence service and valid for ATLAS_MODERATION_STATUS_TTL_S
// seconds. A presence service refuses to act on a grant unless it holds a
// current statement that lists the grant's moderator, so removing a key from
// the roster ends its authority within that lifetime. The statement holds
// only pseudonymous moderator references and their scopes. Rate limited per
// client address. Format: docs/moderation-authorization.md.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_get();
$kp = atlas_load_keys();

$retryAfter = atlas_moderation_take_status_slot();
if ($retryAfter) {
  header('Retry-After: ' . $retryAfter);
  send_json(429, ['error' => 'too many status requests; try again later', 'code' => 'rate-limited', 'retryAfter' => $retryAfter]);
}
$config = atlas_moderation_config();
if (!$config['audiences'] || !$config['domain']) {
  send_json(503, ['error' => 'no presence endpoint is configured to receive moderation grants', 'code' => 'moderation-not-configured']);
}
$audience = isset($_GET['audience']) && is_string($_GET['audience']) ? $_GET['audience'] : '';
if ($audience === '' || !in_array($audience, $config['audiences'], true)) {
  send_json(403, ['error' => 'this presence endpoint is not configured for this domain', 'code' => 'audience-not-trusted']);
}

$nowMs = atlas_now_ms();
$ttlMs = atlas_moderation_status_ttl_s() * 1000;
$iso = function ($ms) { return gmdate('Y-m-d\TH:i:s', intdiv($ms, 1000)) . sprintf('.%03dZ', $ms % 1000); };
$payload = [
  'type' => ATLAS_MODERATION_STATUS_TYPE,
  'version' => ATLAS_MODERATION_STATUS_VERSION,
  'domain' => $config['domain'],
  'audience' => $audience,
  'issuedAt' => $iso($nowMs),
  'expiresAt' => $iso($nowMs + $ttlMs),
  'moderators' => atlas_moderation_status_moderators($config['domain']),
];
$signature = b64url_encode(ecdsa_sign_raw($kp['privateKey'], ATLAS_MODERATION_STATUS_SIGN_CONTEXT . canonicalize($payload)));
header('Cache-Control: no-store');
send_json(200, ['payload' => $payload, 'proof' => ['signerRole' => 'raw-ecdsa', 'publicKey' => $kp['publicKeyB64url'], 'signature' => $signature]]);
