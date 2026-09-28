// Manual check for demo-domain-a/warranty-demo.html — the factory-to-
// retailer-to-owner warranty chain. test/manual-asset-mint.js already
// covers the new POST /atlas/asset/mint endpoint's own protocol behavior
// at the HTTP layer; this test is what the PAGE does with it, plus the
// existing (already-tested elsewhere) reissue and transfer endpoints it
// leans on for the retailer-stamp and ownership-change steps. Drives the
// real page with a headless browser, same "own isolated instance"
// reasoning every other manual-*.js test in this project uses. Admin
// actions (mint, reissue) are performed directly over HTTP here, standing
// in for a person actually using the Admin Panel in another tab, exactly
// as the page's own instructions describe.
//
// Checks:
//   1. The page generates and displays a public key on load.
//   2. Importing a certificate minted to a DIFFERENT public key is
//      rejected with a clear reason, and nothing renders.
//   3. Importing a genuinely minted certificate (with a serial number
//      property) renders a card showing that serial and "not started yet".
//   4. Importing a retailer-reissued version (sale date + warranty length
//      stamped) flips the card to "Active until ... remaining".
//   5. A further reissue with an already-lapsed sale window flips the same
//      card to "Expired ... ago" — pure date arithmetic, no real waiting.
//   6. "Transfer to a new owner" performs a genuine POST
//      /atlas/asset/transfer and the resulting card shows a new owner
//      while keeping the exact same serial number and warranty status.
//   7. "Try verifying this one independently" on the transferred
//      certificate reports it valid.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const NODE_PORT = 8142; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://localhost:' + NODE_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-warranty-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-warranty-docroot-'));

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
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
function postJson(base, urlPath, body) {
  return fetch(base + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}
async function adminMint(base, admin, mintPayload) {
  const proof = await signWithSelf(admin.kp, admin.publicKey, mintPayload);
  const res = await postJson(base, '/atlas/asset/mint', { payload: mintPayload, proof });
  if (res.status !== 200) throw new Error('admin mint failed: ' + JSON.stringify(res.body));
  return res.body;
}
async function adminReissue(base, admin, reissuePayload) {
  const proof = await signWithSelf(admin.kp, admin.publicKey, reissuePayload);
  const res = await postJson(base, '/atlas/asset/reissue', { payload: reissuePayload, proof });
  if (res.status !== 200) throw new Error('admin reissue failed: ' + JSON.stringify(res.body));
  return res.body.newCredential;
}
function isoDateDaysAgo(days) {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

(async () => {
  console.log('SETUP: copying demo-domain-a into an isolated docroot and starting its own issuer-server instance on port ' + NODE_PORT);
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-a'), NODE_DOCROOT_DIR, { recursive: true });
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
  console.log('PASS: isolated issuer-server up on port ' + NODE_PORT + ', serving the isolated demo-domain-a copy');

  console.log('SETUP: registering an admin key (stands in for the real admin panel)');
  const admin = await genIdentity();
  fs.writeFileSync(path.join(NODE_STATE_DIR, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));

  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' });
    const page = await browser.newPage();
    await page.goto(NODE_BASE + '/warranty-demo.html', { waitUntil: 'load' });

    console.log('STEP 1: the page generates and displays a public key on load');
    await page.waitForFunction(() => (document.getElementById('yourPublicKey').textContent || '').length > 0, { timeout: 10000 });
    const yourPublicKey = await page.locator('#yourPublicKey').textContent();
    assert(yourPublicKey.length > 20, 'expected a real-looking public key, got: ' + yourPublicKey);
    console.log('PASS: page identity generated —', yourPublicKey.slice(0, 24) + '…');

    console.log('STEP 2: importing a certificate minted to a DIFFERENT public key is rejected');
    const someoneElse = await genIdentity();
    const wrongOwnerCert = await adminMint(NODE_BASE, admin, { ownerPublicKey: someoneElse.publicKey, assetClass: 'atlas.demo.warranty.certificate', properties: { 'com.example.serialNumber': 'SN-WRONG' } });
    await page.locator('#mintImport').fill(JSON.stringify(wrongOwnerCert));
    await page.locator('#mintImportBtn').click();
    assert((await page.locator('#mintImportResult').textContent()).includes("wasn't minted to your public key"), 'expected a clear ownership-mismatch rejection');
    assert(!(await page.locator('#cardPanel').isVisible()), 'expected no card to render for a mismatched-owner import');
    console.log('PASS: a certificate minted to someone else is rejected, nothing renders');

    console.log('STEP 3: importing a genuinely minted certificate renders the serial number and "not started yet"');
    const minted = await adminMint(NODE_BASE, admin, { ownerPublicKey: yourPublicKey, assetClass: 'atlas.demo.warranty.certificate', properties: { 'com.example.serialNumber': 'SN-0001' } });
    await page.locator('#mintImport').fill(JSON.stringify(minted));
    await page.locator('#mintImportBtn').click();
    await page.waitForFunction(() => document.getElementById('cardPanel').style.display !== 'none', { timeout: 10000 });
    const cardTextAfterMint = await page.locator('#certificateCard').textContent();
    assert(cardTextAfterMint.includes('SN-0001'), 'expected the serial number to show on the card, got: ' + cardTextAfterMint);
    assert(cardTextAfterMint.includes('Not started yet'), 'expected a "not started" warranty status before any sale is stamped, got: ' + cardTextAfterMint);
    assert(cardTextAfterMint.includes('(you)'), 'expected the card to show the certificate as currently owned by you');
    console.log('PASS: minted certificate imported and rendered correctly —', minted.id);

    console.log('STEP 4: a retailer reissue stamping a recent sale flips the card to Active');
    const activeReissued = await adminReissue(NODE_BASE, admin, {
      credential: minted,
      properties: { 'com.example.saleDate': isoDateDaysAgo(30), 'com.example.warrantyMonths': 24, 'com.example.retailer': 'Example Retailer' }
    });
    await page.locator('#reissueImport').fill(JSON.stringify(activeReissued));
    await page.locator('#reissueImportBtn').click();
    await page.waitForFunction(() => (document.getElementById('certificateCard').textContent || '').includes('Active until'), { timeout: 10000 });
    const activeCardText = await page.locator('#certificateCard').textContent();
    assert(activeCardText.includes('Example Retailer'), 'expected the retailer name to show on the card, got: ' + activeCardText);
    assert(activeCardText.includes('SN-0001'), 'expected the same serial number to survive the reissue');
    console.log('PASS: sale stamped, warranty shows Active with the retailer name —', activeCardText.match(/Active until \S+ \(\d+ days remaining\)/)[0]);

    console.log('STEP 5: a further reissue with an already-lapsed sale window flips the card to Expired');
    const expiredReissued = await adminReissue(NODE_BASE, admin, {
      credential: activeReissued,
      properties: { 'com.example.saleDate': isoDateDaysAgo(800), 'com.example.warrantyMonths': 12 }
    });
    await page.locator('#reissueImport').fill(JSON.stringify(expiredReissued));
    await page.locator('#reissueImportBtn').click();
    await page.waitForFunction(() => (document.getElementById('certificateCard').textContent || '').includes('Expired'), { timeout: 10000 });
    console.log('PASS: an already-lapsed sale window shows Expired, computed instantly with no real waiting');

    console.log('STEP 6: "Transfer to a new owner" performs a genuine transfer, keeping the serial and warranty status');
    await page.locator('#transferBtn').click();
    await page.waitForFunction(() => (document.getElementById('transferResult').textContent || '').startsWith('Transferred'), { timeout: 10000 });
    const afterTransferText = await page.locator('#certificateCard').textContent();
    assert(afterTransferText.includes('SN-0001'), 'expected the serial number to survive the transfer, got: ' + afterTransferText);
    assert(afterTransferText.includes('Expired'), 'expected the warranty status to survive the transfer unchanged, got: ' + afterTransferText);
    assert(!afterTransferText.includes('(you)'), 'expected the card to no longer show "(you)" once ownership moved to the newly generated owner');
    console.log('PASS: ownership transferred for real, serial and warranty status both carried over unchanged');

    console.log('STEP 7: "Try verifying this one independently" reports the transferred certificate valid');
    await page.locator('#certificateCard details.raw summary').click();
    await page.locator('#certificateCard .fillVerifyBtn').click();
    await page.waitForFunction(() => (document.getElementById('verifyResult').textContent || '').startsWith('✓ Valid'), { timeout: 10000 });
    console.log('PASS: independently verified as valid —', await page.locator('#verifyResult').textContent());

    console.log('\nALL WARRANTY DEMO CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    nodeProc.kill();
    try { fs.rmSync(NODE_STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(NODE_DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
