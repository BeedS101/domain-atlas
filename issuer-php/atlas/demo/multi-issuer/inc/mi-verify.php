<?php
// Multi-Issuer Portable Asset Lab: verification of the portable asset, authenticated discovery,
// outbound HTTPS and signed peer requests. See mi.php for the model.

// ---------------------------------------------------------------- state digest, transfer payload, receipts

function mi_state_digest($assetId, $version, $ownerPub, $previous) {
  return mi_digest(['v' => MI_STATE_VERSION, 'assetId' => $assetId, 'version' => $version, 'owner' => $ownerPub, 'previous' => $previous]);
}

function mi_transfer_shape_ok($p) {
  if (!mi_keys_exact($p, ['assetId', 'baseStateDigest', 'baseVersion', 'createdAtMs', 'definitionDigest', 'expiresAtMs', 'fromOwner', 'registry', 'session', 'toOwner', 'txId', 'v'])) return false;
  if ($p['v'] !== MI_TRANSFER_VERSION || !mi_is_uuid($p['txId']) || !mi_is_uuid($p['assetId'])) return false;
  foreach (['baseStateDigest', 'definitionDigest'] as $f) if (!is_string($p[$f]) || !preg_match('/^[0-9a-f]{64}$/', $p[$f])) return false;
  foreach (['baseVersion', 'createdAtMs', 'expiresAtMs'] as $f) if (!is_int($p[$f])) return false;
  if ($p['baseVersion'] < 0 || $p['expiresAtMs'] <= $p['createdAtMs']) return false;
  if (!mi_pubkey_ok($p['fromOwner']) || !mi_pubkey_ok($p['toOwner']) || $p['fromOwner'] === $p['toOwner']) return false;
  if (!mi_domain_ok($p['registry'])) return false;
  return is_string($p['session']) && preg_match('/^[0-9a-f]{16}$/', $p['session']) === 1;
}

function mi_owner_auth_ok($auth, $payload, $digest) {
  return mi_keys_exact($auth, ['owner', 'signedAtMs', 'transferDigest', 'txId', 'v'])
    && $auth['v'] === MI_OWNER_AUTH_VERSION && $auth['txId'] === $payload['txId'] && $auth['transferDigest'] === $digest
    && $auth['owner'] === mi_key_id($payload['fromOwner']) && is_int($auth['signedAtMs']);
}

// ---------------------------------------------------------------- offline verification of a portable asset

// Verifies approvals recorded in a list of {approver|domain, approval, signature} entries against the
// issuer keys embedded in the definition. Each domain counts at most once.
function mi_check_signatures($def, $entries, $refId, $digest, $policy) {
  $rows = [];
  $decisions = [];
  $seen = [];
  foreach (is_array($entries) ? $entries : [] as $e) {
    $dom = is_array($e) ? (isset($e['domain']) ? $e['domain'] : (isset($e['approver']) ? $e['approver'] : null)) : null;
    $row = ['domain' => is_string($dom) ? $dom : null, 'valid' => false, 'decision' => null, 'reason' => null, 'approvedAtMs' => null];
    $issuer = is_string($dom) ? mi_issuer($def, $dom) : null;
    if (!is_array($e) || !isset($e['approval'], $e['signature'])) $row['reason'] = 'malformed entry';
    elseif ($issuer === null || !in_array($dom, $policy['roster'], true)) $row['reason'] = 'not an issuer of this asset';
    elseif (isset($seen[$dom])) $row['reason'] = 'duplicate: a domain counts once';
    elseif (!txlab_approval_shape_ok($e['approval'])) $row['reason'] = 'malformed approval';
    elseif ($e['approval']['approver'] !== $dom) $row['reason'] = 'approval names a different signer';
    elseif ($e['approval']['txId'] !== $refId) $row['reason'] = 'approval is for a different item';
    elseif ($e['approval']['payloadDigest'] !== $digest) $row['reason'] = 'approval signed over a different digest';
    elseif (!mi_verify_obj($issuer['publicKey'], $e['approval'], $e['signature'])) $row['reason'] = 'signature does not verify against the issuer key in the asset';
    else {
      $row['valid'] = true;
      $row['decision'] = $e['approval']['decision'];
      $row['approvedAtMs'] = $e['approval']['approvedAtMs'];
      $decisions[$dom] = $e['approval']['decision'];
    }
    if ($row['domain'] !== null && !isset($seen[$row['domain']])) $seen[$row['domain']] = true;
    $rows[] = $row;
  }
  return [$rows, txlab_evaluate($policy, $decisions)];
}

