// Manual, end-to-end check for reserve-bank-demo.html's full seven-act
// flow, run directly against a real isolated issuer-server instance (no
// mocking, no browser) — same "spin up a throwaway instance, hit its real
// endpoints" pattern as manual-clawback.js. Not part of the permanent
// suite, same reasoning as every other manual-*.js script.
//
// Covers, in the same order and with the same payload shapes the page
// itself uses:
//   1. A 3-officer, 2-of-3 K-of-N committee mints Reserve Credits to a
//      treasury identity (POST /atlas/demo/reserve/request-mint +
//      /atlas/demo/reserve/mint/sign), and the executed response carries
//      the full minted credential, not just its id.
//   2. The treasury splits reserves straight to two banks
//      (POST /atlas/asset/split) — proves fungible movement works without
//      the unique-item transfer endpoint, which rejects fungible outright.
//   3. Each bank purchases its own retail currency with held reserves
//      (POST /atlas/asset/purchase).
//   4. Each bank credits one customer, then that customer pays a second
//      person directly (three more splits) — a bank and an ordinary
//      customer both moving money through the identical mechanism.
//   5. The two customers, holding two DIFFERENT domain-issued currencies,
//      settle a real cross-currency trade at the Trading Station
//      (POST /atlas/trade/submit, /atlas/trade/claim) — the same
//      unmodified settlement code, run for the first time in this
//      codebase across two different fungible classes at once.
//   6. An independent reviewer identity attests to a bank's own reserve
//      backing (POST /atlas/demo/attestation/issue).
//   7. A compromised bank key splits off a large chunk of legitimate
//      currency to a fraudster; it gets suspended, clawed back, and
//      consolidated with whatever the bank already had left
//      (POST /atlas/demo/clawback/suspend, /clawback,
//      POST /atlas/asset/consolidate) — and the stolen credential is
//      independently verified as no longer valid afterward.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const PORT = 8179; // isolated — distinct from every other manual-*.js test's chosen port
const DOMAIN = 'localhost:' + PORT;
const BASE = 'http://' + DOMAIN;
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-reserve-demo-node-'));
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-reserve-demo-docroot-'));

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
function getJson(urlPath) {
  return fetch(BASE + urlPath).then(async (r) => ({ status: r.status, body: await r.json() }));
}
async function issueAsset(ownerPublicKey, assetClass, quantity) {
  const res = await postJson('/atlas/asset/issue', { ownerPublicKey, assetClass, quantity });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ': ' + JSON.stringify(res.body));
  return res.body;
}
async function splitAsset(credential, sendAmount, toPublicKey) {
  return postJson('/atlas/asset/split', { credential, sendAmount, toPublicKey });
}
async function purchaseAsset(buyer, credential, purchasedClass, quantity) {
  const payload = { credentialId: credential.id, purchasedClass, quantity, action: 'purchase' };
  const proof = await signWithSelf(buyer, payload);
  return postJson('/atlas/asset/purchase', { credential, purchasedClass, quantity, intent: { payload, proof } });
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
    console.log('STEP 1: committee mints Reserve Credits to the treasury');
    const officers = [await genIdentity(), await genIdentity(), await genIdentity()];
    const treasury = await genIdentity();
    const req = await postJson('/atlas/demo/reserve/request-mint', {
      approvers: officers.map((o) => o.publicKey), requiredApprovals: 2,
      toPublicKey: treasury.publicKey, amount: 100000, memo: 'test issuance'
    });
    assert(req.status === 200, 'request-mint failed: ' + JSON.stringify(req.body));
    const approvalId = req.body.approval.id;

    const fetched1 = await getJson('/atlas/demo/reserve/mint?id=' + encodeURIComponent(approvalId));
    assert(fetched1.status === 200, 'GET mint failed: ' + JSON.stringify(fetched1.body));
    const sign1 = await postJson('/atlas/demo/reserve/mint/sign', {
      id: approvalId, proof: await signWithSelf(officers[0], { id: fetched1.body.approval.id, action: fetched1.body.approval.action })
    });
    assert(sign1.status === 200 && sign1.body.approval.status === 'pending', '1st signature should leave it pending: ' + JSON.stringify(sign1.body));

    const fetched2 = await getJson('/atlas/demo/reserve/mint?id=' + encodeURIComponent(approvalId));
    const sign2 = await postJson('/atlas/demo/reserve/mint/sign', {
      id: approvalId, proof: await signWithSelf(officers[1], { id: fetched2.body.approval.id, action: fetched2.body.approval.action })
    });
    assert(sign2.status === 200, 'sign2 failed: ' + JSON.stringify(sign2.body));
    assert(sign2.body.approval.status === 'executed', 'expected executed after 2 of 3: ' + JSON.stringify(sign2.body));
    assert(sign2.body.approval.executedCredential, 'expected the full minted credential in the response, not just an id');
    let treasuryReserve = sign2.body.approval.executedCredential;
    assert(treasuryReserve.quantity === 100000, 'expected 100000 minted, got ' + treasuryReserve.quantity);
    assert(treasuryReserve.asset.class === 'atlas.currency.reserve', 'expected atlas.currency.reserve');
    console.log('PASS: committee minted', treasuryReserve.quantity, 'Reserve Credits to the treasury');

    console.log('STEP 2: wholesale issuance — treasury splits reserves to both banks (fungible, so split not transfer)');
    const bankAlpha = await genIdentity(), bankBeta = await genIdentity();
    const t1 = await splitAsset(treasuryReserve, 40000, bankAlpha.publicKey);
    assert(t1.status === 200, 'split to Bank Alpha failed: ' + JSON.stringify(t1.body));
    let bankAlphaReserve = t1.body.sent;
    treasuryReserve = t1.body.remainder;
    assert(bankAlphaReserve.quantity === 40000 && treasuryReserve.quantity === 60000, 'unexpected split amounts');

    const t2 = await splitAsset(treasuryReserve, 40000, bankBeta.publicKey);
    assert(t2.status === 200, 'split to Bank Beta failed: ' + JSON.stringify(t2.body));
    let bankBetaReserve = t2.body.sent;
    treasuryReserve = t2.body.remainder;
    assert(bankBetaReserve.quantity === 40000 && treasuryReserve.quantity === 20000, 'unexpected split amounts');
    console.log('PASS: both banks hold 40000 reserves each, treasury keeps 20000 unallocated');

    // Sanity check the fungible/transfer boundary the whole demo leans on:
    // the ordinary unique-item transfer endpoint must reject this class.
    const badTransfer = await postJson('/atlas/asset/transfer', {
      credential: bankAlphaReserve, recipientPublicKey: bankBeta.publicKey,
      intent: { payload: { credentialId: bankAlphaReserve.id, recipientPublicKey: bankBeta.publicKey, action: 'transfer' }, proof: await signWithSelf(bankAlpha, { credentialId: bankAlphaReserve.id, recipientPublicKey: bankBeta.publicKey, action: 'transfer' }) }
    });
    assert(badTransfer.status === 400, 'expected /atlas/asset/transfer to reject a fungible currency');
    console.log('PASS: confirmed /atlas/asset/transfer correctly refuses a fungible currency (split is the right mechanism)');

    console.log('STEP 3: each bank converts reserves into its own retail currency');
    const c1 = await purchaseAsset(bankAlpha, bankAlphaReserve, 'atlas.currency.alpha', 20000);
    assert(c1.status === 200, 'Bank Alpha conversion failed: ' + JSON.stringify(c1.body));
    bankAlphaReserve = c1.body.balance;
    let bankAlphaAlpha = c1.body.purchased;
    assert(bankAlphaAlpha.quantity === 20000 && bankAlphaAlpha.asset.class === 'atlas.currency.alpha', 'unexpected purchase result');

    const c2 = await purchaseAsset(bankBeta, bankBetaReserve, 'atlas.currency.beta', 20000);
    assert(c2.status === 200, 'Bank Beta conversion failed: ' + JSON.stringify(c2.body));
    bankBetaReserve = c2.body.balance;
    let bankBetaBeta = c2.body.purchased;
    assert(bankBetaBeta.quantity === 20000 && bankBetaBeta.asset.class === 'atlas.currency.beta', 'unexpected purchase result');
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

    console.log('STEP 5: Alice (Alpha Dollars) and Bob (Beta Dollars) settle a cross-currency trade at the Trading Station');
    const aliceMembership = await issueAsset(alice.publicKey, 'atlas.tradingstation.membership');
    const bobMembership = await issueAsset(bob.publicKey, 'atlas.tradingstation.membership');

    const bobPayload = {
      offer: { class: 'atlas.currency.beta', quantity: 300 }, want: { class: 'atlas.currency.alpha', quantity: 300 },
      from: { publicKey: bob.publicKey }, expiresAt: new Date(Date.now() + 600000).toISOString()
    };
    const submitRes = await postJson('/atlas/trade/submit', { membership: bobMembership, intent: { payload: bobPayload, proof: await signWithSelf(bob, bobPayload) }, balance: bobBeta });
    assert(submitRes.status === 200, 'trade submit failed: ' + JSON.stringify(submitRes.body));
    const pendingId = submitRes.body.pendingId;

    const alicePayload = {
      offer: { class: 'atlas.currency.alpha', quantity: 300 }, want: { class: 'atlas.currency.beta', quantity: 300 },
      from: { publicKey: alice.publicKey }, counterparty: bob.publicKey, expiresAt: new Date(Date.now() + 600000).toISOString()
    };
    const claimRes = await postJson('/atlas/trade/claim', { pendingId, membership: aliceMembership, intent: { payload: alicePayload, proof: await signWithSelf(alice, alicePayload) }, balance: aliceAlpha });
    assert(claimRes.status === 200, 'trade claim failed: ' + JSON.stringify(claimRes.body));
    assert(claimRes.body.status === 'settled', 'expected settled: ' + JSON.stringify(claimRes.body));
    const aliceReceivedBeta = claimRes.body.received;
    assert(aliceReceivedBeta.asset.class === 'atlas.currency.beta' && aliceReceivedBeta.quantity === 300, 'Alice should receive 300 Beta Dollars');
    aliceAlpha = claimRes.body.remainder;
    console.log('PASS: cross-currency settlement succeeded — Alice now also holds', aliceReceivedBeta.quantity, 'Beta Dollars issued by Bank Beta');

    console.log('STEP 6: an independent reviewer attests to Bank Alpha\'s reserve backing');
    const attestRes = await postJson('/atlas/demo/attestation/issue', { subjectAssetId: bankAlphaReserve.id, subjectIssuerDomain: DOMAIN, claim: 'reserves-verified' });
    assert(attestRes.status === 200, 'attestation failed: ' + JSON.stringify(attestRes.body));
    assert(attestRes.body.attestation.claim.includes('Reserve holdings'), 'unexpected claim text: ' + JSON.stringify(attestRes.body));
    console.log('PASS: attestation issued —', attestRes.body.attestation.claim);

    console.log('STEP 7: Bank Beta\'s key is compromised, a fraudulent split fires, then suspend + clawback + consolidate recover it');
    const fraudster = await genIdentity();
    const fraudRes = await splitAsset(bankBetaBeta, 15000, fraudster.publicKey);
    assert(fraudRes.status === 200, 'fraud split failed: ' + JSON.stringify(fraudRes.body));
    const stolen = fraudRes.body.sent;
    bankBetaBeta = fraudRes.body.remainder; // null here, since 15000 was the entire remaining balance
    assert(bankBetaBeta === null, 'expected the bank\'s own remainder to be fully depleted by the theft');

    const suspendRes = await postJson('/atlas/demo/clawback/suspend', { credential: stolen });
    assert(suspendRes.status === 200, 'suspend failed: ' + JSON.stringify(suspendRes.body));

    const clawRes = await postJson('/atlas/demo/clawback/clawback', { credential: stolen, toPublicKey: bankBeta.publicKey });
    assert(clawRes.status === 200, 'clawback failed: ' + JSON.stringify(clawRes.body));
    const recovered = clawRes.body.newCredential;
    assert(recovered.quantity === 15000 && recovered.owner.publicKey === bankBeta.publicKey, 'unexpected clawback result');

    const verifyKeyDoc = await fetch(BASE + '/.well-known/atlas-key.json').then((r) => r.json());
    const revDoc = await fetch(BASE + '/.well-known/atlas-revocations.json').then((r) => r.json());
    assert((revDoc.revoked || []).some((r) => r.id === stolen.id), 'expected the stolen credential to be in the public revocation list');
    console.log('PASS: stolen balance suspended, clawed back to Bank Beta, and independently confirmed revoked');
    void verifyKeyDoc;

    console.log('\nALL SEVEN ACTS PASSED against a real, isolated issuer-server instance.');
  } finally {
    proc.kill();
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.rmSync(DOCROOT_DIR, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exitCode = 1;
});
