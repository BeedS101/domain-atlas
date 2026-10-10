<?php
// POST /atlas/admin/moderation/grant — mirrors issuer-server/server.js's same
// route. {payload, proof}, signed fresh for this request (payload.adminAuth).
// Issues a short-lived, domain-signed moderation grant to the signing key:
// administrators and moderators may ask (scope 'moderation'); no other route
// accepts a moderator. A session token is not accepted, even next to a proof. The key's CURRENT roster authority bounds the worlds and
// operations, the audience must be a configured presence endpoint, and the
// grant is bound to the requester's ephemeral proof-of-possession key.
// Format and verification: docs/moderation-authorization.md.
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

$requestBody = read_admin_json_body();
$payload = $requestBody['payload'] ?? null;
$proof = $requestBody['proof'] ?? null;
if (!is_array($proof)) {
  admin_auth_fail(admin_failure(401, 'signature-required', 'a moderation grant needs a fresh signed request; a session token alone is not accepted'));
}
$auth = require_admin_auth($payload, $proof, null, '/atlas/admin/moderation/grant', 'moderation');
if (isset($auth['error'])) admin_auth_fail($auth);

$config = atlas_moderation_config();
if (!$config['audiences'] || !$config['domain']) {
  admin_auth_fail(admin_failure(503, 'moderation-not-configured', 'no presence endpoint is configured to receive moderation grants'));
}
// The grant names the configured domain; a request that arrived under any
// other host name is refused rather than silently signed for the wrong one.
if (strtolower(atlas_domain()) !== strtolower($config['domain'])) {
  admin_auth_fail(admin_failure(400, 'wrong-domain', 'this request was not addressed to the configured domain'));
}

$parsed = atlas_parse_grant_request($payload, $auth['publicKey'], $kp['publicKeyB64url']);
if (isset($parsed['error'])) admin_auth_fail($parsed['error']);
$r = $parsed['request'];
if (!in_array($r['audience'], $config['audiences'], true)) admin_auth_fail(admin_failure(403, 'audience-not-trusted', 'this presence endpoint is not configured for this domain'));
if (!atlas_grant_within_authority($auth['authority'], $r)) admin_auth_fail(admin_failure(403, 'scope-denied', 'the requested worlds or operations are outside this key\'s authority'));

$nowMs = atlas_now_ms();
$grantPayload = [
  'type' => ATLAS_MODERATION_GRANT_TYPE,
  'version' => ATLAS_MODERATION_GRANT_VERSION,
  'grantId' => b64url_encode(random_bytes(16)),
  'domain' => $config['domain'],
  'audience' => $r['audience'],
  'moderatorRef' => atlas_moderator_ref($config['domain'], $auth['publicKey']),
  'worlds' => $r['worlds'],
  'operations' => $r['operations'],
  'issuedAt' => gmdate('Y-m-d\TH:i:s', intdiv($nowMs, 1000)) . sprintf('.%03dZ', $nowMs % 1000),
  'expiresAt' => gmdate('Y-m-d\TH:i:s', intdiv($nowMs + $r['ttl'] * 1000, 1000)) . sprintf('.%03dZ', ($nowMs + $r['ttl'] * 1000) % 1000),
  'cnf' => ['alg' => 'ES256', 'publicKey' => $r['popPublicKey']],
];
$recorded = atlas_record_moderation_grant([
  'grantId' => $grantPayload['grantId'],
  'moderatorRef' => $grantPayload['moderatorRef'],
  'audience' => $r['audience'],
  'issuedAt' => $grantPayload['issuedAt'],
  'expiresAtMs' => $nowMs + $r['ttl'] * 1000,
], $nowMs);
if (!$recorded) admin_auth_fail(admin_failure(429, 'grant-quota', 'too many live moderation grants for this moderator; wait for one to expire'));

$signature = b64url_encode(ecdsa_sign_raw($kp['privateKey'], ATLAS_MODERATION_GRANT_SIGN_CONTEXT . canonicalize($grantPayload)));
send_json(200, [
  'grant' => ['payload' => $grantPayload, 'proof' => ['signerRole' => 'raw-ecdsa', 'publicKey' => $kp['publicKeyB64url'], 'signature' => $signature]],
  'expiresAt' => $grantPayload['expiresAt'],
]);
