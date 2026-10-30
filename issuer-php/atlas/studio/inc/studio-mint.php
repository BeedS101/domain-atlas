<?php
// Asset Studio mint pipeline: design -> challenge -> wallet signature -> one issuer-signed credential.
//
// Needs lib/bootstrap.php already loaded (issuer key, issue_asset(), the replay store and transaction
// journal). Every function returns [httpStatus, body] and never sends output itself, so tests can call it.
//
// Idempotency and crash safety. The request id is 'studio-mint-' + the challenge nonce. A credential
// exists exactly when the issuer's journal or replay record for that request id exists:
//
//   sign the credential in memory (nothing recorded)            studio:signed / txn:minted
//   write the transaction journal entry (atomic replace)        txn:journal-written   <- the commit
//   store the replay record, remove the journal entry           txn:replay-stored
//
// Everything before the journal write leaves no trace of the credential (it was never returned), so a
// retry signs a fresh one. Everything after it is finished by any retry, which returns the SAME stored
// response byte for byte. Requests for one nonce are serialized by the request-id lease, so concurrent
// retries cannot both sign. The attempt ledger and the challenge state are bookkeeping and quotas; a
// crash that leaves them behind is repaired by the next retry, never by guessing.
require_once __DIR__.'/storage.php';
require_once __DIR__.'/challenges.php';
require_once __DIR__.'/mint-attempts.php';
require_once __DIR__.'/authorize-design.php';

function atlas_studio_config_defaults() {
  // name => [default, min, max]
  return [
    'challengesPerIpPerHour'=>[30,1,10000],
    'mintsPerIpPerHour'=>[10,1,10000],
    'maxMintsPerRecipientPerDay'=>[3,1,1000],
    'maxMintsPerDay'=>[200,1,100000],
    'maxOutstandingChallenges'=>[500,1,5000],
  ];
}

// Studio minting is OFF unless <storage root>/studio-config.json says {"mintEnabled": true, ...}. Any problem
// with the file or the settings keeps it off (fail closed) and is reported as a short reason code.
// {"mintEnabled": true, "domain": "host[:port]", "origins": ["https://host"], <limits>}
// `domain` must equal this request's host and `origins` (default https://domain) are the only page origins
// whose wallet signatures are accepted; http is allowed only for localhost-style hosts.
function atlas_studio_config($root) {
  $off = function ($why) { return ['enabled'=>false,'reason'=>$why]; };
  $file = $root.'/studio-config.json';
  if (!is_file($file) || is_link($file)) return $off('mint-not-configured');
  $raw = @file_get_contents($file, false, null, 0, 8193);
  if ($raw === false || strlen($raw) > 8192) return $off('config-unreadable');
  $c = json_decode($raw, true);
  if (!is_array($c) || ($c['mintEnabled'] ?? false) !== true) return $off('mint-disabled');
  $domain = $c['domain'] ?? null;
  if (!is_string($domain) || $domain === '' || strtolower($domain) !== strtolower(atlas_domain())) return $off('domain-mismatch');
  $host = preg_replace('/:\d+$/', '', strtolower($domain));
  $local = in_array($host, ['localhost','127.0.0.1','[::1]'], true);
  $origins = $c['origins'] ?? ['https://'.$domain];
  if (!is_array($origins) || !$origins || count($origins) > 4) return $off('bad-origins');
  foreach ($origins as $o) {
    if (!is_string($o) || !preg_match('#^https?://[A-Za-z0-9.:\[\]-]+$#D', $o) || (strpos($o, 'http://') === 0 && !$local)) return $off('bad-origins');
  }
  $cfg = ['enabled'=>true,'domain'=>$domain,'origins'=>array_values($origins)];
  foreach (atlas_studio_config_defaults() as $k=>$spec) {
    $v = array_key_exists($k, $c) ? $c[$k] : $spec[0];
    if (!is_int($v) || $v < $spec[1] || $v > $spec[2]) return $off('bad-limit-'.$k);
    $cfg[$k] = $v;
  }
  return $cfg;
}

