<?php
namespace DomainAtlas\Verify;

use Throwable;

if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only

// Domain Atlas credential verifier. Stateless and verification-only: it holds no private key, writes nothing and
// keeps no cache. Given an asset credential and an explicitly configured issuer origin it answers one question:
// is this credential, as issued, valid right now?
//
// Checks (SPEC.md section 5):
//   1. the credential names the configured issuer (never the other way round: the host to ask is configuration,
//      not something the credential can choose);
//   2. the issuer publishes the key named by the credential, and that key was valid at issuedAt (section 5.3);
//   3. the ECDSA P-256 signature over the canonical payload;
//   4. the issuer's revocation list is readable and does not list the id;
//   5. the issuer's suspension list is readable and does not hold the id (an expired "finalize" suspension counts
//      as revoked, section 13.4);
//   6. the signed asset.expiresAt has not passed (section 5.10).
// It does not check that the presenter owns the credential (section 5 step 3, a live signature by owner.publicKey).
//
// Anything that cannot be established is not a pass: a status document that cannot be read gives status
// "unavailable" and valid=false.

require_once __DIR__ . '/atlas-verify-crypto.php';
require_once __DIR__ . '/atlas-verify-fetch.php';

const VERSION = '0.1.0';
const CREDENTIAL_TYPE = 'domain-atlas-asset/1.0';
const MAX_CREDENTIAL_BYTES = 262144;
const MAX_KEY_DOCUMENT_BYTES = 262144;
const MAX_STATUS_DOCUMENT_BYTES = 4194304;
const MAX_STATUS_ENTRIES = 20000;
const MAX_KEY_ENTRIES = 1000;
const MAX_SAFE_INTEGER = 9007199254740991;

// ---------- configuration ----------

// An origin is scheme://host[:port] and nothing else. Returns null when it is anything more or less.
function parse_origin($origin) {
  if (!is_string($origin)) return null;
  $origin = rtrim(trim($origin), '/');
  if (!preg_match('~^(https?)://([a-z0-9]([a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])(:([0-9]{1,5}))?$~i', $origin, $m)) return null;
  $scheme = strtolower($m[1]);
  $host = strtolower($m[2]);
  $port = isset($m[5]) && $m[5] !== '' ? (int) $m[5] : null;
  if ($port !== null && ($port < 1 || $port > 65535)) return null;
  if ($port === ($scheme === 'https' ? 443 : 80)) $port = null;
  $domain = $port === null ? $host : $host . ':' . $port;
  return [
    'origin' => $scheme . '://' . $domain,
    'scheme' => $scheme,
    'host' => $host,
    'domain' => $domain,
    'loopback' => in_array($host, ['localhost', '127.0.0.1', '[::1]'], true),
  ];
}

// Turns a trustedIssuers setting into a map of issuer domain => trust entry. Accepts a list of origins, or a map of
// origin => options (pinnedKeys, suspensions). Returns ['issuers' => [...], 'errors' => [...]]; any error means the
// configuration must not be used.
function load_trust_config($config) {
  $errors = [];
  $issuers = [];
  $allowLoopback = is_array($config) && !empty($config['allowInsecureLoopback']);
  $listed = is_array($config) && isset($config['trustedIssuers']) && is_array($config['trustedIssuers']) ? $config['trustedIssuers'] : null;
  if ($listed === null || count($listed) === 0) {
    return ['issuers' => [], 'errors' => ['trustedIssuers must list at least one issuer origin']];
  }
  foreach ($listed as $key => $value) {
    $origin = is_string($key) ? $key : $value;
    $options = is_string($key) && is_array($value) ? $value : [];
    $info = parse_origin($origin);
    if ($info === null) { $errors[] = 'not an origin (use https://host): ' . (is_string($origin) ? $origin : gettype($origin)); continue; }
    if ($info['scheme'] !== 'https' && !($info['loopback'] && $allowLoopback)) {
      $errors[] = 'plain http is only allowed for localhost with allowInsecureLoopback: ' . $info['origin'];
      continue;
    }
    $pins = [];
    if (isset($options['pinnedKeys'])) {
      if (!is_array($options['pinnedKeys'])) { $errors[] = 'pinnedKeys must be a list for ' . $info['origin']; continue; }
      foreach ($options['pinnedKeys'] as $pin) {
        if (decode_point($pin) === null) { $errors[] = 'pinnedKeys holds something that is not a P-256 public key for ' . $info['origin']; continue 2; }
        $pins[] = $pin;
      }
    }
    $suspensions = isset($options['suspensions']) ? $options['suspensions'] : 'required';
    if (!in_array($suspensions, ['required', 'optional'], true)) { $errors[] = 'suspensions must be "required" or "optional" for ' . $info['origin']; continue; }
    if (isset($issuers[$info['domain']])) { $errors[] = 'issuer listed twice: ' . $info['origin']; continue; }
    $issuers[$info['domain']] = $info + ['pinnedKeys' => $pins, 'suspensions' => $suspensions];
  }
  return ['issuers' => $issuers, 'errors' => $errors];
}

