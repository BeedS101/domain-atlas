<?php
// POST /atlas/admin/site-pause {payload: {feature}} — mirrors issuer-server/server.js's same route. Admin-gated
// (require_admin_auth(), administrators only).
//
// Switches one feature OFF (never on) when the registry marks it pausable: see lib/site-pause.php for exactly what
// each kind of switch changes. Pausing an already-off feature changes nothing and still answers 200.
require_once __DIR__ . '/../../lib/bootstrap.php';
require_once __DIR__ . '/../../lib/site-pause.php';
handle_preflight();
require_post();

$body = read_admin_json_body();

$payload = $body['payload'] ?? null;
$proof = $body['proof'] ?? null;
$token = $body['token'] ?? null;
if (!is_array($payload) || !isset($payload['feature']) || !is_string($payload['feature']) || !preg_match('/^[a-z0-9-]{1,40}$/', $payload['feature'])) {
  send_json(400, ['error' => 'payload.feature is required', 'code' => 'bad-request']);
}
$auth = require_admin_auth($payload, $proof, $token, '/atlas/admin/site-pause');
if (isset($auth['error'])) admin_auth_fail($auth);

$root = atlas_docroot();
$r = atlas_site_pause($root, atlas_sf_registry($root), $payload['feature'], atlas_domain());
if (empty($r['ok'])) send_json($r['code'] === 'unknown-feature' ? 404 : 409, ['error' => $r['error'], 'code' => $r['code']]);
error_log('atlas: admin ' . substr($auth['publicKey'], 0, 16) . ' paused ' . $payload['feature'] . ($r['changed'] ? '' : ' (already off)'));
send_json(200, ['ok' => true, 'feature' => $payload['feature'], 'changed' => $r['changed'], 'state' => $r['state']]);
