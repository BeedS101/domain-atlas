<?php
// POST /atlas/asset/reissue — mirrors issuer-server/server.js's same route
// (SPEC.md §5.1.1: the supersedes-linked reissue pattern, non-fungible
// only — this is what lets an issuer publish an updated version of an
// asset a visitor already holds, e.g. a museum exhibit's properties
// changing after the visitor picked it up). Fungible classes are
// deliberately rejected: SPEC.md §5.1 requires every credential of a
// fungible class to carry identical properties so §5.4.1's consolidation
// can sum quantities without silently blending a differing fact, so a
// fungible credential's properties only ever change at the class level
// (ATLAS_ASSET_CATALOG), never by reissuing one specific balance.
//
// Input: {credential, properties} — the exact currently-held credential
// being replaced, plus a patch merged onto its asset.properties. Verifies
// the presented credential really was signed by this domain and isn't
// already revoked before ever reissuing anything — an issuer can only ever
// reissue its own assets, never forge an update for a credential it didn't
// sign in the first place.
//
// This is an issuer-initiated action (the domain deciding to publish an
// update), not owner-initiated like a split — there's no WebAuthn
// assertion to check here, same as /atlas/revoke needs none: the caller
// of this endpoint is whoever operates the domain, not a visitor's
// browser.
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
$properties = $body['properties'] ?? null;
if (!is_array($credential) || ($credential['credential'] ?? null) !== 'domain-atlas-asset/1.0') {
  send_json(400, ['error' => 'credential must be a domain-atlas-asset/1.0 credential']);
}
if (!is_array($properties) || count($properties) === 0) {
  send_json(400, ['error' => 'properties (a non-empty patch onto asset.properties) is required']);
}
if (!isset($credential['issuer']['domain']) || $credential['issuer']['domain'] !== atlas_domain()) {
  send_json(400, ['error' => 'credential was not issued by this domain']);
}
if (!isset($credential['asset']['fungible']) || $credential['asset']['fungible'] !== false) {
  send_json(400, ['error' => "reissue only applies to a non-fungible asset — a fungible class's properties are fixed per class (SPEC.md §5.1), not per credential"]);
}
if (is_revoked($credential['id'])) send_json(400, ['error' => 'credential is already revoked']);

$sigOk = verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential));
if (!$sigOk) send_json(400, ['error' => "credential signature does not check out against this issuer's key"]);

$newAsset = $credential['asset'];
$newAsset['properties'] = array_merge($newAsset['properties'] ?? [], $properties);
$newCredential = issue_asset($kp['privateKey'], $kp['publicKeyB64url'], $credential['owner']['publicKey'], $newAsset, $credential['quantity'], $credential['id']);

// Same ordering guarantee §5.4's split/consolidate already give: the new
// credential is signed FIRST, then the old one revoked — a crash between
// the two would leave an extra valid asset rather than a holder with
// neither.
atlas_revoke($credential['id'], 'superseded');
append_asset_update(['id' => $credential['id'], 'status' => 'superseded', 'reason' => 'superseded', 'newCredential' => $newCredential]);

send_json(200, ['newCredential' => $newCredential]);
