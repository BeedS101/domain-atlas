// Manual check for demo-domain-a/warranty-demo.html — the factory-to-
// retailer-to-owner warranty chain. test/manual-demo-self-serve.js already
// covers the self-serve /atlas/demo/warranty/mint and
// /atlas/demo/warranty/stamp-sale endpoints' own protocol behavior at the
// HTTP layer; this test is what the PAGE does with them, plus the existing
// (already-tested elsewhere) transfer endpoint it leans on for the
// ownership-change step. Drives the real page with a headless browser,
// same "own isolated instance" reasoning every other manual-*.js test in
// this project uses. Minting and stamping both happen right on the page —
// no admin panel, no operator login, nothing a live-site visitor couldn't
// do themselves.
//
// Checks:
//   1. The page generates and displays a public key on load.
//   2. Filling in a serial number and clicking "Mint certificate" mints
//      directly (no admin panel involved) and renders a card showing that
//      serial and "not started yet".
//   3. Filling in a sale date, warranty length, and retailer name and
//      clicking "Stamp the sale" flips the card to "Active until ...
//      remaining", showing the retailer name, with the same serial number.
//   4. Stamping again with an already-lapsed sale window flips the same
//      card to "Expired ... ago" — pure date arithmetic, no real waiting.
//   5. "Transfer to a new owner" performs a genuine POST
//      /atlas/asset/transfer and the resulting card shows a new owner
//      while keeping the exact same serial number and warranty status.
//   6. "Try verifying this one independently" on the transferred
//      certificate reports it valid.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PORT = 8142; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://localhost:' + NODE_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-warranty-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-warranty-docroot-'));

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
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

    console.log('STEP 2: filling in a serial number and minting renders the card with that serial and "not started yet" — no admin panel involved');
    await page.locator('#serialInput').fill('SN-0001');
    await page.locator('#mintBtn').click();
    await page.waitForFunction(() => document.getElementById('cardPanel').style.display !== 'none', { timeout: 10000 });
    const cardTextAfterMint = await page.locator('#certificateCard').textContent();
    assert(cardTextAfterMint.includes('SN-0001'), 'expected the serial number to show on the card, got: ' + cardTextAfterMint);
    assert(cardTextAfterMint.includes('Not started yet'), 'expected a "not started" warranty status before any sale is stamped, got: ' + cardTextAfterMint);
    assert(cardTextAfterMint.includes('(you)'), 'expected the card to show the certificate as currently owned by you');
    console.log('PASS: self-serve mint rendered correctly on the page');

    console.log('STEP 3: stamping a recent sale flips the card to Active');
    await page.locator('#saleDateInput').fill(isoDateDaysAgo(30));
    await page.locator('#warrantyMonthsInput').fill('24');
    await page.locator('#retailerInput').fill('Example Retailer');
    await page.locator('#stampBtn').click();
    await page.waitForFunction(() => (document.getElementById('certificateCard').textContent || '').includes('Active until'), { timeout: 10000 });
    const activeCardText = await page.locator('#certificateCard').textContent();
    assert(activeCardText.includes('Example Retailer'), 'expected the retailer name to show on the card, got: ' + activeCardText);
    assert(activeCardText.includes('SN-0001'), 'expected the same serial number to survive the stamp');
    console.log('PASS: sale stamped, warranty shows Active with the retailer name —', activeCardText.match(/Active until \S+ \(\d+ days remaining\)/)[0]);

    console.log('STEP 4: stamping again with an already-lapsed sale window flips the card to Expired');
    await page.locator('#saleDateInput').fill(isoDateDaysAgo(800));
    await page.locator('#warrantyMonthsInput').fill('12');
    await page.locator('#stampBtn').click();
    await page.waitForFunction(() => (document.getElementById('certificateCard').textContent || '').includes('Expired'), { timeout: 10000 });
    console.log('PASS: an already-lapsed sale window shows Expired, computed instantly with no real waiting');

    console.log('STEP 5: "Transfer to a new owner" performs a genuine transfer, keeping the serial and warranty status');
    await page.locator('#transferBtn').click();
    await page.waitForFunction(() => (document.getElementById('transferResult').textContent || '').startsWith('Transferred'), { timeout: 10000 });
    const afterTransferText = await page.locator('#certificateCard').textContent();
    assert(afterTransferText.includes('SN-0001'), 'expected the serial number to survive the transfer, got: ' + afterTransferText);
    assert(afterTransferText.includes('Expired'), 'expected the warranty status to survive the transfer unchanged, got: ' + afterTransferText);
    assert(!afterTransferText.includes('(you)'), 'expected the card to no longer show "(you)" once ownership moved to the newly generated owner');
    console.log('PASS: ownership transferred for real, serial and warranty status both carried over unchanged');

    console.log('STEP 6: "Try verifying this one independently" reports the transferred certificate valid');
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
