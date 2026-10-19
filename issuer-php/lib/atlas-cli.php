<?php
// Domain Atlas - PHP issuer: command-line checks and recovery for the operator.
//
//   php lib/atlas-cli.php preflight [--write-probe]   permissions, files, keys, revocation list, private state
//   php lib/atlas-cli.php counts                      revocation entry counts and an inventory of the state files
//   php lib/atlas-cli.php txn-list                    pending transaction-journal entries (no credentials shown)
//   php lib/atlas-cli.php txn-recover [--force]       settle pending entries (what the next request would do)
//
// Command line only: it refuses to run under a web server. lib/.htaccess also
// denies web access to this folder. It never creates, replaces or deletes the
// issuer key, the published key document or the revocation list, and it never
// prints a private key or a credential. `preflight` is read-only unless
// --write-probe is given, which creates and removes a uniquely named probe file
// in each directory the issuer writes to.
//
// Which user this runs as matters: on a host where PHP runs for the web as one
// account and the command line as another, "writable" below is true for the
// account running this, which may not be the web account. txn-recover refuses
// to run as a different account than the one that owns the journal directory,
// because files it wrote would then be unwritable for the web requests.

if (PHP_SAPI !== 'cli') {
  http_response_code(404);
  exit;
}

foreach (['crypto.php', 'store.php', 'replacement.php'] as $needed) {
  if (!is_file(__DIR__ . '/' . $needed)) {
    fwrite(STDERR, 'FAIL lib/' . $needed . " is missing: upload every file in lib/ from the same release before running this tool\n");
    exit(1);
  }
}
require_once __DIR__ . '/crypto.php';
require_once __DIR__ . '/store.php';
require_once __DIR__ . '/replacement.php';

$argvList = $argv;
array_shift($argvList);
$command = $argvList[0] ?? 'help';
$flags = array_slice($argvList, 1);
$failures = 0;
$warnings = 0;

function cli_line($level, $text) {
  global $failures, $warnings;
  if ($level === 'FAIL') $failures++;
  if ($level === 'WARN') $warnings++;
  echo str_pad($level, 5) . ' ' . $text . "\n";
}

function cli_mode($path) {
  $perms = @fileperms($path);
  return $perms === false ? '----' : substr(sprintf('%o', $perms), -4);
}

function cli_owner($path) {
  $uid = @fileowner($path);
  if ($uid === false) return '?';
  if (function_exists('posix_getpwuid')) {
    $info = @posix_getpwuid($uid);
    if (is_array($info)) return $info['name'] . '(' . $uid . ')';
  }
  return (string) $uid;
}

function cli_self() {
  if (function_exists('posix_geteuid')) {
    $uid = posix_geteuid();
    $info = function_exists('posix_getpwuid') ? @posix_getpwuid($uid) : null;
    return (is_array($info) ? $info['name'] : 'uid') . '(' . $uid . ')';
  }
  return '?';
}

// The public key as the issuer publishes it, derived from the private key file
// without creating anything. null when the file cannot be used.
function cli_public_key_of_private_key($file) {
  $pem = @file_get_contents($file);
  if ($pem === false) return null;
  $priv = @openssl_pkey_get_private($pem);
  if ($priv === false) return null;
  $d = openssl_pkey_get_details($priv);
  if (!isset($d['ec']['x'], $d['ec']['y'])) return null;
  return b64url_encode("\x04" . str_pad($d['ec']['x'], 32, "\x00", STR_PAD_LEFT) . str_pad($d['ec']['y'], 32, "\x00", STR_PAD_LEFT));
}

function cli_directory($label, $dir, $mustExist, $probe) {
  if (!is_dir($dir)) {
    cli_line($mustExist ? 'FAIL' : 'INFO', $label . ': ' . $dir . ($mustExist ? ' does not exist' : ' does not exist yet (created on first use)'));
    return;
  }
  $writable = is_writable($dir);
  $line = $label . ': ' . $dir . ' mode ' . cli_mode($dir) . ' owner ' . cli_owner($dir) . ' (running as ' . cli_self() . ')';
  cli_line($writable ? 'PASS' : 'FAIL', $line . ($writable ? ' writable' : ' NOT writable'));
  if ($writable && $probe) {
    $probeFile = $dir . '/atlas-preflight-' . bin2hex(random_bytes(4)) . '.json';
    try {
      atlas_write_file_atomic($probeFile, '{"probe":true}');
      $back = @file_get_contents($probeFile);
      @unlink($probeFile);
      cli_line($back === '{"probe":true}' ? 'PASS' : 'FAIL', $label . ': atomic write (temporary file, rename) and removal work');
    } catch (Exception $e) {
      @unlink($probeFile);
      cli_line('FAIL', $label . ': atomic write failed: ' . $e->getMessage());
    }
  }
}

