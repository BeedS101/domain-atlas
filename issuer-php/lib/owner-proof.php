<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
// Owner proof for membership issuance: the recipient key signs an exact "issue" request.
//
// Mirrors issuer-server/lib-owner-proof.js decision for decision; both are checked against the shared vectors in
// test/vectors/owner-proof.json. Signature verification is passed in ($verify): the issuer hands over its own
// envelope check and nothing here touches a key store, a clock or a file.
//
// The signed payload (the intent shape split, consolidate and convert already use):
//   { action: 'issue', assetClass, domain, issuedAt, ownerPublicKey, quantity: 1, requestId }
// signed by ownerPublicKey, so it authorizes one issuance of one class to that key at one issuer.
//
// Order of checks: mode off or another class (not this file's business); no intent (accept lets it through as an
// unsigned issuance, require refuses); an intent that is present is checked in every mode (shape, request id, exact
// payload, signature, signer); freshness only when asked, because a retry of an issuance already completed has
// legitimately aged.

const ATLAS_OWNER_PROOF_CLASSES = ['atlas.membership', 'atlas.postoffice.membership', 'atlas.tradingstation.membership'];
const ATLAS_OWNER_PROOF_MODES = ['off', 'accept', 'require'];
const ATLAS_OWNER_PROOF_WINDOW_MS = 120000;
// What a wallet that predates the signed request shows when this issuer insists on one.
const ATLAS_OWNER_PROOF_UPDATE_WALLET_MESSAGE = 'This domain requires a newer version of Domain Atlas Wallet to join this service. Please update your wallet and try again.';

// The mode named by $value, or null when it is not one of the three.
function atlas_owner_proof_parse_mode($value) {
  $v = is_string($value) ? strtolower(trim($value)) : '';
  return in_array($v, ATLAS_OWNER_PROOF_MODES, true) ? $v : null;
}

function atlas_owner_proof_needs($assetClass, $mode) {
  return $mode !== 'off' && is_string($assetClass) && in_array($assetClass, ATLAS_OWNER_PROOF_CLASSES, true);
}

function atlas_owner_proof_payload($f) {
  return [
    'action' => 'issue', 'assetClass' => $f['assetClass'], 'domain' => $f['domain'], 'issuedAt' => $f['issuedAt'],
    'ownerPublicKey' => $f['ownerPublicKey'], 'quantity' => 1, 'requestId' => $f['requestId'],
  ];
}

// An object here is a non-empty associative array; an empty one or a list is never a valid payload, proof or intent.
function atlas_owner_proof_is_object($v) {
  return is_array($v) && $v !== [] && !array_is_list($v);
}

