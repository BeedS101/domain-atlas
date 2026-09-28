<?php
// POST /atlas/demo/cafeteria/fulfill — mirrors issuer-server/server.js's
// same route. Self-serve sibling of atlas/asset/fulfill.php, hardcoded to
// the cafeteria demo's own three purchasable classes — no admin auth at
// all. Plays "the counter" for cafeteria-demo.html's step 4, since a solo
// visitor can't otherwise be both the student and the operator confirming
// their own order.
require_once __DIR__ . '/../../../lib/bootstrap.php';
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

atlas_revoke($credential['id'], 'fulfilled');
send_json(200, ['status' => 'fulfilled', 'id' => $credential['id'], 'asset' => $credential['asset'], 'owner' => $credential['owner']]);
