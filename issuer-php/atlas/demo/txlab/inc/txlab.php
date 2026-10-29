<?php
// Domain Atlas - Multi-Domain Transaction Authorization Lab (test only, no real value).
//
// A self-contained module: it has its own signing key, its own SQLite database, its
// own admin token and its own configuration, all in a private directory. It never reads
// or writes the issuer's keys, stores, balances, reserve bank or trading state.
//
// Model: one settlement authority (config.settlementDomain) owns the demo accounts and
// executes a transfer once the policy (threshold + mandatory domains) is satisfied by
// signed approvals. Every roster domain signs the same canonical payload digest with its
// own key; verifiers use public keys pinned in their own configuration, never keys
// supplied in a request. This is NOT atomic settlement across independent ledgers.
//
// Compatible with PHP 7.2+ (shared hosting): no arrow functions, match or typed properties.

require_once __DIR__ . '/../../../../lib/crypto.php';

const TXLAB_VERSION = 'domain-atlas-txlab/1';
const TXLAB_APPROVAL_VERSION = 'domain-atlas-txlab-approval/1';
const TXLAB_RECEIPT_VERSION = 'domain-atlas-txlab-receipt/1';
const TXLAB_CURRENCY = 'DEMO';
const TXLAB_MINOR_PER_UNIT = 100;      // 2 decimals: 3000 minor units = 30.00 DEMO
const TXLAB_MAX_AMOUNT_MINOR = 100000; // 1000.00 DEMO per transfer
const TXLAB_MAX_PENDING = 10;
const TXLAB_MAX_EVENTS_PER_TX = 200;
const TXLAB_CLOCK_SKEW_MS = 120000;
const TXLAB_MAX_BODY = 16384;

// ---------------------------------------------------------------- errors

class TxlabError extends Exception {
  public $httpStatus;
  public $extra;
  public function __construct($status, $message, $extra = []) {
    parent::__construct($message);
    $this->httpStatus = $status;
    $this->extra = $extra;
  }
}

function txlab_fail($status, $message, $extra = []) {
  throw new TxlabError($status, $message, $extra);
}

function txlab_now_ms() {
  return (int) round(microtime(true) * 1000);
}

// ---------------------------------------------------------------- private directory + config

function txlab_private_dir() {
  $env = getenv('TXLAB_PRIVATE_DIR');
  if ($env !== false && $env !== '') return rtrim($env, '/\\');
  $pointer = __DIR__ . '/private-dir.php';
  if (is_file($pointer)) {
    $v = include $pointer;
    if (is_string($v) && $v !== '') return rtrim($v, '/\\');
  }
  return null;
}

function txlab_path_is_within($path, $root) {
  $p = realpath($path);
  $r = realpath($root);
  if ($p === false || $r === false) return false;
  $p = rtrim(str_replace('\\', '/', $p), '/') . '/';
  $r = rtrim(str_replace('\\', '/', $r), '/') . '/';
  return strpos($p, $r) === 0;
}

function txlab_is_loopback_url($url) {
  $host = parse_url($url, PHP_URL_HOST);
  return $host === '127.0.0.1' || $host === 'localhost' || $host === '[::1]';
}

