<?php
// DNS rebinding and "public name, private address" protection of the PHP directory (directory-php/.../lib/fetch.php).
// Same questions as test/verify-directory-rebinding.js: a public-looking host name is only fetched if EVERY address it
// resolves to is public, and the connection goes to an address that was checked, not to whatever a second lookup says.
//
// No real DNS, no live domain, no traffic to any other machine: dir_fetch() takes the answers from a test resolver, and the
// one request that is really made goes to a throw-away server this script starts on 127.0.0.1.
//
//   php test/verify-directory-rebinding.php
// With DIRECTORY_EXPECT_PHP=7.4 (or 8.1 ...) it also fails unless this is that PHP.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

$failures = 0;
function check($label, $ok, $detail = null) {
  global $failures;
  if ($ok) { echo "PASS $label\n"; return; }
  $failures++;
  echo "FAIL $label" . ($detail !== null ? ' :: ' . substr(json_encode($detail), 0, 300) : '') . "\n";
}

$mode = isset($argv[1]) ? $argv[1] : 'public';
$expect = getenv('DIRECTORY_EXPECT_PHP');
if ($mode === 'public') {
  echo 'Directory under test: PHP ' . PHP_VERSION . ($expect ? " (expected $expect)" : '') . "\n";
  if ($expect && !(PHP_VERSION === $expect || strpos(PHP_VERSION, $expect . '.') === 0)) {
    echo "FAILURE: PHP version mismatch: this is " . PHP_VERSION . ", expected $expect\n";
    exit(1);
  }
}
// The settings are read once per process, so public mode and local mode are two runs of this script.
putenv('DIRECTORY_ALLOW_LOCAL=' . ($mode === 'pin' ? '1' : '0'));

require_once __DIR__ . '/../directory-php/atlas/directory/lib/bootstrap.php';
require_once __DIR__ . '/../directory-php/atlas/directory/lib/fetch.php';

function refusal($parsed, $resolver) {
  try { dir_fetch($parsed, $resolver); return null; } catch (DirectoryException $e) { return $e->getMessage(); }
}

if ($mode === 'public') {
  $cases = [
    'loopback.example' => ['127.0.0.1'],
    'private-ten.example' => ['10.1.2.3'],
    'private-172.example' => ['172.16.9.9'],
    'private-192.example' => ['192.168.0.10'],
    'metadata.example' => ['169.254.169.254'],
    'cgnat.example' => ['100.64.1.1'],
    'unspecified.example' => ['0.0.0.0'],
    'v6-loopback.example' => ['::1'],
    'v6-private.example' => ['fd00::5'],
    'v6-mapped-loopback.example' => ['::ffff:127.0.0.1'],
    'mixed-public-first.example' => ['8.8.8.8', '10.0.0.5'],
    'mixed-private-first.example' => ['10.0.0.5', '8.8.8.8'],
  ];
  echo "--- public names that resolve to private or loopback addresses ---\n";
  foreach ($cases as $name => $addresses) {
    $calls = 0;
    $parsed = dir_check_url('https://' . $name . '/.well-known/spatial.json');
    $why = refusal($parsed, function ($host) use ($addresses, &$calls) { $calls++; return $addresses; });
    // The reason is the directory's own refusal, not a failed connection: nothing was ever dialled.
    check("$name (" . implode(', ', $addresses) . ') is refused as non-public, before any connection', $why !== null && strpos($why, 'non-public') !== false && $calls === 1, $why);
  }
  $why = refusal(dir_check_url('https://unresolvable.example/x'), function ($host) { return []; });
  check('a name that does not resolve is refused before any connection', $why !== null && strpos($why, 'did not resolve') !== false, $why);
  echo "--- address literals and localhost never reach a lookup ---\n";
  check('dir_check_url refuses an address literal and localhost before any lookup', refusal_url('https://127.0.0.1/x') && refusal_url('https://localhost/x') && refusal_url('https://[::1]/x'));
  echo $failures === 0 ? "\nPUBLIC-MODE REBINDING CHECKS PASSED\n" : "\n$failures PUBLIC-MODE REBINDING CHECK(S) FAILED\n";
  // Local mode needs its own process (see above).
  $self = escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg(__FILE__) . ' pin';
  passthru($self, $code);
  if ($code !== 0) $failures++;
  echo $failures === 0 ? "\nALL DIRECTORY REBINDING CHECKS PASSED (php " . PHP_VERSION . ")\n" : "\nDIRECTORY REBINDING CHECKS FAILED (php " . PHP_VERSION . ")\n";
  exit($failures === 0 ? 0 : 1);
}