// ---------- small parsers ----------

// 65-byte uncompressed P-256 point from base64url, or null.
function decode_point($value) {
  $raw = decode_strict($value, 65);
  return ($raw !== null && $raw[0] === "\x04") ? $raw : null;
}

// Canonical, unpadded base64url of exactly $length bytes, or null.
function decode_strict($value, $length) {
  if (!is_string($value) || $value === '' || strlen($value) > 200 || !preg_match('/^[A-Za-z0-9_-]+$/', $value)) return null;
  try {
    $raw = b64url_decode($value);
  } catch (\Exception $e) {
    return null;
  }
  if (strlen($raw) !== $length || rtrim(strtr(base64_encode($raw), '+/', '-_'), '=') !== $value) return null;
  return $raw;
}

// RFC 3339 timestamp to seconds since the epoch (with fraction), or null when it is not one.
function parse_time($value) {
  if (!is_string($value)) return null;
  if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/', $value, $m)) return null;
  list(, $y, $mo, $d, $h, $mi, $s) = $m;
  if (!checkdate((int) $mo, (int) $d, (int) $y) || (int) $h > 23 || (int) $mi > 59 || (int) $s > 59) return null;
  $seconds = gmmktime((int) $h, (int) $mi, (int) $s, (int) $mo, (int) $d, (int) $y);
  $zone = $m[8];
  if ($zone !== 'Z') {
    $offsetHours = (int) substr($zone, 1, 2);
    $offsetMinutes = (int) substr($zone, 4, 2);
    if ($offsetHours > 23 || $offsetMinutes > 59) return null;
    $offset = $offsetHours * 3600 + $offsetMinutes * 60;
    $seconds += $zone[0] === '-' ? $offset : -$offset;
  }
  $fraction = isset($m[7]) && $m[7] !== '' ? (float) ('0.' . $m[7]) : 0.0;
  return $seconds + $fraction;
}

function prop($object, $name) {
  return is_object($object) && property_exists($object, $name) ? $object->$name : null;
}

function has_prop($object, $name) {
  return is_object($object) && property_exists($object, $name);
}

function iso_time($seconds) {
  return gmdate('Y-m-d\TH:i:s', (int) floor($seconds)) . 'Z';
}

// ---------- verdicts ----------

function verdict($status, $code, $reason, $context, $checks) {
  return [
    'valid' => $status === 'verified',
    'status' => $status,
    'code' => $code,
    'reason' => $reason,
    'credentialId' => isset($context['id']) ? $context['id'] : null,
    'issuer' => isset($context['issuer']) ? $context['issuer'] : null,
    'checks' => $checks,
    'checkedAt' => iso_time($context['now']),
    'verifier' => ['name' => 'atlas-verify', 'version' => VERSION],
  ];
}

function blank_checks() {
  return ['issuerTrusted' => 'skipped', 'keyPublished' => 'skipped', 'keyValidAtIssuance' => 'skipped', 'signature' => 'skipped',
          'revocation' => 'skipped', 'suspension' => 'skipped', 'expiry' => 'skipped'];
}

// ---------- published documents ----------

// Reads one document under the issuer origin's /.well-known/. Returns ['doc' => object] or
// ['doc' => null, 'notFound' => bool, 'why' => text].
function read_document($trust, $name, $maxBytes, $fetch) {
  $url = $trust['origin'] . '/.well-known/' . $name;
  try {
    $res = call_user_func($fetch, $url, $maxBytes, $trust['scheme'] === 'http');
  } catch (Throwable $e) {
    return ['doc' => null, 'notFound' => false, 'why' => 'could not be reached'];
  }
  if (!is_array($res) || !isset($res['status'])) return ['doc' => null, 'notFound' => false, 'why' => 'could not be reached'];
  if (!empty($res['tooLarge'])) return ['doc' => null, 'notFound' => false, 'why' => 'is larger than the verifier reads'];
  if ((int) $res['status'] === 404) return ['doc' => null, 'notFound' => true, 'why' => 'is not published (HTTP 404)'];
  if ((int) $res['status'] !== 200 || !isset($res['body']) || !is_string($res['body'])) {
    return ['doc' => null, 'notFound' => false, 'why' => (int) $res['status'] > 0 ? 'could not be read (HTTP ' . (int) $res['status'] . ')' : 'could not be reached'];
  }
  $doc = json_decode($res['body'], false, 32);
  if (!($doc instanceof \stdClass)) return ['doc' => null, 'notFound' => false, 'why' => 'is not a JSON object'];
  return ['doc' => $doc];
}