function cli_revocation_summary() {
  $file = atlas_revocations_file();
  if (!file_exists($file)) return ['state' => 'missing'];
  try {
    $doc = read_revocations();
  } catch (Exception $e) {
    return ['state' => 'bad', 'message' => $e->getMessage()];
  }
  $ids = [];
  $dupes = 0;
  $tagged = 0;
  foreach ($doc['revoked'] as $r) {
    if (!is_array($r) || !isset($r['id']) || !is_string($r['id'])) continue;
    if (isset($ids[$r['id']])) $dupes++;
    $ids[$r['id']] = true;
    if (isset($r['txn'])) $tagged++;
  }
  return ['state' => 'ok', 'entries' => count($doc['revoked']), 'distinct' => count($ids), 'duplicates' => $dupes, 'tagged' => $tagged, 'bytes' => (int) @filesize($file), 'sha256' => hash_file('sha256', $file)];
}

function cli_preflight($probe) {
  global $failures, $warnings;
  $lib = __DIR__;
  $docroot = atlas_docroot();
  $wk = $docroot . '/.well-known';
  echo "Domain Atlas PHP issuer preflight\n";
  echo 'docroot ' . $docroot . ' | lib ' . $lib . ' | PHP ' . PHP_VERSION . ' ' . PHP_SAPI . ' | running as ' . cli_self() . ($probe ? ' | write probes ON' : ' | read-only') . "\n\n";

  cli_line(version_compare(PHP_VERSION, '7.0.0', '>=') ? 'PASS' : 'FAIL', 'PHP version ' . PHP_VERSION . ' (7.0 or newer needed)');
  foreach (['openssl', 'json', 'hash', 'mbstring'] as $ext) {
    cli_line(extension_loaded($ext) ? 'PASS' : 'FAIL', 'extension ' . $ext);
  }
  cli_line(function_exists('fsync') ? 'PASS' : 'WARN', function_exists('fsync')
    ? 'fsync() available: replaced files are flushed to disk before the rename'
    : 'fsync() not available (PHP before 8.1): files are flushed to the operating system but not forced to disk; a power loss can lose the last write');
  foreach (['flock', 'random_bytes', 'rename'] as $fn) {
    cli_line(function_exists($fn) ? 'PASS' : 'FAIL', 'function ' . $fn);
  }

  echo "\n-- files from one version --\n";
  foreach (['bootstrap.php', 'crypto.php', 'store.php', 'replacement.php', 'transfer-policy.php', 'elements-catalog.php', '.htaccess'] as $f) {
    cli_line(is_file($lib . '/' . $f) ? 'PASS' : 'FAIL', 'lib/' . $f . (is_file($lib . '/' . $f) ? '' : ' is missing'));
  }
  cli_line(function_exists('atlas_commit_replacement') && function_exists('atlas_txn_sweep') && function_exists('atlas_private_subdir_ensure') ? 'PASS' : 'FAIL', 'lib/replacement.php is the transaction-journal version');
  $endpoints = ['asset/split.php', 'asset/consolidate.php', 'asset/issue.php', 'convert.php', 'asset/purchase.php'];
  foreach ($endpoints as $e) {
    $path = $docroot . '/atlas/' . $e;
    $text = is_file($path) ? (string) @file_get_contents($path) : '';
    cli_line(strpos($text, 'atlas_commit_replacement') !== false ? 'PASS' : 'FAIL', 'atlas/' . $e . (strpos($text, 'atlas_commit_replacement') !== false ? ' uses the journal' : ' is missing or still the old version (upload lib/ first, then these)'));
  }
  foreach (['asset/issue.php' => 'atlas_record_issuance', 'trade/claim.php' => 'atlas_store_claim_outcome', 'capabilities.php' => 'issue-unique'] as $e => $needle) {
    $path = $docroot . '/atlas/' . $e;
    $text = is_file($path) ? (string) @file_get_contents($path) : '';
    cli_line(strpos($text, $needle) !== false ? 'PASS' : 'FAIL', 'atlas/' . $e . (strpos($text, $needle) !== false ? ' answers a repeated request id' : ' is missing or still the old version (upload lib/ first, then these)'));
  }
  $claimText = is_file($docroot . '/atlas/trade/claim.php') ? (string) @file_get_contents($docroot . '/atlas/trade/claim.php') : '';
  $claimReturnsRemainder = strpos($claimText, "'remainder' => \$bRemainder, 'code' => 'claim-incomplete'") !== false;
  cli_line($claimReturnsRemainder ? 'PASS' : 'FAIL', 'atlas/trade/claim.php' . ($claimReturnsRemainder ? ' returns the claimant\'s change with an incomplete claim' : ' is missing or does not return the claimant\'s change with an incomplete claim (upload this version)'));
  foreach (['ledger/account-credential.php' => 'lib/ledger-issuance.php', 'ledger/balance-receipt.php' => 'lib/ledger-receipts.php'] as $endpoint => $libFile) {
    $text = is_file($lib . '/' . basename($libFile)) ? (string) @file_get_contents($lib . '/' . basename($libFile)) : '';
    if (is_file($docroot . '/atlas/' . $endpoint)) {
      cli_line(strpos($text, 'revocations-unavailable') !== false ? 'PASS' : 'FAIL', $libFile . (strpos($text, 'revocations-unavailable') !== false ? ' fails closed on a bad revocation list' : ' is the old version'));
    }
  }

  echo "\n-- web access to lib/ --\n";
  $ht = $lib . '/.htaccess';
  $htText = is_file($ht) ? (string) @file_get_contents($ht) : '';
  $denies = stripos($htText, 'Require all denied') !== false || stripos($htText, 'Deny from all') !== false;
  cli_line($denies ? 'PASS' : 'FAIL', 'lib/.htaccess denies web access' . ($denies ? '' : ' (missing or empty): the issuer key and all state would be served'));
  cli_line('INFO', 'This only shows the file is there. Whether the web server honours it is checked over HTTP (tools/gen1-php-smoke.js, or request /lib/issuer-private-key.pem and expect 403 or 404).');

  echo "\n-- identity --\n";
  $keyFile = atlas_key_file();
  if (!is_file($keyFile)) {
    cli_line('FAIL', 'lib/issuer-private-key.pem is missing (an existing domain must have it; the issuer refuses to make a new identity while a key is published)');
  } else {
    $mode = cli_mode($keyFile);
    cli_line(($mode[2] === '0' && $mode[3] === '0') ? 'PASS' : 'WARN', 'issuer private key file mode ' . $mode . ' owner ' . cli_owner($keyFile) . (($mode[2] === '0' && $mode[3] === '0') ? '' : ' (readable by group or others; 0600 is expected)'));
    $pub = cli_public_key_of_private_key($keyFile);
    if ($pub === null) {
      cli_line('FAIL', 'the issuer private key file cannot be read as an EC key by this account');
    } else {
      $doc = is_file(atlas_public_key_file()) ? json_decode((string) @file_get_contents(atlas_public_key_file()), true) : null;
      if (!is_array($doc) || !isset($doc['keys']) || !is_array($doc['keys'])) {
        cli_line('FAIL', '.well-known/atlas-key.json is missing or unreadable');
      } else {
        $listed = atlas_key_doc_lists($doc, $pub);
        cli_line($listed ? 'PASS' : 'FAIL', 'the published key document ' . ($listed ? 'lists' : 'does NOT list') . ' the public key of the private key file (' . substr($pub, 0, 12) . '..., ' . count($doc['keys']) . ' key(s) published)');
      }
    }
  }

  echo "\n-- revocation list --\n";
  $rev = cli_revocation_summary();
  if ($rev['state'] === 'missing') {
    cli_line('FAIL', '.well-known/atlas-revocations.json is missing: an existing domain must have one; do not let the issuer start a new one');
  } elseif ($rev['state'] === 'bad') {
    cli_line('FAIL', $rev['message']);
  } else {
    cli_line('PASS', 'valid: ' . $rev['entries'] . ' entries (' . $rev['distinct'] . ' distinct ids, ' . $rev['tagged'] . ' written by journalled replacements), ' . $rev['bytes'] . ' bytes, mode ' . cli_mode(atlas_revocations_file()) . ', owner ' . cli_owner(atlas_revocations_file()));
    $share = $rev['bytes'] / 4194304;
    cli_line($share > 0.8 ? 'WARN' : 'PASS', sprintf('size is %.0f%% of the wallet\'s 4 MiB read limit; %d of the 20000 entries the wallet will examine', $share * 100, $rev['entries']));
    cli_line('INFO', 'sha256 ' . $rev['sha256'] . ' (record it before and after a deployment)');
  }

  echo "\n-- directories the issuer writes to --\n";
  cli_directory('.well-known (atomic replace of the revocation list)', $wk, true, $probe);
  cli_directory('lib (lock files, state files)', $lib, true, $probe);
  $base = atlas_private_base();
  if ($base !== '') {
    cli_line(preg_match('#^(/|[A-Za-z]:[\\\\/])#', $base) && is_dir($base) ? 'PASS' : 'FAIL', 'private state directory configured outside lib/: ' . $base . (is_dir($base) ? (atlas_path_in_docroot($base) ? ' (inside the web root)' : ' (outside the web root)') : ' does not exist'));
  } else {
    cli_line('INFO', 'private state is in lib/ (replay, holdings, txn); set lib/atlas-private-dir.txt to move it outside the web root before first use');
  }
  foreach (['replay', 'holdings', 'txn'] as $name) {
    $dir = atlas_private_subdir($name);
    cli_directory($name . ' (private)', $dir, false, $probe && is_dir($dir));
    if (is_dir($dir)) {
      $mode = cli_mode($dir);
      if ($mode[2] !== '0' || $mode[3] !== '0') cli_line('WARN', $name . ': directory mode ' . $mode . ' lets other accounts list it; 0700 is expected for a directory this code created');
      if (atlas_path_in_docroot($dir) && !is_file($dir . '/.htaccess')) cli_line('WARN', $name . ': no .htaccess of its own (it is written the next time the directory is used)');
    }
  }
  if ($probe) {
    $lock = $lib . '/atlas-preflight-' . bin2hex(random_bytes(4)) . '.lock';
    $fh = @fopen($lock, 'c');
    $ok = $fh !== false && flock($fh, LOCK_EX | LOCK_NB);
    if ($fh !== false) { flock($fh, LOCK_UN); fclose($fh); }
    @unlink($lock);
    cli_line($ok ? 'PASS' : 'FAIL', 'a lock file can be created in lib/ and locked');
  }

  echo "\n-- pending transactions --\n";
  $pending = cli_txn_entries();
  cli_line(count($pending) === 0 ? 'PASS' : 'WARN', count($pending) . ' journal entr' . (count($pending) === 1 ? 'y' : 'ies') . ' pending' . (count($pending) ? ' (php lib/atlas-cli.php txn-list)' : ''));

  echo "\n";
  echo $failures === 0 ? "RESULT: no failures" : "RESULT: $failures failure(s)";
  echo $warnings ? ", $warnings warning(s)\n" : "\n";
  return $failures === 0 ? 0 : 1;
}

