<?php
// POST /atlas/demo/clawback/suspend: freezes a demo token or demo funds, as
// the issuer would after a fraud report. Needs the credential's demo authority
// (lib/demo-authority.php), never the owner. Only adds a suspension where there
// is none, so it never replaces an admin, trade or delivery suspension.
// clawback-demo.html and reserve-bank-demo.html Act 7. Mirrors issuer-server/server.js.
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
if (!is_array($credential) || !isset($credential['asset'], $credential['id'])) send_json(400, ['error' => 'credential is required']);
if (!in_array($credential['asset']['class'] ?? null, atlas_demo_suspendable_classes(), true)) {
  send_json(400, ['error' => 'this endpoint only acts on: ' . implode(', ', atlas_demo_suspendable_classes())]);
}
if (($credential['issuer']['domain'] ?? null) !== atlas_domain()) send_json(400, ['error' => 'this domain did not issue this credential']);
$busy = atlas_spend_lock($credential['id']);
if ($busy !== null) send_json(409, ['error' => $busy]);
if (is_revoked($credential['id'])) send_json(400, ['error' => 'credential is already revoked']);
// The issuer's signature makes the demo authority it names trustworthy.
if (!verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential))) {
  send_json(400, ['error' => "credential signature does not check out against this issuer's key"]);
}
atlas_require_demo_request($body, $credential, 'demo-suspend', atlas_demo_authority_of($credential));
read_suspensions(); // drops expired suspensions first
if (!atlas_suspend_if_free($credential['id'], ATLAS_DEMO_SUSPENSION_REASON)) {
  send_json(409, ['error' => 'this credential is already suspended', 'code' => 'already-suspended']);
}
send_json(200, ['ok' => true]);
