<?php
// POST /atlas/asset/issue — mirrors issuer-server/server.js's same route.
// Mints a first credential of an asset class — unique (fungible: false,
// quantity forced to 1) or fungible (quantity caller-chosen) alike
// (SPEC.md §5), depending entirely on what ATLAS_ASSET_CATALOG says that
// class is.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$ownerPublicKey = $body['ownerPublicKey'] ?? null;
$assetClass = $body['assetClass'] ?? null;
$quantity = $body['quantity'] ?? null;
$existingBalances = $body['existingBalances'] ?? null;
if (!$ownerPublicKey) send_json(400, ['error' => 'ownerPublicKey is required']);
if (!isset(ATLAS_ASSET_CATALOG[$assetClass])) {
  // This used to enumerate every known class by name, which
  // stopped being useful once the periodic-table expansion pushed the
  // catalog past 125 classes — pointing at the catalog itself instead.
  send_json(400, ['error' => 'Unknown assetClass. See GET /atlas/trade/catalog for tradable classes, or ATLAS_ASSET_CATALOG_BASE in issuer-php/lib/store.php (plus issuer-php/lib/elements-catalog.php) for the full list.']);
}

// fungible: true — quantity is caller-chosen and must be a positive
// integer. fungible: false — quantity is always exactly 1 (SPEC.md §5):
// accept it omitted, or explicitly 1, but reject anything else rather
// than silently ignoring a caller's mistaken request for more than one
// of a unique class.
$catalogEntry = ATLAS_ASSET_CATALOG[$assetClass];
if ($catalogEntry['fungible']) {
  if (!atlas_is_positive_int($quantity)) {
    send_json(400, ['error' => 'quantity must be a positive integer for a fungible assetClass']);
  }
  $mintQuantity = (int) $quantity;
} else {
  if ($quantity !== null && $quantity !== 1) {
    send_json(400, ['error' => 'quantity must be 1 (or omitted) for a non-fungible assetClass']);
  }
  $mintQuantity = 1;
}

// A repeated request id returns the credential already issued for it.
$issueRequestId = atlas_parse_request_id($body);
$issueReplayable = $issueRequestId !== null && $catalogEntry['fungible'];
$issueParams = ['ownerPublicKey' => $ownerPublicKey, 'assetClass' => $assetClass, 'quantity' => $mintQuantity];
if ($issueReplayable) {
  if (atlas_request_lease($issueRequestId) !== null) send_json(503, ['error' => 'this request is already being processed - try again', 'code' => 'busy']);
  $prior = atlas_replay_lookup($issueRequestId, 'issue', [], $issueParams);
  if ($prior !== null && isset($prior['conflict'])) send_json(409, ['error' => 'requestId was already used for a different request', 'code' => 'request-id-conflict']);
  if ($prior !== null) {
    http_response_code(200);
    header('Content-Type: application/json');
    cors_headers();
    no_store_headers();
    echo $prior['responseJson'];
    exit;
  }
}

// Mirrors issuer-server/server.js's same check verbatim: a fresh mint of a
// class with a 'holdingCap' is refused when the owner's holdings plus the
// quantity requested would pass the cap. Holdings come from the issuer's own
// index of what it signed for this owner (atlas_assess_holdings), not from
// what the wallet presents; the owner is held for the whole check-and-mint so
// two concurrent mints cannot both pass on the same count. Applies to every
// caller of this endpoint; split, convert and trade re-mints move existing
// value and call mint_asset_by_class() directly.
if ($catalogEntry['fungible'] && isset($catalogEntry['holdingCap'])) {
  if (atlas_owner_lease($ownerPublicKey) !== null) send_json(503, ['error' => 'this owner is being updated by another request - try again', 'code' => 'busy']);
  list($held, $adopt) = atlas_assess_holdings($kp['publicKeyB64url'], $ownerPublicKey, $assetClass, $existingBalances);
  $cap = $catalogEntry['holdingCap'];
  if ($adopt) atlas_holdings_register($ownerPublicKey, $assetClass, $adopt);
  if ($held + $mintQuantity > $cap) {
    send_json(400, [
      'error' => $held >= $cap
        ? 'already holding ' . $held . ' ' . $catalogEntry['name'] . ' (cap: ' . $cap . ') — convert some to another element (POST /atlas/convert) or spend it before mining more'
        : 'holding ' . $held . ' ' . $catalogEntry['name'] . '; ' . $mintQuantity . ' more would pass the cap (cap: ' . $cap . ') — at most ' . ($cap - $held) . ' more can be mined',
      'code' => 'cap', 'held' => $held, 'cap' => $cap,
    ]);
  }
}

