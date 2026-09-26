// Protocol-level check that the four admin-gated action endpoints —
// POST /atlas/revoke, /atlas/mail/send, /atlas/asset/reissue, and
// /atlas/calendar — accept a session token (from the admin session
// primitive, manual-admin-session.js) as an alternative to a freshly
// signed proof envelope. Without this, the session primitive could only
// ever answer "am I an admin" (via /whoami) — it couldn't actually
// authorize any of the real actions, which is the entire point of having
// a session in the first place (a future admin page holding a token, not
// the wallet's private key, doing the clicking).
//
// requireAdminAuth(payload, proof, token) is the shared gate all four
// routes now call: a token, when present, is checked instead of proof;
// proof-based calls with no token still work exactly as before (every
// existing manual-*.js test and tools/admin-*.js CLI already proves that
// path, so this file focuses on the NEW token path plus one regression
// check that the old path still works after the refactor).
//
// HTTP layer directly, same isolated-instance style as
// manual-admin-session.js — no browser/extension involved.
//
// Checks:
//   1. Log in via the session primitive to get a token.
//   2. /atlas/revoke with {payload, token} (no proof) succeeds.
//   3. /atlas/calendar POST (action: add) with {payload, token} succeeds.
//   4. /atlas/mail/send with {payload, token} succeeds.
//   5. /atlas/asset/reissue with {payload, token} succeeds.
//   6. A garbage token on /atlas/revoke is rejected 401, same as a bad
//      proof would be.
//   7. Regression: /atlas/revoke with a freshly signed {payload, proof}
//      and NO token still works — the token path is additive, not a
//      replacement.
//
// Not part of the permanent suite, same reasoning as every other
// manual-*.js script.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const NODE_PORT = 8115; // isolated — distinct from every other manual-*.js test's own port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://localhost:' + NODE_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-admin-session-actions-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-admin-session-actions-docroot-'));

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
// envelope, the same one verifyEnvelope() checks.
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}

async function issueAsset(base, ownerPublicKey, assetClass, quantity) {
  const res = await postJson(base, '/atlas/asset/issue', { ownerPublicKey, assetClass, quantity });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ' at ' + base + ': ' + JSON.stringify(res.body));
  return res.body;
}

async function login(admin) {
  const nonce = (await get(NODE_BASE, '/atlas/admin/session/nonce')).body.nonce;
  const payload = { nonce };
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  const res = await postJson(NODE_BASE, '/atlas/admin/session/start', { payload, proof });
  if (res.status !== 200) throw new Error('login failed: ' + JSON.stringify(res));
  return res.body.token;
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
    const owner = 'test-owner-public-key-admin-session-actions-demo';
    fs.writeFileSync(path.join(NODE_STATE_DIR, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));

    console.log('STEP 1: log in via the session primitive');
    const token = await login(admin);
    assert(typeof token === 'string' && token.length > 0, 'expected a session token');
    console.log('PASS: got session token ->', token.slice(0, 16) + '...');

    console.log('STEP 2: POST /atlas/revoke with {payload, token} (no proof) succeeds');
    const toRevoke = await issueAsset(NODE_BASE, owner, 'atlas.trophy.chess', 1);
    const revokeRes = await postJson(NODE_BASE, '/atlas/revoke', { payload: { id: toRevoke.id, reason: 'token-path-test' }, token });
    assert(revokeRes.status === 200 && revokeRes.body.ok === true, 'expected revoke via token to succeed, got: ' + JSON.stringify(revokeRes));
    console.log('PASS: revoke via token succeeded');

    console.log('STEP 3: POST /atlas/calendar (add) with {payload, token} succeeds');
    const calendarRes = await postJson(NODE_BASE, '/atlas/calendar', { payload: { action: 'add', event: { title: 'Token path check', dateTime: new Date().toISOString() } }, token });
    assert(calendarRes.status === 200 && calendarRes.body.id, 'expected calendar add via token to succeed, got: ' + JSON.stringify(calendarRes));
    console.log('PASS: calendar add via token succeeded ->', calendarRes.body.id);

    console.log('STEP 4: POST /atlas/mail/send with {payload, token} succeeds');
    const mailCredential = await issueAsset(NODE_BASE, owner, 'atlas.trophy.chess', 1);
    const mailRes = await postJson(NODE_BASE, '/atlas/mail/send', { payload: { credentialId: mailCredential.id, subject: 'Token path check', body: 'sent via session token, not a signed proof' }, token });
    assert(mailRes.status === 200 && mailRes.body.credentialId === mailCredential.id, 'expected mail send via token to succeed, got: ' + JSON.stringify(mailRes));
    console.log('PASS: mail send via token succeeded');

    console.log('STEP 5: POST /atlas/asset/reissue with {payload, token} succeeds');
    const toReissue = await issueAsset(NODE_BASE, owner, 'atlas.trophy.chess', 1);
    const reissueRes = await postJson(NODE_BASE, '/atlas/asset/reissue', { payload: { credential: toReissue, properties: { engraved: 'token path' } }, token });
    assert(reissueRes.status === 200 && reissueRes.body.newCredential, 'expected reissue via token to succeed, got: ' + JSON.stringify(reissueRes));
    console.log('PASS: reissue via token succeeded ->', reissueRes.body.newCredential.id);

    console.log('STEP 6: a garbage token on /atlas/revoke is rejected 401, same as a bad proof would be');
    const anotherToRevoke = await issueAsset(NODE_BASE, owner, 'atlas.trophy.chess', 1);
    const badTokenRes = await postJson(NODE_BASE, '/atlas/revoke', { payload: { id: anotherToRevoke.id }, token: 'not-a-real-token' });
    assert(badTokenRes.status === 401, 'expected a garbage token to be rejected, got: ' + JSON.stringify(badTokenRes));
    console.log('PASS: garbage token rejected ->', badTokenRes.body.error);

    console.log('STEP 7: regression — {payload, proof} with NO token still works on /atlas/revoke');
    const proofOnlyPayload = { id: anotherToRevoke.id, reason: 'proof-path-still-works' };
    const proof = await signWithSelf(admin.kp, admin.publicKey, proofOnlyPayload);
    const proofOnlyRes = await postJson(NODE_BASE, '/atlas/revoke', { payload: proofOnlyPayload, proof });
    assert(proofOnlyRes.status === 200 && proofOnlyRes.body.ok === true, 'expected the pre-existing proof-only path to still work, got: ' + JSON.stringify(proofOnlyRes));
    console.log('PASS: proof-only path still works unchanged');

    console.log('\nALL ADMIN SESSION ACTION-TOKEN CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    nodeProc.kill();
    try { fs.rmSync(NODE_STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(NODE_DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
