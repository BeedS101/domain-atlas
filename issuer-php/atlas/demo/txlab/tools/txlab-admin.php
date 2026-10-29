<?php
// Command-line helper for the transaction lab (never reachable over the web).
//
//   php txlab-admin.php keygen --dir DIR --domain NAME
//       creates DIR (0700), signing-key.pem (0600), public-key.txt and admin-token.sha256, and prints the
//       public key and a freshly generated demo-administrator token (shown once, never stored).
//   php txlab-admin.php config --dir DIR --domain NAME --settlement NAME --threshold N
//         --mandatory a,b --roster "name=PUBLICKEY@https://name/atlas/demo/txlab/api.php,..." [--ttl 900]
//         [--accounts alice=10000,bob=0] [--allow-insecure-http] [--enable]
//         [--public-demo [--public-set maxAmountMinor=5000,maxSessions=100]]
//       writes DIR/config.php (disabled unless --enable). --public-demo adds a publicDemo block with
//       enabled => true (visitor sessions, no administrator token); --public-set overrides limits.
//   php txlab-admin.php check --dir DIR     validates the setup the way the web endpoints do
//   php txlab-admin.php disable --dir DIR   creates DIR/DISABLED (the kill switch); delete it to re-enable
//   php txlab-admin.php reset --dir DIR --yes   deletes the lab's databases, main and public-demo (balances return to the seeded values)
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__ . '/../../../../lib/crypto.php';

function arg($name, $default = null) {
  global $argv;
  $i = array_search('--' . $name, $argv, true);
  if ($i === false) return $default;
  return isset($argv[$i + 1]) && substr($argv[$i + 1], 0, 2) !== '--' ? $argv[$i + 1] : true;
}
function die_msg($m) { fwrite(STDERR, $m . "\n"); exit(1); }

$cmd = isset($argv[1]) ? $argv[1] : '';
$dir = arg('dir');
if (!is_string($dir) || $dir === '') die_msg('--dir is required');
$dir = rtrim($dir, '/\\');

if ($cmd === 'keygen') {
  $domain = arg('domain');
  if (!is_string($domain)) die_msg('--domain is required');
  if (!is_dir($dir) && !mkdir($dir, 0700, true)) die_msg('could not create ' . $dir);
  @chmod($dir, 0700);
  if (is_file($dir . '/signing-key.pem')) die_msg('signing-key.pem already exists; refusing to overwrite it');
  $priv = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
  if ($priv === false) die_msg('key generation failed: ' . openssl_error_string());
  openssl_pkey_export($priv, $pem);
  file_put_contents($dir . '/signing-key.pem', $pem);
  chmod($dir . '/signing-key.pem', 0600);
  $d = openssl_pkey_get_details($priv);
  $pub = b64url_encode("\x04" . str_pad($d['ec']['x'], 32, "\x00", STR_PAD_LEFT) . str_pad($d['ec']['y'], 32, "\x00", STR_PAD_LEFT));
  file_put_contents($dir . '/public-key.txt', $pub . "\n");
  $token = bin2hex(random_bytes(20));
  file_put_contents($dir . '/admin-token.sha256', hash('sha256', $token) . "\n");
  chmod($dir . '/admin-token.sha256', 0600);
  echo "domain:        $domain\n";
  echo "public key:    $pub\n";
  echo "admin token:   $token\n";
  echo "(the token is shown only now; keep it in a password manager. Only its sha256 hash is stored.)\n";
  exit(0);
}

