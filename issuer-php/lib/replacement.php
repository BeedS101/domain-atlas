<?php
// Safe retry and issuer-side holdings for fungible replacement. Mirrors the
// "replacement results" and "holdings index" sections of
// issuer-server/server.js.
//
// Replacement results: a split, consolidate, convert or fungible issue is
// "check, sign the successors, revoke the predecessors, respond". If the
// response is lost the wallet is left with predecessors that are now revoked
// and successors that exist nowhere. A request that carries a client-chosen
// `requestId` has its finished result stored here (lib/replay/, which is not
// web-reachable, keyed by a hash of the id) for the replay TTL, so repeating
// the identical request returns the same signed credentials instead of
// "asset already revoked". The same id with a different request is refused
// (409). The stored credentials are bearer credentials, so a replay also needs
// the matching predecessors, signed by this issuer.
//
// Holdings index: for every class that carries a `holdingCap`, the
// credentials this issuer signs are recorded per owner key as they are signed
// (issue_asset), and the holdings used for the cap are those records that are
// not revoked. The cap therefore does not depend on which balances a wallet
// presents. It is an index over credentials the issuer signed, not a ledger:
// the signed credentials and the revocation list stay the source of truth, and
// a credential signed before the index existed is counted only once a wallet
// presents it. The limit is per owner key; keys are free to create, so it
// bounds one key, not one person.
//
// Lock order, to keep concurrent requests from waiting on each other: spend
// locks (store.php), then the request-id lock, then the owner's holdings lock.

const ATLAS_HOLDINGS_PRUNE_AT = 100;

function atlas_replay_ttl_seconds() {
  $hours = getenv('ATLAS_REPLAY_TTL_HOURS');
  return (is_numeric($hours) && $hours > 0 ? (float) $hours : 168.0) * 3600;
}

// null when absent; throws a 400 for a malformed id.
function atlas_parse_request_id($body) {
  if (!is_array($body) || !array_key_exists('requestId', $body) || $body['requestId'] === null) return null;
  $id = $body['requestId'];
  if (!is_string($id) || !preg_match('/^[A-Za-z0-9_-]{16,80}$/', $id)) {
    throw new Exception('requestId must be 16 to 80 characters of letters, digits, - and _', 400);
  }
  return $id;
}

function atlas_replay_dir() { return __DIR__ . '/replay'; }
function atlas_replay_file($requestId) { return atlas_replay_dir() . '/' . hash('sha256', $requestId) . '.json'; }

// ['responseJson' => string] for a stored identical request, ['conflict' => true]
// when the id was used for a different one, null when nothing is stored.
function atlas_replay_lookup($requestId, $op, $predecessorIds, $params) {
  $file = atlas_replay_file($requestId);
  if (!is_file($file)) return null;
  $rec = json_decode((string) @file_get_contents($file), true);
  if (!is_array($rec) || !isset($rec['createdAt'], $rec['responseJson'])) return null;
  if (time() - (int) strtotime($rec['createdAt']) > atlas_replay_ttl_seconds()) return null;
  $ids = array_values($predecessorIds);
  sort($ids);
  $same = ($rec['op'] ?? null) === $op
    && json_encode($rec['predecessors'] ?? null) === json_encode($ids)
    && json_encode($rec['params'] ?? null) === json_encode($params);
  return $same ? ['responseJson' => $rec['responseJson']] : ['conflict' => true];
}

// $responseJson is the exact text sent to the client, so a replay is
// byte-identical to the original answer.
function atlas_replay_store($requestId, $op, $predecessorIds, $params, $responseJson) {
  try {
    @mkdir(atlas_replay_dir(), 0755, true);
    $ids = array_values($predecessorIds);
    sort($ids);
    $text = json_encode([
      'op' => $op, 'predecessors' => $ids, 'params' => $params,
      'createdAt' => gmdate('Y-m-d\TH:i:s\Z'), 'responseJson' => $responseJson,
    ], JSON_UNESCAPED_SLASHES);
    if ($text === false) throw new Exception('could not encode the replay record');
    atlas_write_file_atomic(atlas_replay_file($requestId), $text);
    if (mt_rand(1, 50) === 1) atlas_replay_prune();
  } catch (Exception $e) {
    // The operation has already happened; a missing record only costs the
    // ability to retry it.
    error_log('atlas: could not store the replay record: ' . $e->getMessage());
  }
}

