<?php
// POST /atlas/demo/clawback/suspend — mirrors issuer-server/server.js's
// same route. Self-serve sibling of the real, admin-gated suspend action
// behind atlas/clawback.php (SPEC.md §5.3), gated to
// atlas_demo_suspendable_classes() (originally just
// atlas.demo.clawback.token; widened for reserve-bank-demo.html's own
// fraud act) — no admin auth at all.
//
// clawback-demo.html has no admin login to freeze a credential with, so —
// same "plays the privileged role" reasoning as every other
// atlas/demo/* route — this lets the credential's own currently-valid
// signature stand in for that authority: whoever can still produce a
// full, correctly signed copy of the credential is treated as "the
// rightful reporter of its own theft/fraud" for these toy classes, never
// anything else in ASSET_CATALOG. Deliberately does NOT check who
// currently owns it — a stolen credential's whole point is that it no
// longer sits with the person who can prove they minted it, so ownership
// can't be the gate here the way it is for an ordinary transfer.
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
if (!in_array($credential['asset']['class'] ?? null, atlas_demo_suspendable_classes(), true)) {
  send_json(400, ['error' => 'this endpoint only suspends: ' . implode(', ', atlas_demo_suspendable_classes())]);
}
if (!isset($credential['issuer']['domain']) || $credential['issuer']['domain'] !== atlas_domain()) {
  send_json(400, ['error' => 'this domain did not issue this credential']);
}
if (is_revoked($credential['id'])) send_json(400, ['error' => 'credential is already revoked']);
$sigOk = verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential));
if (!$sigOk) send_json(400, ['error' => "credential signature does not check out against this issuer's key"]);
atlas_suspend($credential['id'], 'demo-fraud-report', null);
send_json(200, ['ok' => true]);
