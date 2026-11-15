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
// a system mail message addressed to that same old balance id — the
// gift-claim path (wallet.js's claimMailGift) already
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

// A claim that carries a request id has its final outcome stored once the settlement has run, so a
// claimant whose answer was lost can ask again. The id must be the one the claimant signed, and the
// stored outcome is only returned for the same listing, balance and offer/want. This is checked
// before the intent's expiry: an outcome that already exists stays retrievable after it.
try {
  $claimRequestId = atlas_parse_request_id($body);
} catch (Exception $e) {
  send_json(400, ['error' => $e->getMessage()]);
}
$claimParams = null;
if ($claimRequestId !== null) {
  if (($intent['payload']['requestId'] ?? null) !== $claimRequestId) send_json(400, ['error' => 'intent does not authorize this requestId']);
  if (!is_string($balance['id'] ?? null)) send_json(400, ['error' => 'balance: not an asset credential']);
  $claimParams = [
    'pendingId' => $pendingId, 'claimantPublicKey' => $claimantPub, 'balanceId' => $balance['id'],
    'offer' => $intent['payload']['offer'] ?? null, 'want' => $intent['payload']['want'] ?? null,
  ];
  if (atlas_lease('claim', $claimRequestId) !== null) send_json(503, ['error' => 'this request is already being processed - try again', 'code' => 'busy']);
  $prior = atlas_replay_lookup($claimRequestId, 'claim', [$balance['id']], $claimParams);
  if ($prior !== null && isset($prior['conflict'])) send_json(409, ['error' => 'requestId was already used for a different request', 'code' => 'request-id-conflict']);
  if ($prior !== null) {
    $stored = json_decode($prior['responseJson'], true);
    atlas_send_claim_text((int) $stored['status'], $stored['bodyJson']);
  }
}
// The outcome is kept as the exact text that was sent, so a replay is byte-identical and the signed
// credentials in it are not re-encoded.
function atlas_send_claim_text($status, $text) {
  http_response_code($status);
  header('Content-Type: application/json');
  cors_headers();
  no_store_headers();
  echo $text;
  exit;
}
function atlas_store_claim_outcome($requestId, $balanceId, $params, $status, $bodyText) {
  if ($requestId === null) return;
  atlas_replay_store($requestId, 'claim', [$balanceId], $params, json_encode(['status' => $status, 'bodyJson' => $bodyText], JSON_UNESCAPED_SLASHES));
}
// Stores the outcome of a claim that mutated state, then answers with it.
function atlas_answer_claim($requestId, $balanceId, $params, $status, $body) {
  $text = json_encode($body, JSON_UNESCAPED_SLASHES);
  atlas_store_claim_outcome($requestId, $balanceId, $params, $status, $text);
  atlas_send_claim_text($status, $text);
}

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
$tradeId = $posted['id'];

$claimantShapeProblem = validate_trade_side_shape($offerB, 'offer') ?? validate_trade_side_shape($wantB, 'want');
if ($claimantShapeProblem) send_json(400, ['error' => $claimantShapeProblem]);

// Mirror check — the claimant's offer/want must exactly match what this
// listing wants/offers, same shape §7's own Match step uses. A non-fungible
// side's quantity is always exactly 1 on both ends (validate_trade_side_shape
// enforces this at submit time), so a plain equality check works whichever
// side is fungible.
if ($offerB['class'] !== $wantA['class'] || $offerB['quantity'] !== $wantA['quantity'] ||
    $wantB['class'] !== $offerA['class'] || $wantB['quantity'] !== $offerA['quantity']) {
  send_json(400, ['error' => "your intent does not mirror this listing's offer/want"]);
}

// Which check runs for each side is decided by that side's own presented
// balance's signed fungible flag, as in atlas/trade/submit.php.
$offerBIsUnique = isset($balanceB['asset']['fungible']) && $balanceB['asset']['fungible'] === false;
// A claimant whose earlier attempt stopped after this balance was spent for this trade resumes from the recorded result
// instead (atlas_trade_leg_resumable()).
$balanceBResumed = atlas_trade_leg_resumable($kp, $tradeId, $balanceB, $claimantPub, $offerB['class'], $offerB['quantity'], $posterPub, false)
  || atlas_trade_attempt_resumable($tradeId, $balanceB, $claimantPub, $offerB['class'], $offerB['quantity']);
