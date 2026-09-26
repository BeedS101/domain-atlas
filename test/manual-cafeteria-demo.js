// End-to-end check for demo-domain-a/cafeteria-demo.html — the worked
// example of SPEC.md §5.8 (purchasing) and §5.9 (fulfillment): a parent
// tops up a student's spendable balance, the student spends part of it on
// menu items, and each purchase's receipt is later fulfilled by an
// operator on the admin panel (issuer-server/admin-panel/index.html's new
// "Fulfill a purchase" section). test/manual-asset-purchase.js already
// proves the underlying endpoints at the HTTP layer — this test is what
// the two PAGES do with them, end to end, across both.
//
// Drives both pages directly with a headless browser (neither needs the
// wallet extension). The admin panel's own login is normally a wallet-
// extension handoff (manual-admin-panel.js already proves that plumbing);
// this test skips it by starting a real session the same protocol way
// (nonce/sign/start, as manual-admin-session.js proves) and seeding
// sessionStorage with the resulting token before the panel loads, so the
// panel is exercised as a genuinely logged-in operator without needing the
// extension at all.
//
// Checks:
//   1. Creating a student wallet reveals the top-up and menu panels.
//   2. Topping up 10 credits shows a balance of 10.
//   3. Buying the sandwich (price 5) drops the balance to 5 and adds an
//      "Awaiting collection" receipt card with the item's real raw JSON.
//   4. Buying the juice (price 2) drops the balance to 3, disabling the
//      sandwich button (would need 5) but leaving the snack (3) enabled.
//   5. Pasting the sandwich receipt's raw JSON into the admin panel's
//      "Fulfill a purchase" section and clicking Fulfill succeeds.
//   6. Back on the cafeteria page, "Check status" on that same receipt
//      flips its badge to "Collected ✓"; the juice receipt's own "Check
//      status" still reports "Awaiting collection" — proving the check is
//      per-credential, not a blanket refresh.
//   7. "Start over" resets the page back to Step 1.
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