function cli_txn_entries() {
  $out = [];
  foreach ((array) @scandir(atlas_txn_dir()) as $name) {
    if (substr($name, -5) !== '.json') continue;
    $out[] = $name;
  }
  return $out;
}

function cli_counts() {
  $rev = cli_revocation_summary();
  echo "revocation list: ";
  if ($rev['state'] !== 'ok') { echo $rev['state'] . (isset($rev['message']) ? ' - ' . $rev['message'] : '') . "\n"; }
  else echo $rev['entries'] . ' entries, ' . $rev['distinct'] . ' distinct, ' . $rev['duplicates'] . ' repeated ids, ' . $rev['tagged'] . ' tagged, ' . $rev['bytes'] . ' bytes, sha256 ' . $rev['sha256'] . "\n";
  $keyDoc = is_file(atlas_public_key_file()) ? json_decode((string) @file_get_contents(atlas_public_key_file()), true) : null;
  echo 'published keys: ' . (is_array($keyDoc) && isset($keyDoc['keys']) ? count($keyDoc['keys']) : 'unreadable') . "\n";
  echo "state files in lib/ (name, bytes, JSON?, top-level entries):\n";
  $files = glob(__DIR__ . '/atlas-*.json') ?: [];
  sort($files);
  foreach ($files as $f) {
    $doc = json_decode((string) @file_get_contents($f), true);
    echo '  ' . str_pad(basename($f), 46) . str_pad((string) filesize($f), 9) . (is_array($doc) ? 'valid   ' . count($doc) : 'INVALID') . "\n";
  }
  foreach (['replay', 'holdings', 'txn'] as $name) {
    $n = 0;
    foreach ((array) @scandir(atlas_private_subdir($name)) as $f) if (substr($f, -5) === '.json') $n++;
    echo '  ' . str_pad($name . '/', 46) . $n . " file(s)\n";
  }
  return 0;
}

