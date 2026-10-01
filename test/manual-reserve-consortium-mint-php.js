// Manual check for issuer-php's port of the domain-quorum extension of
// reserve-bank-demo.html's K-of-N mint — atlas/demo/reserve/consortium/
// {request-mint,mint/index,co-sign,approve}.php. Same two-isolated-bundle
// harness smoke-trusted-peers-admin.js already uses (one copied issuer-php
// bundle per PHP dev server, each on its own port, so each gets its own
// Host-header domain identity and its own key/store files), since this is
// the first reserve-mint mechanism that genuinely needs two live domains
// rather than one tab's own simulated identities. Run at the HTTP layer
// directly, same reasoning as manual-bank-approval-php.js: proves the PHP
// request/response shapes and atlas_approve_reserve_mint_consortium()'s
// (lib/store.php) find/validate/mutate/write sequence are correct on their
// own, ahead of anything in a browser — see
// test/manual-reserve-consortium-mint.js (this feature's Node-side
// companion) for the full list of what's checked; the checks here are the
// same, against the PHP backend.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const REPO = path.resolve(__dirname, '..');
const A_PORT = 8195; // isolated — distinct from every other manual-*.js/-php.js test's chosen port
const B_PORT = 8196;
const A_DOMAIN = 'localhost:' + A_PORT;
const B_DOMAIN = 'localhost:' + B_PORT;
const A_BASE = 'http://' + A_DOMAIN;
const B_BASE = 'http://' + B_DOMAIN;

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }
function b64url(bytes) { return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
function get(base, p) { return fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() })); }
function postJson(base, p, body) {
  return fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
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
async function login(base, admin) {
  const nonce = (await get(base, '/atlas/admin/session/nonce')).body.nonce;
  const payload = { nonce };
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  const res = await postJson(base, '/atlas/admin/session/start', { payload, proof });
  if (res.status !== 200) throw new Error('login failed: ' + JSON.stringify(res));
  return res.body.token;
}

function startPhpServer(port, bundleDir) {
  // PHP_CLI_SERVER_WORKERS matters here specifically: this feature's own
  // co-sign route makes A wait on an outbound call to B while B is itself
  // mid-request on the inbound call from A (B's co-sign waiting on A's
  // /approve, which in turn calls back out to fetch B's own published key)
  // — a genuine two-domain round trip, not a self-call. The built-in dev
  // server's default single worker can only serve one request at a time,
  // so without this it deadlocks: A blocks on B, B blocks on A, waiting on
  // each other forever until the client's own timeout fires. A real
  // deployment (Apache/PHP-FPM) is always multi-worker already, so this is
  // purely a test-harness fix, not anything the feature itself needs to
  // work around.
  const proc = spawn('php', ['-S', 'localhost:' + port, 'test-router.php'], {
    cwd: bundleDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4' }
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php server on ' + port + ' did not start in time')), 5000);
    proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(proc); } });
    proc.on('exit', (code) => reject(new Error('php server on ' + port + ' exited early with code ' + code)));
  });
}

