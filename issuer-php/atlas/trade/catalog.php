<?php
// GET /atlas/trade/catalog — Task #202 (SPEC.md §7), catalog discovery:
// what CAN a wallet ask this domain's Trading Station for in the "You want"
// side of a trade, without already having one in hand? Before this, the
// wallet's Sell UI hardcoded the three fungible classes this specific demo
// happens to define (see viewer.js's refreshTradingSellOfferOptions
// comment) — fine for one domain, but useless for any other domain running
// this same bundle with its own catalog. Deliberately ungated, same "read
// is open" reasoning as atlas/trade/listings.php just above: a catalog
// entry is already public the moment atlas/asset/issue.php exists to hand
// it out, so listing the classes reveals nothing new.
//
// Filtered to fungible===true (the only kind a quantity-based trade
// intent's offer/want shape supports today — see SPEC.md §5.4) and
// tradeScope!=='bound' (a membership card can never be the THING traded,
// same exclusion check_presented_asset() already enforces at claim time).
// Reuses atlas_asset_catalog_entry() so the resolved name/model/thumbnail/
// tradeScope shape here is byte-for-byte the same helper every other
// endpoint already trusts, rather than a second, possibly-drifting
// reimplementation of that resolution logic.
//
// This same shape is designed to extend to a FOREIGN domain's catalog
// later (fetched live while composing a trade, per the wallet UX idea
// discussed for cross-domain trading) — see the private design notes for
// what changes and what doesn't when that day comes. Mirrors
// issuer-server/server.js's GET /atlas/trade/catalog.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_get();

$classes = [];
foreach (array_keys(ATLAS_ASSET_CATALOG) as $cls) {
  $entry = ATLAS_ASSET_CATALOG[$cls];
  $tradeScope = isset($entry['tradeScope']) ? $entry['tradeScope'] : 'local';
  if ($entry['fungible'] !== true || $tradeScope === 'bound') continue;
  $resolved = atlas_asset_catalog_entry($cls);
  $row = [
    'class' => $cls,
    'name' => $resolved['name'],
    'thumbnail' => isset($resolved['thumbnail']) ? $resolved['thumbnail'] : null,
    'tradeScope' => $resolved['tradeScope'],
  ];
  // Task #203 — surfaced here (rather than a separate rates endpoint) so
  // the same fetch that already drives the Sell tab's "You want" dropdown
  // also drives Convert's live rate preview. Read straight off
  // ATLAS_ASSET_CATALOG (not $resolved) since these two fields are
  // catalog-only config, never part of atlas_asset_catalog_entry()'s
  // signed-credential shape. 'exchangeRate' is only present when the class
  // is actually eligible for conversion (see atlas/convert.php);
  // 'isBaseCurrency' is a display hint only, never checked by the
  // conversion math itself.
  if (isset($entry['exchangeRate']) && is_numeric($entry['exchangeRate'])) $row['exchangeRate'] = $entry['exchangeRate'];
  if (!empty($entry['isBaseCurrency'])) $row['isBaseCurrency'] = true;
  $classes[] = $row;
}

send_json(200, ['domain' => atlas_domain(), 'classes' => $classes]);
