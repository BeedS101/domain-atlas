<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
// Studio mint proof checks: what the visitor's wallet signed, bound to the issuer's own challenge.
//
// The wallet signs { ctx: 'atlas.bridge.sign/1', origin, payload } (SPEC.md §3.8.1) where payload is the
// exact request the issuer handed out with the challenge. Binding checks (this file, pure) come first and
// the cryptographic check (the issuer's verify_envelope(), passed in as $verifier) follows. Neither
// consumes a challenge or issues anything.
require_once __DIR__.'/keys.php';
require_once __DIR__.'/issuance-plan.php';

const ATLAS_STUDIO_CHALLENGE_TTL = 120;

// The payload the wallet is asked to sign. Fixed shape; nothing the page adds can ride along.
function atlas_studio_sign_request($challenge, $summary) {
  return [
    'purpose'=>ATLAS_STUDIO_MINT_PURPOSE,
    'nonce'=>$challenge['nonce'],
    'designDigest'=>$challenge['designDigest'],
    'recipient'=>$challenge['recipient'],
    'expiresAt'=>$challenge['expiresAt'],
    'summary'=>$summary,
  ];
}

// A WebAuthn assertion counts only with clientDataJSON.type 'webauthn.get' and the authenticator's
// user-present flag set; verify_envelope() itself checks neither. Raw-ECDSA identities are unaffected.
function atlas_studio_webauthn_presence($proof) {
  if (($proof['signerRole'] ?? null) !== 'webauthn') return true;
  $client=$proof['clientDataJSON'] ?? null;
  $auth=$proof['authenticatorData'] ?? null;
  if (!is_string($client) || !is_string($auth)) return false;
  $rawClient=atlas_studio_b64url_exact($client);
  $rawAuth=atlas_studio_b64url_exact($auth);
  if ($rawClient===null || $rawAuth===null || strlen($rawAuth)<37) return false;
  $data=json_decode($rawClient,true);
  return is_array($data) && ($data['type'] ?? null)==='webauthn.get'
    && (ord($rawAuth[32]) & 0x01)!==0;
}

// Optional pin on the WebAuthn relying party. verify_envelope() does not look at the authenticator's rpIdHash
// or the client-data origin, so by default any credential whose signature verifies is accepted; the wallet's
// passkeys are scoped to the wallet, not to this issuer. When `webauthnRpIds` is configured, the rpIdHash must
// be the SHA-256 of one of those ids. Raw-ECDSA identities are unaffected. null means no pin.
function atlas_studio_webauthn_rp_ok($proof, $rpIds) {
  if ($rpIds === null || ($proof['signerRole'] ?? null) !== 'webauthn') return true;
  $rawAuth = is_string($proof['authenticatorData'] ?? null) ? atlas_studio_b64url_exact($proof['authenticatorData']) : null;
  if ($rawAuth === null || strlen($rawAuth) < 37 || !is_array($rpIds)) return false;
  foreach ($rpIds as $id) if (is_string($id) && hash_equals(hash('sha256', $id, true), substr($rawAuth, 0, 32))) return true;
  return false;
}

