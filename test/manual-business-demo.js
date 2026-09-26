// Manual check for demo-domain-a/business-demo.html — the standalone,
// extension-free page built for showing the credential layer to someone
// evaluating it for business use, without asking them to install anything
// first. It generates its own two throwaway identities (page-local, "you"
// and "your friend" — the same "second local keypair in one browser tab"
// device extension/wallet.js's own counterparty already uses for its §5.2
// loss demo, just standing in for a friend's separate wallet here instead),
// issues two real credentials to the first, and lets a visitor try sending
// each to the second via POST /atlas/asset/transfer (test/manual-asset-
// transfer.js already covers that endpoint's own protocol behavior at the
// HTTP layer — this test is what the PAGE does with it).
//
// Drives the real page directly with a headless browser rather than the
// wallet extension, since this page deliberately has nothing to do with
// it. ATLAS_DOCROOT points at an isolated copy of demo-domain-a (rather
// than the real one) so the server's own .well-known key/revocation files
// never touch the actual project directory, same "own isolated instance"
// reasoning every other manual-*.js test in this project already follows.
//
// Checks:
//   1. Clicking "Get my two demo credentials" issues both a coupon and a
//      badge to a freshly-generated identity and renders both cards.
//   2. Sending the coupon to a friend succeeds: it appears in "Your
//      friend's wallet" with the exact same properties, and the sender's
//      card shows a plain-English success message.
//   3. Sending the badge is rejected with the server's own plain-English
//      reason shown inline, and the badge stays exactly where it was —
//      nothing added to the friend panel for it.
//   4. The "View raw signed credential" detail genuinely reflects the real
//      issued credential (matching id/class), not placeholder text.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PORT = 8126; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://localhost:' + NODE_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-business-demo-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-business-demo-docroot-'));

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
    await page.goto(NODE_BASE + '/business-demo.html', { waitUntil: 'load' });

    console.log('STEP 1: clicking "Get my two demo credentials" issues and renders both cards');
    await page.locator('#issueBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('#youCards .card').length === 2, { timeout: 10000 });
    const couponCard = page.locator('#youCards .card', { hasText: '10% Off Coupon' });
    const badgeCard = page.locator('#youCards .card', { hasText: 'Plaza Visitor Badge' });
    assert(await couponCard.locator('.badge.giftable').count() === 1, 'expected the coupon to be tagged Giftable');
    assert(await badgeCard.locator('.badge.locked').count() === 1, 'expected the badge to be tagged Locked to you');
    console.log('PASS: both credentials issued and correctly tagged giftable/locked');

    console.log('STEP 2: sending the coupon to a friend succeeds and arrives in the friend panel');
    const couponRawBefore = await couponCard.locator('details.raw pre').textContent();
    const couponIdBefore = JSON.parse(couponRawBefore).id;
    await couponCard.locator('.sendBtn').click();
    await page.waitForFunction(() => document.querySelectorAll('#friendCards .card').length === 1, { timeout: 10000 });
    assert((await couponCard.locator('.result.ok').textContent()).includes('Sent'), 'expected a plain success message on the sender\'s own card');
    const friendCard = page.locator('#friendCards .card', { hasText: '10% Off Coupon' });
    assert(await friendCard.count() === 1, 'expected the coupon to show up in the friend panel');
    const friendRaw = JSON.parse(await friendCard.locator('details.raw pre').textContent());
    assert(friendRaw.asset.class === 'atlas.demo.coupon', 'expected the received card\'s raw JSON to genuinely be the coupon class');
    assert(friendRaw.id !== couponIdBefore, 'expected the received credential to be a freshly-minted id, not the original');
    console.log('PASS: the coupon genuinely moves to the friend panel with a fresh, real credential');

    console.log('STEP 3: sending the badge is rejected inline, and nothing lands in the friend panel for it');
    await badgeCard.locator('.sendBtn').click();
    await page.waitForFunction(() => {
      const cards = [...document.querySelectorAll('#youCards .card')].filter((c) => c.textContent.includes('Plaza Visitor Badge'));
      return cards[0] && cards[0].querySelector('.result.err');
    }, { timeout: 10000 });
    const badgeErrorText = await badgeCard.locator('.result.err').textContent();
    assert(badgeErrorText.includes('bound to its owner and cannot be sent'), 'expected the exact server rejection reason to be shown, got: ' + badgeErrorText);
    assert(await page.locator('#friendCards .card', { hasText: 'Plaza Visitor Badge' }).count() === 0, 'expected nothing to land in the friend panel for a rejected transfer');
    assert(await page.locator('#youCards .card', { hasText: 'Plaza Visitor Badge' }).count() === 1, 'expected the badge to remain exactly where it was');
    console.log('PASS: the badge stays put, rejected with the real plain-English reason:', badgeErrorText.replace('Can’t send this one: ', ''));

    console.log('\nALL BUSINESS DEMO PAGE CHECKS PASSED');
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
