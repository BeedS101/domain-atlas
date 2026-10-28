<?php
// POST /atlas/demo/clawback/clawback: reissues a demo token or demo funds to
// toPublicKey and revokes the original, as the issuer would after a theft.
// Needs the credential's demo authority, never the owner. Refused while the
// credential has any suspension the demo did not make (admin, trade lock,
// delivery hold). clawback-demo.html and reserve-bank-demo.html Act 7.
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
$credential = $body['credential'] ?? null;
if (!is_array($credential) || !isset($credential['asset'], $credential['id'])) send_json(400, ['error' => 'credential is required']);
if (!in_array($credential['asset']['class'] ?? null, atlas_demo_suspendable_classes(), true)) {
  send_json(400, ['error' => 'this endpoint only acts on: ' . implode(', ', atlas_demo_suspendable_classes())]);
}
if (($credential['issuer']['domain'] ?? null) !== atlas_domain()) send_json(400, ['error' => 'this domain did not issue this credential']);
$toPublicKey = $body['toPublicKey'] ?? null;
if (!atlas_demo_valid_key($toPublicKey)) send_json(400, ['error' => 'toPublicKey must be a raw P-256 public key']);
if ($toPublicKey === ($credential['owner']['publicKey'] ?? null)) {
  send_json(400, ['error' => "toPublicKey already matches the credential's current owner — nothing to claw back"]);
}
$busy = atlas_spend_lock($credential['id']);
if ($busy !== null) send_json(409, ['error' => $busy]);
if (is_revoked($credential['id'])) send_json(400, ['error' => 'credential is already revoked']);
// The issuer's signature makes the demo authority it names trustworthy.
if (!verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential))) {
  send_json(400, ['error' => "credential signature does not check out against this issuer's key"]);
}
atlas_require_demo_request($body, $credential, 'demo-clawback', atlas_demo_authority_of($credential), ['toPublicKey' => $toPublicKey]);
if (atlas_demo_suspension_state($credential['id']) === 'other') {
  send_json(409, ['error' => 'this credential is held by a suspension the demo did not make', 'code' => 'not-a-demo-suspension']);
}
$newCredential = issue_asset($kp['privateKey'], $kp['publicKeyB64url'], $toPublicKey, $credential['asset'], $credential['quantity'], $credential['id']);
atlas_revoke($credential['id'], 'clawback');
atlas_unsuspend_if_reason($credential['id'], ATLAS_DEMO_SUSPENSION_REASON);
archive_if_audited($credential, 'clawback');
send_json(200, ['newCredential' => $newCredential]);
