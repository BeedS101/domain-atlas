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

// ---------- where replay records, holdings and the journal live ----------
// They hold signed bearer credentials (the replay store and the journal) and a
// record of what each owner holds, so they are private. By default they sit in
// lib/ next to the issuer key, behind lib/.htaccess. A host that serves lib/
// without honouring .htaccess would expose them, so two further protections
// apply: each directory gets its own deny-all .htaccess when this code creates
// it (written by PHP, so it cannot be skipped by an upload tool that leaves
// dot-files out), and the three directories can be moved outside the document
// root altogether by putting an absolute path in lib/atlas-private-dir.txt (or
// the ATLAS_PRIVATE_DIR environment variable). Directories are created 0700
// and the files in them 0600. A configured path that is relative, missing or
// not writable is an error (503); the code never falls back to lib/, because
// that would split one store across two places. Choose the location before
// first use and do not change it afterwards.

const ATLAS_PRIVATE_DENY = "# Private state: never served over HTTP.\n<IfModule mod_authz_core.c>\n  Require all denied\n</IfModule>\n<IfModule !mod_authz_core.c>\n  Order deny,allow\n  Deny from all\n</IfModule>\n";

// lib/ holds the issuer key and every state file, and is protected by its own
// .htaccess. An upload tool that leaves dot-files out would leave it unprotected,
// so the first request after such an upload writes the file back. This does not
// help on a server that ignores .htaccess; tools/gen1-php-smoke.js checks that
// over HTTP.
function atlas_ensure_lib_guard() {
  $guard = __DIR__ . '/.htaccess';
  if (!is_file($guard) && @file_put_contents($guard, ATLAS_PRIVATE_DENY) === false) {
    error_log('atlas: lib/.htaccess is missing and could not be written; lib/ may be served');
  }
}

function atlas_private_base() {
  static $base = null;
  if ($base !== null) return $base;
  $configured = getenv('ATLAS_PRIVATE_DIR');
  if (!is_string($configured) || $configured === '') {
    $file = __DIR__ . '/atlas-private-dir.txt';
    $configured = is_file($file) ? trim((string) @file_get_contents($file)) : '';
  }
  $base = rtrim($configured, '/\\');
  return $base;
}

function atlas_private_subdir($name) {
  $base = atlas_private_base();
  return ($base === '' ? __DIR__ : $base) . '/' . $name;
}

// True when $dir resolves to somewhere under the web root.
function atlas_path_in_docroot($dir) {
  $real = realpath($dir);
  $root = realpath(atlas_docroot());
  if ($real === false || $root === false) return true;
  return strpos($real . DIRECTORY_SEPARATOR, $root . DIRECTORY_SEPARATOR) === 0;
}

// Creates (if needed) and checks one private directory. Throws a 503 when it
// cannot be used.
function atlas_private_subdir_ensure($name) {
  $base = atlas_private_base();
  if ($base !== '') {
    if (!preg_match('#^(/|[A-Za-z]:[\\\\/])#', $base)) {
      throw new Exception('the private state directory in atlas-private-dir.txt must be an absolute path', 503);
    }
    if (!is_dir($base) || !is_writable($base)) {
      throw new Exception('the private state directory in atlas-private-dir.txt does not exist or is not writable', 503);
    }
  }
  $dir = atlas_private_subdir($name);
  if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
    throw new Exception('could not create the private ' . $name . ' directory', 503);
  }
  if (!is_writable($dir)) {
    throw new Exception('the private ' . $name . ' directory is not writable', 503);
  }
  if (atlas_path_in_docroot($dir)) {
    $guard = $dir . '/.htaccess';
    if (!is_file($guard) && @file_put_contents($guard, ATLAS_PRIVATE_DENY) === false) {
      error_log('atlas: could not write ' . $guard . '; this directory relies on lib/.htaccess alone');
    }
  }
  return $dir;
}

