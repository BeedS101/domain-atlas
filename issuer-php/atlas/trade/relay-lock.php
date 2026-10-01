<?php
// POST /atlas/trade/relay-lock (SPEC.md §7, v1.29) — the LOCK half of a
// cross-domain Trading Station settlement's two-phase commit. Another
// domain's station, about to settle a trade that touches a balance THIS
// domain issued, asks this domain to atlas_suspend() that balance for the
// pending trade before either side of the trade mutates anything — so a
// failure partway through the other domain's own settlement can never
// leave one side spent and the other not. Same attestation-and-verify
// shape as atlas/world/drops/relay-claim.php: the relaying domain signs a
// small attestation with ITS OWN key, this domain fetches that domain's
// published key and verifies the attestation against it, with no prior
// handshake needed.
//
// Gated on atlas_is_trusted_trade_peer() (lib/store.php) — a signature
// check alone only proves the relaying domain sent this, not that this
// domain is willing to let that domain direct what happens to a balance
// it never got the credential's actual owner's own fresh signature for.
// Default (empty list) rejects every relay outright, same posture
// check_presented_asset()'s own foreign-balance branch already takes from
// the other side of this exact trade.
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
if (empty($attestation['tradeId']) || empty($attestation['relayingDomain']) || empty($attestation['expiresAt'])) {
  send_json(400, ['error' => 'attestation must carry tradeId, relayingDomain, and expiresAt']);
}

$relayingDomain = $attestation['relayingDomain'];
if (!atlas_is_trusted_trade_peer($relayingDomain)) {
  send_json(403, ['error' => 'this domain does not accept trade relays from ' . $relayingDomain]);
}

if (is_revoked($credential['id'])) {
  send_json(400, ['error' => 'that balance has already been revoked']);
}
// Any existing suspension that isn't THIS exact trade's own lock — whether
// it's a different pending trade or an unrelated admin review — means this
// balance isn't free to lock right now.
$existing = find_suspension($credential['id']);
if ($existing && $existing['reason'] !== 'trade-lock:' . $attestation['tradeId']) {
  send_json(409, ['error' => 'that balance is already locked or suspended for something else']);
}
if (is_expired($credential)) {
  send_json(400, ['error' => 'that balance has already expired']);
}

$ownSignatureOk = verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential));
if (!$ownSignatureOk) {
  send_json(400, ['error' => "credential signature does not check out against this domain's own key"]);
}

try {
  $relayingDomainKey = fetch_domain_public_key($relayingDomain);
} catch (Exception $e) {
  send_json(502, ['error' => "could not verify " . $relayingDomain . "'s own published key: " . $e->getMessage()]);
}
$attestationOk = verify_domain_signature($relayingDomainKey, $attestation, $attestationSignature);
if (!$attestationOk) {
  send_json(400, ['error' => $relayingDomain . "'s attestation signature does not check out"]);
}

// A short, station-chosen expiry (SPEC.md §7 — ~120s in practice) rather
// than a separate relay-unlock endpoint: an abandoned or failed trade just
// lifts itself, the same self-healing find_suspension() already gives
// every other suspension in this bundle, instead of standing up a second
// code path that itself needs to be reachable and trusted to run.
atlas_suspend($credential['id'], 'trade-lock:' . $attestation['tradeId'], $attestation['expiresAt']);
send_json(200, ['status' => 'locked', 'expiresAt' => $attestation['expiresAt']]);
