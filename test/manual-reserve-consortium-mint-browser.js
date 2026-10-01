// Browser-level check for reserve-bank-demo.html's Act 8 (domain-quorum
// reserve mint) and the new "Consortium mint co-signing" section on the
// shared admin panel (issuer-server/admin-panel/index.html, identical to
// issuer-php/atlas-admin/index.html) — the actual UI Bruno will click
// through, not just the HTTP shapes test/manual-reserve-consortium-mint.js
// and -php.js already prove.
//
// Two isolated Node issuer-server instances (domain A, the requesting
// domain, serving a real copy of demo-domain-a so reserve-bank-demo.html
// is actually there; domain B, a sibling approver, serving an empty
// docroot since it only ever needs its own built-in /atlas-admin/, which
// issuer-server always serves from its own admin-panel/ directory
// regardless of docroot — see server.js's ADMIN_PANEL_DIR).
//
// Logging into each domain's admin panel skips the wallet-extension
// handoff manual-admin-panel.js already proves elsewhere (that handoff is
// tangential plumbing this feature doesn't touch) and instead seeds
// sessionStorage directly with a REAL token obtained from a REAL
// nonce/sign/start round trip against each server — the same mechanism
// the extension's own handoff produces, just without driving the button
// click itself.
//
// Checks:
//   1. On A's reserve-bank-demo.html, creating the pending request (Act 8)
//      shows the approve panel with the request id and 0-of-2 progress.
//   2. On B's own admin panel, "Fetch pending request" shows the real
//      pending action (amount, approver domains) fetched from A, and
//      "Co-sign & relay" succeeds — the request is now 1 of 2.
//   3. Back on A's reserve-bank-demo.html, "Refresh status" reflects B's
//      signature and shows what's still waited on.
//   4. On A's own admin panel, co-signing as A reaches the 2-of-2
//      threshold and reports the mint executed.
//   5. Back on A's reserve-bank-demo.html, "Refresh status" shows
//      "Executed" with a real minted credential's raw JSON.
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

const REPO = path.resolve(__dirname, '..');
const A_PORT = 8197; // isolated — distinct from every other manual-*.js test's chosen port
const B_PORT = 8198;
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

// Pre-seeds sessionStorage with a real token before any page script runs —
// the admin panel reads this back out on load (see its own top comment).
async function loginAsAdminInBrowser(page, token) {
  await page.addInitScript((t) => {
    try { sessionStorage.setItem('atlasAdminSession', JSON.stringify({ token: t, expiresAt: null })); } catch (err) {}
  }, token);
}

