<?php
// POST /atlas/demo/oracle/payout/claim — mirrors issuer-server/server.js's
// same route. The one endpoint that actually combines both primitives:
// presenting the held policy credential (bearer-but-verified, same intent-
// envelope shape atlas/asset/purchase.php already uses — the holder's own
// signature is what authorizes claiming against their own policy)
// alongside an oracle attestation triggers an automatic payout, with
// every check that makes this more than "anyone can mint themselves
// money": the policy must genuinely be this domain's own, held by the
// claimant, and not already paid out; the attestation must genuinely
// carry this domain's own oracle signature, be about the SAME flight this
// policy covers, and clear this policy's fixed delay threshold.
//
// The actual find/validate-claimed/mutate/write sequence against the
// policy store lives in claim_oracle_policy() (lib/store.php), one
// exclusive lock held across the whole thing — see that function's own
// comment for why a bare read-then-write would race here, the same
// reasoning cast_governance_vote() already established.
require_once __DIR__ . '/../../../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();
$reviewerKp = atlas_load_reviewer_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$credential = $body['credential'] ?? null;
$attestation = $body['attestation'] ?? null;
$intent = $body['intent'] ?? null;
if (!$credential || !$attestation || !$intent) {
  send_json(400, ['error' => 'credential, attestation, and intent are all required']);
}
if (!isset($intent['payload']) || !isset($intent['proof'])) {
  send_json(400, ['error' => 'intent must carry payload and proof']);
}
$payload = $intent['payload'];
if (($payload['policyId'] ?? null) !== $credential['id'] || ($payload['action'] ?? null) !== 'claim-payout') {
  send_json(400, ['error' => 'intent does not authorize claiming a payout on this policy']);
}

$envelopeOk = verify_envelope($payload, $intent['proof']);
if (!$envelopeOk) send_json(400, ['error' => 'intent signature does not check out']);
$holderPub = $intent['proof']['publicKey'];

$problem = check_presented_membership($kp['publicKeyB64url'], $credential, $holderPub, 'atlas.demo.insurance.policy');
if ($problem) send_json(400, ['error' => $problem]);

// The attestation's SIGNATURE is verified here, before the policy store
// is ever touched by claim_oracle_policy() below.
$attestationOk = isset($attestation['issuer']['publicKey']) && $attestation['issuer']['publicKey'] === $reviewerKp['publicKeyB64url'] &&
  verify_own_credential_signature($reviewerKp['publicKeyB64url'], $attestation, oracle_attestation_payload_of($attestation));
if (!$attestationOk) send_json(400, ["error" => "attestation signature does not check out against this domain's own oracle key"]);

$result = claim_oracle_policy($credential['id'], $attestation['flightNumber'] ?? null, $attestation['delayMinutes'] ?? null);
if (isset($result['error'])) {
  $status = ($result['error'] === 'no policy record on file for this credential') ? 404 : 400;
  send_json($status, ['error' => $result['error']]);
}
$policy = $result['policy'];

// Deliberately does NOT revoke the policy credential itself — see
// claim_oracle_policy()'s own comment: its `claimed` flag is already the
// sole, atomic guard against a double payout, and leaving the credential
// unrevoked means a second presentation is rejected for the actually-
// relevant reason ("already paid out") rather than a generic "revoked".
$payout = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $holderPub, 'atlas.demo.insurance.payout', $policy['payoutAmount'], null);
$policy['payoutCredentialId'] = $payout['id'];
save_oracle_policy($policy);
send_json(200, ['payout' => $payout, 'policy' => $policy]);
