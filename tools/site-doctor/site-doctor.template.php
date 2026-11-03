<?php
// Domain Atlas site doctor (template). Do not upload this file: tools/site-doctor-build.js turns it into
// site-doctor.php with the manifest, an access-token hash and an expiry embedded.
//
// What the built file does: after a token check it compares the files below its own folder with the manifest
// (SHA-256, text files with CRLF folded to LF), lists unexpected files, checks the server against what the issuer
// needs, and prints the setup values to copy. It is read-only: nothing is created, changed or sent anywhere. The
// only write is the "delete this file" action, which removes this file. File contents are never shown; private
// state is reported by name, size and mode only and is never opened. PHP 7.2 compatible.

$DOCTOR = null;
/*@@DOCTOR_CONFIG@@*/

if (PHP_SAPI === 'cli') exit("site-doctor.php runs on a web server only.\n");

function doctor_security_headers() {
  header('X-Robots-Tag: noindex, nofollow, noarchive');
  header('Cache-Control: no-store, no-cache, must-revalidate');
  header('Referrer-Policy: no-referrer');
  header('X-Content-Type-Options: nosniff');
  header('X-Frame-Options: DENY');
}

function doctor_json($data, $status = 200) {
  http_response_code($status);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
  exit;
}

function doctor_text_page($status, $text) {
  http_response_code($status);
  header('Content-Type: text/plain; charset=utf-8');
  echo $text . "\n";
  exit;
}

doctor_security_headers();

if (!is_array($DOCTOR) || empty($DOCTOR['tokenSha256']) || empty($DOCTOR['entries']) || !is_array($DOCTOR['entries'])) {
  doctor_text_page(404, 'This is the unbuilt site doctor template. Build the real file with: node tools/site-doctor-build.js <out dir>');
}

$DOCTOR_ROOT = rtrim(str_replace('\\', '/', __DIR__), '/');
$DOCTOR_SELF = basename(__FILE__);
$DOCTOR_EXPIRED = time() > (int)$DOCTOR['expires'];

// ---- helpers --------------------------------------------------------------------------------------------

function doctor_is_text_name($rel) {
  if (preg_match('#(^|/)\.htaccess$#', $rel)) return true;
  return in_array(strtolower(pathinfo($rel, PATHINFO_EXTENSION)), ['php', 'html', 'htm', 'js', 'css', 'json', 'md', 'txt', 'svg', 'xml', 'example'], true);
}

// Entries that apply to the selected site: the issuer's files, plus those of one demo site.
function doctor_applicable($entries, $site) {
  $want = 'i' . ($site === 'a' ? 'a' : ($site === 'b' ? 'b' : ''));
  $out = [];
  foreach ($entries as $e) if (strpbrk($e[5], $want) !== false) $out[] = $e;
  return $out;
}

// One manifest entry against the file on disk. Never follows symlinks.
function doctor_check_entry($root, $e) {
  $p = $e[0]; $hash = $e[1]; $n = (int)$e[2]; $flags = $e[4];
  $path = $root . '/' . $p;
  clearstatcache(true, $path);
  if (is_link($path)) return 'symlink';
  if (!file_exists($path)) return strpos($flags, 'o') !== false ? 'absent-optional' : 'missing';
  if (!is_file($path)) return 'not-file';
  $size = @filesize($path);
  if ($size === false) return 'unreadable';
  $differs = strpos($flags, 'x') !== false ? 'expected-differs' : 'differs';
  if (doctor_is_text_name($p)) {
    if ($size > max(1048576, $n * 4)) return $differs;
    $c = @file_get_contents($path);
    if ($c === false) return 'unreadable';
    $got = hash('sha256', str_replace("\r\n", "\n", $c));
  } else {
    if ($size !== $n) return $differs;
    $got = @hash_file('sha256', $path);
    if ($got === false) return 'unreadable';
  }
  return hash_equals($hash, $got) ? 'ok' : $differs;
}

// Private state: matched by name only, never opened.
function doctor_is_state($rel) {
  return (bool)preg_match('#(^|/)(atlas-[^/]*\.(json|lock)|[^/]*\.pem|[^/]*-lock-[^/]*|\.salt|storage-root\.php|private-dir\.php|atlas-private-dir\.txt|studio-config\.json|[^/]*config[^/]*\.json)$#i', $rel)
    || (bool)preg_match('#(^|/)(replay|holdings|txn)/#', $rel);
}
function doctor_is_host_file($rel) {
  return (bool)preg_match('#(^|/)(error_log|php\.ini|\.user\.ini|\.htaccess|\.ftpquota|cgi-bin|\.well-known/(acme-challenge|pki-validation)/.*)$#', $rel);
}

function doctor_extras($root, $known, $self, $budget) {
  $t0 = microtime(true);
  $skipDirs = ['cgi-bin' => 1, '.git' => 1, 'node_modules' => 1, '.well-known/acme-challenge' => 1, '.well-known/pki-validation' => 1, '.cagefs' => 1, '.tmp' => 1];
  $res = ['state' => [], 'host' => [], 'other' => [], 'otherTotal' => 0, 'scanned' => 0, 'partial' => false];
  $stack = [['', 0]];
  while ($stack) {
    list($rel, $depth) = array_pop($stack);
    $dir = $rel === '' ? $root : $root . '/' . $rel;
    $names = @scandir($dir);
    if ($names === false) continue;
    foreach ($names as $name) {
      if ($name === '.' || $name === '..') continue;
      $r = $rel === '' ? $name : $rel . '/' . $name;
      $full = $root . '/' . $r;
      if (microtime(true) - $t0 > $budget || $res['scanned'] > 40000) { $res['partial'] = true; break 2; }
      if (is_link($full)) {
        if (!isset($known[$r])) { $res['otherTotal']++; if (count($res['other']) < 400) $res['other'][] = $r . ' (symlink)'; }
        continue;
      }
      if (is_dir($full)) {
        if (isset($skipDirs[$r]) || isset($skipDirs[$name]) || $depth >= 12) continue;
        $stack[] = [$r, $depth + 1];
        continue;
      }
      $res['scanned']++;
      if (isset($known[$r]) || $r === $self) continue;
      if (doctor_is_state($r)) {
        $mode = @fileperms($full);
        $res['state'][] = [$r, $mode === false ? '' : substr(sprintf('%o', $mode), -4), (int)@filesize($full)];
      } elseif (doctor_is_host_file($r)) {
        $res['host'][] = $r;
      } else {
        $res['otherTotal']++;
        if (count($res['other']) < 400) $res['other'][] = $r;
      }
    }
  }
  sort($res['other']);
  return $res;
}

