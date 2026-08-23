<?php
// POST /atlas/resource/split — mirrors issuer-server/server.js's same route.
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
$expectedClass = $credential['class'] ?? null;
$problem = check_presented_balance($kp['publicKeyB64url'], $credential, $expectedOwner, $expectedClass, $sendAmount);
if ($problem) send_json(400, ['error' => $problem]);

$remainderQty = $credential['quantity'] - $sendAmount;
$sent = issue_resource($kp['privateKey'], $kp['publicKeyB64url'], $toPublicKey, $credential['class'], $sendAmount, $credential['id']);
$remainder = $remainderQty > 0
  ? issue_resource($kp['privateKey'], $kp['publicKeyB64url'], $credential['owner']['publicKey'], $credential['class'], $remainderQty, $credential['id'])
  : null;
atlas_revoke($credential['id'], 'superseded');
send_json(200, ['sent' => $sent, 'remainder' => $remainder]);
