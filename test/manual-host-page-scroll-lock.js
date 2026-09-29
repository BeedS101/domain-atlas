// The overlay iframe covers the whole viewport (position: fixed; inset: 0),
// but a native scrollbar is drawn by the browser's own window chrome, not
// the page's stacking context, so nothing in-page can cover it. Before this
// fix, the host page underneath stayed scrollable by mouse wheel the whole
// time the overlay was open — a scrollbar with nothing to do with the
// wallet or the world inside it, easy to mistake for a wallet-panel bug.
// See content.js's own comment on lockHostPageScroll()/unlockHostPageScroll().
//
// Checks: the host page's <html>/<body> are NOT scroll-locked before the
// overlay opens; opening it locks both; closing it restores whatever the
// page's own inline overflow values were before (not just cleared to '');
// and a second open/close cycle behaves the same way, proving the guard
// against a re-open recapturing 'hidden' as if it were the original value.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PORT = 8151; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://' + NODE_DOMAIN;
const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-scroll-lock-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-scroll-lock-docroot-'));
const EXT_PATH = path.resolve(__dirname, '..', 'extension');

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
  console.log('PASS: isolated issuer-server up on port ' + NODE_PORT);

  const userDataDir = path.resolve(__dirname, '.chrome-profile-scroll-lock');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox'
    ]
  });

  try {
    const page = await context.newPage();

    console.log('STEP 1: before opening the overlay, the host page scrolls normally');
    await page.goto(NODE_BASE, { waitUntil: 'load' });
    const before = await page.evaluate(() => ({
      html: document.documentElement.style.overflow,
      body: document.body.style.overflow
    }));
    assert(before.html !== 'hidden' && before.body !== 'hidden', 'expected the host page not to be scroll-locked before any overlay was opened, got: ' + JSON.stringify(before));
    console.log('PASS: host page starts unlocked —', JSON.stringify(before));

    console.log('STEP 2: opening the overlay locks scroll on both <html> and <body>');
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.length > 0, { timeout: 10000 });
    const locked = await page.evaluate(() => ({
      html: document.documentElement.style.overflow,
      body: document.body.style.overflow
    }));
    assert(locked.html === 'hidden' && locked.body === 'hidden', 'expected both <html> and <body> to be scroll-locked while the overlay is open, got: ' + JSON.stringify(locked));
    console.log('PASS: host page is scroll-locked while the overlay is open —', JSON.stringify(locked));

    console.log('STEP 3: closing the overlay restores the host page\'s original overflow values');
    await frame.locator('#closeBtn').click();
    await page.waitForFunction(() => !document.getElementById('domain-atlas-overlay'), { timeout: 5000 });
    const restored = await page.evaluate(() => ({
      html: document.documentElement.style.overflow,
      body: document.body.style.overflow
    }));
    assert(restored.html === before.html && restored.body === before.body, 'expected overflow to be restored to its pre-overlay values ' + JSON.stringify(before) + ', got: ' + JSON.stringify(restored));
    console.log('PASS: host page scroll restored to its original state —', JSON.stringify(restored));

    console.log('STEP 4: a page that sets its OWN inline overflow gets that exact value back, not an empty string');
    await page.evaluate(() => {
      document.documentElement.style.overflow = 'scroll';
      document.body.style.overflow = 'auto';
    });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle2 = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame2 = await frameHandle2.contentFrame();
    await frame2.waitForFunction(() => document.getElementById('placeLabel').textContent.length > 0, { timeout: 10000 });
    const lockedAgain = await page.evaluate(() => ({
      html: document.documentElement.style.overflow,
      body: document.body.style.overflow
    }));
    assert(lockedAgain.html === 'hidden' && lockedAgain.body === 'hidden', 'expected a second open to lock scroll the same way, got: ' + JSON.stringify(lockedAgain));
    await frame2.locator('#closeBtn').click();
    await page.waitForFunction(() => !document.getElementById('domain-atlas-overlay'), { timeout: 5000 });
    const restoredAgain = await page.evaluate(() => ({
      html: document.documentElement.style.overflow,
      body: document.body.style.overflow
    }));
    assert(restoredAgain.html === 'scroll' && restoredAgain.body === 'auto', 'expected the page\'s own pre-existing inline overflow values to come back exactly, got: ' + JSON.stringify(restoredAgain));
    console.log('PASS: a page\'s own inline overflow styling is preserved across an open/close cycle, not clobbered —', JSON.stringify(restoredAgain));

    console.log('\nALL HOST PAGE SCROLL LOCK CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
    nodeProc.kill();
    try { fs.rmSync(NODE_STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(NODE_DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
