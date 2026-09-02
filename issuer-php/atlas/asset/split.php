<?php
// POST /atlas/asset/split — mirrors issuer-server/server.js's same route.
// Fungible only (SPEC.md §5.4) — check_presented_asset() below rejects a
// fungible:false credential with a clear error.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$credential = $body['credential'] ?? null;
$sendAmount = $body['sendAmount'] ?? null;
$toPublicKey = $body['toPublicKey'] ?? null;
if (!$credential || !$toPublicKey || !atlas_is_positive_int($sendAmount)) {
  send_json(400, ['error' => 'credential, sendAmount, and toPublicKey are required']);
}
$sendAmount = (int) $sendAmount;

$expectedOwner = $credential['owner']['publicKey'] ?? null;
$expectedClass = $credential['asset']['class'] ?? null;
$problem = check_presented_asset($kp['publicKeyB64url'], $credential, $expectedOwner, $expectedClass, $sendAmount);
if ($problem) send_json(400, ['error' => $problem]);

$remainderQty = $credential['quantity'] - $sendAmount;
$sent = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $toPublicKey, $expectedClass, $sendAmount, $credential['id']);
$remainder = $remainderQty > 0
  ? mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $expectedOwner, $expectedClass, $remainderQty, $credential['id'])
  : null;
atlas_revoke($credential['id'], 'superseded');
send_json(200, ['sent' => $sent, 'remainder' => $remainder]);
