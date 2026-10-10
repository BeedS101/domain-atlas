<?php
// POST /atlas/unsuspend — mirrors issuer-server/server.js's same route.
//
// Admin-gated (require_admin_auth(), above), same wire shape as
// atlas/suspend.php: {payload: {id}, proof} or {payload, token}. Lifts a
// suspension early — a no-op (still 200, wasSuspended: false) if the id
// wasn't suspended in the first place, or its suspension had already
// expired on its own, rather than treating "nothing to lift" as an error.
require_once __DIR__ . '/../lib/bootstrap.php';
handle_preflight();
require_post();
atlas_load_keys(); // ensures .well-known files exist even if this is the very first request the site ever gets

$body = read_admin_json_body();

$payload = $body['payload'] ?? null;
$proof = $body['proof'] ?? null;
$token = $body['token'] ?? null;
if (!is_array($payload) || empty($payload['id'])) send_json(400, ['error' => 'payload.id is required']);
$auth = require_admin_auth($payload, $proof, $token, '/atlas/unsuspend');
if (isset($auth['error'])) admin_auth_fail($auth);
$wasSuspended = atlas_unsuspend($payload['id']);
send_json(200, ['ok' => true, 'wasSuspended' => $wasSuspended]);