(async () => {
  const aBundle = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-consortium-php-a-'));
  const bBundle = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-consortium-php-b-'));
  fs.cpSync(path.join(REPO, 'issuer-php'), aBundle, { recursive: true });
  fs.cpSync(path.join(REPO, 'issuer-php'), bBundle, { recursive: true });

  console.log('SETUP: starting PHP domain A on', A_PORT, 'and PHP domain B on', B_PORT);
  const aProc = await startPhpServer(A_PORT, aBundle);
  const bProc = await startPhpServer(B_PORT, bBundle);
  console.log('PASS: both PHP domains up');

  try {
    const aAdmin = await genIdentity();
    fs.writeFileSync(path.join(aBundle, 'lib', 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: aAdmin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
    const aToken = await login(A_BASE, aAdmin);

    const bAdmin = await genIdentity();
    fs.writeFileSync(path.join(bBundle, 'lib', 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: bAdmin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
    const bToken = await login(B_BASE, bAdmin);
    console.log('PASS: both PHP domains have a logged-in admin session');

    const treasury = await genIdentity();

    console.log('STEP 1: A creates a pending 2-of-2 consortium request naming [A, B]');
    let res = await postJson(A_BASE, '/atlas/demo/reserve/consortium/request-mint', {
      approverDomains: [A_DOMAIN, B_DOMAIN], requiredApprovals: 2,
      toPublicKey: treasury.publicKey, amount: 50000, memo: 'Consortium issuance test (PHP)'
    });
    assert(res.status === 200 && res.body.request && res.body.request.status === 'pending', 'expected a pending request, got: ' + JSON.stringify(res));
    const id = res.body.request.id;
    console.log('PASS: created', id);

    console.log('STEP 2: A can read it back fresh via the ungated GET');
    res = await get(A_BASE, '/atlas/demo/reserve/consortium/mint/?id=' + encodeURIComponent(id));
    assert(res.status === 200 && res.body.request.id === id, 'expected to read the request back, got: ' + JSON.stringify(res));
    console.log('PASS: read back');

    console.log('STEP 3: B co-signs (logged in as B\'s own admin) — relays a real attestation to A, 1 of 2');
    res = await postJson(B_BASE, '/atlas/demo/reserve/consortium/co-sign', { payload: { requestingDomain: A_DOMAIN, id }, token: bToken });
    assert(res.status === 200 && res.body.ok === true, 'expected B\'s co-sign to succeed, got: ' + JSON.stringify(res));
    assert(res.body.request.approvals.length === 1 && res.body.request.approvals[0].domain === B_DOMAIN, 'expected exactly 1 approval, from B, got: ' + JSON.stringify(res.body.request));
    assert(res.body.request.status === 'pending', 'expected still pending after 1 of 2, got: ' + res.body.request.status);
    console.log('PASS: B co-signed, 1 of 2, still pending');

    console.log('STEP 4: a domain NOT named as an approver is rejected (403) if it tries to approve directly against A');
    const outsider = await genIdentity();
    const outsiderAttestation = { domain: 'outsider.example', requestingDomain: A_DOMAIN, id, action: res.body.request.action };
    const outsiderSigData = new TextEncoder().encode(canonicalize(outsiderAttestation));
    const outsiderSig = b64url(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, outsider.kp.privateKey, outsiderSigData)));
    res = await postJson(A_BASE, '/atlas/demo/reserve/consortium/approve', { id, attestation: outsiderAttestation, attestationSignature: outsiderSig });
    assert(res.status === 403, 'expected 403 for a non-approver domain, got: ' + JSON.stringify(res));
    console.log('PASS: non-approver domain rejected with 403');

    // Steps 5-6 both target domain A's own still-unapproved slot (B already
    // legitimately approved in step 3, so re-targeting B here would just
    // hit the idempotent "already approved" short-circuit before ever
    // reaching the checks these steps actually mean to exercise).
    console.log('STEP 5: a forged attestation (claims to be A, signed with a key that is NOT A\'s real published key) is rejected');
    const forger = await genIdentity();
    const fresh = await get(A_BASE, '/atlas/demo/reserve/consortium/mint/?id=' + encodeURIComponent(id));
    const forgedAttestation = { domain: A_DOMAIN, requestingDomain: A_DOMAIN, id, action: fresh.body.request.action };
    const forgedSigData = new TextEncoder().encode(canonicalize(forgedAttestation));
    const forgedSig = b64url(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, forger.kp.privateKey, forgedSigData)));
    res = await postJson(A_BASE, '/atlas/demo/reserve/consortium/approve', { id, attestation: forgedAttestation, attestationSignature: forgedSig });
    assert(res.status === 400 && /signature does not check out/.test(res.body.error || ''), 'expected a signature-check failure for the forged attestation, got: ' + JSON.stringify(res));
    console.log('PASS: forged attestation rejected — A\'s claimed domain name alone is not enough, the signature has to check out against A\'s own fetched key');

    console.log('STEP 6: a tampered action (different amount) is rejected even over a correctly-"signed" payload');
    const tamperedAttestation = { domain: A_DOMAIN, requestingDomain: A_DOMAIN, id, action: { ...fresh.body.request.action, amount: 999999999 } };
    const tamperedSig = 'not-a-real-signature';
    res = await postJson(A_BASE, '/atlas/demo/reserve/consortium/approve', { id, attestation: tamperedAttestation, attestationSignature: tamperedSig });
    assert(res.status === 400 && /pending action exactly/.test(res.body.error || ''), 'expected the tampered-action check to fire, got: ' + JSON.stringify(res));
    console.log('PASS: tampered action rejected on the exact-action-match check');

    console.log('STEP 7: A co-signs (logged in as A\'s own admin) — reaches 2 of 2, mint executes');
    res = await postJson(A_BASE, '/atlas/demo/reserve/consortium/co-sign', { payload: { requestingDomain: A_DOMAIN, id }, token: aToken });
    assert(res.status === 200 && res.body.ok === true, 'expected A\'s co-sign to succeed, got: ' + JSON.stringify(res));
    assert(res.body.request.status === 'executed', 'expected the mint to have executed at 2 of 2, got: ' + JSON.stringify(res.body.request));
    assert(res.body.request.executedCredential && res.body.request.executedCredential.quantity === 50000, 'expected a real 50000-quantity minted credential, got: ' + JSON.stringify(res.body.request.executedCredential));
    console.log('PASS: executed — minted credential', res.body.request.executedCredential.id);

    console.log('STEP 8: re-approving as B after execution is a clean 400 ("already executed")');
    res = await postJson(B_BASE, '/atlas/demo/reserve/consortium/co-sign', { payload: { requestingDomain: A_DOMAIN, id }, token: bToken });
    assert(res.status === 400 && /already executed/.test(res.body.error || ''), 'expected a clean "already executed" rejection, got: ' + JSON.stringify(res));
    console.log('PASS: rejected cleanly as already executed');

    console.log('\nALL PHP CONSORTIUM-MINT CHECKS PASSED');
  } finally {
    aProc.kill();
    bProc.kill();
  }
})().catch((err) => { console.error(err); process.exit(1); });
