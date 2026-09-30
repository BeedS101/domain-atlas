// Manual, end-to-end check for oracle-demo.html against issuer-php — same
// "real HTTP calls against PHP's built-in dev server, no mocking" pattern
// as manual-governance-demo-php.js; this feature's own Node-side companion
// is manual-oracle-demo.js. Not part of the permanent suite, same
// reasoning as the other manual-*.js scripts.
//
// Covers the same six checks as the Node version, at the HTTP layer: buy a
// policy, a sub-threshold report is rejected at claim time, an over-
// threshold report for the same flight succeeds and independently
// verifies, a second claim against the same policy is rejected, and a
// genuine over-threshold report for a DIFFERENT flight is rejected as a
// mismatch.

const { spawn } = require('child_process');
const { webcrypto } = require('crypto');
const fs = require('fs');
const path = require('path');

const { subtle } = webcrypto;
const PORT = 8194; // isolated — distinct from every other manual-*.js/-php.js test's chosen port
const BASE = 'http://localhost:' + PORT;
const BUNDLE_DIR = path.resolve(__dirname, '..', 'issuer-php');

const GENERATED_FILES = [
  path.resolve(BUNDLE_DIR, 'lib', 'issuer-private-key.pem'),
  path.resolve(BUNDLE_DIR, 'lib', 'reviewer-private-key.pem'),
  path.resolve(BUNDLE_DIR, '.well-known', 'atlas-key.json'),
  path.resolve(BUNDLE_DIR, '.well-known', 'atlas-revocations.json'),
  path.resolve(BUNDLE_DIR, '.well-known', 'atlas-reviewer-key.json'),
  path.resolve(BUNDLE_DIR, 'lib', 'atlas-oracle-policies-store.json'),
];
function cleanGeneratedFiles() {
  for (const f of GENERATED_FILES) { try { fs.unlinkSync(f); } catch (err) {} }
  try { fs.rmdirSync(path.resolve(BUNDLE_DIR, '.well-known')); } catch (err) {}
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
async function genIdentity() {
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
  return fetch(BASE + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
}
function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
async function buyPolicy(ownerPublicKey, flightNumber, payoutAmount) {
  return post('/atlas/demo/oracle/policy/issue', { ownerPublicKey, flightNumber, payoutAmount });
}
async function getOracleReport(flightNumber, delayMinutes) {
  return post('/atlas/demo/oracle/attest', { flightNumber, delayMinutes });
}
async function claimPayout(identity, credential, attestation) {
  const payload = { policyId: credential.id, action: 'claim-payout' };
  const proof = await signPayload(identity, payload);
  return post('/atlas/demo/oracle/payout/claim', { credential, attestation, intent: { payload, proof } });
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

    console.log('\nALL ORACLE-DEMO CHECKS PASSED against a real PHP dev server.');
  } finally {
    serverProc.kill();
    cleanGeneratedFiles();
  }
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exitCode = 1;
});
