// Manual browser click-through for demo-domain-a/recall-demo.html — the
// supply-chain provenance + recall demo. Unlike test/manual-recall-demo.js
// and test/manual-recall-demo-php.js (which drive the same flow straight
// against each backend's HTTP API), this one actually loads the real page
// in a real browser and clicks through it, the same way
// test/manual-oracle-demo-browser.js does for oracle-demo.html — catching
// bugs those two API-level tests cannot, such as a page-script reference
// error that only surfaces when a button handler actually runs in a
// browser.
//
// Checks, one per act:
//   1. Shipping a widget renders a raw credential box and reveals Act 2.
//   2. Both transfers succeed in order, the second only enabled once the
//      first lands, and reveal Act 3.
//   3. Tracing the widget's history renders a two-link chain and reveals
//      Act 4.
//   4. Issuing a recall renders the class patch and reveals Act 5.
//   5. A tampered check-in is correctly ignored (a "warn" result, not
//      fatal) — the page stays usable; a real check-in afterward lands
//      the recall notice and reveals Act 6.
//   6. Reselling the now-bound widget is correctly rejected.
//   Plus: clicking the raw reissued-widget box's "Try verifying this one"
//   button independently confirms the credential in the browser itself.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PORT = 8198; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://' + NODE_DOMAIN;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-recall-demo-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-recall-demo-docroot-'));

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
    await page.goto(NODE_BASE + '/recall-demo.html', { waitUntil: 'load' });

    console.log('STEP 1: Act 1 — ship a widget to the Distributor');
    await page.locator('#mintBtn').click();
    await page.waitForFunction(() => document.getElementById('transferPanel').style.display !== 'none', null, { timeout: 10000 });
    const mintText = await page.locator('#mintResult').textContent();
    assert(mintText.includes('minted to the Distributor'), 'unexpected mint result: ' + mintText);
    assert(await page.locator('#mintResult details.raw').count() === 1, 'expected a raw-widget box on the mint result');
    console.log('PASS:', mintText);

    console.log('STEP 2: Act 2 — Distributor -> Retailer -> Customer');
    await page.locator('#transfer1Btn').click();
    await page.waitForFunction(() => !document.getElementById('transfer2Btn').disabled, null, { timeout: 10000 });
    const t1Text = await page.locator('#transfer1Result').textContent();
    assert(t1Text.includes('Transferred to the Retailer'), 'unexpected first transfer result: ' + t1Text);
    await page.locator('#transfer2Btn').click();
    await page.waitForFunction(() => document.getElementById('historyPanel').style.display !== 'none', null, { timeout: 10000 });
    const t2Text = await page.locator('#transfer2Result').textContent();
    assert(t2Text.includes('final owner'), 'unexpected second transfer result: ' + t2Text);
    console.log('PASS: both transfers landed, widget now with the Customer');

    console.log('STEP 3: Act 3 — trace the widget\'s full supply chain');
    await page.locator('#traceBtn').click();
    await page.waitForFunction(() => document.getElementById('recallPanel').style.display !== 'none', null, { timeout: 10000 });
    const traceText = await page.locator('#traceResult').textContent();
    assert(traceText.includes('2 earlier links'), 'unexpected trace result: ' + traceText);
    assert(await page.locator('#traceResult details.raw').count() === 2, 'expected two raw link boxes in the traced chain');
    console.log('PASS:', traceText);

    console.log('STEP 4: Act 4 — the manufacturer issues a recall');
    await page.locator('#issueRecallBtn').click();
    await page.waitForFunction(() => document.getElementById('checkinPanel').style.display !== 'none', null, { timeout: 10000 });
    const recallText = await page.locator('#recallResult').textContent();
    assert(recallText.includes('Recall issued'), 'unexpected recall result: ' + recallText);
    assert(await page.locator('#recallResult details.raw').count() === 1, 'expected a raw class-patch box on the recall result');
    console.log('PASS:', recallText);

    console.log('STEP 5: Act 5 — a tampered check-in is ignored, then a real one lands the recall');
    await page.locator('#tamperCheckinBtn').click();
    await page.waitForFunction(() => document.getElementById('checkinResult').textContent.includes('Correctly ignored'), null, { timeout: 10000 });
    const tamperText = await page.locator('#checkinResult').textContent();
    assert(!tamperText.includes('Unexpected'), 'tampered check-in should have been ignored, got: ' + tamperText);
    assert(await page.locator('#breakPanel').isHidden(), 'break panel should stay hidden until a real check-in actually lands the recall');
    console.log('PASS:', tamperText);

    await page.locator('#realCheckinBtn').click();
    await page.waitForFunction(() => document.getElementById('breakPanel').style.display !== 'none', null, { timeout: 10000 });
    const checkinText = await page.locator('#checkinResult').textContent();
    assert(checkinText.includes('The recall landed'), 'unexpected real check-in result: ' + checkinText);
    assert(await page.locator('#checkinResult details.raw').count() === 1, 'expected a raw reissued-widget box on the real check-in result');
    console.log('PASS:', checkinText);

    console.log('STEP 6: Act 6 — try to break it: resell the now-bound widget');
    await page.locator('#resaleBtn').click();
    await page.waitForFunction(() => document.getElementById('breakResult').textContent.includes('Rejected'), null, { timeout: 10000 });
    const breakText = await page.locator('#breakResult').textContent();
    assert(!breakText.includes('Unexpected'), 'resale of a recalled widget should have been rejected, got: ' + breakText);
    assert(breakText.includes('bound to its owner'), 'unexpected resale rejection text: ' + breakText);
    console.log('PASS:', breakText);

    console.log('STEP 7: independently verify the reissued widget credential, in the browser itself');
    const rawBox = page.locator('#checkinResult details.raw');
    await rawBox.locator('summary').click();
    await rawBox.locator('button').click();
    await page.waitForFunction(() => document.getElementById('verifyResult').textContent.startsWith('✓ Valid'), null, { timeout: 10000 });
    const verifyText = await page.locator('#verifyResult').textContent();
    console.log('PASS:', verifyText);

    assert(pageErrors.length === 0, 'expected no uncaught page errors during the whole walkthrough, got: ' + pageErrors.map((e) => e.message).join(' | '));
    console.log('PASS: no uncaught page errors across the whole walkthrough');

    console.log('\nALL SIX ACTS PASSED in a real browser against demo-domain-a/recall-demo.html');
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
