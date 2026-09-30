<?php
// POST /atlas/demo/clawback/clawback — mirrors issuer-server/server.js's
// same route. Self-serve sibling of the real, admin-gated
// atlas/clawback.php (SPEC.md §5.12), hardcoded the same way as
// suspend.php/unsuspend.php above.
//
// Confirms SPEC.md §5.12's own framing that clawback finds a stolen asset
// wherever it currently sits: toPublicKey only has to differ from the
// credential's CURRENT owner, not from whoever first held it, so the
// demo's optional thief-to-fence laundering hop makes no difference to
// this check. No roster to fix up here — atlas.demo.clawback.token is
// never a membership credential — so this mirrors the real endpoint's
// core three steps only (reissue, revoke, archive) and skips its
// mail-delivery and roster fix-up, which exist there for classes this
// demo class was never meant to touch.
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
$toPublicKey = $body['toPublicKey'] ?? null;
if (!is_array($credential) || !isset($credential['asset'])) send_json(400, ['error' => 'credential is required']);
if (!$toPublicKey) send_json(400, ['error' => 'toPublicKey is required']);
if (!in_array($credential['asset']['class'] ?? null, atlas_demo_suspendable_classes(), true)) {
  send_json(400, ['error' => 'this endpoint only claws back: ' . implode(', ', atlas_demo_suspendable_classes())]);
}
if (!isset($credential['issuer']['domain']) || $credential['issuer']['domain'] !== atlas_domain()) {
  send_json(400, ['error' => 'this domain did not issue this credential']);
}
if ($toPublicKey === ($credential['owner']['publicKey'] ?? null)) {
  send_json(400, ['error' => "toPublicKey already matches the credential's current owner — nothing to claw back"]);
}
if (is_revoked($credential['id'])) send_json(400, ['error' => 'credential is already revoked — nothing to claw back']);
$sigOk = verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential));
if (!$sigOk) send_json(400, ['error' => "credential signature does not check out against this issuer's key"]);

$newCredential = issue_asset($kp['privateKey'], $kp['publicKeyB64url'], $toPublicKey, $credential['asset'], $credential['quantity'], $credential['id']);
atlas_revoke($credential['id'], 'clawback');
archive_if_audited($credential, 'clawback');
send_json(200, ['newCredential' => $newCredential]);
