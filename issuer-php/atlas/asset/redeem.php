<?php
// POST /atlas/asset/redeem — mirrors issuer-server/server.js's same route.
// A holder giving up their own credential, no recipient involved at all:
// the plainest possible revocation request, authorized by nothing but the
// holder's own signature over exactly that intent. Same envelope shape as
// transfer.php, minus the recipient field; same underlying atlas_revoke()
// every other revocation path here already calls, just reached through a
// new authorization route rather than the admin gate. Works on a bound
// credential too (see check_presented_redeemable_asset()) — voiding your
// own membership card needs no recipient to reason about.
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
$intent = $body['intent'] ?? null;
if (!$credential || !$intent) {
  send_json(400, ['error' => 'credential and intent are both required']);
}
if (!isset($intent['payload']) || !isset($intent['proof'])) {
  send_json(400, ['error' => 'intent must carry payload and proof']);
}
$payload = $intent['payload'];
if (($payload['credentialId'] ?? null) !== $credential['id'] || ($payload['action'] ?? null) !== 'redeem') {
  send_json(400, ['error' => 'intent does not authorize redeeming this credential']);
}

$envelopeOk = verify_envelope($payload, $intent['proof']);
if (!$envelopeOk) send_json(400, ['error' => 'intent signature does not check out']);
$holderPub = $intent['proof']['publicKey'];

$problem = check_presented_redeemable_asset($kp['publicKeyB64url'], $credential, $holderPub, $credential['asset']['class'] ?? null);
if ($problem) send_json(400, ['error' => $problem]);

atlas_revoke($credential['id'], 'issuer-request');
send_json(200, ['status' => 'redeemed', 'id' => $credential['id']]);
