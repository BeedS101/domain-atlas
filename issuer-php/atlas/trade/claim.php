<?php
// POST /atlas/trade/claim (v1.14, SPEC.md §7) — fulfill one specific
// open listing by id. Same Intent/Settle discipline §7 already uses, just
// triggered by a claim naming a listing instead of a live-matched pair
// arriving together. Delivery to the poster (not live for this call)
// reuses the same two mechanisms this bundle already has, unmodified: a
// REMAINDER credential supersedes the old balance id, so it arrives "for
// free" the next time that wallet's own /atlas/mail/check asks about that
// (still-held, not-yet-superseded) id — see append_asset_update below,
// consumed by wallet.js's processAssetUpdates exactly like a reissue. A
// newly RECEIVED credential (of a class the poster may never have held
// before, so there's no old id for it to supersede) is instead attached to
// a system mail message addressed to that same old balance id — task #59's
// existing, tested gift-claim path (wallet.js's claimMailGift) already
// knows how to absorb an already-fully-signed credential from a mail
// attachment, so nothing new is needed on the receiving end at all. The
// claimant is by definition live for this call, so their own side applies
// directly in the response — no mail round-trip needed for them.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$pendingId = $body['pendingId'] ?? null;
$membership = $body['membership'] ?? null;
$intent = $body['intent'] ?? null;
$balance = $body['balance'] ?? null;
if (!$pendingId || !$membership || !$intent || !$balance) {
  send_json(400, ['error' => 'pendingId, membership, intent, and balance are all required']);
}
if (!isset($intent['payload']) || !isset($intent['proof'])) {
  send_json(400, ['error' => 'intent must carry payload and proof']);
}

$envelopeOk = verify_envelope($intent['payload'], $intent['proof']);
if (!$envelopeOk) send_json(400, ['error' => 'intent signature does not check out']);
$claimantPub = $intent['proof']['publicKey'];

$membershipProblem = check_presented_membership($kp['publicKeyB64url'], $membership, $claimantPub, 'atlas.tradingstation.membership');
if ($membershipProblem) send_json(400, ['error' => 'membership: ' . $membershipProblem]);

$exp = strtotime($intent['payload']['expiresAt'] ?? '');
if ($exp === false || $exp < time()) send_json(400, ['error' => 'intent has already expired']);

$pendingDoc = read_pending_trades();
$posted = null;
foreach ($pendingDoc['trades'] as $t) {
  if ($t['id'] === $pendingId) { $posted = $t; break; }
}
if (!$posted) send_json(404, ['error' => 'listing not found — already claimed, withdrawn, or expired']);

$posterPub = $posted['intent']['proof']['publicKey'];
$offerA = $posted['intent']['payload']['offer'];
$wantA = $posted['intent']['payload']['want'];
$balanceA = $posted['balance'];
$offerB = $intent['payload']['offer'];
$wantB = $intent['payload']['want'];
$balanceB = $balance;

$claimantShapeProblem = validate_trade_side_shape($offerB, 'offer') ?? validate_trade_side_shape($wantB, 'want');
if ($claimantShapeProblem) send_json(400, ['error' => $claimantShapeProblem]);

// Mirror check — the claimant's offer/want must exactly match what this
// listing wants/offers, same shape §7's own Match step uses. Unchanged by
// task #250 fourth follow-up's unique-item support: a non-fungible side's
// quantity is always exactly 1 on both ends (validate_trade_side_shape
// enforces this at submit time already), so this plain equality check
// keeps working without needing to know or care which side is fungible.
if ($offerB['class'] !== $wantA['class'] || $offerB['quantity'] !== $wantA['quantity'] ||
    $wantB['class'] !== $offerA['class'] || $wantB['quantity'] !== $offerA['quantity']) {
  send_json(400, ['error' => "your intent does not mirror this listing's offer/want"]);
}

