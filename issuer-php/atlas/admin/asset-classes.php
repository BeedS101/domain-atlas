<?php
// POST /atlas/admin/asset-classes — mirrors issuer-server/server.js's same
// route. Admin-gated (require_admin_auth(), same wire shape as every
// other admin action here: {payload, proof} or {payload, token}.
//
// Every non-fungible class in ATLAS_ASSET_CATALOG, bound or not — for the
// class-patch form's own dropdown. GET /atlas/trade/catalog.php
// deliberately excludes a bound class (it can never be the THING traded),
// but a bound class is still a perfectly valid class-patch target — a
// badge or membership card can carry a wrong fact same as anything else —
// so this can't just reuse that public list. Gating it behind admin auth
// (rather than adding a second public endpoint) is what makes exposing
// bound classes here fine: nothing here reveals who holds one, only the
// same static catalog config atlas/trade/catalog.php already publishes
// for the non-bound subset.
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

// `properties`/`randomized`: same purpose as issuer-server/server.js's
// mirror of this route — let the class-patch form pre-fill from the
// class's actual current state instead of a blind textarea. `randomized`
// flags a class whose real per-instance values are rolled at mint time
// (randomizeProperties, e.g. the Signet Ring/hats), so the panel can warn
// that `properties` here is only the shared fallback template, not any
// specific holder's actual roll.
$classes = [];
foreach (ATLAS_ASSET_CATALOG as $cls => $entry) {
  if (($entry['fungible'] ?? null) !== false) continue;
  $classes[] = [
    'class' => $cls,
    'name' => $entry['name'] ?? $cls,
    'tradeScope' => $entry['tradeScope'] ?? 'local',
    'properties' => $entry['properties'] ?? [],
    'randomized' => isset($entry['randomizeProperties'])
  ];
}
send_json(200, ['classes' => $classes]);
