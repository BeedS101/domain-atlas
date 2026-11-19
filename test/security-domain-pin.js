// An issuer's identity comes from its configuration, never from the Host header of a request. A request that names another
// host must not make the issuer sign credentials in that name, accept an owner's or an administrator's signed request that was
// meant for another domain, or serve a malformed host as its own. The same cases run against both issuers; the PHP-only
// cases cover its two ways of being configured (the ATLAS_DOMAIN setting and lib/atlas-domain-config.json) and the older, unpinned
// deployment that still works from the Host header.
//
//   node test/security-domain-pin.js [node|php|both]
//
// Throw-away issuers on localhost; nothing leaves this machine.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const S = require('./support/issuer-stack');
const { adminAuth } = require('../tools/lib/admin-auth');

const WHICH = process.argv.find((a) => ['node', 'php', 'both'].includes(a)) || 'both';
let failures = 0;
function check(kind, name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL') + ' [' + kind + '] ' + name + (!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300) : ''));
}
const ATTACKER = 'attacker.example';

// POST/GET with a Host header of the caller's choosing (fetch does not let a test set one).
function request(base, method, urlPath, body, host) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { host: host || u.host };
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const req = http.request({ host: u.hostname, port: u.port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let json; try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch (e) { json = {}; } resolve({ status: res.statusCode, body: json }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const post = (base, p, body, host) => request(base, 'POST', p, body, host);

async function issueAs(issuer, owner, host) {
  return post(issuer.base, '/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: 'atlas.trophy.chess', quantity: 1 }, host);
}
const writeRoster = (issuer, kind, identity) => {
  const dir = kind === 'php' ? path.join(issuer.dir, 'bundle', 'lib') : path.join(issuer.dir, 'state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: identity.publicKey, addedAt: new Date().toISOString() }] }));
};
async function adminStatus(issuer, identity, domain, host) {
  const payload = { adminAuth: adminAuth(domain, '/atlas/admin/site-status') };
  return post(issuer.base, '/atlas/admin/site-status', { payload, proof: await S.signPayload(identity, payload) }, host);
}
async function dropAs(issuer, owner, credential, domain, host) {
  const payload = { action: 'drop', credentialId: credential.id, world: 'world-pin', domain, dropId: 'urn:atlas:worlddrop:' + crypto.randomUUID(), droppedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
  return post(issuer.base, '/atlas/world/drop', { credential, world: 'world-pin', position: [1, 0, 1], intent: { payload, proof: await S.signPayload(owner, payload) } }, host);
}

// The cases every issuer must pass: configured identity, whatever Host a request carries.
async function pinned(kind, issuer, label) {
  const owner = await S.generateIdentity();
  const own = await issueAs(issuer, owner);
  check(kind, label + ': an ordinary request is signed in the configured domain', own.status === 200 && own.body.issuer && own.body.issuer.domain === issuer.domain, own);

  const spoofed = await issueAs(issuer, owner, ATTACKER);
  check(kind, label + ': a request with another Host is still signed in the configured domain', spoofed.status === 200 && spoofed.body.issuer && spoofed.body.issuer.domain === issuer.domain, spoofed);

  const item = spoofed.body && spoofed.body.id ? spoofed.body : own.body;
  const foreignIntent = await dropAs(issuer, owner, item, ATTACKER, ATTACKER);
  check(kind, label + ': an owner\'s intent written for another domain is refused, even with that Host', foreignIntent.status >= 400 && foreignIntent.status < 500, foreignIntent);
  const rightIntent = await dropAs(issuer, owner, item, issuer.domain, ATTACKER);
  check(kind, label + ': the owner\'s intent for the configured domain is accepted', rightIntent.status === 200, rightIntent);

  const admin = await S.generateIdentity();
  writeRoster(issuer, kind, admin);
  const replayed = await adminStatus(issuer, admin, ATTACKER, ATTACKER);
  check(kind, label + ': an administrator\'s request written for another domain is refused, even with that Host', replayed.status === 400 && replayed.body.code === 'wrong-domain', replayed);
  const real = await adminStatus(issuer, admin, issuer.domain);
  check(kind, label + ': the same request for the configured domain is accepted', real.status === 200, real);
}

(async () => {
  const kinds = WHICH === 'both' ? ['node', 'php'] : [WHICH];
  for (const kind of kinds) {
    const base = kind === 'node' ? 8671 : 8681;
    const made = [];
    const start = async (port, env) => { const i = await S.startIssuer(kind, port, env); made.push(i); return i; };
    try {
      const configured = await start(base, { ATLAS_DOMAIN: 'localhost:' + base, ATLAS_MINT_LIMITS: 'off' });
      await pinned(kind, configured, 'configured domain');

      if (kind === 'php') {
        // The domain pinned in a file the web server cannot serve, for hosts where an environment setting is hard to set.
        const viaFile = await start(base + 1, { ATLAS_MINT_LIMITS: 'off', ATLAS_DOMAIN: '' });
        fs.writeFileSync(path.join(viaFile.dir, 'bundle', 'lib', 'atlas-domain-config.json'), JSON.stringify({ domain: viaFile.domain }));
        await pinned(kind, viaFile, 'domain pinned in lib/atlas-domain-config.json');

        // A configured value that is not a host name is a misconfiguration: the issuer refuses to run, it does not fall back to
        // whatever the request says.
        const broken = await start(base + 2, { ATLAS_MINT_LIMITS: 'off', ATLAS_DOMAIN: 'https://issuer.example/path' });
        const owner = await S.generateIdentity();
        const refused = await post(broken.base, '/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: 'atlas.trophy.chess', quantity: 1 });
        check(kind, 'a configured domain that is not a host name stops the issuer from signing', refused.status >= 500 && !refused.body.id, refused);

        // An issuer nobody has pinned yet keeps working from the Host header, as before, but a malformed Host is refused.
        const unpinned = await start(base + 3, { ATLAS_MINT_LIMITS: 'off', ATLAS_DOMAIN: '' });
        const plain = await post(unpinned.base, '/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: 'atlas.trophy.chess', quantity: 1 });
        check(kind, 'an unpinned issuer still signs in the domain the request arrived on', plain.status === 200 && plain.body.issuer.domain === 'localhost:' + (base + 3), plain);
        const malformed = await post(unpinned.base, '/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: 'atlas.trophy.chess', quantity: 1 }, 'evil.example/x@y');
        check(kind, 'an unpinned issuer refuses a Host that is not a host name', malformed.status === 400 && !malformed.body.id, malformed);
      }
    } catch (e) { failures++; console.log('FAIL [' + kind + '] ' + (e.stack || e)); } finally {
      for (const i of made) i.stop();
    }
  }
  console.log(failures ? failures + ' FAILED' : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