// Binding checks. $allowedOrigins are the exact origins this issuer's configuration names; $summary is
// recomputed by the issuer from the validated design. $requireFresh is false only when answering a retry
// for a mint that already completed, where the original expiry has legitimately passed.
function atlas_studio_check_mint_proof($proof, $challenge, $allowedOrigins, $designDigest, $summary, $now = null, $requireFresh = true) {
  $now = $now ?? time();
  if (!is_array($proof) || !is_array($challenge)) return ['ok'=>false,'error'=>'invalid-proof'];
  $allowedFields=['signerRole','publicKey','signature','clientDataJSON','authenticatorData','signedPayload'];
  if (array_diff(array_keys($proof),$allowedFields)) return ['ok'=>false,'error'=>'invalid-proof'];
  $signed=$proof['signedPayload'] ?? null;
  if (!is_array($signed) || ($signed['ctx'] ?? null)!=='atlas.bridge.sign/1' ||
      !is_string($signed['origin'] ?? null) || !is_array($allowedOrigins) || !in_array($signed['origin'],$allowedOrigins,true) ||
      count($signed)!==3)
    return ['ok'=>false,'error'=>'wrong-signing-context'];
  $p=$signed['payload'] ?? null;
  $shape=['purpose','nonce','designDigest','recipient','expiresAt','summary'];
  if (!is_array($p) || count($p)!==count($shape) || array_diff(array_keys($p),$shape))
    return ['ok'=>false,'error'=>'invalid-payload-shape'];
  // Reject hostile JSON types before any comparison.
  foreach (['purpose','nonce','designDigest','recipient','summary'] as $field) {
    if (!is_string($p[$field])) return ['ok'=>false,'error'=>'invalid-proof-types'];
  }
  foreach (['nonce','designDigest','recipient'] as $field) {
    if (!is_string($challenge[$field] ?? null)) return ['ok'=>false,'error'=>'invalid-proof-types'];
  }
  if (!is_int($p['expiresAt']) || !is_string($designDigest) || !is_string($summary) ||
      !preg_match('/^[a-f0-9]{64}$/D', $designDigest) || !preg_match('/^[a-f0-9]{64}$/D', $p['nonce']) ||
      !preg_match('/^[a-f0-9]{64}$/D', $p['designDigest']) || !is_string($proof['publicKey'] ?? null))
    return ['ok'=>false,'error'=>'invalid-proof-types'];
  $role=$proof['signerRole'] ?? null;
  $kind=atlas_studio_p256_key_kind($proof['publicKey']);
  if (($role==='raw-ecdsa' && $kind!=='raw') || ($role==='webauthn' && $kind!=='spki'))
    return ['ok'=>false,'error'=>'invalid-proof-key'];
  if ($p['purpose']!==ATLAS_STUDIO_MINT_PURPOSE ||
      !hash_equals($challenge['nonce'],$p['nonce']) ||
      !hash_equals($designDigest,$p['designDigest']) ||
      !hash_equals($challenge['designDigest'],$designDigest) ||
      !hash_equals($challenge['recipient'],$p['recipient']) ||
      !hash_equals($p['recipient'],$proof['publicKey']) ||
      !hash_equals($summary,$p['summary']) ||
      ($challenge['expiresAt'] ?? null)!==$p['expiresAt'] ||
      !in_array($role,['raw-ecdsa','webauthn'],true))
    return ['ok'=>false,'error'=>'proof-mismatch'];
  if ($requireFresh && ($p['expiresAt'] < $now || $p['expiresAt'] > $now + ATLAS_STUDIO_CHALLENGE_TTL))
    return ['ok'=>false,'error'=>'challenge-expired'];
  return ['ok'=>true,'signedPayload'=>$signed,'recipient'=>$p['recipient']];
}

// Binding checks, WebAuthn presence, then the cryptographic verifier (the issuer's
// verify_envelope($signed, $proof, true) in production).
function atlas_studio_verify_mint_envelope($proof, $challenge, $allowedOrigins, $designDigest, $summary, $verifier, $now = null, $requireFresh = true) {
  $check = atlas_studio_check_mint_proof($proof, $challenge, $allowedOrigins, $designDigest, $summary, $now, $requireFresh);
  if (!$check['ok']) return $check;
  if (!atlas_studio_webauthn_presence($proof)) return ['ok'=>false,'error'=>'webauthn-presence-required'];
  if (!is_callable($verifier)) return ['ok'=>false,'error'=>'verifier-unavailable'];
  try {
    if ($verifier($check['signedPayload'], $proof) !== true) return ['ok'=>false,'error'=>'invalid-signature'];
  } catch (Throwable $e) {
    return ['ok'=>false,'error'=>'invalid-signature'];
  }
  return ['ok'=>true,'recipient'=>$check['recipient']];
}