if ($cmd === 'config') {
  $domain = arg('domain'); $settlement = arg('settlement'); $threshold = (int) arg('threshold', 0);
  $mandatory = array_filter(explode(',', (string) arg('mandatory', '')));
  $rosterArg = arg('roster');
  if (!is_string($domain) || !is_string($settlement) || !is_string($rosterArg) || $threshold < 1) die_msg('--domain, --settlement, --roster and --threshold are required');
  $roster = [];
  foreach (explode(',', $rosterArg) as $item) {
    if (!preg_match('/^([^=@]+)=([A-Za-z0-9_-]+)@(https?:\/\/\S+)$/', trim($item), $m)) die_msg('bad roster item: ' . $item);
    $roster[$m[1]] = ['publicKey' => $m[2], 'baseUrl' => $m[3]];
  }
  $hashFile = $dir . '/admin-token.sha256';
  if (!is_file($hashFile)) die_msg('run keygen first (admin-token.sha256 missing)');
  $accounts = ['alice' => 10000, 'bob' => 0];
  if (is_string(arg('accounts'))) {
    $accounts = [];
    foreach (explode(',', arg('accounts')) as $a) { list($n, $v) = explode('=', $a); $accounts[$n] = (int) $v; }
  }
  $cfg = [
    'enabled' => (bool) arg('enable', false),
    'domain' => $domain, 'settlementDomain' => $settlement, 'threshold' => $threshold, 'mandatory' => array_values($mandatory),
    'ttlSeconds' => (int) arg('ttl', 900), 'accounts' => $accounts, 'roster' => $roster,
    'adminTokenHash' => trim(file_get_contents($hashFile)), 'allowInsecureHttp' => (bool) arg('allow-insecure-http', false),
  ];
  if (arg('public-demo', false)) {
    $pub = ['enabled' => true];
    if (is_string(arg('public-set'))) {
      foreach (explode(',', arg('public-set')) as $kv) {
        $parts = explode('=', $kv);
        if (count($parts) !== 2 || !preg_match('/^[A-Za-z]+$/', $parts[0]) || !preg_match('/^[0-9]+$/', $parts[1])) die_msg('bad --public-set item: ' . $kv);
        $pub[$parts[0]] = (int) $parts[1];
      }
    }
    $cfg['publicDemo'] = $pub;
  }
  file_put_contents($dir . '/config.php', "<?php\n// Transaction lab configuration. Keep this directory outside the web root.\nreturn " . var_export($cfg, true) . ";\n");
  chmod($dir . '/config.php', 0600);
  echo 'wrote ' . $dir . '/config.php (' . ($cfg['enabled'] ? 'ENABLED' : 'disabled; re-run with --enable or set enabled to true') . ")\n";
  exit(0);
}

putenv('TXLAB_PRIVATE_DIR=' . $dir);
require_once __DIR__ . '/../inc/txlab.php';

if ($cmd === 'check') {
  list($cfg, $problems) = txlab_load_config();
  if ($cfg === null) { echo "NOT READY - the lab stays disabled:\n"; foreach ($problems as $p) echo "  - $p\n"; exit(2); }
  txlab_db();
  echo "OK: domain {$cfg['domain']}, settlement {$cfg['settlementDomain']}, {$cfg['threshold']}-of-" . count($cfg['rosterDomains']) . ', roster ' . implode(', ', $cfg['rosterDomains']) . "\n";
  if ($cfg['insecure']) echo "WARNING: allowInsecureHttp is on (tests only; never on a live domain)\n";
  if ($cfg['public'] !== null) { txlab_db('public'); echo 'public demo: ENABLED (' . json_encode(txlab_public_limits($cfg)) . ")\n"; }
  else echo "public demo: off\n";
  exit(0);
}

if ($cmd === 'disable') {
  file_put_contents($dir . '/DISABLED', "disabled " . gmdate('c') . "\n");
  echo "lab disabled (delete $dir/DISABLED to enable it again)\n";
  exit(0);
}

if ($cmd === 'reset') {
  if (!arg('yes')) die_msg('refusing without --yes');
  $n = 0;
  foreach (['txlab.sqlite', 'txlab.sqlite-wal', 'txlab.sqlite-shm', 'txlab-public.sqlite', 'txlab-public.sqlite-wal', 'txlab-public.sqlite-shm'] as $f) if (is_file($dir . '/' . $f) && unlink($dir . '/' . $f)) $n++;
  echo "removed $n database file(s); balances are re-seeded from config.php on the next request\n";
  exit(0);
}

die_msg('usage: keygen | config | check | disable | reset (see the header of this file)');
