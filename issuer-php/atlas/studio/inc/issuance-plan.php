<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
// Asset Studio demo collectible mapping. Pure apart from reading the clock: builds the plan and the signed asset body from a
// validated design; it does not sign, store or consume anything.
// The client never chooses the asset class, issuer, model path or quantity. It may choose, within the issuer's
// limits, a trade scope of 'bound' (default) or 'local', an expiry and a few labelled properties; all three are part
// of the signed design digest.
require_once __DIR__ . '/design-fingerprint.php';
require_once __DIR__ . '/model-catalog.php';
require_once __DIR__ . '/keys.php';

const ATLAS_STUDIO_CLASS = 'atlas.demo.studio.collectible';
const ATLAS_STUDIO_MINT_PURPOSE = 'atlas.studio.mint/1';

// What the wallet shows the visitor in the signing prompt. Derived from the validated design, so
// the page cannot describe one design and sign another; the issuer recomputes it from the design
// it fingerprints and rejects a signed payload whose summary differs.
function atlas_studio_summary($design) {
  $enc = function ($v) { return json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES); };
  $text = 'Mint a free demo ' . $design['template'] . ' (' . $design['finish'] . ') named ' . $enc($design['name']);
  if (!empty($design['properties'])) {
    $pairs = [];
    foreach ($design['properties'] as $k => $v) $pairs[] = $k . ' ' . $enc($v);
    $text .= ' with ' . implode(', ', $pairs);
  }
  $tail = ($design['tradeScope'] ?? 'bound') === 'local'
    ? 'can be given to other wallets on this domain.'
    : 'is bound to this wallet: it cannot be transferred or traded.';
  $text .= isset($design['expiresAt'])
    ? '. It has no value, expires ' . $design['expiresAt'] . ', and ' . $tail
    : '. It has no value and ' . $tail;
  return $text;
}

// $opts, all optional: now (int), allowLocal (bool, default false: fail closed), expiryMin / expiryMax
// (seconds a design's expiry must lie ahead of now, defaults one hour and one year). The design's own
// validity is pure; these are the issuer's policy limits and depend on the clock, so they are applied
// here, at plan time, never in the validator or the fingerprint.
function atlas_studio_issuance_plan($submitted, $ownerPublicKey, $opts = []) {
  $fp = atlas_studio_design_fingerprint($submitted);
  if (!$fp['ok']) return $fp;
  // A public key is a recipient reference, not proof that this visitor owns it.
  // Callers MUST authenticate ownership (wallet signature) before issuing.
  if (!atlas_studio_recipient_ok($ownerPublicKey)) return ['ok'=>false, 'error'=>'invalid-recipient-key'];
  $d = $fp['design'];
  $scope = $d['tradeScope'] ?? 'bound';
  if ($scope === 'local' && empty($opts['allowLocal'])) return ['ok'=>false,'error'=>'giftable-not-allowed'];
  $expiresAt = $d['expiresAt'] ?? null;
  if ($expiresAt !== null) {
    $now = $opts['now'] ?? time();
    $ahead = strtotime($expiresAt) - $now;
    if ($ahead < ($opts['expiryMin'] ?? 3600)) return ['ok'=>false,'error'=>'expiry-too-soon'];
    if ($ahead > ($opts['expiryMax'] ?? 31536000)) return ['ok'=>false,'error'=>'expiry-too-far'];
  }
  $model = atlas_studio_model_for_template($d['template']);
  if ($model === null) return ['ok'=>false,'error'=>'model-not-approved'];
  $properties = [
    'atlas.studio.template'=>$d['template'],
    'atlas.studio.name'=>$d['name'],
    'atlas.studio.description'=>$d['description'],
    'atlas.studio.finish'=>$d['finish'],
    'atlas.studio.designDigest'=>$fp['designDigest'],
    'atlas.studio.version'=>'0.1'
  ];
  foreach ($d['properties'] ?? [] as $k => $v) $properties['atlas.studio.custom.' . $k] = $v;
  return [
    'ok'=>true,
    'requiredClass'=>ATLAS_STUDIO_CLASS,
    'quantity'=>1,
    'recipient'=>$ownerPublicKey,
    'nonFungible'=>true,
    'requiredTradeScope'=>$scope,
    'expiresAt'=>$expiresAt,
    'model'=>$model,
    'designDigest'=>$fp['designDigest'],
    'summary'=>atlas_studio_summary($d),
    'properties'=>$properties
  ];
}

// The asset object an issuer-signed credential carries, from the catalog entry for the Studio class
// (name, flags, tradeScope, fixed properties) with the template's approved model and the design's
// properties. $baseAsset is atlas_asset_catalog_entry(ATLAS_STUDIO_CLASS); $domain is this issuer's
// own host, used to make the model URLs absolute exactly as the catalog does.
function atlas_studio_build_asset($baseAsset, $plan, $domain) {
  if (!is_array($baseAsset) || ($baseAsset['class'] ?? null) !== ATLAS_STUDIO_CLASS) return null;
  if (($baseAsset['fungible'] ?? null) !== false || ($baseAsset['tradeScope'] ?? null) !== 'bound') return null;
  if (!in_array($plan['requiredTradeScope'] ?? null, ['bound','local'], true)) return null;
  $asset = $baseAsset;
  $asset['tradeScope'] = $plan['requiredTradeScope'];
  if (isset($plan['expiresAt'])) $asset['expiresAt'] = $plan['expiresAt'];
  $asset['name'] = $plan['properties']['atlas.studio.name'];
  $asset['model'] = 'https://' . $domain . $plan['model']['modelPath'];
  $asset['thumbnail'] = 'https://' . $domain . $plan['model']['thumbnailPath'];
  $asset['properties'] = array_merge(isset($baseAsset['properties']) ? $baseAsset['properties'] : [], $plan['properties']);
  return $asset;
}
