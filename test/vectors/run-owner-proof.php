<?php
// Runs test/vectors/owner-proof.json through issuer-php's owner-proof decision and prints one JSON verdict per case,
// in order, for the Node runner to compare. Usage: php run-owner-proof.php <vectors.json>
require_once __DIR__ . '/../../issuer-php/lib/crypto.php';
require_once __DIR__ . '/../../issuer-php/lib/owner-proof.php';
$doc = json_decode(file_get_contents($argv[1]), true);
// Raw P-256 only: the vectors carry no passkey assertions that verify, and a passkey proof must fail here.
$verify = function ($payload, $proof) {
  if (($proof['signerRole'] ?? null) !== 'raw-ecdsa') return false;
  $pem = ec_raw_point_to_pem(b64url_decode($proof['publicKey']));
  return ecdsa_verify_raw($pem, b64url_decode($proof['signature']), canonicalize($payload));
};
$out = [];
foreach ($doc['cases'] as $case) {
  $r = atlas_owner_proof_verdict($case['body'], $case['ctx'], $verify);
  unset($r['error'], $r['issuedAtMs'], $r['updateWallet']);
  $out[] = $r;
}
echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
