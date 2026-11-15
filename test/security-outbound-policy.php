<?php
// The PHP issuer's policy for requests to other domains (issuer-php/lib/outbound.php), against the same shared vectors
// as the Node test: which peers are acceptable, which addresses a connection may use, and how a request behaves
// (pinned address, TLS, no redirects, size and time limits, rate limits, client-safe errors). Local servers and an
// injected resolver only; nothing leaves this machine.
//
// Run: php test/security-outbound-policy.php
$root = dirname(__DIR__) . '/issuer-php';
$work = sys_get_temp_dir() . '/atlas-outbound-php-' . getmypid();
mkdir($work);
// A scratch copy of the bundle, so the rate-limit store is not the repository's.
foreach (['lib'] as $d) { mkdir("$work/$d"); foreach (glob("$root/$d/*.php") as $f) copy($f, "$work/$d/" . basename($f)); }
foreach (glob("$root/lib/*", GLOB_ONLYDIR) as $sub) { /* state directories are not needed */ }
putenv('ATLAS_DOMAIN=issuer.example');
$domainForTests = 'issuer.example';
require "$work/lib/bootstrap.php";

$failures = 0; $passes = 0;
function check($name, $ok, $detail = null) {
  global $failures, $passes;
  if ($ok) { $passes++; echo "PASS $name\n"; }
  else { $failures++; echo "FAIL $name" . ($detail === null ? '' : ' :: ' . substr(json_encode($detail), 0, 240)) . "\n"; }
}
function accepts($text, $local) { try { atlas_outbound_parse_peer($text, $local); return true; } catch (AtlasOutboundException $e) { return false; } }
function attempt($fn) { try { $fn(); return null; } catch (AtlasOutboundException $e) { return $e; } }
function reset_rate() { @unlink(atlas_outbound_rate_file()); }

$vectors = json_decode(file_get_contents(__DIR__ . '/support/outbound-vectors.json'), true);
echo "--- which peers are acceptable ---\n";
foreach ($vectors['production']['accept'] as $t) check('production accepts ' . json_encode($t), accepts($t, false));
foreach ($vectors['production']['reject'] as $t) check('production rejects ' . json_encode($t), !accepts($t, false), $t);
foreach ($vectors['production']['rejectNonStrings'] as $v) check('production rejects non-string ' . json_encode($v), !accepts($v, false) && !accepts($v, true));
foreach ($vectors['local']['accept'] as $t) check('a local development server accepts ' . json_encode($t), accepts($t, true));
foreach ($vectors['local']['reject'] as $t) check('a local development server rejects ' . json_encode($t), !accepts($t, true), $t);
check('production never accepts a loopback peer', !accepts('localhost:8001', false) && !accepts('127.0.0.1:8001', false) && !accepts('[::1]:8001', false));

echo "--- which addresses a connection may use ---\n";
foreach ($vectors['addresses']['public'] as $ip) check("public address $ip", atlas_outbound_is_public_address($ip) === true);
foreach ($vectors['addresses']['nonPublic'] as $ip) check('non-public address ' . json_encode($ip), atlas_outbound_is_public_address($ip) === false);

// Local servers run as child processes (PHP has no async server of its own): a tiny router script per behaviour.
$certDir = "$work/certs"; mkdir($certDir);
$sh = function ($cmd) use ($certDir) { exec('cd ' . escapeshellarg($certDir) . ' && ' . $cmd . ' 2>&1', $out, $rc); if ($rc !== 0) { echo "FATAL $cmd\n" . implode("\n", $out) . "\n"; exit(1); } };
$sh('openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -subj "/CN=Test CA" -days 2');
$sh('openssl req -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr -subj "/CN=peer-a.example"');
file_put_contents("$certDir/ext.cnf", "subjectAltName=DNS:peer-a.example,DNS:peer-b.example\n");
$sh('openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out leaf.pem -days 2 -extfile ext.cnf');
$sh('cat leaf.pem leaf.key > bundle.pem');

