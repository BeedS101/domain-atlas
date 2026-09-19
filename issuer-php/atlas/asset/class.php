<?php
// GET /atlas/asset/class?class=<assetClass> — Task #213, mirrors
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

send_json(200, $resolved);