function atlas_studio_err($status, $code) {
  return [$status, ['ok'=>false,'error'=>$code]];
}

// Maps a design / proof failure to an HTTP status.
function atlas_studio_status_for($error) {
  switch ($error) {
    case 'invalid-signature': case 'wrong-signing-context': case 'proof-mismatch': case 'webauthn-presence-required':
    case 'invalid-proof-key': return 403;
    case 'challenge-expired': case 'challenge-not-issued': return 410;
    default: return 400;
  }
}

function atlas_studio_body_ok($body, $keys) {
  if (!is_array($body) || array_diff(array_keys($body), $keys) || array_diff($keys, array_keys($body))) return false;
  return true;
}

// The issuer's own verifier for a wallet-bridge signature: the bridge wrapper must name one of this
// domain's origins and the envelope's signature must verify (WebAuthn or raw ECDSA).
function atlas_studio_wallet_verifier() {
  return function ($signed, $proof) {
    return atlas_unwrap_bridge_signed($signed) !== null && verify_envelope($signed, $proof, true);
  };
}

function atlas_studio_request_id($nonce) { return 'studio-mint-'.$nonce; }

// POST ?op=challenge  { design, recipient }
function atlas_studio_issue_challenge($root, $cfg, $body, $ipKey, $now = null) {
  $now = $now ?? time();
  if (!atlas_studio_body_ok($body, ['design','recipient'])) return atlas_studio_err(400, 'invalid-request');
  $plan = atlas_studio_issuance_plan($body['design'], $body['recipient']);
  if (!$plan['ok']) return atlas_studio_err(400, $plan['error']);
  if (!atlas_studio_model_available(atlas_docroot(), $plan['model'])) return atlas_studio_err(503, 'model-unavailable');
  if (!atlas_studio_rate_hit($root, 'challenge:'.$ipKey, $cfg['challengesPerIpPerHour'], 3600, $now)) return atlas_studio_err(429, 'rate-limited');
  try {
    $c = atlas_studio_new_challenge($root, $plan['designDigest'], $plan['recipient'], $now, $cfg['maxOutstandingChallenges']);
  } catch (RuntimeException $e) {
    return atlas_studio_err(503, $e->getMessage() === 'too-many-challenges' ? 'busy' : 'unavailable');
  }
  $fp = atlas_studio_design_fingerprint($body['design']);
  return [200, [
    'ok'=>true, 'nonce'=>$c['nonce'], 'expiresAt'=>$c['expiresAt'], 'design'=>$fp['design'], 'designDigest'=>$plan['designDigest'],
    'signRequest'=>atlas_studio_sign_request(['nonce'=>$c['nonce'],'designDigest'=>$plan['designDigest'],'recipient'=>$plan['recipient'],'expiresAt'=>$c['expiresAt']], $plan['summary']),
  ]];
}

