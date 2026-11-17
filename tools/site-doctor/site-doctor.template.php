<?php
// Domain Atlas site doctor (template). Do not upload this file: tools/site-doctor-build.js turns it into
// site-doctor.php with the manifest, an access-token hash and an expiry embedded.
//
// What the built file does: after a token check it compares the files below its own folder with the manifest
// (SHA-256, text files with CRLF folded to LF), lists unexpected files, checks the server against what the issuer
// needs, and prints the setup values to copy. It is read-only: nothing is created, changed or sent anywhere. The
// only write is the "delete this file" action, which removes this file. File contents are never shown; private
// state is reported by name, size and mode. A few files are opened only to be counted or checked for valid JSON
// (the revocation and suspension lists, holdings records, the administrator key list) and only counts and sizes
// leave this file; the administrator session store is never opened. PHP 7.2 compatible.

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
  return (bool)preg_match('#(^|/)(atlas-[^/]*\.(json|lock)|[^/]*\.pem|[^/]*-lock-[^/]*|\.salt|storage-root\.php|private-dir\.php|atlas-private-dir\.txt|studio-config\.json|[^/]*\.sqlite|[^/]*config[^/]*\.json|lib/config\.php(\.off|\.bak)?)$#i', $rel)
    || (bool)preg_match('#(^|/)(replay|holdings|mint-allowance|txn|state)/#', $rel);
}
function doctor_is_host_file($rel) {
  return (bool)preg_match('#(^|/)(error_log|php\.ini|\.user\.ini|\.htaccess|\.ftpquota|cgi-bin|\.well-known/(acme-challenge|pki-validation)/.*)$#', $rel);
}

// Lists of many files in one folder are summarised as "folder/ [N files]".
function doctor_collapse($paths, $limit) {
  $byDir = [];
  foreach ($paths as $r) { $d = dirname($r); $byDir[$d === '.' ? '' : $d][] = $r; }
  $out = [];
  foreach ($byDir as $d => $list) {
    if (count($list) > $limit) $out[] = ($d === '' ? '' : $d . '/') . ' [' . count($list) . ' files]';
    else foreach ($list as $r) $out[] = $r;
  }
  sort($out);
  return $out;
}

// For an unknown PHP file: size, date, and whether a repository file has the same name (a misplaced copy) and
// the same content. The content is only hashed, never shown.
function doctor_php_info($root, $r, $byBase) {
  $full = $root . '/' . $r;
  $t = @filemtime($full);
  $info = ['p' => $r, 'size' => (int)@filesize($full), 'date' => $t ? date('Y-m-d', $t) : '', 'like' => null, 'same' => false];
  $b = basename($r);
  if (isset($byBase[$b])) {
    $info['like'] = $byBase[$b][0][0];
    if ($info['size'] <= 1048576) {
      $c = @file_get_contents($full);
      if ($c !== false) {
        $h = hash('sha256', str_replace("\r\n", "\n", $c));
        foreach ($byBase[$b] as $e) if (hash_equals($e[1], $h)) { $info['like'] = $e[0]; $info['same'] = true; break; }
      }
    }
  }
  return $info;
}

function doctor_extras($root, $known, $self, $budget, $byBase) {
  $t0 = microtime(true);
  $skipDirs = ['cgi-bin' => 1, '.git' => 1, 'node_modules' => 1, '.well-known/acme-challenge' => 1, '.well-known/pki-validation' => 1, '.cagefs' => 1, '.tmp' => 1];
  $scanned = 0; $partial = false;
  $state = []; $host = []; $other = []; $php = [];
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
      if (microtime(true) - $t0 > $budget || $scanned > 40000) { $partial = true; break 2; }
      if (is_link($full)) {
        if (!isset($known[$r])) $other[] = $r . ' (symlink)';
        continue;
      }
      if (is_dir($full)) {
        if (isset($skipDirs[$r]) || isset($skipDirs[$name]) || $depth >= 12) continue;
        $stack[] = [$r, $depth + 1];
        continue;
      }
      $scanned++;
      if (isset($known[$r]) || $r === $self) continue;
      if (doctor_is_state($r)) {
        $mode = @fileperms($full);
        $state[] = [$r, $mode === false ? '' : substr(sprintf('%o', $mode), -4), (int)@filesize($full)];
      } elseif (doctor_is_host_file($r)) {
        $host[] = $r;
      } elseif (preg_match('/\.(php|phtml|php[3-8])$/i', $r)) {
        $php[] = $r;
      } else {
        $other[] = $r;
      }
    }
  }
  // Private state: lock files become one line per folder (the issuer creates up to 64 empty ones per kind and
  // they are meant to stay empty), and a state folder with more than a few files becomes one line.
  $groups = []; $single = []; $locks = [];
  foreach ($state as $s) {
    if (preg_match('#(^|/)[^/]*(\.lock|-lock-[^/]*)$#i', $s[0])) {
      $d = dirname($s[0]) === '.' ? '' : dirname($s[0]) . '/';
      if (!isset($locks[$d])) $locks[$d] = [0, 0];
      $locks[$d][0]++; $locks[$d][1] += $s[2];
    }
    elseif (preg_match('#^(.*?(?:^|/)(?:replay|holdings|mint-allowance|txn|state)/)#', $s[0], $m)) $groups[$m[1]][] = $s; else $single[] = $s;
  }
  foreach ($locks as $d => $l) $single[] = [$d . '*.lock', '', $l[0], 'locks', $l[1]];
  foreach ($groups as $key => $list) {
    if (count($list) > 3) $single[] = [$key, '', count($list), 'dir']; else foreach ($list as $s) $single[] = $s;
  }
  usort($single, function ($x, $y) { return strcmp($x[0], $y[0]); });
  sort($php);
  sort($host);
  return ['state' => $single, 'host' => $host, 'other' => doctor_collapse($other, 10), 'otherTotal' => count($other),
    'php' => array_map(function ($r) use ($root, $byBase) { return doctor_php_info($root, $r, $byBase); }, array_slice($php, 0, 300)), 'phpTotal' => count($php), 'scanned' => $scanned, 'partial' => $partial];
}

function doctor_https() {
  if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') return true;
  if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && strtolower($_SERVER['HTTP_X_FORWARDED_PROTO']) === 'https') return true;
  return isset($_SERVER['SERVER_PORT']) && (int)$_SERVER['SERVER_PORT'] === 443;
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
  foreach (['atlas/asset', 'lib'] as $d) {
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
    'id' => 'studio', 'name' => 'Asset Studio', 'policy' => ['walletBridge' => ['read' => true, 'sign' => ['atlas.studio.mint/1', 'atlas.studio.quota/1'], 'offer' => ['atlas.demo.studio.collectible']]]]];
  if ($studioHere) {
    list($how, $configured) = atlas_sf_studio_root($root);
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
    // Most demo pages are on both domains; the wallet bridge demo is only on site B and the pinned-spot listing only on site A.
    'detected' => is_file($root . '/wallet-bridge-demo.html') ? 'b' : (is_file($root . '/compass-listing.html') ? 'a' : 'none'),
    'detectedMods' => (is_file($root . '/atlas/call/info.php') ? 'c' : '') . (is_file($root . '/presence/status.php') ? 'p' : '')];
}

/*@@SITE_FEATURES@@*/

// ---- manifest ----------------------------------------------------------------------------------------------
// Reads this domain's own .well-known/spatial.json (public by design) and reports its worlds, the effective
// policy of each (a world's own value wins, the manifest's top level fills in: SPEC 3.4.1), and the mistakes that
// are certain: broken references, a missing scene file, an unreadable manifest. Everything else is shown as
// information. Strings are clipped, lists are capped, and nothing in it is executed or fetched from the network.

function doctor_val($v) {
  if ($v === true) return 'yes';
  if ($v === false) return 'no';
  if ($v === null) return 'not set';
  if (is_int($v) || is_float($v)) return (string)$v;
  if (is_string($v)) return atlas_sf_clip($v, 60);
  if (is_array($v)) {
    if (!atlas_sf_is_list($v)) return 'an object';
    if (!$v) return 'none';
    $names = [];
    foreach (array_slice($v, 0, 8) as $x) $names[] = is_string($x) ? atlas_sf_clip($x, 50) : '(invalid)';
    return count($v) . ': ' . implode(', ', $names) . (count($v) > 8 ? ', ...' : '');
  }
  return '(invalid)';
}

function doctor_scene_path($root, $scene) {
  if (!is_string($scene) || $scene === '' || strlen($scene) > 300) return [null, 'none'];
  if (preg_match('#^[a-z][a-z0-9+.-]*:#i', $scene) || strpos($scene, '//') === 0) return [null, 'external'];
  $p = preg_replace('/[?#].*$/', '', $scene);
  if ($p === '' || strpos($p, "\0") !== false || preg_match('#(^|/)\.\.(/|$)#', $p)) return [null, 'bad'];
  return [$root . '/' . ltrim($p, '/'), 'local'];
}

function doctor_manifest($root, $host) {
  $res = ['state' => 'ok', 'size' => 0, 'anchor' => 'none', 'top' => [], 'worlds' => [], 'problems' => []];
  $path = $root . '/.well-known/spatial.json';
  $P = function ($level, $text) use (&$res) { if (count($res['problems']) < 80) $res['problems'][] = [$level, $text]; };
  if (is_link($path) || !is_file($path)) { $res['state'] = 'missing'; $P('warn', 'There is no .well-known/spatial.json, so this domain declares no space (fine if that is intended).'); return $res; }
  $res['size'] = (int)@filesize($path);
  $raw = atlas_sf_small_file($path, 2097152);
  if ($raw === false) { $res['state'] = 'unreadable'; $P('fail', '.well-known/spatial.json could not be read' . ($res['size'] > 2097152 ? ' (it is larger than 2 MB)' : '') . '.'); return $res; }
  $m = json_decode($raw, true);
  if (!is_array($m) || atlas_sf_is_list($m)) { $res['state'] = 'invalid'; $P('fail', '.well-known/spatial.json is not a valid JSON object (' . atlas_sf_clip(json_last_error_msg(), 80) . '). Clients ignore it.'); return $res; }
  if ($res['size'] > 524288) $P('warn', 'The manifest is ' . round($res['size'] / 1024) . ' KB; every visitor and directory downloads it, so keep it small.');

  // domain level
  $domain = isset($m['domain']) && is_string($m['domain']) ? $m['domain'] : null;
  $hasKey = isset($m['identityKey']) && is_string($m['identityKey']) && $m['identityKey'] !== '';
  $res['anchor'] = $domain !== null && $hasKey ? 'domain, with a pinned identity key' : ($domain !== null ? 'domain' : ($hasKey ? 'identity key (no domain)' : 'none'));
  if ($domain === null && !$hasKey) $P('fail', 'The manifest has neither "domain" nor "identityKey", so clients cannot tell who it belongs to.');
  elseif ($domain !== null && $host !== '' && $domain !== $host) $P('warn', '"domain" is "' . atlas_sf_clip($domain, 80) . '" but this site is served as "' . atlas_sf_clip($host, 80) . '". A client that fetched this file from here may refuse it.');
  if ($domain === null && $hasKey && empty($m['signature'])) $P('fail', 'A key-anchored manifest (identityKey, no domain) must carry a "signature". It is not verified here.');
  if (isset($m['spec']) && (!is_string($m['spec']) || !preg_match('#^domain-atlas/\d+\.\d+$#', $m['spec']))) $P('warn', '"spec" should look like domain-atlas/1.0.');
  $top = [];
  $top[] = 'spec: ' . (isset($m['spec']) ? doctor_val($m['spec']) : 'not set');
  $top[] = 'domain: ' . ($domain !== null ? atlas_sf_clip($domain, 80) : 'not set') . '  (anchor: ' . $res['anchor'] . ')';
  if (isset($m['owner']) && is_array($m['owner']) && isset($m['owner']['name'])) $top[] = 'owner: ' . doctor_val($m['owner']['name']);
  $top[] = 'updated: ' . (isset($m['updated']) ? doctor_val($m['updated']) : 'not set');
  $top[] = 'default world: ' . (isset($m['defaultWorld']) ? doctor_val($m['defaultWorld']) : 'not set');
  $top[] = 'size: ' . round($res['size'] / 1024, 1) . ' KB';
  foreach (['chat' => 'chat (domain-wide)', 'tradingStation' => 'trading station', 'calendar' => 'calendar (domain-wide)'] as $k => $label) if (array_key_exists($k, $m)) $top[] = $label . ': ' . doctor_val($m[$k]);
  foreach (['acceptedItemClasses' => 'accepted item classes (default for every world)', 'walletBridge' => 'wallet bridge (default)', 'trustedIssuers' => 'trusted issuers (default)'] as $k => $label) if (array_key_exists($k, $m)) $top[] = $label . ': ' . ($k === 'walletBridge' && is_array($m[$k]) ? 'read ' . doctor_val(isset($m[$k]['read']) ? $m[$k]['read'] : null) : doctor_val($m[$k]));
  // Service declarations that say a membership credential is needed (SPEC.md section 3.9).
  foreach (['postOffice', 'mailRelay', 'chat', 'inWorldChat', 'voiceCalling', 'assetStudio', 'chainLabs', 'scanner', 'tradingStation', 'directory', 'calendar', 'domainMembership'] as $svc) {
    if (!isset($m[$svc]) || !is_array($m[$svc]) || !array_key_exists('requiresCredential', $m[$svc])) continue;
    $d = $m[$svc];
    if ($d['requiresCredential'] !== true) { $P('warn', '"' . $svc . '.requiresCredential" is not exactly true, so it says nothing. Use true, or remove it.'); continue; }
    $cls = isset($d['credentialClass']) ? $d['credentialClass'] : null;
    if (!is_string($cls) || strlen($cls) > 128 || !preg_match('/^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9-]*){1,6}$/', $cls)) $P('warn', '"' . $svc . '" says it requires a credential but "credentialClass" is missing or is not a class name such as atlas.postoffice.membership, so wallets ignore it.');
    if (empty($d['enabled']) || $d['enabled'] !== true) $P('warn', '"' . $svc . '" has requiresCredential but "enabled" is not true, so the service is not advertised at all.');
  }
  if (isset($m['worldDropPolicy'])) $top[] = 'world drop policy: set';
  if (isset($m['emailTickets']) && is_array($m['emailTickets'])) $top[] = 'email tickets: intake address ' . (!empty($m['emailTickets']['intakeAddress']) ? 'set' : 'not set');
  if (array_key_exists('fileTransfer', $m)) $top[] = 'file transfer: ' . (is_array($m['fileTransfer']) && isset($m['fileTransfer']['classes']) && is_array($m['fileTransfer']['classes']) ? 'classes ' . doctor_val($m['fileTransfer']['classes']) : 'every eligible class');
  $res['top'] = $top;

  // cross-checks with what is installed on this domain
  if (!empty($m['emailTickets']['intakeAddress']) && is_file($root . '/lib/email-tickets.php')) {
    $e = atlas_sf_feature_email_tickets($root, ['file' => 'lib/atlas-email-tickets-config.json'], $host);
    if ($e[0] === 'off') $P('warn', 'The manifest advertises an email intake address, but email delivery is not configured here (lib/atlas-email-tickets-config.json). See Features.');
    elseif (in_array('incoming (IMAP): off', $e[2], true)) $P('warn', 'The manifest advertises an email intake address, but IMAP (incoming) is not configured, so nothing reads that mailbox.');
  }
  if (array_key_exists('fileTransfer', $m) && !is_file($root . '/atlas/asset/transfer-to-file.php')) $P('warn', 'The manifest opts into "fileTransfer", but atlas/asset/transfer-to-file.php is not on this domain.');

  // worlds
  if (!isset($m['worlds']) || !is_array($m['worlds']) || !atlas_sf_is_list($m['worlds'])) { $P('fail', '"worlds" must be a list (even for a single world).'); return $res; }
  if (!$m['worlds']) $P('warn', '"worlds" is empty, so there is nothing to enter.');
  $ids = []; $enterable = [];
  foreach (array_slice($m['worlds'], 0, 200) as $i => $w) {
    if (!is_array($w) || !isset($w['id']) || !is_string($w['id']) || $w['id'] === '') { $P('fail', 'World #' . ($i + 1) . ' has no text "id".'); continue; }
    if (isset($ids[$w['id']])) $P('fail', 'Two worlds share the id "' . atlas_sf_clip($w['id'], 60) . '"; links to it are ambiguous.');
    if (preg_match('/[\s:#]/', $w['id'])) $P('warn', 'World id "' . atlas_sf_clip($w['id'], 60) . '" contains a space, colon or #, which the page link syntax (#world:anchor) cannot express.');
    $ids[$w['id']] = true;
    $enterable[$w['id']] = isset($w['entry']) && is_array($w['entry']);
  }
  if (count($m['worlds']) > 200) $P('warn', 'Only the first 200 worlds were checked.');
  if (isset($m['defaultWorld'])) {
    if (!is_string($m['defaultWorld']) || !isset($ids[$m['defaultWorld']])) $P('fail', '"defaultWorld" names "' . atlas_sf_clip(is_string($m['defaultWorld']) ? $m['defaultWorld'] : '(not text)', 60) . '", which is not in "worlds".');
    elseif (!$enterable[$m['defaultWorld']]) $P('fail', '"defaultWorld" is a world with no "entry", which a client can never enter.');
  } elseif (count($ids) > 1) $P('warn', 'There is more than one world and no "defaultWorld", so a plain visit has no obvious destination.');

  $anyKey = is_file($root . '/.well-known/atlas-key.json');
  foreach (array_slice($m['worlds'], 0, 200) as $i => $w) {
    if (!is_array($w) || !isset($w['id']) || !is_string($w['id']) || $w['id'] === '') continue;
    $id = atlas_sf_clip($w['id'], 60);
    $name = isset($w['name']) && is_string($w['name']) ? atlas_sf_clip($w['name'], 80) : '';
    $facts = []; $portals = [];
    $wp = function ($level, $text) use ($P, $id) { $P($level, 'World "' . $id . '": ' . $text); };

    // entry
    $scene = 'none'; $playable = false;
    if (isset($w['entry'])) {
      if (!is_array($w['entry'])) $wp('warn', '"entry" is not an object.');
      else {
        $playable = true;
        $sc = isset($w['entry']['scene']) ? $w['entry']['scene'] : null;
        list($file, $kind) = doctor_scene_path($root, $sc);
        if ($kind === 'none') { $wp('warn', '"entry.scene" is missing.'); $scene = 'no scene'; }
        elseif ($kind === 'external') $scene = 'external: ' . atlas_sf_clip($sc, 80);
        elseif ($kind === 'bad') { $wp('warn', '"entry.scene" is not a usable path.'); $scene = 'bad path'; }
        elseif (is_link($file) || !is_file($file)) { $wp('warn', 'the scene file ' . atlas_sf_clip($sc, 100) . ' is not on this domain (fine only if a rewrite rule serves it).'); $scene = atlas_sf_clip($sc, 100) . ' - MISSING'; }
        else {
          $scene = atlas_sf_clip($sc, 100) . ' - ' . (int)@filesize($file) . ' bytes';
          if (preg_match('/\.json$/i', $file)) {
            list($ss, $sd) = atlas_sf_json_doc($file, 1048576);
            if ($ss === 'invalid') { $wp('warn', 'the scene file is not valid JSON.'); $scene .= ', NOT VALID JSON'; }
            elseif ($ss === 'ok') { $n = isset($sd['objects']) && is_array($sd['objects']) ? count($sd['objects']) : 0; $a = isset($sd['anchors']) && is_array($sd['anchors']) ? count($sd['anchors']) : 0; $scene .= ', ' . $n . ' object(s), ' . $a . ' anchor(s)'; }
          }
        }
        $r = isset($w['entry']['renderer']) ? $w['entry']['renderer'] : null;
        if (!is_array($r) || !$r || !atlas_sf_is_list($r)) $wp('warn', '"entry.renderer" should be a non-empty list.');
        else $facts[] = 'renderers: ' . doctor_val($r);
      }
    } else $scene = 'no entry (policy only, not enterable)';
    $facts[] = 'scene: ' . $scene;

    // effective policy
    $pol = isset($w['policy']) && is_array($w['policy']) ? $w['policy'] : [];
    $eff = function ($key) use ($pol, $m) {
      if (array_key_exists($key, $pol)) return [$pol[$key], ''];
      if (array_key_exists($key, $m)) return [$m[$key], ' (domain default)'];
      return [null, ''];
    };
    foreach (['guestAccess' => 'guest access', 'discoverable' => 'discoverable', 'identityRequired' => 'identity required', 'itemDropsAllowed' => 'item drops allowed', 'acceptedItemClasses' => 'accepted item classes', 'trustedIssuers' => 'trusted issuers'] as $k => $label) {
      list($v, $src) = $eff($k);
      if ($v === null && !array_key_exists($k, $pol) && !array_key_exists($k, $m)) { $facts[] = $label . ': not set'; continue; }
      $facts[] = $label . ': ' . doctor_val($v) . $src;
      if ($k === 'guestAccess' && !in_array($v, ['open', 'invite-only', 'private', 'closed'], true)) $wp('warn', '"guestAccess" must be open, invite-only, private or closed.');
      if (in_array($k, ['discoverable', 'identityRequired', 'itemDropsAllowed'], true) && !is_bool($v)) $wp('warn', '"' . $k . '" must be true or false.');
      if ($k === 'acceptedItemClasses') {
        $bad = !is_array($v) || !atlas_sf_is_list($v);
        if (!$bad) foreach ($v as $c) if (!is_string($c) || $c === '') $bad = true;
        if ($bad) $wp('warn', '"acceptedItemClasses" must be a list of class names.');
      }
      if ($k === 'trustedIssuers') {
        $ok = $v === 'any' || $v === 'self' || (is_array($v) && atlas_sf_is_list($v));
        if (!$ok) $wp('warn', '"trustedIssuers" must be "any", "self" or a list of issuer domains.');
        elseif ($v === 'self' && !$anyKey) $wp('warn', 'trusts only its own issuer, but this domain has no published issuer key (.well-known/atlas-key.json).');
      }
    }
    list($wb, $wbSrc) = $eff('walletBridge');
    if ($wb !== null) {
      if (!is_array($wb) || (isset($wb['read']) && !is_bool($wb['read']))) $wp('warn', '"walletBridge" must look like {"read": true}.');
      else $facts[] = 'wallet bridge: read ' . doctor_val(isset($wb['read']) ? $wb['read'] : null) . $wbSrc . (isset($wb['sign']) ? ', signing: ' . doctor_val($wb['sign']) : '');
    }
    $chat = !empty($w['chat']) || !empty($m['chat']);
    $facts[] = 'chat: ' . ($chat ? 'on' : 'off') . '   calendar: ' . (!empty($w['calendar']) ? 'this world has its own' : 'none of its own');
    if (isset($w['profile']) && is_array($w['profile'])) {
      $pr = $w['profile'];
      $cap = isset($pr['capabilities']) && is_array($pr['capabilities']) ? $pr['capabilities'] : [];
      $parts = [];
      foreach (['building', 'vehicles', 'combat', 'landOwnership'] as $k) if (array_key_exists($k, $cap)) $parts[] = $k . ' ' . doctor_val($cap[$k]);
      $facts[] = 'profile: ' . (isset($pr['genre']) ? doctor_val($pr['genre']) : '?') . ', scale ' . (isset($pr['scale']) ? doctor_val($pr['scale']) : '?') . ($parts ? ' (' . implode(', ', $parts) . ')' : '');
      if (isset($pr['scale']) && !in_array($pr['scale'], ['room', 'building', 'district', 'planet', 'system', 'galaxy'], true)) $wp('warn', 'profile "scale" is not one of room, building, district, planet, system, galaxy.');
    }

    // portals
    if (isset($w['portals'])) {
      if (!is_array($w['portals']) || !atlas_sf_is_list($w['portals'])) $wp('warn', '"portals" must be a list.');
      else foreach (array_slice($w['portals'], 0, 60) as $pi => $po) {
        if (!is_array($po)) { $wp('warn', 'portal #' . ($pi + 1) . ' is not an object.'); continue; }
        $kind = isset($po['kind']) && is_string($po['kind']) ? $po['kind'] : '';
        $to = isset($po['to']) && is_string($po['to']) ? $po['to'] : '';
        $label = isset($po['label']) && is_string($po['label']) ? atlas_sf_clip($po['label'], 60) : '';
        $state = 'ok';
        if ($kind === 'world') {
          if ($to === '' || !isset($ids[$to])) { $state = 'BROKEN: no world "' . atlas_sf_clip($to, 40) . '"'; $wp('fail', 'portal "' . $label . '" leads to world "' . atlas_sf_clip($to, 40) . '", which does not exist.'); }
          elseif (!$enterable[$to]) { $state = 'leads to a world with no entry'; $wp('warn', 'portal "' . $label . '" leads to "' . atlas_sf_clip($to, 40) . '", which has no "entry" and cannot be entered.'); }
        } elseif ($kind === 'domain') {
          $mf = isset($po['manifest']) && is_string($po['manifest']) ? $po['manifest'] : '';
          $mh = $mf !== '' ? parse_url($mf) : false;
          if ($to === '' || $mf === '') { $state = 'needs "to" and "manifest"'; $wp('warn', 'domain portal "' . $label . '" needs both "to" and "manifest".'); }
          elseif (!is_array($mh) || !isset($mh['scheme'], $mh['host']) || !in_array($mh['scheme'], ['http', 'https'], true)) { $state = 'manifest is not a web address'; $wp('warn', 'domain portal "' . $label . '" has a "manifest" that is not an http(s) address.'); }
          else {
            $mhost = $mh['host'] . (isset($mh['port']) ? ':' . $mh['port'] : '');
            if ($mhost !== $to) { $state = 'manifest host differs from "to"'; $wp('warn', 'domain portal "' . $label . '" names "' . atlas_sf_clip($to, 60) . '" but its manifest is on "' . atlas_sf_clip($mhost, 60) . '".'); }
            elseif ($mh['scheme'] !== 'https') $state = 'plain http (blocked by strict clients)';
          }
        } elseif ($kind === 'key') {
          if (empty($po['identityKey']) || empty($po['manifest'])) { $state = 'needs "identityKey" and "manifest"'; $wp('warn', 'key portal "' . $label . '" needs "identityKey" and "manifest".'); }
        } else { $state = 'unknown kind'; $wp('warn', 'portal "' . $label . '" has an unknown kind "' . atlas_sf_clip($kind, 20) . '" (use world, domain or key).'); }
        $portals[] = ($kind === '' ? '?' : $kind) . ' -> ' . atlas_sf_clip($kind === 'key' ? (isset($po['identityKey']) && is_string($po['identityKey']) ? substr($po['identityKey'], 0, 12) . '...' : '?') : $to, 60) . ($label !== '' ? '  "' . $label . '"' : '') . ($state === 'ok' ? '' : '  [' . $state . ']');
      }
      if (count($w['portals']) > 60) $portals[] = '... ' . (count($w['portals']) - 60) . ' more';
    }
    $res['worlds'][] = ['id' => $id, 'name' => $name, 'default' => isset($m['defaultWorld']) && $m['defaultWorld'] === $w['id'], 'playable' => $playable, 'facts' => $facts, 'portals' => $portals];
  }
  return $res;
}

