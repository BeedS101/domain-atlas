<?php
// POST /atlas/mail/send — mirrors issuer-server/server.js's same route.
//
// This is the demo/admin side of the mail system: standing in for
// whatever real interface a domain operator would actually use to write
// to members (this bundle has no such interface, so a plain endpoint
// fills in for it — you'd call this from a small admin script, a cron
// job, or curl, not from the wallet). It doesn't check that credentialId
// was really issued by this server — same demo-simplification level as
// the rest of this bundle, which trusts its own caller.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$credentialId = $body['credentialId'] ?? null;
$subject = $body['subject'] ?? null;
$msgBody = $body['body'] ?? null;
if (!$credentialId || !$subject || !$msgBody) {
  send_json(400, ['error' => 'credentialId, subject, and body are required']);
}

// Task #59: a message can optionally carry an attached asset gift —
// giftAssetClass/giftOwnerPublicKey/(giftQuantity for a fungible class).
// Mirrors issue.php's own ATLAS_ASSET_CATALOG lookup and fungible/quantity
// validation exactly — a gift is always fresh NEW supply (supersedes
// null), never a reissue. The resulting credential goes into the mail
// payload as attachedAsset BEFORE signing, so the mail signature covers
// it too — see server.js's identical note on why that ordering matters.
// Same as the Node route, this does NOT add the gift to the recipient's
// wallet automatically — see extension/wallet.js's claimMailGift() for
// the explicit-Claim path that's the only way a gift is ever adopted.
$giftAssetClass = $body['giftAssetClass'] ?? null;
$giftOwnerPublicKey = $body['giftOwnerPublicKey'] ?? null;
$giftQuantity = $body['giftQuantity'] ?? null;

$attachedAsset = null;
if ($giftAssetClass) {
  if (!$giftOwnerPublicKey) send_json(400, ['error' => 'giftOwnerPublicKey is required when giftAssetClass is set']);
  if (!isset(ATLAS_ASSET_CATALOG[$giftAssetClass])) {
    send_json(400, ['error' => 'Unknown giftAssetClass. Try atlas.wearable, atlas.badge, atlas.wearable.ring, atlas.membership, atlas.element.iron, or atlas.element.gold.']);
  }
  $giftCatalogEntry = ATLAS_ASSET_CATALOG[$giftAssetClass];
  if ($giftCatalogEntry['fungible']) {
    if (!atlas_is_positive_int($giftQuantity)) {
      send_json(400, ['error' => 'giftQuantity must be a positive integer for a fungible giftAssetClass']);
    }
    $giftMintQuantity = (int) $giftQuantity;
  } else {
    if ($giftQuantity !== null && $giftQuantity !== 1) {
      send_json(400, ['error' => 'giftQuantity must be 1 (or omitted) for a non-fungible giftAssetClass']);
    }
    $giftMintQuantity = 1;
  }
  $attachedAsset = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $giftOwnerPublicKey, $giftAssetClass, $giftMintQuantity, null);
}

$payload = [
  'id' => 'urn:atlas:mail:' . atlas_uuid(),
  'credentialId' => $credentialId,
  'subject' => $subject,
  'body' => $msgBody,
];
if ($attachedAsset) $payload['attachedAsset'] = $attachedAsset;
$payload['sentAt'] = iso_now();
$signature = atlas_sign($kp['privateKey'], $payload);
$message = array_merge($payload, ['signature' => $signature]);
append_mail($message);
send_json(200, $message);
