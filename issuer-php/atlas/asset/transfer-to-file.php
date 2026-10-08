<?php
// POST /atlas/asset/transfer-to-file — mirrors issuer-server/server.js's
// same route (SPEC.md §13.5): export a held non-fungible credential as a
// claimable file. The owner signs an intent; the domain mints a fresh
// credential owned by a discarded key, lists its id in the bearer registry,
// revokes the owner's credential (reason 'file-transferred') and returns
// the new credential as `file`. Whoever claims the file first
// (claim-from-file.php) becomes its owner.
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
if (($payload['credentialId'] ?? null) !== $credential['id'] || ($payload['action'] ?? null) !== 'transfer-to-file') {
  send_json(400, ['error' => 'intent does not authorize exporting this credential to a file']);
}

$fileConfig = file_transfer_config();
if (!$fileConfig) {
  send_json(400, ['error' => 'this domain has not enabled file transfers (SPEC.md §13.5)', 'code' => 'not-enabled']);
}

$envelopeOk = verify_envelope($payload, $intent['proof']);
if (!$envelopeOk) send_json(400, ['error' => 'intent signature does not check out']);
$senderPub = $intent['proof']['publicKey'];

$assetClass = $credential['asset']['class'] ?? null;
if ($fileConfig['classes'] !== null && !in_array($assetClass, $fileConfig['classes'], true)) {
  send_json(400, ['error' => 'this domain does not allow ' . $assetClass . ' to be exported to a file', 'code' => 'class-not-allowed']);
}

// Exports and claims run one at a time: a second export of this credential
// waits here, then finds it revoked.
$lock = atlas_bearer_lock();

$problem = check_presented_giftable_asset($kp['publicKeyB64url'], $credential, $senderPub, $assetClass);
if ($problem) send_json(400, ['error' => $problem]);

$discardedOwnerKey = generate_discarded_owner_public_key();
$minted = transfer_unique_asset($kp['privateKey'], $kp['publicKeyB64url'], $discardedOwnerKey, $credential);
register_bearer($minted['id'], $assetClass);
atlas_revoke($credential['id'], 'file-transferred');
archive_if_audited($credential, 'file-transferred');
send_json(200, ['status' => 'file-transferred', 'file' => $minted]);
