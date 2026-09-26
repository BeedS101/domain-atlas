// Protocol-level check for the admin session primitive: GET
// /atlas/admin/session/nonce, POST /atlas/admin/session/start, POST
// /atlas/admin/session/whoami, POST /atlas/admin/session/logout
// (issuer-server/server.js). A short-lived bearer-token layer on top of
// the existing admin roster/requireAdmin() gate — lets a roster key sign
// in ONCE (over a fresh nonce, so the login itself can't be replayed) and
// use a random token for everything after that, instead of re-signing
// every request with its ECDSA key. The roster stays the one source of
// truth for who's an admin; this only ever hands out a session to a key
// that already passes requireAdmin().
//
// HTTP layer directly, same style as manual-calendar-protocol.js — no
// browser/extension involved, and this test needs to backdate nonce/
// session expiry by editing the store files directly, which only works
// against an isolated instance whose state directory this test controls,
// not the shared demo servers.
//
// Checks:
//   1. GET nonce returns a fresh nonce string.
//   2. Signing that nonce with a key that is NOT on the admin roster is
//      rejected 401 — and does NOT burn the nonce (a following legitimate
//      attempt against the same nonce still works).
//   3. Signing it with a registered admin key succeeds: 200, a token and
//      an expiresAt come back.
//   4. Replaying the exact same (now-consumed) nonce, even with a valid
//      admin signature over it, is rejected 401 — single-use.
//   5. POST whoami with the returned token succeeds and echoes the
//      admin's own public key back; a garbage token is rejected 401.
//   6. Backdating the session's expiresAt in the store file (simulating a
//      timed-out session) makes the next whoami fail 401.
//   7. A fresh login's token is accepted by whoami, then POST logout ends
//      it — the same token then fails whoami. Logging out again with the
//      same already-dead token still returns 200 (idempotent).
//   8. The old, pre-session shape (bare {id}-style body, no payload/proof
//      envelope) is rejected the same way every other admin endpoint
//      already rejects it.
//
// Not part of the permanent suite, same reasoning as every other
// manual-*.js script.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const NODE_PORT = 8113; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://localhost:' + NODE_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-admin-session-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-admin-session-docroot-'));
const NONCES_FILE = path.join(NODE_STATE_DIR, 'atlas-admin-nonces-store.json');
const SESSIONS_FILE = path.join(NODE_STATE_DIR, 'atlas-admin-sessions-store.json');

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
// envelope, the same one verifyEnvelope() on the server checks.
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

