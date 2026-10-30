<?php
// Studio proof preflight. Pure validation; NO signature or issuance occurs here.
// The caller must verify the cryptographic envelope with verify_envelope($signedPayload, $proof, true)
// and consume the challenge atomically before minting.
function atlas_studio_check_mint_proof($proof, $challenge, $expectedOrigin, $designDigest, $now = null) {
  $now = $now ?? time();
  if (!is_array($proof) || !is_array($challenge)) return ['ok'=>false,'error'=>'invalid-proof'];
  $signed=$proof['signedPayload'] ?? null;
  if (!is_array($signed) || ($signed['ctx'] ?? null)!=='atlas.bridge.sign/1' || ($signed['origin'] ?? null)!==$expectedOrigin)
    return ['ok'=>false,'error'=>'wrong-signing-context'];
  $p=$signed['payload'] ?? null;
  if (!is_array($p) || count($p)!==5 || array_diff(array_keys($p),['purpose','nonce','designDigest','recipient','expiresAt']))
    return ['ok'=>false,'error'=>'invalid-payload-shape'];
  // Reject hostile JSON types before comparisons. In particular, PHP casting an
  // array to a string in hash_equals() emits warnings and must never happen.
  foreach (['nonce','designDigest','recipient'] as $field) {
    if (!is_string($p[$field] ?? null) || !is_string($challenge[$field] ?? null))
      return ['ok'=>false,'error'=>'invalid-proof-types'];
  }
  if (!is_string($designDigest) || !preg_match('/^[a-f0-9]{64}$/D', $designDigest) ||
      !preg_match('/^[a-f0-9]{64}$/D', $p['nonce']) ||
      !preg_match('/^[a-f0-9]{64}$/D', $p['designDigest']) ||
      !is_string($expectedOrigin) || !preg_match('#^https://[^/]+$#D', $expectedOrigin) ||
      !is_string($proof['publicKey'] ?? null))
    return ['ok'=>false,'error'=>'invalid-proof-types'];
  if (($p['purpose'] ?? null)!=='atlas.studio.mint/1' ||
      !hash_equals((string)($challenge['nonce'] ?? ''),(string)($p['nonce'] ?? '')) ||
      !hash_equals((string)$designDigest,(string)($p['designDigest'] ?? '')) ||
      ($challenge['designDigest'] ?? null)!==$designDigest ||
      ($challenge['recipient'] ?? null)!==($p['recipient'] ?? null) ||
      ($p['expiresAt'] ?? null)!==($challenge['expiresAt'] ?? null) ||
      !is_int($p['expiresAt']) || $p['expiresAt'] < $now || $p['expiresAt'] > $now + 300 ||
      !is_string($p['recipient']) || $p['recipient'] === '' ||
      ($p['recipient'] ?? null) !== ($proof['publicKey'] ?? null) ||
      !in_array($proof['signerRole'] ?? null,['raw-ecdsa','webauthn'],true))
    return ['ok'=>false,'error'=>'proof-mismatch'];
  return ['ok'=>true,'signedPayload'=>$signed,'recipient'=>$p['recipient']];
}


// Combines the Studio-specific binding check with the existing issuer's
// cryptographic verifier. The caller must supply a server-loaded challenge,
// verified origin and digest; this does not consume or issue anything.
// The verifier should be PHP issuer verify_envelope(..., ..., true).
function atlas_studio_verify_mint_envelope($proof, $challenge, $expectedOrigin, $designDigest, $verifier, $now = null) {
  $check = atlas_studio_check_mint_proof($proof, $challenge, $expectedOrigin, $designDigest, $now);
  if (!$check['ok']) return $check;
  if (!is_callable($verifier)) return ['ok'=>false,'error'=>'verifier-unavailable'];
  // Explicitly pass the bridge-signed payload, which is what the wallet signed.
  try {
    if (!$verifier($check['signedPayload'], $proof)) return ['ok'=>false,'error'=>'invalid-signature'];
  } catch (Throwable $e) {
    return ['ok'=>false,'error'=>'invalid-signature'];
  }
  return ['ok'=>true,'recipient'=>$check['recipient']];
}
