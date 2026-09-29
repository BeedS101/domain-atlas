// Manual check for issuer-php's port of the K-of-N treasury-approval demo
// (bank-demo.html / issuer-server/server.js's BANK_APPROVALS_FILE routes).
// Run at the HTTP layer directly against issuer-php (same style as
// manual-trade-submit-php.js) rather than through Playwright — this proves
// the PHP request/response shapes and the concurrency-guarded
// find/validate/mutate/write sequence in sign_bank_approval() (lib/
// store.php) are correct on their own, ahead of anything in a browser.
// Builds real ECDSA P-256 keypairs and signs real canonicalize()+SHA-256
// "raw-ecdsa" envelopes with Node's own crypto.webcrypto, exactly mirroring
// manual-trade-submit-php.js's own identity/signing helpers.
//
// Covers:
//   1. POST /atlas/demo/bank/request-approval validation: rejects a
//      duplicate-key approvers list, rejects requiredApprovals < 2, and
//      rejects a non-positive amount.
//   2. A valid request creates a real pending record: status pending,
//      0 signatures, the exact amount/memo/toPublicKey given, and an
//      expiresAt in the future.
//   3. GET /atlas/demo/bank/approval?id=... is ungated and returns the
//      same record — the WYSIWYS read every approver's own client is
//      expected to make for itself before signing.
//   4. POST .../sign rejects a signature from a key not on the approvers
//      list, and rejects a signature over a tampered payload (signed by
//      an authorized key, but not matching what the server actually
//      holds) — proving this is a genuine payload check, not a lookup.
//   5. A first valid signature is accepted, still leaves status pending,
//      and re-submitting that SAME officer's signature again is a no-op
//      (idempotent — doesn't double count or error).
//   6. A second valid signature reaches the 2-of-3 threshold, executes
//      the transfer (status: executed, a real urn:atlas:asset: minted
//      credential id), and a further sign attempt from the third officer
//      is rejected since it's no longer pending.
//   7. Concurrency: three officers signing a *fresh* request at the same
//      moment (Promise.all, all three requests in flight together) still
//      records all three signatures — proving sign_bank_approval()'s
//      single held lock actually prevents the two-separate-locks race
//      this code once had (see that function's own comment in store.php).
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const { webcrypto } = require('crypto');
const fs = require('fs');
const path = require('path');

const { subtle } = webcrypto;
const PORT = 8163; // isolated — distinct from every other manual-*.js/-php.js test's chosen port (see manual-bank-approval.js's 8162 for this feature's Node-side companion)
const BASE = 'http://localhost:' + PORT;
const BUNDLE_DIR = path.resolve(__dirname, '..', 'issuer-php');

// Same reasoning as manual-trade-submit-php.js's GENERATED_FILES: runtime
// state, not fixtures to commit, and a stale one from an earlier run would
// otherwise make signatures from a fresh run fail to verify or pollute the
// approvals list this test reads back.
const GENERATED_FILES = [
  path.resolve(BUNDLE_DIR, 'lib', 'issuer-private-key.pem'),
  path.resolve(BUNDLE_DIR, '.well-known', 'atlas-key.json'),
  path.resolve(BUNDLE_DIR, '.well-known', 'atlas-revocations.json'),
  path.resolve(BUNDLE_DIR, 'lib', 'atlas-bank-approvals-store.json'),
];
function cleanGeneratedFiles() {
  for (const f of GENERATED_FILES) { try { fs.unlinkSync(f); } catch (err) {} }
  try { fs.rmdirSync(path.resolve(BUNDLE_DIR, '.well-known')); } catch (err) {}
}

// ---------- crypto helpers — identical to manual-trade-submit-php.js's ----------

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

async function generateIdentity() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rawPublic = await subtle.exportKey('raw', pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: b64url(rawPublic) };
}

async function signPayload(identity, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, data);
  return { signerRole: 'raw-ecdsa', publicKey: identity.publicKey, signature: b64url(sig) };
}