function backdateStoreEntry(file, collectionKey, matchFn) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = doc[collectionKey].find(matchFn);
  if (!entry) throw new Error('Could not find the entry to backdate in ' + file);
  entry.expiresAt = Date.now() - 1000; // already expired
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
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

  try {
    const admin = await genIdentity();
    const outsider = await genIdentity(); // never registered — used to prove a non-admin key is rejected
    fs.writeFileSync(path.join(NODE_STATE_DIR, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));

    console.log('STEP 1: GET nonce returns a fresh nonce');
    const nonceRes = await get(NODE_BASE, '/atlas/admin/session/nonce');
    assert(nonceRes.status === 200 && typeof nonceRes.body.nonce === 'string' && nonceRes.body.nonce.length > 0, 'expected a nonce string, got: ' + JSON.stringify(nonceRes));
    const nonce = nonceRes.body.nonce;
    console.log('PASS: got nonce ->', nonce.slice(0, 16) + '...');

    console.log('STEP 2: a non-admin key signing that nonce is rejected, and does not burn it');
    const outsiderAttempt = await login(NODE_BASE, outsider, nonce);
    assert(outsiderAttempt.status === 401 && /not a registered domain admin/.test(outsiderAttempt.body.error || ''), 'expected a not-an-admin 401, got: ' + JSON.stringify(outsiderAttempt));
    console.log('PASS: non-admin login rejected ->', outsiderAttempt.body.error);

    console.log('STEP 3: the registered admin key signing the SAME nonce succeeds (proves step 2 did not burn it)');
    const loginRes = await login(NODE_BASE, admin, nonce);
    assert(loginRes.status === 200 && loginRes.body.token && loginRes.body.expiresAt, 'expected a token and expiresAt, got: ' + JSON.stringify(loginRes));
    const token = loginRes.body.token;
    console.log('PASS: admin login succeeded, token issued ->', token.slice(0, 16) + '...');

    console.log('STEP 4: replaying the same now-consumed nonce is rejected, even with a valid admin signature');
    const replay = await login(NODE_BASE, admin, nonce);
    assert(replay.status === 401 && /nonce/.test(replay.body.error || ''), 'expected a nonce-reuse 401, got: ' + JSON.stringify(replay));
    console.log('PASS: nonce replay rejected ->', replay.body.error);

    console.log('STEP 5: whoami with the token succeeds and echoes the admin\'s public key; a garbage token is rejected');
    const whoamiOk = await postJson(NODE_BASE, '/atlas/admin/session/whoami', { token });
    assert(whoamiOk.status === 200 && whoamiOk.body.publicKey === admin.publicKey, 'expected whoami to echo the admin public key, got: ' + JSON.stringify(whoamiOk));
    const whoamiBad = await postJson(NODE_BASE, '/atlas/admin/session/whoami', { token: 'not-a-real-token' });
    assert(whoamiBad.status === 401, 'expected a garbage token to be rejected, got: ' + JSON.stringify(whoamiBad));
    console.log('PASS: whoami accepts the real token and rejects a garbage one');

    console.log('STEP 6: a backdated (timed-out) session fails whoami');
    backdateStoreEntry(SESSIONS_FILE, 'sessions', (s) => s.token === token);
    const whoamiExpired = await postJson(NODE_BASE, '/atlas/admin/session/whoami', { token });
    assert(whoamiExpired.status === 401, 'expected an expired session to be rejected, got: ' + JSON.stringify(whoamiExpired));
    console.log('PASS: expired session rejected ->', whoamiExpired.body.error);

    console.log('STEP 7: a fresh login, then logout ends it; logging out again (already dead) is still 200');
    const nonce2 = (await get(NODE_BASE, '/atlas/admin/session/nonce')).body.nonce;
    const login2 = await login(NODE_BASE, admin, nonce2);
    assert(login2.status === 200 && login2.body.token, 'expected a second successful login, got: ' + JSON.stringify(login2));
    const token2 = login2.body.token;
    const logoutRes = await postJson(NODE_BASE, '/atlas/admin/session/logout', { token: token2 });
    assert(logoutRes.status === 200, 'expected logout to return 200, got: ' + JSON.stringify(logoutRes));
    const whoamiAfterLogout = await postJson(NODE_BASE, '/atlas/admin/session/whoami', { token: token2 });
    assert(whoamiAfterLogout.status === 401, 'expected whoami to fail after logout, got: ' + JSON.stringify(whoamiAfterLogout));
    const logoutAgain = await postJson(NODE_BASE, '/atlas/admin/session/logout', { token: token2 });
    assert(logoutAgain.status === 200, 'expected a repeat logout of an already-dead token to still return 200 (idempotent), got: ' + JSON.stringify(logoutAgain));
    console.log('PASS: logout ends the session, whoami fails afterward, and a repeat logout is harmless');

    console.log('STEP 8: the old, pre-session bare-body shape is rejected the same way every other admin endpoint already rejects it');
    const oldShape = await postJson(NODE_BASE, '/atlas/admin/session/start', { nonce: (await get(NODE_BASE, '/atlas/admin/session/nonce')).body.nonce });
    assert(oldShape.status === 401 && /payload and proof are required/.test(oldShape.body.error || ''), 'expected the old bare-body shape to be rejected, got: ' + JSON.stringify(oldShape));
    console.log('PASS: old bare-body shape rejected ->', oldShape.body.error);

    console.log('\nALL ADMIN SESSION CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    nodeProc.kill();
    try { fs.rmSync(NODE_STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(NODE_DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
