<?php
// Key-anchored manifest verification (SPEC.md §3.6): canonicalize the manifest with `signature`
// removed (the same canonical form extension/wallet.js and issuer-php use) and check it against the
// manifest's own identityKey. ECDSA P-256 / SHA-256, raw (r||s) signature, raw 65-byte public key.

function dir_b64url_decode($str) {
  if (!is_string($str) || $str === '' || !preg_match('/^[A-Za-z0-9_-]+$/', $str)) return false;
  $str = strtr($str, '-_', '+/');
  $pad = strlen($str) % 4;
  if ($pad === 1) return false;
  if ($pad) $str .= str_repeat('=', 4 - $pad);
  return base64_decode($str, true);
}

function dir_json_string($s) {
  $out = '"';
  $len = strlen($s);
  for ($i = 0; $i < $len; $i++) {
    $c = $s[$i];
    $ord = ord($c);
    if ($c === '"') $out .= '\\"';
    elseif ($c === '\\') $out .= '\\\\';
    elseif ($ord === 0x08) $out .= '\\b';
    elseif ($ord === 0x0C) $out .= '\\f';
    elseif ($ord === 0x0A) $out .= '\\n';
    elseif ($ord === 0x0D) $out .= '\\r';
    elseif ($ord === 0x09) $out .= '\\t';
    elseif ($ord < 0x20) $out .= sprintf('\\u%04x', $ord);
    else $out .= $c; // '/' and non-ASCII are not escaped, matching JSON.stringify
  }
  return $out . '"';
}

// Works on json_decode(..., false) output so {} and [] stay distinct.
function dir_canonicalize($value) {
  if ($value === null) return 'null';
  if (is_bool($value)) return $value ? 'true' : 'false';
  if (is_int($value)) return (string) $value;
  if (is_float($value)) {
    if ($value === 0.0) return '0';
    return preg_replace('/\.0e/', 'e', json_encode($value));
  }
  if (is_string($value)) return dir_json_string($value);
  if (is_array($value)) return '[' . implode(',', array_map('dir_canonicalize', $value)) . ']';
  if (is_object($value)) {
    $props = get_object_vars($value);
    $keys = array_map('strval', array_keys($props));
    sort($keys, SORT_STRING);
    $parts = [];
    foreach ($keys as $k) $parts[] = dir_json_string($k) . ':' . dir_canonicalize($props[$k]);
    return '{' . implode(',', $parts) . '}';
  }
  throw new DirectoryException('unsupported value in manifest');
}

function dir_raw_sig_to_der($raw) {
  $int = function ($b) {
    $b = ltrim($b, "\x00");
    if ($b === '') $b = "\x00";
    if (ord($b[0]) & 0x80) $b = "\x00" . $b;
    return "\x02" . chr(strlen($b)) . $b;
  };
  $body = $int(substr($raw, 0, 32)) . $int(substr($raw, 32, 32));
  return "\x30" . chr(strlen($body)) . $body;
}

// $manifestObject is the manifest decoded with json_decode($text, false).
function dir_verify_key_anchored($manifestObject) {
  if (!is_object($manifestObject) || !isset($manifestObject->signature, $manifestObject->identityKey)) return false;
  if (!is_string($manifestObject->signature) || $manifestObject->signature === '' || !is_string($manifestObject->identityKey)) return false;
  $point = dir_b64url_decode($manifestObject->identityKey);
  $signature = dir_b64url_decode($manifestObject->signature);
  if ($point === false || $signature === false || strlen($point) !== 65 || ord($point[0]) !== 4 || strlen($signature) !== 64) return false;
  if (!function_exists('openssl_verify')) throw new DirectoryException('this host has no openssl extension, so key-anchored manifests cannot be verified');
  $unsigned = clone $manifestObject;
  unset($unsigned->signature);
  $der = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200') . $point;
  $pem = "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
  $key = @openssl_pkey_get_public($pem);
  if (!$key) return false;
  return openssl_verify(dir_canonicalize($unsigned), dir_raw_sig_to_der($signature), $key, OPENSSL_ALGO_SHA256) === 1;
}