function atlas_replay_prune() {
  $removed = 0;
  foreach ((array) @scandir(atlas_replay_dir()) as $name) {
    if (substr($name, -5) !== '.json' || $removed >= 500) continue;
    $file = atlas_replay_dir() . '/' . $name;
    if (time() - (int) @filemtime($file) > atlas_replay_ttl_seconds()) { @unlink($file); $removed++; }
  }
}

// ---------- named locks held for the rest of the request ----------
// Striped lock files (64 per kind), held until the script ends. A request that
// already holds a stripe is not made to wait on itself.

function &atlas_lease_registry() {
  static $held = [];
  return $held;
}

function atlas_lease_stripe_name($kind, $key) {
  return $kind . (abs(crc32($kind . ':' . $key)) % 64);
}

function atlas_lease_held($kind, $key) {
  $registry = &atlas_lease_registry();
  return isset($registry[atlas_lease_stripe_name($kind, $key)]);
}

// null on success (or when already held), otherwise a message.
function atlas_lease($kind, $key, $waitSeconds = 15) {
  $registry = &atlas_lease_registry();
  $name = atlas_lease_stripe_name($kind, $key);
  if (isset($registry[$name])) return null;
  $fh = fopen(__DIR__ . '/atlas-' . $kind . '-lock-' . substr($name, strlen($kind)) . '.lock', 'c');
  if ($fh === false) return 'could not take the ' . $kind . ' lock';
  $deadline = microtime(true) + $waitSeconds;
  while (!flock($fh, LOCK_EX | LOCK_NB)) {
    if (microtime(true) > $deadline) {
      fclose($fh);
      return 'this request is being processed by another request right now - try again';
    }
    usleep(2000);
  }
  $registry[$name] = $fh;
  return null;
}

// Held for the rest of this request. Returns an error message when it could
// not be had.
function atlas_request_lease($requestId) {
  return atlas_lease('rid', $requestId);
}

// Held for the whole check-and-mint of a capped issue, so two concurrent mints
// for one owner cannot both pass on the same count.
function atlas_owner_lease($ownerPublicKey) {
  return atlas_lease('holdings', $ownerPublicKey);
}

// ---------- holdings index ----------

function atlas_holdings_dir() { return __DIR__ . '/holdings'; }
function atlas_holdings_file($owner) {
  return atlas_holdings_dir() . '/' . substr(hash('sha256', (string) $owner), 0, 40) . '.json';
}

function atlas_holdings_unavailable($reason) {
  return new Exception('the holdings index ' . $reason . '; refusing to guess a balance', 503);
}

function atlas_holdings_read($owner) {
  $file = atlas_holdings_file($owner);
  if (!file_exists($file)) return ['held' => []];
  $text = @file_get_contents($file);
  if ($text === false) throw atlas_holdings_unavailable('could not be read');
  $doc = json_decode($text, true);
  if (!is_array($doc) || !isset($doc['held']) || !is_array($doc['held'])) throw atlas_holdings_unavailable('for this owner is unreadable');
  return $doc;
}

function atlas_holdings_write($owner, $doc) {
  @mkdir(atlas_holdings_dir(), 0755, true);
  $held = [];
  foreach ($doc['held'] as $cls => $list) $held[$cls] = array_values($list);
  $text = json_encode(['owner' => $owner, 'held' => (object) $held], JSON_UNESCAPED_SLASHES);
  if ($text === false) throw new Exception('could not encode the holdings index', 503);
  atlas_write_file_atomic(atlas_holdings_file($owner), $text);
}

