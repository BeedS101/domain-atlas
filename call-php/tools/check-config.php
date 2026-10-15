<?php
// Checks a Call Service settings file the way the service does and says what is wrong.
//
//   php check-config.php [path/to/config.php]
//
// With no argument it reads atlas/call/lib/config.php next to this tool, or the file named by
// the ATLAS_CALL_CONFIG environment variable. Prints OK, or the first problem, and exits 0 or 1.
// Run it on the host before the first call (over SSH or the hosting panel's terminal); it does
// not need the web server. Not part of what is uploaded to a web host.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require __DIR__ . '/../atlas/call/lib/bootstrap.php';

$file = isset($argv[1]) ? $argv[1] : null;
if ($file === null) {
  $env = getenv('ATLAS_CALL_CONFIG');
  $file = $env ?: __DIR__ . '/../atlas/call/lib/config.php';
}
$cfg = CallConfig::load($file);
if ($cfg['configured']) {
  $state = $cfg['stateDir'];
  $ok = is_dir($state) ? is_writable($state) : is_writable(dirname($state));
  echo "OK: configured for {$cfg['origin']} (domain {$cfg['domain']})\n";
  echo 'state folder: ' . ($ok ? 'writable' : 'NOT writable') . "\n";
  echo 'TURN: ' . ($cfg['turnUrls'] ? implode(', ', $cfg['turnUrls']) : 'none') . "\n";
  echo 'STUN: ' . ($cfg['stunUrls'] ? implode(', ', $cfg['stunUrls']) : 'none (direct connections only)') . "\n";
  echo 'revocations: ' . ($cfg['revocationsFile'] ? 'file ' . $cfg['revocationsFile'] . (is_readable($cfg['revocationsFile']) ? ' (readable)' : ' (NOT readable: tag creation will fail closed)') : ($cfg['revocationsUrl'] ?: 'none (revoked memberships are not checked)')) . "\n";
  exit($ok ? 0 : 1);
}
fwrite(STDERR, 'PROBLEM: ' . $cfg['problem'] . "\n");
exit(1);