function mi_verify_portable($asset) {
  $rep = [
    'shapeOk' => false, 'problem' => null, 'assetId' => null, 'definitionDigestOk' => false,
    'issuers' => [], 'issuance' => null, 'originalIssuanceVerified' => false,
    'ownership' => ['chainValid' => false, 'version' => null, 'owner' => null, 'ownerKeyId' => null, 'stateDigest' => null, 'registry' => null, 'problems' => [], 'steps' => []],
  ];
  if (!is_array($asset) || !isset($asset['format']) || $asset['format'] !== MI_PORTABLE_FORMAT || !isset($asset['definition'], $asset['definitionDigest'])) { $rep['problem'] = 'not a portable multi-issuer asset'; return $rep; }
  $def = $asset['definition'];
  $p = mi_definition_problem($def);
  if ($p !== null) { $rep['problem'] = $p; return $rep; }
  $rep['shapeOk'] = true;
  $rep['assetId'] = $def['assetId'];
  $rep['definitionDigestOk'] = is_string($asset['definitionDigest']) && mi_digest($def) === $asset['definitionDigest'];
  if (!$rep['definitionDigestOk']) { $rep['problem'] = 'the definition does not match its digest (modified roster, policy or metadata)'; return $rep; }
  $digest = $asset['definitionDigest'];
  $sigs = isset($asset['issuance']['signatures']) ? $asset['issuance']['signatures'] : [];
  list($rows, $eval) = mi_check_signatures($def, $sigs, $def['assetId'], $digest, $def['issuancePolicy']);
  $by = [];
  foreach ($rows as $r) if ($r['domain'] !== null && !isset($by[$r['domain']])) $by[$r['domain']] = $r;
  foreach ($def['issuers'] as $i) {
    $r = isset($by[$i['domain']]) ? $by[$i['domain']] : null;
    $rep['issuers'][] = [
      'domain' => $i['domain'], 'keyId' => $i['keyId'], 'publicKey' => $i['publicKey'], 'capabilities' => $i['discovery']['capabilities'],
      'mandatory' => in_array($i['domain'], $def['issuancePolicy']['mandatory'], true),
      'signed' => $r !== null && $r['valid'], 'decision' => $r ? $r['decision'] : null, 'approvedAtMs' => $r ? $r['approvedAtMs'] : null,
      'reason' => $r ? $r['reason'] : 'no signature',
    ];
  }
  $rep['invalidEntries'] = array_values(array_filter($rows, function ($r) { return !$r['valid']; }));
  $rep['issuance'] = [
    'approved' => count($eval['approved']), 'required' => $eval['required'], 'signedBy' => $eval['approved'], 'rejectedBy' => $eval['rejected'],
    'missingMandatory' => $eval['missingMandatory'], 'satisfied' => $eval['satisfied'],
    'roster' => $def['issuancePolicy']['roster'],
  ];
  $rep['originalIssuanceVerified'] = (bool) $eval['satisfied'];
  mi_verify_chain($def, $digest, isset($asset['ownership']['evidence']) ? $asset['ownership']['evidence'] : [], $rep['originalIssuanceVerified'], $rep['ownership']);
  return $rep;
}

