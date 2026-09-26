<?php
// POST /atlas/mail/send — mirrors issuer-server/server.js's same route.
//
// This is the admin side of the mail system: SPEC.md §11.1 already says
// sending is "authenticated as the domain operator, not as any visitor" —
// require_admin_auth() (lib/store.php) enforces that instead of just
// trusting whoever could reach the endpoint, which also meant anyone
// could get this domain to sign and deliver an arbitrary message, or mint
// an arbitrary gift asset via giftAssetClass, to any credential id they
// chose. Wire shape is {payload: {...the same fields as before}, proof}
// or {payload, token} — the same envelope every other admin action here
// uses.
//
// No E2E encryption here (unlike server.js's Node route): that needs an
// ECDH key derivation PHP's openssl extension doesn't expose, and there's
// no /atlas/mail/register-key endpoint on this side either. subject/body
// are sent and stored the same as before — plaintext, signed but not
// encrypted. A wallet talking to a PHP-backed domain gets the same
// graceful fallback it already gets for a WebAuthn identity with no
// ECDH key: no registered key on file, so nothing to encrypt against.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $requestBody = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$sendPayload = $requestBody['payload'] ?? null;
$proof = $requestBody['proof'] ?? null;
$token = $requestBody['token'] ?? null;
$auth = require_admin_auth($sendPayload, $proof, $token);
if (isset($auth['error'])) send_json(401, ['error' => $auth['error']]);

$credentialId = $sendPayload['credentialId'] ?? null;
$subject = $sendPayload['subject'] ?? null;
$msgBody = $sendPayload['body'] ?? null;
if (!$credentialId || !$subject || !$msgBody) {
  send_json(400, ['error' => 'payload.credentialId, payload.subject, and payload.body are required']);
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
$giftAssetClass = $sendPayload['giftAssetClass'] ?? null;
$giftOwnerPublicKey = $sendPayload['giftOwnerPublicKey'] ?? null;
$giftQuantity = $sendPayload['giftQuantity'] ?? null;

$attachedAsset = null;
if ($giftAssetClass) {
  if (!$giftOwnerPublicKey) send_json(400, ['error' => 'giftOwnerPublicKey is required when giftAssetClass is set']);
  if (!isset(ATLAS_ASSET_CATALOG[$giftAssetClass])) {
    // Task #204: see the matching comment on issue.php's own "Unknown
    // assetClass" message for why this stopped enumerating every class.
    send_json(400, ['error' => 'Unknown giftAssetClass. See GET /atlas/trade/catalog for tradable classes, or ATLAS_ASSET_CATALOG_BASE in issuer-php/lib/store.php (plus issuer-php/lib/elements-catalog.php) for the full list.']);
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
