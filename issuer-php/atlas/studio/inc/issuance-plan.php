<?php
// Asset Studio demo collectible mapping. This module DOES NOT mint or sign.
// Use only behind a dedicated, authenticated issuer route after security review.
// The client never chooses the asset class, issuer, model path, quantity or trade policy.
require_once __DIR__ . '/design-validator.php';

function atlas_studio_issuance_plan($submitted, $ownerPublicKey) {
  $validated = atlas_studio_validate_design($submitted);
  if (!$validated['ok']) return $validated;
  // A public key is a recipient reference, not proof that this visitor owns it.
  // Caller MUST authenticate ownership (wallet challenge/signature) before issuance.
  if (!is_string($ownerPublicKey) || strlen($ownerPublicKey) < 20 || strlen($ownerPublicKey) > 2048)
    return ['ok'=>false, 'error'=>'invalid-recipient-key'];
  $d=$validated['design'];
  return [
    'ok'=>true,
    // Not a catalog class and NOT authorised by general /atlas/asset/issue.
    // Dedicated issuer-approved class is required before calling mint_asset_by_class.
    'requiredClass'=>'atlas.demo.studio.collectible',
    'quantity'=>1,
    'recipient'=>$ownerPublicKey,
    'nonFungible'=>true,
    'requiredTradeScope'=>'bound',
    'properties'=>[
      'atlas.studio.template'=>$d['template'],
      'atlas.studio.name'=>$d['name'],
      'atlas.studio.description'=>$d['description'],
      'atlas.studio.finish'=>$d['finish'],
      'atlas.studio.version'=>'0.1'
    ]
  ];
}
