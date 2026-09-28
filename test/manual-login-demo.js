// Manual check for the login demo (demo-domain-a/login-demo.html): an
// ordinary password step, then a real second factor — presenting an
// atlas.demo.login.badge and signing a fresh single-use nonce
// (/atlas/login/nonce) with the same key the badge names as owner
// (/atlas/login/verify). The page itself only fakes the password step;
// everything from the nonce round trip onward is exactly what this test
// drives directly at the HTTP layer, same isolated-instance reasoning
// every other manual-*.js test in this project uses.
//
// Checks:
//   1. Node — a fresh login badge signs in successfully.
//   2. Node — the same nonce can never be reused (replay rejected).
//   3. Node — a credential of the wrong class is rejected.
//   4. Node — a signature from a key other than the credential's owner is
//      rejected.
//   5. Node — revoking the credential (the same admin action the demo
//      page's own "revoke it live" callout points at) makes the very next
//      sign-in fail, with no other step touched.
//   6. PHP — the same mint-sign-verify-then-revoke behavior on an
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

const NODE_PORT = 8137; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://localhost:' + NODE_PORT;
const PHP_PORT = 8138;
const PHP_BASE = 'http://localhost:' + PHP_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-login-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-login-docroot-'));
const PHP_BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-login-php-'));

function getJson(base, urlPath) {
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
async function issueAsset(base, ownerPublicKey, assetClass) {
  const res = await postJson(base, '/atlas/asset/issue', { ownerPublicKey, assetClass });
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
async function login(base, identity, credential) {
  const { body: nonceBody } = await getJson(base, '/atlas/login/nonce');
  const payload = { nonce: nonceBody.nonce, action: 'login' };
  const proof = await signWithSelf(identity.kp, identity.publicKey, payload);
  return { res: await postJson(base, '/atlas/login/verify', { credential, intent: { payload, proof } }), payload, proof };
}
async function revokeAsAdmin(base, admin, id) {
  const payload = { id };
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  return postJson(base, '/atlas/revoke', { payload, proof });
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
    console.log('SETUP: minting a holder identity and enrolling it with a login credential; registering a Node admin');
    const holder = await genIdentity();
    const admin = await genIdentity();
    fs.writeFileSync(path.join(NODE_STATE_DIR, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
    const credential = await issueAsset(NODE_BASE, holder.publicKey, 'atlas.demo.login.badge');

    console.log('STEP 1: Node — a fresh login badge signs in successfully');
    const first = await login(NODE_BASE, holder, credential);
    assert(first.res.status === 200 && first.res.body.ok === true, 'expected a successful login, got: ' + JSON.stringify(first.res.body));
    assert(first.res.body.ownerPublicKey === holder.publicKey, 'expected the reported owner to be the holder, got: ' + JSON.stringify(first.res.body));
    console.log('PASS: sign-in succeeds for a freshly issued, unrevoked login credential');

    console.log('STEP 2: Node — the same nonce can never be reused');
    const replay = await postJson(NODE_BASE, '/atlas/login/verify', { credential, intent: { payload: first.payload, proof: first.proof } });
    assert(replay.status === 401 && /nonce/.test(replay.body.error), 'expected a nonce-reuse rejection, got: ' + JSON.stringify(replay.body));
    console.log('PASS: replaying a spent nonce is rejected —', replay.body.error);

    console.log('STEP 3: Node — a credential of the wrong class is rejected');
    const wrongClassCredential = await issueAsset(NODE_BASE, holder.publicKey, 'atlas.badge');
    const wrongClass = await login(NODE_BASE, holder, wrongClassCredential);
    assert(wrongClass.res.status === 401 && /wrong class/.test(wrongClass.res.body.error), 'expected a wrong-class rejection, got: ' + JSON.stringify(wrongClass.res.body));
    console.log('PASS: presenting an unrelated credential class is rejected —', wrongClass.res.body.error);

    console.log('STEP 4: Node — a signature from a key other than the credential\'s owner is rejected');
    const impostor = await genIdentity();
    const { body: nonceBody } = await getJson(NODE_BASE, '/atlas/login/nonce');
    const impostorPayload = { nonce: nonceBody.nonce, action: 'login' };
    const impostorProof = await signWithSelf(impostor.kp, impostor.publicKey, impostorPayload);
    const impostorAttempt = await postJson(NODE_BASE, '/atlas/login/verify', { credential, intent: { payload: impostorPayload, proof: impostorProof } });
    assert(impostorAttempt.status === 401 && /does not belong/.test(impostorAttempt.body.error), 'expected an ownership rejection, got: ' + JSON.stringify(impostorAttempt.body));
    console.log('PASS: a signature from a non-owner key is rejected —', impostorAttempt.body.error);

    console.log('STEP 5: Node — revoking the credential makes the very next sign-in fail');
    const revokeRes = await revokeAsAdmin(NODE_BASE, admin, credential.id);
    assert(revokeRes.status === 200 && revokeRes.body.ok === true, 'expected the revoke to succeed, got: ' + JSON.stringify(revokeRes.body));
    const afterRevoke = await login(NODE_BASE, holder, credential);
    assert(afterRevoke.res.status === 401 && /revoked/.test(afterRevoke.res.body.error), 'expected a revoked rejection, got: ' + JSON.stringify(afterRevoke.res.body));
    console.log('PASS: sign-in fails immediately after revocation —', afterRevoke.res.body.error);

    console.log('STEP 6: PHP — the same mint-sign-verify-then-revoke behavior on an independent issuer-php bundle');
    fs.writeFileSync(path.join(PHP_BUNDLE_DIR, 'lib', 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
    const phpHolder = await genIdentity();
    const phpCredential = await issueAsset(PHP_BASE, phpHolder.publicKey, 'atlas.demo.login.badge');
    const phpFirst = await login(PHP_BASE, phpHolder, phpCredential);
    assert(phpFirst.res.status === 200 && phpFirst.res.body.ok === true, 'expected PHP to accept a fresh login credential, got: ' + JSON.stringify(phpFirst.res.body));
    const phpRevoke = await revokeAsAdmin(PHP_BASE, admin, phpCredential.id);
    assert(phpRevoke.status === 200, 'expected PHP to revoke the credential, got: ' + JSON.stringify(phpRevoke.body));
    const phpAfterRevoke = await login(PHP_BASE, phpHolder, phpCredential);
    assert(phpAfterRevoke.res.status === 401 && /revoked/.test(phpAfterRevoke.res.body.error), 'expected PHP to reject the revoked credential, got: ' + JSON.stringify(phpAfterRevoke.res.body));
    console.log('PASS: PHP matches Node for accepting, then rejecting once revoked');

    console.log('\nALL LOGIN DEMO CHECKS PASSED');
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
