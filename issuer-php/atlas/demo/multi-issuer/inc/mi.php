<?php
// Domain Atlas - Multi-Issuer Portable Asset Lab (test only, no real value).
//
// One portable asset is issued jointly by several independent domains. The asset itself carries
// its canonical definition, the complete issuer roster (domain, key id, public key, discovery
// reference), the issuance and transfer policies, the state authority, and every issuer's
// signature. Current endpoints are NOT part of the asset: each issuer publishes a signed
// discovery manifest at a fixed well-known path, so services can move without reissuing.
//
// This module reuses the Transaction Lab's primitives unchanged: canonical JSON and P-256 ECDSA
// (lib/crypto.php), the signed approval object, quorum evaluation (threshold + mandatory
// domains) and the lab error type. It has its own signing key, SQLite database, configuration
// and private directory, and never reads or writes issuer keys, stores, wallets or ledgers.
//
// Ownership state is held by one designated state authority; this is NOT atomic settlement
// across independent ledgers and NOT Byzantine fault tolerant consensus.
//
// Compatible with PHP 7.2+ (shared hosting): no arrow functions, match or typed properties.

require_once __DIR__ . '/../../txlab/inc/txlab.php';

const MI_ASSET_VERSION = 'domain-atlas-mi-asset/1';
const MI_PORTABLE_FORMAT = 'domain-atlas-mi-portable-asset/1';
const MI_TRANSFER_VERSION = 'domain-atlas-mi-transfer/1';
const MI_OWNER_AUTH_VERSION = 'domain-atlas-mi-owner-auth/1';
const MI_REGISTRATION_VERSION = 'domain-atlas-mi-registration/1';
const MI_TRANSITION_VERSION = 'domain-atlas-mi-transition/1';
const MI_STATE_VERSION = 'domain-atlas-mi-state/1';
const MI_PEER_REQUEST_VERSION = 'domain-atlas-mi-peer-request/1';
const MI_DISCOVERY_VERSION = 'domain-atlas-multi-issuer-discovery/1';
const MI_ENDORSEMENT_VERSION = 'domain-atlas-mi-key-endorsement/1';
const MI_WELL_KNOWN_PATH = '/.well-known/atlas-multi-issuer.json';
const MI_CAP_ISSUE = 'asset.issue.approve';
const MI_CAP_TRANSFER = 'asset.transfer.approve';
const MI_CAP_STATE = 'asset.state';
const MI_MAX_BODY = 16384;
const MI_MAX_IMPORT_BYTES = 65536;
const MI_PEER_SKEW_MS = 120000;

function mi_capabilities() { return [MI_CAP_ISSUE, MI_CAP_TRANSFER, MI_CAP_STATE]; }

// ---------------------------------------------------------------- small helpers

// Single-row reads close their cursor: an open read cursor would pin a stale snapshot and make a later write fail with SQLITE_BUSY.
function mi_row($st, $mode = PDO::FETCH_ASSOC) { $r = $st->fetch($mode); $st->closeCursor(); return $r; }
function mi_col($st) { $r = $st->fetchColumn(); $st->closeCursor(); return $r; }

function mi_fail($status, $message, $extra = []) { txlab_fail($status, $message, $extra); }

function mi_digest($value) { return hash('sha256', canonicalize($value)); }

function mi_uuid() { return atlas_txlab_uuid(); }

function mi_is_uuid($s) { return is_string($s) && preg_match('/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/', $s) === 1; }

function mi_domain_ok($d) {
  return is_string($d) && strlen($d) <= 253 && preg_match('/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/', $d) === 1 && strpos($d, '..') === false;
}

function mi_pubkey_ok($b64) {
  if (!is_string($b64) || !preg_match('/^[A-Za-z0-9_-]{87}$/', $b64)) return false;
  try {
    $raw = b64url_decode($b64);
    if (strlen($raw) !== 65 || $raw[0] !== "\x04") return false;
    return @openssl_pkey_get_public(ec_raw_point_to_pem($raw)) !== false;
  } catch (Exception $e) {
    return false;
  }
}

