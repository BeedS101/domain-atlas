<?php
// POST /atlas/asset/issue — mirrors issuer-server/server.js's same route.
// Mints a first credential of an asset class — unique (fungible: false,
// quantity forced to 1) or fungible (quantity caller-chosen) alike
// (SPEC.md §5), depending entirely on what ATLAS_ASSET_CATALOG says that
// class is.
require_once __DIR__ . '/../../lib/bootstrap.php';
require_once __DIR__ . '/../../lib/owner-proof.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

// Roster rows and the welcome mail of a membership class, written after an issue has committed. A row
// already carrying the credential id means this was done, so a retry that finds the issue committed
// (replayed) completes whatever a crash cut short and never writes it twice.
function atlas_record_issuance($kp, $assetClass, $credential, $ownerPublicKey) {
  $recorded = function ($rows) use ($credential) {
    foreach ((array) $rows as $r) if (is_array($r) && ($r['credentialId'] ?? null) === $credential['id']) return true;
    return false;
  };
  $welcome = function ($subject, $text) use ($kp, $credential) {
    $payload = ['id' => 'urn:atlas:mail:' . atlas_uuid(), 'credentialId' => $credential['id'], 'subject' => $subject, 'body' => $text, 'sentAt' => iso_now()];
    append_mail(array_merge($payload, ['signature' => atlas_sign($kp['privateKey'], $payload)]));
  };
  if ($assetClass === 'atlas.membership') {
    if ($recorded(read_subscribers()['subscribers'] ?? [])) return;
    append_subscriber(['credentialId' => $credential['id'], 'ownerPublicKey' => $ownerPublicKey, 'subscribedAt' => $credential['issuedAt']]);
    $welcome('Welcome to ' . atlas_domain(), "Thanks for subscribing — you'll hear from us here whenever there's something worth sharing.");
  } elseif ($assetClass === 'atlas.postoffice.membership') {
    if ($recorded(read_postoffice_members()['members'] ?? [])) return;
    append_postoffice_member(['credentialId' => $credential['id'], 'ownerPublicKey' => $ownerPublicKey, 'joinedAt' => $credential['issuedAt']]);
    $welcome('Your address is live', 'Anyone who has your public key can now reach you through ' . atlas_domain() . "'s Global Mail — share it the way you'd share an email address.");
  } elseif ($assetClass === 'atlas.tradingstation.membership') {
    if ($recorded(read_tradingstation_members()['members'] ?? [])) return;
    append_tradingstation_member(['credentialId' => $credential['id'], 'ownerPublicKey' => $ownerPublicKey, 'joinedAt' => $credential['issuedAt']]);
    $welcome('Trading Station membership active', 'You can now submit a remote trade intent to ' . atlas_domain() . "'s Trading Station without standing at the stall — it'll hold your offer until a matching counterparty intent arrives.");
  } elseif ($assetClass === 'atlas.demo.governance.membership') {
    if ($recorded(read_governance_members()['members'] ?? [])) return;
    append_governance_member(['credentialId' => $credential['id'], 'ownerPublicKey' => $ownerPublicKey, 'joinedAt' => $credential['issuedAt']]);
  }
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

// A class marked 'restrictedIssuance' (Asset Studio collectibles) is minted only by its own
// wallet-authorized route; this general route never issues it. Checked before any request lease,
// supply reservation or signing, and mint_asset_by_class() refuses it again.
if (!empty(ATLAS_ASSET_CATALOG[$assetClass]['restrictedIssuance'])) {
  send_json(403, [
    'error' => 'Studio collectibles require authorized Studio issuance',
    'code' => 'studio-authorization-required'
  ]);
}

// The public route serves this domain's own pages only, and only for classes the domain offers. Checked before
// any lease, reservation or signing.
$nativeJoin = false;
if (!atlas_mint_origin_allowed($assetClass)) {
  if (!atlas_native_join_possible($assetClass, $body)) {
    send_json(403, ['error' => 'minting is open to this domain\'s own pages only', 'code' => 'mint-origin-refused']);
  }
  $nativeJoin = true;
}
if (!atlas_public_mint_offered($assetClass)) {
  send_json(403, ['error' => ATLAS_ASSET_CATALOG[$assetClass]['name'] . ' is not offered by this domain', 'code' => 'mint-not-offered']);
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
  // A class with mintLimits is minted in small steps only; a bigger request is refused before any lease or journal.
  $mintLimits = atlas_mint_limits_for($catalogEntry);
  if ($mintLimits !== null && $mintQuantity > $mintLimits['perRequest']) {
    send_json(400, [
      'error' => $catalogEntry['name'] . ' can be mined ' . $mintLimits['perRequest'] . ' at a time (asked for ' . $mintQuantity . ')',
      'code' => 'mint-too-large', 'perRequest' => $mintLimits['perRequest'],
    ]);
  }
} else {
  if ($quantity !== null && $quantity !== 1) {
    send_json(400, ['error' => 'quantity must be 1 (or omitted) for a non-fungible assetClass']);
  }
  $mintQuantity = 1;
}

// Proof that the requester holds the recipient key, for the membership classes (see atlas_owner_proof_mode()). Nothing
// below has been touched yet, so a refusal leaves no lease, credential, roster row or mail behind. Freshness is judged
// further down, and only when this request is about to create something.
// A request that arrives without an Origin header (a native app) is served only on a signed request from the recipient's
// own key, verified here in 'require' mode whatever the issuer's mode is.
$proofVerdict = atlas_owner_proof_verdict($body, [
  'domain' => atlas_domain(), 'mode' => $nativeJoin ? 'require' : atlas_owner_proof_mode(), 'nowMs' => (int) round(microtime(true) * 1000), 'requireFresh' => false,
], function ($payload, $proof) { return verify_envelope($payload, $proof); });
if ($nativeJoin && $proofVerdict['ok'] && (empty($proofVerdict['signed']) || ($body['intent']['proof']['publicKey'] ?? null) !== $ownerPublicKey)) {
  send_json(403, ['error' => 'minting is open to this domain\'s own pages only', 'code' => 'mint-origin-refused']);
}
if (!$proofVerdict['ok']) {
  if (!$nativeJoin) atlas_owner_proof_note($assetClass, 'refused', $proofVerdict['code']);
  $refusal = $proofVerdict;
  unset($refusal['ok'], $refusal['status']);
  send_json($proofVerdict['status'], $refusal);
}

// A repeated request id returns the credential already issued for it.
$issueRequestId = atlas_parse_request_id($body);
$issueReplayable = $issueRequestId !== null;
$issueParams = ['ownerPublicKey' => $ownerPublicKey, 'assetClass' => $assetClass, 'quantity' => $mintQuantity];
if ($catalogEntry['fungible'] || $issueReplayable) atlas_txn_sweep();
$issueTxn = null;
if ($catalogEntry['fungible'] && !$issueReplayable) {
  // A mint without a request id still journals; its transaction lease is taken
  // here, ahead of the owner lease below.
  $issueTxn = atlas_new_txn_id();
  if (atlas_lease('rid', $issueTxn) !== null) send_json(503, ['error' => 'this request is already being processed - try again', 'code' => 'busy']);
}
if ($issueReplayable) {
  if (atlas_request_lease($issueRequestId) !== null) send_json(503, ['error' => 'this request is already being processed - try again', 'code' => 'busy']);
  atlas_txn_recover_key($issueRequestId);
  $prior = atlas_replay_lookup($issueRequestId, 'issue', [], $issueParams);
  if ($prior !== null && isset($prior['conflict'])) send_json(409, ['error' => 'requestId was already used for a different request', 'code' => 'request-id-conflict']);
  if ($prior !== null) {
    atlas_record_issuance($kp, $assetClass, json_decode($prior['responseJson'], true), $ownerPublicKey);
    http_response_code(200);
    header('Content-Type: application/json');
    cors_headers();
    no_store_headers();
    echo $prior['responseJson'];
    exit;
  }
}

// The signed request has to be recent only when it is about to create something: a retry of one the issuer already
// completed (answered above) may be much older.
if (!empty($proofVerdict['signed'])) {
  $stale = atlas_owner_proof_stale($proofVerdict['issuedAtMs'], (int) round(microtime(true) * 1000), $nativeJoin ? ATLAS_NATIVE_JOIN_WINDOW_MS : null);
  if ($stale !== null) {
    if (!$nativeJoin) atlas_owner_proof_note($assetClass, 'refused', $stale['code']);
    $refusal = $stale;
    unset($refusal['ok'], $refusal['status']);
    send_json($stale['status'], $refusal);
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

// Rolling-window allowance for a class with mintLimits, checked after the holding cap so a refusal there uses none
// of it. The reservation is keyed by the request id (or this request's transaction id) and is given back if the
// mint fails before anything is signed. Applies to every caller of this endpoint.
$allowanceKey = null;
if ($catalogEntry['fungible'] && atlas_mint_limits_for($catalogEntry) !== null) {
  if (atlas_owner_lease($ownerPublicKey) !== null) send_json(503, ['error' => 'this owner is being updated by another request - try again', 'code' => 'busy']);
  $limits = atlas_mint_limits_for($catalogEntry);
  $allowanceKey = $issueReplayable ? 'r:' . $issueRequestId : ($issueTxn !== null ? 't:' . $issueTxn : 'x:' . atlas_uuid());
  $refused = atlas_mint_allowance_reserve($ownerPublicKey, $assetClass, $mintQuantity, $limits, $allowanceKey, time());
  if ($refused !== null) {
    send_json(400, [
      'error' => 'Weekly limit reached for ' . $catalogEntry['name'] . ': ' . $refused['used'] . ' of ' . $limits['perWindow'] . ' mined in the last ' . round($limits['windowSeconds'] / 86400) . ' days. More can be mined from ' . gmdate('Y-m-d H:i', $refused['retryAt']) . ' UTC.',
      'code' => 'weekly-limit', 'used' => $refused['used'], 'limit' => (int) $limits['perWindow'],
      'windowSeconds' => (int) $limits['windowSeconds'], 'retryAt' => gmdate('Y-m-d\TH:i:s\Z', $refused['retryAt']),
    ]);
  }
}

// A first minting — never a reissue — so supersedes is always null here.
// See atlas/asset/reissue.php (SPEC.md §5.1.1) for the other caller of
// issue_asset(), where supersedes names the id being replaced.
$journalled = (bool) $catalogEntry['fungible'] || $issueReplayable;
try {
  $credential = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $ownerPublicKey, $assetClass, $mintQuantity, null, null, $journalled);
} catch (Throwable $e) {
  if ($allowanceKey !== null) atlas_mint_allowance_release($ownerPublicKey, $assetClass, $allowanceKey);
  throw $e;
}
if ($journalled) {
  atlas_commit_replacement($issueReplayable ? $issueRequestId : null, 'issue', [], null, $issueParams, [$credential], $credential, $issueTxn);
}

atlas_record_issuance($kp, $assetClass, $credential, $ownerPublicKey);
if (!empty($proofVerdict['signed'])) atlas_owner_proof_note($assetClass, 'signed');
elseif (!empty($proofVerdict['legacy'])) {
  error_log('atlas: issued ' . $assetClass . ' without proof of key ownership (owner proof mode accept).');
  atlas_owner_proof_note($assetClass, 'unsigned');
}

send_json(200, $credential);
