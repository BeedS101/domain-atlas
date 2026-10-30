<?php
// Public-key checks for Studio recipients and proof keys.
// An owner key is accepted only in the spellings the wallet and issuer already use, and only when
// it parses as a real NIST P-256 key: either the 65-byte uncompressed point (87 characters of
// base64url) or a P-256 SubjectPublicKeyInfo DER (WebAuthn identities), written canonically.
require_once __DIR__.'/../../../lib/crypto.php';

function atlas_studio_b64url_exact($s) {
  if (!is_string($s) || $s === '' || strlen($s) > 512 || !preg_match('/^[A-Za-z0-9_-]+$/D', $s)) return null;
  $bin = base64_decode(strtr($s, '-_', '+/') . str_repeat('=', (4 - strlen($s) % 4) % 4), true);
  if ($bin === false || rtrim(strtr(base64_encode($bin), '+/', '-_'), '=') !== $s) return null;
  return $bin;
}

// 'raw' or 'spki' for a valid P-256 public key, null otherwise. Uses OpenSSL's own parser, so a point
// that is not on the curve, or a key on a different curve, is refused.
function atlas_studio_p256_key_kind($s) {
  $bin = atlas_studio_b64url_exact($s);
  if ($bin === null) return null;
  if (strlen($bin) === 65 && ord($bin[0]) === 4) {
    $pem = pem_wrap(ATLAS_P256_SPKI_PREFIX . $bin, 'PUBLIC KEY');
    $kind = 'raw';
  } elseif (strlen($bin) > 65 && strlen($bin) <= 200 && substr($bin, 0, 2) === "\x30" . chr(strlen($bin) - 2)) {
    $pem = pem_wrap($bin, 'PUBLIC KEY');
    $kind = 'spki';
  } else {
    return null;
  }
  $key = @openssl_pkey_get_public($pem);
  if ($key === false) return null;
  $d = openssl_pkey_get_details($key);
  if (!is_array($d) || ($d['type'] ?? null) !== OPENSSL_KEYTYPE_EC || ($d['ec']['curve_name'] ?? null) !== 'prime256v1') return null;
  return $kind;
}

function atlas_studio_recipient_ok($s) {
  return atlas_studio_p256_key_kind($s) !== null;
}
