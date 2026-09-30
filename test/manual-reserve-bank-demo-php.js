// Manual, end-to-end check for reserve-bank-demo.html's full seven-act
// flow against issuer-php — same "real HTTP calls against PHP's built-in
// dev server, no mocking" pattern as manual-bank-approval-php.js, this
// feature's own Node-side companion is manual-reserve-bank-demo.js. Not
// part of the permanent suite, same reasoning as the other manual-*.js
// scripts.
//
// Covers the same seven acts as the Node version, at the HTTP layer:
// committee mint (2-of-3), wholesale issuance by split (and confirms the
// unique-item transfer endpoint refuses a fungible currency), retail
// conversion by purchase, a bank crediting a customer then that customer
// paying a second person, a cross-currency Trading Station settlement,
// an independent reserve-backing attestation, and a fraud recovered by
// suspend + clawback + consolidate, independently re-verified as revoked.

const { spawn } = require('child_process');
const { webcrypto } = require('crypto');
const fs = require('fs');
const path = require('path');

const { subtle } = webcrypto;
const PORT = 8180; // isolated — distinct from every other manual-*.js/-php.js test's chosen port
const BASE = 'http://localhost:' + PORT;
const BUNDLE_DIR = path.resolve(__dirname, '..', 'issuer-php');

const GENERATED_FILES = [
  path.resolve(BUNDLE_DIR, 'lib', 'issuer-private-key.pem'),
  path.resolve(BUNDLE_DIR, 'lib', 'reviewer-private-key.pem'),
  path.resolve(BUNDLE_DIR, '.well-known', 'atlas-key.json'),
  path.resolve(BUNDLE_DIR, '.well-known', 'atlas-revocations.json'),
  path.resolve(BUNDLE_DIR, '.well-known', 'atlas-reviewer-key.json'),
  path.resolve(BUNDLE_DIR, 'lib', 'atlas-reserve-mint-approvals-store.json'),
  path.resolve(BUNDLE_DIR, 'lib', 'atlas-tradingstation-members-store.json'),
  path.resolve(BUNDLE_DIR, 'lib', 'atlas-pending-trades-store.json'),
  path.resolve(BUNDLE_DIR, 'lib', 'atlas-suspensions-store.json'),
  path.resolve(BUNDLE_DIR, 'lib', 'atlas-attestations-store.json'),
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
function get(urlPath) {
  return fetch(BASE + urlPath).then(async (r) => ({ status: r.status, body: await r.json() }));
}
function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
async function issueAsset(ownerPublicKey, assetClass, quantity) {
  const res = await post('/atlas/asset/issue', { ownerPublicKey, assetClass, quantity });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ': ' + JSON.stringify(res.body));
  return res.body;
}
async function splitAsset(credential, sendAmount, toPublicKey) {
  return post('/atlas/asset/split', { credential, sendAmount, toPublicKey });
}
async function purchaseAsset(buyer, credential, purchasedClass, quantity) {
  const payload = { credentialId: credential.id, purchasedClass, quantity, action: 'purchase' };
  const proof = await signPayload(buyer, payload);
  return post('/atlas/asset/purchase', { credential, purchasedClass, quantity, intent: { payload, proof } });
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
    console.log('STEP 1: committee mints Reserve Credits to the treasury (2-of-3)');
    const officerA = await genIdentity(), officerB = await genIdentity(), officerC = await genIdentity();
    const treasury = await genIdentity();
    const approvers = [officerA.publicKey, officerB.publicKey, officerC.publicKey];
    const req = await post('/atlas/demo/reserve/request-mint', { approvers, requiredApprovals: 2, toPublicKey: treasury.publicKey, amount: 100000, memo: 'test issuance' });
    assert(req.status === 200, 'request-mint failed: ' + JSON.stringify(req.body));
    const approvalId = req.body.approval.id;

    const fetched1 = await get('/atlas/demo/reserve/mint?id=' + encodeURIComponent(approvalId));
    assert(fetched1.status === 200, 'GET mint failed: ' + JSON.stringify(fetched1.body));
    const sign1 = await post('/atlas/demo/reserve/mint/sign', { id: approvalId, proof: await signPayload(officerA, { id: fetched1.body.approval.id, action: fetched1.body.approval.action }) });
    assert(sign1.status === 200 && sign1.body.approval.status === 'pending', '1st signature should leave it pending: ' + JSON.stringify(sign1.body));

    const fetched2 = await get('/atlas/demo/reserve/mint?id=' + encodeURIComponent(approvalId));
    const sign2 = await post('/atlas/demo/reserve/mint/sign', { id: approvalId, proof: await signPayload(officerB, { id: fetched2.body.approval.id, action: fetched2.body.approval.action }) });
    assert(sign2.status === 200 && sign2.body.approval.status === 'executed', 'expected executed after 2 of 3: ' + JSON.stringify(sign2.body));
    assert(sign2.body.approval.executedCredential, 'expected the full minted credential in the response, not just an id');
    let treasuryReserve = sign2.body.approval.executedCredential;
    assert(treasuryReserve.quantity === 100000 && treasuryReserve.asset.class === 'atlas.currency.reserve', 'unexpected mint result');
    console.log('PASS: committee minted', treasuryReserve.quantity, 'Reserve Credits to the treasury');

    console.log('STEP 2: wholesale issuance — treasury splits reserves to both banks');
    const bankAlpha = await genIdentity(), bankBeta = await genIdentity();
    const t1 = await splitAsset(treasuryReserve, 40000, bankAlpha.publicKey);
    assert(t1.status === 200, 'split to Bank Alpha failed: ' + JSON.stringify(t1.body));
    let bankAlphaReserve = t1.body.sent;
    treasuryReserve = t1.body.remainder;
    const t2 = await splitAsset(treasuryReserve, 40000, bankBeta.publicKey);
    assert(t2.status === 200, 'split to Bank Beta failed: ' + JSON.stringify(t2.body));
    let bankBetaReserve = t2.body.sent;
    assert(bankAlphaReserve.quantity === 40000 && bankBetaReserve.quantity === 40000, 'unexpected split amounts');
    console.log('PASS: both banks hold 40000 reserves each');

    const badTransferPayload = { credentialId: bankAlphaReserve.id, recipientPublicKey: bankBeta.publicKey, action: 'transfer' };
    const badTransfer = await post('/atlas/asset/transfer', { credential: bankAlphaReserve, recipientPublicKey: bankBeta.publicKey, intent: { payload: badTransferPayload, proof: await signPayload(bankAlpha, badTransferPayload) } });
    assert(badTransfer.status === 400, 'expected /atlas/asset/transfer to reject a fungible currency');
    console.log('PASS: confirmed /atlas/asset/transfer correctly refuses a fungible currency');

    console.log('STEP 3: each bank converts reserves into its own retail currency');
    const c1 = await purchaseAsset(bankAlpha, bankAlphaReserve, 'atlas.currency.alpha', 20000);
    assert(c1.status === 200, 'Bank Alpha conversion failed: ' + JSON.stringify(c1.body));
    bankAlphaReserve = c1.body.balance;
    let bankAlphaAlpha = c1.body.purchased;
    const c2 = await purchaseAsset(bankBeta, bankBetaReserve, 'atlas.currency.beta', 20000);
    assert(c2.status === 200, 'Bank Beta conversion failed: ' + JSON.stringify(c2.body));
    bankBetaReserve = c2.body.balance;
    let bankBetaBeta = c2.body.purchased;
    assert(bankAlphaAlpha.quantity === 20000 && bankBetaBeta.quantity === 20000, 'unexpected purchase amounts');
    console.log('PASS: both banks now hold 20000 units of their own retail currency');

    console.log('STEP 4: banks credit customers, then a customer pays a customer');
    const alice = await genIdentity(), bob = await genIdentity(), charlie = await genIdentity();
    const s1 = await splitAsset(bankAlphaAlpha, 5000, alice.publicKey);
    assert(s1.status === 200, 'credit Alice failed: ' + JSON.stringify(s1.body));
    let aliceAlpha = s1.body.sent;
    bankAlphaAlpha = s1.body.remainder;
    const s2 = await splitAsset(bankBetaBeta, 5000, bob.publicKey);
    assert(s2.status === 200, 'credit Bob failed: ' + JSON.stringify(s2.body));
    let bobBeta = s2.body.sent;
    bankBetaBeta = s2.body.remainder;
    const s3 = await splitAsset(aliceAlpha, 1200, charlie.publicKey);
    assert(s3.status === 200, 'Alice -> Charlie payment failed: ' + JSON.stringify(s3.body));
    const charlieAlpha = s3.body.sent;
    aliceAlpha = s3.body.remainder;
    assert(charlieAlpha.quantity === 1200 && aliceAlpha.quantity === 3800, 'unexpected same-bank payment amounts');
    console.log('PASS: Alice holds', aliceAlpha.quantity, ', Charlie holds', charlieAlpha.quantity, ', Bob holds', bobBeta.quantity);

    console.log('STEP 5: Alice (Alpha Dollars) and Bob (Beta Dollars) settle a cross-currency trade');
    const aliceMembership = await issueAsset(alice.publicKey, 'atlas.tradingstation.membership');
    const bobMembership = await issueAsset(bob.publicKey, 'atlas.tradingstation.membership');
    const bobPayload = { offer: { class: 'atlas.currency.beta', quantity: 300 }, want: { class: 'atlas.currency.alpha', quantity: 300 }, from: { publicKey: bob.publicKey }, expiresAt: new Date(Date.now() + 600000).toISOString() };
    const submitRes = await post('/atlas/trade/submit', { membership: bobMembership, intent: { payload: bobPayload, proof: await signPayload(bob, bobPayload) }, balance: bobBeta });
    assert(submitRes.status === 200, 'trade submit failed: ' + JSON.stringify(submitRes.body));
    const alicePayload = { offer: { class: 'atlas.currency.alpha', quantity: 300 }, want: { class: 'atlas.currency.beta', quantity: 300 }, from: { publicKey: alice.publicKey }, counterparty: bob.publicKey, expiresAt: new Date(Date.now() + 600000).toISOString() };
    const claimRes = await post('/atlas/trade/claim', { pendingId: submitRes.body.pendingId, membership: aliceMembership, intent: { payload: alicePayload, proof: await signPayload(alice, alicePayload) }, balance: aliceAlpha });
    assert(claimRes.status === 200 && claimRes.body.status === 'settled', 'trade claim failed: ' + JSON.stringify(claimRes.body));
    assert(claimRes.body.received.asset.class === 'atlas.currency.beta' && claimRes.body.received.quantity === 300, 'unexpected settlement result');
    console.log('PASS: cross-currency settlement succeeded — Alice now also holds 300 Beta Dollars');

    console.log('STEP 6: an independent reviewer attests to Bank Alpha\'s reserve backing');
    const attestRes = await post('/atlas/demo/attestation/issue', { subjectAssetId: bankAlphaReserve.id, subjectIssuerDomain: 'localhost:' + PORT, claim: 'reserves-verified' });
    assert(attestRes.status === 200, 'attestation failed: ' + JSON.stringify(attestRes.body));
    console.log('PASS: attestation issued —', attestRes.body.attestation.claim);

    console.log('STEP 7: a fraudulent split, then suspend + clawback recover it');
    const fraudster = await genIdentity();
    const fraudRes = await splitAsset(bankBetaBeta, 15000, fraudster.publicKey);
    assert(fraudRes.status === 200, 'fraud split failed: ' + JSON.stringify(fraudRes.body));
    const stolen = fraudRes.body.sent;
    const suspendRes = await post('/atlas/demo/clawback/suspend', { credential: stolen });
    assert(suspendRes.status === 200, 'suspend failed: ' + JSON.stringify(suspendRes.body));
    const clawRes = await post('/atlas/demo/clawback/clawback', { credential: stolen, toPublicKey: bankBeta.publicKey });
    assert(clawRes.status === 200, 'clawback failed: ' + JSON.stringify(clawRes.body));
    assert(clawRes.body.newCredential.quantity === 15000 && clawRes.body.newCredential.owner.publicKey === bankBeta.publicKey, 'unexpected clawback result');
    const revDoc = await fetch(BASE + '/.well-known/atlas-revocations.json').then((r) => r.json());
    assert((revDoc.revoked || []).some((r) => r.id === stolen.id), 'expected the stolen credential to be in the public revocation list');
    console.log('PASS: stolen balance suspended, clawed back to Bank Beta, and independently confirmed revoked');

    console.log('\nALL SEVEN ACTS PASSED against a real issuer-php instance.');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    serverProc.kill();
    cleanGeneratedFiles();
  }
})();
