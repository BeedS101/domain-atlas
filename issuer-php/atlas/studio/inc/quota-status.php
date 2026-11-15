<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
// Read-only answer to "how many Studio mints does this wallet have left?", for the wallet that asks.
//
// The count comes from the mint-attempt ledger (inc/mint-attempts.php), the same records the mint quota is
// enforced from. A wallet's history is not public: a caller must show it controls the key, either with a wallet
// signature over a fixed read-only request (purpose below, verified by the same verifier as a mint proof) or with a
// short-lived token that an earlier signed answer returned, so a page does not need a wallet prompt for every
// refresh. The token is an HMAC over the key and its expiry; it carries no history and is useless for any other key.
require_once __DIR__.'/mint-attempts.php';
require_once __DIR__.'/mint-authorization.php';
require_once __DIR__.'/studio-mint.php';

const ATLAS_STUDIO_QUOTA_PURPOSE = 'atlas.studio.quota/1';
const ATLAS_STUDIO_QUOTA_SUMMARY = 'Read how many Asset Studio mints this wallet has left. Nothing is minted or changed.';
const ATLAS_STUDIO_QUOTA_PAST = 600;   // a signed request may be this old...
const ATLAS_STUDIO_QUOTA_FUTURE = 120; // ...or this far ahead of the issuer's clock
const ATLAS_STUDIO_QUOTA_TOKEN_TTL = 3600;
const ATLAS_STUDIO_QUOTA_ASK_LIMIT = 30; // requests per minute from one network

// The payload the wallet is asked to sign. Fixed shape; nothing the page adds can ride along.
function atlas_studio_quota_sign_request($recipient, $issuedAt) {
  return ['purpose'=>ATLAS_STUDIO_QUOTA_PURPOSE,'recipient'=>$recipient,'issuedAt'=>$issuedAt,'summary'=>ATLAS_STUDIO_QUOTA_SUMMARY];
}

// Binding checks for a quota proof: exact wrapper, an allowed origin, exact payload shape and values, the
// signing key equal to the asked-about key, and a recent timestamp. The signature itself is $verifier's job.
function atlas_studio_check_quota_proof($proof, $recipient, $allowedOrigins, $now) {
  if (!is_array($proof) || !is_string($recipient)) return ['ok'=>false,'error'=>'invalid-proof'];
  if (array_diff(array_keys($proof), ['signerRole','publicKey','signature','clientDataJSON','authenticatorData','signedPayload'])) return ['ok'=>false,'error'=>'invalid-proof'];
  $signed = $proof['signedPayload'] ?? null;
  if (!is_array($signed) || count($signed) !== 3 || ($signed['ctx'] ?? null) !== 'atlas.bridge.sign/1' ||
      !is_string($signed['origin'] ?? null) || !is_array($allowedOrigins) || !in_array($signed['origin'], $allowedOrigins, true))
    return ['ok'=>false,'error'=>'wrong-signing-context'];
  $p = $signed['payload'] ?? null;
  if (!is_array($p) || count($p) !== 4 || array_diff(array_keys($p), ['purpose','recipient','issuedAt','summary'])) return ['ok'=>false,'error'=>'invalid-payload-shape'];
  if (!is_string($p['purpose']) || !is_string($p['recipient']) || !is_string($p['summary']) || !is_int($p['issuedAt']) || !is_string($proof['publicKey'] ?? null))
    return ['ok'=>false,'error'=>'invalid-proof-types'];
  $role = $proof['signerRole'] ?? null;
  $kind = atlas_studio_p256_key_kind($proof['publicKey']);
  if (($role === 'raw-ecdsa' && $kind !== 'raw') || ($role === 'webauthn' && $kind !== 'spki')) return ['ok'=>false,'error'=>'invalid-proof-key'];
  if ($p['purpose'] !== ATLAS_STUDIO_QUOTA_PURPOSE || $p['summary'] !== ATLAS_STUDIO_QUOTA_SUMMARY ||
      !hash_equals($recipient, $p['recipient']) || !hash_equals($p['recipient'], $proof['publicKey']) || !in_array($role, ['raw-ecdsa','webauthn'], true))
    return ['ok'=>false,'error'=>'proof-mismatch'];
  if ($p['issuedAt'] < $now - ATLAS_STUDIO_QUOTA_PAST || $p['issuedAt'] > $now + ATLAS_STUDIO_QUOTA_FUTURE) return ['ok'=>false,'error'=>'request-expired'];
  return ['ok'=>true,'signedPayload'=>$signed];
}

