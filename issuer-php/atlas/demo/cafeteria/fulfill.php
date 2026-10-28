<?php
// POST /atlas/demo/cafeteria/fulfill: the counter redeems a cafeteria item the
// owner presents. Self-serve sibling of atlas/asset/fulfill.php for the
// cafeteria demo's three classes. The owner's signed request
// (lib/demo-authority.php) is what the counter acts on, so nobody can redeem
// someone else's item. Mirrors issuer-server/server.js.
require_once __DIR__ . '/../../../lib/bootstrap.php';
require_once __DIR__ . '/../../../lib/demo-authority.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();
try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}
$fulfillable = ['atlas.demo.cafeteria.sandwich', 'atlas.demo.cafeteria.juice', 'atlas.demo.cafeteria.snack'];
$credential = $body['credential'] ?? null;
if (!is_array($credential) || !isset($credential['asset'])) send_json(400, ['error' => 'credential is required']);
if (!in_array($credential['asset']['class'] ?? null, $fulfillable, true)) {
  send_json(400, ['error' => 'this endpoint only fulfills ' . implode(', ', $fulfillable)]);
}
$problem = check_presented_fulfillable_asset($kp['publicKeyB64url'], $credential);
if ($problem) send_json(400, ['error' => $problem]);
atlas_require_demo_request($body, $credential, 'demo-fulfill', $credential['owner']['publicKey'] ?? null);
atlas_revoke($credential['id'], 'fulfilled');
send_json(200, ['status' => 'fulfilled', 'id' => $credential['id'], 'asset' => $credential['asset'], 'owner' => $credential['owner']]);