// POST ?op=mint  { design, nonce, proof }. Returns the issuer-signed credential; a repeat of the same
// request returns the identical response.
function atlas_studio_mint($root, $cfg, $body, $ipKey, $now = null) {
  $now = $now ?? time();
  if (!atlas_studio_body_ok($body, ['design','nonce','proof'])) return atlas_studio_err(400, 'invalid-request');
  $nonce = $body['nonce'];
  if (!is_string($nonce) || !preg_match('/^[a-f0-9]{64}$/D', $nonce)) return atlas_studio_err(400, 'invalid-nonce');
  $challenge = atlas_studio_read_challenge($root, $nonce);
  if ($challenge === null) return atlas_studio_err(404, 'unknown-challenge');

  // Authorize first (binding + signature), in retry mode so a repeat after expiry can still be answered.
  $auth = atlas_studio_authorize_design_proof($body['design'], $body['proof'], $challenge, $cfg['origins'], atlas_studio_wallet_verifier(), $now, true);
  if (!$auth['ok']) return atlas_studio_err(atlas_studio_status_for($auth['error']), $auth['error']);
  $digest = $auth['designDigest'];
  $recipient = $auth['recipient'];
  $requestId = atlas_studio_request_id($nonce);
  $params = ['assetClass'=>ATLAS_STUDIO_CLASS,'designDigest'=>$digest,'recipient'=>$recipient,'nonce'=>$nonce];

  atlas_txn_sweep();
  if (atlas_request_lease($requestId) !== null) return atlas_studio_err(503, 'busy');
  atlas_txn_recover_key($requestId);
  $prior = atlas_replay_lookup($requestId, 'studio-mint', [], $params);
  if ($prior !== null && isset($prior['conflict'])) return atlas_studio_err(409, 'request-conflict');
  if ($prior !== null) {
    $done = json_decode($prior['responseJson'], true);
    $id = is_array($done) && isset($done['credential']['id']) ? $done['credential']['id'] : null;
    if ($id !== null) {
      atlas_studio_mark_attempt_minted($root, $nonce, $id);
      atlas_studio_transition_challenge($root, $nonce, 'issued', 'completed', $digest, $recipient);
    }
    return [200, ['__raw'=>$prior['responseJson']]];
  }

  // Nothing was ever committed for this nonce: this is the first attempt, or a crash left no trace.
  $live = atlas_studio_read_challenge($root, $nonce);
  if ($live === null || $live['state'] !== 'issued') return atlas_studio_err(410, 'challenge-not-issued');
  if ($live['expiresAt'] < $now || $live['expiresAt'] > $now + ATLAS_STUDIO_CHALLENGE_TTL) return atlas_studio_err(410, 'challenge-expired');
  $plan = atlas_studio_issuance_plan($body['design'], $recipient);
  if (!$plan['ok']) return atlas_studio_err(400, $plan['error']);
  if (!atlas_studio_model_available(atlas_docroot(), $plan['model'])) return atlas_studio_err(503, 'model-unavailable');
  if (!atlas_studio_rate_hit($root, 'mint:'.$ipKey, $cfg['mintsPerIpPerHour'], 3600, $now)) return atlas_studio_err(429, 'rate-limited');
  $claim = atlas_studio_claim_attempt($root, $nonce, $digest, $recipient,
    ['perRecipient'=>$cfg['maxMintsPerRecipientPerDay'],'global'=>$cfg['maxMintsPerDay'],'windowSeconds'=>86400], $now);
  if (!$claim['ok']) {
    $quota = $claim['error'] === 'quota-recipient' || $claim['error'] === 'quota-global';
    return atlas_studio_err($quota ? 429 : 409, $claim['error']);
  }
  // An attempt recorded as minted with no stored result cannot be re-issued: report it, never re-sign.
  if ($claim['state'] === 'minted') return atlas_studio_err(410, 'already-minted');
  atlas_fault_point('studio:claimed');

  $kp = atlas_load_keys();
  $asset = atlas_studio_build_asset(atlas_asset_catalog_entry(ATLAS_STUDIO_CLASS), $plan, atlas_domain());
  if ($asset === null) return atlas_studio_err(500, 'class-unavailable');
  $credential = issue_asset($kp['privateKey'], $kp['publicKeyB64url'], $recipient, $asset, 1, null, true);
  atlas_fault_point('studio:signed');
  $responseJson = atlas_commit_replacement($requestId, 'studio-mint', [], null, $params, [$credential],
    ['ok'=>true,'credential'=>$credential,'designDigest'=>$digest]);
  atlas_fault_point('studio:committed');
  atlas_studio_mark_attempt_minted($root, $nonce, $credential['id']);
  atlas_studio_transition_challenge($root, $nonce, 'issued', 'completed', $digest, $recipient);
  return [200, ['__raw'=>$responseJson]];
}
