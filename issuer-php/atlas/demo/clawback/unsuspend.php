<?php
// POST /atlas/demo/clawback/unsuspend — mirrors issuer-server/server.js's
// same route. The "false alarm" branch of the same walkthrough as
// suspend.php above: lifts a suspension placed by that endpoint, under
// the identical class/issuer/signature checks.
//
// No is_revoked()/is_suspended() precondition here — atlas_unsuspend()
// itself already reports whether there was anything to lift, and asking a
// demo visitor to first re-diagnose the credential's current state just
// to call this would add nothing but a redundant round trip.
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
if (!is_array($credential) || !isset($credential['asset'])) send_json(400, ['error' => 'credential is required']);
if (($credential['asset']['class'] ?? null) !== 'atlas.demo.clawback.token') {
  send_json(400, ['error' => 'this endpoint only unsuspends atlas.demo.clawback.token']);
}
if (!isset($credential['issuer']['domain']) || $credential['issuer']['domain'] !== atlas_domain()) {
  send_json(400, ['error' => 'this domain did not issue this credential']);
}
$sigOk = verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential));
if (!$sigOk) send_json(400, ['error' => "credential signature does not check out against this issuer's key"]);
$wasSuspended = atlas_unsuspend($credential['id']);
send_json(200, ['ok' => true, 'wasSuspended' => $wasSuspended]);
