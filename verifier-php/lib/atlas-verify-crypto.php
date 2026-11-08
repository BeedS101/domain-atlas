<?php
// Domain Atlas verifier: verification-only crypto primitives.
//
// Base64url, the ECDSA P-256 raw/DER signature conversion, the SPKI public key wrapper and the
// signature check below are copied unchanged from the reference issuer's crypto.php (they sit in this
// package's namespace so they cannot collide with an issuer on the same host). Nothing here can sign:
// there is no private key handling, no key generation and no signing call.
namespace DomainAtlas\Verify;

use Exception;

if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only

// DER prefix of a P-256 SubjectPublicKeyInfo; the 65-byte uncompressed point follows it.
const ATLAS_P256_SPKI_PREFIX = "\x30\x59\x30\x13\x06\x07\x2a\x86\x48\xce\x3d\x02\x01\x06\x08\x2a\x86\x48\xce\x3d\x03\x01\x07\x03\x42\x00";

function b64url_decode($str) {
  $str = strtr($str, '-_', '+/');
  $pad = strlen($str) % 4;
  if ($pad) $str .= str_repeat('=', 4 - $pad);
  $out = base64_decode($str, true);
  if ($out === false) throw new Exception('malformed base64url');
  return $out;
}

function raw_to_der_ecdsa_sig($raw64) {
  if (strlen($raw64) !== 64) throw new Exception('raw ECDSA signature must be 64 bytes');
  $r = substr($raw64, 0, 32);
  $s = substr($raw64, 32, 32);
  $body = der_int_encode($r) . der_int_encode($s);
  return "\x30" . chr(strlen($body)) . $body;
}

function der_int_encode($bytes32) {
  $i = 0;
  while ($i < 31 && ord($bytes32[$i]) === 0) $i++;
  $trimmed = substr($bytes32, $i);
  if (ord($trimmed[0]) & 0x80) $trimmed = "\x00" . $trimmed;
  return "\x02" . chr(strlen($trimmed)) . $trimmed;
}

function pem_wrap($der, $label) {
  return "-----BEGIN $label-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END $label-----\n";
}

function ec_raw_point_to_pem($rawPoint65) {
  if (strlen($rawPoint65) !== 65 || ord($rawPoint65[0]) !== 0x04) {
    throw new Exception('expected a 65-byte uncompressed EC point (0x04 || X || Y)');
  }
  return pem_wrap(ATLAS_P256_SPKI_PREFIX . $rawPoint65, 'PUBLIC KEY');
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

// Canonical JSON, the same form the reference issuer signs: object keys sorted at every level, no
// insignificant whitespace, strings escaped as JSON.stringify does. Takes a value decoded with
// json_decode($text, false) so that an empty object stays an object (an assoc decode would turn {} into
// [] and change the bytes), and sorts keys in UTF-16 code unit order, the order JavaScript's default
// sort gives. Scalars, lists and float text follow the issuer's canonicalize() line for line.
function utf16_units($s) {
  $units = [];
  $len = strlen($s);
  for ($i = 0; $i < $len;) {
    $b = ord($s[$i]);
    if ($b < 0x80) { $cp = $b; $i += 1; }
    elseif ($b < 0xE0) { $cp = (($b & 0x1F) << 6) | (ord($s[$i + 1]) & 0x3F); $i += 2; }
    elseif ($b < 0xF0) { $cp = (($b & 0x0F) << 12) | ((ord($s[$i + 1]) & 0x3F) << 6) | (ord($s[$i + 2]) & 0x3F); $i += 3; }
    else { $cp = (($b & 0x07) << 18) | ((ord($s[$i + 1]) & 0x3F) << 12) | ((ord($s[$i + 2]) & 0x3F) << 6) | (ord($s[$i + 3]) & 0x3F); $i += 4; }
    if ($cp >= 0x10000) {
      $cp -= 0x10000;
      $units[] = 0xD800 + ($cp >> 10);
      $units[] = 0xDC00 + ($cp & 0x3FF);
    } else {
      $units[] = $cp;
    }
  }
  return $units;
}

function compare_keys($a, $b) {
  if ($a === $b) return 0;
  $ua = utf16_units($a);
  $ub = utf16_units($b);
  $n = min(count($ua), count($ub));
  for ($i = 0; $i < $n; $i++) {
    if ($ua[$i] !== $ub[$i]) return $ua[$i] < $ub[$i] ? -1 : 1;
  }
  return count($ua) <=> count($ub);
}

// Text of a float exactly as ECMAScript Number::toString (and so JSON.stringify) writes it. The shortest round-trip digits
// come from json_encode (serialize_precision -1); only the placement of the decimal point and exponent is redone.
function js_number($v) {
  if ($v === 0.0) return '0';
  if (is_nan($v) || is_infinite($v)) throw new Exception('canonicalize: non-finite number');
  if (!preg_match('/^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/', json_encode(abs($v)), $m)) throw new Exception('canonicalize: unreadable number');
  $int = $m[1];
  $digits = $int . (isset($m[2]) ? $m[2] : '');
  $point = strlen($int) + (isset($m[3]) ? (int) $m[3] : 0);
  $trimmed = ltrim($digits, '0');
  $point -= strlen($digits) - strlen($trimmed);
  $digits = rtrim($trimmed, '0');
  $k = strlen($digits);
  if ($k <= $point && $point <= 21) $out = $digits . str_repeat('0', $point - $k);
  elseif (0 < $point && $point <= 21) $out = substr($digits, 0, $point) . '.' . substr($digits, $point);
  elseif (-6 < $point && $point <= 0) $out = '0.' . str_repeat('0', -$point) . $digits;
  else $out = substr($digits, 0, 1) . ($k > 1 ? '.' . substr($digits, 1) : '') . 'e' . ($point - 1 < 0 ? '-' : '+') . abs($point - 1);
  return ($v < 0 ? '-' : '') . $out;
}

function canonicalize($value) {
  if ($value === null) return 'null';
  if (is_bool($value)) return $value ? 'true' : 'false';
  if (is_int($value)) return ($value > 9007199254740992 || $value < -9007199254740992) ? js_number((float) $value) : (string) $value;
  if (is_float($value)) return js_number($value);
  if (is_string($value)) return atlas_json_string($value);
  if (is_array($value)) {
    $parts = [];
    foreach ($value as $item) $parts[] = canonicalize($item);
    return '[' . implode(',', $parts) . ']';
  }
  if ($value instanceof \stdClass) {
    $props = [];
    foreach (get_object_vars($value) as $k => $v) $props[(string) $k] = $v;
    $keys = array_map('strval', array_keys($props));
    usort($keys, __NAMESPACE__ . '\compare_keys');
    $parts = [];
    foreach ($keys as $k) $parts[] = atlas_json_string($k) . ':' . canonicalize($props[$k]);
    return '{' . implode(',', $parts) . '}';
  }
  throw new Exception('canonicalize: unsupported value type');
}
