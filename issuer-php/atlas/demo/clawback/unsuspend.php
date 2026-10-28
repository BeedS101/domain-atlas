<?php
// POST /atlas/demo/clawback/unsuspend: lifts a suspension the demo itself made
// (clawback-demo.html's false-alarm path). Needs the credential's demo
// authority, never the owner. An admin, trade or delivery suspension is left in
// place and refused (409). Mirrors issuer-server/server.js.
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
atlas_require_demo_request($body, $credential, 'demo-unsuspend', atlas_demo_authority_of($credential));
read_suspensions(); // drops expired suspensions first
$result = atlas_unsuspend_if_reason($credential['id'], ATLAS_DEMO_SUSPENSION_REASON);
if ($result === 'other') send_json(409, ['error' => 'this suspension was not made by the demo and cannot be lifted here', 'code' => 'not-a-demo-suspension']);
send_json(200, ['ok' => true, 'wasSuspended' => $result === 'removed']);