$claimantBalanceProblem = $balanceBResumed ? null : ($offerBIsUnique
  ? check_presented_unique_asset($kp['publicKeyB64url'], $balanceB, $claimantPub, $offerB['class'])
  : check_presented_asset($kp['publicKeyB64url'], $balanceB, $claimantPub, $offerB['class'], $offerB['quantity']));
if ($claimantBalanceProblem) send_json(400, ['error' => 'balance: ' . $claimantBalanceProblem]);

// Re-checks the poster's own balance fresh (not just trusted from when it
// was posted) in case it was since spent or revoked some other way.
$offerAIsUnique = isset($balanceA['asset']['fungible']) && $balanceA['asset']['fungible'] === false;
$balanceAResumed = atlas_trade_leg_resumable($kp, $tradeId, $balanceA, $posterPub, $offerA['class'], $offerA['quantity'], $claimantPub, true);
// The poster's balance comes from the listing, not from the claimant. When this claim's first leg already settled, the
// issuer of the poster's balance is the authority on whether its own leg did too, so a revocation there is not grounds
// to withdraw the listing.
$posterBalanceProblem = ($balanceAResumed || $balanceBResumed) ? null : ($offerAIsUnique
  ? check_presented_unique_asset($kp['publicKeyB64url'], $balanceA, $posterPub, $offerA['class'])
  : check_presented_asset($kp['publicKeyB64url'], $balanceA, $posterPub, $offerA['class'], $offerA['quantity']));
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
$lockExpiresAt = gmdate('Y-m-d\TH:i:s\Z', time() + 120);

// A trade whose first leg was refunded is finished: the poster's credit from it no longer exists, so the second leg must not
// run now even if the poster's issuer would accept it.
if ($issuerBDomain === atlas_domain()) {
  $earlier = atlas_trade_leg_outcome($tradeId, $balanceB);
  if ($earlier['state'] === 'busy') send_json(409, ['error' => 'this balance is being settled by another request - try again', 'code' => 'busy']);
  if ($earlier['state'] === 'refunded') {
    atlas_answer_claim($claimRequestId, $balance['id'] ?? null, $claimParams, 502, ['error' => 'this trade could not be completed and your ' . $offerB['quantity'] . ' ' . $offerB['class'] . ' was refunded.', 'refund' => $earlier['refund'], 'remainder' => $earlier['leg']['remainder'] ?? null, 'code' => 'claim-incomplete']);
  }
}
if ($issuerBDomain !== atlas_domain()) atlas_trade_attempt_mark($tradeId, $balanceB, $claimantPub, $offerB['quantity']);

// Lock phase first, BEFORE either side mutates anything: if a foreign
// issuer refuses the lock, nothing has been spent yet, and whichever lock
// did succeed just self-expires (relay-lock.php's own comment on why
// there's no separate unlock call).
if ($issuerBDomain !== atlas_domain()) {
  try {
    atlas_relay_trade_lock($kp, $issuerBDomain, $tradeId, $balanceB, $lockExpiresAt);
  } catch (AtlasTradeRefundedException $e) {
    atlas_answer_claim($claimRequestId, $balance['id'] ?? null, $claimParams, 502, ['error' => 'this trade could not be completed and your ' . $offerB['quantity'] . ' ' . $offerB['class'] . ' was refunded by ' . $issuerBDomain . '.', 'refund' => $e->refund, 'remainder' => $e->remainder, 'code' => 'claim-incomplete']);
  } catch (Exception $e) {
    send_json(502, ['error' => "could not lock the claimant's balance at " . $issuerBDomain . ': ' . $e->getMessage(), 'code' => 'not-settled']);
  }
}
if ($issuerADomain !== atlas_domain()) {
  try {
    atlas_relay_trade_lock($kp, $issuerADomain, $tradeId, $balanceA, $lockExpiresAt);
  } catch (Exception $e) {
    send_json(502, ['error' => "could not lock the poster's balance at " . $issuerADomain . ': ' . $e->getMessage(), 'code' => 'not-settled']);
  }
}

// B's side settles FIRST — it produces aReceived, what the absent poster
// is owed. A's own settlement (next) needs that already in hand before it
// can mail-deliver it, since only issuerA's mail store is one the
// poster's wallet is actually polling (fulfill_trade_side_settlement()'s
// own comment in lib/bootstrap.php has the full reasoning).
if ($issuerBDomain === atlas_domain()) {
  $bSide = fulfill_trade_side_settlement($kp, $balanceB, $offerB['quantity'], $posterPub, null, $tradeId);
} else {
  try {
    $bSide = atlas_relay_trade_settle($kp, $issuerBDomain, $tradeId, $balanceB, $offerB['quantity'], $posterPub, null);
  } catch (Exception $e) {
    send_json(502, ['error' => "could not settle the claimant's balance at " . $issuerBDomain . ': ' . $e->getMessage(), 'code' => 'claim-unresolved']);
  }
}
$aReceived = $bSide['received'];
$bRemainder = $bSide['remainder'];

