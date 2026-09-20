<?php
// POST /atlas/world/drops/relay-claim (task #250, SPEC.md §5.5) — mirrors
// issuer-server/server.js's own /atlas/world/drops/relay-claim handler
// exactly. The RECEIVING half of a cross-domain drop claim: another domain
// (the world's own host, having already removed the drop listing from its
// own store) asks THIS domain — the credential's actual issuer — to finish
// the ownership transfer, since only the real issuer holds the signing key
// needed to legitimately mint a replacement naming the new owner. Same
// trust model as atlas/postoffice/relay.php (SPEC.md §11.4): the relaying
// domain signs a small attestation with ITS OWN key, this domain fetches
// that domain's published key and verifies the attestation against it,
// with no prior handshake needed.
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
if (!$credential || !$attestation || !$attestationSignature) {
  send_json(400, ['error' => 'credential, attestation, and attestationSignature are all required']);
}
if (empty($credential['asset']) || empty($credential['issuer']) || $credential['issuer']['domain'] !== atlas_domain()) {
  send_json(400, ['error' => 'this domain did not issue that credential']);
}
if (($attestation['credentialId'] ?? null) !== $credential['id']) {
  send_json(400, ['error' => 'attestation does not name the credential it was sent with']);
}
if (is_revoked($credential['id'])) {
  send_json(400, ['error' => 'that credential has already been revoked — nothing to claim']);
}

$ownSignatureOk = verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential));
if (!$ownSignatureOk) {
  send_json(400, ['error' => "credential signature does not check out against this domain's own key"]);
}

try {
  $relayingDomainKey = fetch_domain_public_key($attestation['relayingDomain']);
} catch (Exception $e) {
  send_json(502, ['error' => "could not verify " . $attestation['relayingDomain'] . "'s own published key: " . $e->getMessage()]);
}
$attestationOk = verify_domain_signature($relayingDomainKey, $attestation, $attestationSignature);
if (!$attestationOk) {
  send_json(400, ['error' => $attestation['relayingDomain'] . "'s attestation signature does not check out"]);
}

$received = fulfill_world_drop_claim($kp, $credential, $attestation['claimantPublicKey']);
send_json(200, ['status' => 'claimed', 'credential' => $received]);
