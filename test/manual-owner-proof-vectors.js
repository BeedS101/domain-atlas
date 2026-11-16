// Runs the shared owner-proof decision table (test/vectors/owner-proof.json) through every implementation and requires
// each to return exactly the expected verdict for every case:
//   issuer-server/lib-owner-proof.js   (in process)
//   issuer-php/lib/owner-proof.php     (php CLI)
//   extension/owner-proof-core.js      (payload bytes only: the wallet builds the request, it does not judge it)
// A new rule is added to the table first, then implemented in both issuers.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { webcrypto } = require('crypto');
const proof = require('../issuer-server/lib-owner-proof');
const core = require('../extension/owner-proof-core');

const vectorsFile = path.resolve(__dirname, 'vectors', 'owner-proof.json');
const doc = JSON.parse(fs.readFileSync(vectorsFile, 'utf8'));
const b64u = (s) => Buffer.from(s, 'base64url');

async function verify(payload, p) {
  if (p.signerRole !== 'raw-ecdsa') return false;
  const key = await webcrypto.subtle.importKey('raw', b64u(p.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64u(p.signature), new TextEncoder().encode(proof.canonicalize(payload)));
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => { o[k] = sortKeys(v[k]); return o; }, {});
  return v;
}
const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const shape = (r) => { const o = Object.assign({}, r); delete o.error; delete o.issuedAtMs; delete o.updateWallet; return o; };

(async () => {
  let failures = 0;
  const fail = (msg, extra) => { failures++; console.log('FAIL ' + msg + (extra ? ' :: ' + JSON.stringify(extra) : '')); };
  const phpOut = JSON.parse(execFileSync('php', [path.resolve(__dirname, 'vectors', 'run-owner-proof.php'), vectorsFile], { encoding: 'utf8' }));
  if (phpOut.length !== doc.cases.length) fail('php returned ' + phpOut.length + ' verdicts for ' + doc.cases.length + ' cases');

  for (let i = 0; i < doc.cases.length; i++) {
    const c = doc.cases[i];
    const node = shape(await proof.ownerProofVerdict(c.body, c.ctx, verify));
    if (!same(node, c.expect)) fail('node: ' + c.name, { got: node, want: c.expect });
    if (!same(phpOut[i], c.expect)) fail('php: ' + c.name, { got: phpOut[i], want: c.expect });
    if (c.canonicalPayload) {
      const built = core.canonicalize(core.issuePayload({
        assetClass: c.body.assetClass, domain: c.ctx.domain, issuedAt: c.body.intent.payload.issuedAt,
        ownerPublicKey: c.body.ownerPublicKey, requestId: c.body.requestId
      }));
      if (built !== c.canonicalPayload) fail('wallet core builds different bytes: ' + c.name, { built, want: c.canonicalPayload });
    }
  }
  // The classes and the window are one set of facts in three places.
  if (!same(core.OWNER_PROOF_CLASSES, proof.OWNER_PROOF_CLASSES)) fail('wallet and issuer disagree on the gated classes');
  if (core.OWNER_PROOF_WINDOW_MS !== proof.OWNER_PROOF_WINDOW_MS) fail('wallet and issuer disagree on the window');
  const phpConst = execFileSync('php', ['-r', 'require "' + path.resolve(__dirname, '../issuer-php/lib/owner-proof.php') + '"; echo json_encode([ATLAS_OWNER_PROOF_CLASSES, ATLAS_OWNER_PROOF_WINDOW_MS]);'], { encoding: 'utf8' });
  if (!same(JSON.parse(phpConst), [proof.OWNER_PROOF_CLASSES, proof.OWNER_PROOF_WINDOW_MS])) fail('php disagrees on the gated classes or window');

  console.log((failures ? 'FAILED: ' : 'ok: ') + doc.cases.length + ' cases, node and php' + (failures ? ', ' + failures + ' failures' : ' identical'));
  process.exit(failures ? 1 : 0);
})();