function mi_verify_chain($def, $digest, $evidence, $issued, &$own) {
  $own['registry'] = $def['stateAuthority']['domain'];
  $regIssuer = mi_issuer($def, $def['stateAuthority']['domain']);
  if (!is_array($evidence) || count($evidence) === 0) { $own['problems'][] = $issued ? 'no ownership evidence attached' : 'the asset is not issued yet'; return; }
  $prev = null;
  $ownerPub = null;
  foreach ($evidence as $i => $step) {
    $row = ['version' => $i, 'valid' => false, 'reason' => null, 'txId' => null];
    $r = is_array($step) && isset($step['receipt']) ? $step['receipt'] : null;
    $bad = function ($m) use (&$row, &$own, $i) { $row['reason'] = $m; $own['problems'][] = 'version ' . $i . ': ' . $m; };
    if (!is_array($r) || !isset($step['signature']) || !mi_verify_obj($regIssuer['publicKey'], $r, $step['signature'])) { $bad('the state authority\'s signature does not verify'); $own['steps'][] = $row; break; }
    if ($i === 0) {
      if (!mi_keys_exact($r, ['assetId', 'definitionDigest', 'owner', 'registeredAtMs', 'registry', 'stateDigest', 'v', 'version'])) { $bad('malformed registration'); $own['steps'][] = $row; break; }
      if ($r['v'] !== MI_REGISTRATION_VERSION || $r['assetId'] !== $def['assetId'] || $r['definitionDigest'] !== $digest || $r['version'] !== 0 || $r['registry'] !== $def['stateAuthority']['domain']) { $bad('registration does not match the asset'); $own['steps'][] = $row; break; }
      if ($r['owner'] !== $def['originalOwner']['publicKey']) { $bad('registered owner differs from the original owner in the definition'); $own['steps'][] = $row; break; }
      if ($r['stateDigest'] !== mi_state_digest($def['assetId'], 0, $r['owner'], $digest)) { $bad('state digest mismatch'); $own['steps'][] = $row; break; }
      $ownerPub = $r['owner'];
      $prev = $r['stateDigest'];
      $row['valid'] = true;
      $own['steps'][] = $row;
      continue;
    }
    if (!mi_keys_exact($r, ['approvals', 'assetId', 'executedAtMs', 'fromVersion', 'ownerAuthorization', 'previousStateDigest', 'registry', 'stateDigest', 'toVersion', 'transfer', 'transferDigest', 'txId', 'v'])) { $bad('malformed transition'); $own['steps'][] = $row; break; }
    $t = $r['transfer'];
    $row['txId'] = $r['txId'];
    if ($r['v'] !== MI_TRANSITION_VERSION || $r['assetId'] !== $def['assetId'] || $r['fromVersion'] !== $i - 1 || $r['toVersion'] !== $i || $r['previousStateDigest'] !== $prev || $r['registry'] !== $def['stateAuthority']['domain']) { $bad('transition does not extend the previous state'); $own['steps'][] = $row; break; }
    if (!mi_transfer_shape_ok($t) || $t['assetId'] !== $def['assetId'] || $t['definitionDigest'] !== $digest || $t['baseVersion'] !== $i - 1 || $t['baseStateDigest'] !== $prev || $t['fromOwner'] !== $ownerPub || $t['registry'] !== $def['stateAuthority']['domain'] || $t['txId'] !== $r['txId']) { $bad('the transfer does not match the state it claims to move'); $own['steps'][] = $row; break; }
    $td = mi_digest($t);
    if ($td !== $r['transferDigest']) { $bad('transfer digest mismatch'); $own['steps'][] = $row; break; }
    $oa = $r['ownerAuthorization'];
    if (!is_array($oa) || !isset($oa['object'], $oa['signature']) || !mi_owner_auth_ok($oa['object'], $t, $td) || !mi_verify_obj($t['fromOwner'], $oa['object'], $oa['signature'])) { $bad('the previous owner\'s signature on this exact transfer does not verify'); $own['steps'][] = $row; break; }
    list($rows, $eval) = mi_check_signatures($def, $r['approvals'], $t['txId'], $td, $def['transferPolicy']);
    if (!$eval['satisfied']) { $bad('the transfer policy was not satisfied by valid issuer approvals'); $own['steps'][] = $row; break; }
    if ($r['stateDigest'] !== mi_state_digest($def['assetId'], $i, $t['toOwner'], $prev)) { $bad('state digest mismatch'); $own['steps'][] = $row; break; }
    $ownerPub = $t['toOwner'];
    $prev = $r['stateDigest'];
    $row['valid'] = true;
    $own['steps'][] = $row;
  }
  $ok = count($own['problems']) === 0;
  $own['chainValid'] = $ok && $issued;
  if ($ok) {
    $own['version'] = count($evidence) - 1;
    $own['owner'] = $ownerPub;
    $own['ownerKeyId'] = mi_key_id($ownerPub);
    $own['stateDigest'] = $prev;
  }
}

