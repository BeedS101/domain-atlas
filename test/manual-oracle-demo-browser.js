// Manual browser click-through for demo-domain-a/oracle-demo.html — the
// oracle-triggered flight-delay payout demo. Unlike test/manual-oracle-demo.js
// and test/manual-oracle-demo-php.js (which drive the same flow straight
// against each backend's HTTP API), this one actually loads the real page
// in a real browser and clicks through it, the same way
// test/manual-governance-demo-browser.js does for governance-demo.html —
// catching bugs those two API-level tests cannot, such as a page-script
// reference error that only surfaces when a button handler actually runs
// in a browser.
//
// Checks, one per act:
//   1. Buying a policy for BA249 (500-unit payout) renders a raw policy
//      box and reveals Act 2.
//   2. Reporting a 45-minute delay renders a raw oracle-report box and
//      reveals Act 3.
//   3. Requesting a payout against that sub-threshold report is rejected
//      (a "warn" result, not fatal) — the page stays usable.
//   4. Reporting a 150-minute delay for the same flight, then requesting
//      the payout again, succeeds and reveals Act 4.
//   5. Both "try to break it" buttons are correctly rejected (a second
//      payout on the same policy; a genuine, well-over-threshold report
//      for a different flight).
//   Plus: clicking the raw payout box's "Try verifying this one" button
//   independently confirms the payout credential in the browser itself.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PORT = 8195; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://' + NODE_DOMAIN;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-oracle-demo-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-oracle-demo-docroot-'));

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}

(async () => {
  console.log('SETUP: copying demo-domain-a into an isolated docroot and starting its own issuer-server instance on port ' + NODE_PORT);
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-a'), NODE_DOCROOT_DIR, { recursive: true });
  const nodeProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(NODE_PORT), ATLAS_DOMAIN: NODE_DOMAIN, ATLAS_STATE_DIR: NODE_STATE_DIR, ATLAS_DOCROOT: NODE_DOCROOT_DIR },
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
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err));
    await page.goto(NODE_BASE + '/oracle-demo.html', { waitUntil: 'load' });

    console.log('STEP 1: Act 1 — buy a policy for BA249, 500-unit payout');
    await page.locator('#buyBtn').click();
    await page.waitForFunction(() => document.getElementById('reportPanel').style.display !== 'none', { timeout: 10000 });
    const buyText = await page.locator('#buyResult').textContent();
    assert(buyText.includes('BA249') && buyText.includes('500') && buyText.includes('120'), 'unexpected buy result: ' + buyText);
    assert(await page.locator('#buyResult details.raw').count() === 1, 'expected a raw-policy box on the buy result');
    console.log('PASS:', buyText);

    console.log('STEP 2: Act 2 — the oracle reports a 45-minute delay');
    await page.locator('#delayInput').fill('45');
    await page.locator('#reportBtn').click();
    await page.waitForFunction(() => document.getElementById('claimPanel').style.display !== 'none', { timeout: 10000 });
    const reportText = await page.locator('#reportResult').textContent();
    assert(reportText.includes('BA249') && reportText.includes('45'), 'unexpected report result: ' + reportText);
    console.log('PASS:', reportText);

    console.log('STEP 3: Act 3 — requesting a payout against the sub-threshold report is rejected');
    await page.locator('#claimBtn').click();
    await page.waitForFunction(() => document.getElementById('claimResult').textContent.includes('Not paid out'), { timeout: 10000 });
    const rejectedClaimText = await page.locator('#claimResult').textContent();
    assert(rejectedClaimText.includes('does not meet'), 'unexpected sub-threshold rejection: ' + rejectedClaimText);
    assert(await page.locator('#breakPanel').isHidden(), 'break panel should stay hidden until a payout actually succeeds');
    console.log('PASS:', rejectedClaimText);

    console.log('STEP 4: report a 150-minute delay for the same flight, then request the payout again — it succeeds');
    await page.locator('#delayInput').fill('150');
    await page.locator('#reportBtn').click();
    await page.waitForFunction(() => document.getElementById('reportResult').textContent.includes('150'), { timeout: 10000 });
    await page.locator('#claimBtn').click();
    await page.waitForFunction(() => document.getElementById('breakPanel').style.display !== 'none', { timeout: 10000 });
    const claimText = await page.locator('#claimResult').textContent();
    assert(claimText.includes('Paid out 500 units'), 'unexpected successful claim result: ' + claimText);
    assert(await page.locator('#claimResult details.raw').count() === 1, 'expected a raw-payout box on the successful claim result');
    console.log('PASS:', claimText);

    console.log('STEP 5: Act 4 — try to break it');
    await page.locator('#doubleClaimBtn').click();
    await page.waitForFunction(() => document.getElementById('breakResult').textContent.includes('Rejected'), { timeout: 10000 });
    let breakText = await page.locator('#breakResult').textContent();
    assert(!breakText.includes('Unexpected'), 'double claim should have been rejected, got: ' + breakText);
    assert(breakText.includes('already been paid out'), 'unexpected double-claim rejection text: ' + breakText);

    await page.locator('#wrongFlightBtn').click();
    await page.waitForFunction(() => document.getElementById('breakResult').textContent.includes('different flight'), { timeout: 10000 });
    breakText = await page.locator('#breakResult').textContent();
    assert(!breakText.includes('Unexpected'), 'mismatched-flight claim should have been rejected, got: ' + breakText);
    console.log('PASS: both double-claim and mismatched-flight attempts were correctly rejected');

    console.log('STEP 6: independently verify the payout credential, in the browser itself');
    const rawBox = page.locator('#claimResult details.raw');
    await rawBox.locator('summary').click();
    await rawBox.locator('button').click();
    await page.waitForFunction(() => document.getElementById('verifyResult').textContent.startsWith('✓ Valid'), { timeout: 10000 });
    const verifyText = await page.locator('#verifyResult').textContent();
    console.log('PASS:', verifyText);

    assert(pageErrors.length === 0, 'expected no uncaught page errors during the whole walkthrough, got: ' + pageErrors.map((e) => e.message).join(' | '));
    console.log('PASS: no uncaught page errors across the whole walkthrough');

    console.log('\nALL FOUR ACTS PASSED in a real browser against demo-domain-a/oracle-demo.html');
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
