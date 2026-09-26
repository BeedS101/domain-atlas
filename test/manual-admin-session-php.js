// Companion to test/manual-admin-session.js — proves issuer-php's own port
// of the admin session primitive (atlas/admin/session/{nonce,start,whoami,
// logout}.php, lib/store.php's issue_admin_nonce()/consume_admin_nonce()/
// create_admin_session()/touch_admin_session()/delete_admin_session())
// behaves the same way the Node version does, WITHOUT a browser. Same
// "HTTP layer directly, isolated bundle copy" style as
// manual-calendar-protocol-php.js — this test backdates the nonce/session
// store files directly to simulate expiry, which needs an isolated copy
// this test alone controls.
//
// Mirrors manual-admin-session.js's own checks (see that file for the full
// reasoning on each):
//   1. GET nonce returns a nonce.
//   2. A non-admin key is rejected and does not burn the nonce.
//   3. The registered admin key succeeds against that same nonce.
//   4. Replaying the consumed nonce is rejected.
//   5. whoami accepts the real token, rejects a garbage one.
//   6. A backdated session fails whoami.
//   7. logout ends a session; a repeat logout is still 200.
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
const PORT = 8114; // isolated — distinct from every other manual-*-php.js test's own port
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

// Same canonicalize() shape as extension/wallet.js and issuer-server/
// server.js's own crypto helpers — sorted-key JSON, no whitespace.
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

// Mirrors extension/wallet.js's signWithSelf() — a raw-ecdsa self-signed
// envelope, the same one verify_envelope() checks.
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}

async function login(base, identity, nonce) {
  const payload = { nonce };
  const proof = await signWithSelf(identity.kp, identity.publicKey, payload);
  return postJson(base, '/atlas/admin/session/start', { payload, proof });
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

function backdateStoreEntry(file, collectionKey, matchFn) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = doc[collectionKey].find(matchFn);
  if (!entry) throw new Error('Could not find the entry to backdate in ' + file);
  entry.expiresAt = Date.now() - 1000; // already expired
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-admin-session-php-'));
  const bundle = path.join(tmpRoot, 'domain');
  console.log('SETUP: copying issuer-php into an isolated throwaway bundle');
  fs.cpSync(BUNDLE_DIR, bundle, { recursive: true });
  const sessionsFile = path.join(bundle, 'lib', 'atlas-admin-sessions-store.json');

  let proc;
  try {
    proc = await startPhpServer(bundle, PORT);
    console.log('PASS: PHP dev server up on ' + PORT);

    const admin = await genIdentity();
    const outsider = await genIdentity(); // never registered — used to prove a non-admin key is rejected
    fs.writeFileSync(path.join(bundle, 'lib', 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));

    console.log('STEP 1: GET nonce returns a fresh nonce');
    const nonceRes = await get(BASE, '/atlas/admin/session/nonce');
    assert(nonceRes.status === 200 && typeof nonceRes.body.nonce === 'string' && nonceRes.body.nonce.length > 0, 'expected a nonce string, got: ' + JSON.stringify(nonceRes));
    const nonce = nonceRes.body.nonce;
    console.log('PASS: got nonce ->', nonce.slice(0, 16) + '...');

    console.log('STEP 2: a non-admin key signing that nonce is rejected, and does not burn it');
    const outsiderAttempt = await login(BASE, outsider, nonce);
    assert(outsiderAttempt.status === 401, 'expected a not-an-admin 401, got: ' + JSON.stringify(outsiderAttempt));
    console.log('PASS: non-admin login rejected ->', outsiderAttempt.body.error);

    console.log('STEP 3: the registered admin key signing the SAME nonce succeeds (proves step 2 did not burn it)');
    const loginRes = await login(BASE, admin, nonce);
    assert(loginRes.status === 200 && loginRes.body.token && loginRes.body.expiresAt, 'expected a token and expiresAt, got: ' + JSON.stringify(loginRes));
    const token = loginRes.body.token;
    console.log('PASS: admin login succeeded, token issued ->', token.slice(0, 16) + '...');

    console.log('STEP 4: replaying the same now-consumed nonce is rejected, even with a valid admin signature');
    const replay = await login(BASE, admin, nonce);
    assert(replay.status === 401, 'expected a nonce-reuse 401, got: ' + JSON.stringify(replay));
    console.log('PASS: nonce replay rejected ->', replay.body.error);

    console.log('STEP 5: whoami with the token succeeds and echoes the admin\'s public key; a garbage token is rejected');
    const whoamiOk = await postJson(BASE, '/atlas/admin/session/whoami', { token });
    assert(whoamiOk.status === 200 && whoamiOk.body.publicKey === admin.publicKey, 'expected whoami to echo the admin public key, got: ' + JSON.stringify(whoamiOk));
    const whoamiBad = await postJson(BASE, '/atlas/admin/session/whoami', { token: 'not-a-real-token' });
    assert(whoamiBad.status === 401, 'expected a garbage token to be rejected, got: ' + JSON.stringify(whoamiBad));
    console.log('PASS: whoami accepts the real token and rejects a garbage one');

    console.log('STEP 6: a backdated (timed-out) session fails whoami');
    backdateStoreEntry(sessionsFile, 'sessions', (s) => s.token === token);
    const whoamiExpired = await postJson(BASE, '/atlas/admin/session/whoami', { token });
    assert(whoamiExpired.status === 401, 'expected an expired session to be rejected, got: ' + JSON.stringify(whoamiExpired));
    console.log('PASS: expired session rejected ->', whoamiExpired.body.error);

    console.log('STEP 7: a fresh login, then logout ends it; logging out again (already dead) is still 200');
    const nonce2 = (await get(BASE, '/atlas/admin/session/nonce')).body.nonce;
    const login2 = await login(BASE, admin, nonce2);
    assert(login2.status === 200 && login2.body.token, 'expected a second successful login, got: ' + JSON.stringify(login2));
    const token2 = login2.body.token;
    const logoutRes = await postJson(BASE, '/atlas/admin/session/logout', { token: token2 });
    assert(logoutRes.status === 200, 'expected logout to return 200, got: ' + JSON.stringify(logoutRes));
    const whoamiAfterLogout = await postJson(BASE, '/atlas/admin/session/whoami', { token: token2 });
    assert(whoamiAfterLogout.status === 401, 'expected whoami to fail after logout, got: ' + JSON.stringify(whoamiAfterLogout));
    const logoutAgain = await postJson(BASE, '/atlas/admin/session/logout', { token: token2 });
    assert(logoutAgain.status === 200, 'expected a repeat logout of an already-dead token to still return 200 (idempotent), got: ' + JSON.stringify(logoutAgain));
    console.log('PASS: logout ends the session, whoami fails afterward, and a repeat logout is harmless');

    console.log('\nALL ADMIN SESSION PHP CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (proc) proc.kill();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) {}
  }
})();