$mailNotice = [
  'subject' => 'Listing claimed at ' . atlas_domain(),
  'body' => "Your open listing of {$offerA['quantity']} {$offerA['class']} for {$wantA['quantity']} {$wantA['class']} was claimed while you were away.",
  'attachedAsset' => $aReceived,
];
try {
  $aSide = $issuerADomain === atlas_domain()
    ? fulfill_trade_side_settlement($kp, $balanceA, $offerA['quantity'], $claimantPub, $mailNotice, $tradeId)
    : atlas_relay_trade_settle($kp, $issuerADomain, $tradeId, $balanceA, $offerA['quantity'], $claimantPub, $aReceived);
} catch (Exception $e) {
  // A foreign issuer whose outcome is unknown may have settled the poster's balance. Refunding then would pay the claimant
  // twice, so nothing is undone and the stored outcome is left open: the same claim asked again finds the issuer's
  // recorded result (or settles it), or a definite refusal, which is refunded.
  if ($issuerADomain !== atlas_domain() && !($e instanceof AtlasRelayOutcomeException && $e->definite)) {
    send_json(502, ['error' => "could not confirm the poster's settlement at " . $issuerADomain . ' (' . $e->getMessage() . ') - ask again with the same claim; nothing has been refunded or lost', 'code' => 'claim-unresolved']);
  }
  // B's side already settled above, so balanceB is spent even though this request is about to report failure. The issuer of
  // that balance refunds it: this domain when it issued it (refund_failed_second_leg()), otherwise the issuer, asked
  // through atlas_relay_trade_refund().
  $refund = null;
  if ($issuerBDomain === atlas_domain()) {
    try {
      $refund = refund_failed_second_leg($kp, $aReceived, $offerB, $claimantPub);
      $refundNote = ' — your ' . $offerB['quantity'] . ' ' . $offerB['class'] . ' was automatically refunded.';
    } catch (Exception $refundErr) {
      $refundNote = ' — automatic refund also failed (' . $refundErr->getMessage() . '); contact the domain operator, your balance may be stuck.';
    }
  } else {
    // The claimant's balance was spent by another domain: it undoes its own first leg and pays the claimant back.
    try {
      $relayed = atlas_relay_trade_refund($kp, $issuerBDomain, $tradeId, $balanceB);
      $refund = $relayed['refund'];
      if ($relayed['remainder'] !== null) $bRemainder = $relayed['remainder'];
      $refundNote = ' — your ' . $offerB['quantity'] . ' ' . $offerB['class'] . ' was refunded by ' . $issuerBDomain . '.';
    } catch (AtlasRelayRefundException $refundErr) {
      if ($refundErr->kind === 'refused') {
        $refundNote = ' — your balance was spent at ' . $issuerBDomain . ' and it refused to refund it (' . $refundErr->getMessage() . '); contact the domain operator.';
      } else {
        // The refund may or may not have happened, or the issuer cannot do it yet. Nothing is stored, so the same claim asked
        // again finds the recorded refund, or asks for it again.
        send_json(502, ['error' => "could not settle the poster's balance at " . $issuerADomain . ' (' . $e->getMessage() . ') and the refund at ' . $issuerBDomain . ' is not confirmed (' . $refundErr->getMessage() . ') - ask again with the same claim, or contact the domain operator; nothing has been duplicated', 'remainder' => $bRemainder, 'code' => 'claim-unresolved']);
      }
    }
  }
  atlas_answer_claim($claimRequestId, $balance['id'] ?? null, $claimParams, 502, ['error' => "could not settle the poster's balance at " . $issuerADomain . ': ' . $e->getMessage() . $refundNote, 'refund' => $refund, 'remainder' => $bRemainder, 'code' => 'claim-incomplete']);
}
$bReceived = $aSide['received'];

$settledText = json_encode(['status' => 'settled', 'remainder' => $bRemainder, 'received' => $bReceived], JSON_UNESCAPED_SLASHES);
atlas_store_claim_outcome($claimRequestId, $balance['id'] ?? null, $claimParams, 200, $settledText);
remove_pending_trade($posted['id']);

atlas_send_claim_text(200, $settledText);