// A first minting — never a reissue — so supersedes is always null here.
// See atlas/asset/reissue.php (SPEC.md §5.1.1) for the other caller of
// issue_asset(), where supersedes names the id being replaced.
$credential = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $ownerPublicKey, $assetClass, $mintQuantity, null);
if ($issueReplayable) {
  $credentialJson = json_encode($credential, JSON_UNESCAPED_SLASHES);
  if ($credentialJson !== false) atlas_replay_store($issueRequestId, 'issue', [], $issueParams, $credentialJson);
}

// Subscribing IS requesting this specific asset class (see the mail-system
// notes in README.txt) — log the subscriber and auto-send a welcome
// message the same way any other domain-to-subscriber mail works, so the
// very first thing a new subscriber's wallet picks up on its next mail
// check is confirmation the subscription worked.
if ($assetClass === 'atlas.membership') {
  append_subscriber(['credentialId' => $credential['id'], 'ownerPublicKey' => $ownerPublicKey, 'subscribedAt' => $credential['issuedAt']]);
  $welcomePayload = [
    'id' => 'urn:atlas:mail:' . atlas_uuid(),
    'credentialId' => $credential['id'],
    'subject' => 'Welcome to ' . atlas_domain(),
    'body' => "Thanks for subscribing — you'll hear from us here whenever there's something worth sharing.",
    'sentAt' => iso_now(),
  ];
  $welcomeSignature = atlas_sign($kp['privateKey'], $welcomePayload);
  append_mail(array_merge($welcomePayload, ['signature' => $welcomeSignature]));
}

// Post Office (SPEC.md §11.3): claiming this specific class
// IS registering for Global Mail here, same "requesting the class is the
// whole registration step" shape as atlas.membership above — logged to
// its own roster (see is_valid_postoffice_member(), the gate
// atlas/postoffice/send.php checks every send against) plus the same
// welcome-mail courtesy, addressed by THIS credential's id so it arrives
// through the ordinary mail/check.php loop like anything else this wallet
// already holds a credential for. Mirrors issuer-server/server.js's same
// branch in its /atlas/asset/issue handler.
if ($assetClass === 'atlas.postoffice.membership') {
  append_postoffice_member(['credentialId' => $credential['id'], 'ownerPublicKey' => $ownerPublicKey, 'joinedAt' => $credential['issuedAt']]);
  $welcomePayload = [
    'id' => 'urn:atlas:mail:' . atlas_uuid(),
    'credentialId' => $credential['id'],
    'subject' => 'Your address is live',
    'body' => 'Anyone who has your public key can now reach you through ' . atlas_domain() . "'s Global Mail — share it the way you'd share an email address.",
    'sentAt' => iso_now(),
  ];
  $welcomeSignature = atlas_sign($kp['privateKey'], $welcomePayload);
  append_mail(array_merge($welcomePayload, ['signature' => $welcomeSignature]));
}

// Trading Station: same shape as Post Office just
// above: claiming this class IS joining, logged to its own roster, welcome
// mail addressed by this credential's own id so it arrives through the
// ordinary mail/check.php loop. Mirrors issuer-server/server.js's same
// branch in its /atlas/asset/issue handler.
if ($assetClass === 'atlas.tradingstation.membership') {
  append_tradingstation_member(['credentialId' => $credential['id'], 'ownerPublicKey' => $ownerPublicKey, 'joinedAt' => $credential['issuedAt']]);
  $welcomePayload = [
    'id' => 'urn:atlas:mail:' . atlas_uuid(),
    'credentialId' => $credential['id'],
    'subject' => 'Trading Station membership active',
    'body' => 'You can now submit a remote trade intent to ' . atlas_domain() . "'s Trading Station without standing at the stall — it'll hold your offer until a matching counterparty intent arrives.",
    'sentAt' => iso_now(),
  ];
  $welcomeSignature = atlas_sign($kp['privateKey'], $welcomePayload);
  append_mail(array_merge($welcomePayload, ['signature' => $welcomeSignature]));
}

// Governance/voting demo — same shape as Post Office/Trading Station
// just above: claiming this class IS joining the assembly, logged to its
// own roster (is_valid_governance_member(), the gate propose/vote below
// check every request against). Mirrors issuer-server/server.js's same
// branch in its /atlas/asset/issue handler.
if ($assetClass === 'atlas.demo.governance.membership') {
  append_governance_member(['credentialId' => $credential['id'], 'ownerPublicKey' => $ownerPublicKey, 'joinedAt' => $credential['issuedAt']]);
}

send_json(200, $credential);
