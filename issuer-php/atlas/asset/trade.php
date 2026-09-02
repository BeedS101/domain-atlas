<?php
// POST /atlas/asset/trade — mirrors issuer-server/server.js's same route
// (this server plays the trading-station role — see that file's header
// comment for why issuer and station are the same process in this demo).
// Fungible only, per SPEC.md §7: offer/want only ever name a class and a
// quantity, which is exactly what a fungible balance is and exactly what
// a fungible:false asset isn't. check_presented_asset() below enforces
// this the same way it does for split/consolidate.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$intentA = $body['intentA'] ?? null;
$intentB = $body['intentB'] ?? null;
$balanceA = $body['balanceA'] ?? null;
$balanceB = $body['balanceB'] ?? null;
if (!$intentA || !$intentB || !$balanceA || !$balanceB) {
  send_json(400, ['error' => 'intentA, intentB, balanceA, balanceB are all required']);
}

// 1. Intent — each side's own signature over their own offer.
$okA = verify_envelope($intentA['payload'] ?? null, $intentA['proof'] ?? null);
$okB = verify_envelope($intentB['payload'] ?? null, $intentB['proof'] ?? null);
if (!$okA) send_json(400, ['error' => 'intentA signature does not check out']);
if (!$okB) send_json(400, ['error' => 'intentB signature does not check out']);

$pubA = $intentA['proof']['publicKey'];
$pubB = $intentB['proof']['publicKey'];
if (($intentA['payload']['counterparty'] ?? null) !== $pubB || ($intentB['payload']['counterparty'] ?? null) !== $pubA) {
  send_json(400, ['error' => 'intents do not name each other as counterparty']);
}
$expA = strtotime($intentA['payload']['expiresAt'] ?? '');
$expB = strtotime($intentB['payload']['expiresAt'] ?? '');
if ($expA === false || $expB === false || $expA < time() || $expB < time()) {
  send_json(400, ['error' => 'an intent has expired']);
}

// 2. Match — do the two offers actually mirror each other?
$offerA = $intentA['payload']['offer'];
$wantA = $intentA['payload']['want'];
$offerB = $intentB['payload']['offer'];
$wantB = $intentB['payload']['want'];
$mirrors = $offerA['class'] === $wantB['class'] && $offerA['quantity'] === $wantB['quantity']
        && $offerB['class'] === $wantA['class'] && $offerB['quantity'] === $wantA['quantity'];
if (!$mirrors) send_json(400, ['error' => 'intents do not mirror — offer/want mismatch']);

// 3. Settle — check both presented balances actually cover the offer (and are fungible), then issue.
$probA = check_presented_asset($kp['publicKeyB64url'], $balanceA, $pubA, $offerA['class'], $offerA['quantity']);
if ($probA) send_json(400, ['error' => 'balanceA: ' . $probA]);
$probB = check_presented_asset($kp['publicKeyB64url'], $balanceB, $pubB, $offerB['class'], $offerB['quantity']);
if ($probB) send_json(400, ['error' => 'balanceB: ' . $probB]);

$remainderA = $balanceA['quantity'] - $offerA['quantity'];
$remainderB = $balanceB['quantity'] - $offerB['quantity'];

$aRemainder = $remainderA > 0
  ? mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $pubA, $offerA['class'], $remainderA, $balanceA['id'])
  : null;
$aReceived = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $pubA, $wantA['class'], $wantA['quantity'], $balanceA['id']);
$bRemainder = $remainderB > 0
  ? mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $pubB, $offerB['class'], $remainderB, $balanceB['id'])
  : null;
$bReceived = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $pubB, $wantB['class'], $wantB['quantity'], $balanceB['id']);

// 4. Atomicity — both sides' pre-trade balances are only revoked once every
// new credential above has actually been signed, so a failure earlier in
// this handler leaves nothing settled at all.
atlas_revoke($balanceA['id'], 'superseded');
atlas_revoke($balanceB['id'], 'superseded');

send_json(200, ['aRemainder' => $aRemainder, 'aReceived' => $aReceived, 'bRemainder' => $bRemainder, 'bReceived' => $bReceived]);