// ---- housekeeping, permissions and administrator-side checks -----------------------------------------------
// Every check here reads metadata (names, sizes, modes, dates) and a few JSON files to count or validate them.
// Nothing from those files is shown except counts and sizes: no credential id, no key, no token. Files that hold
// bearer tokens (the administrator session store) are never opened, only their modification date is read.

function doctor_bytes($v) {
  $v = trim((string)$v);
  if ($v === '') return 0;
  if ($v === '-1') return -1;
  $n = (float)$v;
  $u = strtolower(substr($v, -1));
  if ($u === 'g') $n *= 1073741824; elseif ($u === 'm') $n *= 1048576; elseif ($u === 'k') $n *= 1024;
  return (int)$n;
}
function doctor_size($n) {
  if ($n >= 1048576) return round($n / 1048576, 1) . ' MB';
  if ($n >= 1024) return round($n / 1024) . ' KB';
  return (int)$n . ' bytes';
}
function doctor_mode($path) {
  $m = @fileperms($path);
  return $m === false ? null : ($m & 0777);
}
function doctor_modestr($m) { return sprintf('%04o', $m); }

// A JSON file: [status, document, size]. Status is missing, unreadable, too-big (not parsed), invalid or ok.
function doctor_json_file($path, $maxParse) {
  if (is_link($path) || !is_file($path)) return ['missing', null, 0];
  $size = (int)@filesize($path);
  if ($size > $maxParse) return ['too-big', null, $size];
  $c = @file_get_contents($path);
  if ($c === false) return ['unreadable', null, $size];
  $d = json_decode($c, true);
  return [is_array($d) ? 'ok' : 'invalid', is_array($d) ? $d : null, $size];
}

function doctor_private_base($root) {
  $env = getenv('ATLAS_PRIVATE_DIR');
  if (is_string($env) && $env !== '') return rtrim($env, '/\\');
  $c = atlas_sf_small_file($root . '/lib/atlas-private-dir.txt', 4096);
  return is_string($c) ? rtrim(trim($c), '/\\') : '';
}

// ---- permission scan ----------------------------------------------------------------------------------------
// Looks at modes only (never opens a file), skips symlinks, and stops at a time and entry limit so a huge state
// folder cannot cause a timeout. What counts as a problem:
//   - any file or folder that every account on the server can write (a PHP file, .htaccess or settings file can
//     be rewritten to run someone else's code; a state file can be edited to forge a balance or un-revoke a
//     credential; a folder lets them add files);
//   - a key, settings file or private state file that every account can read;
//   - group-writable items whose group is not one this account trusts.
// Public files under .well-known are meant to be readable, so for them only write access matters. The
// .htaccess and index.html placeholders that keep a folder from being listed are meant to be readable too. Ordinary
// hosting modes (files 0644, folders 0755, PHP files 0644 or 0640, group-readable) are never reported.

function doctor_perm_kind($rel) {
  $b = basename($rel);
  if (preg_match('#(^|/)\.well-known/#', $rel)) return 'wk';
  if (preg_match('#(^|/)(replay|holdings|mint-allowance|txn|state)/#', $rel)) return 'state';
  // A route that happens to be called config.php is code; the settings files named config.php live in a lib/ folder.
  if (preg_match('/^config\.php(\.off|\.bak)?$/i', $b) && basename(dirname($rel)) === 'lib') return 'secret';
  if (preg_match('/\.pem$|-config\.json$|^\.salt$/i', $b) || preg_match('/^atlas-admin-.*\.json$/', $b)) return 'secret';
  if (preg_match('/\.(php|phtml|php[3-8])$/i', $b)) return 'code';
  if ($b === '.htaccess' || $b === '.user.ini' || $b === 'php.ini') return 'conf';
  return null;
}

// One bounded walk below $start (an absolute folder); $label is its name in the report. Appends risky entries to
// $out as [kind, relPath, mode, gid]; a folder is [ 'dir', relPath, mode, gid, holdsCode, inStateFolder ].
function doctor_perm_walk($start, $label, $skipAbs, $deadline, &$left, &$out, &$seen, &$partial, $forceState) {
  $skipNames = ['cgi-bin' => 1, '.git' => 1, 'node_modules' => 1, 'acme-challenge' => 1, 'pki-validation' => 1, '.cagefs' => 1, '.tmp' => 1];
  $stack = [[$start, $label, 0]];
  while ($stack) {
    list($dir, $rel, $depth) = array_pop($stack);
    $names = @scandir($dir);
    if ($names === false) continue;
    $hasCode = false;
    foreach ($names as $name) {
      if ($name === '.' || $name === '..') continue;
      if ($left <= 0 || microtime(true) > $deadline) { $partial = true; break 2; }
      $left--;
      $full = $dir . '/' . $name;
      $r = $rel === '' ? $name : $rel . '/' . $name;
      if (is_link($full)) continue;
      if (is_dir($full)) {
        if ($depth >= 12 || isset($skipNames[$name]) || isset($skipAbs[$full])) continue;
        $stack[] = [$full, $r, $depth + 1];
        continue;
      }
      $m = @fileperms($full);
      if ($m === false) continue;
      $m &= 0777;
      $seen['files']++;
      $kind = $forceState ? 'state' : doctor_perm_kind($r);
      if ($kind === null) continue;
      if ($kind === 'code' || $kind === 'conf' || $kind === 'secret') $hasCode = true;
      if (($m & 0002) || ($m & 0020) || (($m & 0004) && ($kind === 'secret' || $kind === 'state') && !preg_match('/^(\.htaccess|index\.html?)$/i', $name))) {
        $g = @filegroup($full);
        $out[] = [$kind, $r, $m, $g === false ? -1 : $g];
      }
    }
    $seen['dirs']++;
    $dm = @fileperms($dir);
    if ($dm !== false && $rel !== '') {
      $dm &= 01777;
      // A sticky shared folder (like /tmp) only lets an account change its own files, so its world bit is not a risk.
      if ($dm & 01000) $dm &= ~0002;
      if (($dm & 0002) || ($dm & 0020)) {
        $g = @filegroup($dir);
        $out[] = ['dir', $rel, $dm & 0777, $g === false ? -1 : $g, $hasCode, $forceState];
      }
    }
  }
}

function doctor_gname($gid) {
  if ($gid < 0) return 'an unknown group';
  if (function_exists('posix_getgrgid')) { $g = @posix_getgrgid($gid); if (is_array($g) && isset($g['name'])) return 'group "' . $g['name'] . '"'; }
  return 'group id ' . $gid;
}

// Group ids whose write access is accepted: this account's own group (the doctor file's), the PHP process's
// group, and any the doctor was built to trust.
function doctor_trusted_gids($names) {
  $ok = []; $unresolved = [];
  $own = @filegroup(__FILE__);
  if ($own !== false) $ok[$own] = true;
  if (function_exists('posix_getegid')) $ok[posix_getegid()] = true;
  foreach ($names as $t) {
    $t = (string)$t;
    if (preg_match('/^\d+$/', $t)) { $ok[(int)$t] = true; continue; }
    $g = function_exists('posix_getgrnam') ? @posix_getgrnam($t) : false;
    if (is_array($g) && isset($g['gid'])) $ok[$g['gid']] = true; else $unresolved[] = $t;
  }
  return [$ok, $unresolved];
}

function doctor_perm_list($items) {
  $lines = [];
  foreach (array_slice($items, 0, 8) as $i) $lines[] = $i[0] . ' (' . $i[1] . ')';
  return implode(', ', $lines) . (count($items) > 8 ? ', and ' . (count($items) - 8) . ' more' : '');
}