function mi_key_id($pubB64) { return substr(hash('sha256', b64url_decode($pubB64)), 0, 32); }

function mi_verify($pubB64, $data, $sigB64) {
  if (!mi_pubkey_ok($pubB64) || !is_string($sigB64) || $sigB64 === '' || strlen($sigB64) > 100) return false;
  try {
    return ecdsa_verify_raw(ec_raw_point_to_pem(b64url_decode($pubB64)), b64url_decode($sigB64), $data);
  } catch (Exception $e) {
    return false;
  }
}

function mi_verify_obj($pubB64, $obj, $sigB64) { return mi_verify($pubB64, canonicalize($obj), $sigB64); }

function mi_manifest_url($domain) { return 'https://' . $domain . MI_WELL_KNOWN_PATH; }

function mi_ascii_text($s, $max) { return is_string($s) && strlen($s) <= $max && preg_match('/^[A-Za-z0-9 .,:;()#\/_-]*$/', $s) === 1; }

// ---------------------------------------------------------------- private directory + config

function mi_private_dir() {
  $env = getenv('MI_PRIVATE_DIR');
  if ($env !== false && $env !== '') return rtrim($env, '/\\');
  $pointer = __DIR__ . '/private-dir.php';
  if (is_file($pointer)) {
    $v = include $pointer;
    if (is_string($v) && $v !== '') return rtrim($v, '/\\');
  }
  return null;
}

// name => [default, min, max]
function mi_public_defaults() {
  return [
    'sessionTtlSeconds' => [7200, 60, 86400],
    'issuanceWindowSeconds' => [600, 10, 3600],
    'transferTtlSeconds' => [300, 5, 1800],
    'maxAssetsPerSession' => [3, 1, 50],
    'maxTransfersPerSession' => [8, 1, 100],
    'maxPendingTransfersGlobal' => [40, 1, 1000],
    'maxSessions' => [100, 1, 5000],
    'sessionsPerIpPerHour' => [10, 1, 1000],
    'assetsPerIpPerHour' => [15, 1, 1000],
    'transfersPerIpPerHour' => [40, 1, 2000],
    'approvalsPerIpPerMinute' => [30, 1, 600],
    'callsPerIpPerMinute' => [120, 10, 10000],
    'peerRequestsPerHour' => [1500, 1, 100000],
    'maxInflightPeer' => [4, 1, 32],
  ];
}

function mi_public_config($raw, &$problems) {
  if (!is_array($raw) || !isset($raw['enabled']) || $raw['enabled'] !== true) return null;
  $out = [];
  $defs = mi_public_defaults();
  foreach ($defs as $k => $spec) {
    $v = array_key_exists($k, $raw) ? $raw[$k] : $spec[0];
    if (!is_int($v) || $v < $spec[1] || $v > $spec[2]) { $problems[] = 'publicDemo.' . $k . ' must be an integer between ' . $spec[1] . ' and ' . $spec[2]; continue; }
    $out[$k] = $v;
  }
  foreach (array_keys($raw) as $k) if ($k !== 'enabled' && !isset($defs[$k])) $problems[] = 'publicDemo has an unknown setting: ' . $k;
  return $out;
}

function mi_policy_config($raw, $name, $roster, $stateAuthority, &$problems) {
  $n = count($roster);
  $t = is_array($raw) && isset($raw['threshold']) ? $raw['threshold'] : null;
  $m = is_array($raw) && isset($raw['mandatory']) && is_array($raw['mandatory']) ? array_values($raw['mandatory']) : null;
  if (!is_int($t) || $t < 1 || $t > $n) $problems[] = $name . '.threshold must be an integer between 1 and the roster size';
  if ($m === null) { $problems[] = $name . '.mandatory must be a list of domains'; return null; }
  foreach ($m as $d) if (!is_string($d) || !isset($roster[$d])) $problems[] = $name . '.mandatory names a domain that is not in the roster';
  if (!in_array($stateAuthority, $m, true)) $problems[] = $name . '.mandatory must include the state authority (it owns the ownership state; no unrelated quorum may replace it)';
  $m = array_values(array_unique($m));
  sort($m);
  return ['threshold' => $t, 'mandatory' => $m];
}

