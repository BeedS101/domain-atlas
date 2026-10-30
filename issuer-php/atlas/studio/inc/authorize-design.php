<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
// Studio authorization: bind a submitted design to the issuer's stored challenge and to a wallet
// proof verified by the issuer's own verifier. Does not consume a challenge or issue anything.
require_once __DIR__.'/design-fingerprint.php';
require_once __DIR__.'/mint-authorization.php';

// $retry skips the freshness test and also accepts a 'completed' challenge: it is for answering a repeat
// of a mint that may already have committed, where the original expiry has passed. The same design,
// recipient and signature must still match either way. A NEW credential is signed only when the caller
// has also confirmed the challenge is unexpired and still 'issued'.
function atlas_studio_authorize_design_proof($design,$proof,$challenge,$allowedOrigins,$verifier,$now=null,$retry=false) {
  $fp=atlas_studio_design_fingerprint($design);
  if (!$fp['ok']) return $fp;
  $states=$retry ? ['issued','completed'] : ['issued'];
  if (!is_array($challenge) || !in_array($challenge['state'] ?? null,$states,true))
    return ['ok'=>false,'error'=>'challenge-not-issued'];
  $verified=atlas_studio_verify_mint_envelope(
    $proof,$challenge,$allowedOrigins,$fp['designDigest'],atlas_studio_summary($fp['design']),$verifier,$now,!$retry
  );
  if (!$verified['ok']) return $verified;
  return ['ok'=>true,'recipient'=>$verified['recipient'],
    'design'=>$fp['design'],'designDigest'=>$fp['designDigest']];
}
