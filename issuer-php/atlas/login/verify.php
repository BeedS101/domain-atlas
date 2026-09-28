<?php
// POST /atlas/login/verify — mirrors issuer-server/server.js's same route.
// demo-domain-a/login-demo.html's second factor: {credential, intent:
// {payload: {nonce, action: 'login'}, proof}} — present an
// atlas.demo.login.badge and sign the fresh nonce from nonce.php with the
// same key the badge names as owner. No session token comes back: every
// sign-in re-proves the badge is held and unrevoked at that exact moment,
// which is also what makes revoking it from the admin panel take effect
// immediately, without anything else to invalidate.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$credential = $body['credential'] ?? null;
$intent = $body['intent'] ?? null;
if (!$credential || !$intent) send_json(400, ['error' => 'credential and intent are both required']);
if (!isset($intent['payload']) || !isset($intent['proof'])) {
  send_json(400, ['error' => 'intent must carry payload and proof']);
}
$payload = $intent['payload'];
if (!is_string($payload['nonce'] ?? null) || ($payload['action'] ?? null) !== 'login') {
  send_json(400, ['error' => 'intent does not authorize a login with this nonce']);
}

// Signature checked before the nonce is burned, same order (and same
// reasoning) as admin/session/start.php: a bad signature shouldn't cost
// the caller their nonce and force a fresh GET just to retry.
$envelopeOk = verify_envelope($payload, $intent['proof']);
if (!$envelopeOk) send_json(401, ['error' => 'login signature does not check out']);
if (!consume_login_nonce($payload['nonce'])) {
  send_json(401, ['error' => 'nonce is missing, unknown, already used, or expired']);
}

$signerPub = $intent['proof']['publicKey'];
$problem = check_presented_membership($kp['publicKeyB64url'], $credential, $signerPub, 'atlas.demo.login.badge');
if ($problem) send_json(401, ['error' => $problem]);

send_json(200, ['ok' => true, 'ownerPublicKey' => $signerPub, 'name' => $credential['asset']['name'] ?? null]);
