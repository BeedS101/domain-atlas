// Manual check for demo-domain-b/email-ticket-demo.html — the standalone,
// wallet-free page built for showing SPEC.md §13 (email-delivered bearer
// credentials) to someone evaluating the protocol, with no extension and
// no second wallet involved at all: the whole point of this page is that
// the RECEIVING end never needs one. Issues a real atlas.demo.email.ticket
// credential to a page-local throwaway identity (Step 1, a genuine
// POST /atlas/asset/issue). Step 2 — "Send the voucher" — is a client-side
// mockup only: letting this page fire real, unauthenticated email from the
// domain's own mailbox at any address typed into it, with nothing to tell
// a human apart from a script calling the same endpoint directly, would
// have made the page itself an abuse vector. test/manual-email-ticket-
// send.js already covers /atlas/asset/transfer-to-email's own protocol
// behavior at the HTTP layer; this test is only about what the PAGE does,
// which is now never call that endpoint at all.
//
// Drives the real page directly with a headless browser against a single
// isolated issuer-server instance. ATLAS_DOCROOT points at an isolated
// copy of demo-domain-b so the instance's own .well-known key/revocation
// files never touch the actual project directory.
//
// Checks:
//   1. Clicking "Get my demo voucher" issues a voucher to a freshly
//      generated identity and renders it, tagged Giftable.
//   2. Clicking "Send the voucher" with the email field left empty is
//      caught client-side ("Enter a valid email address") without
//      touching the network at all.
//   3. Entering a well-formed address and clicking "Send the voucher"
//      shows the mockup result — the voucher's own thumbnail image, a
//      message naming the address and saying no real email was sent —
//      and flips the voucher's own badge to "Sent (mockup)", all without
//      a single request ever reaching the server for it.
//   4. "Start over" resets the page without a reload, and a second
//      run-through works normally.
//
// Not part of the permanent suite, same reasoning as every other
// manual-*.js script.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PORT = 8206; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://' + NODE_DOMAIN;

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}

(async () => {
  const docrootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-email-ticket-demo-docroot-'));
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-b'), docrootDir, { recursive: true });

  console.log('SETUP: starting an isolated issuer-server instance on port ' + NODE_PORT);
  const nodeProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(NODE_PORT),
      ATLAS_DOMAIN: NODE_DOMAIN,
      ATLAS_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-email-ticket-demo-state-')),
      ATLAS_DOCROOT: docrootDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    nodeProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    nodeProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: issuer-server up on port ' + NODE_PORT);

  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: '/opt/pw-browsers/chromium' });
    const page = await browser.newPage();

    const transferRequests = [];
    page.on('request', (req) => {
      if (req.url().includes('/atlas/asset/transfer-to-email')) transferRequests.push(req.url());
    });

    await page.goto(NODE_BASE + '/email-ticket-demo.html', { waitUntil: 'load' });

    console.log('STEP 1: clicking "Get my demo voucher" issues and renders the voucher, tagged Giftable');
    await page.locator('#issueBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('#voucherCard .card').length === 1, null, { timeout: 10000 });
    const voucherCard = page.locator('#voucherCard .card');
    assert((await voucherCard.locator('h3').textContent()) === 'Workshop Visitor Voucher', 'expected the voucher\'s real name to render');
    assert(await voucherCard.locator('.badge').textContent() === 'Giftable', 'expected the voucher tagged Giftable');
    assert(await page.locator('#sendPanel').isVisible(), 'expected Step 2 to reveal itself once a voucher exists');
    console.log('PASS: voucher issued and rendered');

    console.log('STEP 2: clicking "Send the voucher" with no address entered is caught client-side, no network call');
    await page.locator('#sendBtn').click();
    await page.waitForFunction(() => (document.getElementById('sendResult').textContent || '').includes('Enter a valid email address'), null, { timeout: 10000 });
    assert(await page.locator('#sendBtn').isEnabled(), 'expected the button to stay enabled after a client-side-only rejection');
    console.log('PASS: empty address caught before anything else happens');

    console.log('STEP 3: sending to a well-formed address shows the mockup result, never touching the real endpoint');
    await page.locator('#emailInput').fill('friend@example.com');
    await page.locator('#sendBtn').click();
    await page.waitForFunction(() => document.querySelector('#sendResult .result.ok') !== null, null, { timeout: 10000 });
    const okText = await page.locator('#sendResult .result.ok').textContent();
    assert(okText.includes('friend@example.com'), 'expected the mockup message to name the address typed in, got: ' + okText);
    assert(/no real email was sent/i.test(okText), 'expected the mockup to say plainly that nothing was actually sent, got: ' + okText);
    const imgSrc = await page.locator('#sendResult img').getAttribute('src');
    assert(/\/assets\/ring\.png$/.test(imgSrc), 'expected the mockup to display the voucher\'s own thumbnail image, got: ' + imgSrc);
    assert(await page.locator('#sendBtn').isDisabled(), 'expected the send button to disable once the mockup "send" completes');
    assert(await page.locator('#emailInput').isDisabled(), 'expected the email field to disable once the mockup "send" completes');
    assert((await voucherCard.locator('.badge').textContent()) === 'Sent (mockup)', 'expected the voucher\'s own badge to flip to Sent (mockup), not a bare Sent that could pass for a real one');
    assert(transferRequests.length === 0, 'expected the page to never call the real transfer-to-email endpoint, got requests: ' + JSON.stringify(transferRequests));
    console.log('PASS: mockup shown, nothing reached the server for it');

    console.log('STEP 4: "Start over" resets the page without a reload, and a second run-through works normally');
    await page.locator('#resetBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('#voucherCard .card').length === 0 && document.getElementById('resetBtn').style.display === 'none', null, { timeout: 10000 });
    assert(!(await page.locator('#sendPanel').isVisible()), 'expected Step 2 to hide again after a reset');
    assert(await page.locator('#issueBtn').isEnabled(), 'expected "Get my demo voucher" to be clickable again');
    await page.locator('#issueBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('#voucherCard .card').length === 1, null, { timeout: 10000 });
    assert(transferRequests.length === 0, 'expected the real endpoint to still never have been called after a reset and re-run');
    console.log('PASS: the page resets in place and a second run-through works normally');

    console.log('\nALL EMAIL TICKET DEMO PAGE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    nodeProc.kill();
    try { fs.rmSync(docrootDir, { recursive: true, force: true }); } catch (err) {}
    process.exit(process.exitCode || 0);
  }
})();
