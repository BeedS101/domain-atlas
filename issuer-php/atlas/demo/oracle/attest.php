<?php
// POST /atlas/demo/oracle/attest — mirrors issuer-server/server.js's same
// route. The independent flight-status oracle's own signed opinion about
// one flight's delay, using the SAME reviewer keypair
// attestation-demo.html's "independent reviewer" and
// reserve-bank-demo.html's "independent auditor" already play — a
// genuinely different signer than the policy-issuing key. Ungated: a real
// deployment would put this behind the oracle's own authenticated feed,
// not a public button, but the signature itself is what a verifying
// client actually relies on either way.
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_post();
$reviewerKp = atlas_load_reviewer_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$flightNumber = $body['flightNumber'] ?? null;
$delayMinutes = $body['delayMinutes'] ?? null;
if (!is_string($flightNumber) || !preg_match(ATLAS_ORACLE_FLIGHT_NUMBER_RE, $flightNumber)) {
  send_json(400, ['error' => 'flightNumber must look like a real flight code, e.g. "BA249"']);
}
if (!is_int($delayMinutes) || $delayMinutes < 0 || $delayMinutes > 1440) {
  send_json(400, ['error' => 'delayMinutes must be an integer between 0 and 1440']);
}

$attestation = issue_oracle_attestation($reviewerKp['privateKey'], $reviewerKp['publicKeyB64url'], $flightNumber, $delayMinutes);
send_json(200, ['attestation' => $attestation]);
