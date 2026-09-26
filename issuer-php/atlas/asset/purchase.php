<?php
// POST /atlas/asset/purchase (SPEC.md §5.8) — mirrors issuer-server/
// server.js's same route. Spend a fungible balance to acquire a fresh
// asset of a different class, atomically: the purchased asset is minted
// FIRST, before the presented balance is touched at all, so a sold-out or
// otherwise-failing purchasedClass never debits anything. Same intent
// envelope shape as transfer.php/redeem.php — the current owner's own
// signature is what authorizes spending their own balance.
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
$purchasedClass = $body['purchasedClass'] ?? null;
$quantity = array_key_exists('quantity', $body) ? $body['quantity'] : 1;
$intent = $body['intent'] ?? null;
if (!$credential || !$purchasedClass || !$intent) {
  send_json(400, ['error' => 'credential, purchasedClass, and intent are all required']);
}
if (!atlas_is_positive_int($quantity)) {
  send_json(400, ['error' => 'quantity, when given, must be a positive integer']);
}
$quantity = (int) $quantity;
if (!isset($intent['payload']) || !isset($intent['proof'])) {
  send_json(400, ['error' => 'intent must carry payload and proof']);
}
$payload = $intent['payload'];
if (($payload['credentialId'] ?? null) !== $credential['id'] || ($payload['purchasedClass'] ?? null) !== $purchasedClass ||
    ($payload['quantity'] ?? null) !== $quantity || ($payload['action'] ?? null) !== 'purchase') {
  send_json(400, ['error' => 'intent does not authorize purchasing this class/quantity with this balance']);
}

$envelopeOk = verify_envelope($payload, $intent['proof']);
if (!$envelopeOk) send_json(400, ['error' => 'intent signature does not check out']);
$buyerPub = $intent['proof']['publicKey'];

$catalogEntry = isset(ATLAS_ASSET_CATALOG[$purchasedClass]) ? ATLAS_ASSET_CATALOG[$purchasedClass] : null;
if (!$catalogEntry || empty($catalogEntry['purchase'])) send_json(400, ['error' => 'this class is not for sale']);
if ((!isset($catalogEntry['fungible']) || $catalogEntry['fungible'] !== true) && $quantity !== 1) {
  send_json(400, ['error' => 'a non-fungible purchase is always quantity 1 — this class is not fungible']);
}

$priceClass = $catalogEntry['purchase']['priceClass'];
$totalPrice = $catalogEntry['purchase']['priceAmount'] * $quantity;
$problem = check_presented_spendable_asset($kp['publicKeyB64url'], $credential, $buyerPub, $priceClass, $totalPrice);
if ($problem) send_json(400, ['error' => $problem]);

$purchased = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $buyerPub, $purchasedClass, $quantity, null);
$remainderQty = $credential['quantity'] - $totalPrice;
$balance = $remainderQty > 0
  ? mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $buyerPub, $priceClass, $remainderQty, $credential['id'])
  : null;
atlas_revoke($credential['id'], 'superseded');
send_json(200, ['balance' => $balance, 'purchased' => $purchased]);
