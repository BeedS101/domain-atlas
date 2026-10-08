<?php
// POST /atlas/asset/claim-from-file — mirrors issuer-server/server.js's same
// route (SPEC.md §13.5). The claimer signs an intent with the key that
// should own the asset. The file's credential must be listed in the bearer
// registry: anyone can copy any credential, so being validly signed by this
// domain is not enough. The registry entry is consumed before anything is
// minted, so simultaneous claims of one file have exactly one winner.
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

if (($credential['credential'] ?? null) !== 'domain-atlas-asset/1.0' || !isset($credential['asset']) || !is_array($credential['asset'])) {
  send_json(400, ['error' => 'not an asset credential', 'code' => 'not-claimable']);
}
if (!verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential))) {
  send_json(400, ['error' => 'asset signature does not check out', 'code' => 'not-claimable']);
}
if (is_revoked($credential['id'])) send_json(409, ['error' => 'this file has already been claimed or withdrawn', 'code' => 'already-claimed']);
if (is_suspended($credential['id'])) send_json(409, ['error' => 'this asset is currently suspended pending review', 'code' => 'suspended']);
if (is_expired($credential)) send_json(400, ['error' => 'asset has expired', 'code' => 'expired']);
if (!isset($credential['asset']['fungible']) || $credential['asset']['fungible'] !== false) {
  send_json(400, ['error' => 'only a unique item can be claimed from a file', 'code' => 'not-claimable']);
}
if (isset($credential['asset']['tradeScope']) && $credential['asset']['tradeScope'] === 'bound') {
  send_json(400, ['error' => 'asset is bound and cannot be claimed from a file', 'code' => 'not-claimable']);
}

// The reservation: from here on no other claim can take this id.
$taken = take_bearer($credential['id']);
if ($taken === null) send_json(400, ['error' => 'this is not a transfer file issued by this domain', 'code' => 'not-claimable']);

try {
  $minted = transfer_unique_asset($kp['privateKey'], $kp['publicKeyB64url'], $newOwner, $credential);
} catch (Exception $e) {
  restore_bearer($credential['id'], $taken);
  send_json(500, ['error' => 'could not mint the claimed asset']);
}
atlas_revoke($credential['id'], 'file-claimed');
archive_if_audited($credential, 'file-claimed');
try { note_file_claimed($credential['id'], $minted['id']); } catch (Throwable $e) { /* the receipt is derived at the next recovery instead */ }
send_json(200, ['status' => 'claimed', 'credential' => $minted]);