function post(urlPath, body) {
  return fetch(BASE + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

function get(urlPath) {
  return fetch(BASE + urlPath).then(async (r) => ({ status: r.status, body: await r.json() }));
}

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}

async function requestApproval(approvers, requiredApprovals, toPublicKey, amount, memo) {
  const res = await post('/atlas/demo/bank/request-approval', { approvers, requiredApprovals, toPublicKey, amount, memo });
  if (res.status !== 200) throw new Error('Failed to create approval request: ' + JSON.stringify(res.body));
  return res.body.approval;
}

(async () => {
  console.log('SETUP: starting PHP\'s built-in dev server against issuer-php/test-router.php');
  cleanGeneratedFiles();
  const serverProc = spawn('php', ['-S', 'localhost:' + PORT, 'test-router.php'], { cwd: BUNDLE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
    serverProc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
  });
  console.log('PASS: PHP dev server up on port ' + PORT);

  try {
    const officerA = await generateIdentity();
    const officerB = await generateIdentity();
    const officerC = await generateIdentity();
    const recipient = await generateIdentity();
    const approvers = [officerA.publicKey, officerB.publicKey, officerC.publicKey];

    console.log('STEP 1: POST /atlas/demo/bank/request-approval validation — duplicate approvers, requiredApprovals < 2, non-positive amount');
    const dup = await post('/atlas/demo/bank/request-approval', { approvers: [officerA.publicKey, officerA.publicKey], requiredApprovals: 2, toPublicKey: recipient.publicKey, amount: 100 });
    if (dup.status !== 400 || !dup.body.error.includes('distinct')) throw new Error('Expected duplicate approvers to be rejected, got: ' + JSON.stringify(dup.body));
    const tooFewRequired = await post('/atlas/demo/bank/request-approval', { approvers, requiredApprovals: 1, toPublicKey: recipient.publicKey, amount: 100 });
    if (tooFewRequired.status !== 400) throw new Error('Expected requiredApprovals < 2 to be rejected, got: ' + JSON.stringify(tooFewRequired.body));
    const badAmount = await post('/atlas/demo/bank/request-approval', { approvers, requiredApprovals: 2, toPublicKey: recipient.publicKey, amount: -5 });
    if (badAmount.status !== 400) throw new Error('Expected a non-positive amount to be rejected, got: ' + JSON.stringify(badAmount.body));
    console.log('PASS: all three invalid requests correctly rejected with 400');

    console.log('STEP 2: a valid request creates a real pending record');
    const approval = await requestApproval(approvers, 2, recipient.publicKey, 750, 'Payroll batch');
    assert(approval.status === 'pending', 'expected a fresh request to be pending, got: ' + approval.status);
    assert(approval.signatures.length === 0, 'expected zero signatures on a fresh request');
    assert(approval.action.amount === 750, 'expected the amount given to be preserved, got: ' + approval.action.amount);
    assert(approval.action.toPublicKey === recipient.publicKey, 'expected toPublicKey to be preserved');
    assert(approval.action.memo === 'Payroll batch', 'expected memo to be preserved');
    assert(new Date(approval.expiresAt).getTime() > Date.now(), 'expected expiresAt to be in the future');
    console.log('PASS: pending request created ->', approval.id);

    console.log('STEP 3: GET /atlas/demo/bank/approval?id=... is ungated and returns the same record');
    const fetched = await get('/atlas/demo/bank/approval?id=' + encodeURIComponent(approval.id));
    if (fetched.status !== 200 || fetched.body.approval.id !== approval.id) throw new Error('Expected the same record back, got: ' + JSON.stringify(fetched.body));
    console.log('PASS: fetched the pending record with no credential presented');

    console.log('STEP 4: sign rejects an unauthorized key, and rejects a signature over a tampered payload');
    const outsider = await generateIdentity();
    const outsiderProof = await signPayload(outsider, { id: approval.id, action: approval.action });
    const outsiderSign = await post('/atlas/demo/bank/approval/sign', { id: approval.id, proof: outsiderProof });
    if (outsiderSign.status !== 400 || !outsiderSign.body.error.includes('not an authorized approver')) {
      throw new Error('Expected an unauthorized key to be rejected, got: ' + JSON.stringify(outsiderSign.body));
    }
    const tamperedAction = { ...approval.action, amount: 999999 };
    const tamperedProof = await signPayload(officerC, { id: approval.id, action: tamperedAction });
    const tamperedSign = await post('/atlas/demo/bank/approval/sign', { id: approval.id, proof: tamperedProof });
    if (tamperedSign.status !== 400 || !tamperedSign.body.error.includes('does not check out')) {
      throw new Error('Expected a tampered-payload signature to be rejected, got: ' + JSON.stringify(tamperedSign.body));
    }
    console.log('PASS: unauthorized key and tampered payload both correctly rejected');

    console.log('STEP 5: a first valid signature is accepted (still pending), a repeat of the same signature is an idempotent no-op');
    const proofA = await signPayload(officerA, { id: approval.id, action: approval.action });
    const signA = await post('/atlas/demo/bank/approval/sign', { id: approval.id, proof: proofA });
    if (signA.status !== 200 || signA.body.approval.status !== 'pending' || signA.body.approval.signatures.length !== 1) {
      throw new Error('Expected Officer A\'s signature to be accepted, still pending, got: ' + JSON.stringify(signA.body));
    }
    const signAAgain = await post('/atlas/demo/bank/approval/sign', { id: approval.id, proof: proofA });
    if (signAAgain.status !== 200 || signAAgain.body.approval.signatures.length !== 1) {
      throw new Error('Expected a repeat signature from the same key to be a no-op, got: ' + JSON.stringify(signAAgain.body));
    }
    console.log('PASS: first signature accepted, repeat signature did not double-count ->', signA.body.approval.signatures.length);

    console.log('STEP 6: a second valid signature reaches the 2-of-3 threshold and executes; a further sign attempt is then rejected');
    const proofB = await signPayload(officerB, { id: approval.id, action: approval.action });
    const signB = await post('/atlas/demo/bank/approval/sign', { id: approval.id, proof: proofB });
    if (signB.status !== 200 || signB.body.approval.status !== 'executed') {
      throw new Error('Expected the second signature to cross the threshold and execute, got: ' + JSON.stringify(signB.body));
    }
    assert(typeof signB.body.approval.executedCredentialId === 'string' && signB.body.approval.executedCredentialId.startsWith('urn:atlas:asset:'), 'expected a real minted credential id, got: ' + signB.body.approval.executedCredentialId);
    const proofC = await signPayload(officerC, { id: approval.id, action: approval.action });
    const signCAfterExecuted = await post('/atlas/demo/bank/approval/sign', { id: approval.id, proof: proofC });
    if (signCAfterExecuted.status !== 400 || !signCAfterExecuted.body.error.includes('already executed')) {
      throw new Error('Expected a sign attempt on an already-executed request to be rejected, got: ' + JSON.stringify(signCAfterExecuted.body));
    }
    console.log('PASS: executed with a real minted credential ->', signB.body.approval.executedCredentialId, '— further signing rejected ->', signCAfterExecuted.body.error);

    console.log('STEP 7: concurrency — three officers signing a fresh request at the same moment all get recorded, none dropped');
    const raceApproval = await requestApproval(approvers, 3, recipient.publicKey, 42, 'Concurrency check');
    const raceProofs = await Promise.all([officerA, officerB, officerC].map((o) => signPayload(o, { id: raceApproval.id, action: raceApproval.action })));
    const raceResults = await Promise.all(raceProofs.map((proof) => post('/atlas/demo/bank/approval/sign', { id: raceApproval.id, proof })));
    for (const r of raceResults) {
      if (r.status !== 200) throw new Error('Expected every concurrent signature to be accepted, got: ' + JSON.stringify(r.body));
    }
    const raceFinal = await get('/atlas/demo/bank/approval?id=' + encodeURIComponent(raceApproval.id));
    if (raceFinal.body.approval.signatures.length !== 3) {
      throw new Error('Expected all 3 concurrent signatures to be recorded (none dropped by a racing read-modify-write), got: ' + raceFinal.body.approval.signatures.length);
    }
    if (raceFinal.body.approval.status !== 'executed') throw new Error('Expected the 3-of-3 request to execute once all three land, got: ' + raceFinal.body.approval.status);
    console.log('PASS: all 3 concurrent signatures recorded and the request executed — the held lock in sign_bank_approval() holds up under real concurrent load');

    console.log('\nALL PHP K-OF-N TREASURY APPROVAL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    serverProc.kill();
    cleanGeneratedFiles();
  }
})();
