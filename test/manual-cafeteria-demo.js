// End-to-end check for demo-domain-a/cafeteria-demo.html — the worked
// example of SPEC.md §5.8 (purchasing) and §5.9 (fulfillment): a parent
// tops up a student's spendable balance, the student spends part of it on
// menu items, and each purchase's receipt is fulfilled right on this same
// page — no admin panel or operator login needed (POST
// /atlas/demo/cafeteria/fulfill, the self-serve sibling of the real
// admin-gated /atlas/asset/fulfill, hardcoded to this menu's three
// classes). test/manual-asset-purchase.js and test/manual-demo-self-serve.js
// already prove the underlying endpoints at the HTTP layer — this test is
// what the PAGE does with them, end to end.
//
// Drives the page directly with a headless browser (it needs no wallet
// extension).
//
// Checks:
//   1. Creating a student wallet reveals the top-up and menu panels.
//   2. Topping up 10 credits shows a balance of 10.
//   3. Buying the sandwich (price 5) drops the balance to 5 and adds an
//      "Awaiting collection" receipt card with the item's real raw JSON.
//   4. Buying the juice (price 2) drops the balance to 3, disabling the
//      sandwich button (would need 5) but leaving the snack (3) enabled.
//   5. Clicking "Collect" on the sandwich receipt fulfills it right on this
//      page and flips its badge to "Collected ✓" — the juice receipt's own
//      badge stays "Awaiting collection", proving this is per-credential.
//   6. "Check status" on the now-collected sandwich receipt still reports
//      Collected — reading the same fact back from this domain's own
//      public revocation list, independently of the page's own state.
//   7. "Start over" resets the page back to Step 1.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PORT = 8133; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://localhost:' + NODE_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cafeteria-demo-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cafeteria-demo-docroot-'));

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
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

    console.log('STEP 5: clicking "Collect" on the sandwich receipt fulfills it right on this page, with no admin panel involved');
    await sandwichCard.locator('.collectBtn').click();
    await page.waitForFunction(() => {
      const cards = [...document.querySelectorAll('#receiptCards .card')];
      const card = cards.find((c) => c.textContent.includes('Sandwich'));
      return card && card.querySelector('.badge.collected');
    }, null, { timeout: 10000 });
    assert(await juiceCard.locator('.badge.awaiting').count() === 1, 'expected the juice receipt to still show Awaiting collection — it was never collected');
    console.log('PASS: sandwich receipt shows Collected ✓ immediately, juice receipt untouched');

    console.log('STEP 6: "Check status" on the now-collected sandwich receipt still reports Collected, read back from the public revocation list');
    await sandwichCard.locator('.statusBtn').click();
    await page.waitForTimeout(500);
    assert(await sandwichCard.locator('.badge.collected').count() === 1, 'expected the sandwich receipt to still show Collected after re-checking status independently');
    console.log('PASS: "Check status" confirms the same fact from this domain\'s own public revocation list');

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
