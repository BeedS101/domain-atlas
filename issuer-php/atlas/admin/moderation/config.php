<?php
// POST /atlas/admin/moderation/config — mirrors issuer-server/server.js's same
// route. {token}. What the moderation panel needs to know before it asks for a
// grant: this key's role, the worlds and operations it may use, and the
// presence endpoints this domain is configured to address grants to. Read from
// this bundle's own configuration and the roster; never from the manifest or
// the request. Administrators and moderators (scope 'moderation'); the answer
// holds no secrets and names no other moderator.
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_post();

$requestBody = read_admin_json_body(ATLAS_ADMIN_SESSION_MAX_BODY_BYTES);
$token = $requestBody['token'] ?? null;
if (!is_string($token) || $token === '') admin_auth_fail(admin_failure(401, 'session-invalid', 'session is missing, unknown, or expired'));
$auth = require_admin_auth(null, null, $token, '/atlas/admin/moderation/config', 'moderation');
if (isset($auth['error'])) admin_auth_fail($auth);

send_json(200, atlas_moderation_panel_config($auth['authority']));