(async () => {
  const aState = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-consortium-ui-a-'));
  const aDocroot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-consortium-ui-a-doc-'));
  const bState = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-consortium-ui-b-'));
  const bDocroot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-consortium-ui-b-doc-'));
  fs.cpSync(path.resolve(REPO, 'demo-domain-a'), aDocroot, { recursive: true });

  console.log('SETUP: starting domain A (with demo-domain-a docroot) on', A_PORT, 'and domain B on', B_PORT);
  const aProc = await startServer(A_PORT, A_DOMAIN, aState, aDocroot);
  const bProc = await startServer(B_PORT, B_DOMAIN, bState, bDocroot);
  console.log('PASS: both domains up');

  let browser;
  try {
    const aAdmin = await genIdentity();
    fs.writeFileSync(path.join(aState, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: aAdmin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
    const aToken = await login(A_BASE, aAdmin);

    const bAdmin = await genIdentity();
    fs.writeFileSync(path.join(bState, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: bAdmin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
    const bToken = await login(B_BASE, bAdmin);
    console.log('PASS: both domains have a real admin session token');

    browser = await chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' });

    const demoPage = await browser.newPage();
    await demoPage.goto(A_BASE + '/reserve-bank-demo.html', { waitUntil: 'load' });

    console.log('STEP 1: on A\'s reserve-bank-demo.html, creating the pending request shows the approve panel with 0-of-2 progress');
    await demoPage.locator('#siblingDomainInput').fill(B_DOMAIN);
    await demoPage.locator('#consortiumAmountInput').fill('20000');
    await demoPage.locator('#requestConsortiumMintBtn').click();
    await demoPage.waitForFunction(() => document.getElementById('consortiumApprovePanel').style.display !== 'none', { timeout: 10000 });
    const requestId = await demoPage.locator('#consortiumRequestIdDisplay').inputValue();
    assert(requestId.startsWith('urn:atlas:reserve-mint-consortium:'), 'expected a real request id, got: ' + requestId);
    const progressAfterCreate = await demoPage.locator('#consortiumProgressText').textContent();
    assert(progressAfterCreate.includes('0 of 2'), 'expected "0 of 2" right after creating, got: ' + progressAfterCreate);
    console.log('PASS: request created —', requestId);

    console.log('STEP 2: on B\'s own admin panel, fetch previews the real pending action, then co-sign succeeds (1 of 2)');
    const bAdminPage = await browser.newPage();
    await loginAsAdminInBrowser(bAdminPage, bToken);
    await bAdminPage.goto(B_BASE + '/atlas-admin/', { waitUntil: 'load' });
    await bAdminPage.waitForFunction(() => document.getElementById('hidden-while-logged-out').style.display !== 'none', { timeout: 10000 });
    await bAdminPage.locator('#consortiumRequestingDomain').fill(A_DOMAIN);
    await bAdminPage.locator('#consortiumRequestId').fill(requestId);
    await bAdminPage.locator('#consortiumFetchBtn').click();
    await bAdminPage.waitForFunction(() => (document.getElementById('consortiumPreview').textContent || '').includes('Mint'), { timeout: 10000 });
    const previewText = await bAdminPage.locator('#consortiumPreview').textContent();
    assert(previewText.includes('20000'), 'expected the preview to show the real pending amount (20000), got: ' + previewText);
    await bAdminPage.evaluate(() => { document.getElementById('consortiumResult').textContent = ''; });
    await bAdminPage.locator('#consortiumCoSignBtn').click();
    await bAdminPage.waitForFunction(() => (document.getElementById('consortiumResult').textContent || '').length > 0, { timeout: 10000 });
    const bCoSignResult = await bAdminPage.locator('#consortiumResult').textContent();
    assert(/relayed|executed/.test(bCoSignResult), 'expected B\'s co-sign to report success, got: ' + bCoSignResult);
    console.log('PASS: B co-signed via its own admin panel —', bCoSignResult);

    console.log('STEP 3: back on A\'s reserve-bank-demo.html, refreshing shows B\'s signature and what\'s still waited on');
    await demoPage.locator('#refreshConsortiumBtn').click();
    await demoPage.waitForFunction(() => (document.getElementById('consortiumApproveStatus').textContent || '').includes('Waiting'), { timeout: 10000 });
    const waitingText = await demoPage.locator('#consortiumApproveStatus').textContent();
    assert(waitingText.includes(A_DOMAIN), 'expected the status to say it\'s still waiting on A, got: ' + waitingText);
    const progressAfterB = await demoPage.locator('#consortiumProgressText').textContent();
    assert(progressAfterB.includes('1 of 2'), 'expected "1 of 2" after B signed, got: ' + progressAfterB);
    console.log('PASS: reflects 1 of 2, waiting on A');

    console.log('STEP 4: on A\'s own admin panel, co-signing as A reaches 2-of-2 and the mint executes');
    const aAdminPage = await browser.newPage();
    await loginAsAdminInBrowser(aAdminPage, aToken);
    await aAdminPage.goto(A_BASE + '/atlas-admin/', { waitUntil: 'load' });
    await aAdminPage.waitForFunction(() => document.getElementById('hidden-while-logged-out').style.display !== 'none', { timeout: 10000 });
    await aAdminPage.locator('#consortiumRequestingDomain').fill(A_DOMAIN);
    await aAdminPage.locator('#consortiumRequestId').fill(requestId);
    await aAdminPage.locator('#consortiumCoSignBtn').click();
    await aAdminPage.waitForFunction(() => (document.getElementById('consortiumResult').textContent || '').length > 0, { timeout: 10000 });
    const aCoSignResult = await aAdminPage.locator('#consortiumResult').textContent();
    assert(/executed/.test(aCoSignResult), 'expected A\'s co-sign to report the mint executed, got: ' + aCoSignResult);
    console.log('PASS: A co-signed, threshold reached —', aCoSignResult);

    console.log('STEP 5: back on A\'s reserve-bank-demo.html, refreshing shows Executed with a real minted credential');
    await demoPage.locator('#refreshConsortiumBtn').click();
    await demoPage.waitForFunction(() => (document.getElementById('consortiumApproveStatus').textContent || '').includes('minted'), { timeout: 10000 });
    const executedText = await demoPage.locator('#consortiumApproveStatus').textContent();
    assert(executedText.includes('20000'), 'expected the executed message to show the real minted quantity, got: ' + executedText);
    const rawCredentialText = await demoPage.locator('#consortiumApproveStatus details.raw pre').textContent();
    const rawCredential = JSON.parse(rawCredentialText);
    assert(rawCredential.quantity === 20000 && rawCredential.id.startsWith('urn:atlas:asset:'), 'expected a real raw credential, got: ' + rawCredentialText);
    console.log('PASS: executed, with a real raw credential —', rawCredential.id);

    console.log('\nALL BROWSER CONSORTIUM-MINT CHECKS PASSED');
  } finally {
    if (browser) await browser.close();
    aProc.kill();
    bProc.kill();
  }
})().catch((err) => { console.error(err); process.exit(1); });
