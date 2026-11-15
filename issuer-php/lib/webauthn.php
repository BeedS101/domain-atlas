<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
// Passkey (WebAuthn) assertions as owner and identity proofs. Mirrors issuer-server/lib-webauthn.js rule for rule.
//
// An envelope { signerRole: 'webauthn', publicKey, clientDataJSON, authenticatorData, signature } is accepted only when
//   - every field is canonical base64url within a size limit, and the client data is a JSON object;
//   - it is an authentication ("webauthn.get") assertion, not a registration, whose challenge is the SHA-256 of the
//     canonical payload, and it was not made by a cross-origin frame;
//   - the authenticator data is well formed (37 bytes, plus extension data only when flagged), the user was present, and
//     it carries no attested credential data, which an assertion never has;
//   - the origin is one this issuer expects, and the relying-party hash is the SHA-256 of an id that origin may use;
//   - the ECDSA P-256 signature over authenticatorData || SHA-256(clientDataJSON) verifies under the named key.
//
// The origin and relying-party id are reported by the client, so they are never trusted for what they claim: an origin
// must be on the list this issuer expects, and the authenticator-signed rpIdHash must agree with it.
//
// Expected origins: by default this domain's own origins and any browser-extension origin (the wallet is an extension,
// and its id differs between installs). This domain is the configured ATLAS_DOMAIN, never the request's Host header,
// which the client chooses; without it only extension origins are expected by default. ATLAS_WEBAUTHN_ORIGINS (comma-separated origins) replaces that default with an
// exact list. ATLAS_WEBAUTHN_RP_IDS additionally pins the relying-party ids. ATLAS_WEBAUTHN_REQUIRE_UV=1 refuses an
// assertion whose authenticator did not verify the user (the wallet asks for "preferred", so this is off by default).
// The signature counter is not checked: synced passkeys report 0. Replay protection is the payload's own nonce.

const ATLAS_WEBAUTHN_MAX_CLIENT_DATA = 8192;
const ATLAS_WEBAUTHN_MAX_AUTH_DATA = 4096;
const ATLAS_WEBAUTHN_MAX_SIGNATURE = 128;
const ATLAS_WEBAUTHN_MAX_KEY = 256;

// ['scheme' => , 'host' => ] for a serialized origin this code can reason about, else null.
function atlas_webauthn_parse_origin($origin) {
  if (!is_string($origin) || strlen($origin) > 300) return null;
  $label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  $shapes = [
    ['https', '#^https://(' . $label . '(?:\.' . $label . ')+)(?::[0-9]{1,5})?$#D'],
    ['http', '#^http://(localhost)(?::[0-9]{1,5})?$#D'],
    ['chrome-extension', '#^chrome-extension://([a-p]{32})$#D'],
    ['moz-extension', '#^moz-extension://([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$#D'],
    ['safari-web-extension', '#^safari-web-extension://([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$#D'],
  ];
  foreach ($shapes as [$scheme, $re]) {
    if (preg_match($re, $origin, $m)) {
      if ($scheme === 'https' && preg_match('/^[0-9.]+$/D', $m[1])) return null; // an address is not a relying-party id
      return ['scheme' => $scheme, 'host' => $m[1]];
    }
  }
  return null;
}

function atlas_webauthn_is_extension_scheme($scheme) {
  return $scheme !== 'https' && $scheme !== 'http';
}

// The relying-party ids a page or extension at this origin may use: its host and each parent domain that still has two
// labels (a bare public suffix is never one); an extension or localhost has only itself.
function atlas_webauthn_allowed_rp_ids($parsed) {
  if (atlas_webauthn_is_extension_scheme($parsed['scheme']) || strpos($parsed['host'], '.') === false) return [$parsed['host']];
  $labels = explode('.', $parsed['host']);
  $out = [];
  for ($i = 0; $i <= count($labels) - 2; $i++) $out[] = implode('.', array_slice($labels, $i));
  return $out;
}

function atlas_webauthn_list($value) {
  return array_values(array_filter(array_map('trim', explode(',', $value)), function ($s) { return $s !== ''; }));
}

// The origins a page of the configured domain is served from (none when ATLAS_DOMAIN is not set).
function atlas_webauthn_own_origins() {
  $domain = getenv('ATLAS_DOMAIN');
  if (!is_string($domain) || trim($domain) === '') return [];
  $domain = strtolower(trim($domain));
  $host = preg_replace('/:\d+$/', '', $domain);
  return in_array($host, ['localhost', '127.0.0.1', '[::1]'], true) ? ['https://' . $domain, 'http://' . $domain] : ['https://' . $domain];
}

// The operator configuration. A pin that is set but lists nothing usable matches nothing, so a typo cannot silently
// widen the policy.
function atlas_webauthn_policy() {
  $origins = getenv('ATLAS_WEBAUTHN_ORIGINS');
  $rpIds = getenv('ATLAS_WEBAUTHN_RP_IDS');
  $uv = getenv('ATLAS_WEBAUTHN_REQUIRE_UV');
  return [
    'ownOrigins' => atlas_webauthn_own_origins(),
    'origins' => is_string($origins) && trim($origins) !== '' ? atlas_webauthn_list($origins) : null,
    'rpIds' => is_string($rpIds) && trim($rpIds) !== '' ? atlas_webauthn_list($rpIds) : null,
    'requireUv' => $uv === '1' || $uv === 'true',
  ];
}

