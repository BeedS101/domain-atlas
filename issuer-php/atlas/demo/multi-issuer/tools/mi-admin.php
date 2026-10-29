<?php
// Command-line helper for the multi-issuer lab (never reachable over the web).
//
//   php mi-admin.php keygen --dir DIR --domain NAME
//       creates DIR (0700), signing-key.pem (0600) and public-key.txt, and prints the public key.
//   php mi-admin.php config --dir DIR --domain NAME --state NAME --roster "name=PUBLICKEY,..."
//         --issuance-threshold N --issuance-mandatory a,b --transfer-threshold N --transfer-mandatory a,b
//         [--classes joint-explorer-certificate] [--allow-insecure-http] [--open-discovery]
//         [--override "name=http://127.0.0.1:PORT/api.php?op=discovery,..."]
//         [--public-demo [--public-set maxSessions=100,transferTtlSeconds=300]] [--enable]
//       writes DIR/config.php (disabled unless --enable). The state authority must be mandatory in
//       both policies. The roster carries pinned public keys only; endpoints come from discovery.
//   php mi-admin.php manifest --dir DIR --service "asset.issue.approve=URL,asset.transfer.approve=URL[,asset.state=URL]"
//         [--valid-days 30] [--signer-dir NEWKEYDIR]
//       signs the discovery manifest (DIR/manifest.json) with the next sequence number. Publish it at
//       /.well-known/atlas-multi-issuer.json. With --signer-dir the manifest is signed by the key in
//       NEWKEYDIR and that key is endorsed by this directory's pinned key (key rotation: peers keep
//       trusting the pinned key; the new key is accepted only through the endorsement).
//   php mi-admin.php check --dir DIR     validates the setup the way the web endpoints do
//   php mi-admin.php disable --dir DIR   creates DIR/DISABLED (the kill switch); delete it to re-enable
//   php mi-admin.php reset --dir DIR --yes   deletes the lab database (assets, ownership state, sessions)
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__ . '/../../../../lib/crypto.php';

function arg($name, $default = null) {
  global $argv;
  $i = array_search('--' . $name, $argv, true);
  if ($i === false) return $default;
  return isset($argv[$i + 1]) && substr($argv[$i + 1], 0, 2) !== '--' ? $argv[$i + 1] : true;
}
function die_msg($m) { fwrite(STDERR, $m . "\n"); exit(1); }
function csv($s) { return array_values(array_filter(array_map('trim', explode(',', (string) $s)))); }
function iso($ms) { return gmdate('Y-m-d\TH:i:s\Z', (int) floor($ms / 1000)); }
function pub_of($priv) {
  $d = openssl_pkey_get_details($priv);
  return b64url_encode("\x04" . str_pad($d['ec']['x'], 32, "\x00", STR_PAD_LEFT) . str_pad($d['ec']['y'], 32, "\x00", STR_PAD_LEFT));
}

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
  $pub = pub_of($priv);
  file_put_contents($dir . '/public-key.txt', $pub . "\n");
  echo "domain:      $domain\n";
  echo "public key:  $pub\n";
  echo "(only the public key is ever shared; the private key stays in signing-key.pem)\n";
  exit(0);
}

if ($cmd === 'config') {
  $domain = arg('domain'); $state = arg('state'); $rosterArg = arg('roster');
  if (!is_string($domain) || !is_string($state) || !is_string($rosterArg)) die_msg('--domain, --state and --roster are required');
  $roster = [];
  foreach (csv($rosterArg) as $item) {
    if (!preg_match('/^([a-z0-9][a-z0-9.-]*)=([A-Za-z0-9_-]{87})$/', $item, $m)) die_msg('bad roster item (expected name=PUBLICKEY): ' . $item);
    $roster[$m[1]] = ['publicKey' => $m[2]];
  }
  $cfg = [
    'enabled' => (bool) arg('enable', false), 'domain' => $domain, 'stateAuthority' => $state, 'roster' => $roster,
    'issuance' => ['threshold' => (int) arg('issuance-threshold', 0), 'mandatory' => csv(arg('issuance-mandatory', ''))],
    'transfer' => ['threshold' => (int) arg('transfer-threshold', 0), 'mandatory' => csv(arg('transfer-mandatory', ''))],
    'assetClasses' => is_string(arg('classes')) ? csv(arg('classes')) : ['joint-explorer-certificate'],
    'allowInsecureHttp' => (bool) arg('allow-insecure-http', false), 'openDiscovery' => (bool) arg('open-discovery', false),
  ];
  if (is_string(arg('override'))) {
    $cfg['discoveryOverrides'] = [];
    foreach (csv(arg('override')) as $kv) {
      $p = explode('=', $kv, 2);
      if (count($p) !== 2) die_msg('bad --override item: ' . $kv);
      $cfg['discoveryOverrides'][$p[0]] = $p[1];
    }
  }
  if (arg('public-demo', false)) {
    $pub = ['enabled' => true];
    if (is_string(arg('public-set'))) {
      foreach (csv(arg('public-set')) as $kv) {
        $parts = explode('=', $kv);
        if (count($parts) !== 2 || !preg_match('/^[A-Za-z]+$/', $parts[0]) || !preg_match('/^[0-9]+$/', $parts[1])) die_msg('bad --public-set item: ' . $kv);
        $pub[$parts[0]] = (int) $parts[1];
      }
    }
    $cfg['publicDemo'] = $pub;
  }
  file_put_contents($dir . '/config.php', "<?php\n// Multi-issuer lab configuration. Keep this directory outside the web root.\nreturn " . var_export($cfg, true) . ";\n");
  chmod($dir . '/config.php', 0600);
  echo 'wrote ' . $dir . '/config.php (' . ($cfg['enabled'] ? 'ENABLED' : 'disabled; re-run with --enable or set enabled to true') . ")\n";
  exit(0);
}