function refusal_url($url) {
  try { dir_check_url($url); return false; } catch (DirectoryException $e) { return true; }
}

// ----- local mode: the connection itself -----
// A throw-away server records the Host header of every request it gets.
$dir = sys_get_temp_dir() . '/directory-rebinding-' . getmypid();
mkdir($dir);
$log = $dir . '/hits.log';
file_put_contents($dir . '/router.php', '<?php file_put_contents(' . var_export($log, true) . ', ($_SERVER["HTTP_HOST"] ?? "?") . "\n", FILE_APPEND); header("Content-Type: application/json"); echo "{\"ok\":true}";');
$sock = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
$port = (int) substr(strrchr(stream_socket_get_name($sock, false), ':'), 1);
fclose($sock);
$proc = proc_open([PHP_BINARY, '-S', '127.0.0.1:' . $port, '-t', $dir, $dir . '/router.php'], [['pipe', 'r'], ['file', '/dev/null', 'w'], ['file', '/dev/null', 'w']], $pipes);
for ($i = 0; $i < 50; $i++) { $c = @fsockopen('127.0.0.1', $port, $e1, $e2, 0.2); if ($c) { fclose($c); break; } usleep(100000); }
function hits() { global $log; return is_file($log) ? array_values(array_filter(explode("\n", file_get_contents($log)))) : []; }
function target($name, $port) { return ['url' => 'http://' . $name . ':' . $port . '/probe', 'scheme' => 'http', 'hostname' => $name, 'port' => $port, 'host' => $name . ':' . $port, 'path' => '/probe', 'query' => '']; }

try {
  echo "--- the connection goes to the address that was resolved ---\n";
  // Control: left to itself, this name does not resolve, so reaching the server proves the address was handed to curl.
  $ch = curl_init('http://pinned-name.invalid:' . $port . '/probe');
  curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_TIMEOUT => 3]);
  $direct = curl_exec($ch);
  curl_close($ch);
  check('control: without the pinned address the name cannot be reached', $direct === false);

  $calls = 0;
  $body = null; $error = null;
  try { $body = dir_fetch(target('pinned-name.invalid', $port), function ($host) use (&$calls) { $calls++; return $calls === 1 ? ['127.0.0.1'] : ['10.9.9.9']; }); } catch (DirectoryException $e) { $error = $e->getMessage(); }
  check('the request reaches the server at the address the first lookup gave', $body === '{"ok":true}' && hits() === ['pinned-name.invalid:' . $port], ['body' => $body, 'error' => $error, 'hits' => hits()]);
  check('the name is looked up once, so a different second answer is never used', $calls === 1, $calls);

  $calls = 0; $before = count(hits());
  $body = null; $error = null;
  try { $body = dir_fetch(target('pinned-name.invalid', $port), function ($host) use (&$calls) { $calls++; return ['::1', '127.0.0.1']; }); } catch (DirectoryException $e) { $error = $e->getMessage(); }
  check('with an IPv6 and an IPv4 answer, the IPv4 address is the one connected to', $body === '{"ok":true}' && count(hits()) === $before + 1, ['body' => $body, 'error' => $error]);

  $why = refusal(target('pinned-name.invalid', $port), function ($host) { return []; });
  check('local mode still refuses a name that does not resolve', $why !== null && strpos($why, 'did not resolve') !== false, $why);
} finally {
  proc_terminate($proc);
  proc_close($proc);
  array_map('unlink', glob($dir . '/*'));
  rmdir($dir);
}
echo $failures === 0 ? "LOCAL-MODE REBINDING CHECKS PASSED\n" : "$failures LOCAL-MODE REBINDING CHECK(S) FAILED\n";
exit($failures === 0 ? 0 : 1);