function cli_txn_list() {
  $names = cli_txn_entries();
  if (!$names) { echo "no pending transactions\n"; return 0; }
  $exit = 0;
  foreach ($names as $name) {
    $text = @file_get_contents(atlas_txn_dir() . '/' . $name);
    $rec = json_decode((string) $text, true);
    if (!is_array($rec) || !isset($rec['txn'], $rec['key'], $rec['predecessors'], $rec['successors'])) {
      echo substr($name, 0, 12) . "  UNREADABLE (examine by hand; the issuer answers 503 for this request)\n";
      $exit = 1;
      continue;
    }
    try { $state = atlas_txn_state($rec); } catch (Exception $e) { $state = 'unknown (' . $e->getMessage() . ')'; $exit = 1; }
    if ($state === 'inconsistent') $exit = 1;
    $age = isset($rec['createdAt']) ? max(0, time() - (int) strtotime($rec['createdAt'])) : -1;
    echo substr($name, 0, 12) . '  ' . ($rec['op'] ?? '?') . '  ' . $state . '  age ' . ($age >= 0 ? $age . 's' : '?')
      . '  ' . count($rec['predecessors']) . ' spent, ' . count($rec['successors']) . ' new'
      . '  requestId ' . (!empty($rec['requestId']) ? 'yes' : 'no') . "\n";
  }
  return $exit;
}