// $reported: absolute paths the checks before this already report on, so nothing is said twice.
function doctor_perm_checks($root, $base, $reported, $trustedNames, $add) {
  $out = []; $seen = ['files' => 0, 'dirs' => 0]; $partial = false; $statePartial = false;
  $stateSeen = ['files' => 0, 'dirs' => 0];
  // Private state first, with its own allowance, so a large web root cannot starve it.
  $stateDirs = [];
  foreach (['holdings', 'replay', 'txn'] as $n) { $stateDirs[$root . '/lib/' . $n] = 'lib/' . $n; if ($base !== '') $stateDirs[$base . '/' . $n] = '<private>/' . $n; }
  $stateLeft = 6000; $stateDeadline = microtime(true) + 3.0; $stateOut = [];
  foreach ($stateDirs as $abs => $label) {
    if (!is_dir($abs) || is_link($abs)) continue;
    doctor_perm_walk($abs, $label, [], $stateDeadline, $stateLeft, $stateOut, $stateSeen, $statePartial, true);
    $m = @fileperms($abs);
    if ($m !== false && (($m & 0002) || ($m & 0020))) { $g = @filegroup($abs); $stateOut[] = ['dir', $label, $m & 0777, $g === false ? -1 : $g, false, true]; }
  }
  $left = 40000; $deadline = microtime(true) + 5.0;
  doctor_perm_walk($root, '', $stateDirs, $deadline, $left, $out, $seen, $partial, false);
  list($trusted, $unresolved) = doctor_trusted_gids($trustedNames);

  $w = ['code' => [], 'dir' => [], 'state' => [], 'wk' => []]; $readable = ['secret' => [], 'state' => []]; $groupHits = [];
  foreach (array_merge($stateOut, $out) as $e) {
    $kind = $e[0]; $rel = $e[1]; $m = $e[2]; $gid = $e[3];
    $inState = $kind === 'dir' && !empty($e[5]);
    if (!$inState && isset($reported[$root . '/' . $rel])) continue;
    $ms = doctor_modestr($m);
    if ($inState) $bucket = 'state';
    elseif ($kind === 'dir') $bucket = 'dir';
    elseif ($kind === 'conf' || $kind === 'secret') $bucket = 'code';
    else $bucket = $kind;
    $label = (strlen($rel) > 150 ? substr($rel, 0, 147) . '...' : $rel) . ($kind === 'dir' ? '/' : '');
    if ($m & 0002) { $w[$bucket][] = [$label, $ms]; continue; }
    if (($m & 0004) && ($kind === 'secret' || $kind === 'state')) $readable[$kind][] = [$label, $ms];
    if (($m & 0020) && $gid >= 0 && !isset($trusted[$gid])) {
      $sensitive = $kind !== 'dir' || $inState || !empty($e[4]) || preg_match('#(^|/)(lib|\.well-known)$#', $rel);
      if ($sensitive) $groupHits[$gid][] = [$label, $ms];
    }
  }
  $problems = 0;
  if ($w['code']) { $problems++; $add('permissions', 'perm-code', 'fail', count($w['code']) . ' PHP, .htaccess or settings file(s) can be rewritten by any account on this server', doctor_perm_list($w['code']) . '. Anyone who can write to a PHP file can make your site run their code.', 'Set PHP files and .htaccess to 0644 (0640 also works), and settings files that hold secrets to 0600, in your file manager.'); }
  if ($w['dir']) { $problems++; $add('permissions', 'perm-dirs', 'fail', count($w['dir']) . ' folder(s) can be written by any account on this server', doctor_perm_list($w['dir']) . '. Anyone who can write to a folder can add a PHP file to it.', 'Set them to 0755 (0750 also works) in your file manager.'); }
  if ($w['state']) { $problems++; $add('permissions', 'perm-state-writable', 'fail', count($w['state']) . ' private state file(s) or folder(s) can be changed by any account on this server', doctor_perm_list($w['state']) . '. Holdings, replay and transaction records decide who owns what; editing them can forge a balance.', 'Set files to 0600 and folders to 0700 (0755 also works) in your file manager.'); }
  if ($w['wk']) { $problems++; $add('permissions', 'perm-wellknown', 'fail', count($w['wk']) . ' file(s) in .well-known can be rewritten by any account on this server', doctor_perm_list($w['wk']) . '. These publish your issuer key, manifest and revocation list; changing the revocation list would un-revoke credentials.', 'Set them to 0644 (readable by everyone is correct here; writable only by you).'); }
  if ($readable['state']) { $problems++; $add('permissions', 'perm-state-readable', 'warn', count($readable['state']) . ' private state file(s) are readable by other accounts', doctor_perm_list($readable['state']) . '. The issuer itself writes these as 0600; 0644 means they were changed or copied.', 'Set them to 0600 in your file manager.'); }
  if ($readable['secret']) { $problems++; $add('permissions', 'perm-secret-readable', 'warn', count($readable['secret']) . ' key or settings file(s) are readable by other accounts', doctor_perm_list($readable['secret']) . '. On shared hosting other accounts on the same server may be able to read them.', 'Set them to 0600 (0640 if your host needs the group) in your file manager.'); }
  foreach ($groupHits as $gid => $items) {
    $problems++;
    $g = function_exists('posix_getgrgid') ? @posix_getgrgid($gid) : false;
    $add('permissions', 'perm-group', 'warn', count($items) . ' sensitive item(s) are writable by ' . doctor_gname($gid) . ', which is not this account\'s own group', doctor_perm_list($items) . '. Group write is fine when only you are in the group; here the group is neither this account\'s group nor the PHP process\'s group, so other accounts may be in it.', 'Remove group write (chmod g-w: 0644 for files, 0755 for folders, 0600 for secrets), or if you trust the group, rebuild the doctor with --trusted-groups ' . (is_array($g) && isset($g['name']) ? $g['name'] : $gid) . '.');
  }
  if ($unresolved) $add('permissions', 'perm-group-names', 'info', 'Trusted group(s) could not be looked up here: ' . implode(', ', $unresolved), 'This server does not offer group name lookups, so only numeric ids and this account\'s own group can be trusted.', 'Rebuild the doctor with the numeric group id in --trusted-groups.');
  if (!$problems) $add('permissions', 'perm-scan', 'ok', 'PHP code, .htaccess, settings, private state and .well-known have no unsafe permissions', ($seen['files'] + $stateSeen['files']) . ' file(s) and ' . ($seen['dirs'] + $stateSeen['dirs']) . ' folder(s) looked at, including ' . $stateSeen['files'] . ' private state file(s). Public files in .well-known may be readable by everyone; that is intended.');
  if ($partial || $statePartial) $add('permissions', 'perm-limit', 'info', 'The permission scan stopped at its time or size limit', ($statePartial ? 'The private state folders hold more files than one check looks at (' . $stateSeen['files'] . ' looked at). ' : '') . ($partial ? 'The web root is large; ' . $seen['files'] . ' files were looked at. ' : '') . 'The report says so rather than guessing; clear out old files and run it again if you need full coverage.');
}

function doctor_health($root, $host, $trustedGroups = []) {
  $checks = [];
  $add = function ($group, $id, $status, $title, $detail = '', $fix = '') use (&$checks) {
    $checks[] = ['group' => $group, 'id' => $id, 'status' => $status, 'title' => $title, 'detail' => $detail, 'fix' => $fix];
  };
  $now = time();
  $lib = $root . '/lib';
  $wk = $root . '/.well-known';
  $isWin = DIRECTORY_SEPARATOR === '\\';

  // -- housekeeping: the two public lists
  list($st, $doc, $size) = doctor_json_file($wk . '/atlas-revocations.json', 6291456);
  if ($st === 'invalid' || $st === 'unreadable') {
    $add('housekeeping', 'revocations-json', 'fail', 'The revocation list cannot be read (' . $st . ')', 'The issuer refuses to run rather than treat it as empty.', 'Restore .well-known/atlas-revocations.json from a backup. Do not delete it.');
  } elseif ($st === 'too-big') {
    $add('housekeeping', 'revocations-size', 'warn', 'The revocation list is very large: ' . doctor_size($size), 'It is read in full on every credential check and every wallet download.', 'Ask before pruning: an entry may only be dropped once that credential has expired anyway.');
  } elseif ($st === 'ok') {
    $list = isset($doc['revoked']) && is_array($doc['revoked']) ? $doc['revoked'] : null;
    if ($list === null) $add('housekeeping', 'revocations-json', 'fail', 'The revocation list has no "revoked" list', '', 'Restore .well-known/atlas-revocations.json from a backup.');
    else {
      $bad = 0; $seen = [];
      foreach ($list as $e) {
        $id = is_array($e) && isset($e['id']) && is_string($e['id']) ? $e['id'] : (is_string($e) ? $e : null);
        if ($id === null) $bad++; else $seen[$id] = true;
      }
      $dups = count($list) - $bad - count($seen);
      $detail = count($list) . ' entries, ' . doctor_size($size) . ($bad ? '; ' . $bad . ' entries have no id' : '') . ($dups > 0 ? '; ' . $dups . ' repeated' : '') . '.';
      if ($size >= 1048576) $add('housekeeping', 'revocations-size', 'warn', 'The revocation list is large: ' . doctor_size($size), $detail . ' It is read in full on every credential check and every wallet download.', 'Ask before pruning: an entry may only be dropped once that credential has expired anyway.');
      elseif ($bad) $add('housekeeping', 'revocations-json', 'warn', 'The revocation list has entries without an id', $detail, 'Check the file against a backup.');
      else $add('housekeeping', 'revocations-json', 'ok', 'Revocation list is valid JSON', $detail);
    }
  }
  list($st, $doc, $size) = doctor_json_file($wk . '/atlas-suspensions.json', 6291456);
  if ($st === 'invalid' || $st === 'unreadable' || $st === 'too-big') {
    $add('housekeeping', 'suspensions-json', 'fail', 'The suspension list cannot be read (' . $st . ')', 'Suspended credentials may not be enforced.', 'Restore .well-known/atlas-suspensions.json from a backup, or replace it with {"suspended": []} if nothing is suspended.');
  } elseif ($st === 'ok') {
    $list = isset($doc['suspended']) && is_array($doc['suspended']) ? $doc['suspended'] : null;
    if ($list === null) $add('housekeeping', 'suspensions-json', 'fail', 'The suspension list has no "suspended" list', '', 'Restore it from a backup, or replace it with {"suspended": []} if nothing is suspended.');
    else {
      $bad = 0; $expired = 0; $oldest = 0;
      foreach ($list as $e) {
        if (!is_array($e) || !isset($e['id']) || !is_string($e['id'])) { $bad++; continue; }
        $t = isset($e['expiresAt']) && is_string($e['expiresAt']) ? strtotime($e['expiresAt']) : false;
        if ($t !== false && $t < $now) { $expired++; if ($oldest === 0 || $t < $oldest) $oldest = $t; }
      }
      $detail = count($list) . ' entries, ' . doctor_size($size) . ($bad ? '; ' . $bad . ' have no id' : '') . '.';
      if ($bad) $add('housekeeping', 'suspensions-json', 'warn', 'The suspension list has entries without an id', $detail, 'Check the file against a backup.');
      else $add('housekeeping', 'suspensions-json', 'ok', 'Suspension list is valid JSON', $detail);
      if ($expired) {
        $stale = $oldest !== 0 && $now - $oldest > 86400;
        $add('housekeeping', 'suspensions-expired', $stale ? 'warn' : 'info', $expired . ' suspension(s) have run out but are still in the file',
          'The issuer lifts them (or revokes them, for "revoke when it ends") the next time any credential is checked, so this is normal for a quiet site.' . ($stale ? ' The oldest ended ' . date('Y-m-d', $oldest) . ', so nothing has checked a credential since.' : ''),
          'Open the admin panel\'s "Currently suspended" list: opening it resolves them.');
      }
    }
  }

  // -- housekeeping: holdings (counted and checked for valid JSON, never shown)
  $base = doctor_private_base($root);
  $hdir = ($base === '' ? $lib : $base) . '/holdings';
  if (is_dir($hdir) && !is_link($hdir)) {
    $t0 = microtime(true); $n = 0; $bad = 0; $big = 0; $total = 0; $checked = 0;
    $names = @scandir($hdir);
    foreach (is_array($names) ? $names : [] as $name) {
      if ($name === '.' || $name === '..' || substr($name, -5) !== '.json') continue;
      $f = $hdir . '/' . $name;
      if (!is_file($f) || is_link($f)) continue;
      $n++; $sz = (int)@filesize($f); $total += $sz;
      if ($sz > 262144) { $big++; continue; }
      if ($checked >= 2000 || microtime(true) - $t0 > 3.0) continue;
      $checked++;
      $d = json_decode((string)@file_get_contents($f), true);
      if (!is_array($d) || !isset($d['held']) || !is_array($d['held'])) $bad++;
    }
    if ($bad) $add('housekeeping', 'holdings', 'fail', $bad . ' holdings record(s) are unreadable', 'The issuer refuses to guess a balance for those owners, so their issuing and replacement requests fail.', 'Restore those files in holdings/ from a backup. Do not delete them.');
    elseif ($big) $add('housekeeping', 'holdings', 'warn', $big . ' holdings record(s) are over 256 KB', $n . ' records, ' . doctor_size($total) . ' in all.', 'An owner holding that many credentials is unusual; check it is not a loop.');
    else $add('housekeeping', 'holdings', 'ok', 'Holdings records are valid JSON', $n . ' records, ' . doctor_size($total) . ' in all' . ($checked < $n ? ' (' . $checked . ' checked within the time limit)' : '') . '.');
  }

  // -- housekeeping: any single state file growing out of hand
  $largest = [];
  foreach ([$lib, $wk] as $d) {
    $names = is_dir($d) ? @scandir($d) : false;
    foreach (is_array($names) ? $names : [] as $name) {
      $f = $d . '/' . $name;
      if (is_file($f) && !is_link($f) && preg_match('/^atlas-.*\.json$/', $name)) $largest[] = [(int)@filesize($f), substr($f, strlen($root) + 1)];
    }
  }
  rsort($largest);
  if ($largest && $largest[0][0] >= 5242880) $add('housekeeping', 'big-state', 'warn', 'A state file is over 5 MB: ' . $largest[0][1] . ' (' . doctor_size($largest[0][0]) . ')', 'Every request that touches it reads the whole file.', 'Find out why it grew before deleting anything.');

  // -- permissions
  if ($isWin) {
    $add('permissions', 'modes', 'info', 'File modes are not checked on Windows');
  } else {
    $secret = []; $worldWritable = [];
    $watch = [];
    foreach (['lib', 'lib/replay', 'lib/holdings', 'lib/txn', '.well-known'] as $d) $watch[] = $root . '/' . $d;
    if ($base !== '') foreach (['replay', 'holdings', 'txn'] as $d) $watch[] = $base . '/' . $d;
    list($how, $configured) = atlas_sf_studio_root($root);
    if ($configured !== null && is_dir($configured)) { $watch[] = $configured; foreach (['drafts', 'uploads-quarantine', 'mint-receipts', 'tmp', 'rate'] as $d) $watch[] = $configured . '/' . $d; }
    foreach ($watch as $d) {
      if (!is_dir($d) || is_link($d)) continue;
      $m = doctor_mode($d);
      if ($m !== null && ($m & 0002)) $worldWritable[] = substr($d, 0, strlen($root) + 1) === $root . '/' ? substr($d, strlen($root) + 1) . '/' : $d . '/';
    }
    $files = [];
    foreach ([$lib] as $d) {
      $names = is_dir($d) ? @scandir($d) : false;
      foreach (is_array($names) ? $names : [] as $name) {
        $f = $d . '/' . $name;
        if (!is_file($f) || is_link($f)) continue;
        if (preg_match('/\.pem$|-config\.json$|^atlas-.*-store\.json$|^atlas-.*\.json$|^config\.php$|storage-root\.php$/', $name)) $files[] = $f;
      }
    }
    if ($configured !== null && is_file($configured . '/studio-config.json')) $files[] = $configured . '/studio-config.json';
    foreach ($files as $f) {
      $m = doctor_mode($f);
      if ($m === null) continue;
      $rel = strpos($f, $root . '/') === 0 ? substr($f, strlen($root) + 1) : $f;
      if ($m & 0002) $worldWritable[] = $rel . ' (' . doctor_modestr($m) . ')';
      elseif ($m & 0004 && preg_match('/\.pem$|-config\.json$|admin-[a-z-]*\.json$|^config\.php$/', basename($f))) $secret[] = $rel . ' (' . doctor_modestr($m) . ')';
    }
    if ($worldWritable) $add('permissions', 'modes-writable', 'fail', count($worldWritable) . ' file(s) or folder(s) can be changed by any account on this server', implode(', ', array_slice($worldWritable, 0, 8)) . (count($worldWritable) > 8 ? ', and ' . (count($worldWritable) - 8) . ' more' : ''), 'Set folders to 0755 and files to 0644 or tighter (0600 for keys and settings) in your file manager.');
    if ($secret) $add('permissions', 'modes-readable', 'warn', count($secret) . ' key or settings file(s) are readable by other accounts', implode(', ', array_slice($secret, 0, 8)) . (count($secret) > 8 ? ', and ' . (count($secret) - 8) . ' more' : '') . '. On shared hosting other accounts on the same server may be able to read them.', 'Set them to 0600 (or 0640 if your host needs the group) in your file manager. Do not change the folder modes.');
    if (!$worldWritable && !$secret) $add('permissions', 'modes', 'ok', 'Keys, settings and private folders are not open to other accounts', count($files) . ' file(s) and ' . count($watch) . ' folder(s) looked at.');
    $reported = [];
    foreach ($files as $f) $reported[$f] = true;
    foreach ($watch as $d) $reported[$d] = true;
    doctor_perm_checks($root, $base, $reported, is_array($trustedGroups) ? $trustedGroups : [], $add);
  }

  // -- permissions: PHP limits
  $mem = doctor_bytes(ini_get('memory_limit'));
  if ($mem !== -1 && $mem > 0 && $mem < 67108864) $add('permissions', 'php-memory', 'warn', 'PHP memory_limit is ' . ini_get('memory_limit'), 'Large lists (revocations, holdings) are loaded into memory.', 'Raise it to 128M or more (cPanel: MultiPHP INI Editor).');
  else $add('permissions', 'php-memory', 'ok', 'PHP memory_limit is ' . ini_get('memory_limit'));
  $up = doctor_bytes(ini_get('upload_max_filesize')); $post = doctor_bytes(ini_get('post_max_size'));
  if (!ini_get('file_uploads')) $add('permissions', 'php-uploads', 'warn', 'PHP file uploads are switched off', 'Asset Studio cannot receive models.', 'Set file_uploads to On.');
  elseif (($up > 0 && $up < 2097152) || ($post > 0 && $post < 2097152)) $add('permissions', 'php-uploads', 'warn', 'PHP upload limits are small: upload_max_filesize ' . ini_get('upload_max_filesize') . ', post_max_size ' . ini_get('post_max_size'), 'Asset Studio uploads of models larger than this fail.', 'Raise both to 8M or more.');
  else $add('permissions', 'php-uploads', 'ok', 'PHP upload limits: upload_max_filesize ' . ini_get('upload_max_filesize') . ', post_max_size ' . ini_get('post_max_size'));
  if ($up > 0 && $post > 0 && $post < $up) $add('permissions', 'php-post', 'warn', 'post_max_size is smaller than upload_max_filesize', 'The larger upload limit can never be reached.', 'Make post_max_size at least as large as upload_max_filesize.');
  $met = (int)ini_get('max_execution_time');
  if ($met > 0 && $met < 20) $add('permissions', 'php-time', 'warn', 'PHP max_execution_time is ' . $met . ' seconds', 'Calls to other domains and large lists need a little longer.', 'Raise it to 30 or more.');
  $ob = (string)ini_get('open_basedir');
  if ($ob !== '') {
    $allowed = array_filter(array_map(function ($p) { $r = @realpath(trim($p)); return $r === false ? null : rtrim(str_replace('\\', '/', $r), '/'); }, preg_split('#[:;]#', $ob)));
    $outside = [];
    foreach ([$base, $configured] as $p) {
      if (!is_string($p) || $p === '') continue;
      $rp = @realpath($p);
      if ($rp === false) $rp = $p;
      $rp = rtrim(str_replace('\\', '/', $rp), '/');
      $okp = false;
      foreach ($allowed as $a) if ($rp === $a || strpos($rp . '/', $a . '/') === 0) $okp = true;
      if (!$okp) $outside[] = $p;
    }
    if ($outside) $add('permissions', 'open-basedir', 'fail', 'open_basedir blocks a private folder: ' . implode(', ', $outside), 'PHP may only reach: ' . $ob, 'Add that folder to open_basedir, or move the private folder inside the allowed paths.');
    else $add('permissions', 'open-basedir', 'info', 'open_basedir is set', 'PHP may only reach: ' . $ob);
  }
  $tmp = sys_get_temp_dir();
  if (!@is_writable($tmp)) $add('permissions', 'php-tmp', 'warn', 'PHP\'s temporary folder is not writable: ' . $tmp, 'Uploads pass through it before Studio sees them.', 'Set upload_tmp_dir to a writable folder.');
  $sess = (string)ini_get('session.save_path');
  if ($sess !== '' && strpos($sess, ';') === false && !@is_writable($sess)) $add('permissions', 'php-session', 'info', 'PHP\'s session folder is not writable: ' . $sess, 'The issuer keeps its own administrator sessions and does not use PHP sessions, so this only matters to other software on the domain.');

  // -- administrator side
  list($st, $doc, $size) = doctor_json_file($lib . '/atlas-admin-keys-store.json', 1048576);
  if ($st === 'missing') $add('admin', 'admin-keys', 'warn', 'No administrator keys are registered', 'Without one, nobody can sign in to the admin panel. (Nothing is wrong if you do not use the panel.)', 'Create lib/atlas-admin-keys-store.json from the example in the admin docs, with the public key of your wallet.');
  elseif ($st !== 'ok') $add('admin', 'admin-keys', 'fail', 'The administrator key list cannot be read (' . $st . ')', 'Nobody can sign in to the admin panel.', 'Fix the JSON in lib/atlas-admin-keys-store.json or restore it from a backup.');
  else {
    $keys = isset($doc['keys']) && is_array($doc['keys']) ? $doc['keys'] : [];
    $admins = 0; $mods = 0; $off = 0; $odd = 0;
    foreach ($keys as $k) {
      if (!is_array($k) || !isset($k['publicKey']) || !is_string($k['publicKey']) || strlen($k['publicKey']) < 40) { $odd++; continue; }
      if (array_key_exists('revoked', $k) && !in_array($k['revoked'], [false, null, 0, ''], true)) { $off++; continue; }
      $role = isset($k['role']) ? $k['role'] : null;
      if ($role === null || $role === 'admin') $admins++; elseif ($role === 'moderator') $mods++; else $odd++;
    }
    $detail = $admins . ' administrator(s), ' . $mods . ' moderator(s)' . ($off ? ', ' . $off . ' switched off' : '') . ($odd ? ', ' . $odd . ' entry/entries with an unusable key or role' : '') . '.';
    if (!$admins) $add('admin', 'admin-keys', 'warn', 'No active administrator key', $detail . ' Only moderators can sign in.', 'Add an administrator public key to lib/atlas-admin-keys-store.json.');
    elseif ($odd) $add('admin', 'admin-keys', 'warn', 'Some administrator list entries are unusable', $detail, 'An entry needs a "publicKey"; "role" is "admin" (or left out) or "moderator". A typo in "role" gives that key no rights at all.');
    else $add('admin', 'admin-keys', 'ok', 'Administrator keys are registered', $detail);
  }
  $stores = ['atlas-admin-nonces-store.json', 'atlas-admin-sessions-store.json', 'atlas-admin-proof-nonces-store.json', 'atlas-admin-ratelimit-store.json'];
  $locked = []; $last = 0;
  foreach ($stores as $s) {
    $f = $lib . '/' . $s;
    if (file_exists($f)) {
      if (!is_writable($f)) $locked[] = $s;
      $mt = (int)@filemtime($f);
      if ($mt > $last && $s !== 'atlas-admin-nonces-store.json') $last = $mt;
    }
  }
  if ($locked) $add('admin', 'admin-stores', 'fail', 'Administrator state files are not writable: ' . implode(', ', $locked), 'Sign-in and signed requests fail while they cannot be written.', 'Make them writable by your hosting account (0600 or 0644, owned by it).');
  elseif (is_dir($lib) && !is_writable($lib)) $add('admin', 'admin-stores', 'warn', 'lib/ is not writable, so administrator sessions cannot be stored', '', 'Make lib/ writable by your hosting account (0755).');
  else $add('admin', 'admin-stores', 'ok', 'Administrator session and request state can be written');
  if ($last) $add('admin', 'admin-last', 'info', 'Last administrator activity: ' . date('Y-m-d H:i', $last) . ' (server time)', $now - $last > 90 * 86400 ? 'That was over 90 days ago.' : '');
  else $add('admin', 'admin-last', 'info', 'No administrator has signed in yet', 'No session store exists.');
  return ['checks' => $checks];
}

