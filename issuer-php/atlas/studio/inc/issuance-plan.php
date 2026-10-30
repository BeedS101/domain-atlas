<?php
// Asset Studio demo collectible mapping. Pure: builds the plan and the signed asset body from a
// validated design; it does not sign, store or consume anything.
// The client never chooses the asset class, issuer, model path, quantity or trade policy.
require_once __DIR__ . '/design-fingerprint.php';
require_once __DIR__ . '/model-catalog.php';
require_once __DIR__ . '/keys.php';

const ATLAS_STUDIO_CLASS = 'atlas.demo.studio.collectible';
const ATLAS_STUDIO_MINT_PURPOSE = 'atlas.studio.mint/1';

// What the wallet shows the visitor in the signing prompt. Derived from the validated design, so
// the page cannot describe one design and sign another; the issuer recomputes it from the design
// it fingerprints and rejects a signed payload whose summary differs.
function atlas_studio_summary($design) {
  return 'Mint a free demo ' . $design['template'] . ' (' . $design['finish'] . '): ' . $design['name'] . '. No value.';
}

function atlas_studio_issuance_plan($submitted, $ownerPublicKey) {
  $fp = atlas_studio_design_fingerprint($submitted);
  if (!$fp['ok']) return $fp;
  // A public key is a recipient reference, not proof that this visitor owns it.
  // Callers MUST authenticate ownership (wallet signature) before issuing.
  if (!atlas_studio_recipient_ok($ownerPublicKey)) return ['ok'=>false, 'error'=>'invalid-recipient-key'];
  $d = $fp['design'];
  $model = atlas_studio_model_for_template($d['template']);
  if ($model === null) return ['ok'=>false,'error'=>'model-not-approved'];
  return [
    'ok'=>true,
    'requiredClass'=>ATLAS_STUDIO_CLASS,
    'quantity'=>1,
    'recipient'=>$ownerPublicKey,
    'nonFungible'=>true,
    'requiredTradeScope'=>'bound',
    'model'=>$model,
    'designDigest'=>$fp['designDigest'],
    'summary'=>atlas_studio_summary($d),
    'properties'=>[
      'atlas.studio.template'=>$d['template'],
      'atlas.studio.name'=>$d['name'],
      'atlas.studio.description'=>$d['description'],
      'atlas.studio.finish'=>$d['finish'],
      'atlas.studio.designDigest'=>$fp['designDigest'],
      'atlas.studio.version'=>'0.1'
    ]
  ];
}

// The asset object an issuer-signed credential carries, from the catalog entry for the Studio class
// (name, flags, tradeScope, fixed properties) with the template's approved model and the design's
// properties. $baseAsset is atlas_asset_catalog_entry(ATLAS_STUDIO_CLASS); $domain is this issuer's
// own host, used to make the model URLs absolute exactly as the catalog does.
function atlas_studio_build_asset($baseAsset, $plan, $domain) {
  if (!is_array($baseAsset) || ($baseAsset['class'] ?? null) !== ATLAS_STUDIO_CLASS) return null;
  if (($baseAsset['fungible'] ?? null) !== false || ($baseAsset['tradeScope'] ?? null) !== 'bound') return null;
  $asset = $baseAsset;
  $asset['name'] = $plan['properties']['atlas.studio.name'];
  $asset['model'] = 'https://' . $domain . $plan['model']['modelPath'];
  $asset['thumbnail'] = 'https://' . $domain . $plan['model']['thumbnailPath'];
  $asset['properties'] = array_merge(isset($baseAsset['properties']) ? $baseAsset['properties'] : [], $plan['properties']);
  return $asset;
}
