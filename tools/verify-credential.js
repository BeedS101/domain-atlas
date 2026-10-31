#!/usr/bin/env node
// Independently verifies an issued credential against the issuer's published key, without the wallet.
//
//   node tools/verify-credential.js credential.json [--base https://example.com]
//
// credential.json is the credential as copied from the wallet ("Copy credential" in the item viewer). The key is
// fetched from the issuer's own domain (credential.issuer.domain over https), or from --base when given (for a
// local test issuer). Checks: the issuer public key is one the issuer publishes and was valid at issuedAt; the
// ECDSA P-256 signature over the canonical payload; the credential is not on the issuer's revocation list; and,
// for an Asset Studio collectible, its class, owner-bound scope, and that its design digest matches its fields.
// Read-only. Exit code 0 when every check passes, 1 otherwise.
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^https?:\/\//.test(a));
const baseArg = (() => { const i = args.indexOf('--base'); return i >= 0 ? args[i + 1] : null; })();
if (!file) { console.error('usage: node tools/verify-credential.js credential.json [--base https://example.com]'); process.exit(2); }

let failures = 0;
const check = (name, ok, detail) => { if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' - ' + detail : '')); };

const b64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}
function get(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    (u.protocol === 'https:' ? https : http).get(u, { timeout: 20000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let doc = null; try { doc = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* not JSON */ } resolve({ status: res.statusCode, doc }); });
    }).on('error', () => resolve({ status: 0, doc: null })).on('timeout', function () { this.destroy(); });
  });
}

(async () => {
  let cred;
  try { cred = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('cannot read ' + file + ': ' + e.message); process.exit(2); }
  check('is a Domain Atlas asset credential', cred && cred.credential === 'domain-atlas-asset/1.0' && cred.asset && cred.issuer && typeof cred.signature === 'string');
  if (failures) process.exit(1);

  const base = (baseArg || 'https://' + cred.issuer.domain).replace(/\/+$/, '');
  console.log('issuer: ' + cred.issuer.domain + ' (keys read from ' + base + ')');

  const keyRead = await get(base + '/.well-known/atlas-key.json');
  check('issuer publishes its keys', keyRead.status === 200 && keyRead.doc && Array.isArray(keyRead.doc.keys), 'HTTP ' + keyRead.status);
  const issuedAt = new Date(cred.issuedAt).getTime();
  const key = keyRead.doc && Array.isArray(keyRead.doc.keys) ? keyRead.doc.keys.find((k) => k && k.publicKey === cred.issuer.publicKey
    && issuedAt >= new Date(k.validFrom).getTime() && issuedAt <= (k.validUntil ? new Date(k.validUntil).getTime() : Infinity)) : null;
  check('credential names a published issuer key that was valid when it was issued', !!key);

  if (key) {
    const payload = { id: cred.id, asset: cred.asset, owner: cred.owner, quantity: cred.quantity, supersedes: cred.supersedes, issuedAt: cred.issuedAt };
    let ok = false;
    try {
      const raw = b64u(key.publicKey);
      const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), raw]), format: 'der', type: 'spki' });
      ok = crypto.verify('sha256', Buffer.from(canonicalize(payload)), { key: pub, dsaEncoding: 'ieee-p1363' }, b64u(cred.signature));
    } catch (e) { ok = false; }
    check('issuer signature verifies', ok);
  }

  const rev = await get(base + '/.well-known/atlas-revocations.json');
  if (rev.status === 200 && rev.doc && Array.isArray(rev.doc.revoked)) {
    check('not on the issuer revocation list', !rev.doc.revoked.some((r) => r && r.id === cred.id));
  } else {
    console.log('NOTE revocation list not readable (HTTP ' + rev.status + '); revocation status unknown');
  }

  const a = cred.asset || {};
  if (a.class === 'atlas.demo.studio.collectible') {
    const p = a.properties || {};
    check('Studio class, non-fungible, owner-bound', a.fungible === false && a.tradeScope === 'bound');
    check('owner is set', !!(cred.owner && cred.owner.publicKey));
    const design = { schema: 'atlas.asset-studio.design/0.1', template: p['atlas.studio.template'], name: p['atlas.studio.name'], description: p['atlas.studio.description'], finish: p['atlas.studio.finish'] };
    const digest = crypto.createHash('sha256').update(canonicalize(design)).digest('hex');
    check('design digest matches the design fields', digest === p['atlas.studio.designDigest'], 'sha256 ' + digest.slice(0, 16) + '…');
    check('model and thumbnail are on the issuer domain', typeof a.model === 'string' && typeof a.thumbnail === 'string'
      && a.model.startsWith('https://' + cred.issuer.domain + '/assets/') && a.thumbnail.startsWith('https://' + cred.issuer.domain + '/assets/'));
    console.log('NOTE ' + JSON.stringify({ name: a.name, template: p['atlas.studio.template'], finish: p['atlas.studio.finish'], owner: cred.owner && cred.owner.publicKey && cred.owner.publicKey.slice(0, 16) + '…', issuedAt: cred.issuedAt }));
  } else {
    console.log('NOTE class is ' + a.class + ', not an Asset Studio collectible; only the signature checks apply');
  }

  console.log(failures === 0 ? '\nAll checks passed.' : '\n' + failures + ' check(s) failed.');
  process.exit(failures === 0 ? 0 : 1);
})();