// ---------------------------------------------------------------- outbound HTTPS

function mi_resolve_public($host) {
  if (filter_var($host, FILTER_VALIDATE_IP)) return filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) ? $host : null;
  $ips = @gethostbynamel($host);
  if (!$ips) return null;
  foreach ($ips as $ip) if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) return null;
  return $ips[0];
}

// HTTPS only (loopback http only when the config allows it for tests), TLS verified, no redirects,
// bounded time and size. Public hosts only: the address is resolved here, checked and pinned.
function mi_http($cfg, $method, $url, $body, $timeout) {
  $parts = parse_url($url);
  if (!$parts || !isset($parts['scheme'], $parts['host'])) return ['status' => 0, 'body' => null, 'error' => 'malformed url'];
  $loop = txlab_is_loopback_url($url);
  $https = $parts['scheme'] === 'https';
  if (!$https && !($cfg['insecure'] && $loop && $parts['scheme'] === 'http')) return ['status' => 0, 'body' => null, 'error' => 'refusing a non-https url'];
  $resolve = null;
  if (!$loop) {
    $ip = mi_resolve_public($parts['host']);
    if ($ip === null) return ['status' => 0, 'body' => null, 'error' => 'the host does not resolve to a public address'];
    $resolve = [$parts['host'] . ':' . (isset($parts['port']) ? $parts['port'] : 443) . ':' . $ip];
  }
  $ch = curl_init($url);
  $raw = '';
  $opts = [
    CURLOPT_RETURNTRANSFER => false, CURLOPT_FOLLOWLOCATION => false, CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_TIMEOUT => $timeout,
    CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
    CURLOPT_PROTOCOLS => $https ? CURLPROTO_HTTPS : (CURLPROTO_HTTP | CURLPROTO_HTTPS),
    CURLOPT_WRITEFUNCTION => function ($c, $chunk) use (&$raw) { $raw .= $chunk; return strlen($raw) > 524288 ? 0 : strlen($chunk); },
  ];
  if ($resolve) $opts[CURLOPT_RESOLVE] = $resolve;
  curl_setopt_array($ch, $opts);
  if ($method === 'POST') {
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_SLASHES));
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
  }
  $ok = curl_exec($ch);
  $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
  $err = $ok === false ? curl_error($ch) : '';
  curl_close($ch);
  if ($ok === false) return ['status' => 0, 'body' => null, 'error' => $err ?: 'request failed'];
  $decoded = json_decode($raw, true);
  return ['status' => $status, 'body' => is_array($decoded) ? $decoded : null, 'raw' => $raw, 'error' => is_array($decoded) && isset($decoded['error']) ? $decoded['error'] : ('HTTP ' . $status)];
}

// ---------------------------------------------------------------- authenticated discovery

function mi_iso_ms($s) {
  if (!is_string($s)) return null;
  $t = strtotime($s);
  return $t === false ? null : $t * 1000;
}

// A service endpoint must belong to the issuer: https on the issuer's own domain or a subdomain of it
// (relocation within the issuer's own namespace), no credentials, no query. Loopback http is accepted
// only for local tests.
function mi_endpoint_problem($cfg, $domain, $url) {
  if (!is_string($url) || strlen($url) > 300) return 'invalid endpoint';
  $p = parse_url($url);
  if (!$p || !isset($p['scheme'], $p['host'])) return 'malformed endpoint';
  if (isset($p['user']) || isset($p['pass']) || isset($p['query']) || isset($p['fragment'])) return 'endpoint carries credentials, a query or a fragment';
  $path = isset($p['path']) ? $p['path'] : '';
  if ($path === '' || $path[0] !== '/' || strpos($path, '..') !== false || substr($path, -8) !== '/api.php') return 'endpoint path is not an api.php under the issuer';
  $host = strtolower($p['host']);
  if ($p['scheme'] === 'http') {
    if ($cfg['insecure'] && txlab_is_loopback_url($url)) return null;
    return 'endpoint is not https';
  }
  if ($p['scheme'] !== 'https') return 'endpoint is not https';
  if (isset($p['port']) && $p['port'] !== 443) return 'endpoint uses a non-standard port';
  if ($host !== $domain && substr($host, -strlen($domain) - 1) !== '.' . $domain) return 'endpoint host ' . $host . ' is outside the issuer\'s own domain';
  return null;
}