// Returns [config|null, problems[]]. Any problem keeps the whole lab disabled (fail closed).
function mi_load_config() {
  static $cache = null;
  if ($cache !== null) return $cache;
  $problems = [];
  $dir = mi_private_dir();
  if ($dir === null) return $cache = [null, ['no private directory configured (set inc/private-dir.php)']];
  if (!is_dir($dir)) $problems[] = 'private directory does not exist';
  elseif (!is_writable($dir)) $problems[] = 'private directory is not writable';
  if (!empty($_SERVER['DOCUMENT_ROOT']) && is_dir($dir) && txlab_path_is_within($dir, $_SERVER['DOCUMENT_ROOT'])) $problems[] = 'private directory is inside the web root';
  if ($problems) return $cache = [null, $problems];
  if (is_file($dir . '/DISABLED')) return $cache = [null, ['disabled by the DISABLED file in the private directory']];
  $file = $dir . '/config.php';
  if (!is_file($file)) return $cache = [null, ['config.php missing in the private directory']];
  $c = include $file;
  if (!is_array($c)) return $cache = [null, ['config.php does not return an array']];
  if (empty($c['enabled'])) return $cache = [null, ['disabled in config.php (enabled is not true)']];

  $domain = isset($c['domain']) && is_string($c['domain']) ? $c['domain'] : '';
  $state = isset($c['stateAuthority']) && is_string($c['stateAuthority']) ? $c['stateAuthority'] : '';
  $rosterIn = isset($c['roster']) && is_array($c['roster']) ? $c['roster'] : [];
  $insecure = !empty($c['allowInsecureHttp']);
  $roster = [];
  if (count($rosterIn) < 1 || count($rosterIn) > 8) $problems[] = 'the roster must list between 1 and 8 domains';
  foreach ($rosterIn as $d => $e) {
    if (!mi_domain_ok($d) || !is_array($e) || !isset($e['publicKey']) || !mi_pubkey_ok($e['publicKey'])) { $problems[] = 'roster entry invalid: ' . (is_string($d) ? $d : '?'); continue; }
    $roster[$d] = ['publicKey' => $e['publicKey'], 'keyId' => mi_key_id($e['publicKey'])];
  }
  if (!isset($roster[$domain])) $problems[] = 'own domain is not in the roster';
  if (!isset($roster[$state])) $problems[] = 'the state authority is not in the roster';
  $issuance = mi_policy_config(isset($c['issuance']) ? $c['issuance'] : null, 'issuance', $roster, $state, $problems);
  $transfer = mi_policy_config(isset($c['transfer']) ? $c['transfer'] : null, 'transfer', $roster, $state, $problems);
  $classes = isset($c['assetClasses']) && is_array($c['assetClasses']) ? array_values($c['assetClasses']) : ['joint-explorer-certificate'];
  foreach ($classes as $cl) if (!is_string($cl) || !preg_match('/^[a-z0-9][a-z0-9.-]{0,39}$/', $cl)) $problems[] = 'assetClasses must be short lower-case names';
  $overrides = [];
  if (!empty($c['discoveryOverrides'])) {
    if (!$insecure || !is_array($c['discoveryOverrides'])) $problems[] = 'discoveryOverrides are for local tests only and need allowInsecureHttp';
    else foreach ($c['discoveryOverrides'] as $d => $u) {
      if (!is_string($d) || !is_string($u) || !txlab_is_loopback_url($u)) $problems[] = 'discoveryOverrides must map domains to loopback URLs';
      else $overrides[$d] = $u;
    }
  }
  $public = mi_public_config(isset($c['publicDemo']) ? $c['publicDemo'] : null, $problems);

  $keyFile = $dir . '/signing-key.pem';
  $priv = null;
  if (!is_file($keyFile)) {
    $problems[] = 'signing-key.pem missing in the private directory';
  } else {
    if (DIRECTORY_SEPARATOR === '/') {
      $perms = @fileperms($keyFile);
      if ($perms !== false && ($perms & 0077) !== 0) $problems[] = 'signing-key.pem is readable by other accounts (chmod 600)';
    }
    $priv = @openssl_pkey_get_private(file_get_contents($keyFile));
    if ($priv === false) { $problems[] = 'signing-key.pem is not a valid private key'; $priv = null; }
    else {
      $d = openssl_pkey_get_details($priv);
      if (!isset($d['ec']['curve_name']) || $d['ec']['curve_name'] !== 'prime256v1') $problems[] = 'signing key is not P-256';
      else {
        $raw = "\x04" . str_pad($d['ec']['x'], 32, "\x00", STR_PAD_LEFT) . str_pad($d['ec']['y'], 32, "\x00", STR_PAD_LEFT);
        if (isset($roster[$domain]) && b64url_encode($raw) !== $roster[$domain]['publicKey']) $problems[] = 'the signing key does not match this domain\'s public key in the roster';
      }
    }
  }
  foreach (['pdo_sqlite', 'openssl', 'curl'] as $ext) if (!extension_loaded($ext)) $problems[] = 'the ' . $ext . ' PHP extension is not available';
  try {
    if (canonicalize(['b' => 1, 'a' => ['z' => true, 'y' => 'x']]) !== '{"a":{"y":"x","z":true},"b":1}') $problems[] = 'canonical JSON self-test failed';
  } catch (Exception $e) { $problems[] = 'canonical JSON self-test failed'; }

  if ($problems) return $cache = [null, $problems];
  ksort($roster);
  $cfg = [
    'dir' => $dir, 'domain' => $domain, 'stateAuthority' => $state, 'isState' => $domain === $state,
    'roster' => $roster, 'rosterDomains' => array_keys($roster),
    'issuance' => $issuance, 'transfer' => $transfer, 'assetClasses' => $classes,
    'insecure' => $insecure, 'overrides' => $overrides, 'openDiscovery' => !empty($c['openDiscovery']),
    'public' => $public, 'privateKey' => $priv,
  ];
  return $cache = [$cfg, []];
}

