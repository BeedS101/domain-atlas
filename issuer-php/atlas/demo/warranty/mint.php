<?php
// POST /atlas/demo/warranty/mint: warranty-demo.html's "factory" step. Mints
// atlas.demo.warranty.selfserve, a class separate from the factory's
// atlas.demo.warranty.certificate (admin-gated atlas/asset/mint.php only), so
// the issuer-signed class says the serial was not set by a factory. The only
// property a visitor sets is the serial number; the certificate also carries
// the demo authority (lib/demo-authority.php) that alone may stamp its sale.
// Input: {ownerPublicKey, authorityPublicKey, properties: {'com.example.serialNumber'}}.
// Mirrors issuer-server/server.js.
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
$ownerPublicKey = $body['ownerPublicKey'] ?? null;
$authorityPublicKey = $body['authorityPublicKey'] ?? null;
$properties = $body['properties'] ?? null;
if (!atlas_demo_valid_key($ownerPublicKey) || !atlas_demo_valid_key($authorityPublicKey)) {
  send_json(400, ['error' => 'ownerPublicKey and authorityPublicKey must be raw P-256 public keys']);
}
if ($authorityPublicKey === $ownerPublicKey) send_json(400, ['error' => 'the demo authority must be a different key from the owner']);
$serial = is_array($properties) ? ($properties['com.example.serialNumber'] ?? null) : null;
if (!is_array($properties) || array_keys($properties) !== ['com.example.serialNumber'] ||
    !is_string($serial) || !preg_match('/^[A-Za-z0-9-]{1,40}$/D', $serial)) {
  send_json(400, ['error' => "properties must be exactly {'com.example.serialNumber': up to 40 letters, digits or dashes}"]);
}
$credential = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $ownerPublicKey, 'atlas.demo.warranty.selfserve', 1, null,
  ['com.example.serialNumber' => $serial, ATLAS_DEMO_AUTHORITY_PROPERTY => $authorityPublicKey]);
send_json(200, $credential);