function atlas_replay_dir() { return atlas_private_subdir('replay'); }
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
    atlas_private_subdir_ensure('replay');
    $ids = array_values($predecessorIds);
    sort($ids);
    $text = json_encode([
      'op' => $op, 'predecessors' => $ids, 'params' => $params,
      'createdAt' => gmdate('Y-m-d\TH:i:s\Z'), 'responseJson' => $responseJson,
    ], JSON_UNESCAPED_SLASHES);
    if ($text === false) throw new Exception('could not encode the replay record');
    atlas_write_file_atomic(atlas_replay_file($requestId), $text, 0600);
    if (mt_rand(1, 50) === 1) atlas_replay_prune();
    return true;
  } catch (Exception $e) {
    // The operation has already happened; a missing record only costs the
    // ability to retry it, which is why the transaction journal keeps its
    // entry until this has been stored.
    error_log('atlas: could not store the replay record: ' . $e->getMessage());
    return false;
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

// Releases a lease early. Only for a lease this code took itself and the
// request did not already hold (see atlas_txn_sweep).
function atlas_lease_release($kind, $key) {
  $registry = &atlas_lease_registry();
  $name = atlas_lease_stripe_name($kind, $key);
  if (!isset($registry[$name])) return;
  flock($registry[$name], LOCK_UN);
  fclose($registry[$name]);
  unset($registry[$name]);
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

function atlas_holdings_dir() { return atlas_private_subdir('holdings'); }
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
  atlas_private_subdir_ensure('holdings');
  $held = [];
  foreach ($doc['held'] as $cls => $list) $held[$cls] = array_values($list);
  $text = json_encode(['owner' => $owner, 'held' => (object) $held], JSON_UNESCAPED_SLASHES);
  if ($text === false) throw new Exception('could not encode the holdings index', 503);
  atlas_write_file_atomic(atlas_holdings_file($owner), $text, 0600);
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

// Kept for issue.php files from before the holdings index. A partly uploaded
// bundle (new lib/, old endpoint) keeps minting; the current issue.php does not
// call it. Sums only the presented credentials that verify, as it always did.
function current_held_quantity($publicKeyB64url, $ownerPublicKey, $cls, $presentedBalances) {
  $total = 0;
  foreach ((is_array($presentedBalances) ? $presentedBalances : []) as $cred) {
    if (check_presented_asset($publicKeyB64url, $cred, $ownerPublicKey, $cls, 1) === null) $total += $cred['quantity'];
  }
  return $total;
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
  atlas_txn_sweep();
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
  atlas_txn_recover_key($requestId);
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

// ---------- transaction journal (crash recovery for replacements) ----------
// Mirrors the "transaction journal" section of issuer-server/server.js; read
// its comment for the design. In short: a replacement (split, consolidate,
// convert) or a fungible issue writes the whole decided result (the signed
// successors, the predecessor ids and the exact response text) to a private
// journal entry (lib/txn/) BEFORE anything is spent, in this order:
//
//   sign the successors (nothing recorded yet)        txn:minted
//   write the journal entry (atomic file replace)     txn:journal-written
//   record the successors in the holdings index       txn:holdings-registered
//   revoke every predecessor in ONE atomic replace of
//   the revocation list, entries tagged with the txn  txn:revoke-tmp-written, txn:revoked
//   store the replay result, remove the journal       txn:replay-stored, txn:journal-removed
//
// The atomic replace is the commit point. Recovery (a retry naming the same
// requestId, or the opportunistic sweep at the start of any replacement or
// fungible issue) decides from the revocation list alone: every predecessor
// tagged with this txn means the spend committed, so the holdings record and
// the replay result are completed and a retry gets the same signed result;
// none tagged means it did not commit, so the successors' holdings records are
// dropped and the entry removed. A fungible issue has no predecessors and is
// completed once its entry exists. A half-tagged set cannot come from one
// atomic replace and is reported (503), not guessed at.
//
// PHP shared hosting has no start-up hook, so recovery piggybacks on requests;
// an entry nobody asks about is finished by the next replacement or issue
// request. The crash tests stop the request at each step with exit(); they do
// not test power loss.

function atlas_new_txn_id() { return substr(bin2hex(random_bytes(8)), 0, 16); }
function atlas_txn_dir() { return atlas_private_subdir('txn'); }
function atlas_txn_file($key) { return atlas_txn_dir() . '/' . hash('sha256', $key) . '.json'; }

function atlas_txn_write($rec) {
  atlas_private_subdir_ensure('txn');
  $text = json_encode($rec, JSON_UNESCAPED_SLASHES);
  if ($text === false) throw new Exception('could not encode the transaction journal entry', 503);
  atlas_write_file_atomic(atlas_txn_file($rec['key']), $text, 0600);
}

function atlas_txn_remove($rec) {
  $file = atlas_txn_file($rec['key']);
  if (is_file($file) && !@unlink($file) && is_file($file)) throw new Exception('could not remove a finished transaction journal entry', 503);
}

// null when there is none; 503 when it exists and cannot be trusted.
function atlas_txn_read($key) {
  $file = atlas_txn_file($key);
  if (!is_file($file)) return null;
  $text = @file_get_contents($file);
  if ($text === false) throw new Exception('a pending transaction could not be read', 503);
  $rec = json_decode($text, true);
  if (!is_array($rec) || !isset($rec['txn'], $rec['key'], $rec['predecessors'], $rec['successors'], $rec['responseJson'])) {
    throw new Exception('a pending transaction is unreadable; it must be examined, not guessed at', 503);
  }
  return $rec;
}

function atlas_txn_state($rec) {
  if (!$rec['predecessors']) return 'committed';
  $tagged = [];
  foreach (read_revocations()['revoked'] as $r) {
    if (is_array($r) && isset($r['txn'], $r['id']) && $r['txn'] === $rec['txn']) $tagged[$r['id']] = true;
  }
  $n = 0;
  foreach ($rec['predecessors'] as $id) if (isset($tagged[$id])) $n++;
  if ($n === count($rec['predecessors'])) return 'committed';
  return $n === 0 ? 'aborted' : 'inconsistent';
}

function atlas_txn_register($rec) {
  foreach ($rec['successors'] as $s) {
    atlas_holdings_note_issued($s['owner'], ['fungible' => true, 'class' => $s['cls']], $s['id'], $s['q']);
  }
}

// Completes a committed transaction. Every step is safe to repeat. The journal
// entry is removed only after the replay record is stored.
function atlas_txn_finish($rec) {
  atlas_txn_register($rec);
  $stored = !empty($rec['requestId'])
    ? atlas_replay_store($rec['requestId'], $rec['op'], $rec['predecessors'], $rec['params'], $rec['responseJson'])
    : true;
  atlas_fault_point('txn:replay-stored');
  if (!$stored) throw new Exception('the replay record could not be stored; the journal entry is kept', 503);
  atlas_txn_remove($rec);
  atlas_fault_point('txn:journal-removed');
}

function atlas_txn_abort($rec) {
  foreach ($rec['successors'] as $s) atlas_holdings_unregister($s['owner'], [$s['id']]);
  atlas_txn_remove($rec);
}

// 'committed' or 'aborted'; throws for an inconsistent entry (left in place).
function atlas_txn_recover($rec) {
  $state = atlas_txn_state($rec);
  if ($state === 'committed') { atlas_txn_finish($rec); return 'committed'; }
  if ($state === 'aborted') { atlas_txn_abort($rec); return 'aborted'; }
  throw new Exception('transaction ' . $rec['txn'] . ' is half-recorded in the revocation list; it must be examined, not guessed at', 503);
}

// For a request that holds the key's lease.
function atlas_txn_recover_key($key) {
  $rec = atlas_txn_read($key);
  return $rec === null ? null : atlas_txn_recover($rec);
}

// Recovers every entry whose lease nobody holds. Never waits for a lease and
// never fails the request that happens to run it.
function atlas_txn_sweep() {
  $resolved = 0;
  foreach ((array) @scandir(atlas_txn_dir()) as $name) {
    if (substr($name, -5) !== '.json') continue;
    $rec = json_decode((string) @file_get_contents(atlas_txn_dir() . '/' . $name), true);
    if (!is_array($rec) || !isset($rec['key']) || !is_string($rec['key'])) continue;
    $already = atlas_lease_held('rid', $rec['key']);
    if (!$already && atlas_lease('rid', $rec['key'], 0) !== null) continue;
    try {
      $again = atlas_txn_read($rec['key']);
      if ($again !== null) { atlas_txn_recover($again); $resolved++; }
    } catch (Exception $e) {
      error_log('atlas: transaction recovery: ' . $e->getMessage());
    } finally {
      if (!$already) atlas_lease_release('rid', $rec['key']);
    }
  }
  atlas_remove_stale_temp_files(dirname(atlas_revocations_file()));
  atlas_remove_stale_temp_files(atlas_txn_dir());
  atlas_remove_stale_temp_files(atlas_replay_dir());
  atlas_remove_stale_temp_files(atlas_holdings_dir());
  return $resolved;
}

// Runs the steps above for already-signed (not yet recorded) successors and
// returns the response text. `$successors` are the signed credentials;
// `$response` is what the client gets. The caller holds the lease for
// `$requestId`, or passes null and gets a lease here. A caller that already
// holds a lease on a transaction id of its own (taken before any owner lease,
// to keep the lock order: spend locks, request/transaction lease, owner lease)
// passes that id as `$txn`.
function atlas_commit_replacement($requestId, $op, $predecessorIds, $reason, $params, $successors, $response, $txn = null) {
  $ids = array_values($predecessorIds);
  $sorted = $ids;
  sort($sorted);
  $responseJson = json_encode($response, JSON_UNESCAPED_SLASHES);
  if ($responseJson === false) throw new Exception('could not encode the response', 503);
  $leaseHeldByCaller = $txn !== null;
  if ($txn === null) $txn = atlas_new_txn_id();
  $rec = [
    'txn' => $txn,
    'key' => $requestId !== null ? $requestId : $txn,
    'requestId' => $requestId,
    'op' => $op,
    'reason' => $reason,
    'params' => $params,
    'predecessors' => $sorted,
    'successors' => array_map(function ($c) {
      return ['owner' => $c['owner']['publicKey'], 'cls' => $c['asset']['class'], 'id' => $c['id'], 'q' => $c['quantity']];
    }, $successors),
    'responseJson' => $responseJson,
    'createdAt' => gmdate('Y-m-d\TH:i:s\Z'),
  ];
  if ($requestId === null && !$leaseHeldByCaller) {
    $busy = atlas_lease('rid', $rec['key']);
    if ($busy !== null) throw new Exception($busy, 503);
  }
  atlas_fault_point('txn:minted');
  atlas_txn_write($rec);
  atlas_fault_point('txn:journal-written');
  $committed = false;
  try {
    atlas_txn_register($rec);
    atlas_fault_point('txn:holdings-registered');
    if ($ids) atlas_revoke_many($ids, $reason, $txn);
    $committed = true;
    atlas_fault_point('txn:revoked');
  } catch (Exception $e) {
    if (!$committed) atlas_txn_abort($rec);
    throw $e;
  }
  try {
    atlas_txn_finish($rec);
  } catch (Exception $e) {
    // Committed; the entry stays and recovery finishes it. The client still gets its answer.
    error_log('atlas: transaction ' . $txn . ' is committed but not finished: ' . $e->getMessage());
  }
  return $responseJson;
}

// Sends the response text produced by atlas_commit_replacement().
function atlas_send_committed($responseJson) {
  http_response_code(200);
  header('Content-Type: application/json');
  cors_headers();
  no_store_headers();
  echo $responseJson;
  exit;
}
