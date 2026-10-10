<?php
// POST /atlas/admin/session/whoami — mirrors issuer-server/server.js's
// same route. {token}, no signature — the bearer token itself IS the
// credential once a session exists (start.php). Counts as use, so it
// slides the idle expiry, and fails once the key has left the roster.
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_post();

$requestBody = read_admin_json_body(ATLAS_ADMIN_SESSION_MAX_BODY_BYTES);
$token = $requestBody['token'] ?? null;
// No token at all is an answer, not a guess, so it does not count against the
// failed-attempt budget; a wrong one does.
if (!is_string($token) || $token === '') admin_auth_fail(admin_failure(401, 'session-invalid', 'session is missing, unknown, or expired'));
$auth = require_admin_auth(null, null, $token, '/atlas/admin/session/whoami');
if (isset($auth['error'])) admin_auth_fail($auth);

send_json(200, ['publicKey' => $auth['publicKey']]);