function mi_key_window_ok($k, $now) {
  $from = mi_iso_ms(isset($k['validFrom']) ? $k['validFrom'] : null);
  if ($from === null || $from > $now + TXLAB_CLOCK_SKEW_MS) return false;
  if (array_key_exists('validUntil', $k) && $k['validUntil'] !== null) {
    $until = mi_iso_ms($k['validUntil']);
    if ($until === null || $until <= $now) return false;
  }
  return true;
}

// Validates a fetched discovery wrapper against the issuer identity PINNED in the asset (or this
// domain's roster). Returns [result|null, reason|null].
function mi_validate_manifest($cfg, $issuer, $wrap) {
  $now = txlab_now_ms();
  if (!is_array($wrap) || !isset($wrap['spec'], $wrap['doc'], $wrap['signedBy'], $wrap['signature']) || $wrap['spec'] !== MI_DISCOVERY_VERSION) return [null, 'not a multi-issuer discovery manifest'];
  $doc = $wrap['doc'];
  if (!mi_keys_exact($doc, ['domain', 'issuedAtMs', 'keys', 'seq', 'services', 'validUntilMs'])) return [null, 'malformed manifest'];
  if ($doc['domain'] !== $issuer['domain']) return [null, 'the manifest is for a different domain'];
  if (!is_int($doc['seq']) || $doc['seq'] < 1 || !is_int($doc['issuedAtMs']) || !is_int($doc['validUntilMs'])) return [null, 'malformed manifest numbers'];
  if ($doc['issuedAtMs'] > $now + TXLAB_CLOCK_SKEW_MS) return [null, 'the manifest is dated in the future'];
  if ($doc['validUntilMs'] <= $now) return [null, 'the manifest has expired'];
  if (!is_array($doc['keys']) || count($doc['keys']) < 1 || count($doc['keys']) > 8 || !is_array($doc['services'])) return [null, 'malformed manifest keys or services'];
  // the issuer's identity key is the pinned one; a different signer must be reachable through a chain of endorsements
  $trusted = [$issuer['publicKey'] => 'pinned'];
  $pending = $doc['keys'];
  $progress = true;
  while ($progress) {
    $progress = false;
    foreach ($pending as $idx => $k) {
      if (!is_array($k) || !isset($k['publicKey']) || !mi_pubkey_ok($k['publicKey'])) { unset($pending[$idx]); continue; }
      if (isset($trusted[$k['publicKey']])) { unset($pending[$idx]); continue; }
      $e = isset($k['endorsement']) ? $k['endorsement'] : null;
      if (!is_array($e) || !isset($e['by'], $e['signature']) || !isset($trusted[$e['by']]) || !isset($k['validFrom'])) continue;
      $obj = ['v' => MI_ENDORSEMENT_VERSION, 'domain' => $issuer['domain'], 'publicKey' => $k['publicKey'], 'validFrom' => $k['validFrom']];
      if (mi_verify_obj($e['by'], $obj, $e['signature'])) { $trusted[$k['publicKey']] = 'rotated'; unset($pending[$idx]); $progress = true; }
    }
  }
  $signer = $wrap['signedBy'];
  if (!is_string($signer) || !isset($trusted[$signer])) return [null, 'the manifest is signed by a key that is not the issuer\'s pinned key and is not endorsed by it (public-key substitution refused)'];
  $window = false;
  foreach ($doc['keys'] as $k) {
    if (is_array($k) && isset($k['publicKey']) && $k['publicKey'] === $signer && mi_key_window_ok($k, $now)) $window = true;
  }
  if (!$window) return [null, 'the signing key is not valid now according to the manifest'];
  if (!mi_verify_obj($signer, $doc, $wrap['signature'])) return [null, 'the manifest signature does not verify'];
  $services = [];
  foreach ($doc['services'] as $cap => $url) {
    if (!in_array($cap, mi_capabilities(), true)) continue;
    $why = mi_endpoint_problem($cfg, $issuer['domain'], $url);
    if ($why !== null) return [null, 'service ' . $cap . ': ' . $why];
    $services[$cap] = $url;
  }
  return [['seq' => $doc['seq'], 'issuedAtMs' => $doc['issuedAtMs'], 'validUntilMs' => $doc['validUntilMs'], 'services' => $services, 'keyStatus' => $trusted[$signer], 'signerKeyId' => mi_key_id($signer), 'keys' => count($doc['keys'])], null];
}

