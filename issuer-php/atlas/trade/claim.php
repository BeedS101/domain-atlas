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

// SPEC.md §7 v1.29 — a side issued by a domain other than this station's
// own settles through that domain's relay-lock/relay-settle endpoints
// instead of being minted here directly; an all-local trade (both sides
// issued by atlas_domain()) takes exactly the path this always has. Both
// balances already passed check_presented_(unique_)asset above, which for
// a foreign side means it's already confirmed to be on this domain's own
// atlas_trusted_trade_peers() allowlist — nothing further to check here
// before relaying.
$issuerADomain = $balanceA['issuer']['domain'];
$issuerBDomain = $balanceB['issuer']['domain'];
$tradeId = $posted['id'];
$lockExpiresAt = gmdate('Y-m-d\TH:i:s\Z', time() + 120);

// Lock phase first, BEFORE either side mutates anything: if a foreign
// issuer refuses the lock, nothing has been spent yet, and whichever lock
// did succeed just self-expires (relay-lock.php's own comment on why
// there's no separate unlock call).
if ($issuerBDomain !== atlas_domain()) {
  try {
    atlas_relay_trade_lock($kp, $issuerBDomain, $tradeId, $balanceB, $lockExpiresAt);
  } catch (Exception $e) {
    send_json(502, ['error' => "could not lock the claimant's balance at " . $issuerBDomain . ': ' . $e->getMessage()]);
  }
}
if ($issuerADomain !== atlas_domain()) {
  try {
    atlas_relay_trade_lock($kp, $issuerADomain, $tradeId, $balanceA, $lockExpiresAt);
  } catch (Exception $e) {
    send_json(502, ['error' => "could not lock the poster's balance at " . $issuerADomain . ': ' . $e->getMessage()]);
  }
}

// B's side settles FIRST — it produces aReceived, what the absent poster
// is owed. A's own settlement (next) needs that already in hand before it
// can mail-deliver it, since only issuerA's mail store is one the
// poster's wallet is actually polling (fulfill_trade_side_settlement()'s
// own comment in lib/bootstrap.php has the full reasoning).
if ($issuerBDomain === atlas_domain()) {
  $bSide = fulfill_trade_side_settlement($kp, $balanceB, $offerB['quantity'], $posterPub, null);
} else {
  try {
    $bSide = atlas_relay_trade_settle($kp, $issuerBDomain, $tradeId, $balanceB, $offerB['quantity'], $posterPub, null);
  } catch (Exception $e) {
    send_json(502, ['error' => "could not settle the claimant's balance at " . $issuerBDomain . ': ' . $e->getMessage()]);
  }
}
$aReceived = $bSide['received'];
$bRemainder = $bSide['remainder'];

$mailNotice = [
  'subject' => 'Listing claimed at ' . atlas_domain(),
  'body' => "Your open listing of {$offerA['quantity']} {$offerA['class']} for {$wantA['quantity']} {$wantA['class']} was claimed while you were away.",
  'attachedAsset' => $aReceived,
];
if ($issuerADomain === atlas_domain()) {
  $aSide = fulfill_trade_side_settlement($kp, $balanceA, $offerA['quantity'], $claimantPub, $mailNotice);
} else {
  try {
    $aSide = atlas_relay_trade_settle($kp, $issuerADomain, $tradeId, $balanceA, $offerA['quantity'], $claimantPub, $aReceived);
  } catch (Exception $e) {
    send_json(502, ['error' => "could not settle the poster's balance at " . $issuerADomain . ': ' . $e->getMessage()]);
  }
}
$bReceived = $aSide['received'];

remove_pending_trade($posted['id']);

send_json(200, ['status' => 'settled', 'remainder' => $bRemainder, 'received' => $bReceived]);
