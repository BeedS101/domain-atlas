<?php
// POST /atlas/asset/mint — mirrors issuer-server/server.js's same route.
// Admin-gated sibling of atlas/asset/issue.php: an authenticated operator
// minting a credential with its own explicit starting facts (a factory
// stamping a real serial number onto a certificate at manufacture time,
// say), rather than every unit of a class coming out identical the way a
// self-serve mint's does. payload.properties, when given, merges onto the
// catalog's own base properties the same way atlas/asset/reissue.php's own
// properties patch already does — a key left out keeps the catalog
// default, a key set to null removes it.
//
// Deliberately skips every self-serve side effect issue.php has
// (subscriber/Post Office/Trading Station roster logging, the holdingCap
// check) — this route is for an operator minting a specific instance of a
// class on someone's behalf, not a visitor joining something or mining
// their own supply, and those two things shouldn't be conflated.
//
// Wire shape is {payload: {ownerPublicKey, assetClass, quantity,
// properties}, proof} or {payload, token}, the same envelope
// atlas/asset/reissue.php already uses.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $requestBody = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$mintPayload = $requestBody['payload'] ?? null;
$proof = $requestBody['proof'] ?? null;
$token = $requestBody['token'] ?? null;
$auth = require_admin_auth($mintPayload, $proof, $token);
if (isset($auth['error'])) send_json(401, ['error' => $auth['error']]);

$ownerPublicKey = $mintPayload['ownerPublicKey'] ?? null;
if (!$ownerPublicKey) send_json(400, ['error' => 'payload.ownerPublicKey is required']);
$assetClass = $mintPayload['assetClass'] ?? null;
$quantity = $mintPayload['quantity'] ?? null;
$hasProperties = array_key_exists('properties', $mintPayload);
$properties = $mintPayload['properties'] ?? null;

if (!isset(ATLAS_ASSET_CATALOG[$assetClass])) {
  send_json(400, ['error' => 'Unknown assetClass. See GET /atlas/trade/catalog for tradable classes, or ATLAS_ASSET_CATALOG_BASE in issuer-php/lib/store.php (plus issuer-php/lib/elements-catalog.php) for the full list.']);
}
if ($hasProperties && !is_array($properties)) {
  send_json(400, ['error' => "properties, when given, must be a patch object onto the class's own base properties"]);
}

$catalogEntry = ATLAS_ASSET_CATALOG[$assetClass];
if ($catalogEntry['fungible']) {
  $quantity = $quantity ?? 1;
  if (!atlas_is_positive_int($quantity)) {
    send_json(400, ['error' => 'quantity must be a positive integer for a fungible assetClass']);
  }
  $mintQuantity = (int) $quantity;
} else {
  if ($quantity !== null && $quantity !== 1) {
    send_json(400, ['error' => 'quantity must be 1 (or omitted) for a non-fungible assetClass']);
  }
  $mintQuantity = 1;
}

$credential = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $ownerPublicKey, $assetClass, $mintQuantity, null, $hasProperties ? $properties : null);
send_json(200, $credential);
