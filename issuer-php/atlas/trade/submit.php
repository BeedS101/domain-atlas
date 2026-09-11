<?php
// POST /atlas/trade/submit (task #144 Phase 1, v1.14 open listings —
// mirrors issuer-server/server.js's same route). A visitor posts their own
// half of a trade to the station on its own, with NO counterparty named at
// all. Posting only ever queues — it never auto-settles against whatever
// else happens to be pending. That's a deliberate v1.14 change from this
// endpoint's original Phase 1 shape (which tried to match a fresh
// submission against a waiting counterparty-pinned intent): once a listing
// is meant to be publicly browsed and claimed by whoever wants it, silently
// settling it out from under a browsing buyer because of an unrelated
// submission elsewhere is exactly backwards. v1.15 removed this station's
// earlier /atlas/asset/trade endpoint (both sides' signed intents arriving
// in the same call) entirely — this open-listing model is now the only
// path. See listings.php (browse) and claim.php (settle) for the other
// two-thirds of this.
//
// Gated on holding this domain's atlas.tradingstation.membership,
// presented fresh with the request (check_presented_membership) — the
// same "prove you hold it, right now, signed" shape check_presented_asset
// already uses for the balance itself, not a server-side allow-list
// lookup (see atlas_tradingstation_members_file()'s own comment on why).
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$membership = $body['membership'] ?? null;
$intent = $body['intent'] ?? null;
$balance = $body['balance'] ?? null;
if (!$membership || !$intent || !$balance) {
  send_json(400, ['error' => 'membership, intent, and balance are all required']);
}
if (!isset($intent['payload']) || !isset($intent['proof'])) {
  send_json(400, ['error' => 'intent must carry payload and proof']);
}

$envelopeOk = verify_envelope($intent['payload'], $intent['proof']);
if (!$envelopeOk) send_json(400, ['error' => 'intent signature does not check out']);
$selfPub = $intent['proof']['publicKey'];

$membershipProblem = check_presented_membership($kp['publicKeyB64url'], $membership, $selfPub, 'atlas.tradingstation.membership');
if ($membershipProblem) send_json(400, ['error' => 'membership: ' . $membershipProblem]);

$exp = strtotime($intent['payload']['expiresAt'] ?? '');
if ($exp === false || $exp < time()) send_json(400, ['error' => 'intent has already expired']);

$offerSelf = $intent['payload']['offer'];
$wantSelf = $intent['payload']['want'];
$balanceProblem = check_presented_asset($kp['publicKeyB64url'], $balance, $selfPub, $offerSelf['class'], $offerSelf['quantity']);
if ($balanceProblem) send_json(400, ['error' => 'balance: ' . $balanceProblem]);

$pendingId = 'urn:atlas:trade:' . atlas_uuid();
append_pending_trade(['id' => $pendingId, 'intent' => $intent, 'balance' => $balance, 'submittedAt' => iso_now()]);
send_json(200, ['status' => 'pending', 'pendingId' => $pendingId, 'expiresAt' => $intent['payload']['expiresAt']]);
