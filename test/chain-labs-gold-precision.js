// A Gold credential carries decimal numbers in its element properties (atomic weight 196.97, density 19.32), and the authority checks
// the issuer's signature over their canonical text. PHP writes a float with its serialize_precision setting, which many hosts do not
// leave at the shortest round-trip form (-1), so the check has to fix it for itself. Runs the real adapter check against a credential
// minted by a throw-away issuer under both settings.
// Also: the adapter's HTTP exchange names itself (a host in front of the issuer may turn away a request without a User-Agent) and
// works with or without cURL.
//   node test/chain-labs-gold-precision.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, execFile } = require('child_process');
const { startPhp, api } = require('./lib/gen1-issuers');
const S = require('./support/chain-labs-servers');

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };

(async () => {
  const issuer = await startPhp(9661 + Math.floor(Math.random() * 100), { workers: 0 });
  try {
    const IA = api(issuer);
    const issuerKey = JSON.parse(fs.readFileSync(issuer.keyFile, 'utf8')).keys[0].publicKey;
    const w = S.wallet();
    const minted = await IA.post('/atlas/asset/issue', { ownerPublicKey: w.key, assetClass: 'atlas.element.gold', quantity: 10 });
    line(minted.status === 200 && minted.body.asset.properties['atlas.weight'].value === 196.97, 'the issuer signs a Gold credential with a fractional atomic weight', minted.status);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-precision-'));
    const script = path.join(dir, 'check.php');
    fs.writeFileSync(path.join(dir, 'credential.json'), JSON.stringify(minted.body));
    fs.writeFileSync(script, "<?php\nrequire_once '" + path.join(__dirname, '..', 'chain-labs', 'lib', 'ledger.php') + "';\nrequire_once '" + path.join(__dirname, '..', 'chain-labs', 'lib', 'gold-issuer.php') + "';\n" +
      "$g = gold_issuer_adapter(['issuerUrl' => 'http://127.0.0.1:1', 'issuerDomain' => " + JSON.stringify(issuer.domain) + ", 'issuerKey' => " + JSON.stringify(issuerKey) + "]);\n" +
      "$c = json_decode(file_get_contents(__DIR__ . '/credential.json'), true);\n" +
      "echo json_encode(['precision' => ini_get('serialize_precision'), 'answer' => $g['verify']([], $c, ['issuerKey' => " + JSON.stringify(issuerKey) + ", 'priceClass' => 'atlas.element.gold'], time())]);\n");
    for (const precision of ['-1', '17', '14']) {
      const out = JSON.parse(execFileSync('php', ['-d', 'serialize_precision=' + precision, script]).toString());
      line(out.answer === 'the intent has no payload', 'with serialize_precision ' + precision + ' the issuer\'s signature on the credential checks out (it stops at the missing intent)', out);
    }
    fs.rmSync(dir, { recursive: true, force: true });

    console.log('\n== the HTTP exchange');
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers['user-agent'] || '');
      if (!req.headers['user-agent']) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('blocked'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, method: req.method }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = 'http://127.0.0.1:' + server.address().port + '/x';
    const probe = path.join(os.tmpdir(), 'gold-http-' + process.pid + '.php');
    fs.writeFileSync(probe, "<?php\nrequire_once '" + path.join(__dirname, '..', 'chain-labs', 'lib', 'ledger.php') + "';\nrequire_once '" + path.join(__dirname, '..', 'chain-labs', 'lib', 'gold-issuer.php') + "';\necho json_encode(gold_issuer_http($argv[1], $argv[2], $argv[1] === 'POST' ? ['a' => 1] : null, null, 5));\n");
    const run = (args) => new Promise((resolve) => execFile('php', args, (err, out) => resolve(err ? 'ERR ' + err.message : out)));
    for (const [label, flags] of [['with cURL', []], ['without cURL', ['-d', 'disable_functions=curl_init']]]) {
      seen.length = 0;
      const got = await run([...flags, probe, 'GET', url]);
      line(got === JSON.stringify([200, { ok: true, method: 'GET' }]) && seen[0] === 'domain-atlas-chainlabs/1', 'a GET ' + label + ' is answered and names itself', { got, seen });
      const post = await run([...flags, probe, 'POST', url]);
      line(post === JSON.stringify([200, { ok: true, method: 'POST' }]), 'a POST ' + label + ' is answered', post);
    }
    server.close();

    console.log('\n== a partner that cannot read the issuer\'s hold status says why');
    const probe2 = path.join(os.tmpdir(), 'gold-busy-' + process.pid + '.php');
    fs.writeFileSync(probe2, "<?php\nrequire_once '" + path.join(__dirname, '..', 'chain-labs', 'lib', 'ledger.php') + "';\nrequire_once '" + path.join(__dirname, '..', 'chain-labs', 'lib', 'gold-issuer.php') + "';\n" +
      "$cred = json_decode(file_get_contents($argv[1]), true);\n$out = [];\nforeach ([403, 0] as $status) {\n" +
      "  $g = gold_issuer_adapter(['issuerUrl' => 'http://x', 'issuerDomain' => $cred['issuer']['domain'], 'issuerKey' => 'k', 'http' => fn() => [$status, null]]);\n" +
      "  try { $g['holding']('a', $cred, ['payload' => ['coinId' => 'c']], time()); $out[] = 'no error'; } catch (LedgerError $e) { $out[] = $e->reason . ': ' . $e->getMessage(); }\n}\necho json_encode($out);\n");
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gold-busy-'));
    fs.writeFileSync(path.join(dir2, 'c.json'), JSON.stringify(minted.body));
    const busy = JSON.parse(await run([probe2, path.join(dir2, 'c.json')]));
    line(busy[0] === 'busy: the issuer\'s hold status cannot be read yet (HTTP 403)' && busy[1] === 'busy: the issuer\'s hold status cannot be read yet (no answer from the issuer)', 'the refusal names the HTTP status, or that the issuer did not answer', busy);
    fs.rmSync(probe2, { force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
    fs.rmSync(probe, { force: true });
  } finally {
    issuer.stop();
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' GOLD PRECISION CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); process.exit(1); });