function doctor_https() {
  if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') return true;
  if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && strtolower($_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https') return true;
  return isset($_SERVER['SERVER_PORT']) && (int)$_SERVER['SERVER_PORT'] === 443;
}

// The configured Studio private folder without running storage-root.php: env var first, then the file's
// `return "...";` line.
function doctor_studio_root($root) {
  $env = getenv('ATLAS_STUDIO_STORAGE_ROOT');
  if (is_string($env) && $env !== '') return ['env', $env];
  $file = $root . '/atlas/studio/inc/storage-root.php';
  if (!is_file($file) || is_link($file)) return [null, null];
  $src = @file_get_contents($file, false, null, 0, 4096);
  if ($src !== false && preg_match('/(?:^|<\?php)\s*return\s+(["\'])(.*?)\1\s*;/m', $src, $m) && $m[2] !== '' && strpos($m[2], 'CPANELUSER') === false) return ['file', $m[2]];
  return ['file-unreadable', null];
}

function doctor_env($root) {
  $checks = [];
  $add = function ($id, $status, $title, $detail = '', $fix = '') use (&$checks) {
    $checks[] = ['id' => $id, 'status' => $status, 'title' => $title, 'detail' => $detail, 'fix' => $fix];
  };
  $host = isset($_SERVER['HTTP_HOST']) ? $_SERVER['HTTP_HOST'] : '';
  $docroot = isset($_SERVER['DOCUMENT_ROOT']) ? rtrim(str_replace('\\', '/', (string)$_SERVER['DOCUMENT_ROOT']), '/') : '';
  $real = realpath($root);
  $realDoc = $docroot !== '' ? realpath($docroot) : false;
  $parent = dirname($root);

  // PHP and extensions
  if (version_compare(PHP_VERSION, '7.2.0', '<')) $add('php', 'fail', 'PHP ' . PHP_VERSION, 'The issuer needs PHP 7.2 or newer.', 'Choose a newer PHP version for this domain (cPanel: MultiPHP Manager).');
  elseif (version_compare(PHP_VERSION, '8.1.0', '<')) $add('php', 'info', 'PHP ' . PHP_VERSION, 'Works. PHP 8.1 or newer can also flush directory entries to disk (a durability extra, not a failure).');
  else $add('php', 'ok', 'PHP ' . PHP_VERSION);
  foreach ([['openssl', true, 'signing and key handling'], ['json', true, 'all API responses'], ['hash', true, 'hashing'], ['curl', false, 'calls to other domains (trading, federation)']] as $x) {
    if (extension_loaded($x[0])) $add('ext-' . $x[0], 'ok', 'PHP extension ' . $x[0]);
    else $add('ext-' . $x[0], $x[1] ? 'fail' : 'warn', 'PHP extension ' . $x[0] . ' is missing', 'Used for ' . $x[2] . '.', 'Enable it for this domain (cPanel: Select PHP Version, Extensions).');
  }
  $missingFn = [];
  foreach (['random_bytes', 'hash_equals', 'hash_hmac', 'flock', 'openssl_sign', 'openssl_verify', 'openssl_pkey_new'] as $fn) if (!function_exists($fn)) $missingFn[] = $fn;
  if ($missingFn) $add('functions', 'fail', 'PHP functions unavailable: ' . implode(', ', $missingFn), 'Disabled by the host or missing from this PHP build.', 'Ask the host to enable them, or pick another PHP version.');
  else $add('functions', 'ok', 'Required PHP functions are available');

  // Where the file is
  $add('host', $host === '' ? 'warn' : 'info', 'Host name: ' . ($host === '' ? 'unknown' : $host), strpos($host, 'www.') === 0 ? 'Studio compares the exact Host header, so its config must name this spelling (with www).' : '');
  $add('https', doctor_https() ? 'ok' : 'warn', doctor_https() ? 'Served over HTTPS' : 'Not served over HTTPS', doctor_https() ? '' : 'Wallet signatures and Studio origins expect https.', 'Enable HTTPS (cPanel: SSL/TLS Status) and open the site with https://.');
  if ($realDoc !== false && $real !== false && rtrim(str_replace('\\', '/', $real), '/') !== rtrim(str_replace('\\', '/', $realDoc), '/')) {
    $add('docroot', 'warn', 'This file is not in the document root', 'It checks the folder it sits in, not the whole site.', 'Move site-doctor.php to the web root (the folder that contains atlas/ and lib/).');
  } else $add('docroot', 'ok', 'Checking the document root');
  if (ini_get('open_basedir')) $add('open_basedir', 'info', 'open_basedir is set', 'PHP can only reach: ' . ini_get('open_basedir'));

  // Issuer layout and state files
  $has = function ($rel) use ($root) { return file_exists($root . '/' . $rel); };
  foreach (['atlas/trade', 'atlas/asset', 'lib'] as $d) {
    if (!is_dir($root . '/' . $d)) $add('dir-' . $d, 'warn', 'Folder ' . $d . '/ is not here', 'The issuer is not (fully) uploaded to this folder.', 'Upload the missing files listed under "Files compared with the repository".');
  }
  if (is_dir($root . '/lib')) {
    $add('lib-htaccess', $has('lib/.htaccess') ? 'ok' : 'fail', $has('lib/.htaccess') ? 'lib/.htaccess is present' : 'lib/.htaccess is missing', 'It keeps lib/ (which can hold the issuer key) from being served.', 'Upload lib/.htaccess.');
    $add('lib-writable', is_writable($root . '/lib') ? 'ok' : 'warn', is_writable($root . '/lib') ? 'lib/ is writable by PHP' : 'lib/ is not writable by PHP', 'The issuer writes its key and state here unless a separate private folder is configured.', 'Set the folder permission to 0755 and make sure it belongs to your hosting account.');
  }
  if (is_dir($root . '/.well-known')) {
    $add('wk-writable', is_writable($root . '/.well-known') ? 'ok' : 'warn', is_writable($root . '/.well-known') ? '.well-known/ is writable by PHP' : '.well-known/ is not writable by PHP', 'The issuer publishes its public key and revocation list here.', 'Set the folder permission to 0755.');
  } else $add('wk', 'warn', '.well-known/ folder is missing', 'The manifest and the issuer key are published there.', 'Create it, or upload issuer-php/.well-known/.htaccess and your spatial.json.');
  $keyMirror = $has('.well-known/atlas-key.json'); $revoc = $has('.well-known/atlas-revocations.json') || $has('lib/atlas-revocations.json');
  if ($keyMirror && !$revoc) $add('revocations', 'fail', 'Issuer key published but the revocation list is missing', 'The issuer refuses to run in this state so that revoked credentials cannot come back.', 'Restore atlas-revocations.json from a backup; do not delete the key.');
  elseif ($keyMirror) $add('issuer', 'ok', 'Issuer key and revocation list exist (an established issuer)');
  else $add('issuer', 'info', 'No issuer key yet', 'A new issuer creates its key on the first request to an issuing route.');

  // Manifest
  $spatial = $root . '/.well-known/spatial.json';
  $studioHere = is_file($root . '/atlas/studio/api.php');
  if (is_file($spatial)) {
    $m = json_decode((string)@file_get_contents($spatial, false, null, 0, 1048576), true);
    if (!is_array($m)) $add('spatial', 'fail', '.well-known/spatial.json is not valid JSON', '', 'Fix the JSON (a stray comma is the usual cause) or re-upload the file.');
    else {
      $add('spatial', 'ok', '.well-known/spatial.json loads');
      if ($studioHere) {
        $world = null;
        if (isset($m['worlds']) && is_array($m['worlds'])) foreach ($m['worlds'] as $w) if (is_array($w) && isset($w['id']) && $w['id'] === 'studio') $world = $w;
        $wb = is_array($world) && isset($world['policy']['walletBridge']) ? $world['policy']['walletBridge'] : null;
        $okWb = is_array($wb) && !empty($wb['read']) && isset($wb['sign']) && is_array($wb['sign']) && in_array('atlas.studio.mint/1', $wb['sign'], true)
          && isset($wb['offer']) && is_array($wb['offer']) && in_array('atlas.demo.studio.collectible', $wb['offer'], true);
        $add('spatial-studio', $okWb ? 'ok' : 'warn', $okWb ? 'Manifest has the "studio" world' : 'Manifest has no usable "studio" world', $okWb ? '' : 'Without it the wallet will not let the Studio page sign or receive a collectible.', 'Add the studio world shown under "Setup values".');
      }
    }
  } else $add('spatial', 'warn', '.well-known/spatial.json is missing', 'Wallets read the domain manifest from here.', 'Create it from the matching demo domain\'s .well-known/spatial.json and edit it for your domain.');

  // Asset Studio private storage
  $setup = ['host' => $host, 'suggestedRoot' => $parent . '/atlas-studio-data', 'buckets' => ['drafts', 'uploads-quarantine', 'mint-receipts', 'tmp', 'rate'], 'studioHere' => $studioHere, 'spatialWorld' => [
    'id' => 'studio', 'name' => 'Asset Studio', 'policy' => ['walletBridge' => ['read' => true, 'sign' => ['atlas.studio.mint/1'], 'offer' => ['atlas.demo.studio.collectible']]]]];
  if ($studioHere) {
    list($how, $configured) = doctor_studio_root($root);
    $fixRoot = 'Create the folder ' . $setup['suggestedRoot'] . ' (outside the web root) with the five sub-folders listed under "Setup values", then point Studio at it.';
    if ($how === null) $add('studio-root', 'warn', 'Studio storage is not configured', 'Studio stays off until it has a private folder.', $fixRoot);
    elseif ($configured === null) $add('studio-root', 'warn', 'atlas/studio/inc/storage-root.php does not return a usable path', 'It still has the example value or an unreadable format.', $fixRoot);
    else {
      $rr = is_dir($configured) ? realpath($configured) : false;
      if ($rr === false) $add('studio-root', 'fail', 'Studio storage folder does not exist', 'Configured: ' . $configured, 'Create that folder, or correct the path in storage-root.php.');
      else {
        $rrN = rtrim(str_replace('\\', '/', $rr), '/'); $dN = $realDoc !== false ? rtrim(str_replace('\\', '/', $realDoc), '/') : rtrim(str_replace('\\', '/', $root), '/');
        $inside = $rrN === $dN || strpos($rrN . '/', $dN . '/') === 0 || strpos($dN . '/', $rrN . '/') === 0;
        if ($inside) $add('studio-root', 'fail', 'Studio storage is inside (or contains) the web root', 'Configured: ' . $configured, 'Choose a folder outside public_html, for example ' . $setup['suggestedRoot'] . '.');
        elseif (!is_writable($rr)) $add('studio-root', 'fail', 'Studio storage folder is not writable', 'Configured: ' . $configured, 'Make it writable by your hosting account (permission 0755 is usual on cPanel).');
        else {
          $add('studio-root', 'ok', 'Studio storage folder exists, is outside the web root and is writable', 'Configured via ' . ($how === 'env' ? 'environment variable' : 'storage-root.php') . ': ' . $configured);
          $badBuckets = [];
          foreach ($setup['buckets'] as $b) {
            $bp = $rr . '/' . $b;
            if (is_link($bp) || !is_dir($bp) || !is_writable($bp)) $badBuckets[] = $b;
          }
          if ($badBuckets) $add('studio-buckets', 'fail', 'Studio sub-folders missing or not writable: ' . implode(', ', $badBuckets), '', 'Create each as a plain, writable folder inside ' . $configured . '.');
          else $add('studio-buckets', 'ok', 'All five Studio sub-folders exist and are writable');
          $cfgFile = $rr . '/studio-config.json';
          if (!is_file($cfgFile)) $add('studio-config', 'info', 'No studio-config.json: Studio minting is off', '', 'Create it from the "Setup values" block when you want to try minting.');
          else {
            $c = json_decode((string)@file_get_contents($cfgFile, false, null, 0, 8193), true);
            if (!is_array($c)) $add('studio-config', 'fail', 'studio-config.json is not valid JSON', '', 'Fix or recreate it from the "Setup values" block.');
            else {
              $on = isset($c['mintEnabled']) && $c['mintEnabled'] === true;
              $domainOk = isset($c['domain']) && $c['domain'] === $host;
              $origins = isset($c['origins']) && is_array($c['origins']) ? $c['origins'] : ['https://' . (isset($c['domain']) && is_string($c['domain']) ? $c['domain'] : '')];
              $originOk = in_array('https://' . $host, $origins, true) || in_array('http://' . $host, $origins, true);
              $add('studio-config', ($domainOk && $originOk) ? 'ok' : 'warn', 'Studio minting is ' . ($on ? 'ON' : 'off'),
                ($domainOk ? '' : 'The "domain" in studio-config.json is not exactly "' . $host . '". ') . ($originOk ? '' : 'The "origins" list does not include https://' . $host . '. '),
                ($domainOk && $originOk) ? '' : 'Set "domain" to exactly ' . $host . ' and "origins" to ["https://' . $host . '"].');
            }
          }
        }
      }
    }
  }
  return ['checks' => $checks, 'setup' => $setup, 'facts' => [
    'phpVersion' => PHP_VERSION, 'sapi' => PHP_SAPI, 'os' => PHP_OS, 'host' => $host, 'maxExecutionTime' => (string)ini_get('max_execution_time'), 'memoryLimit' => (string)ini_get('memory_limit'),
    'webRoot' => $root, 'home' => $parent],
    'detected' => is_file($root . '/bank-demo.html') ? 'a' : (is_file($root . '/wallet-bridge-demo.html') ? 'b' : 'none')];
}

// ---- request handling --------------------------------------------------------------------------------------

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
  $action = isset($_POST['action']) ? (string)$_POST['action'] : '';
  $given = hash('sha256', strtolower(preg_replace('/[^0-9a-fA-F]/', '', isset($_POST['token']) ? (string)$_POST['token'] : '')));
  if (!hash_equals((string)$DOCTOR['tokenSha256'], $given)) { usleep(1500000); doctor_json(['ok' => false, 'error' => 'bad-token'], 403); }
  @set_time_limit(60);

  if ($action === 'delete') {
    $self = __FILE__;
    $done = @unlink($self);
    clearstatcache(true, $self);
    $gone = $done && !file_exists($self);
    doctor_json(['ok' => true, 'deleted' => $gone, 'note' => $gone ? 'site-doctor.php has been deleted.' : 'The file could not be deleted from here. Delete ' . $DOCTOR_SELF . ' with your file manager.']);
  }
  if ($DOCTOR_EXPIRED) doctor_json(['ok' => false, 'error' => 'expired', 'note' => 'This check has expired. Delete the file, or build a new one.'], 410);

  if ($action === 'env') {
    $env = doctor_env($DOCTOR_ROOT);
    $env['ok'] = true;
    $env['meta'] = ['commit' => $DOCTOR['commit'], 'built' => $DOCTOR['built'], 'clean' => !empty($DOCTOR['clean']), 'entries' => count($DOCTOR['entries'])];
    doctor_json($env);
  }
  if ($action === 'scan') {
    $site = isset($_POST['site']) && in_array($_POST['site'], ['a', 'b'], true) ? $_POST['site'] : 'none';
    $list = doctor_applicable($DOCTOR['entries'], $site);
    $cursor = max(0, (int)(isset($_POST['cursor']) ? $_POST['cursor'] : 0));
    $t0 = microtime(true);
    $results = []; $counts = [];
    $i = $cursor;
    for ($n = count($list); $i < $n && microtime(true) - $t0 < 6.0; $i++) {
      $st = doctor_check_entry($DOCTOR_ROOT, $list[$i]);
      $counts[$st] = (isset($counts[$st]) ? $counts[$st] : 0) + 1;
      if ($st !== 'ok' && $st !== 'absent-optional') $results[] = [$list[$i][0], $st, $list[$i][3]];
    }
    doctor_json(['ok' => true, 'total' => count($list), 'next' => $i < count($list) ? $i : null, 'results' => $results, 'counts' => $counts]);
  }
  if ($action === 'extras') {
    $known = [];
    foreach ($DOCTOR['entries'] as $e) $known[$e[0]] = true;
    $r = doctor_extras($DOCTOR_ROOT, $known, $DOCTOR_SELF, 10.0);
    $r['ok'] = true;
    doctor_json($r);
  }
  doctor_json(['ok' => false, 'error' => 'unknown-action'], 400);
}

