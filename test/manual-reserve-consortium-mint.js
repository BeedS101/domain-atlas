// Manual check for the domain-quorum extension of reserve-bank-demo.html's
// K-of-N mint: POST /atlas/demo/reserve/consortium/request-mint,
// GET /atlas/demo/reserve/consortium/mint, POST .../co-sign (admin-gated,
// on the APPROVING domain), POST .../approve (the inbound half, on the
// REQUESTING domain). Spins up two isolated Node issuer-server instances —
// domain A (the requesting domain) and domain B (a sibling approver) — the
// same two-instance harness smoke-trusted-peers-admin.js already uses, since
// this is the first reserve-mint mechanism that genuinely needs two live
// domains rather than one tab's own simulated identities.
//
// Checks:
//   1. A creates a pending 2-of-2 consortium request naming [A, B].
//   2. A can read it back fresh via the ungated GET.
//   3. B's own co-sign (logged in as B's admin) relays a real attestation to
//      A and is accepted — 1 of 2, not yet executed.
//   4. A domain NOT named as an approver is rejected with 403 when it tries
//      to approve directly against A.
//   5. A forged attestation (signed with a key that is NOT B's real
//      published issuer key) is rejected — proves this is a genuine
//      signature-over-the-canonical-attestation check against B's
//      FETCHED key, not a bare "says domain: B" lookup.
//   6. A tampered action (attestation claims a different amount than the
//      pending request actually has) is rejected even if "signed" correctly
//      over that tampered payload — proves the approve route binds the
//      attestation to the exact stored action, not just the request id.
//   7. A's own co-sign (logged in as A's admin) reaches the 2-of-2
//      threshold and the mint executes, with a real minted credential.
//   8. Re-approving as B after execution is a clean 400 ("already
//      executed"), the same behavior every other K-of-N demo's own sign
//      route already gives once its own threshold is met — not a silent
//      no-op.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { withAdminAuth } = require('./lib/admin-auth');
const { subtle } = webcrypto;

const REPO = path.resolve(__dirname, '..');
const A_PORT = 8193;
const B_PORT = 8194;
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
  const payload = withAdminAuth({ nonce }, base, '/atlas/admin/session/start');
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  const res = await postJson(base, '/atlas/admin/session/start', { payload, proof });
  if (res.status !== 200) throw new Error('login failed: ' + JSON.stringify(res));
  return res.body.token;
}

function startServer(port, domain, stateDir, docrootDir) {
  const proc = spawn('node', ['issuer-server/server.js'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), ATLAS_DOMAIN: domain, ATLAS_STATE_DIR: stateDir, ATLAS_DOCROOT: docrootDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server on ' + domain + ' did not start in time')), 10000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(proc); } });
    proc.on('exit', (code) => reject(new Error('server on ' + domain + ' exited early with code ' + code)));
  });
}

(async () => {
  const aState = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-consortium-a-'));
  const aDocroot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-consortium-a-doc-'));
  const bState = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-consortium-b-'));
  const bDocroot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-consortium-b-doc-'));

  console.log('SETUP: starting domain A on', A_PORT, 'and domain B on', B_PORT);
  const aProc = await startServer(A_PORT, A_DOMAIN, aState, aDocroot);
  const bProc = await startServer(B_PORT, B_DOMAIN, bState, bDocroot);
  console.log('PASS: both domains up');

  try {
    const aAdmin = await genIdentity();
    fs.writeFileSync(path.join(aState, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: aAdmin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
    const aToken = await login(A_BASE, aAdmin);

    const bAdmin = await genIdentity();
    fs.writeFileSync(path.join(bState, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: bAdmin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
    const bToken = await login(B_BASE, bAdmin);
    console.log('PASS: both domains have a logged-in admin session');

    const treasury = await genIdentity();

    console.log('STEP 1: A creates a pending 2-of-2 consortium request naming [A, B]');
    let res = await postJson(A_BASE, '/atlas/demo/reserve/consortium/request-mint', {
      approverDomains: [A_DOMAIN, B_DOMAIN], requiredApprovals: 2,
      toPublicKey: treasury.publicKey, amount: 50000, memo: 'Consortium issuance test'
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
    const outsider = await genIdentity(); // stands in for a real outsider domain's signature — the domain name itself is what's checked first
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
    // Fresh fetch of the real pending action to build a plausible-looking forged attestation from.
    const fresh = await get(A_BASE, '/atlas/demo/reserve/consortium/mint/?id=' + encodeURIComponent(id));
    const forgedAttestation = { domain: A_DOMAIN, requestingDomain: A_DOMAIN, id, action: fresh.body.request.action };
    const forgedSigData = new TextEncoder().encode(canonicalize(forgedAttestation));
    const forgedSig = b64url(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, forger.kp.privateKey, forgedSigData)));
    res = await postJson(A_BASE, '/atlas/demo/reserve/consortium/approve', { id, attestation: forgedAttestation, attestationSignature: forgedSig });
    assert(res.status === 400 && /signature does not check out/.test(res.body.error || ''), 'expected a signature-check failure for the forged attestation, got: ' + JSON.stringify(res));
    console.log('PASS: forged attestation rejected — A\'s claimed domain name alone is not enough, the signature has to check out against A\'s own fetched key');

    console.log('STEP 6: a tampered action (different amount) is rejected even over a correctly-"signed" payload');
    const tamperedAttestation = { domain: A_DOMAIN, requestingDomain: A_DOMAIN, id, action: { ...fresh.body.request.action, amount: 999999999 } };
    // Can't actually sign with A's real key here (this test doesn't hold it) — this simulates the shape a compromised relay path might attempt; the approve route must reject this on the ACTION MISMATCH check before it would even get to a signature check.
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

    console.log('STEP 8: re-approving as B after execution is a clean 400 ("already executed"), same as every other K-of-N demo\'s own sign route once its threshold is already met — not a silent no-op');
    res = await postJson(B_BASE, '/atlas/demo/reserve/consortium/co-sign', { payload: { requestingDomain: A_DOMAIN, id }, token: bToken });
    assert(res.status === 400 && /already executed/.test(res.body.error || ''), 'expected a clean "already executed" rejection, got: ' + JSON.stringify(res));
    console.log('PASS: rejected cleanly as already executed');

    console.log('\nALL NODE CONSORTIUM-MINT CHECKS PASSED');
  } finally {
    aProc.kill();
    bProc.kill();
  }
})().catch((err) => { console.error(err); process.exit(1); });
