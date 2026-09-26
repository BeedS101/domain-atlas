<?php
// POST /atlas/asset/fulfill (SPEC.md §5.9) — mirrors issuer-server/
// server.js's same route. An operator confirming a held credential is
// genuine and unspent, then consuming it in the same act — the natural
// close to whatever atlas/asset/purchase.php (or any other issuance path)
// started, for anything meant to be handed over once and only once.
// Admin-gated (require_admin_auth(), same as every other operator action
// here) — the presented credential proves what it is, but only the
// domain's own operator decides it's actually been handed over.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$payload = $body['payload'] ?? null;
$proof = $body['proof'] ?? null;
$token = $body['token'] ?? null;
if (!is_array($payload) || empty($payload['credential'])) send_json(400, ['error' => 'payload.credential is required']);
$auth = require_admin_auth($payload, $proof, $token);
if (isset($auth['error'])) send_json(401, ['error' => $auth['error']]);

$credential = $payload['credential'];
$problem = check_presented_fulfillable_asset($kp['publicKeyB64url'], $credential);
if ($problem) send_json(400, ['error' => $problem]);

atlas_revoke($credential['id'], 'fulfilled');
send_json(200, ['status' => 'fulfilled', 'id' => $credential['id'], 'asset' => $credential['asset'], 'owner' => $credential['owner']]);
