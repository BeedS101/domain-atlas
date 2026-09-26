<?php
// POST /atlas/admin/class-patch — mirrors issuer-server/server.js's same
// route. Admin-gated (require_admin_auth(), same wire shape as every
// other admin action here: {payload, proof} or {payload, token}.
//
// The bulk alternative to atlas/asset/reissue.php: sets (or clears) a fact
// for an entire non-fungible CLASS at once, rather than the operator
// reissuing every current holder's credential by hand. This never touches
// an already-issued credential directly: it only records the patch
// (atlas_class_patches_file() — one entry per class ever touched, never
// one per item or holder), and each holder's own wallet picks it up
// automatically the next time it checks in with this domain (see
// apply_class_patch_if_stale() and atlas/mail/check.php's own comment) —
// the same mail check-in cycle that already delivers ordinary mail and
// revocations. `clear` removes a class's patch entirely rather than
// setting one; nothing already-applied to a holder is undone by that
// (there's nothing to undo it FROM without reissuing again), it just
// stops correcting future check-ins against that class. Same
// non-fungible-only restriction atlas/asset/reissue.php gives: a fungible
// class's properties/tradeScope are already uniform across every balance
// (mint_asset_by_class() rebuilds them fresh from ATLAS_ASSET_CATALOG on
// every mint/split/consolidate/trade), so there's nothing a class patch
// could override there that isn't already true everywhere.
// `properties` here goes through merge_properties() the same as
// atlas/asset/reissue.php's own argument — a key set to null removes that
// fact from every credential this patch touches, rather than leaving it
// stuck at a literal null, and (since set_class_patch() itself merges a
// new call onto whatever patch is already stored) removes that key's own
// earlier override from the stored patch too.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$payload = $body['payload'] ?? [];
$proof = $body['proof'] ?? null;
$token = $body['token'] ?? null;
$auth = require_admin_auth($payload, $proof, $token);
if (isset($auth['error'])) send_json(401, ['error' => $auth['error']]);

$assetClass = $payload['assetClass'] ?? null;
$hasProperties = array_key_exists('properties', $payload);
$properties = $payload['properties'] ?? null;
$hasTradeScope = array_key_exists('tradeScope', $payload);
$tradeScope = $payload['tradeScope'] ?? null;
$clear = !empty($payload['clear']);

if (!isset(ATLAS_ASSET_CATALOG[$assetClass])) {
  send_json(400, ['error' => 'Unknown assetClass. See GET /atlas/trade/catalog for tradable classes, or ATLAS_ASSET_CATALOG in lib/store.php for the full list.']);
}
$catalogEntry = ATLAS_ASSET_CATALOG[$assetClass];
if (!empty($catalogEntry['fungible'])) {
  send_json(400, ['error' => "class patches only apply to a non-fungible class — a fungible class's properties/tradeScope are already uniform across every balance (SPEC.md §5.1)"]);
}

if ($clear) {
  clear_class_patch($assetClass);
  send_json(200, ['assetClass' => $assetClass, 'patch' => null]);
}

if (!$hasProperties && !$hasTradeScope) {
  send_json(400, ['error' => 'at least one of properties (a patch onto asset.properties), tradeScope, or clear is required']);
}
if ($hasProperties && !is_array($properties)) {
  send_json(400, ['error' => 'properties, when given, must be a patch object onto asset.properties']);
}
if ($hasTradeScope && $tradeScope !== 'local' && $tradeScope !== 'bound') {
  send_json(400, ['error' => "tradeScope, when given, must be 'local' or 'bound'"]);
}

$patch = set_class_patch($assetClass, $properties, $tradeScope);
send_json(200, ['assetClass' => $assetClass, 'patch' => $patch]);