// The ids on a revocation list, or null when the list is not readable as one.
function revocation_ids($doc) {
  $list = prop($doc, 'revoked');
  if (!is_array($list) || count($list) > MAX_STATUS_ENTRIES) return null;
  $ids = [];
  foreach ($list as $entry) {
    $id = prop($entry, 'id');
    if (!($entry instanceof \stdClass) || !is_string($id) || $id === '') return null;
    $ids[$id] = is_string(prop($entry, 'reason')) ? prop($entry, 'reason') : null;
  }
  return $ids;
}

// Suspension entries for one id, or null when the list is not readable as one. Each returned entry is
// ['expiresAt' => float|null, 'onExpire' => 'lift'|'finalize'].
function suspension_entries_for($doc, $id) {
  $list = prop($doc, 'suspended');
  if (!is_array($list) || count($list) > MAX_STATUS_ENTRIES) return null;
  $found = [];
  foreach ($list as $entry) {
    $entryId = prop($entry, 'id');
    if (!($entry instanceof \stdClass) || !is_string($entryId) || $entryId === '') return null;
    $expires = null;
    if (has_prop($entry, 'expiresAt') && $entry->expiresAt !== null) {
      $expires = parse_time($entry->expiresAt);
      if ($expires === null) return null;
    }
    $onExpire = has_prop($entry, 'onExpire') ? $entry->onExpire : 'lift';
    if ($onExpire !== 'lift' && $onExpire !== 'finalize') return null;
    if ($entryId === $id) $found[] = ['expiresAt' => $expires, 'onExpire' => $onExpire];
  }
  return $found;
}

// ---------- verification ----------

// Verifies a credential given as JSON text (the supported entry point: it keeps empty objects intact). $trust is one
// entry of load_trust_config()['issuers'], or null when the credential's issuer is not configured.
function verify_credential_json($json, $trust, $options = []) {
  $now = isset($options['now']) ? (float) $options['now'] : microtime(true);
  $context = ['now' => $now];
  if (!is_string($json) || strlen($json) > MAX_CREDENTIAL_BYTES) {
    return verdict('invalid', 'malformed-credential', 'the credential is missing or too large', $context, blank_checks());
  }
  $credential = json_decode($json, false, 64);
  if (!($credential instanceof \stdClass)) {
    return verdict('invalid', 'malformed-credential', 'the credential is not a JSON object', $context, blank_checks());
  }
  return verify_decoded_credential($credential, $trust, $options);
}

// As above for a credential already decoded with json_decode($text, false).
function verify_decoded_credential($credential, $trust, $options = []) {
  $now = isset($options['now']) ? (float) $options['now'] : microtime(true);
  $context = ['now' => $now];
  $checks = blank_checks();
  $previousPrecision = ini_get('serialize_precision');
  ini_set('serialize_precision', '-1');
  try {
    return verify_inner($credential, $trust, $options, $context, $checks);
  } catch (Throwable $e) {
    return verdict('unavailable', 'internal-error', 'the verifier could not complete the check', $context, $checks);
  } finally {
    ini_set('serialize_precision', (string) $previousPrecision);
  }
}

