<?php
// POST /atlas/asset/claim-from-file — mirrors issuer-server/server.js's same
// route (SPEC.md §13.5). The claimer signs an intent with the key that
// should own the asset. The file's credential must be listed in the bearer
// registry: anyone can copy any credential, so being validly signed by this
// domain is not enough. The claim is committed (a record holding the
// claimer's key and the minted credential, SPEC.md §13.5.2) before the
// registry entry is consumed, so simultaneous claims have exactly one winner
// and a claim that stopped part-way is finished by the next request for the
// file.
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
if (!is_array($credential) || !isset($credential['id']) || !$intent) {
  send_json(400, ['error' => 'credential and intent are both required']);
}
if (!isset($intent['payload']) || !isset($intent['proof'])) {
  send_json(400, ['error' => 'intent must carry payload and proof']);
}
$payload = $intent['payload'];
$newOwner = $payload['newOwnerPublicKey'] ?? null;
if (($payload['credentialId'] ?? null) !== $credential['id'] || ($payload['action'] ?? null) !== 'claim-from-file' || !is_string($newOwner) || $newOwner === '') {
  send_json(400, ['error' => 'intent does not authorize claiming this credential']);
}
if (($intent['proof']['publicKey'] ?? null) !== $newOwner) {
  send_json(400, ['error' => 'the claim must be signed by the key that will own the asset']);
}
$envelopeOk = verify_envelope($payload, $intent['proof']);
if (!$envelopeOk) send_json(400, ['error' => 'intent signature does not check out']);

if (!isset($credential['issuer']['domain']) || $credential['issuer']['domain'] !== atlas_domain()) {
  send_json(400, ['error' => 'this file was issued by another domain; claim it there', 'code' => 'wrong-domain']);
}

// Exports and claims run one at a time: a second claim of this file waits
// here, then finds it revoked.
$lock = atlas_bearer_lock();

$identity = atlas_evaluate_transfer_policy(['profile' => 'bearer-claim:identity', 'credential' => $credential, 'facts' => atlas_gather_transfer_facts($kp['publicKeyB64url'], $credential)]);
if (!$identity['ok']) send_json(400, ['error' => $identity['message'], 'code' => $identity['wireCode'] ?? null]);

// A claim already committed for this file is finished first, whoever is
// asking. The key that committed it gets its credential again; any other key
// is told the file is claimed.
if (file_claim_of(read_file_claims(), $credential['id']) !== null) {
  $done = finish_file_claim($credential['id'], $credential);
  if ($done['claimantPublicKey'] === $newOwner && isset($done['minted'])) {
    send_json(200, ['status' => 'claimed', 'credential' => $done['minted']]);
  }
  $answer = ['error' => 'this file has already been claimed or withdrawn', 'code' => 'already-claimed'];
  if ($done['claimantPublicKey'] === $newOwner) {
    $answer['receipt'] = ['claimId' => $done['claimId'], 'mintedId' => $done['mintedId'], 'claimedAt' => $done['claimedAt'] ?? null];
  }
  send_json(409, $answer);
}

$state = atlas_evaluate_transfer_policy([
  'profile' => 'bearer-claim:state',
  'credential' => $credential,
  'facts' => atlas_gather_transfer_facts($kp['publicKeyB64url'], $credential),
  'classPolicy' => atlas_class_transfer_policy($credential['asset']['class'] ?? null),
  'operation' => 'transfer',
  'transport' => 'file',
]);
if (!$state['ok']) {
  $wire = $state['wireCode'] ?? null;
  send_json(($wire === 'already-claimed' || $wire === 'suspended') ? 409 : 400, ['error' => $state['message'], 'code' => $wire]);
}

// Nothing has been written yet, so a failed mint changes nothing. From the
// record write onwards the claim is committed.
try {
  $minted = transfer_unique_asset($kp['privateKey'], $kp['publicKeyB64url'], $newOwner, $credential);
} catch (Exception $e) {
  send_json(500, ['error' => 'could not mint the claimed asset']);
}
file_export_fault_point('claim:minted');
create_file_claim($credential, $minted, $newOwner);
finish_file_claim($credential['id'], $credential);
send_json(200, ['status' => 'claimed', 'credential' => $minted]);