function cli_txn_recover($force) {
  $dir = atlas_txn_dir();
  if (is_dir($dir) && function_exists('posix_geteuid') && !$force) {
    $owner = @fileowner($dir);
    if ($owner !== false && $owner !== posix_geteuid()) {
      fwrite(STDERR, 'refusing: ' . $dir . ' belongs to ' . cli_owner($dir) . ' but this runs as ' . cli_self() . ". Files written now would not be writable by the web requests. Run it as the account the web server uses, or pass --force.\n");
      return 2;
    }
  }
  $names = cli_txn_entries();
  if (!$names) { echo "no pending transactions\n"; return 0; }
  $exit = 0;
  foreach ($names as $name) {
    $rec = json_decode((string) @file_get_contents($dir . '/' . $name), true);
    if (!is_array($rec) || !isset($rec['key']) || !is_string($rec['key'])) {
      echo substr($name, 0, 12) . "  UNREADABLE - left as found\n";
      $exit = 1;
      continue;
    }
    $busy = atlas_lease('rid', $rec['key'], 0);
    if ($busy !== null) { echo substr($name, 0, 12) . "  in use by a live request - skipped\n"; continue; }
    try {
      $again = atlas_txn_read($rec['key']);
      $result = $again === null ? 'already settled' : atlas_txn_recover($again);
      echo substr($name, 0, 12) . '  ' . $result . "\n";
    } catch (Exception $e) {
      echo substr($name, 0, 12) . '  NOT settled - ' . $e->getMessage() . "\n";
      $exit = 1;
    } finally {
      atlas_lease_release('rid', $rec['key']);
    }
  }
  return $exit;
}

switch ($command) {
  case 'preflight': exit(cli_preflight(in_array('--write-probe', $flags, true)));
  case 'counts': exit(cli_counts());
  case 'txn-list': exit(cli_txn_list());
  case 'txn-recover': exit(cli_txn_recover(in_array('--force', $flags, true)));
  default:
    echo "usage: php lib/atlas-cli.php preflight [--write-probe] | counts | txn-list | txn-recover [--force]\n";
    exit($command === 'help' ? 0 : 2);
}
