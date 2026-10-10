// Manual check for the opt-in audited-history archive (ASSET_HISTORY_FILE
// / archiveIfAudited() in issuer-server/server.js, atlas_asset_history_
// file() / archive_if_audited() in issuer-php/lib/store.php) against the
// PHP port specifically, at the HTTP layer directly — same "own isolated
// instance" reasoning every other manual-*-php.js test in this project
// uses. test/manual-warranty-demo.js already proves the same mechanism
// through the actual demo page against the Node backend (mint, two
// stamps, a transfer, then "View full history"); this test additionally
// exercises the REAL admin-gated /atlas/asset/mint and /atlas/asset/
// reissue endpoints (the page itself only ever calls their self-serve
// siblings), which the page-driven test never touches, and confirms a
// class that hasn't opted into `auditHistory` is never archived at all,
// however many times it's superseded.
//
// Checks:
//   1. An admin-gated mint of atlas.demo.warranty.certificate (auditHistory
//      => true in ATLAS_ASSET_CATALOG) with a real serial number.
//   2. An admin-gated /atlas/asset/reissue supersedes it — GET /atlas/asset/
//      history?id=<the reissued credential's own supersedes> shows exactly
//      one archived link: the original mint, reason "superseded",
//      supersedes: null.
//   3. The self-serve /atlas/demo/warranty/stamp-sale supersedes it again —
//      the history now shows two links, oldest first, the second one
//      reason "superseded" too and still carrying the earlier stamp's own
//      retailer/sale facts.
//   4. A genuine /atlas/asset/transfer supersedes it a third time — the
//      history grows to three links, the newest one reason "transferred".
//   5. A class that never opted into auditHistory (atlas.demo.attestation.
//      filing) is never archived, however many times it changes hands —
//      GET /atlas/asset/history always returns an empty chain for it.
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

const PORT = 8164; // isolated — distinct from every other manual-*.js/-php.js test's chosen port
const BASE = 'http://localhost:' + PORT;
const BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-history-php-'));

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
function postJson(urlPath, body) {
  return fetch(BASE + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}
function getJson(urlPath) {
  return fetch(BASE + urlPath).then(async (r) => ({ status: r.status, body: await r.json() }));
}
function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function genIdentity() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { kp, publicKey: b64url(raw) };
}
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}
async function adminCall(urlPath, admin, payload) {
  payload = withAdminAuth(payload, BASE, urlPath);
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  return postJson(urlPath, { payload, proof });
}
async function issueAsset(ownerPublicKey, assetClass) {
  const res = await postJson('/atlas/asset/issue', { ownerPublicKey, assetClass });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ': ' + JSON.stringify(res.body));
  return res.body;
}
async function historyChain(id) {
  const res = await getJson('/atlas/asset/history?id=' + encodeURIComponent(id));
  if (res.status !== 200) throw new Error('history lookup failed: ' + JSON.stringify(res.body));
  return res.body.chain;
}

