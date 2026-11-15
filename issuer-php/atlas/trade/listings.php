<?php
// GET /atlas/trade/listings (v1.14, SPEC.md §7) — browse this station's
// own open, unexpired listings. Deliberately ungated: reading reveals
// nothing a poster didn't already choose to make public by posting (offer,
// want, and their own public key — exactly what a prospective buyer
// needs), the same "read is open, write is gated" asymmetry Post Office's
// own inbox-check already has against its send. read_pending_trades()
// already lazily prunes anything expired, so nothing extra is needed here
// beyond shaping each entry for a browsing client.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_get();

// Display-only view of a unique item staked on an open listing, so a browsing client can show the exact item on offer.
// Only the asset's own public description is copied; the credential id, signature and owner key stay on the station.
// Fungible offers get none (their class is described by the catalog), and every URL must be http(s).
// Mirrors tradeListingAssetPreview() in issuer-server/server.js.
function trade_listing_asset_preview($balance) {
  $asset = is_array($balance) ? ($balance['asset'] ?? null) : null;
  if (!is_array($asset) || ($asset['fungible'] ?? null) !== false || !is_string($asset['class'] ?? null)) return null;
  $url = function ($u) {
    return is_string($u) && strlen($u) <= 512 && preg_match('#^https?://#i', $u) ? $u : null;
  };
  $properties = null;
  if (isset($asset['properties']) && is_array($asset['properties']) && $asset['properties'] !== [] && array_keys($asset['properties']) !== range(0, count($asset['properties']) - 1)) {
    $text = json_encode($asset['properties'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($text !== false && strlen($text) <= 4096) $properties = $asset['properties'];
  }
  $issuerDomain = is_array($balance['issuer'] ?? null) && is_string($balance['issuer']['domain'] ?? null) ? substr($balance['issuer']['domain'], 0, 253) : null;
  $preview = [
    'class' => $asset['class'],
    'name' => is_string($asset['name'] ?? null) ? mb_substr($asset['name'], 0, 120) : $asset['class'],
    'fungible' => false,
    'issuerDomain' => $issuerDomain,
    'thumbnail' => $url($asset['thumbnail'] ?? null),
    'model' => $url($asset['model'] ?? null),
  ];
  if ($properties !== null) $preview['properties'] = $properties;
  return $preview;
}

$pendingDoc = read_pending_trades();
$listings = array_map(function ($t) {
  $listing = [
    'pendingId' => $t['id'],
    'posterPublicKey' => $t['intent']['proof']['publicKey'],
    'offer' => $t['intent']['payload']['offer'],
    'want' => $t['intent']['payload']['want'],
    'expiresAt' => $t['intent']['payload']['expiresAt'],
  ];
  // A unique offer also carries the listed item's own public description.
  $offerAsset = trade_listing_asset_preview($t['balance'] ?? null);
  if ($offerAsset !== null && $offerAsset['class'] === $t['intent']['payload']['offer']['class']) $listing['offerAsset'] = $offerAsset;
  return $listing;
}, $pendingDoc['trades']);

send_json(200, ['listings' => array_values($listings)]);
