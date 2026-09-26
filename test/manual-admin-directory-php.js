// Companion to test/manual-admin-directory.js — proves issuer-php's own
// port of POST /atlas/admin/directory (atlas/admin/directory.php) behaves
// the same way the Node version does. Same "HTTP layer directly, isolated
// bundle copy" style as manual-admin-session-php.js.
//
// Mirrors manual-admin-directory.js's own checks (see that file for the
// full reasoning on each):
//   1. Log in via the session primitive to get a token.
//   2. With no subscribers or members yet, both lists come back empty.
//   3. The two rosters populate independently and stay separate.
//   4. Revoking a subscriber's credential drops it from the list.
//   5. No token and no proof is rejected 401.
//
// Not part of the permanent suite, same reasoning as every other
// manual-*.js script.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const BUNDLE_DIR = path.resolve(__dirname, '..', 'issuer-php');
const PORT = 8118; // isolated — distinct from every other manual-*-php.js test's own port
const BASE = 'http://localhost:' + PORT;

function get(base, urlPath) {
  return fetch(base + urlPath).then(async (r) => ({ status: r.status, body: await r.json() }));
}
function postJson(base, urlPath, body) {
  return fetch(base + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}
function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
async function genIdentity() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { kp, publicKey: b64url(raw) };
}
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}
async function issueAsset(ownerPublicKey, assetClass) {
  const res = await postJson(BASE, '/atlas/asset/issue', { ownerPublicKey, assetClass });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ': ' + JSON.stringify(res.body));
  return res.body;
}
async function login(admin) {
  const nonce = (await get(BASE, '/atlas/admin/session/nonce')).body.nonce;
  const payload = { nonce };
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  const res = await postJson(BASE, '/atlas/admin/session/start', { payload, proof });
  if (res.status !== 200) throw new Error('login failed: ' + JSON.stringify(res));
  return res.body.token;
}
function startPhpServer(bundleDir, port) {
  const proc = spawn('php', ['-S', 'localhost:' + port, 'test-router.php'], {
    cwd: bundleDir, stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S on port ' + port + ' did not start in time')), 5000);
    proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(proc); } });
    proc.on('exit', (code) => reject(new Error('php -S on port ' + port + ' exited early with code ' + code)));
  });
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-admin-directory-php-'));
  const bundle = path.join(tmpRoot, 'domain');
  console.log('SETUP: copying issuer-php into an isolated throwaway bundle');
  fs.cpSync(BUNDLE_DIR, bundle, { recursive: true });

  let proc;
  try {
    proc = await startPhpServer(bundle, PORT);
    console.log('PASS: PHP dev server up on ' + PORT);

    const admin = await genIdentity();
    fs.writeFileSync(path.join(bundle, 'lib', 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));

    console.log('STEP 1: log in via the session primitive');
    const token = await login(admin);
    assert(typeof token === 'string' && token.length > 0, 'expected a session token');
    console.log('PASS: got session token ->', token.slice(0, 16) + '...');

    console.log('STEP 2: with nobody subscribed yet, both lists come back empty');
    const empty = await postJson(BASE, '/atlas/admin/directory', { token });
    assert(empty.status === 200 && Array.isArray(empty.body.subscribers) && empty.body.subscribers.length === 0, 'expected an empty subscribers list, got: ' + JSON.stringify(empty.body));
    assert(Array.isArray(empty.body.postOfficeMembers) && empty.body.postOfficeMembers.length === 0, 'expected an empty postOfficeMembers list, got: ' + JSON.stringify(empty.body));
    console.log('PASS: both rosters start empty');

    console.log('STEP 3: the two rosters populate independently and stay separate');
    const subscriberOwner = 'directory-test-subscriber-php';
    const subscriberCred = await issueAsset(subscriberOwner, 'atlas.membership');
    const memberOwner = 'directory-test-postoffice-member-php';
    const memberCred = await issueAsset(memberOwner, 'atlas.postoffice.membership');
    const populated = await postJson(BASE, '/atlas/admin/directory', { token });
    assert(populated.status === 200, 'expected 200, got: ' + JSON.stringify(populated));
    assert(populated.body.subscribers.some((s) => s.credentialId === subscriberCred.id && s.ownerPublicKey === subscriberOwner), 'expected the new subscriber in subscribers, got: ' + JSON.stringify(populated.body.subscribers));
    assert(!populated.body.postOfficeMembers.some((m) => m.credentialId === subscriberCred.id), 'the subscriber should not also show up in postOfficeMembers');
    assert(populated.body.postOfficeMembers.some((m) => m.credentialId === memberCred.id && m.ownerPublicKey === memberOwner), 'expected the new Post Office member in postOfficeMembers, got: ' + JSON.stringify(populated.body.postOfficeMembers));
    assert(!populated.body.subscribers.some((s) => s.credentialId === memberCred.id), 'the Post Office member should not also show up in subscribers');
    console.log('PASS: subscribers and Post Office members populate independently, never cross-listed');

    console.log('STEP 4: revoking a subscriber\'s credential drops it from the list');
    const revokeRes = await postJson(BASE, '/atlas/revoke', { payload: { id: subscriberCred.id, reason: 'directory-test' }, token });
    assert(revokeRes.status === 200 && revokeRes.body.ok === true, 'expected the revoke to succeed, got: ' + JSON.stringify(revokeRes));
    const afterRevoke = await postJson(BASE, '/atlas/admin/directory', { token });
    assert(!afterRevoke.body.subscribers.some((s) => s.credentialId === subscriberCred.id), 'expected the revoked subscriber to be filtered out, got: ' + JSON.stringify(afterRevoke.body.subscribers));
    assert(afterRevoke.body.postOfficeMembers.some((m) => m.credentialId === memberCred.id), 'the still-valid Post Office member should remain listed');
    console.log('PASS: a revoked credential is never suggested as a mail recipient');

    console.log('STEP 5: no token and no proof is rejected 401');
    const unauthed = await postJson(BASE, '/atlas/admin/directory', {});
    assert(unauthed.status === 401, 'expected 401 with no auth, got: ' + JSON.stringify(unauthed));
    console.log('PASS: unauthenticated request rejected ->', unauthed.body.error);

    console.log('\nALL ADMIN DIRECTORY PHP CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (proc) proc.kill();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) {}
  }
})();
