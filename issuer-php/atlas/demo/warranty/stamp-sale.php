<?php
// POST /atlas/demo/warranty/stamp-sale — mirrors issuer-server/server.js's
// same route. Self-serve sibling of atlas/asset/reissue.php, hardcoded to
// atlas.demo.warranty.certificate only — no admin auth at all. Plays "the
// retailer" for warranty-demo.html's step 2, using the exact same
// revoke-old/mint-new mechanics reissue.php itself uses.
//
// Input: {credential, properties} — the exact currently-held certificate,
// plus a patch merged onto its asset.properties. Verifies the presented
// credential really was signed by this domain and isn't already revoked
// before ever reissuing anything.
require_once __DIR__ . '/../../../lib/bootstrap.php';
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
if (!is_array($credential) || ($credential['credential'] ?? null) !== 'domain-atlas-asset/1.0') {
  send_json(400, ['error' => 'credential must be a domain-atlas-asset/1.0 credential']);
}
if (($credential['asset']['class'] ?? null) !== 'atlas.demo.warranty.certificate') {
  send_json(400, ['error' => 'this endpoint only stamps an atlas.demo.warranty.certificate credential']);
}
if (!is_array($properties)) {
  send_json(400, ['error' => 'properties (a patch onto asset.properties) is required']);
}
if (!isset($credential['issuer']['domain']) || $credential['issuer']['domain'] !== atlas_domain()) {
  send_json(400, ['error' => 'credential was not issued by this domain']);
}
if (is_revoked($credential['id'])) send_json(400, ['error' => 'credential is already revoked']);

$sigOk = verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential));
if (!$sigOk) send_json(400, ['error' => "credential signature does not check out against this issuer's key"]);

$newAsset = $credential['asset'];
$newAsset['properties'] = merge_properties($newAsset['properties'] ?? [], $properties);
$newCredential = issue_asset($kp['privateKey'], $kp['publicKeyB64url'], $credential['owner']['publicKey'], $newAsset, $credential['quantity'], $credential['id']);

atlas_revoke($credential['id'], 'superseded');
append_asset_update(['id' => $credential['id'], 'status' => 'superseded', 'reason' => 'superseded', 'newCredential' => $newCredential]);

send_json(200, ['newCredential' => $newCredential]);
