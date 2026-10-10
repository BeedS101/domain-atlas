<?php
// POST /atlas/admin/session/logout — mirrors issuer-server/server.js's
// same route. {token}. Always 200 regardless of whether the token was
// ever valid, deliberately — see delete_admin_session()'s own comment
// (lib/store.php) on why nothing here should let a caller distinguish
// "wrong token" from "already logged out."
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_post();

$requestBody = read_admin_json_body(ATLAS_ADMIN_SESSION_MAX_BODY_BYTES);

$token = $requestBody['token'] ?? null;
if (is_string($token)) delete_admin_session($token);

send_json(200, ['status' => 'logged out']);