// Runs a short read-modify-write on one owner's holdings, under that owner's
// lock unless this request already holds it.
function atlas_holdings_modify($owner, $fn) {
  $held = atlas_lease_held('holdings', $owner);
  $fh = null;
  if (!$held) {
    $stripe = abs(crc32('holdings:' . $owner)) % 64;
    $fh = fopen(__DIR__ . '/atlas-holdings-lock-' . $stripe . '.lock', 'c');
    if ($fh === false) throw new Exception('could not take the holdings lock', 503);
    $deadline = microtime(true) + 15;
    while (!flock($fh, LOCK_EX | LOCK_NB)) {
      if (microtime(true) > $deadline) { fclose($fh); throw new Exception('this owner is being updated by another request - try again', 503); }
      usleep(2000);
    }
  }
  try {
    $doc = atlas_holdings_read($owner);
    $fn($doc);
    atlas_holdings_write($owner, $doc);
  } finally {
    if ($fh !== null) { flock($fh, LOCK_UN); fclose($fh); }
  }
}

function atlas_revoked_id_set() {
  $set = [];
  foreach (read_revocations()['revoked'] as $r) if (is_array($r) && isset($r['id'])) $set[$r['id']] = true;
  return $set;
}

function atlas_holdings_register($owner, $cls, $entries) {
  atlas_holdings_modify($owner, function (&$doc) use ($cls, $entries) {
    $list = isset($doc['held'][$cls]) && is_array($doc['held'][$cls]) ? $doc['held'][$cls] : [];
    $have = [];
    foreach ($list as $h) $have[$h['id']] = true;
    foreach ($entries as $e) {
      if (!isset($have[$e['id']])) { $list[] = ['id' => $e['id'], 'q' => $e['q']]; $have[$e['id']] = true; }
    }
    if (count($list) > ATLAS_HOLDINGS_PRUNE_AT) {
      $revoked = atlas_revoked_id_set();
      $list = array_values(array_filter($list, function ($h) use ($revoked) { return !isset($revoked[$h['id']]); }));
    }
    $doc['held'][$cls] = $list;
  });
}

function atlas_holdings_unregister($owner, $ids) {
  try {
    atlas_holdings_modify($owner, function (&$doc) use ($ids) {
      $drop = array_flip($ids);
      foreach ($doc['held'] as $cls => $list) {
        $doc['held'][$cls] = array_values(array_filter($list, function ($h) use ($drop) { return !isset($drop[$h['id']]); }));
      }
    });
  } catch (Exception $e) {
    error_log('atlas: could not roll back holdings records: ' . $e->getMessage());
  }
}

// Records a freshly signed credential when its class is capped.
function atlas_holdings_note_issued($owner, $asset, $id, $quantity) {
  if (!is_array($asset) || ($asset['fungible'] ?? null) !== true) return;
  $cls = $asset['class'] ?? null;
  if (!is_string($cls) || !isset(ATLAS_ASSET_CATALOG[$cls]) || !isset(ATLAS_ASSET_CATALOG[$cls]['holdingCap'])) return;
  atlas_holdings_register($owner, $cls, [['id' => $id, 'q' => $quantity]]);
}

