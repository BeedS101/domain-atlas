// Companion to test/manual-admin-session-actions.js — proves issuer-php's
// own port of require_admin_auth() (lib/store.php) lets the four
// admin-gated action routes (atlas/revoke.php, atlas/mail/send.php,
// atlas/asset/reissue.php, atlas/calendar.php) accept a session token the
// same way the Node backend does. See that file for the full reasoning on
// why this needed building at all.
//
// Same "HTTP layer directly, isolated bundle copy" style as
// manual-admin-session-php.js.
//
// Checks (mirrors manual-admin-session-actions.js's own, see that file):
//   1. Log in via the session primitive to get a token.
//   2. atlas/revoke.php with {payload, token} (no proof) succeeds.
//   3. atlas/calendar.php POST (action: add) with {payload, token} succeeds.
//   4. atlas/mail/send.php with {payload, token} succeeds.
//   5. atlas/asset/reissue.php with {payload, token} succeeds.
//   6. A garbage token on atlas/revoke.php is rejected 401.
//   7. Regression: atlas/revoke.php with a freshly signed {payload, proof}
//      and NO token still works.
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
const PORT = 8116; // isolated — distinct from every other manual-*-php.js test's own port
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

async function issueAsset(base, ownerPublicKey, assetClass, quantity) {
  const res = await postJson(base, '/atlas/asset/issue', { ownerPublicKey, assetClass, quantity });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ' at ' + base + ': ' + JSON.stringify(res.body));
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-admin-session-actions-php-'));
  const bundle = path.join(tmpRoot, 'domain');
  console.log('SETUP: copying issuer-php into an isolated throwaway bundle');
  fs.cpSync(BUNDLE_DIR, bundle, { recursive: true });

  let proc;
  try {
    proc = await startPhpServer(bundle, PORT);
    console.log('PASS: PHP dev server up on ' + PORT);

    const admin = await genIdentity();
    const owner = 'test-owner-public-key-admin-session-actions-php-demo';
    fs.writeFileSync(path.join(bundle, 'lib', 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));

    console.log('STEP 1: log in via the session primitive');
    const token = await login(admin);
    assert(typeof token === 'string' && token.length > 0, 'expected a session token');
    console.log('PASS: got session token ->', token.slice(0, 16) + '...');

    console.log('STEP 2: POST /atlas/revoke with {payload, token} (no proof) succeeds');
    const toRevoke = await issueAsset(BASE, owner, 'atlas.trophy.chess', 1);
    const revokeRes = await postJson(BASE, '/atlas/revoke', { payload: { id: toRevoke.id, reason: 'token-path-test' }, token });
    assert(revokeRes.status === 200 && revokeRes.body.ok === true, 'expected revoke via token to succeed, got: ' + JSON.stringify(revokeRes));
    console.log('PASS: revoke via token succeeded');

    console.log('STEP 3: POST /atlas/calendar (add) with {payload, token} succeeds');
    const calendarRes = await postJson(BASE, '/atlas/calendar', { payload: { action: 'add', event: { title: 'Token path check', dateTime: new Date().toISOString() } }, token });
    assert(calendarRes.status === 200 && calendarRes.body.id, 'expected calendar add via token to succeed, got: ' + JSON.stringify(calendarRes));
    console.log('PASS: calendar add via token succeeded ->', calendarRes.body.id);

    console.log('STEP 4: POST /atlas/mail/send with {payload, token} succeeds');
    const mailCredential = await issueAsset(BASE, owner, 'atlas.trophy.chess', 1);
    const mailRes = await postJson(BASE, '/atlas/mail/send', { payload: { credentialId: mailCredential.id, subject: 'Token path check', body: 'sent via session token, not a signed proof' }, token });
    assert(mailRes.status === 200 && mailRes.body.credentialId === mailCredential.id, 'expected mail send via token to succeed, got: ' + JSON.stringify(mailRes));
    console.log('PASS: mail send via token succeeded');

    console.log('STEP 5: POST /atlas/asset/reissue with {payload, token} succeeds');
    const toReissue = await issueAsset(BASE, owner, 'atlas.trophy.chess', 1);
    const reissueRes = await postJson(BASE, '/atlas/asset/reissue', { payload: { credential: toReissue, properties: { engraved: 'token path' } }, token });
    assert(reissueRes.status === 200 && reissueRes.body.newCredential, 'expected reissue via token to succeed, got: ' + JSON.stringify(reissueRes));
    console.log('PASS: reissue via token succeeded ->', reissueRes.body.newCredential.id);

    console.log('STEP 6: a garbage token on /atlas/revoke is rejected 401, same as a bad proof would be');
    const anotherToRevoke = await issueAsset(BASE, owner, 'atlas.trophy.chess', 1);
    const badTokenRes = await postJson(BASE, '/atlas/revoke', { payload: { id: anotherToRevoke.id }, token: 'not-a-real-token' });
    assert(badTokenRes.status === 401, 'expected a garbage token to be rejected, got: ' + JSON.stringify(badTokenRes));
    console.log('PASS: garbage token rejected ->', badTokenRes.body.error);

    console.log('STEP 7: regression — {payload, proof} with NO token still works on /atlas/revoke');
    const proofOnlyPayload = { id: anotherToRevoke.id, reason: 'proof-path-still-works' };
    const proof = await signWithSelf(admin.kp, admin.publicKey, proofOnlyPayload);
    const proofOnlyRes = await postJson(BASE, '/atlas/revoke', { payload: proofOnlyPayload, proof });
    assert(proofOnlyRes.status === 200 && proofOnlyRes.body.ok === true, 'expected the pre-existing proof-only path to still work, got: ' + JSON.stringify(proofOnlyRes));
    console.log('PASS: proof-only path still works unchanged');

    console.log('\nALL ADMIN SESSION ACTION-TOKEN PHP CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (proc) proc.kill();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) {}
  }
})();