// A tiny HTTPS and HTTP server in Node, driven by files: ?mode is read from the request path prefix.
$serverJs = <<<'JS'
const https = require('https'), http = require('http'), fs = require('fs');
const dir = process.argv[2];
let behave = 'ok';
const hits = [];
const handler = (req, res) => {
  if (req.url.startsWith('/__behave/')) { behave = req.url.slice(10); res.end('ok'); return; }
  if (req.url === '/__hits') { res.end(JSON.stringify(hits)); return; }
  hits.push(req.url);
  if (behave === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); return res.end(); }
  if (behave === 'hang') return;
  if (behave === 'huge-declared') { res.writeHead(200, { 'content-length': String(9 * 1024 * 1024) }); return res.end('x'); }
  if (behave === 'huge-streamed') { res.writeHead(200); return res.end('x'.repeat(5 * 1024 * 1024)); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ keys: [{ publicKey: 'k', validFrom: '2020-01-01T00:00:00Z' }], host: req.headers.host }));
};
const t = https.createServer({ key: fs.readFileSync(dir + '/leaf.key'), cert: fs.readFileSync(dir + '/leaf.pem') }, handler);
const p = http.createServer(handler);
t.listen(0, '127.0.0.1', () => p.listen(0, '127.0.0.1', () => { console.log(JSON.stringify({ tls: t.address().port, plain: p.address().port })); }));
JS;
file_put_contents("$work/server.js", $serverJs);
$proc = proc_open(['node', "$work/server.js", $certDir], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
$ports = json_decode(trim(fgets($pipes[1])), true);
if (!$ports) { echo "FATAL test server did not start\n"; exit(1); }
$tlsPort = $ports['tls']; $plainPort = $ports['plain'];
$behave = function ($mode) use ($plainPort) { file_get_contents("http://127.0.0.1:$plainPort/__behave/$mode"); };
$hitCount = function () use ($plainPort) { return count(json_decode(file_get_contents("http://127.0.0.1:$plainPort/__hits"), true)); };
$publicIp = '93.184.216.34';
$useHooks = function ($resolve, $port = null, $withCa = true) use ($tlsPort, $certDir) {
  $GLOBALS['atlas_outbound_test_hooks'] = [
    'resolve' => $resolve,
    'connect' => function ($peer, $ip) use ($port, $tlsPort, $withCa, $certDir) {
      return ['ip' => '127.0.0.1', 'port' => $port !== null ? $port : $tlsPort, 'cainfo' => $withCa ? "$certDir/ca.pem" : null];
    },
  ];
};
putenv('ATLAS_OUTBOUND_RATE_WINDOW_MS=60000');

echo "--- normal https federation between two domains ---\n";
reset_rate();
$useHooks(function () use ($publicIp) { return [$publicIp]; });
$behave('ok');
$res = atlas_peer_request('GET', 'peer-a.example', '/.well-known/atlas-key.json', null, 'key');
$doc = json_decode($res['raw'], true);
check('a public peer with a valid certificate answers', $res['status'] === 200 && count($doc['keys']) === 1, $res);
check("the request carries the peer's own host name", ($doc['host'] ?? null) === 'peer-a.example', $doc);
$res = atlas_peer_post_json('peer-b.example', '/atlas/postoffice/relay', ['hello' => 'world']);
check('a JSON POST to the second domain works the same way', $res['status'] === 200, $res);
$err = attempt(function () { atlas_peer_request('GET', 'peer-c.example', '/x'); });
check('a certificate that does not name the peer is refused', $err && $err->outboundCode === 'unreachable', $err ? $err->getMessage() : null);
$useHooks(function () use ($publicIp) { return [$publicIp]; }, null, false);
$err = attempt(function () { atlas_peer_request('GET', 'peer-a.example', '/x'); });
check('a certificate from an untrusted authority is refused', $err && $err->outboundCode === 'unreachable', $err ? $err->getMessage() : null);

echo "--- destinations the policy refuses before connecting ---\n";
reset_rate();
$useHooks(function () use ($publicIp) { return [$publicIp]; });
$before = $hitCount();
$bad = [['http://127.0.0.1:' . $plainPort, 'a URL'], ['127.0.0.1:' . $plainPort, 'loopback'], ['localhost:' . $plainPort, 'localhost'], ['169.254.169.254', 'the metadata address'], ['10.0.0.5', 'a private address'], ['metadata.google.internal', 'the metadata name'], ['user@peer-a.example', 'userinfo'], ['peer-a.example/x', 'a path']];
foreach ($bad as $b) {
  $err = attempt(function () use ($b) { atlas_peer_request('GET', $b[0], '/.well-known/atlas-key.json'); });
  check('production refuses ' . $b[1], $err && $err->outboundCode === 'peer-invalid' && !preg_match('/10\.0\.0|127\.0|169\.254/', str_replace($b[0], '', $err->getMessage())), $err ? [$err->outboundCode, $err->getMessage()] : null);
}
check('none of those reached a server', $hitCount() === $before);
foreach ([['looks-public.example', ['10.1.2.3'], 'a public-looking name that resolves to a private address'], ['mixed.example', [$publicIp, '127.0.0.1'], 'a name with one public and one internal address'], ['v6.example', ['::1'], 'a name that resolves to ::1'], ['mapped.example', ['::ffff:169.254.169.254'], 'a name that resolves to an IPv4-mapped metadata address']] as $c) {
  $useHooks(function () use ($c) { return $c[1]; });
  $err = attempt(function () use ($c) { atlas_peer_request('GET', $c[0], '/x'); });
  check($c[2] . ' is refused', $err && $err->outboundCode === 'peer-invalid' && !preg_match('/10\.1\.2\.3/', $err->getMessage()), $err ? $err->getMessage() : null);
}
$useHooks(function () { return []; });
$err = attempt(function () { atlas_peer_request('GET', 'nothing.example', '/x'); });
check('a name that does not resolve is refused as unreachable', $err && $err->outboundCode === 'unreachable');

echo "--- DNS rebinding: the address that was checked is the address connected to ---\n";
$calls = 0; $dialed = [];
$GLOBALS['atlas_outbound_test_hooks'] = [
  'resolve' => function () use (&$calls, $publicIp) { return ++$calls === 1 ? [$publicIp] : ['127.0.0.1']; },
  'connect' => function ($peer, $ip) use (&$dialed, $tlsPort, $certDir) { $dialed[] = $ip; return ['ip' => '127.0.0.1', 'port' => $tlsPort, 'cainfo' => "$certDir/ca.pem"]; },
];
reset_rate();
atlas_peer_request('GET', 'peer-a.example', '/x');
$second = attempt(function () { atlas_peer_request('GET', 'peer-a.example', '/x'); });
check('the connection is made to the address that passed the check', count($dialed) === 1 && $dialed[0] === $publicIp, $dialed);
check('a later answer pointing inside is refused, and nothing is dialed for it', $second && $second->outboundCode === 'peer-invalid' && count($dialed) === 1);
check('the name is resolved once per request', $calls === 2);

echo "--- redirects, size, time ---\n";
reset_rate();
$useHooks(function () use ($publicIp) { return [$publicIp]; });
$behave('redirect'); $h = $hitCount();
$err = attempt(function () { atlas_peer_request('GET', 'peer-a.example', '/x'); });
check('a redirect is refused, not followed', $err && $err->outboundCode === 'redirect-refused' && $hitCount() === $h + 1, $err ? $err->outboundCode : null);
putenv('ATLAS_OUTBOUND_MAX_BYTES=' . (1024 * 1024));
$behave('huge-declared');
$err = attempt(function () { atlas_peer_request('GET', 'peer-a.example', '/x'); });
check('a response that declares too much is refused', $err && $err->outboundCode === 'too-large', $err ? $err->outboundCode : null);
$behave('huge-streamed');
$err = attempt(function () { atlas_peer_request('GET', 'peer-a.example', '/x'); });
check('a response that streams past the limit is cut off', $err && $err->outboundCode === 'too-large', $err ? $err->outboundCode : null);
putenv('ATLAS_OUTBOUND_MAX_BYTES');
putenv('ATLAS_OUTBOUND_TIMEOUT_MS=1000');
$behave('hang'); $t0 = microtime(true);
$err = attempt(function () { atlas_peer_request('GET', 'peer-a.example', '/x'); });
check('a peer that never answers times out', $err && $err->outboundCode === 'timeout' && microtime(true) - $t0 < 5, $err ? $err->outboundCode : null);
putenv('ATLAS_OUTBOUND_TIMEOUT_MS');
$behave('ok');
$useHooks(function () use ($publicIp) { return [$publicIp]; }, 1);
$err = attempt(function () { atlas_peer_request('GET', 'peer-a.example', '/x'); });
check('a refused connection gives a client-safe message', $err && $err->getMessage() === 'could not reach peer-a.example' && preg_match('/curl 7/', (string) $err->detail), $err ? [$err->getMessage(), $err->detail] : null);

echo "--- rate limits count attempts, failures included ---\n";
$useHooks(function () use ($publicIp) { return [$publicIp]; });
putenv('ATLAS_OUTBOUND_KEY_RATE=3'); putenv('ATLAS_OUTBOUND_KEY_RATE_ALL=5');
reset_rate();
$h = $hitCount(); $codes = [];
for ($i = 0; $i < 5; $i++) { $e = attempt(function () { atlas_peer_request('GET', 'peer-a.example', '/.well-known/atlas-key.json', null, 'key'); }); $codes[] = $e ? $e->outboundCode : null; }
check('the fourth key lookup for one domain is refused before connecting', $codes[3] === 'rate-limited' && $codes[4] === 'rate-limited' && $hitCount() === $h + 3, $codes);
$others = [];
for ($i = 0; $i < 3; $i++) { $e = attempt(function () { atlas_peer_request('GET', 'peer-b.example', '/.well-known/atlas-key.json', null, 'key'); }); $others[] = $e ? $e->outboundCode : null; }
check('another domain has its own budget until the overall budget is spent', $others[0] === null && $others[1] === null && $others[2] === 'rate-limited', $others);
putenv('ATLAS_OUTBOUND_KEY_RATE=2'); putenv('ATLAS_OUTBOUND_KEY_RATE_ALL=50');
reset_rate();
$useHooks(function () use ($publicIp) { return [$publicIp]; }, 1);
$failed = [];
for ($i = 0; $i < 4; $i++) { $e = attempt(function () { atlas_peer_request('GET', 'dead.example', '/x', null, 'key'); }); $failed[] = $e->outboundCode; }
check('failed lookups use up the budget too', implode(',', $failed) === 'unreachable,unreachable,rate-limited,rate-limited', $failed);
putenv('ATLAS_OUTBOUND_KEY_RATE=5'); putenv('ATLAS_OUTBOUND_KEY_RATE_ALL=6');
reset_rate();
$many = [];
for ($i = 0; $i < 9; $i++) { $e = attempt(function () use ($i) { atlas_peer_request('GET', "made-up-$i.example", '/x', null, 'key'); }); $many[] = $e->outboundCode; }
check('a flood of made-up domains hits the overall budget', count(array_unique(array_slice($many, 0, 6))) === 1 && $many[0] === 'unreachable' && count(array_unique(array_slice($many, 6))) === 1 && $many[6] === 'rate-limited', $many);
putenv('ATLAS_OUTBOUND_KEY_RATE'); putenv('ATLAS_OUTBOUND_KEY_RATE_ALL');
reset_rate();

echo "--- local development ---\n";
$GLOBALS['atlas_outbound_test_hooks'] = [];
check('production does not allow loopback', atlas_outbound_allow_local() === false);
$_SERVER['HTTP_HOST'] = 'localhost:8001';
check('a request that claims a local Host header does not change that', atlas_outbound_allow_local() === false);
$h = $hitCount();
$err = attempt(function () use ($plainPort) { atlas_peer_request('GET', 'localhost:' . $plainPort, '/x'); });
check('so a loopback peer is refused without connecting', $err && $err->outboundCode === 'peer-invalid' && $hitCount() === $h);
putenv('ATLAS_ALLOW_LOCAL_PEERS=1');
check('an explicit setting allows local development', atlas_outbound_allow_local() === true);
reset_rate();
$res = atlas_peer_request('GET', 'localhost:' . $plainPort, '/.well-known/atlas-key.json');
check('then a loopback peer is reached over http', $res['status'] === 200, $res['status']);
$res = atlas_peer_request('GET', '127.0.0.1:' . $plainPort, '/.well-known/atlas-key.json');
check('including by address', $res['status'] === 200, $res['status']);
$err = attempt(function () { atlas_peer_request('GET', '10.0.0.5', '/x'); });
check('but still refuses a private address', $err && $err->outboundCode === 'peer-invalid');
$err = attempt(function () use ($plainPort) { atlas_peer_request('GET', 'http://localhost:' . $plainPort, '/x'); });
check('and still refuses a URL', $err && $err->outboundCode === 'peer-invalid');
putenv('ATLAS_ALLOW_LOCAL_PEERS=0');
check('and an explicit 0 turns it off', atlas_outbound_allow_local() === false);
putenv('ATLAS_ALLOW_LOCAL_PEERS');

proc_terminate($proc);
echo "\n" . ($failures ? "$failures CHECK(S) FAILED" : 'ALL CHECKS PASSED') . "\n";
exec('rm -rf ' . escapeshellarg($work));
exit($failures ? 1 : 0);
