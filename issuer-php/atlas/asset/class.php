<?php
// GET /atlas/asset/class?class=<assetClass> — mirrors
// issuer-server/server.js's same route. Asset-class lookup for previewing a
// class the caller does not (yet) hold a credential of at all: a scene's
// hoverable stall/crate (demo-domain-a/spatial/lobby/scene.json's
// `interactables`, keyed by `class`) names a class but carries none of
// ATLAS_ASSET_CATALOG's own name/thumbnail/model/properties — those only
// travel today inside an actual minted credential. atlas/trade/catalog.php
// already establishes that an issuer may voluntarily publish more about its
// OWN classes than SPEC.md §5.1's "no central catalog" floor requires (a
// class is a namespace, not an approval-gated registry — see that
// endpoint's own comment) — but it's deliberately narrow: fungible-only,
// tradeScope-filtered, no model/properties at all, since all it ever had to
// answer was "what can I ask this Trading Station for". This endpoint
// answers a different question — "what IS this class, whether or not I can
// trade for it, whether or not I've ever held one" — so it covers every
// class in the catalog (fungible or not, any tradeScope) and returns the
// full display shape.
//
// Reuses atlas_asset_catalog_entry() rather than re-resolving
// name/model/thumbnail/tradeScope/properties by hand here — the exact same
// helper every other endpoint (issue.php, catalog.php) already trusts, so
// this can never quietly drift from what a real mint would sign.
//
// Ungated, same "read is open" reasoning as atlas/trade/catalog.php and
// atlas/trade/listings.php: nothing here is secret — anyone who walks up to
// the lobby crate and opens it would see all of this anyway, on their own
// freshly-minted credential, one action later. Query-string shaped
// (?class=...) rather than a path segment, matching this codebase's
// existing convention of putting every parameter in a JSON body or a query
// string, never in the URL path itself — PHP_URL_PATH-based routing
// (test-router.php / atlas/.htaccess) already strips the query string
// before mapping the clean URL to this file, so ?class=... never interferes
// with that lookup.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_get();

$cls = $_GET['class'] ?? null;
if (!$cls) send_json(400, ['error' => 'class query parameter is required']);

$resolved = atlas_asset_catalog_entry($cls);
if ($resolved === null) send_json(404, ['error' => 'unknown assetClass']);

// ?specDigest= returns the item spec a signed asset names, current or earlier, so a verifier can check it
// against the digest in the credential.
if (isset($_GET['specDigest'])) {
  $wantedDigest = $_GET['specDigest'];
  if (!is_string($wantedDigest) || !preg_match(ATLAS_ITEM_ISSUER_DIGEST_RE, $wantedDigest)) {
    send_json(400, ['error' => 'specDigest must be 64 lowercase hex characters', 'code' => 'item-spec-digest-invalid']);
  }
  $currentSpec = atlas_item_issuer_describe_spec(ATLAS_ASSET_CATALOG[$cls]);
  if ($currentSpec !== null && $currentSpec['itemSpecDigest'] === $wantedDigest) send_json(200, array_merge(['class' => $cls], $currentSpec, ['current' => true]));
  $earlierSpec = atlas_item_issuer_spec_lookup($cls, $wantedDigest);
  if ($earlierSpec === null) send_json(404, ['error' => 'unknown item spec for this class', 'code' => 'item-spec-unknown']);
  send_json(200, ['class' => $cls, 'itemStandard' => ATLAS_ITEM_STANDARD_VERSION, 'itemSpec' => $earlierSpec, 'itemSpecDigest' => $wantedDigest, 'current' => false]);
}

// atlas_asset_catalog_entry() OMITS model/thumbnail entirely when a class
// has neither (correct for the signed credential shape a real mint
// produces — SPEC.md §5's "both optional" means absent, not null) — but
// this discovery response is unsigned display data, not part of any
// credential, and issuer-server/server.js's own /atlas/asset/class route
// explicitly coalesces both to null here so a caller can rely on the keys
// always being present. Mirrors that convention on this response only,
// without changing what a real mint of the same class actually signs.
$resolved['model'] = $resolved['model'] ?? null;
$resolved['thumbnail'] = $resolved['thumbnail'] ?? null;

// 'purchase' and 'expiresInMinutes' are policy, not part of the signed
// `asset` shape atlas_asset_catalog_entry() builds — they never travel on
// a credential, so they have to be read straight off the raw catalog entry
// here, the same way issuer-server/server.js's own route reads them
// straight off ASSET_CATALOG[cls] rather than through mintAssetByClass's
// asset-builder. Lets a scene's "purchase" interactable (the museum
// ticket stall) show a live price/expiry without hardcoding either in
// scene.json — see that route's own comment for the full reasoning.
$rawEntry = ATLAS_ASSET_CATALOG[$cls];
$describedSpec = atlas_item_issuer_describe_spec($rawEntry);
if ($describedSpec !== null) $resolved = array_merge($resolved, $describedSpec);
if (isset($rawEntry['purchase'])) $resolved['purchase'] = $rawEntry['purchase'];
if (isset($rawEntry['expiresInMinutes'])) $resolved['expiresInMinutes'] = $rawEntry['expiresInMinutes'];

send_json(200, $resolved);
