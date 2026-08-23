<?php
// Domain Atlas — PHP issuer: crypto primitives.
//
// This file exists because the browser extension verifies everything with
// the Web Crypto API, and Web Crypto's ECDSA is fussy in ways OpenSSL isn't:
//   - Web Crypto signatures/verification always use "raw" r||s (64 bytes for
//     P-256), never DER. OpenSSL's openssl_sign()/openssl_verify() always
//     use DER. Every signature that crosses the PHP<->browser boundary has
//     to be converted one way or the other — get this wrong and signatures
//     look "invalid" for no reason a casual reading of the code would show.
//   - Web Crypto's 'raw' public key format is the SEC1 uncompressed point
//     (0x04 || X || Y, 65 bytes for P-256). OpenSSL wants a PEM/DER
//     SubjectPublicKeyInfo. Converting between them needs a fixed ASN.1
//     prefix — hardcoded below, it's the same 26 bytes for every P-256 key.
//   - OpenSSL silently returns X/Y coordinates with leading zero bytes
//     stripped (confirmed empirically — roughly 1 in 256 keys has a short
//     X or Y). Skip the left-pad-to-32-bytes step and you get a renderer
//     that works during testing and then produces a garbled public key for
//     a random visitor weeks later. Always pad.
//
// All three of the above were verified against real Node/Web Crypto output
// before this was wired into the endpoints (see the project chat history —
// canonicalize() byte-for-byte diffed against wallet.js's version, and the
// DER<->raw conversion round-tripped 300 fresh keypairs with zero failures).

// ---------- base64url ----------

function b64url_encode($bin) {
  return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}

function b64url_decode($str) {
  $str = strtr($str, '-_', '+/');
  $pad = strlen($str) % 4;
  if ($pad) $str .= str_repeat('=', 4 - $pad);
  $out = base64_decode($str, true);
  if ($out === false) throw new Exception('malformed base64url');
  return $out;
}

// ---------- canonical JSON — MUST match extension/wallet.js's canonicalize()
// and issuer-server/server.js's canonicalize() exactly, byte for byte, or
// a real signature will look "invalid" purely from encoding differences. ----------

function atlas_json_string($s) {
  $out = '"';
  $len = strlen($s);
  for ($i = 0; $i < $len; $i++) {
    $c = $s[$i];
    $ord = ord($c);
    if ($c === '"') { $out .= '\\"'; }
    elseif ($c === '\\') { $out .= '\\\\'; }
    elseif ($ord === 0x08) { $out .= '\\b'; }
    elseif ($ord === 0x0C) { $out .= '\\f'; }
    elseif ($ord === 0x0A) { $out .= '\\n'; }
    elseif ($ord === 0x0D) { $out .= '\\r'; }
    elseif ($ord === 0x09) { $out .= '\\t'; }
    elseif ($ord < 0x20) { $out .= sprintf('\\u%04x', $ord); }
    else { $out .= $c; } // NOT escaping '/' or non-ASCII — JS's JSON.stringify doesn't either.
  }
  return $out . '"';
}

// array_is_list() is PHP 8.1+ only. Shared hosting (this file's whole
// reason for existing) very often still defaults an account to PHP 7.x or
// 8.0 unless you've explicitly bumped it in cPanel's MultiPHP Manager — so
// this polyfills it rather than assuming a modern PHP version is running.
function atlas_array_is_list($arr) {
  if (function_exists('array_is_list')) return array_is_list($arr);
  $i = 0;
  foreach ($arr as $k => $v) {
    if ($k !== $i) return false;
    $i++;
  }
  return true;
}

function canonicalize($value) {
  if ($value === null) return 'null';
  if (is_bool($value)) return $value ? 'true' : 'false';
  if (is_int($value)) return (string) $value;
  if (is_float($value)) return (string) $value; // not used for anything hashed in this app
  if (is_string($value)) return atlas_json_string($value);
  if (is_array($value)) {
    if (atlas_array_is_list($value)) {
      return '[' . implode(',', array_map('canonicalize', $value)) . ']';
    }
    $keys = array_keys($value);
    sort($keys, SORT_STRING);
    $parts = [];
    foreach ($keys as $k) {
      $parts[] = atlas_json_string((string) $k) . ':' . canonicalize($value[$k]);
    }
    return '{' . implode(',', $parts) . '}';
  }
  throw new Exception('canonicalize: unsupported value type');
}

