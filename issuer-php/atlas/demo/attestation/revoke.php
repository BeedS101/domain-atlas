<?php
// POST /atlas/demo/attestation/revoke — mirrors issuer-server/server.js's
// same route. Self-serve sibling of atlas/revoke.php, restricted to an id
// this domain's own attestation store actually issued (read_attestations(),
// not an arbitrary id) — the attestation equivalent of
// atlas/demo/login/revoke.php's own class-narrowing, just scoped by "did
// this domain really sign this" instead of by class, since an attestation
// has no class at all. Demonstrates SPEC.md §5.11's own point that an
// attestation is revoked on the ATTESTING identity's own schedule,
// independent of whatever happens to the underlying asset. Checked against
// the reviewer key (atlas_load_reviewer_keys()), not the main issuer key —
// an attestation was never signed by the latter.
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_post();
$reviewerKp = atlas_load_reviewer_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$id = $body['id'] ?? null;
if (!$id) send_json(400, ['error' => 'id is required']);

$doc = read_attestations();
$credential = null;
foreach ($doc['attestations'] as $a) {
  if ($a['id'] === $id) { $credential = $a; break; }
}
if (!$credential) send_json(400, ['error' => 'this domain has no attestation with that id']);
$busy = atlas_spend_lock($id);
if ($busy !== null) send_json(409, ['error' => $busy]);
if (is_revoked($id)) send_json(400, ['error' => 'attestation is already revoked']);

$sigOk = verify_own_credential_signature($reviewerKp['publicKeyB64url'], $credential, attestation_payload_of($credential));
if (!$sigOk) send_json(400, ['error' => "attestation signature does not check out against this domain's reviewer key"]);

atlas_revoke($id, 'demo-self-serve');
send_json(200, ['ok' => true]);
