// A Gold credential carries decimal numbers in its element properties (atomic weight 196.97, density 19.32), and the authority checks
// the issuer's signature over their canonical text. PHP writes a float with its serialize_precision setting, which many hosts do not
// leave at the shortest round-trip form (-1), so the check has to fix it for itself. Runs the real adapter check against a credential
// minted by a throw-away issuer under both settings.
//   node test/chain-labs-gold-precision.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
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
  } finally {
    issuer.stop();
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' GOLD PRECISION CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); process.exit(1); });