// Strict base64url (no padding, canonical) within a size limit, else null.
function atlas_webauthn_decode($value, $maxBytes) {
  if (!is_string($value) || $value === '' || strlen($value) > (int) ceil($maxBytes * 4 / 3) + 4) return null;
  if (!preg_match('/^[A-Za-z0-9_-]+$/D', $value) || strlen($value) % 4 === 1) return null;
  try { $raw = b64url_decode($value); } catch (Exception $e) { return null; }
  if (strlen($raw) > $maxBytes || b64url_encode($raw) !== $value) return null;
  return $raw;
}

// A short reason the assertion is not acceptable, or null. Checks structure and context, not the signature.
function atlas_webauthn_problem($envelope, $expectedChallenge, $policy, &$parts = null) {
  if (!is_array($envelope) || !is_array($policy) || ($envelope['signerRole'] ?? null) !== 'webauthn') return 'not an assertion';
  $clientRaw = atlas_webauthn_decode($envelope['clientDataJSON'] ?? null, ATLAS_WEBAUTHN_MAX_CLIENT_DATA);
  $auth = atlas_webauthn_decode($envelope['authenticatorData'] ?? null, ATLAS_WEBAUTHN_MAX_AUTH_DATA);
  if ($clientRaw === null || $auth === null) return 'malformed encoding';
  $clientData = json_decode($clientRaw, true);
  if (!is_array($clientData) || ($clientData !== [] && array_keys($clientData) === range(0, count($clientData) - 1))) return 'client data is not an object';
  if (($clientData['type'] ?? null) !== 'webauthn.get') return 'not an authentication assertion';
  if (!is_string($clientData['challenge'] ?? null) || $clientData['challenge'] !== $expectedChallenge) return 'challenge does not match the payload';
  if (array_key_exists('crossOrigin', $clientData) && $clientData['crossOrigin'] !== false) return 'cross-origin assertion';

  if (strlen($auth) < 37) return 'authenticator data too short';
  $flags = ord($auth[32]);
  if (($flags & 0x01) === 0) return 'user not present';
  if (($flags & 0x40) !== 0) return 'attested credential data in an assertion';
  if ((($flags & 0x80) !== 0) !== (strlen($auth) > 37)) return 'extension data does not match its flag';
  if (!empty($policy['requireUv']) && ($flags & 0x04) === 0) return 'user verification required';

  $origin = $clientData['origin'] ?? null;
  $parsed = atlas_webauthn_parse_origin($origin);
  if ($parsed === null) return 'unexpected origin';
  if (is_array($policy['origins'])) $originOk = in_array($origin, $policy['origins'], true);
  else $originOk = in_array($origin, $policy['ownOrigins'], true) || atlas_webauthn_is_extension_scheme($parsed['scheme']);
  if (!$originOk) return 'origin not expected here';
  $rpHash = substr($auth, 0, 32);
  $matches = false;
  foreach (atlas_webauthn_allowed_rp_ids($parsed) as $id) if (hash_equals(hash('sha256', $id, true), $rpHash)) $matches = true;
  if (!$matches) return 'relying party does not match the origin';
  if (is_array($policy['rpIds'])) {
    $pinned = false;
    foreach ($policy['rpIds'] as $id) if (hash_equals(hash('sha256', $id, true), $rpHash)) $pinned = true;
    if (!$pinned) return 'relying party not expected here';
  }
  $parts = ['clientRaw' => $clientRaw, 'auth' => $auth];
  return null;
}

// $canonicalPayload: the canonical JSON text of the payload the assertion is meant to sign.
function atlas_webauthn_verify($canonicalPayload, $envelope, $policy) {
  try {
    $parts = null;
    $challenge = b64url_encode(sha256_raw($canonicalPayload));
    if (atlas_webauthn_problem($envelope, $challenge, $policy, $parts) !== null) return false;
    $signature = atlas_webauthn_decode($envelope['signature'] ?? null, ATLAS_WEBAUTHN_MAX_SIGNATURE);
    $spki = atlas_webauthn_decode($envelope['publicKey'] ?? null, ATLAS_WEBAUTHN_MAX_KEY);
    if ($signature === null || $spki === null) return false;
    $pem = spki_der_to_pem($spki);
    $key = openssl_pkey_get_public($pem);
    if ($key === false) return false;
    $details = openssl_pkey_get_details($key);
    if (!is_array($details) || ($details['type'] ?? null) !== OPENSSL_KEYTYPE_EC || ($details['ec']['curve_name'] ?? null) !== 'prime256v1') return false;
    // The signature is DER already, which is what openssl_verify takes.
    return ecdsa_verify_der($pem, $signature, $parts['auth'] . sha256_raw($parts['clientRaw']));
  } catch (Throwable $e) {
    return false;
  }
}