// ---- components: which parts of Domain Atlas are installed here -----------------------------------------------
// A component is a part a domain may or may not install (Asset Studio, Global Mail, Chain Labs, the directory, ...).
// It counts as installed when any of its required files is on disk; from then on every file of it is expected. One
// that has no file here and is not advertised by the manifest is "not installed" and its files are never reported
// missing. One the manifest advertises (or the person ticked) but with no file here is reported as missing.

function doctor_component_list() {
  global $DOCTOR;
  return isset($DOCTOR['components']) && is_array($DOCTOR['components']) ? $DOCTOR['components'] : [];
}

// Where a component whose folder may be moved (the verifier) actually sits: its default folder, or the first folder one
// or two levels below the web root that holds all of the marker files.
function doctor_find_mount($root, $comp) {
  $default = trim(isset($comp['mount']) ? (string)$comp['mount'] : '', '/');
  $marks = isset($comp['findMount']) && is_array($comp['findMount']) ? $comp['findMount'] : null;
  if ($marks === null) return $default;
  $has = function ($dir) use ($root, $marks) {
    foreach ($marks as $m) if (!is_file($root . ($dir === '' ? '' : '/' . $dir) . '/' . $m)) return false;
    return true;
  };
  if ($has($default)) return $default;
  $skip = ['.well-known' => 1, 'assets' => 1, 'atlas' => 1, 'lib' => 1, 'cgi-bin' => 1, 'presence' => 1, 'node_modules' => 1, '.git' => 1, 'chain-labs' => 1];
  $top = @scandir($root); $seen = 0;
  foreach (is_array($top) ? $top : [] as $a) {
    if ($a === '' || $a[0] === '.' || isset($skip[$a]) || is_link($root . '/' . $a) || !is_dir($root . '/' . $a)) continue;
    if (++$seen > 300) break;
    if ($has($a)) return $a;
    $sub = @scandir($root . '/' . $a);
    foreach (is_array($sub) ? $sub : [] as $b) {
      if ($b === '' || $b[0] === '.' || is_link($root . '/' . $a . '/' . $b) || !is_dir($root . '/' . $a . '/' . $b)) continue;
      if ($has($a . '/' . $b)) return $a . '/' . $b;
    }
  }
  return $default;
}

// The manifest's entries with a moved component's paths rewritten to where it actually is, and the mounts found.
function doctor_entries($root) {
  global $DOCTOR;
  static $cache = null;
  if ($cache !== null) return $cache;
  $mounts = []; $remap = [];
  foreach (doctor_component_list() as $c) {
    if (empty($c['findMount']) || !isset($c['id'])) continue;
    $actual = doctor_find_mount($root, $c);
    $def = trim(isset($c['mount']) ? (string)$c['mount'] : '', '/');
    $mounts[$c['id']] = $actual;
    if ($actual !== $def) $remap[$c['id']] = [$def, $actual];
  }
  $out = [];
  foreach ($DOCTOR['entries'] as $e) {
    $comp = isset($e[6]) ? $e[6] : 'core';
    if (isset($remap[$comp])) {
      $def = $remap[$comp][0]; $actual = $remap[$comp][1];
      $p = (string)$e[0];
      if ($def === '') $p = ($actual === '' ? '' : $actual . '/') . $p;
      elseif (strpos($p, $def . '/') === 0) $p = ($actual === '' ? '' : $actual . '/') . substr($p, strlen($def) + 1);
      $e[0] = $p;
    }
    $out[] = $e;
  }
  return $cache = ['entries' => $out, 'mounts' => $mounts];
}

function doctor_host_bare($host) {
  return preg_replace('/^www\./', '', strtolower(preg_replace('/:\d+$/', '', (string)$host)));
}

// The services this domain's manifest advertises (SPEC 3.9): name => its address or null. A service whose address is on
// another host is run elsewhere and does not say anything about what is installed here.
function doctor_advertised($root, $host) {
  $out = [];
  $f = $root . '/.well-known/spatial.json';
  if (!is_file($f) || is_link($f) || (int)@filesize($f) > 2097152) return $out;
  $m = json_decode((string)@file_get_contents($f), true);
  if (!is_array($m)) return $out;
  foreach (['postOffice', 'mailRelay', 'chat', 'inWorldChat', 'voiceCalling', 'assetStudio', 'chainLabs', 'chainlabs', 'scanner', 'tradingStation', 'trading', 'directory', 'calendar', 'domainMembership'] as $k) {
    if (!isset($m[$k])) continue;
    $v = $m[$k];
    $on = $v === true || (is_array($v) && isset($v['enabled']) && $v['enabled'] === true);
    if (!$on) continue;
    $url = is_array($v) && isset($v['url']) && is_string($v['url']) ? $v['url'] : null;
    if ($url !== null) {
      $h = parse_url($url, PHP_URL_HOST);
      if (is_string($h) && doctor_host_bare($h) !== doctor_host_bare($host)) continue;
    }
    $out[$k] = $url;
  }
  return $out;
}

// id => [status, present, total, advertised, active] for every optional component.
// status: installed | expected | advertised-missing | not-installed.
function doctor_component_states($root, $host, $entries, $forced) {
  $adv = doctor_advertised($root, $host);
  $out = [];
  foreach (doctor_component_list() as $c) {
    if (!isset($c['kind']) || $c['kind'] !== 'optional') continue;
    $total = 0; $present = 0;
    foreach ($entries as $e) {
      if (!isset($e[6]) || $e[6] !== $c['id'] || strpos((string)$e[4], 'o') !== false) continue;
      $total++;
      if (file_exists($root . '/' . $e[0])) $present++;
    }
    $names = [];
    foreach (isset($c['advertisedBy']) && is_array($c['advertisedBy']) ? $c['advertisedBy'] : [] as $n) if (array_key_exists($n, $adv)) $names[] = $n;
    $isForced = isset($c['code']) && $c['code'] !== '' && strpos((string)$forced, $c['code']) !== false;
    if ($present > 0) $status = 'installed';
    elseif ($isForced) $status = 'expected';
    elseif ($names) $status = 'advertised-missing';
    else $status = 'not-installed';
    $out[$c['id']] = ['status' => $status, 'present' => $present, 'total' => $total, 'advertised' => $names, 'active' => $status !== 'not-installed'];
  }
  return $out;
}

// The entries that apply: the issuer's core files, the files of every component that is installed or expected, and
// the pages of the demo site the person chose.
function doctor_applicable($entries, $site, $states) {
  $out = [];
  foreach ($entries as $e) {
    $tags = (string)$e[5];
    $comp = isset($e[6]) ? $e[6] : 'core';
    $active = $comp === 'core' || $comp === 'site' || (isset($states[$comp]) && $states[$comp]['active']);
    $take = false;
    if (strpos($tags, 'i') !== false) $take = $active;
    if (!$take && ($site === 'a' || $site === 'b') && strpos($tags, $site) !== false) $take = true;
    if (!$take && preg_match('/[cpdlv]/', $tags)) $take = $active;
    if ($take) $out[] = $e;
  }
  return $out;
}

// ---- service checks ---------------------------------------------------------------------------------------------
// Read-only. Every check is [component, id, status, title, detail, fix] with status ok | warn | fail | na | info.
// Nothing here prints a key, token, credential or message: only counts, sizes, modes, names of files and public
// settings. The issuer's private key is opened once, in memory, only to compare its public half with the published key.

function doctor_count_dir($dir, $limit) {
  $n = 0; $bytes = 0; $oldest = 0;
  $names = is_dir($dir) && !is_link($dir) ? @scandir($dir) : false;
  foreach (is_array($names) ? $names : [] as $name) {
    if ($name === '.' || $name === '..') continue;
    $f = $dir . '/' . $name;
    if (is_link($f) || !is_file($f)) continue;
    $n++;
    $bytes += (int)@filesize($f);
    $t = (int)@filemtime($f);
    if ($t > 0 && ($oldest === 0 || $t < $oldest)) $oldest = $t;
    if ($n >= $limit) break;
  }
  return [$n, $bytes, $oldest];
}

function doctor_pubkey_of_pem($file) {
  if (!function_exists('openssl_pkey_get_private')) return null;
  $pem = @file_get_contents($file);
  if (!is_string($pem) || $pem === '') return null;
  $priv = @openssl_pkey_get_private($pem);
  if ($priv === false) return null;
  $d = @openssl_pkey_get_details($priv);
  if (!isset($d['ec']['x'], $d['ec']['y'])) return null;
  $raw = "\x04" . str_pad($d['ec']['x'], 32, "\x00", STR_PAD_LEFT) . str_pad($d['ec']['y'], 32, "\x00", STR_PAD_LEFT);
  return rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
}

// The owner-proof mode this server applies: the environment variable first, then lib/atlas-owner-proof-config.json.
function doctor_owner_proof_mode($root) {
  $env = getenv('ATLAS_OWNER_PROOF');
  $raw = ($env !== false && $env !== '') ? $env : null; $from = 'environment variable';
  if ($raw === null) {
    $d = doctor_json_file($root . '/lib/atlas-owner-proof-config.json', 8192);
    if ($d[0] === 'ok' && is_array($d[1]) && array_key_exists('mode', $d[1])) { $raw = $d[1]['mode']; $from = 'lib/atlas-owner-proof-config.json'; }
  }
  if ($raw === null) return ['accept', 'default', false];
  $v = is_string($raw) ? strtolower(trim($raw)) : '';
  if (in_array($v, ['off', 'accept', 'require'], true)) return [$v, $from, false];
  return ['accept', $from, true];
}

// The same judgement as tools/owner-proof-readiness.js, from the counts the issuer keeps.
function doctor_owner_proof_readiness($doc, $mode, $now, $days) {
  $classes = is_array($doc) && isset($doc['classes']) && (is_array($doc['classes']) || is_object($doc['classes'])) ? (array)$doc['classes'] : [];
  $win = $days * 86400; $signed = 0; $unsigned = 0; $refused = 0; $unsignedRecent = [];
  foreach ($classes as $cls => $c) {
    if (!is_array($c) || !preg_match('/^atlas(\.[a-z0-9-]{1,32}){1,5}$/', (string)$cls)) { unset($classes[$cls]); continue; }
    $signed += (int)(isset($c['signed']) ? $c['signed'] : 0);
    $unsigned += (int)(isset($c['unsigned']) ? $c['unsigned'] : 0);
    $refused += (int)(isset($c['refused']) ? $c['refused'] : 0);
    $t = isset($c['lastUnsignedAt']) && is_string($c['lastUnsignedAt']) ? strtotime($c['lastUnsignedAt']) : false;
    if ($t !== false && $now - $t < $win) $unsignedRecent[] = $cls;
  }
  if ($mode === 'require') $state = 'enforcing';
  elseif ($mode === 'off') $state = 'off';
  elseif ($unsignedRecent) $state = 'not-ready';
  elseif ($signed < 1) $state = 'no-signed-yet';
  else $state = 'ready';
  return ['state' => $state, 'signed' => $signed, 'unsigned' => $unsigned, 'refused' => $refused, 'unsignedRecent' => $unsignedRecent, 'classes' => $classes];
}

function doctor_json_count($path, $key, $maxParse) {
  list($st, $doc, $size) = doctor_json_file($path, $maxParse);
  if ($st !== 'ok') return [$st, null, $size];
  $n = null;
  if ($key !== null && is_array($doc) && isset($doc[$key]) && is_array($doc[$key])) $n = count($doc[$key]);
  elseif ($key === null && is_array($doc)) $n = count($doc);
  return ['ok', $n, $size];
}

