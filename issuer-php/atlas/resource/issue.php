<?php
// POST /atlas/resource/issue — mirrors issuer-server/server.js's same route.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$ownerPublicKey = $body['ownerPublicKey'] ?? null;
$cls = $body['class'] ?? null;
$quantity = $body['quantity'] ?? null;
if (!$ownerPublicKey) send_json(400, ['error' => 'ownerPublicKey is required']);
if (!in_array($cls, ATLAS_RESOURCE_CLASSES, true)) send_json(400, ['error' => 'Unknown resource class. Try atlas.element.iron or atlas.element.gold.']);
if (!atlas_is_positive_int($quantity)) send_json(400, ['error' => 'quantity must be a positive integer']);
$quantity = (int) $quantity;

$credential = issue_resource($kp['privateKey'], $kp['publicKeyB64url'], $ownerPublicKey, $cls, $quantity, null);
send_json(200, $credential);
