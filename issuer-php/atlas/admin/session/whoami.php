<?php
// POST /atlas/admin/session/whoami — mirrors issuer-server/server.js's
// same route. {token}, no signature — the bearer token itself IS the
// credential once a session exists (start.php), the whole point of not
// re-signing every request with the admin's ECDSA key.
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $requestBody = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$publicKey = touch_admin_session($requestBody['token'] ?? null);
if (!$publicKey) send_json(401, ['error' => 'session is missing, unknown, or expired']);

send_json(200, ['publicKey' => $publicKey]);
