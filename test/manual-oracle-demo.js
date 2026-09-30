// Manual end-to-end check for demo-domain-a/oracle-demo.html, run directly
// against a real isolated issuer-server instance (no mocking, no browser)
// — same "spin up a throwaway instance, hit its real endpoints" pattern as
// manual-governance-demo.js. Not part of the permanent suite, same
// reasoning as every other manual-*.js script.
//
// Covers, in the same order the page itself drives them:
//   1. A traveler buys a flight-delay policy for BA249, 500-unit payout.
//   2. The oracle reports a 45-minute delay (below the 120-minute
//      threshold); requesting a payout against it is rejected.
//   3. The oracle reports a 150-minute delay for the SAME flight; the
//      payout succeeds, mints the right quantity, and the returned
//      payout credential independently verifies against the domain's
//      own published key.
//   4. Requesting a second payout against the same already-claimed
//      policy is rejected.
//   5. A fresh oracle report for a DIFFERENT flight, presented against
//      the original policy, is rejected as a flight mismatch — even
//      though that report's own signature is perfectly genuine and well
//      over threshold.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const PORT = 8193; // isolated — distinct from every other manual-*.js test's chosen port
const DOMAIN = 'localhost:' + PORT;
const BASE = 'http://' + DOMAIN;
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-oracle-demo-node-'));
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-oracle-demo-docroot-'));

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
async function signWithSelf(identity, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey: identity.publicKey, signature: b64url(sig) };
}
function postJson(urlPath, body) {
  return fetch(BASE + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
}
async function buyPolicy(ownerPublicKey, flightNumber, payoutAmount) {
  return postJson('/atlas/demo/oracle/policy/issue', { ownerPublicKey, flightNumber, payoutAmount });
}
async function getOracleReport(flightNumber, delayMinutes) {
  return postJson('/atlas/demo/oracle/attest', { flightNumber, delayMinutes });
}
async function claimPayout(identity, credential, attestation) {
  const payload = { policyId: credential.id, action: 'claim-payout' };
  const proof = await signWithSelf(identity, payload);
  return postJson('/atlas/demo/oracle/payout/claim', { credential, attestation, intent: { payload, proof } });
}
async function verifyAssetCredentialIndependently(credential) {
  const keyDoc = await fetch(BASE + '/.well-known/atlas-key.json', { cache: 'no-store' }).then((r) => r.json());
  const issuedAt = new Date(credential.issuedAt).getTime();
  const activeKey = (keyDoc.keys || []).find((k) => {
    const from = new Date(k.validFrom).getTime();
    const until = k.validUntil ? new Date(k.validUntil).getTime() : Infinity;
    return issuedAt >= from && issuedAt <= until;
  });
  if (!activeKey) return { valid: false, reason: 'no currently-valid key at issuedAt' };
  const payload = {
    id: credential.id, asset: credential.asset, owner: credential.owner,
    quantity: credential.quantity, supersedes: credential.supersedes, issuedAt: credential.issuedAt
  };
  const data = new TextEncoder().encode(canonicalize(payload));
  const publicKey = await subtle.importKey('raw', Buffer.from(activeKey.publicKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const sigBuf = Buffer.from(credential.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const sigOk = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sigBuf, data);
  return { valid: sigOk, reason: sigOk ? 'signature checks out' : "signature doesn't match" };
}

(async () => {
  console.log('SETUP: starting an isolated issuer-server instance on port ' + PORT);
  const proc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: DOCROOT_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    proc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-server up on port ' + PORT);

  try {
    console.log('STEP 1: a traveler buys a flight-delay policy for BA249, 500-unit payout');
    const traveler = await genIdentity();
    const buyRes = await buyPolicy(traveler.publicKey, 'BA249', 500);
    assert(buyRes.status === 200, 'policy purchase failed: ' + JSON.stringify(buyRes.body));
    assert(buyRes.body.thresholdMinutes === 120, 'expected the fixed 120-minute threshold, got: ' + JSON.stringify(buyRes.body));
    const policy = buyRes.body.policy;
    assert(policy.asset.class === 'atlas.demo.insurance.policy', 'unexpected policy class');
    console.log('PASS: policy', policy.id, 'issued for BA249, 500-unit payout, 120-minute threshold');

    console.log('STEP 2: the oracle reports only a 45-minute delay — a payout request is rejected');
    const shortReport = await getOracleReport('BA249', 45);
    assert(shortReport.status === 200, 'oracle report failed: ' + JSON.stringify(shortReport.body));
    const shortClaim = await claimPayout(traveler, policy, shortReport.body.attestation);
    assert(shortClaim.status === 400, 'expected a sub-threshold claim to be rejected, got status ' + shortClaim.status);
    assert(/does not meet/.test(shortClaim.body.error || ''), 'unexpected sub-threshold rejection text: ' + JSON.stringify(shortClaim.body));
    console.log('PASS: rejected ->', shortClaim.body.error);

    console.log('STEP 3: the oracle reports a 150-minute delay for the SAME flight — the payout succeeds');
    const longReport = await getOracleReport('BA249', 150);
    assert(longReport.status === 200, 'oracle report failed: ' + JSON.stringify(longReport.body));
    const claimRes = await claimPayout(traveler, policy, longReport.body.attestation);
    assert(claimRes.status === 200, 'expected the over-threshold claim to succeed: ' + JSON.stringify(claimRes.body));
    const payout = claimRes.body.payout;
    assert(payout.quantity === 500 && payout.asset.class === 'atlas.demo.insurance.payout', 'unexpected payout shape: ' + JSON.stringify(payout));
    assert(payout.owner.publicKey === traveler.publicKey, 'payout should go to the policy holder');
    console.log('PASS: paid out', payout.quantity, 'units, no manual review');

    console.log('STEP 4: independently verify the payout credential');
    const verdict = await verifyAssetCredentialIndependently(payout);
    assert(verdict.valid, 'expected the payout to independently verify, got: ' + verdict.reason);
    console.log('PASS:', verdict.reason);

    console.log('STEP 5: requesting a second payout against the same already-claimed policy is rejected');
    const doubleClaim = await claimPayout(traveler, policy, longReport.body.attestation);
    assert(doubleClaim.status === 400, 'expected a double claim to be rejected, got status ' + doubleClaim.status);
    assert(/already been paid out/.test(doubleClaim.body.error || ''), 'unexpected double-claim rejection text: ' + JSON.stringify(doubleClaim.body));
    console.log('PASS: rejected ->', doubleClaim.body.error);

    console.log('STEP 6: a genuine, well-over-threshold report for a DIFFERENT flight is rejected as a mismatch');
    const otherReport = await getOracleReport('ZZ999', 200);
    assert(otherReport.status === 200, 'oracle report failed: ' + JSON.stringify(otherReport.body));
    const mismatchClaim = await claimPayout(traveler, policy, otherReport.body.attestation);
    assert(mismatchClaim.status === 400, 'expected a mismatched-flight claim to be rejected, got status ' + mismatchClaim.status);
    assert(/different flight/.test(mismatchClaim.body.error || ''), 'unexpected mismatch rejection text: ' + JSON.stringify(mismatchClaim.body));
    console.log('PASS: rejected ->', mismatchClaim.body.error);

    console.log('\nALL ORACLE-DEMO CHECKS PASSED against a real, isolated issuer-server instance.');
  } finally {
    proc.kill();
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.rmSync(DOCROOT_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exitCode = 1;
});
