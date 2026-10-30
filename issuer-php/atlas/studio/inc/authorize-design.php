<?php
// Pure Studio authorization preflight: bind a submitted validated design
// to the issuer's exact stored challenge and an independently verified
// wallet proof. Does not consume, issue, register, or return credentials.
require_once __DIR__.'/design-fingerprint.php';
require_once __DIR__.'/mint-authorization.php';

function atlas_studio_authorize_design_proof($design,$proof,$challenge,$expectedOrigin,$verifier,$now=null) {
  $fp=atlas_studio_design_fingerprint($design);
  if (!$fp['ok']) return $fp;
  if (!is_array($challenge) || ($challenge['state'] ?? null)!=='issued')
    return ['ok'=>false,'error'=>'challenge-not-issued'];
  $verified=atlas_studio_verify_mint_envelope(
    $proof,$challenge,$expectedOrigin,$fp['designDigest'],$verifier,$now
  );
  if (!$verified['ok']) return $verified;
  return ['ok'=>true,'recipient'=>$verified['recipient'],
    'design'=>$fp['design'],'designDigest'=>$fp['designDigest']];
}
