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
