<?php
// POST /atlas/issue — mirrors issuer-server/server.js's same route.
require_once __DIR__ . '/../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$ownerPublicKey = $body['ownerPublicKey'] ?? null;
$assetClass = $body['assetClass'] ?? null;
if (!$ownerPublicKey) send_json(400, ['error' => 'ownerPublicKey is required']);
$asset = atlas_item_catalog_entry($assetClass);
if (!$asset) send_json(400, ['error' => 'Unknown assetClass. Try atlas.wearable, atlas.badge, or atlas.wearable.ring.']);

$assetPayload = ['name' => $asset['name'], 'class' => $assetClass, 'model' => $asset['model']];
if (!empty($asset['thumbnail'])) $assetPayload['thumbnail'] = $asset['thumbnail'];
if (!empty($asset['properties'])) $assetPayload['properties'] = $asset['properties'];

$payload = [
  'id' => 'urn:atlas:item:' . atlas_uuid(),
  'asset' => $assetPayload,
  'owner' => ['publicKey' => $ownerPublicKey],
  'issuedAt' => iso_now(),
];
$signature = atlas_sign($kp['privateKey'], $payload);
$credential = array_merge(
  ['credential' => 'domain-atlas-item/1.0'],
  $payload,
  ['issuer' => ['domain' => atlas_domain(), 'publicKey' => $kp['publicKeyB64url']], 'signature' => $signature]
);
send_json(200, $credential);