function doctor_services($root, $host, $states, $mounts) {
  $checks = [];
  $add = function ($comp, $id, $status, $title, $detail = '', $fix = '') use (&$checks) {
    $checks[] = ['component' => $comp, 'id' => $id, 'status' => $status, 'title' => $title, 'detail' => $detail, 'fix' => $fix];
  };
  $now = time();
  $lib = $root . '/lib';
  $wk = $root . '/.well-known';
  $base = doctor_private_base($root);
  $private = $base === '' ? $lib : $base;
  $docReal = realpath($root);
  $inside = function ($path) use ($docReal) {
    $r = realpath($path);
    if ($r === false || $docReal === false) return false;
    $a = rtrim(str_replace('\\', '/', $r), '/'); $b = rtrim(str_replace('\\', '/', $docReal), '/');
    return $a === $b || strpos($a . '/', $b . '/') === 0;
  };

  // -- core: signing key and the published lists
  $keyFile = $lib . '/issuer-private-key.pem';
  list($kst, $kdoc, $ksize) = doctor_json_file($wk . '/atlas-key.json', 262144);
  if (!is_file($keyFile) && $kst === 'missing') {
    $add('core', 'key', 'info', 'No issuer key yet', 'A new issuer creates its key on the first request to an issuing route.');
  } elseif (!is_file($keyFile)) {
    $add('core', 'key', 'fail', 'A signing key is published but lib/issuer-private-key.pem is missing', 'The issuer refuses to make a new identity while a key is published.', 'Restore lib/issuer-private-key.pem from a backup. Do not let the issuer create a new key.');
  } elseif ($kst !== 'ok' || !is_array($kdoc) || !isset($kdoc['keys']) || !is_array($kdoc['keys'])) {
    $add('core', 'key', 'fail', '.well-known/atlas-key.json cannot be read (' . $kst . ')', 'Wallets and other domains cannot check anything this issuer signed.', 'Restore the file from a backup.');
  } else {
    $pub = doctor_pubkey_of_pem($keyFile);
    $listed = false; $valid = 0;
    foreach ($kdoc['keys'] as $k) {
      if (!is_array($k) || !isset($k['publicKey']) || !is_string($k['publicKey'])) continue;
      if ($pub !== null && hash_equals($k['publicKey'], $pub)) $listed = true;
      $from = isset($k['validFrom']) && is_string($k['validFrom']) ? strtotime($k['validFrom']) : 0;
      $until = isset($k['validUntil']) && is_string($k['validUntil']) ? strtotime($k['validUntil']) : null;
      if (($from === false || $from <= $now + 300) && ($until === null || $until === false || $until > $now)) $valid++;
    }
    if ($pub === null) $add('core', 'key', 'fail', 'The issuer private key cannot be read as an EC key by PHP', 'Signing will fail.', 'Check lib/issuer-private-key.pem is readable by this account and not damaged.');
    elseif (!$listed) $add('core', 'key', 'fail', 'The published key list does not contain the public key of the private key file', 'Credentials this issuer signs would not verify.', 'Restore the matching atlas-key.json and issuer-private-key.pem pair from the same backup.');
    elseif ($valid < 1) $add('core', 'key', 'fail', 'No published key is valid right now', count($kdoc['keys']) . ' key(s) listed, none within its validity window.', 'Check validFrom and validUntil in .well-known/atlas-key.json.');
    else $add('core', 'key', 'ok', 'Signing key and published key list agree', count($kdoc['keys']) . ' key(s) published, ' . $valid . ' valid now. The private key was compared in memory only.');
  }
  $revFile = $wk . '/atlas-revocations.json'; $susFile = $wk . '/atlas-suspensions.json';
  if ($kst === 'ok' && (!is_file($revFile) || !is_file($susFile))) {
    $add('core', 'lists', is_file($revFile) ? 'warn' : 'fail', is_file($revFile) ? 'The suspension list is missing' : 'The revocation list is missing while a key is published',
      is_file($revFile) ? 'Suspended credentials may not be enforced.' : 'The issuer refuses to run so that revoked credentials cannot come back.', 'Restore the file from a backup (an empty suspension list is {"suspended": []}).');
  } elseif ($kst === 'ok') $add('core', 'lists', 'ok', 'Key, revocation list and suspension list are all published');

  // -- core: private storage
  if ($base === '') {
    $add('core', 'private-location', 'warn', 'Private state is kept inside the web root (in lib/)', 'lib/.htaccess denies web access, but a server that ignores it would serve replay, holdings and journal records.', 'Create a folder outside the web root and name it in lib/atlas-private-dir.txt (move the replay, holdings, txn, mint-allowance and owner-proof folders into it first).');
  } else {
    $rb = realpath($base);
    if ($rb === false || !is_dir($rb)) $add('core', 'private-location', 'fail', 'The private state folder does not exist', 'Configured: ' . $base, 'Create it, or correct lib/atlas-private-dir.txt. Until then the issuer cannot keep replay, holdings or journal records.');
    elseif ($inside($rb)) $add('core', 'private-location', 'warn', 'The private state folder is inside the web root', 'Configured: ' . $base, 'Choose a folder outside public_html.');
    elseif (!is_writable($rb)) $add('core', 'private-location', 'fail', 'The private state folder is not writable', 'Configured: ' . $base, 'Make it writable by your hosting account.');
    else $add('core', 'private-location', 'ok', 'Private state is outside the web root and writable', 'Configured: ' . $base);
  }
  $dirs = [['replay', 'Replay records', true], ['holdings', 'Holdings records', true], ['txn', 'Transaction journal', true], ['mint-allowance', 'Mint allowance counters', false], ['owner-proof', 'Owner-proof counts', false]];
  foreach ($dirs as $d) {
    $dir = $private . '/' . $d[0];
    if (!is_dir($dir)) {
      $add('core', 'dir-' . $d[0], 'info', $d[1] . ': folder not created yet', 'The issuer creates ' . $d[0] . '/ the first time it needs it.');
      continue;
    }
    if (is_link($dir)) { $add('core', 'dir-' . $d[0], 'fail', $d[1] . ': the folder is a symbolic link', '', 'Replace it with a real folder.'); continue; }
    list($n, $bytes, $oldest) = doctor_count_dir($dir, 20000);
    if (!is_writable($dir)) $add('core', 'dir-' . $d[0], 'fail', $d[1] . ': folder is not writable', $n . ' file(s).', 'Make ' . $d[0] . '/ writable by your hosting account (0700 is usual).');
    elseif ($d[0] === 'txn' && $n > 0) $add('core', 'dir-txn', 'warn', $n . ' journal entr' . ($n === 1 ? 'y is' : 'ies are') . ' still pending', 'A replacement that stopped part-way is finished the next time the issuer handles a request; an entry that stays here for long is stuck' . ($oldest ? ' (oldest ' . date('Y-m-d H:i', $oldest) . ')' : '') . '.', 'Run php lib/atlas-cli.php txn-list over SSH, or ask for help; do not delete the files.');
    else $add('core', 'dir-' . $d[0], 'ok', $d[1] . ': ' . $n . ' file(s), ' . doctor_size($bytes), 'Writable' . (($inside($dir) ? ', inside the web root' : ', outside the web root')) . '.');
  }

  // -- core: membership owner proof
  $issueText = is_file($root . '/atlas/asset/issue.php') ? (string)@file_get_contents($root . '/atlas/asset/issue.php', false, null, 0, 400000) : '';
  $capText = is_file($root . '/atlas/capabilities.php') ? (string)@file_get_contents($root . '/atlas/capabilities.php', false, null, 0, 100000) : '';
  $hasLib = is_file($lib . '/owner-proof.php');
  $inIssue = strpos($issueText, 'atlas_owner_proof_verdict') !== false;
  $inCaps = strpos($capText, 'atlas_owner_proof_mode') !== false;
  list($opMode, $opFrom, $opBad) = doctor_owner_proof_mode($root);
  $statsDoc = null;
  list($sst, $sdoc, $ssize) = doctor_json_file($private . '/owner-proof/stats.json', 1048576);
  if ($sst === 'ok') $statsDoc = $sdoc;
  $ready = doctor_owner_proof_readiness($statsDoc, $opMode, $now, 7);
  $parts = [];
  foreach ([['subscribers', 'atlas-subscribers-store.json', 'subscribers'], ['Global Mail members', 'atlas-postoffice-members-store.json', 'members'], ['Trading Station members', 'atlas-tradingstation-members-store.json', 'members'], ['stored messages', 'atlas-mail-store.json', 'messages']] as $r) {
    list($cs, $cn) = doctor_json_count($lib . '/' . $r[1], $r[2], 8388608);
    if ($cs === 'ok' && $cn !== null) $parts[] = $cn . ' ' . $r[0];
  }
  $counts = [];
  foreach ($ready['classes'] as $cls => $c) if (is_array($c)) $counts[] = $cls . ': ' . (int)(isset($c['signed']) ? $c['signed'] : 0) . ' signed, ' . (int)(isset($c['unsigned']) ? $c['unsigned'] : 0) . ' unsigned, ' . (int)(isset($c['refused']) ? $c['refused'] : 0) . ' refused';
  $countText = $counts ? implode('; ', $counts) : 'no counts recorded yet';
  $detailOp = 'Mode ' . $opMode . ' (' . $opFrom . '). ' . $countText . '.' . ($parts ? ' Right now: ' . implode(', ', $parts) . '.' : '');
  if (!is_file($root . '/atlas/asset/issue.php')) {
    $add('core', 'owner-proof', 'na', 'Membership owner proof: no issue route here', '');
  } elseif (!$hasLib || !$inIssue || !$inCaps) {
    $missing = [];
    if (!$hasLib) $missing[] = 'lib/owner-proof.php';
    if (!$inIssue) $missing[] = 'atlas/asset/issue.php (old version)';
    if (!$inCaps) $missing[] = 'atlas/capabilities.php (old version)';
    $add('core', 'owner-proof', 'fail', 'Membership owner proof is not fully installed', 'Missing or old: ' . implode(', ', $missing) . '. Anyone can ask this issuer for a membership card for a key they do not hold.', 'Upload lib/owner-proof.php, atlas/asset/issue.php, atlas/capabilities.php and lib/webauthn.php from the repository together.');
  } elseif ($opBad) {
    $add('core', 'owner-proof', 'warn', 'The owner-proof setting is not off, accept or require', 'The issuer falls back to accept. ' . $detailOp, 'Correct the value in ' . $opFrom . '.');
  } elseif ($opMode === 'off') {
    $add('core', 'owner-proof', 'fail', 'Membership owner proof is switched off', $detailOp, 'Set ATLAS_OWNER_PROOF (or lib/atlas-owner-proof-config.json) to accept, and to require once ready.');
  } elseif ($opMode === 'accept') {
    $why = ['ready' => 'Signed requests have been seen and no unsigned one in the last 7 days: it can be switched to require.', 'not-ready' => 'An unsigned request arrived in the last 7 days (' . implode(', ', $ready['unsignedRecent']) . '): switching now would turn a wallet away.', 'no-signed-yet' => 'No signed issuance has been seen yet, so the signed path is not proven on this domain.'];
    $add('core', 'owner-proof', 'warn', 'Membership owner proof is in accept mode (temporary): not enforcing yet', (isset($why[$ready['state']]) ? $why[$ready['state']] . ' ' : '') . $detailOp, 'Switch to require when ready: set ATLAS_OWNER_PROOF=require, or put {"mode": "require"} in lib/atlas-owner-proof-config.json.');
  } else {
    $add('core', 'owner-proof', 'ok', 'Membership owner proof is enforcing (require)', $detailOp);
  }

  // -- stores of each installed component: valid JSON, size, counts
  foreach (doctor_component_list() as $c) {
    if (!isset($c['id']) || !isset($c['stores']) || !is_array($c['stores'])) continue;
    $active = $c['id'] === 'core' || (isset($states[$c['id']]) && $states[$c['id']]['active']);
    if (!$active) continue;
    foreach ($c['stores'] as $s) {
      if (!isset($s['file']) || !preg_match('/^atlas-[a-z0-9-]+\.json$/', $s['file'])) continue;
      $key = isset($s['key']) && is_string($s['key']) ? $s['key'] : null;
      list($st, $n, $size) = doctor_json_count($lib . '/' . $s['file'], $key, 8388608);
      $label = isset($s['label']) ? (string)$s['label'] : $s['file'];
      $cid = 'store-' . $s['file'];
      if ($st === 'missing') $add($c['id'], $cid, 'info', $label . ': not created yet', 'Created the first time it is needed.');
      elseif ($st === 'too-big') $add($c['id'], $cid, 'warn', $label . ' is very large: ' . doctor_size($size), 'Every request that touches it reads the whole file.', 'Ask before pruning it.');
      elseif ($st !== 'ok') $add($c['id'], $cid, 'fail', $label . ' cannot be read (' . $st . ')', $s['file'] . ' is damaged or not valid JSON.', 'Restore lib/' . $s['file'] . ' from a backup.');
      elseif ($size >= 5242880) $add($c['id'], $cid, 'warn', $label . ' is large: ' . doctor_size($size), 'Every request that touches it reads the whole file.', 'Ask before pruning it.');
      else $add($c['id'], $cid, 'ok', $label . ': valid' . ($n !== null ? ', ' . $n . ' entries' : ''), doctor_size($size) . '.');
    }
  }

  // -- membership classes the manifest asks for
  $m = null;
  if (is_file($wk . '/spatial.json') && (int)@filesize($wk . '/spatial.json') <= 2097152) $m = json_decode((string)@file_get_contents($wk . '/spatial.json'), true);
  if (is_array($m)) {
    foreach (['postOffice' => 'atlas.postoffice.membership', 'tradingStation' => 'atlas.tradingstation.membership', 'domainMembership' => 'atlas.membership'] as $svc => $cls) {
      if (!isset($m[$svc]) || !is_array($m[$svc]) || empty($m[$svc]['requiresCredential'])) continue;
      $got = isset($m[$svc]['credentialClass']) ? $m[$svc]['credentialClass'] : null;
      $comp = $svc === 'postOffice' ? 'postoffice' : ($svc === 'tradingStation' ? 'trade' : 'core');
      if ($got !== $cls) $add($comp, 'class-' . $svc, 'warn', 'The manifest asks for a different card than the wallet uses for ' . $svc, 'credentialClass is ' . (is_string($got) ? $got : 'not set') . '; the wallet uses ' . $cls . ' for this service and ignores another class.', 'Set "credentialClass" to ' . $cls . ' in .well-known/spatial.json, or remove the field.');
      else $add($comp, 'class-' . $svc, 'ok', 'The manifest asks for the ' . $svc . ' card the wallet issues (' . $cls . ')');
    }
  }

  // -- Global Mail / domain mail: the code the wallet's mail check needs
  if (isset($states['mail']) && $states['mail']['active'] && isset($states['postoffice']) && !$states['postoffice']['active']) {
    $add('mail', 'mail-pair', 'warn', 'Domain mail is installed without the Post Office routes', 'Wallets can check mail here but cannot send person-to-person mail.', 'Upload atlas/postoffice/ if this domain offers Global Mail.');
  }
  if (isset($states['postoffice']) && $states['postoffice']['active'] && isset($states['mail']) && !$states['mail']['active']) {
    $add('postoffice', 'mail-pair', 'fail', 'Global Mail is installed without the mail routes', 'Wallets cannot check for mail on this domain.', 'Upload atlas/mail/ (check.php, send.php, delete.php).');
  }

  // -- Presence
  if (isset($states['presence']) && $states['presence']['active']) {
    list($st, $n, $size) = doctor_json_count($root . '/presence/lib/atlas-presence-store.json', null, 8388608);
    $plib = $root . '/presence/lib';
    if (!is_dir($plib) || !is_writable($plib)) $add('presence', 'presence-writable', 'fail', 'presence/lib/ is not writable', 'Room state cannot be saved.', 'Make presence/lib/ writable by your hosting account.');
    elseif ($st === 'missing') $add('presence', 'presence-store', 'info', 'No presence state yet', 'Created when the first visitor joins a room.');
    elseif ($st !== 'ok') $add('presence', 'presence-store', 'fail', 'The presence store cannot be read (' . $st . ')', '', 'Restore presence/lib/atlas-presence-store.json or delete it to start with empty rooms.');
    else $add('presence', 'presence-store', 'ok', 'Presence state is valid', doctor_size($size) . '.');
  }

  // -- Call
  if (isset($states['call']) && $states['call']['active']) {
    $cl = $root . '/atlas/call/lib';
    if (is_file($cl . '/config.php')) {
      $add('call', 'call-config', 'ok', 'Call service settings file is in place', 'Its contents are never read.');
      if (!is_writable($cl)) $add('call', 'call-state', 'fail', 'atlas/call/lib/ is not writable', 'The call service keeps its state in a folder there.', 'Make atlas/call/lib/ writable by your hosting account.');
    } elseif (is_file($cl . '/config.php.off')) $add('call', 'call-config', 'info', 'The call service is installed but switched off', 'The settings file is renamed config.php.off.', 'Rename it to config.php to switch the service on.');
    else $add('call', 'call-config', 'warn', 'The call service has no settings file', 'It stays off until atlas/call/lib/config.php exists.', 'Copy atlas/call/lib/config.example.php to config.php and fill it in (or leave it off).');
  }

  // -- Directory
  if (isset($states['directory']) && $states['directory']['active']) {
    if (!extension_loaded('pdo_sqlite')) $add('directory', 'dir-sqlite', 'fail', 'The directory needs the pdo_sqlite extension', 'This PHP has none.', 'Enable pdo_sqlite for this domain.');
    $data = null; $how = '';
    $env = getenv('DIRECTORY_DATA_DIR');
    if (is_string($env) && $env !== '') { $data = $env; $how = 'environment variable'; }
    if ($data === null) {
      $d = doctor_json_file($root . '/atlas/directory/lib/atlas-directory-config.json', 8192);
      if ($d[0] === 'ok' && is_array($d[1]) && isset($d[1]['dataDir']) && is_string($d[1]['dataDir']) && $d[1]['dataDir'] !== '') { $data = $d[1]['dataDir']; $how = 'atlas-directory-config.json'; }
    }
    if ($data === null) {
      for ($up = $root . '/atlas/directory/lib'; ; $up = dirname($up)) {
        if (is_dir($up . '/atlas-directory-private')) { $data = $up . '/atlas-directory-private'; $how = 'found beside the web root'; break; }
        if (dirname($up) === $up) break;
      }
    }
    if ($data === null) $add('directory', 'dir-data', 'fail', 'The directory has no data folder', 'It refuses to run without one outside the web root.', 'Create atlas-directory-private beside the web root (or set dataDir in atlas/directory/lib/atlas-directory-config.json).');
    else {
      $rd = realpath($data);
      if ($rd === false || !is_dir($rd)) $add('directory', 'dir-data', 'fail', 'The directory data folder does not exist', 'Configured: ' . $data, 'Create it.');
      elseif ($inside($rd)) $add('directory', 'dir-data', 'fail', 'The directory data folder is inside the web root', 'The directory refuses to run with its database where it could be downloaded.', 'Move it outside public_html.');
      elseif (!is_writable($rd)) $add('directory', 'dir-data', 'fail', 'The directory data folder is not writable', '', 'Make it writable by your hosting account.');
      else {
        $db = $rd . '/atlas-directory.sqlite';
        if (!is_file($db)) $add('directory', 'dir-data', 'info', 'The directory database is not created yet', 'Data folder (' . $how . ') is outside the web root and writable. The database appears with the first submission.');
        else {
          $t = (int)@filemtime($db);
          $stale = $t > 0 && $now - $t > 3 * 86400;
          $add('directory', 'dir-data', $stale ? 'warn' : 'ok', 'Directory database in place, ' . doctor_size((int)@filesize($db)), 'Last changed ' . ($t ? date('Y-m-d H:i', $t) : 'unknown') . ' (server time).' . ($stale ? ' The crawl job (cron.php) may not be scheduled.' : ''), $stale ? 'Schedule atlas/directory/cron.php to run every few hours.' : '');
        }
      }
    }
  }

  // -- Chain Labs
  if (isset($states['chainlabs']) && $states['chainlabs']['active']) {
    $miss = [];
    foreach (['openssl', 'pdo_sqlite'] as $x) if (!extension_loaded($x)) $miss[] = $x;
    if ($miss) $add('chainlabs', 'cl-ext', 'fail', 'Chain Labs needs PHP extension(s): ' . implode(', ', $miss), 'Its pages answer 503 without them.', 'Enable them for this domain.');
    else $add('chainlabs', 'cl-ext', 'ok', 'Chain Labs PHP extensions are present (openssl, pdo_sqlite)');
    $cfgPath = getenv('CHAINLABS_CONFIG');
    $cfgPath = is_string($cfgPath) && $cfgPath !== '' ? $cfgPath : null;
    $priv = realpath(dirname($root) . '/chainblock-labs-private');
    if ($cfgPath !== null && $priv === false) $priv = realpath(dirname($cfgPath));
    if ($priv === false) $add('chainlabs', 'cl-private', 'fail', 'The Chain Labs private folder does not exist', 'Expected beside the web root: chainblock-labs-private. The ledgers and registries are kept there, never inside the web root.', 'Create it beside public_html, writable by your hosting account.');
    elseif ($inside($priv)) $add('chainlabs', 'cl-private', 'fail', 'The Chain Labs private folder is inside the web root', '', 'Move it outside public_html.');
    elseif (!is_writable($priv)) $add('chainlabs', 'cl-private', 'fail', 'The Chain Labs private folder is not writable', '', 'Make it writable by your hosting account.');
    else {
      $have = []; $none = [];
      foreach (['coin26.sqlite', 'chain34.sqlite', 'ledger29.sqlite'] as $f) { if (is_file($priv . '/' . $f)) $have[] = $f . ' (' . doctor_size((int)@filesize($priv . '/' . $f)) . ')'; else $none[] = $f; }
      $add('chainlabs', 'cl-private', 'ok', 'The Chain Labs private folder is outside the web root and writable', ($have ? 'Databases: ' . implode(', ', $have) . '.' : 'No database yet.') . ($none ? ' Not created yet: ' . implode(', ', $none) . '.' : ''));
      $mode = doctor_mode($priv);
      if ($mode !== null && ($mode & 0002)) $add('chainlabs', 'cl-mode', 'fail', 'The Chain Labs private folder can be changed by any account', 'Mode ' . doctor_modestr($mode) . '.', 'Set it to 0700 or 0750.');
      elseif ($mode !== null && ($mode & 0004)) $add('chainlabs', 'cl-mode', 'warn', 'The Chain Labs private folder can be read by other accounts', 'Mode ' . doctor_modestr($mode) . '.', 'Set it to 0700 or 0750.');
    }
    $cfg = $cfgPath !== null ? $cfgPath : ($priv !== false ? $priv . '/chainlabs-config.json' : '');
    $hostsHere = null;
    if ($cfg !== '' && is_file($cfg)) {
      $d = doctor_json_file($cfg, 8192);
      $hosts = $d[0] === 'ok' && is_array($d[1]) && isset($d[1]['hosts']) && is_array($d[1]['hosts']) ? $d[1]['hosts'] : null;
      if ($hosts === null || !$hosts || count($hosts) > 5) $add('chainlabs', 'cl-hosts', 'fail', 'chainlabs-config.json is not usable', 'A configuration file that exists but is invalid leaves no domain at all, so every lab refuses every request.', 'Fix it: {"hosts": ["a.example", "b.example"], "peers": {...}} with one to five host names.');
      else {
        $hostsHere = array_map('strtolower', array_filter($hosts, 'is_string'));
        $add('chainlabs', 'cl-hosts', in_array(strtolower(doctor_host_bare($host)), $hostsHere, true) ? 'ok' : 'fail', in_array(strtolower(doctor_host_bare($host)), $hostsHere, true) ? 'Chain Labs names this domain: ' . implode(', ', $hostsHere) : 'Chain Labs does not list this domain', 'Configured hosts: ' . implode(', ', $hostsHere) . '.', in_array(strtolower(doctor_host_bare($host)), $hostsHere, true) ? '' : 'Add ' . doctor_host_bare($host) . ' to "hosts" in chainlabs-config.json.');
      }
    } else {
      $hp = $root . '/chain-labs/lib/hosts.php';
      $txt = is_file($hp) ? (string)@file_get_contents($hp, false, null, 0, 60000) : '';
      if (preg_match("/CHAINLABS_DEFAULT_HOSTS\\s*=\\s*\\[([^\\]]*)\\]/", $txt, $mm) && preg_match_all("/'([a-z0-9.-]+)'/i", $mm[1], $hh)) {
        $names = array_map('strtolower', $hh[1]);
        $okHere = in_array(strtolower(doctor_host_bare($host)), $names, true);
        $add('chainlabs', 'cl-hosts', $okHere ? 'info' : 'fail', $okHere ? 'Chain Labs uses its built-in domain list' : 'Chain Labs refuses this domain: it is not in the built-in list and there is no chainlabs-config.json', 'Built-in hosts: ' . implode(', ', $names) . '.', $okHere ? '' : 'Create chainlabs-config.json in the Chain Labs private folder naming this domain and its peer.');
      }
    }
    if ($priv !== false && is_file($priv . '/gold-adapter.php')) $add('chainlabs', 'cl-gold', 'info', 'The gold purchase adapter is installed', 'Its contents are never read.');
  }

  // -- Verifier
  if (isset($states['verifier']) && $states['verifier']['active']) {
    $mv = isset($mounts['verifier']) ? $mounts['verifier'] : 'atlas-verify';
    $dirv = $root . ($mv === '' ? '' : '/' . $mv);
    $miss = [];
    foreach (['openssl', 'json'] as $x) if (!extension_loaded($x)) $miss[] = $x;
    if ($miss) $add('verifier', 'vf-ext', 'fail', 'The verifier needs PHP extension(s): ' . implode(', ', $miss), '', 'Enable them for this domain.');
    if (!function_exists('curl_init') && !ini_get('allow_url_fopen')) $add('verifier', 'vf-net', 'fail', 'The verifier cannot make outbound requests', 'It needs the curl extension or allow_url_fopen to reach the issuers it trusts.', 'Enable one of them.');
    if (!is_file($dirv . '/config.php')) $add('verifier', 'vf-config', 'warn', 'The verifier is installed but not configured', 'verify.php reports configured: false until config.php exists.', 'Copy config.example.php to config.php and list the issuer origins you trust.');
    else {
      $txt = (string)@file_get_contents($dirv . '/config.php', false, null, 0, 65536);
      $n = preg_match_all("#https://[A-Za-z0-9.-]+#", $txt);
      $add('verifier', 'vf-config', $n > 0 ? 'ok' : 'warn', $n > 0 ? 'The verifier is configured (' . $n . ' https origin(s) in its settings)' : 'The verifier settings name no https issuer origin', 'The file itself is never shown.', $n > 0 ? '' : 'List at least one trusted issuer origin in config.php.');
    }
    $add('verifier', 'vf-where', 'info', 'The verifier is in ' . ($mv === '' ? 'the web root' : $mv . '/'));
  }
  return ['checks' => $checks];
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
    $env['meta'] = ['commit' => $DOCTOR['commit'], 'built' => $DOCTOR['built'], 'clean' => !empty($DOCTOR['clean']), 'entries' => count($DOCTOR['entries']), 'format' => isset($DOCTOR['v']) ? (int)$DOCTOR['v'] : 1];
    doctor_json($env);
  }
  if ($action === 'features') {
    $host = isset($_SERVER['HTTP_HOST']) ? (string)$_SERVER['HTTP_HOST'] : '';
    doctor_json(['ok' => true, 'features' => atlas_sf_features($DOCTOR_ROOT, isset($DOCTOR['features']) && is_array($DOCTOR['features']) ? $DOCTOR['features'] : [], $host)]);
  }
  if ($action === 'health') {
    $host = isset($_SERVER['HTTP_HOST']) ? (string)$_SERVER['HTTP_HOST'] : '';
    $h = doctor_health($DOCTOR_ROOT, $host, isset($DOCTOR['trustedGroups']) && is_array($DOCTOR['trustedGroups']) ? array_slice($DOCTOR['trustedGroups'], 0, 16) : []);
    $h['ok'] = true;
    doctor_json($h);
  }
  if ($action === 'manifest') {
    $host = isset($_SERVER['HTTP_HOST']) ? (string)$_SERVER['HTTP_HOST'] : '';
    doctor_json(['ok' => true, 'manifest' => doctor_manifest($DOCTOR_ROOT, $host)]);
  }
  if ($action === 'components') {
    $host = isset($_SERVER['HTTP_HOST']) ? (string)$_SERVER['HTTP_HOST'] : '';
    $forced = preg_replace('/[^a-z]/', '', isset($_POST['mods']) ? (string)$_POST['mods'] : '');
    $ents = doctor_entries($DOCTOR_ROOT);
    $states = doctor_component_states($DOCTOR_ROOT, $host, $ents['entries'], $forced);
    $core = ['total' => 0, 'present' => 0];
    foreach ($ents['entries'] as $e) {
      if ((isset($e[6]) ? $e[6] : 'core') !== 'core' || strpos((string)$e[4], 'o') !== false) continue;
      $core['total']++;
      if (file_exists($DOCTOR_ROOT . '/' . $e[0])) $core['present']++;
    }
    $list = [['id' => 'core', 'label' => 'Core PHP issuer and libraries', 'kind' => 'core', 'code' => '', 'status' => $core['present'] === 0 ? 'missing' : 'installed', 'present' => $core['present'], 'total' => $core['total'], 'advertised' => [], 'mount' => '']];
    foreach (doctor_component_list() as $c) {
      if (!isset($c['kind']) || $c['kind'] !== 'optional' || !isset($states[$c['id']])) continue;
      $st = $states[$c['id']];
      $list[] = ['id' => $c['id'], 'label' => $c['label'], 'kind' => 'optional', 'code' => $c['code'], 'status' => $st['status'], 'present' => $st['present'], 'total' => $st['total'], 'advertised' => $st['advertised'], 'mount' => isset($ents['mounts'][$c['id']]) ? $ents['mounts'][$c['id']] : ''];
    }
    doctor_json(['ok' => true, 'components' => $list, 'advertisedAll' => array_keys(doctor_advertised($DOCTOR_ROOT, $host))]);
  }
  if ($action === 'services') {
    $host = isset($_SERVER['HTTP_HOST']) ? (string)$_SERVER['HTTP_HOST'] : '';
    $forced = preg_replace('/[^a-z]/', '', isset($_POST['mods']) ? (string)$_POST['mods'] : '');
    $ents = doctor_entries($DOCTOR_ROOT);
    $states = doctor_component_states($DOCTOR_ROOT, $host, $ents['entries'], $forced);
    $r = doctor_services($DOCTOR_ROOT, $host, $states, $ents['mounts']);
    $r['ok'] = true;
    $r['opMode'] = doctor_owner_proof_mode($DOCTOR_ROOT)[0];
    doctor_json($r);
  }
  if ($action === 'scan') {
    $host = isset($_SERVER['HTTP_HOST']) ? (string)$_SERVER['HTTP_HOST'] : '';
    $site = isset($_POST['site']) && in_array($_POST['site'], ['a', 'b'], true) ? $_POST['site'] : 'none';
    $forced = preg_replace('/[^a-z]/', '', isset($_POST['mods']) ? (string)$_POST['mods'] : '');
    $ents = doctor_entries($DOCTOR_ROOT);
    $states = doctor_component_states($DOCTOR_ROOT, $host, $ents['entries'], $forced);
    $list = doctor_applicable($ents['entries'], $site, $states);
    $cursor = max(0, (int)(isset($_POST['cursor']) ? $_POST['cursor'] : 0));
    $t0 = microtime(true);
    $results = []; $counts = [];
    $i = $cursor;
    for ($n = count($list); $i < $n && microtime(true) - $t0 < 6.0; $i++) {
      $st = doctor_check_entry($DOCTOR_ROOT, $list[$i]);
      $counts[$st] = (isset($counts[$st]) ? $counts[$st] : 0) + 1;
      if ($st !== 'ok' && $st !== 'absent-optional') {
        $sz = $st === 'differs' || $st === 'expected-differs' ? @filesize($DOCTOR_ROOT . '/' . $list[$i][0]) : false;
        $results[] = [$list[$i][0], $st, $list[$i][3], $sz === false ? null : $sz, (int)$list[$i][2], isset($list[$i][6]) ? $list[$i][6] : 'core'];
      }
    }
    doctor_json(['ok' => true, 'total' => count($list), 'next' => $i < count($list) ? $i : null, 'results' => $results, 'counts' => $counts]);
  }
  if ($action === 'extras') {
    $known = []; $byBase = [];
    $ents = doctor_entries($DOCTOR_ROOT);
    foreach ($ents['entries'] as $e) { $known[$e[0]] = true; $byBase[basename($e[0])][] = $e; }
    $r = doctor_extras($DOCTOR_ROOT, $known, $DOCTOR_SELF, 10.0, $byBase);
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
.pill { display:inline-block; min-width:2.2em; padding:1px 9px; border-radius:99px; font-size:12px; letter-spacing:.02em; text-align:center; color:#fff; white-space:nowrap; }
.pill.ok { background:var(--ok); } .pill.warn { background:var(--warn); } .pill.fail { background:var(--fail); } .pill.info { background:var(--info); }
.pill.off { background:var(--muted); } .pill.na { background:transparent; color:var(--muted); border:1px solid var(--line); }
.feat { padding:8px 0; border-top:1px solid var(--line); } .feat:first-child { border-top:0; }
.feat .t { font-weight:600; } .feat .d { color:var(--muted); font-size:14px; }
.feat ul { margin:4px 0 4px 0; padding-left:20px; font-size:14px; } .feat li { word-break:break-word; }
.feat details > summary { cursor:pointer; color:var(--accent); font-size:14px; margin-top:4px; }
.gh { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:14px 0 2px; }
.item { padding:8px 0; border-top:1px solid var(--line); } .item:first-child { border-top:0; }
.item .t { font-weight:600; } .item .d { color:var(--muted); font-size:14px; } .item .f { font-size:14px; margin-top:2px; }
.item.ok .t { font-weight:400; }
pre { margin:6px 0; padding:10px; background:var(--bg); border:1px solid var(--line); border-radius:8px; overflow:auto; font:13px/1.4 ui-monospace,Consolas,monospace; white-space:pre-wrap; word-break:break-all; }
code { font-family:ui-monospace,Consolas,monospace; font-size:13px; }
ul.paths { margin:6px 0; padding-left:20px; columns:1; } ul.paths li { word-break:break-all; font-family:ui-monospace,Consolas,monospace; font-size:13px; }
.banner { font-size:17px; font-weight:600; }
.muted { color:var(--muted); } .hidden { display:none !important; }
.notice { border-left:4px solid var(--warn); padding:6px 12px; background:var(--bg); border-radius:4px; margin:10px 0; }
label.modlabel { display:inline-block; margin-right:14px; }
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
    </div>
    <div class="muted" id="tally"></div>
    <div class="row" id="modRow">
      <span>Expect these even if no file of them is here yet:</span>
      <span id="modBoxes" class="muted">(listed after the first check)</span>
    </div>
    <div class="row"><button class="secondary" id="rerun">Check again</button></div>
  </div>
  <div id="sections"></div>
  <div class="card">
    <h2>When you are done</h2>
    <p class="muted">Copy the report to share it (home and web-root folder names are replaced), then delete this file. Do not leave it on the server.</p>
    <div class="row">
      <button class="secondary" id="copy">Copy report</button>
      <button class="secondary" id="saveReport">Download report</button>
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
    ['/atlas/studio/inc/storage-root.php', 'Studio storage setting'], ['/atlas/demo/txlab/inc/private-dir.php', 'Transaction Lab setting'],
    ['/atlas/call/lib/config.php', 'Call service settings'], ['/atlas/call/lib/config.php.off', 'Call service settings (disabled copy)'],
    ['/atlas/call/lib/state/meta.json', 'Call service state'], ['/presence/lib/store.php', 'Presence library'],
    ['/lib/owner-proof.php', 'owner-proof library'], ['/lib/atlas-owner-proof-config.json', 'owner-proof setting', 'data'], ['/lib/owner-proof/stats.json', 'owner-proof counts', 'data'],
    ['/lib/replay/', 'replay records', 'data'], ['/lib/holdings/', 'holdings records', 'data'], ['/lib/txn/', 'transaction journal', 'data'], ['/lib/mint-allowance/', 'mint allowance counters', 'data'],
    ['/lib/atlas-mail-store.json', 'mail store', 'data'], ['/lib/atlas-subscribers-store.json', 'subscriber list', 'data'], ['/lib/atlas-postoffice-members-store.json', 'Global Mail members', 'data'],
    ['/lib/atlas-tradingstation-members-store.json', 'Trading Station members', 'data'], ['/lib/atlas-admin-keys-store.json', 'administrator key list', 'data'],
    ['/chain-labs/lib/ledger.php', 'Chain Labs ledger library'], ['/chain-labs/lib/hosts.php', 'Chain Labs host list'], ['/atlas/directory/lib/store.php', 'directory library'],
    ['/atlas/directory/lib/atlas-directory-config.json', 'directory setting', 'data'], ['/presence/lib/atlas-presence-store.json', 'presence state', 'data']
  ];

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (k === 'text') n.textContent = attrs[k]; else if (k === 'class') n.className = attrs[k]; else n.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function pill(s, t) { return el('span', { 'class': 'pill ' + s, text: t || ({ ok: 'PASS', warn: 'WARNING', fail: 'FAIL', info: 'INFO', na: 'NOT INSTALLED', off: 'off' })[s] || s }); }

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
  function currentMods() { return Array.prototype.map.call(document.querySelectorAll('input[name=mod]:checked'), function (c) { return c.value; }).join(''); }
  // One tick box per optional component. Ticking one makes the doctor expect all of its files even when none is here.
  function buildModBoxes(list) {
    var box = $('modBoxes');
    if (box.getAttribute('data-built')) return;
    box.setAttribute('data-built', '1'); box.textContent = '';
    list.forEach(function (c) {
      if (c.kind !== 'optional') return;
      var inp = el('input', { type: 'checkbox', name: 'mod', value: c.code });
      inp.addEventListener('change', function () { full(false); });
      box.appendChild(el('label', { 'class': 'modlabel' }, [inp, ' ' + c.label]));
    });
  }

  var envCache = null;
  function full(first) {
    $('rerun').disabled = true; $('verdict').textContent = 'Checking…';
    var st = { missing: [], differs: [], expected: [], odd: [], counts: {}, total: 0, extras: null, probes: [], adminProbes: [], health: [], features: [], manifest: null, env: envCache, components: [], services: [], endpoints: [], opMode: null };
    var chain = Promise.resolve();
    if (first) {
      chain = chain.then(function () { step('Checking the server…'); return call('env'); }).then(function (env) {
        if (!env.ok) { var e = new Error(env.error || 'failed'); e.status = env.httpStatus; throw e; }
        envCache = env; st.env = env;
        var r = document.querySelector('input[name=site][value=' + env.detected + ']'); if (r) r.checked = true;
      });
    }
    chain = chain.then(function () { step('Working out what is installed…'); return call('components', { mods: currentMods() }); })
      .then(function (cj) {
        if (!cj.ok) throw new Error(cj.error || 'components-failed');
        st.components = cj.components;
        buildModBoxes(cj.components);
      });
    chain = chain.then(function () {
      var site = currentSite();
      function more(cursor) {
        return call('scan', { site: site, mods: currentMods(), cursor: String(cursor) }).then(function (j) {
          if (!j.ok) throw new Error(j.error || 'scan-failed');
          st.total = j.total;
          Object.keys(j.counts).forEach(function (k) { st.counts[k] = (st.counts[k] || 0) + j.counts[k]; });
          j.results.forEach(function (r) {
            var o = { path: r[0], group: r[2], size: r[3], n: r[4], comp: r[5] };
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
      .then(function (pr) { st.probes = pr; step('Checking each installed service…'); return call('services', { mods: currentMods() }); })
      .then(function (sv) { if (!sv.ok) throw new Error(sv.error || 'services-failed'); st.services = sv.checks; st.opMode = sv.opMode; step('Asking each service whether it answers…'); return endpointProbes(st.components); })
      .then(function (ep) { st.endpoints = ep; step('Reading the feature switches…'); return call('features'); })
      .then(function (f) { if (!f.ok) throw new Error(f.error || 'features-failed'); st.features = f.features; step('Checking housekeeping, permissions and administrator state…'); return call('health'); })
      .then(function (h) { if (!h.ok) throw new Error(h.error || 'health-failed'); st.health = h.checks; step('Checking that administrator routes refuse strangers…'); return adminProbes(); })
      .then(function (ap) { st.adminProbes = ap; step('Reading the manifest…'); return call('manifest'); })
      .then(function (mf) { if (!mf.ok) throw new Error(mf.error || 'manifest-failed'); st.manifest = mf.manifest; });
    return chain.then(function () { state = st; render(); }).catch(function (e) {
      $('verdict').textContent = 'The check could not finish: ' + (e && e.message ? e.message : e);
      step('');
    }).then(function () { $('rerun').disabled = false; });
  }

  // A file that must stay private counts as exposed only when what came back is that data, not a custom "not found" page.
  function looksLikeData(path, text) {
    if (!text.length) return false;
    if (/\.json$/.test(path)) { try { JSON.parse(text); return true; } catch (e) { return false; } }
    return /Index of|Parent Directory|\.json/.test(text.slice(0, 4000)) && !/<title>[^<]*(not found|404)/i.test(text.slice(0, 2000));
  }

  function probes() {
    return Promise.all(PROBES.map(function (p) {
      return fetch(p[0], { cache: 'no-store', redirect: 'manual', credentials: 'omit' }).then(function (r) {
        if (r.status !== 200) return { path: p[0], what: p[1], exposed: false, status: r.status };
        return r.text().then(function (t) {
          var leak = /<\?php|PRIVATE KEY|\/home\//.test(t.slice(0, 4000)) || (p[2] === 'data' && looksLikeData(p[0], t));
          return { path: p[0], what: p[1], exposed: leak, status: 200, empty: t.length === 0 };
        });
      }).catch(function () { return { path: p[0], what: p[1], exposed: false, status: 0 }; });
    }));
  }

  // Administrator routes asked with no credentials at all: a stranger must be refused. Only routes that read are
  // asked (never revoke, suspend or pause), the body is empty, and a request with no credentials is refused before
  // the route does any work and is not counted as a failed sign-in.
  var ADMIN_ROUTES = ['/atlas/admin/suspensions', '/atlas/admin/site-status', '/atlas/admin/visits', '/atlas/admin/session/whoami'];
  function adminProbes() {
    return Promise.all(ADMIN_ROUTES.map(function (p) {
      return fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store', redirect: 'manual', credentials: 'omit' }).then(function (r) {
        return { path: p, status: r.status, open: r.status >= 200 && r.status < 300, broken: r.status >= 500 };
      }).catch(function () { return { path: p, status: 0, open: false, broken: false }; });
    }));
  }

  // Each installed service is asked one safe question: a read that is public by design (GET), or an empty request that
  // must be refused (POST {} with no credentials). Nothing here changes anything: a refused request is decided before any
  // credential is minted, any state written or any mail sent. [component, method, path, accepted statuses, what comes back]
  var ENDPOINTS = [
    ['core', 'GET', '/atlas/capabilities', [200], 'json:requestIds'],
    ['core', 'GET', '/.well-known/atlas-key.json', [200], 'json:keys'],
    ['core', 'GET', '/.well-known/atlas-revocations.json', [200], 'json:revoked'],
    ['core', 'GET', '/.well-known/spatial.json', [200], 'json'],
    ['core', 'GET', '/atlas/calendar', [200], 'json'],
    ['core', 'POST', '/atlas/asset/issue', [400, 401, 403, 422], 'refuse'],
    ['mail', 'POST', '/atlas/mail/check', [400, 401, 403, 422], 'refuse'],
    ['trade', 'GET', '/atlas/trade/catalog', [200], 'json'],
    ['trade', 'GET', '/atlas/trade/listings', [200], 'json'],
    ['drops', 'GET', '/atlas/world/drops', [200, 400], 'json'],
    ['studio', 'GET', '/atlas/studio/', [200], 'html'],
    ['directory', 'GET', '/atlas/directory/stats.php', [200], 'json'],
    ['directory', 'GET', '/atlas/directory/search.php', [200, 400], 'json'],
    ['chainlabs', 'GET', '/chain-labs/index.html', [200], 'html'],
    ['chainlabs', 'GET', '/chain-labs/spend34.php?action=coins', [200, 503], 'json'],
    ['verifier', 'GET', '@verifier/verify.php', [200], 'json:configured'],
    ['presence', 'GET', '/presence/status.php', [200], 'json'],
    ['call', 'GET', '/atlas/call/info.php', [200], 'json']
  ];
  function endpointProbes(components) {
    var active = {}, mount = {};
    components.forEach(function (c) { active[c.id] = c.kind === 'core' || c.status !== 'not-installed'; mount[c.id] = c.mount; });
    var jobs = ENDPOINTS.filter(function (e) { return active[e[0]]; });
    return Promise.all(jobs.map(function (e) {
      var path = e[2].indexOf('@verifier/') === 0 ? '/' + (mount.verifier ? mount.verifier + '/' : '') + e[2].slice(10) : e[2];
      var opts = { method: e[1], cache: 'no-store', redirect: 'manual', credentials: 'omit' };
      if (e[1] === 'POST') { opts.headers = { 'Content-Type': 'application/json' }; opts.body = '{}'; }
      var out = { component: e[0], method: e[1], path: path, accept: e[3], kind: e[4], status: 0, state: 'fail', note: 'no response', json: null };
      return fetch(path, opts).then(function (r) {
        out.status = r.status;
        return r.text().then(function (t) {
          if (/<\?php/.test(t.slice(0, 4000))) { out.note = 'answered with PHP source code'; return out; }
          var json = null; try { json = JSON.parse(t); } catch (x) { json = null; }
          if (e[3].indexOf(r.status) < 0) {
            if (r.status >= 500) { out.state = 'fail'; out.note = 'server error (HTTP ' + r.status + ')'; }
            else if (r.status === 404) { out.state = 'fail'; out.note = 'not found (HTTP 404): the file is missing or not served'; }
            else if (e[4] === 'refuse' && r.status >= 200 && r.status < 300) { out.state = 'fail'; out.note = 'accepted an empty request (HTTP ' + r.status + ')'; }
            else { out.state = 'warn'; out.note = 'unexpected answer (HTTP ' + r.status + ')'; }
            return out;
          }
          var want = e[4].indexOf('json:') === 0 ? e[4].slice(5) : (e[4] === 'json' ? '' : null);
          if (want !== null && r.status === 200 && (json === null || typeof json !== 'object' || (want && !(want in json)))) { out.state = 'warn'; out.note = 'HTTP 200 but not the expected JSON' + (want ? ' (no "' + want + '")' : ''); return out; }
          if (e[4] === 'refuse') { out.state = 'ok'; out.note = 'refuses an empty request (HTTP ' + r.status + ')'; return out; }
          if (r.status === 503) { out.state = 'warn'; out.note = 'answers 503: installed but not set up yet'; return out; }
          if (e[4] === 'json:configured' && json && json.configured === false) { out.state = 'warn'; out.note = 'answers, but reports it is not configured'; return out; }
          out.state = 'ok'; out.note = 'answers (HTTP ' + r.status + ')'; out.json = json;
          return out;
        });
      }).catch(function () { return out; });
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
      out.push(el('div', { 'class': 'item' }, [el('div', { 'class': 't', text: label + ' - ' + GROUP[g] + ' (' + sub.length + ')' }), pathList(sub.map(function (x) { return x.path + (x.comp && x.comp !== 'core' && x.comp !== 'site' ? '  <' + x.comp + '>' : '') + (x.what ? '  [' + x.what + ']' : '') + (x.size !== null && x.size !== undefined ? '  [' + x.size + ' bytes here, ' + x.n + ' in the repository]' : ''); }))]));
    });
    return out;
  }

  // The fix-it checklist: every problem the checks found, most urgent first. The last number on each entry is
  // its place in the order (exposed secrets, then anything that stops the issuer, then settings, then tidying).
  function todo() {
    var t = [];
    var codeMissing = state.missing.filter(function (x) { return x.group === 'c'; });
    var pageMissing = state.missing.filter(function (x) { return x.group === 'p'; });
    var codeDiffers = state.differs.filter(function (x) { return x.group === 'c'; });
    state.probes.forEach(function (p) { if (p.exposed) t.push(['fail', 'Readable over the web: ' + p.path, 'Block it (check the .htaccess in that folder is uploaded and honoured) and treat any secret in it as exposed.', 0]); });
    state.adminProbes.forEach(function (p) { if (p.open) t.push(['fail', 'Administrator route answers without a sign-in: ' + p.path + ' (HTTP ' + p.status + ')', 'Replace the PHP file or server.js from the repository: an old copy has none of the newer access checks.', 0]); });
    (state.health || []).forEach(function (c) { if (c.status === 'fail') t.push(['fail', c.title, c.fix || c.detail, c.group === 'permissions' ? 1 : 3]); });
    if (codeMissing.length) t.push(['fail', 'Upload ' + codeMissing.length + ' missing code file(s). The issuer or Studio will not work without them.', 'See "Files compared with the repository".', 2]);
    if (codeDiffers.length) t.push(['fail', 'Re-upload ' + codeDiffers.length + ' code file(s) that differ from the repository.', 'An old or edited copy is the usual cause of "internal-error" responses.', 2]);
    (state.env ? state.env.checks : []).forEach(function (c) { if (c.status === 'fail') t.push(['fail', c.title, c.fix || c.detail, 3]); });
    (state.health || []).forEach(function (c) { if (c.status === 'warn') t.push(['warn', c.title, c.fix || c.detail, c.group === 'permissions' ? 4 : 5]); });
    (state.env ? state.env.checks : []).forEach(function (c) { if (c.status === 'warn') t.push(['warn', c.title, c.fix || c.detail, 5]); });
    state.adminProbes.forEach(function (p) { if (p.broken) t.push(['warn', 'Administrator route fails with a server error: ' + p.path + ' (HTTP ' + p.status + ')', 'Look at the PHP error log; the file is probably an old or damaged copy.', 5]); });
    compRows().forEach(function (r) { if (r.status === 'fail' && r.kind !== 'files') t.push(['fail', r.title, r.fix || r.detail, 2]); });
    state.services.forEach(function (c) { if (c.status === 'fail') t.push(['fail', c.title, c.fix || c.detail, 3]); });
    state.endpoints.forEach(function (e) { if (e.state === 'fail') t.push(['fail', 'Service does not answer properly: ' + e.method + ' ' + e.path + ' - ' + e.note, 'Upload the missing or old file, or look at the PHP error log.', 3]); });
    serviceExtra().forEach(function (c) { if (c.status === 'fail') t.push(['fail', c.title, c.fix || c.detail, 3]); });
    state.services.forEach(function (c) { if (c.status === 'warn') t.push(['warn', c.title, c.fix || c.detail, 5]); });
    state.endpoints.forEach(function (e) { if (e.state === 'warn') t.push(['warn', 'Service answer to look at: ' + e.method + ' ' + e.path + ' - ' + e.note, '', 5]); });
    serviceExtra().forEach(function (c) { if (c.status === 'warn') t.push(['warn', c.title, c.fix || c.detail, 5]); });
    state.features.forEach(function (f) { if (f.state === 'problem') t.push(['warn', 'Feature needs attention: ' + f.label, f.reasons.join('; '), 6]); });
    if (state.manifest) state.manifest.problems.forEach(function (p) { t.push([p[0], 'Manifest: ' + p[1], '', p[0] === 'fail' ? 3 : 6]); });
    if (pageMissing.length) t.push(['warn', 'Upload ' + pageMissing.length + ' missing page/config file(s).', '', 7]);
    var pageDiffers = state.differs.filter(function (x) { return x.group === 'p'; });
    if (pageDiffers.length) t.push(['warn', pageDiffers.length + ' page/config file(s) differ from the repository.', 'Fine if you edited them on purpose; otherwise re-upload.', 7]);
    state.odd.forEach(function (o) { t.push(['warn', 'Not a regular file: ' + o.path + ' (' + o.what + ')', 'Replace it with the repository file.', 7]); });
    if (state.extras && state.extras.phpTotal) t.push(['warn', state.extras.phpTotal + ' PHP file(s) here are not in the repository.', 'Look at each one under "Unexpected files". An old copy of a route that was later removed has none of the newer security checks and should be deleted; your own files are fine.', 8]);
    return t.map(function (x, i) { return [x, i]; }).sort(function (a, b) {
      var fa = a[0][0] === 'fail' ? 0 : 1, fb = b[0][0] === 'fail' ? 0 : 1;
      return fa - fb || a[0][3] - b[0][3] || a[1] - b[1];
    }).map(function (x) { return x[0]; });
  }

  // One row per component for the Components section.
  var CSTATE = { installed: 'ok', expected: 'fail', 'advertised-missing': 'fail', 'not-installed': 'na', missing: 'fail' };
  function compRows() {
    return state.components.map(function (c) {
      var st = CSTATE[c.status] || 'warn', title = c.label, detail, fix = '';
      if (c.status === 'not-installed') detail = 'Not installed here, so none of its files are expected.';
      else if (c.status === 'advertised-missing') { st = 'fail'; title = c.label + ' is advertised but not installed'; detail = 'The manifest advertises ' + c.advertised.join(', ') + ', but none of its ' + c.total + ' files are here.'; fix = 'Upload it, or take the service out of .well-known/spatial.json.'; }
      else if (c.status === 'expected') { st = 'fail'; title = c.label + ' is expected but not installed'; detail = 'You ticked it, but none of its ' + c.total + ' files are here.'; fix = 'Upload it, or untick it.'; }
      else if (c.status === 'missing') { title = c.label + ' is missing'; detail = 'None of its ' + c.total + ' files are here.'; fix = 'Upload the issuer.'; }
      else if (c.present < c.total) { st = 'fail'; detail = c.present + ' of ' + c.total + ' files are present; the missing ones are listed under "Files compared with the repository".'; fix = 'Upload the missing files.'; }
      else detail = 'Installed: all ' + c.total + ' files present' + (c.mount ? ' (in ' + c.mount + '/)' : '') + '.';
      return { status: st, title: title, detail: detail, fix: fix, kind: c.present < c.total && c.status === 'installed' ? 'files' : 'component', id: c.id };
    });
  }
  // Checks the browser makes from what the services answered: what the issuer advertises against what the server applies.
  function serviceExtra() {
    var out = [];
    var cap = state.endpoints.filter(function (e) { return e.path === '/atlas/capabilities' && e.state === 'ok'; })[0];
    if (cap && state.opMode) {
      var adv = cap.json && cap.json.ownerProof ? cap.json.ownerProof.mode : null;
      if (state.opMode === 'off') { if (adv !== null) out.push({ status: 'fail', title: 'Owner-proof mode advertised as ' + adv + ' but the server setting is off', detail: '', fix: 'Check the setting and upload capabilities.php together with issue.php.' }); }
      else if (adv === null) out.push({ status: 'fail', title: 'The issuer does not advertise the owner-proof check', detail: 'The server applies mode ' + state.opMode + ' but /atlas/capabilities has no ownerProof record, so wallets will not sign membership requests.', fix: 'Upload atlas/capabilities.php, atlas/asset/issue.php and lib/owner-proof.php together.' });
      else if (adv !== state.opMode) out.push({ status: 'fail', title: 'Advertised owner-proof mode (' + adv + ') differs from the server setting (' + state.opMode + ')', detail: 'The web server and this page see different settings.', fix: 'Set the mode where the web server reads it (environment variable or lib/atlas-owner-proof-config.json).' });
      else out.push({ status: 'ok', title: 'The advertised owner-proof mode matches the server setting (' + adv + ')', detail: 'Membership classes: ' + (cap.json.ownerProof.classes || []).join(', ') + '.' });
    }
    return out;
  }
  var LABEL = { ok: 'PASS', warn: 'WARNING', fail: 'FAIL', na: 'NOT INSTALLED', info: 'INFO' };
  function tally() {
    var n = { ok: 0, warn: 0, fail: 0, na: 0 };
    var add = function (s) { if (n[s] !== undefined) n[s]++; };
    state.env.checks.forEach(function (c) { add(c.status); });
    state.health.forEach(function (c) { add(c.status); });
    state.services.forEach(function (c) { add(c.status); });
    serviceExtra().forEach(function (c) { add(c.status); });
    state.endpoints.forEach(function (e) { add(e.state); });
    compRows().forEach(function (c) { add(c.status); });
    state.probes.forEach(function (p) { add(p.exposed ? 'fail' : 'ok'); });
    return n;
  }
  function tallyText() { var n = tally(); return n.ok + ' PASS, ' + n.warn + ' WARNING, ' + n.fail + ' FAIL, ' + n.na + ' NOT INSTALLED'; }

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
    else kids.push(el('p', { 'class': 'muted', text: 'In this order: anything that exposes a secret first, then what stops the issuer working, then settings, then tidying. Fix from the top and press "Check again".' }));
    problems.forEach(function (x, i) { kids.push(item(x[0], (i + 1) + '. ' + x[1], x[2])); });
    if (problems.length) kids.push(el('div', { 'class': 'row' }, [(function () { var b = el('button', { 'class': 'secondary', id: 'saveReportInline', text: 'Save this report as a file' }); b.addEventListener('click', saveReport); return b; })()]));
    section('To do - fix-it checklist', fails ? 'fail' : (warns ? 'warn' : 'ok'), problems.length ? problems.length + ' item(s)' : 'all clear', problems.length > 0, kids);

    $('tally').textContent = tallyText();
    var cr = compRows();
    var installed = cr.filter(function (r) { return r.status !== 'na'; }).length;
    section('Components (what is installed here)', worstOf(cr), installed + ' installed, ' + (cr.length - installed) + ' not installed', cr.some(function (r) { return r.status === 'fail'; }),
      [el('p', { 'class': 'muted', text: 'A part counts as installed when any of its files is here; then every one of its files is expected. A part with no file here that the manifest does not advertise is simply not installed and is never reported as missing.' })].concat(cr.map(function (r) { return item(r.status, r.title, r.detail, r.fix); })));
    var svc = state.services.concat(serviceExtra());
    var epItems = state.endpoints.map(function (e) { return item(e.state, e.method + ' ' + e.path, e.note); });
    var byComp = {}; state.services.forEach(function (c) { (byComp[c.component] = byComp[c.component] || []).push(c); });
    var svcBody = [el('p', { 'class': 'muted', text: 'Read-only: counts, sizes, modes and public settings only. Keys, messages and credentials are never opened or shown.' })];
    state.components.forEach(function (comp) {
      var rows = (byComp[comp.id] || []).concat(comp.id === 'core' ? serviceExtra() : []);
      if (!rows.length || comp.status === 'not-installed') return;
      svcBody.push(el('div', { 'class': 'gh', text: comp.label }));
      rows.forEach(function (c) { svcBody.push(item(c.status, c.title, c.detail, c.fix)); });
    });
    svcBody.push(el('div', { 'class': 'gh', text: 'Do the installed services answer?' }));
    if (epItems.length) epItems.forEach(function (x) { svcBody.push(x); }); else svcBody.push(el('p', { text: 'Nothing was asked.' }));
    state.components.filter(function (c) { return c.kind === 'optional' && c.status === 'not-installed'; }).forEach(function (c) {
      svcBody.push(item('na', c.label, 'Not installed here.'));
    });
    var svcAll = svc.map(function (c) { return { status: c.status }; }).concat(state.endpoints.map(function (e) { return { status: e.state }; }));
    section('Services and deployment checks', worstOf(svcAll), svc.length + ' check(s), ' + epItems.length + ' endpoint(s) asked', worstOf(svcAll) !== 'ok', svcBody);

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
    if (x.php.length) xb.push(el('div', { 'class': 'item' }, [el('div', { 'class': 't', text: 'Unknown PHP files - review these (' + x.phpTotal + ')' }), el('div', { 'class': 'd', text: 'Code that is not in the repository: your own work, a copy uploaded to the wrong folder, or an old route. A copy with a different content than the repository file of the same name is the one to look at first.' }), pathList(x.php.map(phpLine))]));
    if (x.other.length) xb.push(el('div', { 'class': 'item' }, [el('div', { 'class': 't', text: 'Other unknown files (' + x.otherTotal + ')' }), pathList(x.other)]));
    if (x.state.length) xb.push(el('div', { 'class': 'item' }, [el('div', { 'class': 't', text: 'Private state - listed by name only, never opened (' + x.state.length + ')' }), pathList(x.state.map(stateLine))]));
    if (x.host.length) xb.push(el('div', { 'class': 'item' }, [el('div', { 'class': 't', text: 'Hosting files (' + x.host.length + ')' }), pathList(x.host)]));
    if (x.partial) xb.push(el('p', { 'class': 'notice', text: 'The scan stopped early (time or size limit), so this list is incomplete.' }));
    section('Unexpected files', x.phpTotal ? 'warn' : 'info', x.scanned + ' files scanned', x.phpTotal > 0, xb);

    var pb = state.probes.map(function (p) {
      return item(p.exposed ? 'fail' : 'ok', p.path, p.exposed ? 'The ' + p.what + ' can be read over the web.' : 'Not readable (' + (p.status ? 'HTTP ' + p.status : 'no response') + (p.empty ? ', empty page' : '') + ').');
    });
    section('What the web can read', state.probes.some(function (p) { return p.exposed; }) ? 'fail' : 'ok', 'private helper files must not be served', false, pb);

    [['housekeeping', 'Housekeeping and health', 'lists, holdings and state files'], ['permissions', 'File permissions and PHP limits', 'who can read the keys, what PHP allows']].forEach(function (g) {
      var list = state.health.filter(function (c) { return c.group === g[0]; });
      var w = worstOf(list);
      section(g[1], w, g[2], w !== 'ok', list.length ? list.map(function (c) { return item(c.status, c.title, c.detail, c.fix); }) : [el('p', { text: 'Nothing to report.' })]);
    });
    var adminBody = state.health.filter(function (c) { return c.group === 'admin'; }).map(function (c) { return item(c.status, c.title, c.detail, c.fix); });
    adminBody.push(el('div', { 'class': 'gh', text: 'Do the administrator routes refuse a stranger?' }));
    state.adminProbes.forEach(function (p) { adminBody.push(adminProbeItem(p)); });
    var adminList = state.health.filter(function (c) { return c.group === 'admin'; }).concat(state.adminProbes.map(function (p) { return { status: p.open ? 'fail' : (p.broken ? 'warn' : 'ok') }; }));
    section('Administrator side', worstOf(adminList), 'roster, sign-in state and route protection', worstOf(adminList) !== 'ok', adminBody);

    section('Worlds and manifest', manifestWorst(), manifestSummary(), state.manifest.problems.length > 0, manifestBlocks());

    section('Features (what is switched on)', featureWorst(), featureSummary(), state.features.some(function (f) { return f.state === 'problem'; }), featureBlocks());

    section('Setup values (copy and paste)', 'info', 'for Asset Studio', false, setupBlocks(env.setup));
  }

  function worstOf(list) {
    return list.some(function (c) { return c.status === 'fail'; }) ? 'fail' : (list.some(function (c) { return c.status === 'warn'; }) ? 'warn' : 'ok');
  }
  function adminProbeItem(p) {
    if (p.open) return item('fail', p.path, 'Answered HTTP ' + p.status + ' to a request with no sign-in. A stranger must get 401 or 403.', 'Replace this route with the repository copy.');
    if (p.broken) return item('warn', p.path, 'Answered HTTP ' + p.status + ' (a server error) instead of refusing.', 'Look at the PHP error log.');
    if (p.status === 404) return item('info', p.path, 'Not installed here (HTTP 404).');
    return item('ok', p.path, 'Refused without a sign-in (HTTP ' + (p.status || 'no response') + ').');
  }
  function manifestWorst() {
    var ps = state.manifest.problems;
    return ps.some(function (p) { return p[0] === 'fail'; }) ? 'fail' : (ps.length ? 'warn' : 'ok');
  }
  function manifestSummary() {
    var m = state.manifest;
    if (m.state !== 'ok') return m.state === 'missing' ? 'no manifest on this domain' : 'manifest ' + m.state;
    return m.worlds.length + ' world(s), ' + m.problems.length + ' problem(s). Read-only: edit .well-known/spatial.json to change anything.';
  }
  function manifestBlocks() {
    var m = state.manifest, out = [];
    if (m.problems.length) {
      var pl = el('div', { 'class': 'item' }, [el('div', { 'class': 't', text: 'Problems found (' + m.problems.length + ')' })]);
      m.problems.forEach(function (p) { pl.appendChild(item(p[0], p[1])); });
      out.push(pl);
    } else if (m.state === 'ok') out.push(el('p', { text: 'No problems found. References between worlds, portals and scene files all resolve.' }));
    if (m.top.length) { var u = el('ul', { 'class': 'muted' }); m.top.forEach(function (x) { u.appendChild(el('li', { text: x })); }); out.push(el('div', { 'class': 'item' }, [el('div', { 'class': 't', text: 'This domain' }), u])); }
    m.worlds.forEach(function (w) {
      var kids = [el('div', { 'class': 't' }, [w.name || w.id, w.name ? el('span', { 'class': 'muted', text: '  (' + w.id + ')' }) : null, w.default ? el('span', { 'class': 'muted', text: '  default world' }) : null, w.playable ? null : el('span', { 'class': 'muted', text: '  not enterable' })])];
      var f = el('ul', { 'class': 'muted' }); w.facts.forEach(function (x) { f.appendChild(el('li', { text: x })); }); kids.push(f);
      if (w.portals.length) { var pu = el('ul', { 'class': 'paths' }); w.portals.forEach(function (x) { pu.appendChild(el('li', { text: x })); }); kids.push(el('details', null, [el('summary', { text: 'Portals (' + w.portals.length + ')' }), pu])); }
      out.push(el('div', { 'class': 'feat' }, kids));
    });
    return out;
  }

  var FSTATE = { on: ['ok', 'ON'], off: ['off', 'off'], problem: ['warn', '!'], absent: ['na', 'n/a'] };
  function featureWorst() { return state.features.some(function (f) { return f.state === 'problem'; }) ? 'warn' : 'info'; }
  function featureSummary() {
    var n = { on: 0, off: 0, problem: 0, absent: 0 };
    state.features.forEach(function (f) { n[f.state] = (n[f.state] || 0) + 1; });
    return n.on + ' on, ' + n.off + ' off' + (n.problem ? ', ' + n.problem + ' need attention' : '') + (n.absent ? ', ' + n.absent + ' not installed' : '') + '. Read-only: change them in files.';
  }
  function featureBlocks() {
    var out = [el('p', { 'class': 'muted', text: 'Each switch is a setting in a file or a renamed file. The doctor only reads them and never prints passwords, tokens or keys. Open "How to switch" to see what to change.' })];
    var last = null;
    state.features.forEach(function (f) {
      if (f.group !== last) { last = f.group; out.push(el('div', { 'class': 'gh', text: f.group })); }
      var s = FSTATE[f.state] || FSTATE.problem;
      var kids = [el('div', { 'class': 't' }, [el('span', { 'class': 'pill ' + s[0], text: s[1] }), ' ', f.label])];
      if (f.reasons.length) { var u = el('ul'); f.reasons.forEach(function (r) { u.appendChild(el('li', { text: r })); }); kids.push(u); }
      if (f.facts.length) { var v = el('ul', { 'class': 'muted' }); f.facts.forEach(function (r) { v.appendChild(el('li', { text: r })); }); kids.push(v); }
      kids.push(el('details', null, [el('summary', { text: 'How to switch' }),
        el('div', { 'class': 'd', text: f.about }),
        el('div', { 'class': 'f' }, [el('strong', { text: 'Turn on: ' }), f.enable]),
        el('div', { 'class': 'f' }, [el('strong', { text: 'Turn off: ' }), f.disable])]));
      out.push(el('div', { 'class': 'feat' }, kids));
    });
    return out;
  }

  function phpLine(x) {
    return x.p + '  [' + (x.date ? x.date + ', ' : '') + x.size + ' bytes]' + (x.like ? (x.same ? '  identical copy of ' + x.like + ' (misplaced duplicate)' : '  same name as ' + x.like + ' but different content') : '');
  }
  function stateLine(s) {
    if (s[3] === 'locks') return s[0] + '  [' + s[2] + ' lock files, ' + (s[4] ? s[4] + ' bytes in total' : 'all empty') + ' - normal, they are created on demand]';
    return s[3] === 'dir' ? s[0] + '  [' + s[2] + ' files]' : s[0] + '  [mode ' + s[1] + ', ' + s[2] + ' bytes]';
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
    lines.push('TO DO (most urgent first)'); if (!t.length) lines.push('  nothing'); t.forEach(function (x, i) { lines.push('  ' + (i + 1) + '. [' + x[0] + '] ' + x[1] + (x[2] ? ' - ' + x[2] : '')); });
    lines.push('', 'SUMMARY  ' + tallyText());
    lines.push('', 'COMPONENTS'); compRows().forEach(function (r) { lines.push('  [' + (LABEL[r.status] || r.status) + '] ' + r.title + ' - ' + r.detail); });
    lines.push('', 'SERVICES AND DEPLOYMENT');
    state.services.concat(serviceExtra()).forEach(function (c) { lines.push('  [' + (LABEL[c.status] || c.status) + '] ' + c.title + (c.detail ? ' - ' + c.detail : '')); });
    state.endpoints.forEach(function (e) { lines.push('  [' + (LABEL[e.state] || e.state) + '] ' + e.method + ' ' + e.path + ' - ' + e.note); });
    lines.push('', 'SERVER'); env.checks.forEach(function (x) { lines.push('  [' + x.status + '] ' + x.title + (x.detail ? ' - ' + x.detail : '')); });
    lines.push('', 'MISSING (' + state.missing.length + ')'); state.missing.forEach(function (x) { lines.push('  ' + x.path); });
    lines.push('', 'DIFFERENT (' + state.differs.length + ')'); state.differs.forEach(function (x) { lines.push('  ' + x.path + (x.size !== null && x.size !== undefined ? '  [' + x.size + ' bytes here, ' + x.n + ' in the repository]' : '')); });
    lines.push('', 'WEB EXPOSURE'); state.probes.forEach(function (p) { lines.push('  ' + (p.exposed ? 'EXPOSED ' : 'ok      ') + p.path + ' (HTTP ' + p.status + ')'); });
    lines.push('', 'MANIFEST (' + state.manifest.state + ', ' + state.manifest.worlds.length + ' world(s))');
    state.manifest.problems.forEach(function (p) { lines.push('  [' + p[0] + '] ' + p[1]); });
    state.manifest.worlds.forEach(function (w) { lines.push('  world ' + w.id + (w.default ? ' (default)' : '') + (w.playable ? '' : ' (not enterable)')); w.facts.forEach(function (x) { lines.push('        ' + x); }); w.portals.forEach(function (x) { lines.push('        portal ' + x); }); });
    [['housekeeping', 'HOUSEKEEPING'], ['permissions', 'PERMISSIONS AND PHP LIMITS'], ['admin', 'ADMINISTRATOR SIDE']].forEach(function (g) {
      lines.push('', g[1]);
      state.health.filter(function (c) { return c.group === g[0]; }).forEach(function (c) { lines.push('  [' + c.status + '] ' + c.title + (c.detail ? ' - ' + c.detail : '')); });
      if (g[0] === 'admin') state.adminProbes.forEach(function (p) { lines.push('  ' + (p.open ? 'OPEN    ' : 'refused ') + p.path + ' (HTTP ' + p.status + ')'); });
    });
    lines.push('', 'FEATURES'); state.features.forEach(function (f) {
      lines.push('  [' + f.state + '] ' + f.label + (f.reasons.length ? ' - ' + f.reasons.join('; ') : ''));
      f.facts.forEach(function (x) { lines.push('        ' + x); });
    });
    lines.push('', 'UNKNOWN PHP FILES (' + state.extras.phpTotal + ')'); state.extras.php.forEach(function (x) { lines.push('  ' + phpLine(x)); });
    lines.push('', 'OTHER UNKNOWN FILES (' + state.extras.otherTotal + ')'); state.extras.other.slice(0, 100).forEach(function (x) { lines.push('  ' + x); });
    lines.push('', 'PRIVATE STATE (names only)'); state.extras.state.slice(0, 60).forEach(function (x) { lines.push('  ' + stateLine(x)); });
    if (state.extras.state.length > 60) lines.push('  ... and ' + (state.extras.state.length - 60) + ' more');
    return redact(lines.join('\n'));
  }
  // Saves the same text as "Copy report" to a file in the browser; nothing is uploaded anywhere.
  function saveReport() {
    if (!state) return;
    var host = ((state.env && state.env.facts && state.env.facts.host) || 'site').replace(/[^a-z0-9.-]/gi, '_');
    var name = 'site-doctor-report-' + host + '-' + new Date().toISOString().slice(0, 10) + '.txt';
    var url = URL.createObjectURL(new Blob([report() + '\n'], { type: 'text/plain' }));
    var a = el('a', { href: url, download: name });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    $('doneMsg').textContent = 'Report saved as ' + name + '.';
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
  $('saveReport').addEventListener('click', saveReport);
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
      if (j.ok && j.deleted) { ['del', 'rerun', 'copy', 'saveReport', 'copyMissing'].forEach(function (id) { $(id).disabled = true; }); }
    });
  });
})();
</script>
</body>
</html>
ATLAS_DOCTOR_PAGE;
echo str_replace(['__NONCE__', '__META__'], [$nonce, $meta], $page);