// Holdings used for a `holdingCap` check on a fresh mint: the issuer's own
// index of what it signed for this owner and class that is not revoked, plus
// any presented credential that checks out and is not in the index yet. A
// presented credential can only add to the total, never lower it, and is
// verified without the spend lock, so a credential that is busy or that the
// wallet leaves out cannot make the count smaller. Credentials from another
// domain never count. Returns [held, adopt].
function atlas_assess_holdings($publicKeyB64url, $owner, $cls, $presentedBalances) {
  $revoked = atlas_revoked_id_set();
  $doc = atlas_holdings_read($owner);
  $held = 0;
  $known = [];
  foreach (isset($doc['held'][$cls]) && is_array($doc['held'][$cls]) ? $doc['held'][$cls] : [] as $h) {
    if (isset($revoked[$h['id']])) continue;
    $held += $h['q'];
    $known[$h['id']] = true;
  }
  $adopt = [];
  $presented = is_array($presentedBalances) ? array_slice($presentedBalances, 0, 1000) : [];
  foreach ($presented as $cred) {
    if (!is_array($cred) || !isset($cred['id']) || !is_string($cred['id']) || isset($known[$cred['id']])) continue;
    if (($cred['issuer']['domain'] ?? null) !== atlas_domain()) continue;
    if (check_presented_asset($publicKeyB64url, $cred, $owner, $cls, 1, false) !== null) continue;
    $known[$cred['id']] = true;
    $held += $cred['quantity'];
    $adopt[] = ['id' => $cred['id'], 'q' => $cred['quantity']];
  }
  return [$held, $adopt];
}

// The 400 body for a presented credential that failed a check: `code` and
// `credentialId` let a wallet drop one spent balance and retry the rest.
function atlas_spend_problem_body($problem, $credential) {
  $code = $problem === 'asset already revoked' ? 'revoked'
    : (strpos($problem, 'being used by another request') !== false ? 'busy' : 'invalid');
  return ['error' => $problem, 'code' => $code, 'credentialId' => is_array($credential) && isset($credential['id']) ? $credential['id'] : null];
}

// Start of a split, consolidate or convert: takes the spend locks for every
// predecessor in one fixed order, so two requests naming the same balances
// cannot wait on each other, then answers a repeated request id from the
// stored result (after checking the presented balances are genuinely this
// issuer's). Ends the request itself when it has an answer.
function atlas_begin_replacement($publicKeyB64url, $requestId, $op, $presented, $params) {
  $ids = array_map(function ($c) { return is_array($c) ? ($c['id'] ?? null) : null; }, $presented);
  // Stripes in ascending order: two ids can share a lock file, so the order
  // that matters is the order of the files.
  $stripes = [];
  foreach ($ids as $id) if (is_string($id) && $id !== '') $stripes[abs(crc32($id)) % 64][] = $id;
  ksort($stripes);
  foreach ($stripes as $stripeIds) {
    $busy = atlas_spend_lock($stripeIds[0]);
    if ($busy !== null) send_json(400, ['error' => $busy, 'code' => 'busy', 'credentialId' => $stripeIds[0]]);
  }
  if ($requestId === null) return;
  $busy = atlas_request_lease($requestId);
  if ($busy !== null) send_json(503, ['error' => 'this request is already being processed - try again', 'code' => 'busy']);
  $prior = atlas_replay_lookup($requestId, $op, $ids, $params);
  if ($prior === null) return;
  if (isset($prior['conflict'])) send_json(409, ['error' => 'requestId was already used for a different request', 'code' => 'request-id-conflict']);
  foreach ($presented as $c) {
    $ok = is_array($c) && ($c['credential'] ?? null) === 'domain-atlas-asset/1.0'
      && verify_own_credential_signature($publicKeyB64url, $c, asset_payload_of($c));
    if (!$ok) send_json(400, atlas_spend_problem_body('asset signature does not check out', $c));
  }
  http_response_code(200);
  header('Content-Type: application/json');
  cors_headers();
  no_store_headers();
  echo $prior['responseJson'];
  exit;
}

// Sends a successful result and, when the request carried an id, stores the
// exact text first so a retry returns the same bytes.
function atlas_send_replaceable($requestId, $op, $predecessorIds, $params, $response) {
  $json = json_encode($response, JSON_UNESCAPED_SLASHES);
  if ($requestId !== null && $json !== false) atlas_replay_store($requestId, $op, $predecessorIds, $params, $json);
  send_json(200, $response);
}

// Undoes the holdings records of successors that were signed but never
// delivered because the replacement did not complete.
function atlas_rollback_minted($minted) {
  foreach ($minted as $m) atlas_holdings_unregister($m[0], [$m[1]]);
}
