<?php
// POST /atlas/world/drops/relay-claim (SPEC.md §5.5) — mirrors issuer-server/server.js's own
// /atlas/world/drops/relay-claim handler. The RECEIVING half of a cross-domain drop claim: another domain (the
// world's own host, having already removed the drop listing from its own store) asks THIS domain — the credential's
// actual issuer — to finish the ownership transfer, since only the real issuer holds the signing key needed to mint a
// replacement naming the new owner.
//
// The relaying domain signs a small attestation with ITS OWN key, which this domain verifies against that domain's
// published key (same model as atlas/postoffice/relay.php, SPEC.md §11.4). That proves who sent the request. It does
// not prove the owner placed the credential there, so the request must also carry the owner's signed drop intent
// (naming the credential, the relaying domain, the world and the drop) and the claimant's signed claim intent
// (atlas_world_drop_relay_problem()). Settlement goes through the replacement journal.
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
$attestation = $body['attestation'] ?? null;
$attestationSignature = $body['attestationSignature'] ?? null;
$dropIntent = $body['dropIntent'] ?? null;
$claimIntent = $body['claimIntent'] ?? null;
if (!$credential || !$attestation || !$attestationSignature) {
  send_json(400, ['error' => 'credential, attestation, and attestationSignature are all required']);
}
if (empty($credential['asset']) || empty($credential['issuer']) || $credential['issuer']['domain'] !== atlas_domain()) {
  send_json(400, ['error' => 'this domain did not issue that credential']);
}
if (($attestation['credentialId'] ?? null) !== $credential['id']) {
  send_json(400, ['error' => 'attestation does not name the credential it was sent with']);
}
foreach (['relayingDomain', 'claimantPublicKey', 'dropId', 'world'] as $field) {
  if (!is_string($attestation[$field] ?? null)) send_json(400, ['error' => 'attestation must name the relaying domain, world, drop and claimant']);
}
$ownSignatureOk = verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential));
if (!$ownSignatureOk) {
  send_json(400, ['error' => "credential signature does not check out against this domain's own key"]);
}

// The relaying domain's signature says who sent this request. Whether the credential may move at all rests on the
// owner's own signed drop intent and the claimant's own signed claim, both checked here.
$refusal = atlas_world_drop_relay_problem($credential, $attestation, $dropIntent, $claimIntent);
if ($refusal !== null) send_json($refusal[0], ['error' => $refusal[1], 'code' => $refusal[2]]);

try {
  $relayingDomainKey = fetch_domain_public_key($attestation['relayingDomain']);
} catch (Exception $e) {
  send_json(502, ['error' => "could not verify " . $attestation['relayingDomain'] . "'s own published key: " . $e->getMessage()]);
}
$attestationOk = verify_domain_signature($relayingDomainKey, $attestation, $attestationSignature);
if (!$attestationOk) {
  send_json(400, ['error' => $attestation['relayingDomain'] . "'s attestation signature does not check out"]);
}

atlas_settle_world_drop_claim($kp, $credential, $attestation['claimantPublicKey'], $attestation['dropId'], $attestation['relayingDomain']);
