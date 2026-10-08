// Verifies the browser's own right-click ("Inspect"/"Reload"/"Save image
// as") menu is suppressed across the wallet panel and the 2D scene canvas
// — see viewer.js's own comment on the window-level 'contextmenu' listener
// for why (nothing in either surface does anything with a right click) and
// the one carve-out (text inputs/textareas keep it, for paste/spellcheck).
//
// Dispatches a synthetic, cancelable 'contextmenu' event directly on each
// target element rather than driving a real OS right-click (Playwright has
// no way to observe whether the browser's native menu actually appeared) —
// dispatchEvent()'s own return value (false once something calls
// preventDefault() during dispatch) is the correct, direct signal for
// "was this suppressed," and the event still bubbles up to the real
// window-level listener under test exactly as a genuine right-click would.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PORT = 8152; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://' + NODE_DOMAIN;
const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ctxmenu-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ctxmenu-docroot-'));
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

  const userDataDir = path.resolve(__dirname, '.chrome-profile-ctxmenu');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox'
    ]
  });

  function dispatchContextMenu(handle) {
    return handle.evaluate((el) => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      return el.dispatchEvent(event); // false once something called preventDefault()
    });
  }

  try {
    const page = await context.newPage();

    console.log('STEP 1: create an identity so the wallet panel and its inputs are reachable');
    await page.goto(NODE_BASE, { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.length > 0, null, { timeout: 10000 });

    console.log('STEP 2: right-clicking the 2D scene canvas is suppressed');
    const canvasNotDefaulted = await dispatchContextMenu(frame.locator('#scene'));
    assert(canvasNotDefaulted === false, 'expected the 2D scene canvas\'s contextmenu event to have been prevented, dispatchEvent returned ' + canvasNotDefaulted);
    console.log('PASS: the 2D scene canvas suppresses the browser\'s own right-click menu');

    console.log('STEP 3: right-clicking inside the wallet panel (once open) is suppressed');
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('onboardingChoiceScreen').classList.contains('active'), null, { timeout: 5000 });
    const panelNotDefaulted = await dispatchContextMenu(frame.locator('#walletPanel'));
    assert(panelNotDefaulted === false, 'expected the wallet panel\'s contextmenu event to have been prevented, dispatchEvent returned ' + panelNotDefaulted);
    console.log('PASS: the wallet panel suppresses the browser\'s own right-click menu');

    console.log('STEP 4: right-clicking a text input inside the wallet is NOT suppressed — paste/spellcheck should still work');
    const inputNotDefaulted = await dispatchContextMenu(frame.locator('#newPasswordInput'));
    assert(inputNotDefaulted === true, 'expected a text input\'s contextmenu event to be left alone, dispatchEvent returned ' + inputNotDefaulted);
    console.log('PASS: a text input inside the wallet keeps its normal right-click menu');

    console.log('\nALL CONTEXT MENU SUPPRESSION CHECKS PASSED');
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
