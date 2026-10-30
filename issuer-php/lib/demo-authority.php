<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
// Authorization for the self-serve /atlas/demo/* routes. Two separate kinds:
//
// Owner consent: the credential's current owner signs a request about their
// own credential (redeem a cafeteria item, revoke their own login badge).
//
// Demo authority: a key a demo page generates to play the issuer, retailer or
// bank. It is written into the credential, as the issuer-signed property
// 'atlas.demo.authority', only by a demo mint route and only for a demo-only
// class (atlas_demo_authority_classes()). Demo suspend, unsuspend, clawback and
// the warranty sale stamp need its signature; the owner's signature never
// stands in for it. No production route reads the property, so a demo
// authority cannot authorize anything outside these demo routes.
//
// Both sign { purpose: 'atlas.demo.request/1', action, credentialId, domain,
// issuedAt, ...fields } as an ordinary signed envelope; issuedAt must be within
// ATLAS_DEMO_REQUEST_WINDOW_SECONDS. A wallet-bridge signature is refused
// (verify_envelope()).

const ATLAS_DEMO_REQUEST_PURPOSE = 'atlas.demo.request/1';
const ATLAS_DEMO_AUTHORITY_PROPERTY = 'atlas.demo.authority';
const ATLAS_DEMO_REQUEST_WINDOW_SECONDS = 300;
// The only reason a demo route suspends with, and the only one it lifts.
const ATLAS_DEMO_SUSPENSION_REASON = 'demo-fraud-report';

// Demo-only classes a demo authority may be written into.
function atlas_demo_authority_classes() {
  return ['atlas.demo.clawback.token', 'atlas.demo.clawback.funds', 'atlas.demo.warranty.selfserve'];
}

// A raw P-256 public key (65-byte point), base64url.
function atlas_demo_valid_key($key) {
  if (!is_string($key) || !preg_match('/^[A-Za-z0-9_-]{87}$/D', $key)) return false;
  $raw = base64_decode(strtr($key, '-_', '+/') . '=', true);
  return $raw !== false && strlen($raw) === 65 && ord($raw[0]) === 4;
}

// The demo authority key a credential carries, or null.
function atlas_demo_authority_of($credential) {
  $key = $credential['asset']['properties'][ATLAS_DEMO_AUTHORITY_PROPERTY] ?? null;
  return atlas_demo_valid_key($key) ? $key : null;
}

// Ends the request with 403 unless $body carries intent {payload, proof} for
// exactly this action on this credential, signed by $signerKey within the
// window. $fields are the extra payload fields the request must name.
function atlas_require_demo_request($body, $credential, $action, $signerKey, $fields = []) {
  $refuse = function ($why) { send_json(403, ['error' => $why, 'code' => 'demo-authorization-required']); };
  if (!is_string($signerKey) || $signerKey === '') $refuse('this credential has no key that may authorize ' . $action);
  $intent = $body['intent'] ?? null;
  $payload = is_array($intent) ? ($intent['payload'] ?? null) : null;
  $proof = is_array($intent) ? ($intent['proof'] ?? null) : null;
  if (!is_array($payload) || !is_array($proof)) $refuse('a signed request (intent.payload, intent.proof) is required');
  $expected = array_merge(['purpose' => ATLAS_DEMO_REQUEST_PURPOSE, 'action' => $action, 'credentialId' => $credential['id'] ?? null,
    'domain' => atlas_domain(), 'issuedAt' => $payload['issuedAt'] ?? null], $fields);
  $keys = array_keys($payload); sort($keys, SORT_STRING);
  $want = array_keys($expected); sort($want, SORT_STRING);
  if ($keys !== $want) $refuse('the signed request does not have the fields this action needs');
  foreach ($expected as $k => $v) if (canonicalize($payload[$k]) !== canonicalize($v)) $refuse('the signed request is for a different ' . $k);
  $issuedAt = is_string($payload['issuedAt']) ? strtotime($payload['issuedAt']) : false;
  if ($issuedAt === false || abs(time() - $issuedAt) > ATLAS_DEMO_REQUEST_WINDOW_SECONDS) $refuse('the signed request is too old or not yet valid');
  if (($proof['publicKey'] ?? null) !== $signerKey || !verify_envelope($payload, $proof)) $refuse('the request is not signed by the key that may authorize ' . $action);
}

// The suspension a demo route may act on: none, or one it made itself.
// Returns 'none', 'demo' or 'other'.
function atlas_demo_suspension_state($id) {
  $s = find_suspension($id);
  if ($s === null) return 'none';
  return ($s['reason'] ?? null) === ATLAS_DEMO_SUSPENSION_REASON ? 'demo' : 'other';
}
