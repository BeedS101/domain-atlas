// Manual check for SPEC.md §5.1's new optional signed `asset.expiresAt`
// field — a second, orthogonal way a credential stops being valid,
// alongside explicit revocation. Unlike revocation (an admin action, a
// published list entry, checked via isRevoked()), an expiring credential
// carries its own deadline, computed and signed once at mint time from a
// catalog entry's own `expiresInMinutes`, and checked with nothing but
// arithmetic against the clock — no extra fetch, no extra list.
//
// The Museum ticket stall (demo-domain-a/spatial/museum/scene.json) is the
// real worked example — atlas.demo.museum.ticket expires in a realistic 3
// minutes, deliberately too slow for an automated check to sit through
// twice. atlas.test.expiring / atlas.test.expiring.balance are dedicated,
// clearly-labeled fixtures that exist ONLY so this test can observe a real
// expiry in a couple of seconds — no scene.json or demo page ever mints
// them.
//
// Run at the HTTP layer directly against BOTH backends, same isolated-
// instance reasoning every other manual-*.js test in this project uses.
//
// Checks:
//   1. Node — minting from a class with `expiresInMinutes` signs a real,
//      near-future `asset.expiresAt`; minting from an ordinary class
//      (atlas.badge) never carries the field at all.
//   2. Node — presenting a not-yet-expired credential (fulfill, split) both
//      succeed normally.
//   3. Node — the exact same credentials, presented again after the
//      deadline passes, are rejected with "has expired" — fulfill
//      (checkPresentedFulfillableAsset) and split (checkPresentedAsset)
//      both wired the same way.
//   4. PHP — the same mint-then-expire-then-reject behavior on an
//      independent issuer-php bundle.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const NODE_PORT = 8135; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://localhost:' + NODE_PORT;
const PHP_PORT = 8136;
const PHP_BASE = 'http://localhost:' + PHP_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-expiry-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-expiry-docroot-'));
const PHP_BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-expiry-php-'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function postJson(base, urlPath, body) {
  return fetch(base + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}
function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
async function issueAsset(base, ownerPublicKey, assetClass, quantity) {
  const res = await postJson(base, '/atlas/asset/issue', { ownerPublicKey, assetClass, ...(quantity !== undefined ? { quantity } : {}) });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ' at ' + base + ': ' + JSON.stringify(res.body));
  return res.body;
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
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}
async function fulfillAsAdmin(base, admin, credential) {
  const payload = { credential };
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  return postJson(base, '/atlas/asset/fulfill', { payload, proof });
}
async function split(base, credential, sendAmount, toPublicKey) {
  return postJson(base, '/atlas/asset/split', { credential, sendAmount, toPublicKey });
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

  try {
    console.log('SETUP: minting a holder and an admin identity; registering the admin on the Node roster');
    const holder = await genIdentity();
    const admin = await genIdentity();
    fs.writeFileSync(path.join(NODE_STATE_DIR, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));

    console.log('STEP 1: Node — minting from a class with expiresInMinutes signs a real, near-future asset.expiresAt; an ordinary class never carries the field');
    const ticket = await issueAsset(NODE_BASE, holder.publicKey, 'atlas.test.expiring');
    assert(typeof ticket.asset.expiresAt === 'string', 'expected a signed expiresAt, got: ' + JSON.stringify(ticket.asset));
    const expiresAtMs = new Date(ticket.asset.expiresAt).getTime();
    assert(expiresAtMs > Date.now() && expiresAtMs < Date.now() + 15000, 'expected expiresAt a few seconds in the future, got: ' + ticket.asset.expiresAt);
    const badge = await issueAsset(NODE_BASE, holder.publicKey, 'atlas.badge');
    assert(badge.asset.expiresAt === undefined, 'expected an ordinary class to never carry expiresAt, got: ' + JSON.stringify(badge.asset));
    console.log('PASS: expiresAt is signed only for an opted-in class, ~3 seconds out ->', ticket.asset.expiresAt);

    console.log('STEP 2: Node — presenting a not-yet-expired credential succeeds (fulfill for the ticket, split for a matching fungible balance)');
    const balance = await issueAsset(NODE_BASE, holder.publicKey, 'atlas.test.expiring.balance', 10);
    const fulfilled = await fulfillAsAdmin(NODE_BASE, admin, ticket);
    assert(fulfilled.status === 200 && fulfilled.body.status === 'fulfilled', 'expected the not-yet-expired ticket to fulfill, got: ' + JSON.stringify(fulfilled.body));
    const splitOk = await split(NODE_BASE, balance, 3, holder.publicKey);
    assert(splitOk.status === 200, 'expected the not-yet-expired balance to split, got: ' + JSON.stringify(splitOk.body));
    console.log('PASS: both a fulfill and a split succeed while the deadline has not passed yet');

    console.log('STEP 3: Node — the exact same class, minted fresh, is rejected once the deadline actually passes (fulfill and split both)');
    const ticket2 = await issueAsset(NODE_BASE, holder.publicKey, 'atlas.test.expiring');
    const balance2 = await issueAsset(NODE_BASE, holder.publicKey, 'atlas.test.expiring.balance', 10);
    console.log('  waiting 4 seconds for the 3-second deadline to pass...');
    await sleep(4000);
    const fulfilledLate = await fulfillAsAdmin(NODE_BASE, admin, ticket2);
    assert(fulfilledLate.status === 400 && /has expired/.test(fulfilledLate.body.error), 'expected an expiry rejection on fulfill, got: ' + JSON.stringify(fulfilledLate.body));
    const splitLate = await split(NODE_BASE, balance2, 3, holder.publicKey);
    assert(splitLate.status === 400 && /has expired/.test(splitLate.body.error), 'expected an expiry rejection on split, got: ' + JSON.stringify(splitLate.body));
    console.log('PASS: an expired credential is rejected by both checkPresentedFulfillableAsset and checkPresentedAsset, with no revoke() ever called');

    console.log('STEP 4: PHP — the same mint-then-expire-then-reject behavior on an independent issuer-php bundle');
    fs.writeFileSync(path.join(PHP_BUNDLE_DIR, 'lib', 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
    const phpTicket = await issueAsset(PHP_BASE, holder.publicKey, 'atlas.test.expiring');
    assert(typeof phpTicket.asset.expiresAt === 'string', 'expected PHP to also sign a real expiresAt, got: ' + JSON.stringify(phpTicket.asset));
    const phpFulfilledOnTime = await fulfillAsAdmin(PHP_BASE, admin, phpTicket);
    assert(phpFulfilledOnTime.status === 200, 'expected PHP to fulfill the not-yet-expired ticket, got: ' + JSON.stringify(phpFulfilledOnTime.body));
    const phpTicket2 = await issueAsset(PHP_BASE, holder.publicKey, 'atlas.test.expiring');
    console.log('  waiting 4 seconds for the 3-second deadline to pass...');
    await sleep(4000);
    const phpFulfilledLate = await fulfillAsAdmin(PHP_BASE, admin, phpTicket2);
    assert(phpFulfilledLate.status === 400 && /has expired/.test(phpFulfilledLate.body.error), 'expected PHP to reject the expired ticket the same way, got: ' + JSON.stringify(phpFulfilledLate.body));
    console.log('PASS: PHP matches Node for signing, accepting before the deadline, and rejecting after it');

    console.log('\nALL ASSET EXPIRY CHECKS PASSED');
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
