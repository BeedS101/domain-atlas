<?php
// POST /atlas/admin/session/start — mirrors issuer-server/server.js's same
// route. {payload: {nonce, adminAuth: {action, domain}}, proof}: a roster
// key signs a server-issued single-use nonce (nonce.php), bound to this
// route and domain, and trades that one signature for a session token.
// Idle expiry is ATLAS_ADMIN_SESSION_TTL_MS (slides forward on use);
// absolute expiry is ATLAS_ADMIN_SESSION_MAX_MS from now. See lib/store.php.
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_post();

$requestBody = read_admin_json_body(ATLAS_ADMIN_SESSION_MAX_BODY_BYTES);
$loginPayload = $requestBody['payload'] ?? null;
$proof = $requestBody['proof'] ?? null;

$failed = authenticate_admin_login($loginPayload, $proof);
if ($failed) admin_auth_fail($failed);

send_json(200, create_admin_session($proof['publicKey']));