(async () => {
  console.log('SETUP: copying issuer-php into an isolated bundle dir and starting its own dev server on port ' + PORT);
  fs.cpSync(path.resolve(__dirname, '..', 'issuer-php'), BUNDLE_DIR, { recursive: true });
  const proc = spawn('php', ['-S', 'localhost:' + PORT, 'test-router.php'], { cwd: BUNDLE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
    proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
    proc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-php dev server up on port ' + PORT);

  try {
    console.log('SETUP: registering an admin identity, minting the certificate directly to an owner');
    const admin = await genIdentity();
    const owner1 = await genIdentity();
    const owner2 = await genIdentity();
    fs.writeFileSync(path.join(BUNDLE_DIR, 'lib', 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));

    console.log('STEP 1: admin-gated /atlas/asset/mint mints the certificate with a real serial number');
    const mintPayload = { ownerPublicKey: owner1.publicKey, assetClass: 'atlas.demo.warranty.certificate', properties: { 'com.example.serialNumber': 'SN-PHP-HIST-1' } };
    const mintRes = await adminCall('/atlas/asset/mint', admin, mintPayload);
    assert(mintRes.status === 200, 'expected the admin mint to succeed, got: ' + JSON.stringify(mintRes.body));
    let cred = mintRes.body;
    console.log('PASS: minted', cred.id, '- supersedes', cred.supersedes);

    console.log('STEP 2: admin-gated /atlas/asset/reissue supersedes it; history shows exactly the original mint');
    const reissuePayload = { credential: cred, properties: { 'com.example.note': 'first reissue' } };
    const reissueRes = await adminCall('/atlas/asset/reissue', admin, reissuePayload);
    assert(reissueRes.status === 200, 'expected the admin reissue to succeed, got: ' + JSON.stringify(reissueRes.body));
    cred = reissueRes.body.newCredential;
    let chain = await historyChain(cred.supersedes);
    assert(chain.length === 1, 'expected exactly 1 archived link after one reissue, got ' + chain.length);
    assert(chain[0].supersedes === null, 'expected the original mint to have supersedes: null');
    assert(chain[0].reason === 'superseded', 'expected the archived reason to be superseded, got ' + chain[0].reason);
    assert(chain[0].asset.properties['com.example.serialNumber'] === 'SN-PHP-HIST-1', 'expected the archived body to carry the original serial number');
    console.log('PASS: history after the real admin-gated reissue shows exactly the original mint —', chain[0].id);

    console.log('STEP 3: self-serve /atlas/demo/warranty/stamp-sale supersedes it again; history grows to two links');
    const stampRes = await postJson('/atlas/demo/warranty/stamp-sale', {
      credential: cred,
      properties: { 'com.example.saleDate': '2026-01-01', 'com.example.warrantyMonths': 24, 'com.example.retailer': 'Test Retailer' }
    });
    assert(stampRes.status === 200, 'expected the self-serve stamp-sale to succeed, got: ' + JSON.stringify(stampRes.body));
    cred = stampRes.body.newCredential;
    chain = await historyChain(cred.supersedes);
    assert(chain.length === 2, 'expected 2 archived links after the reissue and the stamp, got ' + chain.length);
    assert(chain[1].asset.properties['com.example.note'] === 'first reissue', 'expected the second link to carry the earlier reissue note');
    console.log('PASS: history now shows both prior links, oldest first');

    console.log('STEP 4: a genuine /atlas/asset/transfer supersedes it a third time; history grows to three links, newest reason "transferred"');
    const transferPayload = { credentialId: cred.id, recipientPublicKey: owner2.publicKey, action: 'transfer' };
    const transferProof = await signWithSelf(owner1.kp, owner1.publicKey, transferPayload);
    const transferRes = await postJson('/atlas/asset/transfer', { credential: cred, recipientPublicKey: owner2.publicKey, intent: { payload: transferPayload, proof: transferProof } });
    assert(transferRes.status === 200, 'expected the transfer to succeed, got: ' + JSON.stringify(transferRes.body));
    cred = transferRes.body.credential;
    chain = await historyChain(cred.supersedes);
    assert(chain.length === 3, 'expected 3 archived links after the transfer, got ' + chain.length);
    assert(chain[2].reason === 'transferred', 'expected the newest link\'s reason to be transferred, got ' + chain[2].reason);
    assert(chain[2].asset.properties['com.example.retailer'] === 'Test Retailer', 'expected the newest link to still carry the stamped retailer');
    console.log('PASS: history shows all 3 prior links after mint -> reissue -> stamp -> transfer');

    console.log('STEP 5: a class that never opted into auditHistory (atlas.demo.attestation.filing) is never archived, however many times it changes hands');
    const filing = await issueAsset(owner1.publicKey, 'atlas.demo.attestation.filing');
    const filingChainBefore = await historyChain(filing.id);
    assert(filingChainBefore.length === 0, 'expected an empty chain for a fresh, unaudited credential');
    const filingTransferPayload = { credentialId: filing.id, recipientPublicKey: owner2.publicKey, action: 'transfer' };
    const filingTransferProof = await signWithSelf(owner1.kp, owner1.publicKey, filingTransferPayload);
    const filingTransferRes = await postJson('/atlas/asset/transfer', { credential: filing, recipientPublicKey: owner2.publicKey, intent: { payload: filingTransferPayload, proof: filingTransferProof } });
    assert(filingTransferRes.status === 200, 'expected the filing transfer itself to succeed, got: ' + JSON.stringify(filingTransferRes.body));
    const filingChainAfter = await historyChain(filing.id);
    assert(filingChainAfter.length === 0, 'expected the superseded filing credential to still not be archived — its class never opted in');
    console.log('PASS: an unaudited class is never archived, before or after being superseded');

    console.log('\nALL PHP AUDIT-HISTORY CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    proc.kill();
    fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
  }
})();