// Per-installation secret for tokens, derived from the rate-limit salt so there is no second secret file to keep.
function atlas_studio_quota_token_key($root) {
  return hash_hmac('sha256', 'studio-quota-token/1', atlas_studio_rate_salt(atlas_studio_storage_bucket($root, 'rate')), true);
}

function atlas_studio_quota_token($root, $recipient, $expires) {
  $fp = atlas_studio_key_fingerprint($recipient);
  if ($fp === null) return null;
  return $expires.'.'.hash_hmac('sha256', 'quota:'.$fp.':'.$expires, atlas_studio_quota_token_key($root));
}

function atlas_studio_quota_token_ok($root, $recipient, $token, $now) {
  if (!is_string($token) || !preg_match('/^([1-9][0-9]{0,11})\.([a-f0-9]{64})$/D', $token, $m)) return false;
  $expires = (int) $m[1];
  if ($expires <= $now || $expires > $now + ATLAS_STUDIO_QUOTA_TOKEN_TTL) return false;
  $want = atlas_studio_quota_token($root, $recipient, $expires);
  return $want !== null && hash_equals($want, $token);
}

// POST ?op=quota  { recipient, proof }  or  { recipient, token }
// 200 { ok, wallet: { limit, used, remaining, windowSeconds, nextSlotAt }, otherLimit, now [, token, tokenExpiresAt] }.
// `otherLimit` names an issuer-wide limit that would refuse this caller before the wallet's own share runs out
// ('quota-actor', 'quota-group', 'quota-global', 'quota-reserved'), or null. Only an answer to a signed request
// carries a new token.
function atlas_studio_quota($root, $cfg, $body, $actor, $verifier, $now = null) {
  $now = $now ?? time();
  if (!is_array($body) || array_diff(array_keys($body), ['recipient','proof','token']) || !isset($body['recipient']) || (isset($body['proof']) === isset($body['token'])))
    return atlas_studio_err(400, 'invalid-request');
  $recipient = $body['recipient'];
  if (!is_string($recipient) || !atlas_studio_recipient_ok($recipient)) return atlas_studio_err(400, 'invalid-recipient');
  $signed = isset($body['proof']);
  if ($signed) {
    $check = atlas_studio_check_quota_proof($body['proof'], $recipient, $cfg['origins'], $now);
    if (!$check['ok']) return atlas_studio_err($check['error'] === 'request-expired' ? 410 : 403, $check['error']);
    if (!atlas_studio_webauthn_presence($body['proof']) || !atlas_studio_webauthn_rp_ok($body['proof'], $cfg['webauthnRpIds'] ?? null)) return atlas_studio_err(403, 'webauthn-presence-required');
    try { $ok = is_callable($verifier) && $verifier($check['signedPayload'], $body['proof']) === true; } catch (Throwable $e) { $ok = false; }
    if (!$ok) return atlas_studio_err(403, 'invalid-signature');
  } elseif (!atlas_studio_quota_token_ok($root, $recipient, $body['token'], $now)) {
    return atlas_studio_err(403, 'invalid-token');
  }
  $limits = ['perRecipient'=>$cfg['maxMintsPerRecipientPerDay'],'perActor'=>$cfg['maxMintsPerActorPerDay'],'perGroup'=>$cfg['maxMintsPerNetworkPerDay'],
    'global'=>$cfg['maxMintsPerDay'],'reserve'=>$cfg['newActorReserve'],'windowSeconds'=>86400];
  $reply = ['ok'=>true,'wallet'=>atlas_studio_quota_status($root, $recipient, $limits, $now, $actor['key'], $actor['group'])];
  $reply['otherLimit'] = $reply['wallet']['otherLimit'];
  unset($reply['wallet']['otherLimit']);
  $reply['now'] = $now;
  if ($signed) {
    $reply['tokenExpiresAt'] = $now + ATLAS_STUDIO_QUOTA_TOKEN_TTL;
    $reply['token'] = atlas_studio_quota_token($root, $recipient, $reply['tokenExpiresAt']);
  }
  return [200, $reply];
}