function mi_require_config() {
  list($cfg, $problems) = mi_load_config();
  if ($cfg === null) mi_fail(503, 'the multi-issuer lab is disabled on this domain', ['enabled' => false, 'reasons' => $problems]);
  return $cfg;
}

function mi_require_public($stateOnly = true) {
  $cfg = mi_require_config();
  if ($cfg['public'] === null) mi_fail(403, 'the public demo is not enabled on this domain');
  if ($stateOnly && !$cfg['isState']) mi_fail(400, 'this operation belongs to the state authority (' . $cfg['stateAuthority'] . ')');
  return $cfg;
}

// The approver's own domain-separated signing helpers (same approval object as the Transaction Lab).
function mi_sign_obj($cfg, $obj) { return txlab_sign($cfg, canonicalize($obj)); }

function mi_make_approval($cfg, $refId, $digest, $decision) {
  return ['v' => TXLAB_APPROVAL_VERSION, 'txId' => $refId, 'payloadDigest' => $digest, 'approver' => $cfg['domain'], 'decision' => $decision, 'approvedAtMs' => txlab_now_ms()];
}

// ---------------------------------------------------------------- database

function mi_db() {
  static $db = null;
  if ($db !== null) return $db;
  $cfg = mi_require_config();
  $db = new PDO('sqlite:' . $cfg['dir'] . '/mi.sqlite');
  $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
  $db->exec('PRAGMA busy_timeout = 8000');
  $db->exec('PRAGMA foreign_keys = ON');
  try { $db->exec('PRAGMA journal_mode = WAL'); } catch (Exception $e) { /* some filesystems refuse WAL */ }
  $db->exec('PRAGMA synchronous = FULL');
  mi_migrate($db);
  return $db;
}