putenv('MI_PRIVATE_DIR=' . $dir);
require_once __DIR__ . '/../inc/mi.php';

if ($cmd === 'manifest') {
  $svc = [];
  foreach (csv(arg('service', '')) as $kv) {
    $p = explode('=', $kv, 2);
    if (count($p) !== 2 || !in_array($p[0], mi_capabilities(), true)) die_msg('bad --service item: ' . $kv);
    $svc[$p[0]] = $p[1];
  }
  if (!$svc) die_msg('--service is required');
  $keyFile = $dir . '/signing-key.pem';
  if (!is_file($keyFile)) die_msg('signing-key.pem missing; run keygen first');
  $pinned = openssl_pkey_get_private(file_get_contents($keyFile));
  $pinnedPub = pub_of($pinned);
  $domain = null;
  if (is_file($dir . '/config.php')) { $c = include $dir . '/config.php'; $domain = isset($c['domain']) ? $c['domain'] : null; }
  if (!is_string($domain)) die_msg('config.php with a domain is required before the manifest can be built');
  $now = (int) round(microtime(true) * 1000);
  $prev = is_file($dir . '/manifest.json') ? json_decode(file_get_contents($dir . '/manifest.json'), true) : null;
  $seq = is_array($prev) && isset($prev['doc']['seq']) ? $prev['doc']['seq'] + 1 : 1;
  $signer = $pinned;
  $keys = [['publicKey' => $pinnedPub, 'validFrom' => iso($now - 60000), 'validUntil' => null]];
  $sd = arg('signer-dir');
  if (is_string($sd)) {
    $signer = openssl_pkey_get_private(file_get_contents(rtrim($sd, '/\\') . '/signing-key.pem'));
    if ($signer === false) die_msg('cannot read the new signing key');
    $newPub = pub_of($signer);
    $from = iso($now - 60000);
    $endorse = ['v' => MI_ENDORSEMENT_VERSION, 'domain' => $domain, 'publicKey' => $newPub, 'validFrom' => $from];
    $keys[] = ['publicKey' => $newPub, 'validFrom' => $from, 'validUntil' => null, 'endorsement' => ['by' => $pinnedPub, 'signature' => b64url_encode(ecdsa_sign_raw($pinned, canonicalize($endorse)))]];
  }
  $doc = ['domain' => $domain, 'seq' => $seq, 'issuedAtMs' => $now, 'validUntilMs' => $now + (int) arg('valid-days', 30) * 86400000, 'keys' => $keys, 'services' => $svc];
  $wrap = ['spec' => MI_DISCOVERY_VERSION, 'doc' => $doc, 'signedBy' => pub_of($signer), 'signature' => b64url_encode(ecdsa_sign_raw($signer, canonicalize($doc)))];
  file_put_contents($dir . '/manifest.json', json_encode($wrap, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT) . "\n");
  echo "wrote $dir/manifest.json (sequence $seq, valid until " . iso($doc['validUntilMs']) . ")\n";
  echo "publish it at https://$domain" . MI_WELL_KNOWN_PATH . "\n";
  exit(0);
}

if ($cmd === 'check') {
  list($cfg, $problems) = mi_load_config();
  if ($cfg === null) { echo "NOT READY - the lab stays disabled:\n"; foreach ($problems as $p) echo "  - $p\n"; exit(2); }
  mi_db();
  echo "OK: domain {$cfg['domain']}, state authority {$cfg['stateAuthority']}, issuance {$cfg['issuance']['threshold']}-of-" . count($cfg['rosterDomains']) . ' (mandatory ' . implode(',', $cfg['issuance']['mandatory']) . "), transfer {$cfg['transfer']['threshold']}-of-" . count($cfg['rosterDomains']) . ' (mandatory ' . implode(',', $cfg['transfer']['mandatory']) . "), roster " . implode(', ', $cfg['rosterDomains']) . "\n";
  if ($cfg['insecure']) echo "WARNING: allowInsecureHttp is on (tests only; never on a live domain)\n";
  if ($cfg['openDiscovery']) echo "NOTE: openDiscovery is on (this site will fetch manifests of issuers outside its roster)\n";
  echo $cfg['public'] !== null ? 'public demo: ENABLED (' . json_encode(mi_public_limits($cfg)) . ")\n" : "public demo: off\n";
  echo is_file($dir . '/manifest.json') ? "discovery manifest: present (publish it at the well-known path)\n" : "discovery manifest: NOT generated yet (php mi-admin.php manifest ...)\n";
  exit(0);
}

if ($cmd === 'disable') {
  file_put_contents($dir . '/DISABLED', 'disabled ' . gmdate('c') . "\n");
  echo "lab disabled (delete $dir/DISABLED to enable it again)\n";
  exit(0);
}

if ($cmd === 'reset') {
  if (!arg('yes')) die_msg('refusing without --yes');
  $n = 0;
  foreach (['mi.sqlite', 'mi.sqlite-wal', 'mi.sqlite-shm'] as $f) if (is_file($dir . '/' . $f) && unlink($dir . '/' . $f)) $n++;
  echo "removed $n database file(s); signing key and config are untouched\n";
  exit(0);
}

die_msg('usage: keygen | config | manifest | check | disable | reset (see the header of this file)');