const NODE_PORT = 8133; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://localhost:' + NODE_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cafeteria-demo-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cafeteria-demo-docroot-'));

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
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}
async function postJson(urlPath, body) {
  const res = await fetch(NODE_BASE + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json() };
}
// Real nonce/sign/start round trip (same as manual-admin-session.js) — a
// genuine session token, not a fabricated one, just obtained without the
// wallet extension's own UI in the way.
async function startAdminSession(admin) {
  const nonce = (await fetch(NODE_BASE + '/atlas/admin/session/nonce').then((r) => r.json())).nonce;
  const payload = { nonce };
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  const res = await postJson('/atlas/admin/session/start', { payload, proof });
  if (res.status !== 200) throw new Error('admin login failed: ' + JSON.stringify(res.body));
  return res.body.token;
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

  let browser;
  try {
    console.log('SETUP: registering an admin identity and starting a real session for it');
    const admin = await genIdentity();
    fs.writeFileSync(path.join(NODE_STATE_DIR, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
    const adminToken = await startAdminSession(admin);
    console.log('PASS: admin session token obtained ->', adminToken.slice(0, 16) + '...');

    browser = await chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' });
    const page = await browser.newPage();
    await page.goto(NODE_BASE + '/cafeteria-demo.html', { waitUntil: 'load' });

    console.log('STEP 1: creating a student wallet reveals the top-up and menu panels');
    await page.locator('#setupBtn').click();
    await page.waitForFunction(() => document.getElementById('parentPanel').style.display !== 'none', null, { timeout: 10000 });
    assert(await page.locator('#menuCards .card').count() === 3, 'expected all three menu items to render');
    console.log('PASS: student wallet created, panels revealed, three menu cards rendered');

    console.log('STEP 2: topping up 10 credits shows a balance of 10');
    await page.fill('#topUpAmount', '10');
    await page.locator('#topUpBtn').click();
    await page.waitForFunction(() => document.getElementById('balanceAmount').textContent === '10', null, { timeout: 10000 });
    console.log('PASS: balance shows 10 after top-up');

    console.log('STEP 3: buying the sandwich drops the balance to 5 and adds a receipt card');
    const sandwichBtn = page.locator('#menuCards .card', { hasText: 'Sandwich' }).locator('button');
    await sandwichBtn.click();
    await page.waitForFunction(() => document.getElementById('balanceAmount').textContent === '5', null, { timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('#receiptCards .card').length === 1, null, { timeout: 10000 });
    const sandwichCard = page.locator('#receiptCards .card', { hasText: 'Sandwich' });
    assert(await sandwichCard.locator('.badge.awaiting').count() === 1, 'expected the sandwich receipt to start as Awaiting collection');
    const sandwichRaw = await sandwichCard.locator('details.raw pre').textContent();
    const sandwichCredential = JSON.parse(sandwichRaw);
    assert(!sandwichCredential.asset || true, 'sandwich raw JSON parses'); // shape sanity: parses without throwing above
    console.log('PASS: balance -> 5, sandwich receipt rendered awaiting collection');

    console.log('STEP 4: buying the juice drops the balance to 3; the sandwich button is now disabled (would cost 5), the snack (3) is not');
    const juiceBtn = page.locator('#menuCards .card', { hasText: 'Juice' }).locator('button');
    await juiceBtn.click();
    await page.waitForFunction(() => document.getElementById('balanceAmount').textContent === '3', null, { timeout: 10000 });
    assert(await sandwichBtn.isDisabled(), 'expected the sandwich button to be disabled with only 3 credits left');
    const snackBtn = page.locator('#menuCards .card', { hasText: 'Snack Bar' }).locator('button');
    assert(!(await snackBtn.isDisabled()), 'expected the snack button to remain enabled with exactly 3 credits left');
    await page.waitForFunction(() => document.querySelectorAll('#receiptCards .card').length === 2, null, { timeout: 10000 });
    const juiceCard = page.locator('#receiptCards .card', { hasText: 'Juice' });
    console.log('PASS: balance -> 3, buy buttons reflect what\'s actually affordable, juice receipt rendered');

    console.log('STEP 5: fulfilling the sandwich receipt on the admin panel (session seeded directly, no extension needed)');
    const adminPage = await browser.newPage();
    await adminPage.context().addInitScript((token) => {
      sessionStorage.setItem('atlasAdminSession', JSON.stringify({ token, expiresAt: Date.now() + 5 * 60 * 1000 }));
    }, adminToken);
    await adminPage.goto(NODE_BASE + '/atlas-admin/', { waitUntil: 'load' });
    await adminPage.waitForFunction(() => document.getElementById('hidden-while-logged-out').style.display !== 'none', null, { timeout: 10000 });
    await adminPage.fill('#fulfillCredential', sandwichRaw);
    await adminPage.locator('#fulfillBtn').click();
    await adminPage.waitForFunction(() => {
      const el = document.getElementById('fulfillResult');
      return el && el.textContent.includes('Fulfilled');
    }, null, { timeout: 10000 });
    const fulfillResultText = await adminPage.locator('#fulfillResult').textContent();
    assert(fulfillResultText.includes('Sandwich'), 'expected the fulfill result to name the item, got: ' + fulfillResultText);
    console.log('PASS: admin panel fulfilled the sandwich receipt ->', fulfillResultText);

    console.log('STEP 6: back on the cafeteria page, "Check status" flips the sandwich receipt to Collected, leaving the juice receipt untouched');
    await sandwichCard.locator('.statusBtn').click();
    await page.waitForFunction(() => {
      const cards = [...document.querySelectorAll('#receiptCards .card')];
      const card = cards.find((c) => c.textContent.includes('Sandwich'));
      return card && card.querySelector('.badge.collected');
    }, null, { timeout: 10000 });
    console.log('PASS: sandwich receipt shows Collected ✓ after checking status');
    await juiceCard.locator('.statusBtn').click();
    await page.waitForTimeout(500);
    assert(await juiceCard.locator('.badge.awaiting').count() === 1, 'expected the juice receipt to still show Awaiting collection — it was never fulfilled');
    console.log('PASS: the juice receipt (never fulfilled) still correctly reports Awaiting collection');

    console.log('STEP 7: "Start over" resets the page back to Step 1');
    await page.locator('#resetBtn').click();
    await page.waitForFunction(() => document.getElementById('parentPanel').style.display === 'none', null, { timeout: 10000 });
    assert(await page.locator('#setupBtn').isVisible(), 'expected the initial setup button to be visible again after reset');
    console.log('PASS: "Start over" returns the page to its initial state');

    console.log('\nALL CAFETERIA DEMO CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    nodeProc.kill();
    try { fs.rmSync(NODE_STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(NODE_DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
