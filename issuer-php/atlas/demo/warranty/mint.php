<?php
// POST /atlas/demo/warranty/mint — mirrors issuer-server/server.js's same
// route. Self-serve sibling of atlas/asset/mint.php, hardcoded to
// atlas.demo.warranty.certificate only — no admin auth at all. A solo
// visitor to warranty-demo.html has no admin login of their own, so this
// plays "the factory" for that page's step 1 in their place; this
// domain's actual admin roster and Admin Panel stay exactly as gated as
// ever, and nothing here can ever touch a class other than the one
// hardcoded below.
//
// Input: {ownerPublicKey, properties} — properties, when given, merges
// onto the class's own base properties the same way
// atlas/asset/reissue.php's own properties patch already does.
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$ownerPublicKey = $body['ownerPublicKey'] ?? null;
if (!$ownerPublicKey) send_json(400, ['error' => 'ownerPublicKey is required']);
$hasProperties = array_key_exists('properties', $body);
$properties = $body['properties'] ?? null;
if ($hasProperties && !is_array($properties)) {
  send_json(400, ['error' => "properties, when given, must be a patch object onto the class's own base properties"]);
}

$credential = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $ownerPublicKey, 'atlas.demo.warranty.certificate', 1, null, $hasProperties ? $properties : null);
send_json(200, $credential);