// Loads and validates everything the demo needs. Returns [config|null, problems[]].
// Any problem keeps the whole demo disabled (fail closed).
function txlab_load_config() {
  static $cache = null;
  if ($cache !== null) return $cache;
  $problems = [];
  $cfg = null;
  $dir = txlab_private_dir();
  if ($dir === null) {
    $problems[] = 'no private directory configured (set inc/private-dir.php)';
    return $cache = [null, $problems];
  }
  if (!is_dir($dir)) $problems[] = 'private directory does not exist';
  elseif (!is_writable($dir)) $problems[] = 'private directory is not writable';
  if (!empty($_SERVER['DOCUMENT_ROOT']) && is_dir($dir) && txlab_path_is_within($dir, $_SERVER['DOCUMENT_ROOT'])) {
    $problems[] = 'private directory is inside the web root';
  }
  if ($problems) return $cache = [null, $problems];
  if (is_file($dir . '/DISABLED')) {
    return $cache = [null, ['disabled by the DISABLED file in the private directory']];
  }
  $cfgFile = $dir . '/config.php';
  if (!is_file($cfgFile)) return $cache = [null, ['config.php missing in the private directory']];
  $c = include $cfgFile;
  if (!is_array($c)) return $cache = [null, ['config.php does not return an array']];
  if (empty($c['enabled'])) return $cache = [null, ['disabled in config.php (enabled is not true)']];

  $domain = isset($c['domain']) && is_string($c['domain']) ? $c['domain'] : '';
  $settlement = isset($c['settlementDomain']) && is_string($c['settlementDomain']) ? $c['settlementDomain'] : '';
  $roster = isset($c['roster']) && is_array($c['roster']) ? $c['roster'] : [];
  $threshold = isset($c['threshold']) ? $c['threshold'] : null;
  $mandatory = isset($c['mandatory']) && is_array($c['mandatory']) ? array_values($c['mandatory']) : [];
  $insecure = !empty($c['allowInsecureHttp']);
  if ($domain === '' || !isset($roster[$domain])) $problems[] = 'own domain is not in the roster';
  if ($settlement === '' || !isset($roster[$settlement])) $problems[] = 'settlement domain is not in the roster';
  if (!is_int($threshold) || $threshold < 1 || $threshold > count($roster)) $problems[] = 'threshold must be an integer between 1 and the roster size';
  foreach ($mandatory as $m) if (!isset($roster[$m])) $problems[] = 'mandatory domain is not in the roster';
  if ($settlement !== '' && !in_array($settlement, $mandatory, true)) $problems[] = 'the settlement domain must be a mandatory approver (it owns the ledger state)';
  foreach ($roster as $d => $entry) {
    if (!is_array($entry) || empty($entry['publicKey']) || empty($entry['baseUrl'])) { $problems[] = 'roster entry incomplete: ' . $d; continue; }
    try {
      if (strlen(b64url_decode($entry['publicKey'])) !== 65) $problems[] = 'roster public key has the wrong length: ' . $d;
    } catch (Exception $e) { $problems[] = 'roster public key is malformed: ' . $d; }
    $scheme = parse_url($entry['baseUrl'], PHP_URL_SCHEME);
    $host = parse_url($entry['baseUrl'], PHP_URL_HOST);
    $port = parse_url($entry['baseUrl'], PHP_URL_PORT);
    if ($scheme === 'https') {
      $hostPort = $port ? $host . ':' . $port : $host;
      if ($hostPort !== $d) $problems[] = 'roster baseUrl host does not match the domain name: ' . $d;
    } elseif (!($insecure && $scheme === 'http' && txlab_is_loopback_url($entry['baseUrl']))) {
      $problems[] = 'roster baseUrl must be https: ' . $d;
    }
  }
  if (empty($c['adminTokenHash']) || !preg_match('/^[0-9a-f]{64}$/', $c['adminTokenHash'])) $problems[] = 'adminTokenHash must be a 64-character sha256 hex digest';
  $accounts = isset($c['accounts']) && is_array($c['accounts']) ? $c['accounts'] : [];
  if (count($accounts) < 2) $problems[] = 'at least two demo accounts are required';
  foreach ($accounts as $name => $bal) {
    if (!is_string($name) || !preg_match('/^[a-z][a-z0-9_]{1,15}$/', $name) || !is_int($bal) || $bal < 0) $problems[] = 'accounts must map names to non-negative integer minor units';
  }
  $ttl = isset($c['ttlSeconds']) ? $c['ttlSeconds'] : 900;
  if (!is_int($ttl) || $ttl < 1 || $ttl > 3600) $problems[] = 'ttlSeconds must be an integer between 1 and 3600';

  // key file: present, EC P-256, readable by this account only, and matching the pinned public key
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
    if ($priv === false) {
      $problems[] = 'signing-key.pem is not a valid private key';
      $priv = null;
    } else {
      $d = openssl_pkey_get_details($priv);
      if (!isset($d['ec']['curve_name']) || $d['ec']['curve_name'] !== 'prime256v1') {
        $problems[] = 'signing key is not P-256';
      } else {
        $raw = "\x04" . str_pad($d['ec']['x'], 32, "\x00", STR_PAD_LEFT) . str_pad($d['ec']['y'], 32, "\x00", STR_PAD_LEFT);
        if (isset($roster[$domain]['publicKey']) && b64url_encode($raw) !== $roster[$domain]['publicKey']) {
          $problems[] = 'the signing key does not match this domain\'s public key in the roster';
        }
      }
    }
  }
  if (!extension_loaded('pdo_sqlite')) $problems[] = 'the pdo_sqlite PHP extension is not available';
  if (!extension_loaded('openssl')) $problems[] = 'the openssl PHP extension is not available';
  if (!extension_loaded('curl')) $problems[] = 'the curl PHP extension is not available';
  // the shared canonical-JSON/ECDSA primitives must behave as the other domains' do
  try {
    if (canonicalize(['b' => 1, 'a' => ['z' => true, 'y' => 'x']]) !== '{"a":{"y":"x","z":true},"b":1}') $problems[] = 'canonical JSON self-test failed';
  } catch (Exception $e) { $problems[] = 'canonical JSON self-test failed'; }

  if ($problems) return $cache = [null, $problems];
  ksort($roster);
  $mandatory = array_values(array_unique($mandatory));
  sort($mandatory);
  $cfg = [
    'dir' => $dir,
    'domain' => $domain,
    'settlementDomain' => $settlement,
    'isSettlement' => $domain === $settlement,
    'roster' => $roster,
    'rosterDomains' => array_keys($roster),
    'threshold' => $threshold,
    'mandatory' => $mandatory,
    'adminTokenHash' => $c['adminTokenHash'],
    'accounts' => $accounts,
    'ttlMs' => $ttl * 1000,
    'insecure' => $insecure,
    'privateKey' => $priv,
  ];
  return $cache = [$cfg, []];
}

function txlab_require_config() {
  list($cfg, $problems) = txlab_load_config();
  if ($cfg === null) txlab_fail(503, 'the transaction lab is disabled on this domain', ['enabled' => false, 'reasons' => $problems]);
  return $cfg;
}

function txlab_policy($cfg) {
  return ['mandatory' => $cfg['mandatory'], 'roster' => $cfg['rosterDomains'], 'threshold' => $cfg['threshold']];
}

// ---------------------------------------------------------------- database

function txlab_db() {
  static $db = null;
  if ($db !== null) return $db;
  $cfg = txlab_require_config();
  $db = new PDO('sqlite:' . $cfg['dir'] . '/txlab.sqlite');
  $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
  $db->exec('PRAGMA busy_timeout = 8000');
  $db->exec('PRAGMA foreign_keys = ON');
  try { $db->exec('PRAGMA journal_mode = WAL'); } catch (Exception $e) { /* some filesystems refuse WAL; the default journal is still durable */ }
  $db->exec('PRAGMA synchronous = FULL');
  txlab_migrate($db, $cfg);
  return $db;
}