function mi_migrate($db) {
  $db->exec('BEGIN IMMEDIATE');
  try {
    $db->exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, token_hash TEXT NOT NULL, ip_hash TEXT NOT NULL, created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL, assets_made INTEGER NOT NULL DEFAULT 0, transfers_made INTEGER NOT NULL DEFAULT 0)');
    $db->exec('CREATE TABLE IF NOT EXISTS assets (
      asset_id TEXT PRIMARY KEY, session_sid TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
      definition_json TEXT NOT NULL, definition_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (\'pending\',\'issued\',\'expired\',\'rejected\')), fail_reason TEXT,
      created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL, issued_ms INTEGER)');
    $db->exec('CREATE TABLE IF NOT EXISTS issuance_approvals (
      asset_id TEXT NOT NULL REFERENCES assets(asset_id), approver TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN (\'approve\',\'reject\')), approval_json TEXT NOT NULL, signature TEXT NOT NULL, stored_ms INTEGER NOT NULL,
      PRIMARY KEY (asset_id, approver))');
    $db->exec('CREATE TABLE IF NOT EXISTS asset_state (
      asset_id TEXT PRIMARY KEY REFERENCES assets(asset_id), version INTEGER NOT NULL CHECK (version >= 0),
      owner_pub TEXT NOT NULL, state_digest TEXT NOT NULL, updated_ms INTEGER NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS transfers (
      tx_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(asset_id), session_sid TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL, digest TEXT NOT NULL, owner_auth_json TEXT NOT NULL, owner_signature TEXT NOT NULL, base_version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN (\'pending\',\'executed\',\'failed\',\'expired\',\'rejected\')), fail_reason TEXT,
      created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL, finished_ms INTEGER)');
    $db->exec('CREATE TABLE IF NOT EXISTS transfer_approvals (
      tx_id TEXT NOT NULL REFERENCES transfers(tx_id), approver TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN (\'approve\',\'reject\')), approval_json TEXT NOT NULL, signature TEXT NOT NULL, stored_ms INTEGER NOT NULL,
      PRIMARY KEY (tx_id, approver))');
    $db->exec('CREATE TABLE IF NOT EXISTS transitions (
      asset_id TEXT NOT NULL REFERENCES assets(asset_id), version INTEGER NOT NULL, tx_id TEXT, receipt_json TEXT NOT NULL, signature TEXT NOT NULL,
      PRIMARY KEY (asset_id, version))');
    // what THIS domain has signed (kept on every domain; the approver-side double-sign guard)
    $db->exec('CREATE TABLE IF NOT EXISTS signed_log (
      kind TEXT NOT NULL, ref_id TEXT NOT NULL, asset_id TEXT NOT NULL, base_version INTEGER, digest TEXT NOT NULL,
      decision TEXT NOT NULL, approval_json TEXT NOT NULL, signature TEXT NOT NULL, expires_ms INTEGER NOT NULL, signed_ms INTEGER NOT NULL,
      PRIMARY KEY (kind, ref_id))');
    $db->exec('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL, ref_id TEXT, kind TEXT NOT NULL, domain TEXT, detail TEXT NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS rate (bucket TEXT NOT NULL, who TEXT NOT NULL, ts_ms INTEGER NOT NULL)');
    $db->exec('CREATE INDEX IF NOT EXISTS rate_lookup ON rate (bucket, who, ts_ms)');
    $db->exec('CREATE TABLE IF NOT EXISTS seen_requests (digest TEXT PRIMARY KEY, ts_ms INTEGER NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS inflight (id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS disc_cache (domain TEXT PRIMARY KEY, seq INTEGER NOT NULL, doc_json TEXT NOT NULL, fetched_ms INTEGER NOT NULL)');
    // a signed definition and a stored transfer can never be edited; a finished state never changes again
    $db->exec('CREATE TRIGGER IF NOT EXISTS assets_immutable BEFORE UPDATE OF asset_id, session_sid, request_id, definition_json, definition_digest, created_ms, expires_ms ON assets BEGIN SELECT RAISE(ABORT, \'asset definition is immutable\'); END');
    $db->exec('CREATE TRIGGER IF NOT EXISTS assets_status_final BEFORE UPDATE OF status ON assets WHEN OLD.status <> \'pending\' BEGIN SELECT RAISE(ABORT, \'asset issuance is already final\'); END');
    $db->exec('CREATE TRIGGER IF NOT EXISTS transfers_immutable BEFORE UPDATE OF tx_id, asset_id, session_sid, request_id, payload_json, digest, owner_auth_json, owner_signature, base_version, created_ms, expires_ms ON transfers BEGIN SELECT RAISE(ABORT, \'transfer is immutable\'); END');
    $db->exec('CREATE TRIGGER IF NOT EXISTS transfers_status_final BEFORE UPDATE OF status ON transfers WHEN OLD.status <> \'pending\' BEGIN SELECT RAISE(ABORT, \'transfer is already final\'); END');
    $db->exec('CREATE TRIGGER IF NOT EXISTS issuance_approvals_immutable BEFORE UPDATE ON issuance_approvals BEGIN SELECT RAISE(ABORT, \'approvals are immutable\'); END');
    $db->exec('CREATE TRIGGER IF NOT EXISTS transfer_approvals_immutable BEFORE UPDATE ON transfer_approvals BEGIN SELECT RAISE(ABORT, \'approvals are immutable\'); END');
    $db->exec('CREATE TRIGGER IF NOT EXISTS transitions_immutable BEFORE UPDATE ON transitions BEGIN SELECT RAISE(ABORT, \'ownership evidence is immutable\'); END');
    $db->exec('CREATE TRIGGER IF NOT EXISTS signed_log_immutable BEFORE UPDATE ON signed_log BEGIN SELECT RAISE(ABORT, \'the signing log is immutable\'); END');
    // ownership moves forward exactly one version at a time and never changes identity
    $db->exec('CREATE TRIGGER IF NOT EXISTS state_step BEFORE UPDATE ON asset_state WHEN NEW.version <> OLD.version + 1 OR NEW.asset_id <> OLD.asset_id BEGIN SELECT RAISE(ABORT, \'ownership state must advance by exactly one version\'); END');
    // one approval per (asset, base version) on this domain: the signer never approves two competing transfers
    // one in-flight transfer per asset: competing transfers of the same ownership state cannot both be pending
    $db->exec('CREATE UNIQUE INDEX IF NOT EXISTS transfers_one_pending ON transfers (asset_id) WHERE status = \'pending\'');
    $db->exec('CREATE UNIQUE INDEX IF NOT EXISTS signed_one_transfer_per_base ON signed_log (asset_id, base_version) WHERE kind = \'transfer\' AND decision = \'approve\'');
    $db->exec('COMMIT');
  } catch (Exception $e) {
    try { $db->exec('ROLLBACK'); } catch (Exception $e2) { /* nothing open */ }
    throw $e;
  }
}

function mi_in_txn($fn) {
  $db = mi_db();
  $db->exec('BEGIN IMMEDIATE');
  try {
    $r = $fn($db);
    $db->exec('COMMIT');
    return $r;
  } catch (Exception $e) {
    try { $db->exec('ROLLBACK'); } catch (Exception $e2) { /* already closed */ }
    throw $e;
  }
}

function mi_event($db, $refId, $kind, $domain, $detail) {
  if ($refId !== null) {
    $n = $db->prepare('SELECT COUNT(*) FROM events WHERE ref_id = ?');
    $n->execute([$refId]);
    if ((int) mi_col($n) >= 300) return;
  }
  $db->prepare('INSERT INTO events (ts_ms, ref_id, kind, domain, detail) VALUES (?, ?, ?, ?, ?)')->execute([txlab_now_ms(), $refId, $kind, $domain, substr($detail, 0, 300)]);
}

// ---------------------------------------------------------------- the asset definition (signed by the issuers)

function mi_policy_block($pol, $roster) {
  return ['mandatory' => $pol['mandatory'], 'roster' => $roster, 'threshold' => $pol['threshold']];
}

function mi_build_definition($cfg, $ownerPub, $serial, $label, $class) {
  $issuers = [];
  foreach ($cfg['rosterDomains'] as $d) {
    $caps = [MI_CAP_ISSUE, MI_CAP_TRANSFER];
    if ($d === $cfg['stateAuthority']) $caps[] = MI_CAP_STATE;
    $issuers[] = [
      'domain' => $d, 'keyId' => $cfg['roster'][$d]['keyId'], 'publicKey' => $cfg['roster'][$d]['publicKey'],
      'discovery' => ['capabilities' => $caps, 'manifest' => mi_manifest_url($d)],
    ];
  }
  $meta = ['serial' => $serial, 'testOnly' => true];
  if ($label !== '') $meta['label'] = $label;
  return [
    'v' => MI_ASSET_VERSION,
    'assetId' => mi_uuid(),
    'class' => $class,
    'name' => 'Joint Explorer Certificate #' . $serial,
    'metadata' => $meta,
    'originalOwner' => ['keyId' => mi_key_id($ownerPub), 'publicKey' => $ownerPub],
    'issuers' => $issuers,
    'issuancePolicy' => mi_policy_block($cfg['issuance'], $cfg['rosterDomains']),
    'transferPolicy' => mi_policy_block($cfg['transfer'], $cfg['rosterDomains']),
    'stateAuthority' => ['domain' => $cfg['stateAuthority'], 'keyId' => $cfg['roster'][$cfg['stateAuthority']]['keyId'], 'capability' => MI_CAP_STATE],
    'createdAtMs' => txlab_now_ms(),
  ];
}

function mi_keys_exact($arr, $keys) {
  if (!is_array($arr)) return false;
  $have = array_keys($arr);
  sort($have);
  sort($keys);
  return $have === $keys;
}

function mi_policy_shape_ok($p) {
  if (!mi_keys_exact($p, ['mandatory', 'roster', 'threshold'])) return false;
  if (!is_int($p['threshold']) || !is_array($p['roster']) || !is_array($p['mandatory'])) return false;
  foreach (array_merge($p['roster'], $p['mandatory']) as $d) if (!mi_domain_ok($d)) return false;
  if (count($p['roster']) !== count(array_unique($p['roster'])) || count($p['mandatory']) !== count(array_unique($p['mandatory']))) return false;
  if ($p['threshold'] < 1 || $p['threshold'] > count($p['roster'])) return false;
  foreach ($p['mandatory'] as $d) if (!in_array($d, $p['roster'], true)) return false;
  return true;
}

// Structure and internal consistency only; whether THIS domain trusts the definition is a separate check.
function mi_definition_problem($d) {
  if (!mi_keys_exact($d, ['assetId', 'class', 'createdAtMs', 'issuancePolicy', 'issuers', 'metadata', 'name', 'originalOwner', 'stateAuthority', 'transferPolicy', 'v'])) return 'the asset definition has missing or unexpected fields';
  if ($d['v'] !== MI_ASSET_VERSION) return 'unknown asset definition version';
  if (!mi_is_uuid($d['assetId'])) return 'invalid asset id';
  if (!is_string($d['class']) || !preg_match('/^[a-z0-9][a-z0-9.-]{0,39}$/', $d['class'])) return 'invalid asset class';
  if (!mi_ascii_text($d['name'], 80) || $d['name'] === '') return 'invalid asset name';
  if (!is_int($d['createdAtMs'])) return 'invalid creation time';
  $m = $d['metadata'];
  if (!is_array($m) || !isset($m['serial']) || !preg_match('/^[0-9]{6}$/', (string) $m['serial']) || !isset($m['testOnly']) || $m['testOnly'] !== true) return 'the asset must be a test-only asset with a serial';
  foreach ($m as $k => $v) {
    if (!in_array($k, ['serial', 'testOnly', 'label'], true)) return 'unexpected metadata field';
    if ($k === 'label' && !mi_ascii_text($v, 40)) return 'invalid label';
  }
  $o = $d['originalOwner'];
  if (!mi_keys_exact($o, ['keyId', 'publicKey']) || !mi_pubkey_ok($o['publicKey']) || $o['keyId'] !== mi_key_id($o['publicKey'])) return 'invalid original owner key';
  if (!is_array($d['issuers']) || count($d['issuers']) < 1 || count($d['issuers']) > 8) return 'invalid issuer roster';
  $domains = [];
  foreach ($d['issuers'] as $i) {
    if (!mi_keys_exact($i, ['discovery', 'domain', 'keyId', 'publicKey'])) return 'invalid issuer entry';
    if (!mi_domain_ok($i['domain']) || !mi_pubkey_ok($i['publicKey']) || $i['keyId'] !== mi_key_id($i['publicKey'])) return 'invalid issuer identity for ' . (is_string($i['domain']) ? $i['domain'] : '?');
    if (!mi_keys_exact($i['discovery'], ['capabilities', 'manifest']) || $i['discovery']['manifest'] !== mi_manifest_url($i['domain'])) return 'the discovery reference of ' . $i['domain'] . ' is not that domain\'s own well-known manifest';
    if (!is_array($i['discovery']['capabilities']) || count($i['discovery']['capabilities']) < 1) return 'invalid capabilities for ' . $i['domain'];
    foreach ($i['discovery']['capabilities'] as $cap) if (!in_array($cap, mi_capabilities(), true)) return 'unknown capability for ' . $i['domain'];
    $domains[] = $i['domain'];
  }
  if (count($domains) !== count(array_unique($domains))) return 'a domain appears more than once in the issuer roster (a domain counts once)';
  foreach (['issuancePolicy', 'transferPolicy'] as $pn) {
    if (!mi_policy_shape_ok($d[$pn])) return 'invalid ' . $pn;
    $r = $d[$pn]['roster'];
    sort($r);
    $dd = $domains;
    sort($dd);
    if ($r !== $dd) return $pn . ' roster differs from the issuer roster';
  }
  $sa = $d['stateAuthority'];
  if (!mi_keys_exact($sa, ['capability', 'domain', 'keyId']) || $sa['capability'] !== MI_CAP_STATE) return 'invalid state authority';
  $found = null;
  foreach ($d['issuers'] as $i) if ($i['domain'] === $sa['domain']) $found = $i;
  if ($found === null || $found['keyId'] !== $sa['keyId'] || !in_array(MI_CAP_STATE, $found['discovery']['capabilities'], true)) return 'the state authority must be one of the issuers and declare asset.state';
  foreach (['issuancePolicy', 'transferPolicy'] as $pn) if (!in_array($sa['domain'], $d[$pn]['mandatory'], true)) return 'the state authority must be mandatory in ' . $pn;
  return null;
}

function mi_issuer($def, $domain) {
  foreach ($def['issuers'] as $i) if ($i['domain'] === $domain) return $i;
  return null;
}

// What THIS domain requires before it signs: its own pinned keys and policies decide, never the asset's claims.
function mi_definition_trust_problem($cfg, $def) {
  $p = mi_definition_problem($def);
  if ($p !== null) return $p;
  $mine = $cfg['rosterDomains'];
  $theirs = array_map(function ($i) { return $i['domain']; }, $def['issuers']);
  sort($theirs);
  if ($theirs !== $mine) return 'the issuer roster differs from this domain\'s own trusted roster';
  foreach ($def['issuers'] as $i) {
    if ($cfg['roster'][$i['domain']]['publicKey'] !== $i['publicKey']) return 'the public key claimed for ' . $i['domain'] . ' differs from the key this domain has pinned';
  }
  if ($def['stateAuthority']['domain'] !== $cfg['stateAuthority']) return 'the asset names a different state authority than this domain trusts';
  foreach (['issuance' => 'issuancePolicy', 'transfer' => 'transferPolicy'] as $cn => $pn) {
    $pol = $def[$pn];
    $m = $pol['mandatory'];
    sort($m);
    if ($pol['threshold'] !== $cfg[$cn]['threshold'] || $m !== $cfg[$cn]['mandatory']) return 'the ' . $cn . ' policy in the asset differs from this domain\'s own policy';
  }
  if (!in_array($def['class'], $cfg['assetClasses'], true)) return 'asset class not allowed for the public test demo';
  return null;
}

require_once __DIR__ . '/mi-verify.php';
require_once __DIR__ . '/mi-core.php';
require_once __DIR__ . '/mi-public.php';
