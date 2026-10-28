<?php
// POST /atlas/demo/warranty/stamp-sale: warranty-demo.html's "retailer" step.
// Stamps the sale date, warranty length and retailer onto a self-serve
// certificate and supersedes it (same mechanics as
// atlas/asset/reissue.php). Needs the certificate's demo authority
// (lib/demo-authority.php), never the owner; only those three properties, and
// only on atlas.demo.warranty.selfserve. Mirrors issuer-server/server.js.
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
$credential = $body['credential'] ?? null;
$properties = $body['properties'] ?? null;
if (!is_array($credential) || ($credential['credential'] ?? null) !== 'domain-atlas-asset/1.0' || !isset($credential['id'])) {
  send_json(400, ['error' => 'credential must be a domain-atlas-asset/1.0 credential']);
}
if (($credential['asset']['class'] ?? null) !== 'atlas.demo.warranty.selfserve') {
  send_json(400, ['error' => 'this endpoint only stamps an atlas.demo.warranty.selfserve credential']);
}
$keys = is_array($properties) ? array_keys($properties) : [];
sort($keys);
$saleDate = $properties['com.example.saleDate'] ?? null;
$months = $properties['com.example.warrantyMonths'] ?? null;
$retailer = $properties['com.example.retailer'] ?? null;
$validDate = is_string($saleDate) && preg_match('/^(\d{4})-(\d{2})-(\d{2})$/D', $saleDate, $d) && checkdate((int) $d[2], (int) $d[3], (int) $d[1]);
if ($keys !== ['com.example.retailer', 'com.example.saleDate', 'com.example.warrantyMonths'] || !$validDate ||
    !is_int($months) || $months < 1 || $months > 120 ||
    !is_string($retailer) || !preg_match('/^[\p{L}\p{N} .,&\'-]{1,64}$/uD', $retailer)) {
  send_json(400, ['error' => 'properties must be exactly a saleDate (YYYY-MM-DD), warrantyMonths (1-120) and retailer (up to 64 characters)']);
}
if (($credential['issuer']['domain'] ?? null) !== atlas_domain()) send_json(400, ['error' => 'credential was not issued by this domain']);
$busy = atlas_spend_lock($credential['id']);
if ($busy !== null) send_json(409, ['error' => $busy]);
if (is_revoked($credential['id'])) send_json(400, ['error' => 'credential is already revoked']);
if (!verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential))) {
  send_json(400, ['error' => "credential signature does not check out against this issuer's key"]);
}
atlas_require_demo_request($body, $credential, 'demo-stamp-sale', atlas_demo_authority_of($credential), ['properties' => $properties]);
$newAsset = $credential['asset'];
$newAsset['properties'] = merge_properties($newAsset['properties'] ?? [], $properties);
$newCredential = issue_asset($kp['privateKey'], $kp['publicKeyB64url'], $credential['owner']['publicKey'], $newAsset, $credential['quantity'], $credential['id']);
atlas_revoke($credential['id'], 'superseded');
archive_if_audited($credential, 'superseded');
append_asset_update(['id' => $credential['id'], 'status' => 'superseded', 'reason' => 'superseded', 'newCredential' => $newCredential]);
send_json(200, ['newCredential' => $newCredential]);
