// Manual check that the self-serve /atlas/demo/* routes still carry their
// demo pages (warranty-demo.html, cafeteria-demo.html, login-demo.html,
// clawback-demo.html), each acting only on its own page's demo class, and
// only with the right authorization (issuer-php/lib/demo-authority.php):
// the owner for what a holder may do to their own credential, a demo
// authority key (minted into the credential) for what the issuer, factory or
// retailer does. test/manual-demo-route-authorization.js covers who is refused.
//
//   node test/manual-demo-self-serve.js [node|php|both]
//
// For each backend:
//   1. warranty/mint makes a genuinely signed self-serve certificate with the
//      serial and the demo authority; refuses a non-serial property.
//   2. warranty/stamp-sale, signed by the demo authority, adds the sale and
//      keeps the serial, revokes the superseded certificate; refuses another
//      class.
//   3. cafeteria/fulfill, signed by the owner, revokes the item; refuses a
//      class outside its three.
//   4. login/revoke, signed by the owner, revokes the badge; refuses another
//      class.
//   5. clawback/suspend, signed by the demo authority, genuinely blocks a
//      transfer; unsuspend lifts it and the same transfer succeeds; both
//      refuse another class.
//   6. clawback/clawback returns a stolen token to its owner, genuinely
//      signed, revokes the stolen one, and refuses the current owner as target.
//   7. The real admin-gated siblings still refuse an unauthenticated request.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const NODE_PORT = 8143; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://localhost:' + NODE_PORT;
const PHP_PORT = 8144;
const PHP_BASE = 'http://localhost:' + PHP_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-demo-self-serve-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-demo-self-serve-docroot-'));
const PHP_BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-demo-self-serve-php-'));

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
function postJson(base, urlPath, body) {
  return fetch(base + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}
function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function genIdentity() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { kp, publicKey: b64url(raw) };
}
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
async function signWithSelf(identity, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.kp.privateKey, data);
  return { signerRole: 'raw-ecdsa', publicKey: identity.publicKey, signature: b64url(new Uint8Array(sig)) };
}
async function transferAsset(base, sender, credential, recipientPublicKey) {
  const payload = { credentialId: credential.id, recipientPublicKey, action: 'transfer' };
  const proof = await signWithSelf(sender, payload);
  return postJson(base, '/atlas/asset/transfer', { credential, recipientPublicKey, intent: { payload, proof } });
}
async function issueAsset(base, ownerPublicKey, assetClass, quantity) {
  const res = await postJson(base, '/atlas/asset/issue', { ownerPublicKey, assetClass, ...(quantity !== undefined ? { quantity } : {}) });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ' at ' + base + ': ' + JSON.stringify(res.body));
  return res.body;
}
async function verifyGenuineSignature(base, credential) {
  const keyDoc = await fetch(base + '/.well-known/atlas-key.json').then((r) => r.json());
  const issuerKey = await subtle.importKey('raw', Buffer.from(keyDoc.keys[0].publicKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const payload = { id: credential.id, asset: credential.asset, owner: credential.owner, quantity: credential.quantity, supersedes: credential.supersedes, issuedAt: credential.issuedAt };
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, issuerKey, Buffer.from(credential.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'), new TextEncoder().encode(canonicalize(payload)));
}
async function isRevoked(base, credentialId) {
  const revDoc = await fetch(base + '/.well-known/atlas-revocations.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ revoked: [] }));
  return (revDoc.revoked || []).some((r) => r.id === credentialId);
}

// A demo request, as the pages build it.
async function demoRequest(domain, signer, action, credential, fields) {
  const payload = Object.assign({ purpose: 'atlas.demo.request/1', action, credentialId: credential.id, domain,
    issuedAt: new Date().toISOString() }, fields || {});
  return { payload, proof: await signWithSelf(signer, payload) };
}

async function runChecks(label, base, domain) {
  const holder = await genIdentity();
  const factory = await genIdentity();
  const outOfScope = await issueAsset(base, holder.publicKey, 'atlas.demo.warranty.certificate');

  console.log('STEP 1: ' + label + ' — warranty/mint makes a signed self-serve certificate');
  const minted = await postJson(base, '/atlas/demo/warranty/mint', { ownerPublicKey: holder.publicKey, authorityPublicKey: factory.publicKey, properties: { 'com.example.serialNumber': 'SN-0001' } });
  assert(minted.status === 200, 'expected the self-serve mint to succeed, got: ' + JSON.stringify(minted.body));
  assert(minted.body.asset.class === 'atlas.demo.warranty.selfserve', 'expected the self-serve class, got: ' + JSON.stringify(minted.body.asset));
  assert(minted.body.asset.properties['com.example.serialNumber'] === 'SN-0001', 'expected the serial number, got: ' + JSON.stringify(minted.body.asset));
  assert(minted.body.asset.properties['atlas.demo.authority'] === factory.publicKey, 'expected the demo authority, got: ' + JSON.stringify(minted.body.asset));
  assert(await verifyGenuineSignature(base, minted.body), 'expected a genuine issuer signature');
  const badProps = await postJson(base, '/atlas/demo/warranty/mint', { ownerPublicKey: holder.publicKey, authorityPublicKey: factory.publicKey, properties: { 'com.example.serialNumber': 'SN-1', 'com.example.extra': 'x' } });
  assert(badProps.status === 400, 'expected a non-serial property to be refused, got: ' + JSON.stringify(badProps.body));
  console.log('PASS: ' + label + ' self-serve warranty mint —', minted.body.id);

  console.log('STEP 2: ' + label + ' — warranty/stamp-sale, by the demo authority');
  const sale = { 'com.example.saleDate': '2026-01-01', 'com.example.warrantyMonths': 24, 'com.example.retailer': 'Example Retailer' };
  const stamped = await postJson(base, '/atlas/demo/warranty/stamp-sale', { credential: minted.body, properties: sale,
    intent: await demoRequest(domain, factory, 'demo-stamp-sale', minted.body, { properties: sale }) });
  assert(stamped.status === 200, 'expected the stamp to succeed, got: ' + JSON.stringify(stamped.body));
  const newCert = stamped.body.newCredential;
  assert(newCert.asset.properties['com.example.serialNumber'] === 'SN-0001' && newCert.asset.properties['com.example.retailer'] === 'Example Retailer',
    'expected the serial kept and the retailer added, got: ' + JSON.stringify(newCert.asset));
  assert(await verifyGenuineSignature(base, newCert), 'expected the stamped certificate to carry a genuine issuer signature');
  assert(await isRevoked(base, minted.body.id), 'expected the pre-stamp certificate to be revoked as superseded');
  const wrongClassStamp = await postJson(base, '/atlas/demo/warranty/stamp-sale', { credential: outOfScope, properties: sale,
    intent: await demoRequest(domain, factory, 'demo-stamp-sale', outOfScope, { properties: sale }) });
  assert(wrongClassStamp.status === 400 && /only stamps/.test(wrongClassStamp.body.error), 'expected a wrong-class rejection, got: ' + JSON.stringify(wrongClassStamp.body));
  console.log('PASS: ' + label + ' stamp-sale —', newCert.id);

  console.log('STEP 3: ' + label + ' — cafeteria/fulfill, by the owner');
  const sandwich = await issueAsset(base, holder.publicKey, 'atlas.demo.cafeteria.sandwich');
  const fulfilled = await postJson(base, '/atlas/demo/cafeteria/fulfill', { credential: sandwich, intent: await demoRequest(domain, holder, 'demo-fulfill', sandwich) });
  assert(fulfilled.status === 200 && fulfilled.body.status === 'fulfilled', 'expected the fulfill to succeed, got: ' + JSON.stringify(fulfilled.body));
  assert(await isRevoked(base, sandwich.id), 'expected the fulfilled item to be revoked');
  const wrongClassFulfill = await postJson(base, '/atlas/demo/cafeteria/fulfill', { credential: outOfScope, intent: await demoRequest(domain, holder, 'demo-fulfill', outOfScope) });
  assert(wrongClassFulfill.status === 400 && /only fulfills/.test(wrongClassFulfill.body.error), 'expected an out-of-scope rejection, got: ' + JSON.stringify(wrongClassFulfill.body));
  console.log('PASS: ' + label + ' cafeteria fulfill —', sandwich.id);

  console.log('STEP 4: ' + label + ' — login/revoke, by the owner');
  const badge = await issueAsset(base, holder.publicKey, 'atlas.demo.login.badge');
  const revoked = await postJson(base, '/atlas/demo/login/revoke', { credential: badge, intent: await demoRequest(domain, holder, 'demo-login-revoke', badge) });
  assert(revoked.status === 200 && revoked.body.ok === true, 'expected the revoke to succeed, got: ' + JSON.stringify(revoked.body));
  assert(await isRevoked(base, badge.id), 'expected the login badge to be revoked');
  const wrongClassRevoke = await postJson(base, '/atlas/demo/login/revoke', { credential: outOfScope, intent: await demoRequest(domain, holder, 'demo-login-revoke', outOfScope) });
  assert(wrongClassRevoke.status === 400 && /only revokes/.test(wrongClassRevoke.body.error), 'expected an out-of-scope rejection, got: ' + JSON.stringify(wrongClassRevoke.body));
  console.log('PASS: ' + label + ' login revoke —', badge.id);

  console.log('STEP 5: ' + label + ' — clawback/suspend and unsuspend, by the demo authority');
  const owner = await genIdentity(), buyer = await genIdentity(), issuer = await genIdentity();
  const mintToken = async (who) => {
    const r = await postJson(base, '/atlas/demo/clawback/mint', { ownerPublicKey: who.publicKey, authorityPublicKey: issuer.publicKey, assetClass: 'atlas.demo.clawback.token' });
    assert(r.status === 200, 'expected the demo token mint to succeed, got: ' + JSON.stringify(r.body));
    return r.body;
  };
  const token = await mintToken(owner);
  const suspended = await postJson(base, '/atlas/demo/clawback/suspend', { credential: token, intent: await demoRequest(domain, issuer, 'demo-suspend', token) });
  assert(suspended.status === 200 && suspended.body.ok === true, 'expected the suspend to succeed, got: ' + JSON.stringify(suspended.body));
  const blockedSale = await transferAsset(base, owner, token, buyer.publicKey);
  assert(blockedSale.status === 400 && /suspended pending review/.test(blockedSale.body.error), 'expected the transfer to be blocked by the suspension, got: ' + JSON.stringify(blockedSale.body));
  const wrongClassSuspend = await postJson(base, '/atlas/demo/clawback/suspend', { credential: outOfScope, intent: await demoRequest(domain, issuer, 'demo-suspend', outOfScope) });
  assert(wrongClassSuspend.status === 400 && /only acts on/.test(wrongClassSuspend.body.error), 'expected an out-of-scope rejection, got: ' + JSON.stringify(wrongClassSuspend.body));
  const unsuspended = await postJson(base, '/atlas/demo/clawback/unsuspend', { credential: token, intent: await demoRequest(domain, issuer, 'demo-unsuspend', token) });
  assert(unsuspended.status === 200 && unsuspended.body.wasSuspended === true, 'expected the unsuspend to lift it, got: ' + JSON.stringify(unsuspended.body));
  const retriedSale = await transferAsset(base, owner, token, buyer.publicKey);
  assert(retriedSale.status === 200, 'expected the same transfer to succeed once unsuspended, got: ' + JSON.stringify(retriedSale.body));
  console.log('PASS: ' + label + ' suspend blocks, unsuspend releases —', retriedSale.body.credential.id);

  console.log('STEP 6: ' + label + ' — clawback/clawback returns a stolen token, by the demo authority');
  const victim = await genIdentity(), thief = await genIdentity();
  let stolen = await mintToken(victim);
  const theft = await transferAsset(base, victim, stolen, thief.publicKey);
  assert(theft.status === 200, 'expected the simulated theft transfer to succeed, got: ' + JSON.stringify(theft.body));
  stolen = theft.body.credential;
  const noop = await postJson(base, '/atlas/demo/clawback/clawback', { credential: stolen, toPublicKey: thief.publicKey,
    intent: await demoRequest(domain, issuer, 'demo-clawback', stolen, { toPublicKey: thief.publicKey }) });
  assert(noop.status === 400 && /nothing to claw back/.test(noop.body.error), 'expected the current owner to be refused as target, got: ' + JSON.stringify(noop.body));
  const clawed = await postJson(base, '/atlas/demo/clawback/clawback', { credential: stolen, toPublicKey: victim.publicKey,
    intent: await demoRequest(domain, issuer, 'demo-clawback', stolen, { toPublicKey: victim.publicKey }) });
  assert(clawed.status === 200 && clawed.body.newCredential.owner.publicKey === victim.publicKey, 'expected the clawback to return it to the victim, got: ' + JSON.stringify(clawed.body));
  assert(await verifyGenuineSignature(base, clawed.body.newCredential), 'expected the returned token to carry a genuine issuer signature');
  assert(await isRevoked(base, stolen.id), 'expected the stolen token to be revoked');
  console.log('PASS: ' + label + ' clawback —', clawed.body.newCredential.id);

  console.log('STEP 7: ' + label + ' — the real admin-gated siblings still refuse an unauthenticated request');
  const statuses = [];
  for (const [route, body] of [['/atlas/asset/mint', { payload: { ownerPublicKey: holder.publicKey, assetClass: 'atlas.demo.warranty.certificate' } }],
    ['/atlas/asset/reissue', { payload: { credential: newCert, properties: {} } }], ['/atlas/asset/fulfill', { payload: { credential: sandwich } }],
    ['/atlas/revoke', { payload: { id: badge.id } }], ['/atlas/suspend', { payload: { id: token.id, reason: 'test' } }],
    ['/atlas/unsuspend', { payload: { id: token.id } }], ['/atlas/clawback', { payload: { credential: token, toPublicKey: buyer.publicKey } }]]) {
    statuses.push((await postJson(base, route, body)).status);
  }
  assert(statuses.every((st) => st === 401), 'expected every admin-gated route to refuse with 401, got: ' + JSON.stringify(statuses));
  console.log('PASS: ' + label + ' admin-gated routes still 401');
}

(async () => {
  console.log('SETUP: starting an isolated issuer-server instance on port ' + NODE_PORT);
  const nodeProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(NODE_PORT),
      ATLAS_DOMAIN: NODE_DOMAIN,
      ATLAS_STATE_DIR: NODE_STATE_DIR,
      ATLAS_DOCROOT: NODE_DOCROOT_DIR
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    nodeProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    nodeProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-server up on port ' + NODE_PORT);

  console.log('SETUP: copying issuer-php into an isolated bundle dir and starting its own dev server on port ' + PHP_PORT);
  fs.cpSync(path.resolve(__dirname, '..', 'issuer-php'), PHP_BUNDLE_DIR, { recursive: true });
  const phpProc = spawn('php', ['-S', 'localhost:' + PHP_PORT, 'test-router.php'], { cwd: PHP_BUNDLE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
    phpProc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
    phpProc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-php dev server up on port ' + PHP_PORT);

  const WHICH = process.argv[2] || 'both';
  try {
    for (const [label, base, domain] of [['Node', NODE_BASE, NODE_DOMAIN], ['PHP', PHP_BASE, 'localhost:' + PHP_PORT]]) {
      if (WHICH !== 'both' && WHICH !== label.toLowerCase()) continue;
      await runChecks(label, base, domain);
    }
    console.log('\nALL DEMO SELF-SERVE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    nodeProc.kill();
    phpProc.kill();
    try { fs.rmSync(NODE_STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(NODE_DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(PHP_BUNDLE_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
