<?php
// POST /atlas/asset/transfer-to-email — mirrors issuer-server/server.js's
// same route (SPEC.md §13.1's "entering the system"): atlas/asset/
// transfer.php's own sibling, targeting an email address instead of a
// recipient's public key. Verification is transfer.php's own
// (check_presented_giftable_asset), gated additionally on this domain
// actually having SMTP delivery configured right now — rejected outright
// if it doesn't. Once authorized, the presented credential is revoked
// (reason 'email-transferred') and a fresh one minted exactly as
// transfer.php already does for a wallet-to-wallet move, with one
// necessary difference: owner.publicKey on the freshly minted credential
// is a keypair generated and immediately discarded
// (generate_discarded_owner_public_key()) — there is no wallet on the
// receiving end for it to belong to. Mint-before-revoke, same ordering
// every other credential-replacing route in this bundle already uses: the
// fresh credential is minted and the outbound send attempted before the
// presented one is revoked, so a send the mail server never actually
// accepts leaves the sender exactly as they were.
require_once __DIR__ . '/../../lib/bootstrap.php';
require_once __DIR__ . '/../../lib/smtp.php';
require_once __DIR__ . '/../../lib/delivery.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$credential = $body['credential'] ?? null;
$recipientEmail = $body['recipientEmail'] ?? null;
$intent = $body['intent'] ?? null;
if (!$credential || !$recipientEmail || !$intent) {
  send_json(400, ['error' => 'credential, recipientEmail, and intent are all required']);
}
if (!preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $recipientEmail)) {
  send_json(400, ['error' => 'recipientEmail does not look like an email address']);
}
if (!isset($intent['payload']) || !isset($intent['proof'])) {
  send_json(400, ['error' => 'intent must carry payload and proof']);
}
$payload = $intent['payload'];
if (($payload['credentialId'] ?? null) !== $credential['id'] || ($payload['recipientEmail'] ?? null) !== $recipientEmail || ($payload['action'] ?? null) !== 'transfer-to-email') {
  send_json(400, ['error' => 'intent does not authorize transferring this credential to this address']);
}

$emailGate = atlas_evaluate_delivery_gate(['transport' => 'email', 'stage' => 'enabled', 'config' => ['emailConfigured' => atlas_email_delivery_configured()]]);
if (!$emailGate['ok']) send_json(400, ['error' => $emailGate['message']]);

$envelopeOk = verify_envelope($payload, $intent['proof']);
if (!$envelopeOk) send_json(400, ['error' => 'intent signature does not check out']);
$senderPub = $intent['proof']['publicKey'];
// The domain sends this mail from its own mailbox, so only a registered
// domain admin may ask for it.
$actorGate = atlas_evaluate_delivery_gate(['transport' => 'email', 'stage' => 'actor', 'actor' => ['isAdmin' => is_admin_key($senderPub)]]);
if (!$actorGate['ok']) send_json($actorGate['status'] ?? 403, ['error' => $actorGate['message']]);

// Taken before anything else is read, so a second request for the same
// credential waits here and then sees what the first one did.
$busy = atlas_spend_lock($credential['id']);
if ($busy !== null) send_json(400, ['error' => $busy]);

// A delivery of this credential already exists: it is never started twice.
// The same signer asking again for the same address gets the same answer the
// first request would have; anything else is told why not.
$sameRequest = function ($rec) use ($senderPub, $recipientEmail) {
  return ($rec['ownerPublicKey'] ?? null) === $senderPub && ($rec['recipientHash'] ?? null) === atlas_delivery_hash_recipient($recipientEmail);
};
$prior = atlas_delivery_latest_for_key($credential['id']);
if ($prior !== null && $prior['state'] === 'delivered') {
  if ($sameRequest($prior)) send_json(200, ['status' => 'email-transferred', 'to' => $recipientEmail]);
  send_json(409, ['error' => 'this asset has already been delivered', 'code' => 'already-delivered']);
}
if ($prior !== null && $prior['state'] !== 'rolled-back') {
  if (!$sameRequest($prior)) send_json(409, ['error' => 'a delivery of this asset is already in progress', 'code' => 'in-progress']);
  $resumed = atlas_delivery_run($prior['deliveryId'], ['waitSeconds' => 2]);
  if ($resumed['busy']) send_json(409, ['error' => 'a delivery of this asset is already in progress', 'code' => 'in-progress']);
  atlas_answer_email_delivery($resumed['rec'], $recipientEmail);
}

$problem = check_presented_giftable_asset($kp['publicKeyB64url'], $credential, $senderPub, $credential['asset']['class'] ?? null, 'email');
if ($problem) send_json(400, ['error' => $problem]);

$discardedOwnerKey = generate_discarded_owner_public_key();
$minted = transfer_unique_asset($kp['privateKey'], $kp['publicKeyB64url'], $discardedOwnerKey, $credential);
file_export_fault_point('delivery:minted');
$began = atlas_delivery_begin([
  'key' => $credential['id'], 'kind' => 'wallet-original', 'class' => $credential['asset']['class'] ?? null,
  'ownerPublicKey' => $senderPub, 'original' => $credential, 'minted' => $minted, 'recipient' => $recipientEmail,
]);
if (isset($began['existing'])) {
  // Another request got there between the checks and here; the credential
  // minted above was never recorded or listed.
  atlas_revoke($minted['id'], 'issuer-request');
  send_json(409, ['error' => 'a delivery of this asset is already in progress', 'code' => 'in-progress']);
}
$outcome = atlas_delivery_run($began['rec']['deliveryId']);
atlas_answer_email_delivery($outcome['rec'], $recipientEmail);