// Resolves an issuer's CURRENT services from its own domain. Never called inside a database transaction.
// $maxAgeMs > 0 lets a recently fetched manifest be re-validated from the cache (signature, key window and
// endpoint checks all run again) instead of fetched; signing paths always pass 0.
function mi_discover($cfg, $issuer, $force = false, $maxAgeMs = 0) {
  static $memo = [];
  $domain = $issuer['domain'];
  $mk = $domain . '|' . $issuer['publicKey'];
  if (!$force && isset($memo[$mk]) && txlab_now_ms() - $memo[$mk]['at'] < 5000) return $memo[$mk]['res'];
  $res = ['ok' => false, 'domain' => $domain, 'manifest' => mi_manifest_url($domain), 'reason' => null, 'trustedRoster' => isset($cfg['roster'][$domain])];
  if (!$res['trustedRoster'] && !$cfg['openDiscovery']) {
    $res['status'] = 'skipped';
    $res['reason'] = 'this issuer is not in this site\'s trusted roster and open discovery is off, so no request was made';
    return $res;
  }
  $db = mi_db();
  if (!$force && $maxAgeMs > 0) {
    $c = $db->prepare('SELECT seq, doc_json, fetched_ms FROM disc_cache WHERE domain = ?');
    $c->execute([$domain]);
    $row = mi_row($c);
    if ($row && txlab_now_ms() - (int) $row['fetched_ms'] <= $maxAgeMs) {
      list($ok, $why) = mi_validate_manifest($cfg, $issuer, json_decode($row['doc_json'], true));
      if ($ok !== null) return array_merge($res, $ok, ['ok' => true, 'status' => 'verified', 'reason' => null, 'fetchedAtMs' => (int) $row['fetched_ms'], 'cached' => true]);
    }
  }
  $url = isset($cfg['overrides'][$domain]) ? $cfg['overrides'][$domain] : mi_manifest_url($domain);
  $r = mi_http($cfg, 'GET', $url, null, 5);
  if ($r['status'] === 0) { $res['status'] = 'unreachable'; $res['reason'] = $r['error']; return $res; }
  if ($r['status'] >= 300 && $r['status'] < 400) { $res['status'] = 'refused'; $res['reason'] = 'the manifest URL redirected (' . $r['status'] . '); redirects are never followed'; return $res; }
  if ($r['status'] !== 200 || !is_array($r['body'])) { $res['status'] = 'unreachable'; $res['reason'] = 'the manifest could not be read (' . $r['error'] . ')'; return $res; }
  list($ok, $why) = mi_validate_manifest($cfg, $issuer, $r['body']);
  if ($ok === null) { $res['status'] = 'rejected'; $res['reason'] = $why; return $res; }
  // rollback protection: never accept an older manifest than one already seen
  $row = $db->prepare('SELECT seq FROM disc_cache WHERE domain = ?');
  $row->execute([$domain]);
  $seen = mi_col($row);
  if ($seen !== false && (int) $seen > $ok['seq']) { $res['status'] = 'rejected'; $res['reason'] = 'rollback: manifest sequence ' . $ok['seq'] . ' is older than ' . $seen . ' already seen'; return $res; }
  $db->prepare('INSERT OR REPLACE INTO disc_cache (domain, seq, doc_json, fetched_ms) VALUES (?, ?, ?, ?)')->execute([$domain, $ok['seq'], json_encode($r['body']), txlab_now_ms()]);
  $res = array_merge($res, $ok, ['ok' => true, 'status' => 'verified', 'reason' => null, 'fetchedAtMs' => txlab_now_ms()]);
  $memo[$mk] = ['at' => txlab_now_ms(), 'res' => $res];
  return $res;
}