function verify_inner($credential, $trust, $options, $context, $checks) {
  $fetch = isset($options['fetch']) && is_callable($options['fetch']) ? $options['fetch'] : __NAMESPACE__ . '\fetch_document';

  $type = prop($credential, 'credential');
  if ($type !== CREDENTIAL_TYPE) {
    if (is_string($type)) return verdict('unsupported', 'unsupported-credential-type', 'this verifier checks ' . CREDENTIAL_TYPE . ' credentials only', $context, $checks);
    return verdict('invalid', 'malformed-credential', 'the credential type is missing', $context, $checks);
  }
  $id = prop($credential, 'id');
  $asset = prop($credential, 'asset');
  $owner = prop($credential, 'owner');
  $quantity = prop($credential, 'quantity');
  $issuedAtText = prop($credential, 'issuedAt');
  $issuer = prop($credential, 'issuer');
  $issuerDomain = prop($issuer, 'domain');
  $issuerKey = prop($issuer, 'publicKey');
  $signature = prop($credential, 'signature');
  if (is_string($id) && $id !== '' && strlen($id) <= 512) $context['id'] = $id;
  if (is_string($issuerDomain) && strlen($issuerDomain) <= 255) $context['issuer'] = ['domain' => $issuerDomain];

  $malformed = function ($why) use ($context, $checks) {
    return verdict('invalid', 'malformed-credential', 'the credential is malformed: ' . $why, $context, $checks);
  };
  if (!isset($context['id'])) return $malformed('id');
  if (!($asset instanceof \stdClass)) return $malformed('asset');
  if (!($owner instanceof \stdClass) || !is_string(prop($owner, 'publicKey')) || prop($owner, 'publicKey') === '') return $malformed('owner');
  if (!is_int($quantity) || $quantity < 1 || $quantity > MAX_SAFE_INTEGER) return $malformed('quantity');
  if (!has_prop($credential, 'supersedes')) return $malformed('supersedes');
  $issuedAt = parse_time($issuedAtText);
  if ($issuedAt === null) return $malformed('issuedAt');
  if (!($issuer instanceof \stdClass) || !isset($context['issuer'])) return $malformed('issuer');
  $point = decode_point($issuerKey);
  if ($point === null) return $malformed('issuer.publicKey');
  $rawSignature = decode_strict($signature, 64);
  if ($rawSignature === null) return $malformed('signature');
  $expiresAt = null;
  if (has_prop($asset, 'expiresAt') && $asset->expiresAt !== null) {
    $expiresAt = parse_time($asset->expiresAt);
    if ($expiresAt === null) return $malformed('asset.expiresAt');
  }

  // 1. the issuer is one this verifier was configured to trust
  if (!is_array($trust) || !isset($trust['origin'], $trust['domain'], $trust['scheme'])) {
    $checks['issuerTrusted'] = 'fail';
    return verdict('untrusted-issuer', 'issuer-not-configured', 'the credential names an issuer this verifier is not configured to trust', $context, $checks);
  }
  if (strtolower($issuerDomain) !== $trust['domain']) {
    $checks['issuerTrusted'] = 'fail';
    return verdict('untrusted-issuer', 'issuer-mismatch', 'the credential names a different issuer than the trusted origin', $context, $checks);
  }
  if (!empty($trust['pinnedKeys']) && !in_array($issuerKey, $trust['pinnedKeys'], true)) {
    $checks['issuerTrusted'] = 'fail';
    return verdict('untrusted-issuer', 'key-not-pinned', 'the credential is signed with a key that is not pinned for this issuer', $context, $checks);
  }
  $checks['issuerTrusted'] = 'pass';
  $context['issuer'] = ['domain' => $trust['domain'], 'origin' => $trust['origin']];

  if (!function_exists('openssl_verify') || !function_exists('openssl_pkey_get_public')) {
    return verdict('unavailable', 'missing-openssl', 'the PHP openssl extension is not available', $context, $checks);
  }

  // 2. the issuer's published key, valid when the credential was issued
  $keyRead = read_document($trust, 'atlas-key.json', MAX_KEY_DOCUMENT_BYTES, $fetch);
  if ($keyRead['doc'] === null) {
    $checks['keyPublished'] = 'unavailable';
    return verdict('unavailable', 'key-document-unavailable', 'the issuer\'s published key ' . $keyRead['why'], $context, $checks);
  }
  $keys = prop($keyRead['doc'], 'keys');
  if (!is_array($keys) || count($keys) === 0 || count($keys) > MAX_KEY_ENTRIES) {
    $checks['keyPublished'] = 'unavailable';
    return verdict('unavailable', 'key-document-unreadable', 'the issuer\'s published key document is not in a form the verifier can read', $context, $checks);
  }
  $listed = false;
  $validWhenIssued = false;
  foreach ($keys as $entry) {
    if (!($entry instanceof \stdClass) || !is_string(prop($entry, 'publicKey'))) {
      $checks['keyPublished'] = 'unavailable';
      return verdict('unavailable', 'key-document-unreadable', 'the issuer\'s published key document is not in a form the verifier can read', $context, $checks);
    }
    if (prop($entry, 'publicKey') !== $issuerKey) continue;
    $listed = true;
    $from = parse_time(prop($entry, 'validFrom'));
    $untilValue = prop($entry, 'validUntil');
    $until = $untilValue === null ? INF : parse_time($untilValue);
    if ($from === null || $until === null) continue;
    if ($issuedAt >= $from && $issuedAt <= $until) { $validWhenIssued = true; break; }
  }
  if (!$listed) {
    $checks['keyPublished'] = 'fail';
    return verdict('invalid', 'key-not-published', 'the issuer does not publish the key this credential names', $context, $checks);
  }
  $checks['keyPublished'] = 'pass';
  if (!$validWhenIssued) {
    $checks['keyValidAtIssuance'] = 'fail';
    return verdict('invalid', 'key-not-valid-at-issuance', 'the issuer key was not valid when the credential was issued', $context, $checks);
  }
  $checks['keyValidAtIssuance'] = 'pass';

  // 3. the signature over the canonical payload
  $payload = new \stdClass();
  $payload->id = $id;
  $payload->asset = $asset;
  $payload->owner = $owner;
  $payload->quantity = $quantity;
  $payload->supersedes = $credential->supersedes;
  $payload->issuedAt = $issuedAtText;
  $verified = false;
  try {
    $verified = ecdsa_verify_raw(ec_raw_point_to_pem($point), $rawSignature, canonicalize($payload));
  } catch (\Exception $e) {
    $verified = false;
  }
  if (!$verified) {
    $checks['signature'] = 'fail';
    return verdict('invalid', 'bad-signature', 'the signature does not match the issuer\'s published key', $context, $checks);
  }
  $checks['signature'] = 'pass';

  // 4. revocation (always required)
  $revoked = false;
  $revocationReason = null;
  $revocationRead = read_document($trust, 'atlas-revocations.json', MAX_STATUS_DOCUMENT_BYTES, $fetch);
  if ($revocationRead['doc'] === null) {
    $checks['revocation'] = 'unavailable';
    $revocationProblem = 'the issuer\'s revocation list ' . $revocationRead['why'];
  } else {
    $ids = revocation_ids($revocationRead['doc']);
    if ($ids === null) {
      $checks['revocation'] = 'unavailable';
      $revocationProblem = 'the issuer\'s revocation list is not in a form the verifier can read';
    } else {
      $revoked = array_key_exists($id, $ids);
      $revocationReason = $revoked ? $ids[$id] : null;
      $checks['revocation'] = $revoked ? 'fail' : 'pass';
    }
  }

  // 5. suspension (required unless the issuer is configured to leave the list unpublished until first use)
  $suspended = false;
  $finalized = false;
  $suspensionRead = read_document($trust, 'atlas-suspensions.json', MAX_STATUS_DOCUMENT_BYTES, $fetch);
  if ($suspensionRead['doc'] === null) {
    if (!empty($suspensionRead['notFound']) && isset($trust['suspensions']) && $trust['suspensions'] === 'optional') {
      $checks['suspension'] = 'pass';
    } else {
      $checks['suspension'] = 'unavailable';
      $suspensionProblem = 'the issuer\'s suspension list ' . $suspensionRead['why'];
    }
  } else {
    $entries = suspension_entries_for($suspensionRead['doc'], $id);
    if ($entries === null) {
      $checks['suspension'] = 'unavailable';
      $suspensionProblem = 'the issuer\'s suspension list is not in a form the verifier can read';
    } else {
      foreach ($entries as $entry) {
        if ($entry['expiresAt'] === null || $entry['expiresAt'] > $context['now']) $suspended = true;
        elseif ($entry['onExpire'] === 'finalize') $finalized = true;
      }
      $checks['suspension'] = ($suspended || $finalized) ? 'fail' : 'pass';
    }
  }

  // 6. expiry
  $expired = $expiresAt !== null && $context['now'] > $expiresAt;
  $checks['expiry'] = $expired ? 'fail' : 'pass';

  // A definite negative outranks an unreadable document; an unreadable document outranks a pass.
  if ($revoked) {
    return verdict('revoked', 'revoked', 'the issuer has revoked this credential' . ($revocationReason !== null ? ' (' . $revocationReason . ')' : ''), $context, $checks);
  }
  if ($finalized) {
    return verdict('revoked', 'suspension-finalized', 'the credential was suspended with a finalize deadline that has passed, which revokes it', $context, $checks);
  }
  if ($suspended) {
    return verdict('suspended', 'suspended', 'the issuer has suspended this credential', $context, $checks);
  }
  if ($expired) {
    return verdict('expired', 'expired', 'the credential expired at ' . $asset->expiresAt, $context, $checks);
  }
  if ($checks['revocation'] === 'unavailable') {
    return verdict('unavailable', 'revocation-unavailable', 'not verified: ' . $revocationProblem, $context, $checks);
  }
  if ($checks['suspension'] === 'unavailable') {
    return verdict('unavailable', 'suspension-unavailable', 'not verified: ' . $suspensionProblem, $context, $checks);
  }
  return verdict('verified', 'verified', 'signed by the issuer\'s published key, not revoked or suspended, not expired', $context, $checks);
}
