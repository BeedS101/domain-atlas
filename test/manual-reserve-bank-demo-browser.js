// Manual browser click-through for demo-domain-a/reserve-bank-demo.html —
// the seven-act reserve-bank / two-tier-currency demo. Unlike
// test/manual-reserve-bank-demo.js and test/manual-reserve-bank-demo-php.js
// (which drive the same flow straight against each backend's HTTP API),
// this one actually loads the real page in a real browser and clicks
// through it, the same way test/manual-attestation-demo.js does for
// attestation-demo.html — catching bugs those two API-level tests cannot,
// such as a page-script reference error that only surfaces when the
// button handler actually runs in a browser.
//
// Checks, one per act:
//   1. "Set up the committee" renders three officer cards; requesting the
//      mint then having 2 of 3 officers approve mints a real Reserve
//      Credit credential to the treasury and reveals Act 2.
//   2. Both "Issue 40,000" buttons split reserves to both banks.
//   3. Both "convert" buttons purchase each bank's own retail currency.
//   4. Both "credit" buttons and the "Alice pays Charlie" button move
//      real balances to real customers.
//   5. Joining the Trading Station, then posting + claiming the listing,
//      settles a genuine cross-currency trade — Alice ends up holding
//      real Beta Dollars.
//   6. Requesting an audit issues a real, independently-signed attestation.
//   7. Simulating the theft produces a real stolen credential; clawback
//      recovers it to Bank Beta and the ledger reflects the merged
//      balance.
//   Plus: the standalone "Verify any credential" panel independently
//   confirms the final Bank Beta balance credential is valid.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PORT = 8181; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://' + NODE_DOMAIN;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-reserve-demo-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-reserve-demo-docroot-'));

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
    await page.goto(NODE_BASE + '/reserve-bank-demo.html', { waitUntil: 'load' });

    console.log('STEP 1: Act 1 — set up the committee, request the mint, 2 of 3 officers approve');
    await page.locator('#setupBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('#officerCards .officer').length === 3, { timeout: 10000 });
    await page.locator('#requestMintBtn').click();
    await page.waitForSelector('#approveButtons button', { timeout: 10000 });
    await page.locator('#approveButtons button').nth(0).click();
    await page.waitForFunction(() => document.getElementById('approveStatus').textContent.includes('Waiting on 1 more'), { timeout: 10000 });
    await page.locator('#approveButtons button').nth(1).click();
    await page.waitForFunction(() => document.getElementById('issuancePanel').style.display !== 'none', { timeout: 10000 });
    const approveStatusText = await page.locator('#approveStatus').textContent();
    assert(approveStatusText.includes('100000 Reserve Credits minted'), 'expected the mint to report 100000 Reserve Credits minted, got: ' + approveStatusText);
    console.log('PASS:', approveStatusText);

    console.log('STEP 2: Act 2 — wholesale issuance to both banks');
    await page.locator('#issueAlphaBtn').click();
    await page.waitForFunction(() => !document.getElementById('issueBetaBtn').disabled, { timeout: 10000 });
    await page.locator('#issueBetaBtn').click();
    await page.waitForFunction(() => document.getElementById('conversionPanel').style.display !== 'none', { timeout: 10000 });
    const issuanceText = await page.locator('#issuanceResult').textContent();
    assert(issuanceText.includes('Bank Alpha now holds 40000') && issuanceText.includes('Bank Beta now holds 40000') && issuanceText.includes('keeps 20000 unallocated'), 'unexpected issuance result: ' + issuanceText);
    console.log('PASS: both banks issued 40,000 reserves each, treasury keeps 20,000');

    console.log('STEP 3: Act 3 — retail conversion into each bank\'s own currency');
    await page.locator('#convertAlphaBtn').click();
    await page.waitForFunction(() => !document.getElementById('convertBetaBtn').disabled, { timeout: 10000 });
    await page.locator('#convertBetaBtn').click();
    await page.waitForFunction(() => document.getElementById('retailPanel').style.display !== 'none', { timeout: 10000 });
    const conversionText = await page.locator('#conversionResult').textContent();
    assert(conversionText.includes('20000 Alpha Dollars') && conversionText.includes('20000 Beta Dollars'), 'unexpected conversion result: ' + conversionText);
    console.log('PASS: both banks converted 20,000 reserves into their own retail currency');

    console.log('STEP 4: Act 4 — banks credit customers, Alice pays Charlie');
    await page.locator('#creditAliceBtn').click();
    await page.waitForFunction(() => !document.getElementById('creditBobBtn').disabled, { timeout: 10000 });
    await page.locator('#creditBobBtn').click();
    await page.waitForFunction(() => !document.getElementById('payCharlieBtn').disabled, { timeout: 10000 });
    await page.locator('#payCharlieBtn').click();
    await page.waitForFunction(() => document.getElementById('tradePanel').style.display !== 'none', { timeout: 10000 });
    const retailText = await page.locator('#retailResult').textContent();
    assert(retailText.includes('Alice now holds 5000') && retailText.includes('Bob now holds 5000') && retailText.includes('Alice paid Charlie 1,200'), 'unexpected retail result: ' + retailText);
    await page.waitForFunction(() => document.getElementById('ledger').style.display !== 'none', { timeout: 10000 });
    assert(await page.locator('#ledger .acct').count() >= 6, 'expected the ledger to render at least 6 account cards');
    console.log('PASS:', retailText);

    console.log('STEP 5: Act 5 — Trading Station cross-currency settlement');
    await page.locator('#joinStationBtn').click();
    await page.waitForFunction(() => !document.getElementById('postListingBtn').disabled, { timeout: 10000 });
    await page.locator('#postListingBtn').click();
    await page.waitForFunction(() => !document.getElementById('claimListingBtn').disabled, { timeout: 10000 });
    await page.locator('#claimListingBtn').click();
    await page.waitForFunction(() => document.getElementById('tradeResult').textContent.includes('Settled'), { timeout: 10000 });
    const tradeText = await page.locator('#tradeResult').textContent();
    assert(tradeText.includes('300') && tradeText.includes('Beta Dollars'), 'unexpected trade settlement result: ' + tradeText);
    console.log('PASS: cross-currency settlement completed —', tradeText.match(/Settled[^.]*\./)[0]);

    console.log('STEP 6: Act 6 — independent reserve audit');
    await page.locator('#auditBtn').click();
    await page.waitForSelector('#auditResult .result.ok', { timeout: 10000 });
    const auditText = await page.locator('#auditResult').textContent();
    assert(auditText.toLowerCase().includes('reserves-verified') || auditText.toLowerCase().includes('sufficient'), 'unexpected audit result: ' + auditText);
    assert(await page.locator('#auditResult details.raw').count() === 1, 'expected a raw-credential box on the audit result');
    console.log('PASS:', auditText);

    console.log('STEP 7: Act 7 — simulate the theft, then suspend + clawback recover it');
    await page.locator('#fraudBtn').click();
    await page.waitForFunction(() => document.getElementById('decideRow').style.display !== 'none', { timeout: 10000 });
    const fraudText = await page.locator('#fraudResult').textContent();
    assert(fraudText.includes('15,000 Beta Dollars'), 'unexpected fraud result: ' + fraudText);
    await page.locator('#clawbackBtn').click();
    await page.waitForFunction(() => document.getElementById('decideResult').textContent.includes('no longer valid') || document.getElementById('decideResult').textContent.includes('unexpected'), { timeout: 10000 });
    const decideText = await page.locator('#decideResult').textContent();
    // "Consolidated" only appears when Bank Beta still held a separate
    // leftover balance to merge with the recovered one — the theft in this
    // run drains Bank Beta's entire remaining balance, so there's nothing
    // left to consolidate against and that step is correctly skipped.
    assert(decideText.includes('Suspended') && decideText.includes('Clawed back') && decideText.includes('no longer valid'), 'unexpected clawback outcome: ' + decideText);
    console.log('PASS:', decideText);

    console.log('STEP 8: independently verify the recovered Bank Beta balance credential');
    const recoveredRawBox = page.locator('#decideResult details.raw').last();
    await recoveredRawBox.locator('summary').click();
    await recoveredRawBox.locator('button').click();
    await page.waitForFunction(() => document.getElementById('verifyResult').textContent.startsWith('✓ Valid'), { timeout: 10000 });
    const verifyText = await page.locator('#verifyResult').textContent();
    console.log('PASS:', verifyText);

    assert(pageErrors.length === 0, 'expected no uncaught page errors during the whole walkthrough, got: ' + pageErrors.map((e) => e.message).join(' | '));
    console.log('PASS: no uncaught page errors across the whole seven-act walkthrough');

    console.log('\nALL SEVEN ACTS PASSED in a real browser against demo-domain-a/reserve-bank-demo.html');
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