function mi_service_url($cfg, $issuer, $cap) {
  if (!in_array($cap, $issuer['capabilities'], true)) mi_fail(400, $issuer['domain'] . ' does not declare ' . $cap . ' in this asset');
  $d = mi_discover($cfg, $issuer);
  if (!$d['ok']) mi_fail(502, 'cannot discover ' . $issuer['domain'] . ': ' . $d['reason'], ['state' => 'discovery-failed']);
  if (!isset($d['services'][$cap])) mi_fail(502, $issuer['domain'] . ' does not currently advertise ' . $cap, ['state' => 'discovery-failed']);
  return $d['services'][$cap];
}

// ---------------------------------------------------------------- signed peer requests

function mi_peer_shape_ok($r) {
  return mi_keys_exact($r, ['digest', 'nonce', 'op', 'ref', 'requestedAtMs', 'requester', 'target', 'v'])
    && $r['v'] === MI_PEER_REQUEST_VERSION && is_string($r['op']) && mi_is_uuid($r['ref']) && is_string($r['digest']) && preg_match('/^[0-9a-f]{64}$/', $r['digest'])
    && is_string($r['nonce']) && preg_match('/^[0-9a-f]{32}$/', $r['nonce']) && is_int($r['requestedAtMs']) && mi_domain_ok($r['requester']) && mi_domain_ok($r['target']);
}

function mi_make_peer_request($cfg, $op, $ref, $target, $digest) {
  $req = ['v' => MI_PEER_REQUEST_VERSION, 'op' => $op, 'ref' => $ref, 'digest' => $digest, 'requester' => $cfg['domain'], 'target' => $target, 'requestedAtMs' => txlab_now_ms(), 'nonce' => bin2hex(random_bytes(16))];
  return ['request' => $req, 'signature' => mi_sign_obj($cfg, $req)];
}

// Authenticates a peer request: addressed to this domain, from a roster domain, signed by the key pinned
// here, fresh, and never seen before.
function mi_verify_peer_request($cfg, $req, $sig, $allowedOps) {
  if (!mi_peer_shape_ok($req) || !is_string($sig) || $sig === '') mi_fail(400, 'malformed peer request');
  if ($req['target'] !== $cfg['domain']) mi_fail(403, 'the request is addressed to a different domain');
  if (!isset($cfg['roster'][$req['requester']]) || $req['requester'] === $cfg['domain']) mi_fail(403, 'the requester is not a peer in this domain\'s roster');
  if (!in_array($req['op'], $allowedOps, true)) mi_fail(403, 'this operation is not available on this endpoint');
  if (!txlab_verify_with_pinned_key($cfg, $req['requester'], canonicalize($req), $sig)) mi_fail(401, 'the request is not signed by ' . $req['requester'] . '\'s pinned key');
  if (abs(txlab_now_ms() - $req['requestedAtMs']) > MI_PEER_SKEW_MS) mi_fail(400, 'the request is stale');
  mi_in_txn(function ($db) use ($req) {
    $now = txlab_now_ms();
    $db->prepare('DELETE FROM seen_requests WHERE ts_ms < ?')->execute([$now - 600000]);
    $d = hash('sha256', canonicalize($req));
    $ex = $db->prepare('SELECT 1 FROM seen_requests WHERE digest = ?');
    $ex->execute([$d]);
    if (mi_col($ex)) mi_fail(409, 'replayed request');
    $db->prepare('INSERT INTO seen_requests (digest, ts_ms) VALUES (?, ?)')->execute([$d, $now]);
  });
  return $req;
}

// Bounded number of outstanding peer exchanges per domain: a burst can never occupy every worker.
function mi_inflight_enter($cfg) {
  $max = $cfg['public'] !== null ? $cfg['public']['maxInflightPeer'] : 4;
  return mi_in_txn(function ($db) use ($max) {
    $now = txlab_now_ms();
    $db->prepare('DELETE FROM inflight WHERE ts_ms < ?')->execute([$now - 30000]);
    if ((int) mi_col($db->query('SELECT COUNT(*) FROM inflight')) >= $max) mi_fail(503, 'too many peer exchanges in flight; retry shortly', ['state' => 'busy']);
    $db->prepare('INSERT INTO inflight (ts_ms) VALUES (?)')->execute([$now]);
    return (int) $db->lastInsertId();
  });
}

function mi_inflight_leave($id) {
  try { mi_db()->prepare('DELETE FROM inflight WHERE id = ?')->execute([$id]); } catch (Exception $e) { /* expires on its own */ }
}
