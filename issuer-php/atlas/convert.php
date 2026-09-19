<?php
// POST /atlas/convert — Task #203 (SPEC.md §7's new "Currency conversion"
// paragraph). Mirrors issuer-server/server.js's same route; see that
// handler's own comment for the full reasoning. Shaped like
// atlas/asset/split.php rather than anything trading-station related:
// there's no counterparty, no listing, no async delivery — the domain
// itself is always the other side, so this settles synchronously in one
// call, minting a DIFFERENT class as the result instead of more of the
// same one. Conversion always stays with the same owner who presented the
// balance — there's no toPublicKey the way split.php has one.
//
// The rate always routes through the shared base-currency unit regardless
// of which two classes are named, so any two rated classes convert
// directly (iron -> silver works exactly the same way gold -> silver
// does), not just base-currency pairs.
require_once __DIR__ . '/../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$credential = $body['credential'] ?? null;
$spendAmount = $body['spendAmount'] ?? null;
$toClass = $body['toClass'] ?? null;
if (!$credential || !$toClass || !atlas_is_positive_int($spendAmount)) {
  send_json(400, ['error' => 'credential, spendAmount, and toClass are required']);
}
$spendAmount = (int) $spendAmount;

$expectedOwner = $credential['owner']['publicKey'] ?? null;
$fromClass = $credential['asset']['class'] ?? null;
$problem = check_presented_asset($kp['publicKeyB64url'], $credential, $expectedOwner, $fromClass, $spendAmount);
if ($problem) send_json(400, ['error' => $problem]);

if ($toClass === $fromClass) send_json(400, ['error' => 'cannot convert a class into itself']);
$toEntry = isset(ATLAS_ASSET_CATALOG[$toClass]) ? ATLAS_ASSET_CATALOG[$toClass] : null;
$toTradeScope = $toEntry !== null && isset($toEntry['tradeScope']) ? $toEntry['tradeScope'] : 'local';
if ($toEntry === null || $toEntry['fungible'] !== true || $toTradeScope === 'bound') {
  send_json(400, ['error' => 'toClass must be a known, fungible, non-bound assetClass']);
}
$fromRate = isset(ATLAS_ASSET_CATALOG[$fromClass]['exchangeRate']) ? ATLAS_ASSET_CATALOG[$fromClass]['exchangeRate'] : null;
$toRate = isset($toEntry['exchangeRate']) ? $toEntry['exchangeRate'] : null;
if (!is_numeric($fromRate) || !is_numeric($toRate)) {
  send_json(400, ['error' => 'one or both classes are not eligible for conversion (no exchangeRate set)']);
}

// valueInBaseCurrency = how many units of the domain's base currency
// $spendAmount of $fromClass is worth; $resultQuantity = that same value
// expressed in $toClass units. Floors rather than rejects a non-exact
// rate, but a spend too small to produce even 1 unit of $toClass is
// rejected outright rather than silently minting nothing.
$valueInBaseCurrency = $spendAmount / $fromRate;
$resultQuantity = (int) floor($valueInBaseCurrency * $toRate);
if ($resultQuantity < 1) {
  send_json(400, ['error' => "converting $spendAmount $fromClass into $toClass at this domain's rate rounds down to 0 — convert a larger amount"]);
}

$remainderQty = $credential['quantity'] - $spendAmount;
$received = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $expectedOwner, $toClass, $resultQuantity, $credential['id']);
$remainder = $remainderQty > 0
  ? mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $expectedOwner, $fromClass, $remainderQty, $credential['id'])
  : null;
atlas_revoke($credential['id'], 'superseded');
send_json(200, ['received' => $received, 'remainder' => $remainder]);