// ---- page --------------------------------------------------------------------------------------------------

$nonce = base64_encode(random_bytes(16));
header("Content-Security-Policy: default-src 'none'; script-src 'nonce-$nonce'; style-src 'nonce-$nonce'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
header('Content-Type: text/html; charset=utf-8');
$meta = json_encode(['commit' => $DOCTOR['commit'], 'built' => $DOCTOR['built'], 'expires' => (int)$DOCTOR['expires'], 'expired' => $DOCTOR_EXPIRED, 'self' => $DOCTOR_SELF],
  JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT);
$page = <<<'ATLAS_DOCTOR_PAGE'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Site Doctor</title>
<style nonce="__NONCE__">
:root { --bg:#f6f7f9; --panel:#fff; --text:#1b1f24; --muted:#5b6570; --line:#d9dee4; --ok:#1a7f37; --warn:#9a6700; --fail:#c62828; --info:#0b5cad; --accent:#0b5cad; }
@media (prefers-color-scheme: dark) { :root { --bg:#12161b; --panel:#1b2128; --text:#e6eaee; --muted:#9aa5b1; --line:#2d3641; --ok:#4cc275; --warn:#e0b030; --fail:#ff7b72; --info:#6cb2ff; --accent:#6cb2ff; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
main { max-width:900px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:17px; margin:0; }
.sub { color:var(--muted); margin:0 0 20px; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; margin:14px 0; }
details.card > summary { cursor:pointer; list-style:none; display:flex; gap:10px; align-items:center; }
details.card > summary::-webkit-details-marker { display:none; }
details.card[open] > summary { margin-bottom:12px; }
label { display:block; margin:4px 0; }
input[type=text], input[type=password] { width:100%; padding:10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); font:inherit; font-family:ui-monospace,Consolas,monospace; }
button { padding:9px 16px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:#fff; font:inherit; cursor:pointer; }
button.secondary { background:transparent; color:var(--accent); }
button.danger { background:var(--fail); border-color:var(--fail); }
button:disabled { opacity:.5; cursor:default; }
.row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-top:10px; }
.pill { display:inline-block; min-width:2.2em; padding:1px 9px; border-radius:99px; font-size:13px; text-align:center; color:#fff; }
.pill.ok { background:var(--ok); } .pill.warn { background:var(--warn); } .pill.fail { background:var(--fail); } .pill.info { background:var(--info); }
.item { padding:8px 0; border-top:1px solid var(--line); } .item:first-child { border-top:0; }
.item .t { font-weight:600; } .item .d { color:var(--muted); font-size:14px; } .item .f { font-size:14px; margin-top:2px; }
.item.ok .t { font-weight:400; }
pre { margin:6px 0; padding:10px; background:var(--bg); border:1px solid var(--line); border-radius:8px; overflow:auto; font:13px/1.4 ui-monospace,Consolas,monospace; white-space:pre-wrap; word-break:break-all; }
code { font-family:ui-monospace,Consolas,monospace; font-size:13px; }
ul.paths { margin:6px 0; padding-left:20px; columns:1; } ul.paths li { word-break:break-all; font-family:ui-monospace,Consolas,monospace; font-size:13px; }
.banner { font-size:17px; font-weight:600; }
.muted { color:var(--muted); } .hidden { display:none !important; }
.notice { border-left:4px solid var(--warn); padding:6px 12px; background:var(--bg); border-radius:4px; margin:10px 0; }
</style>
</head>
<body>
<main>
<h1>Site Doctor</h1>
<p class="sub" id="sub"></p>

<div class="card" id="login">
  <p id="loginIntro">Paste the access token from <code>ACCESS.txt</code>. The check only reads files; nothing on this site is changed.</p>
  <label for="token">Access token</label>
  <input type="password" id="token" autocomplete="off" spellcheck="false" placeholder="xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx">
  <div class="row"><button id="go">Start check</button><span id="loginMsg" class="muted"></span></div>
</div>

<div id="app" class="hidden">
  <div class="card">
    <div class="banner" id="verdict">Checking…</div>
    <div class="muted" id="progress"></div>
    <div class="row">
      <span>This domain serves:</span>
      <label><input type="radio" name="site" value="none"> Issuer only</label>
      <label><input type="radio" name="site" value="a"> Demo site A</label>
      <label><input type="radio" name="site" value="b"> Demo site B</label>
      <button class="secondary" id="rerun">Check again</button>
    </div>
  </div>
  <div id="sections"></div>
  <div class="card">
    <h2>When you are done</h2>
    <p class="muted">Copy the report to share it (home and web-root folder names are replaced), then delete this file. Do not leave it on the server.</p>
    <div class="row">
      <button class="secondary" id="copy">Copy report</button>
      <button class="secondary" id="copyMissing">Copy list of files to upload</button>
      <button class="danger" id="del">Delete this file</button>
    </div>
    <p id="doneMsg" class="muted"></p>
  </div>
</div>
<noscript><div class="card">This page needs JavaScript.</div></noscript>
</main>
<script type="application/json" id="meta">__META__</script>
<script nonce="__NONCE__">
(function () {
  'use strict';
  var META = JSON.parse(document.getElementById('meta').textContent);
  var token = '';
  var state = null;
  var $ = function (id) { return document.getElementById(id); };
  var GROUP = { c: 'Code', p: 'Pages and configuration', a: 'Assets (models and images)' };
  var PROBES = [
    ['/lib/store.php', 'issuer library'], ['/lib/bootstrap.php', 'issuer library'], ['/lib/issuer-private-key.pem', 'issuer private key'],
    ['/lib/.htaccess', 'lib access rules'], ['/atlas/studio/inc/studio-mint.php', 'Studio helper'], ['/atlas/studio/inc/storage.php', 'Studio helper'],
    ['/atlas/studio/inc/storage-root.php', 'Studio storage setting'], ['/atlas/demo/txlab/inc/private-dir.php', 'Transaction Lab setting']
  ];

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === 'text') n.textContent = attrs[k]; else if (k === 'class') n.className = attrs[k]; else n.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function pill(s, t) { return el('span', { 'class': 'pill ' + s, text: t || ({ ok: 'OK', warn: '!', fail: 'X', info: 'i' })[s] }); }

  function fmt(ts) { return new Date(ts * 1000).toLocaleString(); }
  $('sub').textContent = 'Read-only comparison of this domain with Domain Atlas commit ' + META.commit + ' (built ' + META.built.slice(0, 10) + '). ' +
    (META.expired ? 'This check has expired.' : 'Valid until ' + fmt(META.expires) + '.');
  if (META.expired) {
    $('loginIntro').textContent = 'This check has expired and will not run. Paste the token to delete this file, or delete it in your file manager.';
    $('go').textContent = 'Continue';
  }

  function call(action, extra) {
    var body = new URLSearchParams();
    body.set('action', action); body.set('token', token);
    for (var k in (extra || {})) body.set(k, extra[k]);
    return fetch(location.pathname, { method: 'POST', body: body, cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'http-' + r.status }; }).then(function (j) { j.httpStatus = r.status; return j; });
    });
  }

  function step(msg) { $('progress').textContent = msg; }

  function currentSite() { var r = document.querySelector('input[name=site]:checked'); return r ? r.value : 'none'; }

  var envCache = null;
  function full(first) {
    $('rerun').disabled = true; $('verdict').textContent = 'Checking…';
    var st = { missing: [], differs: [], expected: [], odd: [], counts: {}, total: 0, extras: null, probes: [], env: envCache };
    var chain = Promise.resolve();
    if (first) {
      chain = chain.then(function () { step('Checking the server…'); return call('env'); }).then(function (env) {
        if (!env.ok) { var e = new Error(env.error || 'failed'); e.status = env.httpStatus; throw e; }
        envCache = env; st.env = env;
        var r = document.querySelector('input[name=site][value=' + env.detected + ']'); if (r) r.checked = true;
      });
    }
    chain = chain.then(function () {
      var site = currentSite();
      function more(cursor) {
        return call('scan', { site: site, cursor: String(cursor) }).then(function (j) {
          if (!j.ok) throw new Error(j.error || 'scan-failed');
          st.total = j.total;
          Object.keys(j.counts).forEach(function (k) { st.counts[k] = (st.counts[k] || 0) + j.counts[k]; });
          j.results.forEach(function (r) {
            var o = { path: r[0], group: r[2] };
            if (r[1] === 'missing') st.missing.push(o);
            else if (r[1] === 'differs') st.differs.push(o);
            else if (r[1] === 'expected-differs') st.expected.push(o);
            else { o.what = r[1]; st.odd.push(o); }
          });
          var done = j.next === null ? j.total : j.next;
          step('Comparing files: ' + done + ' of ' + j.total + '…');
          return j.next === null ? null : more(j.next);
        });
      }
      return more(0);
    }).then(function () { step('Looking for unexpected files…'); return call('extras'); })
      .then(function (x) { if (!x.ok) throw new Error(x.error || 'extras-failed'); st.extras = x; step('Checking what the web can read…'); return probes(); })
      .then(function (pr) { st.probes = pr; });
    return chain.then(function () { state = st; render(); }).catch(function (e) {
      $('verdict').textContent = 'The check could not finish: ' + (e && e.message ? e.message : e);
      step('');
    }).then(function () { $('rerun').disabled = false; });
  }

  function probes() {
    return Promise.all(PROBES.map(function (p) {
      return fetch(p[0], { cache: 'no-store', redirect: 'manual', credentials: 'omit' }).then(function (r) {
        if (r.status !== 200) return { path: p[0], what: p[1], exposed: false, status: r.status };
        return r.text().then(function (t) {
          var leak = /<\?php|PRIVATE KEY|\/home\//.test(t.slice(0, 4000));
          return { path: p[0], what: p[1], exposed: leak, status: 200, empty: t.length === 0 };
        });
      }).catch(function () { return { path: p[0], what: p[1], exposed: false, status: 0 }; });
    }));
  }

  // ---- rendering ----
  function section(title, status, summary, open, body) {
    var d = el('details', { 'class': 'card' });
    if (open) d.setAttribute('open', '');
    d.appendChild(el('summary', null, [pill(status), el('h2', { text: title }), el('span', { 'class': 'muted', text: summary || '' })]));
    body.forEach(function (b) { d.appendChild(b); });
    $('sections').appendChild(d);
  }
  function item(status, title, detail, fix) {
    return el('div', { 'class': 'item ' + status }, [el('div', { 'class': 't' }, [pill(status), ' ', title]), detail ? el('div', { 'class': 'd', text: detail }) : null, fix ? el('div', { 'class': 'f', text: 'To do: ' + fix }) : null]);
  }
  function pathList(arr) { var u = el('ul', { 'class': 'paths' }); arr.forEach(function (p) { u.appendChild(el('li', { text: p })); }); return u; }
  function groupBlocks(list, label) {
    var out = [];
    ['c', 'p', 'a'].forEach(function (g) {
      var sub = list.filter(function (x) { return x.group === g; });
      if (!sub.length) return;
      out.push(el('div', { 'class': 'item' }, [el('div', { 'class': 't', text: label + ' - ' + GROUP[g] + ' (' + sub.length + ')' }), pathList(sub.map(function (x) { return x.path + (x.what ? '  [' + x.what + ']' : ''); }))]));
    });
    return out;
  }

  function todo() {
    var t = [];
    var codeMissing = state.missing.filter(function (x) { return x.group === 'c'; });
    var pageMissing = state.missing.filter(function (x) { return x.group === 'p'; });
    var codeDiffers = state.differs.filter(function (x) { return x.group === 'c'; });
    if (codeMissing.length) t.push(['fail', 'Upload ' + codeMissing.length + ' missing code file(s). The issuer or Studio will not work without them.', 'See "Files compared with the repository".']);
    if (codeDiffers.length) t.push(['fail', 'Re-upload ' + codeDiffers.length + ' code file(s) that differ from the repository.', 'An old or edited copy is the usual cause of "internal-error" responses.']);
    if (pageMissing.length) t.push(['warn', 'Upload ' + pageMissing.length + ' missing page/config file(s).', '']);
    var pageDiffers = state.differs.filter(function (x) { return x.group === 'p'; });
    if (pageDiffers.length) t.push(['warn', pageDiffers.length + ' page/config file(s) differ from the repository.', 'Fine if you edited them on purpose; otherwise re-upload.']);
    state.odd.forEach(function (o) { t.push(['warn', 'Not a regular file: ' + o.path + ' (' + o.what + ')', 'Replace it with the repository file.']); });
    state.probes.forEach(function (p) { if (p.exposed) t.push(['fail', 'Readable over the web: ' + p.path, 'Block it (check the .htaccess in that folder is uploaded and honoured) and treat any secret in it as exposed.']); });
    (state.env ? state.env.checks : []).forEach(function (c) { if (c.status === 'fail' || c.status === 'warn') t.push([c.status, c.title, c.fix || c.detail]); });
    return t;
  }

  function render() {
    $('sections').textContent = '';
    var env = state.env;
    var c = state.counts;
    var problems = todo();
    var fails = problems.filter(function (x) { return x[0] === 'fail'; }).length;
    var warns = problems.length - fails;
    $('verdict').textContent = fails ? fails + ' problem(s) to fix' + (warns ? ', ' + warns + ' to look at' : '') : (warns ? 'No blocking problems; ' + warns + ' thing(s) to look at' : 'Everything checked matches');
    step((state.total - (c.missing || 0) - (c.differs || 0) - (c['absent-optional'] || 0) - (c['expected-differs'] || 0) - (c.symlink || 0) - (c['not-file'] || 0) - (c.unreadable || 0)) + ' of ' + state.total + ' files match the repository' +
      (c['absent-optional'] ? ' (' + c['absent-optional'] + ' optional file(s) not present)' : '') + '.');

    var kids = [];
    if (!problems.length) kids.push(el('p', { text: 'Nothing to do.' }));
    problems.forEach(function (x) { kids.push(item(x[0], x[1], x[2])); });
    section('To do', fails ? 'fail' : (warns ? 'warn' : 'ok'), problems.length ? problems.length + ' item(s)' : 'all clear', problems.length > 0, kids);

    var checks = env.checks.map(function (x) { return item(x.status, x.title, x.detail, x.fix); });
    var worst = env.checks.some(function (x) { return x.status === 'fail'; }) ? 'fail' : (env.checks.some(function (x) { return x.status === 'warn'; }) ? 'warn' : 'ok');
    section('Server and setup', worst, env.facts.host + ' - PHP ' + env.facts.phpVersion, false, checks);

    var fileBody = [];
    fileBody = fileBody.concat(groupBlocks(state.missing, 'Missing'), groupBlocks(state.differs, 'Different'));
    if (state.expected.length) fileBody.push(el('div', { 'class': 'item' }, [el('div', { 'class': 't', text: 'Different on purpose (site-specific, ' + state.expected.length + ')' }), pathList(state.expected.map(function (x) { return x.path; }))]));
    if (state.odd.length) fileBody.push(el('div', { 'class': 'item' }, [el('div', { 'class': 't', text: 'Not regular files (' + state.odd.length + ')' }), pathList(state.odd.map(function (x) { return x.path + ' [' + x.what + ']'; }))]));
    if (!fileBody.length) fileBody.push(el('p', { text: 'Every file in the manifest is present and identical.' }));
    var fileStatus = state.missing.some(function (x) { return x.group !== 'a'; }) || state.differs.some(function (x) { return x.group === 'c'; }) ? 'fail' : (state.missing.length || state.differs.length || state.odd.length ? 'warn' : 'ok');
    section('Files compared with the repository', fileStatus, state.total + ' checked, ' + state.missing.length + ' missing, ' + state.differs.length + ' different', fileStatus !== 'ok', fileBody);

    var x = state.extras, xb = [];
    xb.push(el('p', { 'class': 'muted', text: 'Files here that are not in the repository. Your own models, pages and hosting files are normal; this is only for awareness.' }));
    if (x.other.length) xb.push(el('div', { 'class': 'item' }, [el('div', { 'class': 't', text: 'Unknown files (' + x.otherTotal + (x.otherTotal > x.other.length ? ', first ' + x.other.length + ' shown' : '') + ')' }), pathList(x.other)]));
    if (x.state.length) xb.push(el('div', { 'class': 'item' }, [el('div', { 'class': 't', text: 'Private state - listed by name only, never opened (' + x.state.length + ')' }), pathList(x.state.map(function (s) { return s[0] + '  [mode ' + s[1] + ', ' + s[2] + ' bytes]'; }))]));
    if (x.host.length) xb.push(el('div', { 'class': 'item' }, [el('div', { 'class': 't', text: 'Hosting files (' + x.host.length + ')' }), pathList(x.host)]));
    if (x.partial) xb.push(el('p', { 'class': 'notice', text: 'The scan stopped early (time or size limit), so this list is incomplete.' }));
    section('Unexpected files', 'info', x.scanned + ' files scanned', false, xb);

    var pb = state.probes.map(function (p) {
      return item(p.exposed ? 'fail' : 'ok', p.path, p.exposed ? 'The ' + p.what + ' can be read over the web.' : 'Not readable (' + (p.status ? 'HTTP ' + p.status : 'no response') + (p.empty ? ', empty page' : '') + ').');
    });
    section('What the web can read', state.probes.some(function (p) { return p.exposed; }) ? 'fail' : 'ok', 'private helper files must not be served', false, pb);

    section('Setup values (copy and paste)', 'info', 'for Asset Studio', false, setupBlocks(env.setup));
  }

  function setupBlocks(s) {
    var q = function (v) { return JSON.stringify(v, null, 2); };
    return [
      el('p', { 'class': 'muted', text: 'The doctor never creates these for you. Create them in your file manager, then run the check again.' }),
      el('div', { 'class': 'item' }, [el('div', { 'class': 't', text: '1. Private folder (outside the web root) with these sub-folders' }), pre(s.suggestedRoot + '/\n' + s.buckets.map(function (b) { return '    ' + b + '/'; }).join('\n'))]),
      el('div', { 'class': 'item' }, [el('div', { 'class': 't', text: '2. atlas/studio/inc/storage-root.php' }), pre('<?php\nreturn ' + JSON.stringify(s.suggestedRoot) + ';')]),
      el('div', { 'class': 'item' }, [el('div', { 'class': 't', text: '3. studio-config.json inside the private folder (minting stays off until you change false to true)' }), pre(q({ mintEnabled: false, domain: s.host, origins: ['https://' + s.host] }))]),
      el('div', { 'class': 'item' }, [el('div', { 'class': 't', text: '4. World to add to the "worlds" list in .well-known/spatial.json' }), pre(q(s.spatialWorld))])
    ];
  }
  function pre(t) { return el('pre', { text: t }); }

  // ---- report ----
  function redact(text) {
    var f = (state && state.env && state.env.facts) || {};
    var out = text;
    if (f.webRoot) out = out.split(f.webRoot).join('<webroot>');
    if (f.home) out = out.split(f.home).join('<home>');
    return out;
  }
  function report() {
    var env = state.env, c = state.counts, lines = [];
    lines.push('Site Doctor report - manifest commit ' + META.commit + ', host ' + env.facts.host + ', PHP ' + env.facts.phpVersion);
    lines.push($('verdict').textContent + '. ' + $('progress').textContent, '');
    var t = todo();
    lines.push('TO DO'); if (!t.length) lines.push('  nothing'); t.forEach(function (x) { lines.push('  [' + x[0] + '] ' + x[1] + (x[2] ? ' - ' + x[2] : '')); });
    lines.push('', 'SERVER'); env.checks.forEach(function (x) { lines.push('  [' + x.status + '] ' + x.title + (x.detail ? ' - ' + x.detail : '')); });
    lines.push('', 'MISSING (' + state.missing.length + ')'); state.missing.forEach(function (x) { lines.push('  ' + x.path); });
    lines.push('', 'DIFFERENT (' + state.differs.length + ')'); state.differs.forEach(function (x) { lines.push('  ' + x.path); });
    lines.push('', 'WEB EXPOSURE'); state.probes.forEach(function (p) { lines.push('  ' + (p.exposed ? 'EXPOSED ' : 'ok      ') + p.path + ' (HTTP ' + p.status + ')'); });
    lines.push('', 'UNKNOWN FILES (' + state.extras.otherTotal + ')'); state.extras.other.slice(0, 100).forEach(function (x) { lines.push('  ' + x); });
    return redact(lines.join('\n'));
  }
  function copy(text, done) {
    var fallback = function () { var ta = el('textarea', { text: text, style: 'position:fixed;left:-9999px' }); document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(true); } catch (e) { done(false); } document.body.removeChild(ta); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done(true); }, fallback); else fallback();
  }
  function said(ok, what) { $('doneMsg').textContent = ok ? what + ' copied.' : 'Copy failed; select the text on the page instead.'; }

  // ---- events ----
  function start() {
    token = $('token').value.trim();
    if (!token) { $('loginMsg').textContent = 'Paste the token first.'; return; }
    $('go').disabled = true; $('loginMsg').textContent = 'Checking the token…';
    if (META.expired) {
      call('delete').then(function (j) {
        $('go').disabled = false;
        $('loginMsg').textContent = j.ok ? (j.note || 'Done.') : 'Token not accepted.';
      });
      return;
    }
    $('app').classList.remove('hidden');
    full(true).then(function () {
      $('go').disabled = false;
      if (!state) {
        $('app').classList.add('hidden');
        $('loginMsg').textContent = /bad-token/.test($('verdict').textContent) ? 'Token not accepted.' : $('verdict').textContent;
      } else { $('login').classList.add('hidden'); }
    });
  }
  $('go').addEventListener('click', start);
  $('token').addEventListener('keydown', function (e) { if (e.key === 'Enter') start(); });
  $('rerun').addEventListener('click', function () { full(false); });
  Array.prototype.forEach.call(document.querySelectorAll('input[name=site]'), function (r) { r.addEventListener('change', function () { full(false); }); });
  $('copy').addEventListener('click', function () { if (state) copy(report(), function (ok) { said(ok, 'Report'); }); });
  $('copyMissing').addEventListener('click', function () {
    if (!state) return;
    var list = state.missing.concat(state.differs).map(function (x) { return x.path; });
    copy(list.length ? list.join('\n') : 'Nothing to upload.', function (ok) { said(ok, 'File list'); });
  });
  $('del').addEventListener('click', function () {
    if (!window.confirm('Delete ' + META.self + ' from the server now?')) return;
    call('delete').then(function (j) {
      $('doneMsg').textContent = j.note || (j.ok ? 'Done.' : 'Not accepted.');
      if (j.ok && j.deleted) { ['del', 'rerun', 'copy', 'copyMissing'].forEach(function (id) { $(id).disabled = true; }); }
    });
  });
})();
</script>
</body>
</html>
ATLAS_DOCTOR_PAGE;
echo str_replace(['__NONCE__', '__META__'], [$nonce, $meta], $page);