function txlab_migrate($db, $cfg) {
  $db->exec('BEGIN IMMEDIATE');
  try {
    $db->exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS accounts (name TEXT PRIMARY KEY, balance_minor INTEGER NOT NULL CHECK (balance_minor >= 0))');
    $db->exec('CREATE TABLE IF NOT EXISTS tx (
      tx_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (\'pending\',\'executed\',\'failed\',\'expired\',\'rejected\')),
      fail_reason TEXT,
      created_ms INTEGER NOT NULL,
      expires_ms INTEGER NOT NULL,
      finished_ms INTEGER)');
    $db->exec('CREATE TABLE IF NOT EXISTS approvals (
      tx_id TEXT NOT NULL REFERENCES tx(tx_id),
      approver TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN (\'approve\',\'reject\')),
      approval_json TEXT NOT NULL,
      signature TEXT NOT NULL,
      stored_ms INTEGER NOT NULL,
      PRIMARY KEY (tx_id, approver))');
    $db->exec('CREATE TABLE IF NOT EXISTS ledger (
      entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
      tx_id TEXT NOT NULL UNIQUE REFERENCES tx(tx_id),
      from_acct TEXT NOT NULL, to_acct TEXT NOT NULL, amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
      from_before INTEGER NOT NULL, from_after INTEGER NOT NULL, to_before INTEGER NOT NULL, to_after INTEGER NOT NULL,
      executed_ms INTEGER NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS receipts (tx_id TEXT PRIMARY KEY REFERENCES tx(tx_id), receipt_json TEXT NOT NULL, signature TEXT NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL, tx_id TEXT, kind TEXT NOT NULL, domain TEXT, detail TEXT NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS auth_failures (ts_ms INTEGER NOT NULL)');
    // a stored transaction can never be edited, and a finished one never changes state again
    $db->exec('CREATE TRIGGER IF NOT EXISTS tx_payload_immutable BEFORE UPDATE OF tx_id, request_id, payload_json, digest, created_ms, expires_ms ON tx BEGIN SELECT RAISE(ABORT, \'transaction payload is immutable\'); END');
    $db->exec('CREATE TRIGGER IF NOT EXISTS tx_status_final BEFORE UPDATE OF status ON tx WHEN OLD.status <> \'pending\' BEGIN SELECT RAISE(ABORT, \'transaction is already final\'); END');
    $db->exec('CREATE TRIGGER IF NOT EXISTS tx_no_delete BEFORE DELETE ON tx BEGIN SELECT RAISE(ABORT, \'transactions are never deleted\'); END');
    $db->exec('CREATE TRIGGER IF NOT EXISTS approvals_immutable BEFORE UPDATE ON approvals BEGIN SELECT RAISE(ABORT, \'approvals are immutable\'); END');
    $db->exec('CREATE TRIGGER IF NOT EXISTS approvals_no_delete BEFORE DELETE ON approvals BEGIN SELECT RAISE(ABORT, \'approvals are never deleted\'); END');
    $db->exec('CREATE TRIGGER IF NOT EXISTS ledger_immutable BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT, \'ledger entries are immutable\'); END');
    $db->exec('CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, \'ledger entries are never deleted\'); END');
    $db->exec('CREATE TRIGGER IF NOT EXISTS receipts_immutable BEFORE UPDATE ON receipts BEGIN SELECT RAISE(ABORT, \'receipts are immutable\'); END');
    // accounts exist only on the settlement authority
    if ($cfg['isSettlement']) {
      $row = $db->query('SELECT v FROM meta WHERE k = \'seeded\'')->fetch(PDO::FETCH_ASSOC);
      if (!$row) {
        $ins = $db->prepare('INSERT INTO accounts (name, balance_minor) VALUES (?, ?)');
        $total = 0;
        foreach ($cfg['accounts'] as $name => $bal) { $ins->execute([$name, $bal]); $total += $bal; }
        $db->exec('INSERT INTO meta (k, v) VALUES (\'seeded\', \'1\')');
        $db->prepare('INSERT INTO meta (k, v) VALUES (\'total_minor\', ?)')->execute([(string) $total]);
      }
    }
    $db->exec('COMMIT');
  } catch (Exception $e) {
    try { $db->exec('ROLLBACK'); } catch (Exception $e2) { /* nothing open */ }
    throw $e;
  }
}

function txlab_in_txn($fn) {
  $db = txlab_db();
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

function txlab_event($db, $txId, $kind, $domain, $detail) {
  if ($txId !== null) {
    $n = $db->prepare('SELECT COUNT(*) FROM events WHERE tx_id = ?');
    $n->execute([$txId]);
    if ((int) $n->fetchColumn() >= TXLAB_MAX_EVENTS_PER_TX) return;
  }
  $st = $db->prepare('INSERT INTO events (ts_ms, tx_id, kind, domain, detail) VALUES (?, ?, ?, ?, ?)');
  $st->execute([txlab_now_ms(), $txId, $kind, $domain, substr($detail, 0, 300)]);
}

// ---------------------------------------------------------------- payload, digest, approvals

function txlab_payload_shape_ok($p) {
  if (!is_array($p)) return false;
  $keys = ['amountMinor', 'createdAtMs', 'currency', 'expiresAtMs', 'from', 'origin', 'policy', 'to', 'txId', 'type', 'v'];
  $have = array_keys($p);
  sort($have);
  if ($have !== $keys) return false;
  if ($p['v'] !== TXLAB_VERSION || $p['type'] !== 'transfer' || $p['currency'] !== TXLAB_CURRENCY) return false;
  foreach (['from', 'to', 'origin', 'txId'] as $f) if (!is_string($p[$f]) || $p[$f] === '') return false;
  foreach (['amountMinor', 'createdAtMs', 'expiresAtMs'] as $f) if (!is_int($p[$f])) return false;
  $pol = $p['policy'];
  if (!is_array($pol)) return false;
  $pk = array_keys($pol);
  sort($pk);
  if ($pk !== ['mandatory', 'roster', 'threshold']) return false;
  if (!is_int($pol['threshold']) || !is_array($pol['roster']) || !is_array($pol['mandatory'])) return false;
  foreach (array_merge($pol['roster'], $pol['mandatory']) as $d) if (!is_string($d)) return false;
  return true;
}

function txlab_digest($payload) {
  return hash('sha256', canonicalize($payload));
}

function txlab_approval_shape_ok($a) {
  if (!is_array($a)) return false;
  $keys = ['approvedAtMs', 'approver', 'decision', 'payloadDigest', 'txId', 'v'];
  $have = array_keys($a);
  sort($have);
  if ($have !== $keys) return false;
  return $a['v'] === TXLAB_APPROVAL_VERSION && is_string($a['txId']) && is_string($a['approver'])
    && is_string($a['payloadDigest']) && is_int($a['approvedAtMs']) && ($a['decision'] === 'approve' || $a['decision'] === 'reject');
}

function txlab_verify_with_pinned_key($cfg, $domain, $data, $sigB64) {
  if (!isset($cfg['roster'][$domain])) return false;
  try {
    $pem = ec_raw_point_to_pem(b64url_decode($cfg['roster'][$domain]['publicKey']));
    return ecdsa_verify_raw($pem, b64url_decode($sigB64), $data);
  } catch (Exception $e) {
    return false;
  }
}

function txlab_sign($cfg, $data) {
  return b64url_encode(ecdsa_sign_raw($cfg['privateKey'], $data));
}

// Checks done by a domain before it signs, and again by the settlement authority on
// whatever it is handed: this domain's OWN policy decides, not the request's.
function txlab_check_payload_against_policy($cfg, $payload, $digest) {
  if (!txlab_payload_shape_ok($payload)) txlab_fail(400, 'the transaction payload is malformed');
  if (txlab_digest($payload) !== $digest) txlab_fail(400, 'the payload does not match its digest');
  if ($payload['origin'] !== $cfg['settlementDomain']) txlab_fail(400, 'the transaction names a different settlement authority than this domain trusts');
  $pol = $payload['policy'];
  $roster = $pol['roster'];
  sort($roster);
  $mandatory = $pol['mandatory'];
  sort($mandatory);
  $mine = $cfg['rosterDomains'];
  sort($mine);
  if ($roster !== $mine || $mandatory !== $cfg['mandatory'] || $pol['threshold'] !== $cfg['threshold']) {
    txlab_fail(400, 'the quorum policy in the transaction differs from this domain\'s own policy');
  }
  if ($payload['amountMinor'] < 1 || $payload['amountMinor'] > TXLAB_MAX_AMOUNT_MINOR) txlab_fail(400, 'amount is outside the allowed range');
  if ($payload['from'] === $payload['to'] || !isset($cfg['accounts'][$payload['from']]) || !isset($cfg['accounts'][$payload['to']])) txlab_fail(400, 'unknown demo accounts');
  if ($payload['expiresAtMs'] <= $payload['createdAtMs'] || $payload['expiresAtMs'] - $payload['createdAtMs'] > 3600000) txlab_fail(400, 'invalid expiry');
}

// Evaluates a set of stored decisions against the transaction's own policy.
function txlab_evaluate($policy, $decisions) {
  $approved = [];
  $rejected = [];
  foreach ($decisions as $domain => $d) {
    if (!in_array($domain, $policy['roster'], true)) continue;
    if ($d === 'approve') $approved[] = $domain; else $rejected[] = $domain;
  }
  $missing = [];
  foreach ($policy['mandatory'] as $m) if (!in_array($m, $approved, true)) $missing[] = $m;
  $satisfied = count($approved) >= $policy['threshold'] && !$missing;
  $mandatoryRejected = array_values(array_intersect($policy['mandatory'], $rejected));
  $impossible = (count($policy['roster']) - count($rejected)) < $policy['threshold'] || $mandatoryRejected;
  return ['approved' => $approved, 'rejected' => $rejected, 'missingMandatory' => $missing, 'satisfied' => $satisfied, 'impossible' => (bool) $impossible, 'required' => $policy['threshold']];
}

// ---------------------------------------------------------------- settlement authority: create

function txlab_balance($db, $name) {
  $st = $db->prepare('SELECT balance_minor FROM accounts WHERE name = ?');
  $st->execute([$name]);
  $v = $st->fetchColumn();
  return $v === false ? null : (int) $v;
}

function txlab_create($requestId, $from, $to, $amountMinor) {
  $cfg = txlab_require_config();
  if (!$cfg['isSettlement']) txlab_fail(400, 'transactions are created at the settlement authority (' . $cfg['settlementDomain'] . ')');
  if (!is_string($requestId) || !preg_match('/^[A-Za-z0-9-]{8,64}$/', $requestId)) txlab_fail(400, 'requestId must be 8-64 characters of letters, digits and dashes');
  if (!is_string($from) || !is_string($to) || !isset($cfg['accounts'][$from]) || !isset($cfg['accounts'][$to]) || $from === $to) txlab_fail(400, 'sender and recipient must be two different demo accounts');
  if (!is_int($amountMinor) || $amountMinor < 1 || $amountMinor > TXLAB_MAX_AMOUNT_MINOR) txlab_fail(400, 'amountMinor must be an integer between 1 and ' . TXLAB_MAX_AMOUNT_MINOR);
  $txId = txlab_in_txn(function ($db) use ($cfg, $requestId, $from, $to, $amountMinor) {
    txlab_sweep_expired($db);
    $ex = $db->prepare('SELECT tx_id FROM tx WHERE request_id = ?');
    $ex->execute([$requestId]);
    $existing = $ex->fetchColumn();
    if ($existing !== false) {
      txlab_event($db, $existing, 'duplicate-submission', null, 'the same requestId was submitted again; no new transaction was created');
      return $existing;
    }
    $pending = (int) $db->query('SELECT COUNT(*) FROM tx WHERE status = \'pending\'')->fetchColumn();
    if ($pending >= TXLAB_MAX_PENDING) txlab_fail(429, 'too many pending transactions; wait for them to finish or expire');
    $bal = txlab_balance($db, $from);
    if ($bal === null || $bal < $amountMinor) txlab_fail(409, 'insufficient balance: ' . $from . ' has ' . $bal . ' minor units');
    $now = txlab_now_ms();
    $payload = [
      'v' => TXLAB_VERSION, 'type' => 'transfer', 'txId' => atlas_txlab_uuid(), 'origin' => $cfg['domain'],
      'from' => $from, 'to' => $to, 'currency' => TXLAB_CURRENCY, 'amountMinor' => $amountMinor,
      'createdAtMs' => $now, 'expiresAtMs' => $now + $cfg['ttlMs'], 'policy' => txlab_policy($cfg),
    ];
    $digest = txlab_digest($payload);
    $db->prepare('INSERT INTO tx (tx_id, request_id, payload_json, digest, status, created_ms, expires_ms) VALUES (?, ?, ?, ?, \'pending\', ?, ?)')
       ->execute([$payload['txId'], $requestId, canonicalize($payload), $digest, $now, $payload['expiresAtMs']]);
    txlab_event($db, $payload['txId'], 'created', $cfg['domain'], $from . ' -> ' . $to . ' ' . $amountMinor . ' minor units; awaiting independent approvals');
    return $payload['txId'];
  });
  return txlab_view($txId);
}

function atlas_txlab_uuid() {
  $d = random_bytes(16);
  $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
  $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
  $h = bin2hex($d);
  return substr($h, 0, 8) . '-' . substr($h, 8, 4) . '-' . substr($h, 12, 4) . '-' . substr($h, 16, 4) . '-' . substr($h, 20, 12);
}

// ---------------------------------------------------------------- settlement authority: approvals + execution

function txlab_sweep_expired($db) {
  $now = txlab_now_ms();
  $st = $db->prepare('SELECT tx_id FROM tx WHERE status = \'pending\' AND expires_ms < ?');
  $st->execute([$now]);
  foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $id) {
    $db->prepare('UPDATE tx SET status = \'expired\', finished_ms = ? WHERE tx_id = ? AND status = \'pending\'')->execute([$now, $id]);
    txlab_event($db, $id, 'expired', null, 'the authorization window closed before the policy was satisfied');
  }
}

function txlab_load_tx($db, $txId) {
  $st = $db->prepare('SELECT * FROM tx WHERE tx_id = ?');
  $st->execute([$txId]);
  $row = $st->fetch(PDO::FETCH_ASSOC);
  if (!$row) return null;
  $row['payload'] = json_decode($row['payload_json'], true);
  return $row;
}

function txlab_stored_decisions($db, $txId) {
  $st = $db->prepare('SELECT approver, decision FROM approvals WHERE tx_id = ?');
  $st->execute([$txId]);
  $out = [];
  foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) $out[$r['approver']] = $r['decision'];
  return $out;
}

// Verifies one signed decision against the stored transaction. Returns normally or throws.
function txlab_verify_decision($cfg, $tx, $approval, $signature, $claimedTxId) {
  if (!txlab_approval_shape_ok($approval)) txlab_fail(400, 'the approval is malformed');
  if (!is_string($signature) || $signature === '') txlab_fail(400, 'the approval has no signature');
  if ($claimedTxId !== $tx['tx_id'] || $approval['txId'] !== $tx['tx_id']) txlab_fail(400, 'the approval is for a different transaction');
  if ($approval['payloadDigest'] !== $tx['digest']) txlab_fail(400, 'the approval was signed over a different payload (amount, recipient or terms differ)');
  $policy = $tx['payload']['policy'];
  if (!in_array($approval['approver'], $policy['roster'], true) || !isset($cfg['roster'][$approval['approver']])) {
    txlab_fail(403, 'the approving domain is not in this transaction\'s roster');
  }
  if (!txlab_verify_with_pinned_key($cfg, $approval['approver'], canonicalize($approval), $signature)) {
    txlab_fail(400, 'the signature does not verify against ' . $approval['approver'] . '\'s pinned public key');
  }
  if ($approval['approvedAtMs'] > txlab_now_ms() + TXLAB_CLOCK_SKEW_MS || $approval['approvedAtMs'] < $tx['created_ms'] - TXLAB_CLOCK_SKEW_MS) {
    txlab_fail(400, 'the approval timestamp is outside the transaction\'s lifetime');
  }
  if ($approval['approvedAtMs'] > $tx['expires_ms'] + TXLAB_CLOCK_SKEW_MS) txlab_fail(400, 'the approval was signed after the authorization expired');
}

function txlab_submit_approval($txId, $approval, $signature) {
  $cfg = txlab_require_config();
  if (!$cfg['isSettlement']) txlab_fail(400, 'approvals are submitted to the settlement authority (' . $cfg['settlementDomain'] . ')');
  if (!is_string($txId) || !preg_match('/^[0-9a-f-]{36}$/', $txId)) txlab_fail(400, 'invalid transaction id');
  // A rejection is logged (when the transaction exists) and still answered with an error,
  // so the failure is visible in the evidence without changing the transaction.
  $reject = null;
  $res = null;
  try {
    $res = txlab_in_txn(function ($db) use ($cfg, $txId, $approval, $signature, &$reject) {
      txlab_sweep_expired($db);
      $tx = txlab_load_tx($db, $txId);
      if (!$tx) txlab_fail(404, 'no such transaction');
      $who = is_array($approval) && isset($approval['approver']) && is_string($approval['approver']) ? substr($approval['approver'], 0, 80) : null;
      try {
        if ($tx['status'] !== 'pending') txlab_fail(409, 'the transaction is ' . $tx['status'] . '; approvals are no longer accepted');
        txlab_verify_decision($cfg, $tx, $approval, $signature, $txId);
        $dup = $db->prepare('SELECT 1 FROM approvals WHERE tx_id = ? AND approver = ?');
        $dup->execute([$txId, $approval['approver']]);
        if ($dup->fetchColumn()) txlab_fail(409, 'duplicate approval: ' . $approval['approver'] . ' has already decided on this transaction');
      } catch (TxlabError $e) {
        txlab_event($db, $txId, 'approval-rejected', $who, $e->getMessage());
        $reject = $e;
        return null;
      }
      $db->prepare('INSERT INTO approvals (tx_id, approver, decision, approval_json, signature, stored_ms) VALUES (?, ?, ?, ?, ?, ?)')
         ->execute([$txId, $approval['approver'], $approval['decision'], canonicalize($approval), $signature, txlab_now_ms()]);
      txlab_event($db, $txId, $approval['decision'] === 'approve' ? 'approval-accepted' : 'rejection-accepted', $approval['approver'], 'signature verified against the pinned public key');
      txlab_advance($cfg, $db, $tx);
      return true;
    });
  } catch (PDOException $e) {
    txlab_fail(409, 'duplicate approval or conflicting update');
  }
  if ($reject) throw $reject;
  return txlab_view($txId);
}

// Re-evaluates a pending transaction and executes it exactly once when the policy is
// satisfied. Runs inside the caller's write transaction.
function txlab_advance($cfg, $db, $tx) {
  $txId = $tx['tx_id'];
  $policy = $tx['payload']['policy'];
  $eval = txlab_evaluate($policy, txlab_stored_decisions($db, $txId));
  $now = txlab_now_ms();
  if ($now > $tx['expires_ms']) {
    $db->prepare('UPDATE tx SET status = \'expired\', finished_ms = ? WHERE tx_id = ? AND status = \'pending\'')->execute([$now, $txId]);
    txlab_event($db, $txId, 'expired', null, 'the authorization window closed before execution');
    return;
  }
  if ($eval['satisfied']) {
    txlab_event($db, $txId, 'quorum-reached', null, count($eval['approved']) . '/' . $policy['threshold'] . ' approvals and every mandatory domain has approved');
    $p = $tx['payload'];
    $fromBefore = txlab_balance($db, $p['from']);
    $toBefore = txlab_balance($db, $p['to']);
    if ($fromBefore === null || $toBefore === null || $fromBefore < $p['amountMinor']) {
      $db->prepare('UPDATE tx SET status = \'failed\', fail_reason = ?, finished_ms = ? WHERE tx_id = ? AND status = \'pending\'')
         ->execute(['insufficient balance at execution time', $now, $txId]);
      txlab_event($db, $txId, 'execution-refused', $cfg['domain'], $p['from'] . ' has ' . $fromBefore . ' minor units, ' . $p['amountMinor'] . ' needed');
      return;
    }
    $up = $db->prepare('UPDATE tx SET status = \'executed\', finished_ms = ? WHERE tx_id = ? AND status = \'pending\'');
    $up->execute([$now, $txId]);
    if ($up->rowCount() !== 1) return; // someone else already finalized it: never execute twice
    $db->prepare('UPDATE accounts SET balance_minor = balance_minor - ? WHERE name = ?')->execute([$p['amountMinor'], $p['from']]);
    $db->prepare('UPDATE accounts SET balance_minor = balance_minor + ? WHERE name = ?')->execute([$p['amountMinor'], $p['to']]);
    $fromAfter = $fromBefore - $p['amountMinor'];
    $toAfter = $toBefore + $p['amountMinor'];
    $db->prepare('INSERT INTO ledger (tx_id, from_acct, to_acct, amount_minor, from_before, from_after, to_before, to_after, executed_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
       ->execute([$txId, $p['from'], $p['to'], $p['amountMinor'], $fromBefore, $fromAfter, $toBefore, $toAfter, $now]);
    $entryId = (int) $db->lastInsertId();
    $ap = $db->prepare('SELECT approver, decision, approval_json, signature FROM approvals WHERE tx_id = ? ORDER BY approver');
    $ap->execute([$txId]);
    $approvals = [];
    foreach ($ap->fetchAll(PDO::FETCH_ASSOC) as $r) {
      $a = json_decode($r['approval_json'], true);
      $approvals[] = ['approvedAtMs' => $a['approvedAtMs'], 'approver' => $r['approver'], 'decision' => $r['decision'], 'signature' => $r['signature']];
    }
    $receipt = [
      'v' => TXLAB_RECEIPT_VERSION, 'txId' => $txId, 'payloadDigest' => $tx['digest'], 'settlementDomain' => $cfg['domain'],
      'executedAtMs' => $now, 'from' => $p['from'], 'to' => $p['to'], 'amountMinor' => $p['amountMinor'], 'currency' => TXLAB_CURRENCY,
      'balancesBefore' => [$p['from'] => $fromBefore, $p['to'] => $toBefore],
      'balancesAfter' => [$p['from'] => $fromAfter, $p['to'] => $toAfter],
      'ledgerEntryId' => $entryId, 'approvals' => $approvals,
    ];
    $json = canonicalize($receipt);
    $db->prepare('INSERT INTO receipts (tx_id, receipt_json, signature) VALUES (?, ?, ?)')->execute([$txId, $json, txlab_sign($cfg, $json)]);
    txlab_event($db, $txId, 'executed', $cfg['domain'], $p['from'] . ' ' . $fromBefore . ' -> ' . $fromAfter . ', ' . $p['to'] . ' ' . $toBefore . ' -> ' . $toAfter);
    return;
  }
  if ($eval['impossible']) {
    $db->prepare('UPDATE tx SET status = \'rejected\', fail_reason = ?, finished_ms = ? WHERE tx_id = ? AND status = \'pending\'')
       ->execute(['the policy can no longer be satisfied', $now, $txId]);
    txlab_event($db, $txId, 'rejected', null, 'enough domains rejected that the quorum policy cannot be met');
  } elseif (count($eval['approved']) >= $policy['threshold'] && $eval['missingMandatory']) {
    txlab_event($db, $txId, 'execution-blocked', null, 'threshold reached but required domain(s) ' . implode(', ', $eval['missingMandatory']) . ' have not approved; no unrelated quorum can stand in for them');
  }
}

// Recovery: re-evaluates every pending transaction (idempotent), so a transaction whose
// policy was met but whose execution was interrupted is completed exactly once.
function txlab_recover() {
  $cfg = txlab_require_config();
  if (!$cfg['isSettlement']) return;
  txlab_in_txn(function ($db) use ($cfg) {
    txlab_sweep_expired($db);
    $ids = $db->query('SELECT tx_id FROM tx WHERE status = \'pending\'')->fetchAll(PDO::FETCH_COLUMN);
    foreach ($ids as $id) {
      $tx = txlab_load_tx($db, $id);
      $eval = txlab_evaluate($tx['payload']['policy'], txlab_stored_decisions($db, $id));
      if ($eval['satisfied']) txlab_advance($cfg, $db, $tx);
    }
  });
}

// ---------------------------------------------------------------- views / evidence

function txlab_view($txId) {
  $cfg = txlab_require_config();
  if (!$cfg['isSettlement']) return txlab_remote_view($cfg, $txId);
  txlab_recover();
  $db = txlab_db();
  $tx = txlab_load_tx($db, $txId);
  if (!$tx) txlab_fail(404, 'no such transaction');
  $policy = $tx['payload']['policy'];
  $ap = $db->prepare('SELECT approver, decision, approval_json, signature, stored_ms FROM approvals WHERE tx_id = ? ORDER BY stored_ms');
  $ap->execute([$txId]);
  $approvals = [];
  $decisions = [];
  foreach ($ap->fetchAll(PDO::FETCH_ASSOC) as $r) {
    $a = json_decode($r['approval_json'], true);
    $decisions[$r['approver']] = $r['decision'];
    $approvals[] = [
      'approver' => $r['approver'], 'decision' => $r['decision'], 'approval' => $a, 'signature' => $r['signature'],
      'storedAtMs' => (int) $r['stored_ms'],
      'verified' => txlab_verify_with_pinned_key($cfg, $r['approver'], $r['approval_json'], $r['signature']),
    ];
  }
  $eval = txlab_evaluate($policy, $decisions);
  $domains = [];
  foreach ($policy['roster'] as $d) {
    $status = 'pending';
    if (isset($decisions[$d])) $status = $decisions[$d] === 'approve' ? 'approved' : 'rejected';
    $domains[] = ['domain' => $d, 'status' => $status, 'mandatory' => in_array($d, $policy['mandatory'], true)];
  }
  $rc = $db->prepare('SELECT receipt_json, signature FROM receipts WHERE tx_id = ?');
  $rc->execute([$txId]);
  $rcRow = $rc->fetch(PDO::FETCH_ASSOC);
  $receipt = null;
  if ($rcRow) {
    $receipt = [
      'receipt' => json_decode($rcRow['receipt_json'], true), 'signature' => $rcRow['signature'],
      'verified' => txlab_verify_with_pinned_key($cfg, $cfg['settlementDomain'], $rcRow['receipt_json'], $rcRow['signature']),
    ];
  }
  $ev = $db->prepare('SELECT ts_ms, kind, domain, detail FROM events WHERE tx_id = ? ORDER BY id');
  $ev->execute([$txId]);
  return [
    'source' => $cfg['domain'], 'settlementDomain' => $cfg['settlementDomain'],
    'txId' => $txId, 'payload' => $tx['payload'], 'digest' => $tx['digest'],
    'digestMatches' => txlab_digest($tx['payload']) === $tx['digest'],
    'status' => $tx['status'], 'failReason' => $tx['fail_reason'],
    'createdAtMs' => (int) $tx['created_ms'], 'expiresAtMs' => (int) $tx['expires_ms'],
    'finishedAtMs' => $tx['finished_ms'] === null ? null : (int) $tx['finished_ms'],
    'quorum' => ['approved' => count($eval['approved']), 'required' => $policy['threshold'], 'missingMandatory' => $eval['missingMandatory']],
    'domains' => $domains, 'approvals' => $approvals, 'receipt' => $receipt,
    'events' => $ev->fetchAll(PDO::FETCH_ASSOC),
    'balances' => txlab_balances($db),
  ];
}

function txlab_balances($db) {
  $out = [];
  foreach ($db->query('SELECT name, balance_minor FROM accounts ORDER BY name')->fetchAll(PDO::FETCH_ASSOC) as $r) $out[$r['name']] = (int) $r['balance_minor'];
  return $out;
}

function txlab_state() {
  $cfg = txlab_require_config();
  if (!$cfg['isSettlement']) {
    $remote = txlab_peer_call($cfg, $cfg['settlementDomain'], 'GET', ['op' => 'state']);
    if ($remote['status'] !== 200 || !is_array($remote['body'])) txlab_fail(502, 'the settlement authority is unreachable or refused: ' . $remote['error']);
    $body = $remote['body'];
    $body['viewedFrom'] = $cfg['domain'];
    return $body;
  }
  txlab_recover();
  $db = txlab_db();
  $balances = txlab_balances($db);
  $total = (int) $db->query('SELECT v FROM meta WHERE k = \'total_minor\'')->fetchColumn();
  $recent = $db->query('SELECT tx_id, payload_json, status, created_ms FROM tx ORDER BY created_ms DESC, rowid DESC LIMIT 15')->fetchAll(PDO::FETCH_ASSOC);
  $list = [];
  foreach ($recent as $r) {
    $p = json_decode($r['payload_json'], true);
    $list[] = ['txId' => $r['tx_id'], 'from' => $p['from'], 'to' => $p['to'], 'amountMinor' => $p['amountMinor'], 'status' => $r['status'], 'createdAtMs' => (int) $r['created_ms']];
  }
  $ev = $db->query('SELECT ts_ms, tx_id, kind, domain, detail FROM events ORDER BY id DESC LIMIT 40')->fetchAll(PDO::FETCH_ASSOC);
  return [
    'source' => $cfg['domain'], 'viewedFrom' => $cfg['domain'], 'settlementDomain' => $cfg['settlementDomain'],
    'currency' => TXLAB_CURRENCY, 'minorPerUnit' => TXLAB_MINOR_PER_UNIT,
    'policy' => txlab_policy($cfg), 'balances' => $balances,
    'conservation' => ['totalMinor' => $total, 'sumMinor' => array_sum($balances), 'ok' => array_sum($balances) === $total],
    'transactions' => $list, 'events' => $ev, 'accounts' => array_keys($cfg['accounts']),
  ];
}

// ---------------------------------------------------------------- peer HTTP (HTTPS + TLS verification, pinned URLs only)

function txlab_peer_call($cfg, $domain, $method, $query, $body = null, $timeout = 6) {
  if (!isset($cfg['roster'][$domain])) return ['status' => 0, 'body' => null, 'error' => 'not a roster domain'];
  $base = $cfg['roster'][$domain]['baseUrl'];
  $url = $base . '?' . http_build_query($query);
  $https = parse_url($base, PHP_URL_SCHEME) === 'https';
  if (!$https && !($cfg['insecure'] && txlab_is_loopback_url($base))) return ['status' => 0, 'body' => null, 'error' => 'refusing a non-https peer'];
  $ch = curl_init($url);
  $raw = '';
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => false,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 4,
    CURLOPT_TIMEOUT => $timeout,
    CURLOPT_SSL_VERIFYPEER => true,
    CURLOPT_SSL_VERIFYHOST => 2,
    CURLOPT_PROTOCOLS => $https ? CURLPROTO_HTTPS : (CURLPROTO_HTTP | CURLPROTO_HTTPS),
    CURLOPT_WRITEFUNCTION => function ($c, $chunk) use (&$raw) {
      $raw .= $chunk;
      return strlen($raw) > 262144 ? 0 : strlen($chunk);
    },
  ]);
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
  return ['status' => $status, 'body' => is_array($decoded) ? $decoded : null, 'error' => is_array($decoded) && isset($decoded['error']) ? $decoded['error'] : ('HTTP ' . $status)];
}

// A non-settlement domain's own view of a transaction: fetched from the settlement
// authority, then re-verified here against THIS domain's pinned keys.
function txlab_remote_view($cfg, $txId) {
  $r = txlab_peer_call($cfg, $cfg['settlementDomain'], 'GET', ['op' => 'tx', 'id' => $txId]);
  if ($r['status'] === 404) txlab_fail(404, 'no such transaction');
  if ($r['status'] !== 200 || !is_array($r['body'])) txlab_fail(502, 'the settlement authority is unreachable or refused: ' . $r['error']);
  $v = $r['body'];
  $local = ['digestMatches' => false, 'approvals' => [], 'receiptVerified' => null];
  if (isset($v['payload']) && isset($v['digest']) && is_array($v['payload'])) {
    $local['digestMatches'] = txlab_payload_shape_ok($v['payload']) && txlab_digest($v['payload']) === $v['digest'];
  }
  foreach (isset($v['approvals']) && is_array($v['approvals']) ? $v['approvals'] : [] as $a) {
    $ok = is_array($a) && isset($a['approval'], $a['signature'], $a['approver'])
      && txlab_approval_shape_ok($a['approval']) && $a['approval']['approver'] === $a['approver']
      && isset($v['digest']) && $a['approval']['payloadDigest'] === $v['digest'] && $a['approval']['txId'] === $txId
      && txlab_verify_with_pinned_key($cfg, $a['approver'], canonicalize($a['approval']), $a['signature']);
    $local['approvals'][] = ['approver' => is_array($a) && isset($a['approver']) ? $a['approver'] : null, 'verified' => (bool) $ok];
  }
  if (isset($v['receipt']) && is_array($v['receipt']) && isset($v['receipt']['receipt'], $v['receipt']['signature'])) {
    $local['receiptVerified'] = txlab_verify_with_pinned_key($cfg, $cfg['settlementDomain'], canonicalize($v['receipt']['receipt']), $v['receipt']['signature']);
  }
  $v['viewedFrom'] = $cfg['domain'];
  $v['verifiedLocally'] = $local;
  return $v;
}

// ---------------------------------------------------------------- admin-triggered decision (this domain signs)

// This domain's admin reviews a pending transaction and signs ONE decision with this
// domain's own key. The payload is fetched from the settlement authority (or read locally
// on the settlement authority itself) and checked against this domain's own policy first.
function txlab_decide($txId, $decision) {
  $cfg = txlab_require_config();
  if (!is_string($txId) || !preg_match('/^[0-9a-f-]{36}$/', $txId)) txlab_fail(400, 'invalid transaction id');
  if ($decision !== 'approve' && $decision !== 'reject') txlab_fail(400, 'decision must be approve or reject');
  if ($cfg['isSettlement']) {
    txlab_recover();
    $db = txlab_db();
    $tx = txlab_load_tx($db, $txId);
    if (!$tx) txlab_fail(404, 'no such transaction');
    $payload = $tx['payload'];
    $digest = $tx['digest'];
    $status = $tx['status'];
  } else {
    $r = txlab_peer_call($cfg, $cfg['settlementDomain'], 'GET', ['op' => 'tx', 'id' => $txId]);
    if ($r['status'] === 404) txlab_fail(404, 'no such transaction at ' . $cfg['settlementDomain']);
    if ($r['status'] !== 200 || !is_array($r['body']) || !isset($r['body']['payload'], $r['body']['digest'], $r['body']['status'])) {
      txlab_fail(502, 'cannot read the transaction from ' . $cfg['settlementDomain'] . ': ' . $r['error'], ['state' => 'peer-unavailable']);
    }
    $payload = $r['body']['payload'];
    $digest = $r['body']['digest'];
    $status = $r['body']['status'];
    if (!is_string($digest) || !is_string($status) || !is_array($payload)) txlab_fail(502, 'the settlement authority returned a malformed transaction');
    if (isset($payload['txId']) && $payload['txId'] !== $txId) txlab_fail(400, 'the settlement authority returned a different transaction');
  }
  txlab_check_payload_against_policy($cfg, $payload, $digest);
  if ($status !== 'pending') txlab_fail(409, 'the transaction is ' . $status . ', not pending');
  if (txlab_now_ms() > $payload['expiresAtMs']) txlab_fail(409, 'the authorization window has closed');
  $approval = [
    'v' => TXLAB_APPROVAL_VERSION, 'txId' => $txId, 'payloadDigest' => $digest, 'approver' => $cfg['domain'],
    'decision' => $decision, 'approvedAtMs' => txlab_now_ms(),
  ];
  $signature = txlab_sign($cfg, canonicalize($approval));
  if ($cfg['isSettlement']) {
    $view = txlab_submit_approval($txId, $approval, $signature);
  } else {
    $r = txlab_peer_call($cfg, $cfg['settlementDomain'], 'POST', ['op' => 'submit-approval'], ['id' => $txId, 'approval' => $approval, 'signature' => $signature]);
    if ($r['status'] === 0) txlab_fail(502, 'could not deliver the signed decision to ' . $cfg['settlementDomain'] . ': ' . $r['error'], ['state' => 'peer-unavailable']);
    if ($r['status'] !== 200 || !is_array($r['body'])) txlab_fail($r['status'] >= 400 && $r['status'] < 600 ? $r['status'] : 502, $cfg['settlementDomain'] . ' refused the decision: ' . $r['error']);
    $view = $r['body'];
  }
  return ['signedBy' => $cfg['domain'], 'approval' => $approval, 'signature' => $signature, 'view' => $view];
}

// ---------------------------------------------------------------- admin authentication

function txlab_require_admin($token) {
  $cfg = txlab_require_config();
  $db = txlab_db();
  $now = txlab_now_ms();
  $db->prepare('DELETE FROM auth_failures WHERE ts_ms < ?')->execute([$now - 300000]);
  $n = (int) $db->query('SELECT COUNT(*) FROM auth_failures')->fetchColumn();
  if ($n >= 8) txlab_fail(429, 'too many failed admin attempts; wait a few minutes');
  if (!is_string($token) || $token === '' || !hash_equals($cfg['adminTokenHash'], hash('sha256', $token))) {
    $db->prepare('INSERT INTO auth_failures (ts_ms) VALUES (?)')->execute([$now]);
    usleep(300000);
    txlab_fail(401, 'demo administrator authorization required');
  }
  return $cfg;
}

// ---------------------------------------------------------------- health / roster / peers

function txlab_health() {
  list($cfg, $problems) = txlab_load_config();
  $out = ['enabled' => $cfg !== null, 'version' => TXLAB_VERSION, 'testDemo' => true];
  if ($cfg !== null) {
    $out['domain'] = $cfg['domain'];
    $out['role'] = $cfg['isSettlement'] ? 'settlement-authority' : 'approver';
    $out['insecureTransport'] = $cfg['insecure'];
  } else {
    $out['reasons'] = $problems;
  }
  return $out;
}

function txlab_roster() {
  $cfg = txlab_require_config();
  $keys = [];
  foreach ($cfg['roster'] as $d => $e) $keys[$d] = $e['publicKey'];
  return [
    'domain' => $cfg['domain'], 'settlementDomain' => $cfg['settlementDomain'], 'policy' => txlab_policy($cfg),
    'publicKeys' => $keys, 'ownPublicKey' => $cfg['roster'][$cfg['domain']]['publicKey'],
    'currency' => TXLAB_CURRENCY, 'minorPerUnit' => TXLAB_MINOR_PER_UNIT, 'version' => TXLAB_VERSION, 'approvalVersion' => TXLAB_APPROVAL_VERSION,
  ];
}

function txlab_peers() {
  $cfg = txlab_require_config();
  $out = [];
  foreach ($cfg['rosterDomains'] as $d) {
    if ($d === $cfg['domain']) { $out[] = ['domain' => $d, 'self' => true, 'reachable' => true, 'keyMatches' => true]; continue; }
    $h = txlab_peer_call($cfg, $d, 'GET', ['op' => 'roster'], null, 3);
    $reach = $h['status'] === 200 && is_array($h['body']);
    $keyOk = $reach && isset($h['body']['ownPublicKey']) && $h['body']['ownPublicKey'] === $cfg['roster'][$d]['publicKey'] && ($h['body']['domain'] ?? null) === $d;
    $out[] = ['domain' => $d, 'self' => false, 'reachable' => $reach, 'keyMatches' => $keyOk, 'error' => $reach ? null : $h['error']];
  }
  return $out;
}