// Task #250 fourth follow-up: which check runs for each side is decided by
// that side's own presented balance's signed fungible flag — see
// atlas/trade/submit.php's own comment on this same choice.
$offerBIsUnique = isset($balanceB['asset']['fungible']) && $balanceB['asset']['fungible'] === false;
$claimantBalanceProblem = $offerBIsUnique
  ? check_presented_unique_asset($kp['publicKeyB64url'], $balanceB, $claimantPub, $offerB['class'])
  : check_presented_asset($kp['publicKeyB64url'], $balanceB, $claimantPub, $offerB['class'], $offerB['quantity']);
if ($claimantBalanceProblem) send_json(400, ['error' => 'balance: ' . $claimantBalanceProblem]);

// Re-checks the poster's own balance fresh (not just trusted from when it
// was posted) in case it was since spent or revoked some other way.
$offerAIsUnique = isset($balanceA['asset']['fungible']) && $balanceA['asset']['fungible'] === false;
$posterBalanceProblem = $offerAIsUnique
  ? check_presented_unique_asset($kp['publicKeyB64url'], $balanceA, $posterPub, $offerA['class'])
  : check_presented_asset($kp['publicKeyB64url'], $balanceA, $posterPub, $offerA['class'], $offerA['quantity']);
if ($posterBalanceProblem) {
  remove_pending_trade($posted['id']); // no longer honorable — drop it rather than leave a dead listing others keep trying to claim
  send_json(400, ['error' => "the poster's balance no longer checks out (" . $posterBalanceProblem . ') — listing withdrawn']);
}

// A unique side never has a remainder (its balance's quantity is
// definitionally 1, exactly what's being offered — SPEC.md §5.1) and is
// TRANSFERRED rather than re-minted from the catalog, so its actual
// instance state (serial, a Signet Ring's randomly-rolled enchantments/
// stats) survives settlement — see transfer_unique_asset()'s own comment
// for the bug this avoids repeating. A fungible side keeps the original
// spend/remainder behavior unchanged.
$remainderA = $offerAIsUnique ? 0 : $balanceA['quantity'] - $offerA['quantity'];
$remainderB = $offerBIsUnique ? 0 : $balanceB['quantity'] - $offerB['quantity'];

$aRemainder = $remainderA > 0
  ? mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $posterPub, $offerA['class'], $remainderA, $balanceA['id'])
  : null;
$aReceived = $offerBIsUnique
  ? transfer_unique_asset($kp['privateKey'], $kp['publicKeyB64url'], $posterPub, $balanceB)
  : mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $posterPub, $wantA['class'], $wantA['quantity'], $balanceA['id']);
$bRemainder = $remainderB > 0
  ? mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $claimantPub, $offerB['class'], $remainderB, $balanceB['id'])
  : null;
$bReceived = $offerAIsUnique
  ? transfer_unique_asset($kp['privateKey'], $kp['publicKeyB64url'], $claimantPub, $balanceA)
  : mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $claimantPub, $wantB['class'], $wantB['quantity'], $balanceB['id']);

atlas_revoke($balanceA['id'], 'superseded');
atlas_revoke($balanceB['id'], 'superseded');
remove_pending_trade($posted['id']);

if ($aRemainder) {
  append_asset_update(['id' => $balanceA['id'], 'status' => 'superseded', 'reason' => 'superseded', 'newCredential' => $aRemainder]);
}
$noticePayload = [
  'id' => 'urn:atlas:mail:' . atlas_uuid(),
  'credentialId' => $balanceA['id'],
  'subject' => 'Listing claimed at ' . atlas_domain(),
  'body' => "Your open listing of {$offerA['quantity']} {$offerA['class']} for {$wantA['quantity']} {$wantA['class']} was claimed while you were away.",
  'attachedAsset' => $aReceived,
  'sentAt' => iso_now(),
];
$noticeSignature = atlas_sign($kp['privateKey'], $noticePayload);
append_mail(array_merge($noticePayload, ['signature' => $noticeSignature]));

send_json(200, ['status' => 'settled', 'remainder' => $bRemainder, 'received' => $bReceived]);
