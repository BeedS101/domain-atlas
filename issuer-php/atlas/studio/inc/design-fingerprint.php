<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
// Hash the VALIDATED design, not arbitrary client JSON.
// Reuse the issuer's canonical JSON rules so field order cannot change the digest.
// This helper does not authorize a mint or consume a challenge.
require_once __DIR__.'/design-validator.php';
require_once __DIR__.'/../../../lib/crypto.php';

function atlas_studio_design_fingerprint($input) {
  $validated=atlas_studio_validate_design($input);
  if (!$validated['ok']) return $validated;
  $canonical=canonicalize($validated['design']);
  return [
    'ok'=>true,
    'design'=>$validated['design'],
    'designDigest'=>hash('sha256',$canonical)
  ];
}
