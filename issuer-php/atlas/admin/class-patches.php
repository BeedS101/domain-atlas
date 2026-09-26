<?php
// POST /atlas/admin/class-patches — mirrors issuer-server/server.js's same
// route. Admin-gated (require_admin_auth(), same wire shape as every
// other admin action here: {payload, proof} or {payload, token}.
//
// Every class this operator has ever patched (never one per item or
// holder — see atlas_class_patches_file()'s own comment), so the admin
// panel can show what's currently active and let the operator edit or
// clear one instead of guessing from memory what's already set.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$payload = $body['payload'] ?? [];
$proof = $body['proof'] ?? null;
$token = $body['token'] ?? null;
$auth = require_admin_auth($payload, $proof, $token);
if (isset($auth['error'])) send_json(401, ['error' => $auth['error']]);

send_json(200, ['patches' => read_class_patches()['patches']]);
