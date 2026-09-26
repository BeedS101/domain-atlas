<?php
// POST /atlas/admin/session/start — mirrors issuer-server/server.js's same
// route. {payload: {nonce}, proof} — the same signed-envelope shape every
// other admin action in this bundle uses, just signing a fresh nonce
// (nonce.php) instead of an action. Trades one real signature for a
// session token good for ATLAS_ADMIN_SESSION_TTL_MS (lib/store.php),
// sliding forward on each /whoami check — see touch_admin_session().
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $requestBody = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$loginPayload = $requestBody['payload'] ?? null;
$proof = $requestBody['proof'] ?? null;
$authError = require_admin($loginPayload, $proof);
if ($authError) send_json(401, ['error' => $authError]);

$nonce = $loginPayload['nonce'] ?? null;
if (!is_string($nonce) || !consume_admin_nonce($nonce)) {
  send_json(401, ['error' => 'nonce is missing, unknown, already used, or expired']);
}

$session = create_admin_session($proof['publicKey']);
send_json(200, $session);
