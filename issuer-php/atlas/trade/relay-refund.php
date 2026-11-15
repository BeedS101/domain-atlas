<?php
// POST /atlas/trade/relay-refund — the UNDO half of a cross-domain Trading Station settlement. The first leg of a trade spent
// a balance this domain issued and minted a credit for the poster. When the poster's issuer then refuses the second leg for
// good, the station asks this domain to take that credit back and pay the balance's own owner the same value, so the
// claimant is neither out of pocket nor paid twice. Same attestation-and-verify shape and the same trusted-peer gate as
// relay-lock.php and relay-settle.php. The refund goes to the owner named by the presented credential, never to a party the
// attestation names, and only for a leg this domain's own journal shows as settled for this trade. Recorded as a journalled
// replacement (refund_failed_second_leg() in lib/bootstrap.php), so asking again returns the same credential.
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
if (empty($credential['asset']) || empty($credential['issuer']) || $credential['issuer']['domain'] !== atlas_domain() || empty($credential['owner']['publicKey'])) {
  send_json(400, ['error' => 'this domain did not issue that credential']);
}
if (($attestation['credentialId'] ?? null) !== $credential['id']) {
  send_json(400, ['error' => 'attestation does not name the credential it was sent with']);
}
$relayingDomain = $attestation['relayingDomain'] ?? null;
$tradeId = $attestation['tradeId'] ?? null;
if (!$relayingDomain || !$tradeId) {
  send_json(400, ['error' => 'attestation must carry relayingDomain and tradeId']);
}
if (!atlas_is_trusted_trade_peer($relayingDomain)) {
  send_json(403, ['error' => 'this domain does not accept trade relays from ' . $relayingDomain]);
}

if (!verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential))) {
  send_json(400, ['error' => "credential signature does not check out against this domain's own key"]);
}
try {
  $relayingDomainKey = fetch_domain_public_key($relayingDomain);
} catch (Exception $e) {
  send_json(502, ['error' => 'could not verify ' . $relayingDomain . "'s own published key: " . $e->getMessage()]);
}
if (!verify_domain_signature($relayingDomainKey, $attestation, $attestationSignature)) {
  send_json(400, ['error' => $relayingDomain . "'s attestation signature does not check out"]);
}

$outcome = atlas_trade_leg_outcome($tradeId, $credential);
if ($outcome['state'] === 'busy') send_json(409, ['error' => 'this balance is being settled by another request - try again', 'code' => 'busy']);
if ($outcome['state'] === 'refunded') {
  send_json(200, ['status' => 'refunded', 'refund' => $outcome['refund'], 'remainder' => $outcome['leg']['remainder'] ?? null]);
}
if ($outcome['state'] === 'none' || !is_revoked($credential['id'])) {
  send_json(400, ['error' => 'no settled leg of this trade is recorded for that balance, so there is nothing to refund']);
}
try {
  $received = $outcome['leg']['received'];
  $refund = refund_failed_second_leg($kp, $received, ['class' => $received['asset']['class'], 'quantity' => $received['quantity']], $credential['owner']['publicKey']);
} catch (Exception $e) {
  send_json(409, ['error' => 'could not refund this trade leg: ' . $e->getMessage()]);
}
send_json(200, ['status' => 'refunded', 'refund' => $refund, 'remainder' => $outcome['leg']['remainder'] ?? null]);