function sha256_raw($data) {
  return hash('sha256', $data, true);
}

// ---------- DER <-> raw ECDSA signature conversion (P-256: 32-byte r, 32-byte s) ----------

function der_to_raw_ecdsa_sig($der) {
  $offset = 2; // skip SEQUENCE tag + short-form length byte
  $readInt = function () use ($der, &$offset) {
    if (ord($der[$offset]) !== 0x02) throw new Exception('malformed DER signature: expected INTEGER');
    $offset++;
    $len = ord($der[$offset]);
    $offset++;
    $val = substr($der, $offset, $len);
    $offset += $len;
    while (strlen($val) > 32 && ord($val[0]) === 0) $val = substr($val, 1);
    return str_pad($val, 32, "\x00", STR_PAD_LEFT);
  };
  $r = $readInt();
  $s = $readInt();
  return $r . $s;
}

function der_int_encode($bytes32) {
  $i = 0;
  while ($i < 31 && ord($bytes32[$i]) === 0) $i++;
  $trimmed = substr($bytes32, $i);
  if (ord($trimmed[0]) & 0x80) $trimmed = "\x00" . $trimmed;
  return "\x02" . chr(strlen($trimmed)) . $trimmed;
}

function raw_to_der_ecdsa_sig($raw64) {
  if (strlen($raw64) !== 64) throw new Exception('raw ECDSA signature must be 64 bytes');
  $r = substr($raw64, 0, 32);
  $s = substr($raw64, 32, 32);
  $body = der_int_encode($r) . der_int_encode($s);
  return "\x30" . chr(strlen($body)) . $body;
}

// ---------- raw EC point (Web Crypto 'raw' format) <-> PEM SubjectPublicKeyInfo ----------

// Fixed ASN.1 prefix for "id-ecPublicKey + prime256v1" SubjectPublicKeyInfo,
// identical for every P-256 key — only the 65-byte point differs.
define('ATLAS_P256_SPKI_PREFIX', hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200'));

function pem_wrap($der, $label) {
  return "-----BEGIN $label-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END $label-----\n";
}

function ec_raw_point_to_pem($rawPoint65) {
  if (strlen($rawPoint65) !== 65 || ord($rawPoint65[0]) !== 0x04) {
    throw new Exception('expected a 65-byte uncompressed EC point (0x04 || X || Y)');
  }
  return pem_wrap(ATLAS_P256_SPKI_PREFIX . $rawPoint65, 'PUBLIC KEY');
}

// WebAuthn's getPublicKey() already returns a full SPKI DER blob — no prefix needed, just PEM-wrap it.
function spki_der_to_pem($spkiDer) {
  return pem_wrap($spkiDer, 'PUBLIC KEY');
}

// ---------- sign / verify wrappers, raw-format in and out to match Web Crypto ----------

function ecdsa_sign_raw($privKeyResource, $data) {
  $ok = openssl_sign($data, $derSig, $privKeyResource, OPENSSL_ALGO_SHA256);
  if (!$ok) throw new Exception('openssl_sign failed: ' . openssl_error_string());
  return der_to_raw_ecdsa_sig($derSig);
}

function ecdsa_verify_raw($pubKeyPem, $rawSig64, $data) {
  try {
    $der = raw_to_der_ecdsa_sig($rawSig64);
  } catch (Exception $e) {
    return false;
  }
  $result = openssl_verify($data, $der, $pubKeyPem, OPENSSL_ALGO_SHA256);
  return $result === 1;
}

function ecdsa_verify_der($pubKeyPem, $derSig, $data) {
  $result = openssl_verify($data, $derSig, $pubKeyPem, OPENSSL_ALGO_SHA256);
  return $result === 1;
}
