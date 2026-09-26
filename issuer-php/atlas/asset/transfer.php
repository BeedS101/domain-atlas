<?php
// POST /atlas/asset/transfer — mirrors issuer-server/server.js's same
// route. Direct, one-sided transfer: send a held non-fungible credential
// straight to a named recipient's public key, no listing posted, no
// matching counter-offer, no world to drop it in first — the simplest
// possible "give this to someone else" primitive this bundle offers,
// alongside the heavier Trading Station (needs a matched intent) and World
// Drops (needs a world and a claimant to walk up) mechanisms, without
// replacing either.
//
// Input: {credential, recipientPublicKey, intent: {payload: {credentialId,
// recipientPublicKey, action: 'transfer'}, proof}} — the sender's own
// signature over exactly what it authorizes, same envelope shape
// /atlas/trade/submit and /atlas/world/drop already use for theirs.
// Ungated beyond that signature: sending something you hold to someone
// else needs no admin approval, same posture split/consolidate/trade
// already take for a visitor's own holdings.
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
$recipientPublicKey = $body['recipientPublicKey'] ?? null;
$intent = $body['intent'] ?? null;
if (!$credential || !$recipientPublicKey || !$intent) {
  send_json(400, ['error' => 'credential, recipientPublicKey, and intent are all required']);
}
if (!isset($intent['payload']) || !isset($intent['proof'])) {
  send_json(400, ['error' => 'intent must carry payload and proof']);
}
$payload = $intent['payload'];
if (($payload['credentialId'] ?? null) !== $credential['id'] || ($payload['recipientPublicKey'] ?? null) !== $recipientPublicKey || ($payload['action'] ?? null) !== 'transfer') {
  send_json(400, ['error' => 'intent does not authorize transferring this credential to this recipient']);
}

$envelopeOk = verify_envelope($payload, $intent['proof']);
if (!$envelopeOk) send_json(400, ['error' => 'intent signature does not check out']);
$senderPub = $intent['proof']['publicKey'];

if ($recipientPublicKey === $senderPub) send_json(400, ['error' => 'cannot transfer a credential to yourself']);

$problem = check_presented_giftable_asset($kp['publicKeyB64url'], $credential, $senderPub, $credential['asset']['class'] ?? null);
if ($problem) send_json(400, ['error' => $problem]);

$received = transfer_unique_asset($kp['privateKey'], $kp['publicKeyB64url'], $recipientPublicKey, $credential);
atlas_revoke($credential['id'], 'transferred');
send_json(200, ['status' => 'transferred', 'credential' => $received]);
