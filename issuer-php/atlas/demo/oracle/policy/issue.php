<?php
// POST /atlas/demo/oracle/policy/issue — mirrors issuer-server/server.js's
// same route. Mints a bound atlas.demo.insurance.policy credential and
// records its flight/payout terms in atlas-oracle-policies-store.json,
// keyed by the fresh credential's own id — the generic asset credential
// shape (SPEC.md §5) has no room for per-instance fields like that.
// Ungated, same "plays the privileged role for a live visitor" reasoning
// as every other /atlas/demo/* issuance route — a real deployment would
// sell this behind an actual premium payment, not a free click.
require_once __DIR__ . '/../../../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$ownerPublicKey = $body['ownerPublicKey'] ?? null;
$flightNumber = $body['flightNumber'] ?? null;
$payoutAmount = $body['payoutAmount'] ?? null;
if (!$ownerPublicKey) send_json(400, ['error' => 'ownerPublicKey is required']);
if (!is_string($flightNumber) || !preg_match(ATLAS_ORACLE_FLIGHT_NUMBER_RE, $flightNumber)) {
  send_json(400, ['error' => 'flightNumber must look like a real flight code, e.g. "BA249"']);
}
if (!atlas_is_positive_int($payoutAmount) || $payoutAmount > 1000000) {
  send_json(400, ['error' => 'payoutAmount must be a positive integer up to 1,000,000']);
}
$payoutAmount = (int) $payoutAmount;

$policy = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $ownerPublicKey, 'atlas.demo.insurance.policy', 1, null);
save_oracle_policy([
  'credentialId' => $policy['id'], 'ownerPublicKey' => $ownerPublicKey, 'flightNumber' => $flightNumber,
  'payoutAmount' => $payoutAmount, 'claimed' => false, 'payoutCredentialId' => null,
]);
send_json(200, ['policy' => $policy, 'flightNumber' => $flightNumber, 'payoutAmount' => $payoutAmount, 'thresholdMinutes' => ATLAS_ORACLE_DELAY_PAYOUT_THRESHOLD_MINUTES]);