// Milliseconds for a canonical UTC timestamp with milliseconds, or null. The round trip refuses dates that roll over
// and any spelling other than the one a wallet writes, so every implementation reads the same instant.
function atlas_owner_proof_parse_issued_at($value) {
  if (!is_string($value) || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/D', $value)) return null;
  $d = DateTimeImmutable::createFromFormat('Y-m-d\TH:i:s.v\Z', $value, new DateTimeZone('UTC'));
  if ($d === false || $d->format('Y-m-d\TH:i:s.v\Z') !== $value) return null;
  return (int) $d->format('U') * 1000 + (int) $d->format('v');
}

function atlas_owner_proof_refuse($status, $code, $error, $extra = []) {
  return array_merge(['ok' => false, 'status' => $status, 'code' => $code, 'error' => $error], $extra);
}

function atlas_owner_proof_stale($issuedAtMs, $nowMs) {
  if (abs($nowMs - $issuedAtMs) <= ATLAS_OWNER_PROOF_WINDOW_MS) return null;
  return atlas_owner_proof_refuse(401, 'stale-request', 'request is outside the allowed time window',
    ['serverTime' => gmdate('Y-m-d\TH:i:s', intdiv($nowMs, 1000)) . sprintf('.%03dZ', $nowMs % 1000)]);
}

// $ctx: domain, mode, nowMs, requireFresh. $verify($payload, $proof) returns exactly true for a good signature.
function atlas_owner_proof_verdict($body, $ctx, $verify) {
  $assetClass = is_array($body) ? ($body['assetClass'] ?? null) : null;
  if (!atlas_owner_proof_needs($assetClass, $ctx['mode'])) return ['ok' => true, 'skipped' => true];
  $intent = $body['intent'] ?? null;
  if ($intent === null) {
    if ($ctx['mode'] === 'require') return atlas_owner_proof_refuse(403, 'owner-authorization-required', ATLAS_OWNER_PROOF_UPDATE_WALLET_MESSAGE, ['updateWallet' => true]);
    return ['ok' => true, 'legacy' => true];
  }
  if (!atlas_owner_proof_is_object($intent) || !atlas_owner_proof_is_object($intent['payload'] ?? null) || !atlas_owner_proof_is_object($intent['proof'] ?? null)) {
    return atlas_owner_proof_refuse(403, 'owner-authorization-required', 'The signed request is malformed.');
  }
  $requestId = $body['requestId'] ?? null;
  if (!is_string($requestId) || !preg_match('/^[A-Za-z0-9_-]{16,80}$/D', $requestId)) {
    return atlas_owner_proof_refuse(400, 'request-id-required', 'A signed membership request needs a requestId of 16 to 80 characters of letters, digits, - and _.');
  }
  $owner = $body['ownerPublicKey'] ?? null;
  if (!is_string($owner) || $owner === '') return atlas_owner_proof_refuse(403, 'owner-authorization-required', 'The signed request does not name the recipient.');
  $payload = $intent['payload'];
  $proof = $intent['proof'];
  // JSON has one kind of number: a whole-number 1.0 is the same value as 1 and signs identically.
  if (isset($payload['quantity']) && is_float($payload['quantity']) && $payload['quantity'] === 1.0) $payload['quantity'] = 1;
  $issuedAtMs = atlas_owner_proof_parse_issued_at($payload['issuedAt'] ?? null);
  if ($issuedAtMs === null) return atlas_owner_proof_refuse(403, 'owner-authorization-required', 'The signed request has no valid issue time.');
  $expected = atlas_owner_proof_payload(['assetClass' => $assetClass, 'domain' => $ctx['domain'], 'issuedAt' => $payload['issuedAt'], 'ownerPublicKey' => $owner, 'requestId' => $requestId]);
  if (canonicalize($payload) !== canonicalize($expected)) {
    return atlas_owner_proof_refuse(403, 'owner-authorization-required', 'The signed request does not authorize exactly this issuance at this domain.');
  }
  $good = false;
  try { $good = is_string($proof['publicKey'] ?? null) && $verify($payload, $proof) === true; } catch (Throwable $e) { $good = false; }
  if (!$good) return atlas_owner_proof_refuse(403, 'owner-signature-invalid', 'The request signature does not check out.');
  if ($proof['publicKey'] !== $owner) return atlas_owner_proof_refuse(403, 'not-owner', 'The request was not signed by the key the membership is issued to.');
  if (!empty($ctx['requireFresh'])) {
    $stale = atlas_owner_proof_stale($issuedAtMs, $ctx['nowMs']);
    if ($stale !== null) return $stale;
  }
  return ['ok' => true, 'signed' => true, 'issuedAtMs' => $issuedAtMs];
}

// ---------- what an operator needs to know before switching to 'require' ----------
// The same document the Node issuer keeps (see issuer-server/lib-owner-proof.js): outcome counts per class, no keys,
// credentials or request ids. tools/owner-proof-readiness.js reads either.
function atlas_owner_proof_empty_stats() {
  return ['version' => 1, 'mode' => null, 'modeSince' => null, 'updatedAt' => null, 'classes' => new stdClass(), 'refusedByCode' => new stdClass()];
}

// kind: 'signed' | 'unsigned' | 'refused' (code names the refusal). Returns the document.
function atlas_owner_proof_record($doc, $assetClass, $kind, $code, $nowIso) {
  if (!is_array($doc) || !isset($doc['classes'])) $doc = atlas_owner_proof_empty_stats();
  $classes = (array) $doc['classes'];
  $by = (array) ($doc['refusedByCode'] ?? []);
  $c = $classes[$assetClass] ?? ['signed' => 0, 'unsigned' => 0, 'refused' => 0, 'lastSignedAt' => null, 'lastUnsignedAt' => null, 'lastRefusedAt' => null];
  if ($kind === 'signed') { $c['signed']++; $c['lastSignedAt'] = $nowIso; }
  elseif ($kind === 'unsigned') { $c['unsigned']++; $c['lastUnsignedAt'] = $nowIso; }
  else {
    $c['refused']++; $c['lastRefusedAt'] = $nowIso;
    $k = is_string($code) ? $code : 'unknown';
    $by[$k] = ($by[$k] ?? 0) + 1;
  }
  $classes[$assetClass] = $c;
  $doc['classes'] = $classes;
  $doc['refusedByCode'] = $by;
  $doc['updatedAt'] = $nowIso;
  return $doc;
}

function atlas_owner_proof_record_mode($doc, $mode, $nowIso) {
  if (!is_array($doc) || !isset($doc['classes'])) $doc = atlas_owner_proof_empty_stats();
  if (($doc['mode'] ?? null) !== $mode) { $doc['mode'] = $mode; $doc['modeSince'] = $nowIso; $doc['updatedAt'] = $nowIso; }
  return $doc;
}

// ---------- mode and outcome counts (the parts that touch the environment and the disk) ----------

// off | accept | require. Environment variable ATLAS_OWNER_PROOF first, then "mode" in lib/atlas-owner-proof-config.json
// (for hosts where setting an environment variable is awkward), otherwise accept. 'accept' is a temporary compatibility
// mode: a request without a proof is still served. An unrecognised value falls back to accept and is logged.
function atlas_owner_proof_mode() {
  static $mode = null;
  if ($mode !== null) return $mode;
  $env = getenv('ATLAS_OWNER_PROOF');
  $raw = ($env !== false && $env !== '') ? $env : null;
  if ($raw === null) {
    $file = __DIR__ . '/atlas-owner-proof-config.json';
    if (is_file($file)) {
      $cfg = json_decode((string) @file_get_contents($file), true);
      if (is_array($cfg) && array_key_exists('mode', $cfg)) $raw = $cfg['mode'];
    }
  }
  if ($raw === null) return $mode = 'accept';
  $parsed = atlas_owner_proof_parse_mode($raw);
  if ($parsed === null) {
    error_log('atlas: the owner proof mode is not off, accept or require; using accept.');
    return $mode = 'accept';
  }
  return $mode = $parsed;
}

function atlas_owner_proof_stats_file() {
  return atlas_private_subdir_ensure('owner-proof') . '/stats.json';
}

// Records one outcome ('signed' | 'unsigned' | 'refused'). Never fails a request: the counts are for the operator.
function atlas_owner_proof_note($assetClass, $kind, $code = null) {
  try {
    $now = gmdate('Y-m-d\TH:i:s\Z');
    atlas_admin_locked(atlas_owner_proof_stats_file(), atlas_owner_proof_empty_stats(), function ($doc) use ($assetClass, $kind, $code, $now) {
      $doc = atlas_owner_proof_record_mode($doc, atlas_owner_proof_mode(), $now);
      $doc = atlas_owner_proof_record($doc, $assetClass, $kind, $code, $now);
      $doc['classes'] = (object) $doc['classes'];
      $doc['refusedByCode'] = (object) $doc['refusedByCode'];
      return [$doc, true];
    });
  } catch (Throwable $e) {
    error_log('atlas: could not record the owner-proof outcome: ' . $e->getMessage());
  }
}
