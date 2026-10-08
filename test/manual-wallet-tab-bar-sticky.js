// Verifies the Wallet/Social/Trade/Settings tab bar (#walletTabBar) stays
// pinned to the top of the wallet panel while a long screen underneath it
// scrolls — see viewer.html's own comment on #walletTabBar/
// #walletPanelContent for the CSS approach (position: sticky within
// #walletPanel's own scroll area, with the panel's former all-sides
// padding moved onto #walletPanelContent so the bar can sit flush with the
// panel's true top edge).
//
// Settings is used as the tall screen to scroll, since it has by far the
// most collapsible categories of any wallet screen — plenty tall enough to
// actually scroll in a normal-height viewport without needing to shrink
// the window.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PORT = 8150; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://' + NODE_DOMAIN;
const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-tabbar-sticky-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-tabbar-sticky-docroot-'));
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

  const userDataDir = path.resolve(__dirname, '.chrome-profile-tabbar-sticky');
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

    console.log('STEP 1: create an identity and open Settings');
    await page.goto(NODE_BASE, { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.length > 0, null, { timeout: 10000 });

    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('onboardingChoiceScreen').classList.contains('active'), null, { timeout: 5000 });
    await frame.locator('#chooseNewBtn').click();
    await frame.waitForFunction(() => document.getElementById('createScreen').classList.contains('active'), null, { timeout: 5000 });
    await frame.locator('#newPasswordInput').fill('tabbar-sticky-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('tabbar-sticky-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });

    await frame.locator('#settingsTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), null, { timeout: 5000 });
    console.log('PASS: on the Settings screen, tab bar should now be visible');

    const barVisible = await frame.evaluate(() => document.getElementById('walletTabBar').classList.contains('visible'));
    assert(barVisible, 'expected the tab bar to be visible on the Settings screen');

    console.log('STEP 2: open every collapsible category so the screen is unambiguously tall enough to scroll');
    await frame.evaluate(() => {
      document.querySelectorAll('#settingsScreen .settings-category').forEach((el) => el.classList.add('open'));
    });

    const before = await frame.evaluate(() => {
      const panel = document.getElementById('walletPanel');
      const bar = document.getElementById('walletTabBar');
      const rect = bar.getBoundingClientRect();
      return { scrollTop: panel.scrollTop, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight, barTop: rect.top, barLeft: rect.left };
    });
    assert(before.scrollHeight > before.clientHeight + 100, 'expected Settings, fully expanded, to be meaningfully taller than the panel — got scrollHeight ' + before.scrollHeight + ' vs clientHeight ' + before.clientHeight);
    assert(before.barTop === 56, 'expected the tab bar to start flush with the panel (top: 56px in this layout), got ' + before.barTop);
    console.log('PASS: Settings is tall enough to scroll (scrollHeight ' + before.scrollHeight + ' vs clientHeight ' + before.clientHeight + '), tab bar starts at the panel\'s top edge');

    console.log('STEP 3: scroll the panel most of the way down');
    const scrollAmount = before.scrollHeight - before.clientHeight - 40;
    await frame.evaluate((amount) => { document.getElementById('walletPanel').scrollTop = amount; }, scrollAmount);
    const after = await frame.evaluate(() => {
      const panel = document.getElementById('walletPanel');
      const bar = document.getElementById('walletTabBar');
      const rect = bar.getBoundingClientRect();
      return { scrollTop: panel.scrollTop, barTop: rect.top, barLeft: rect.left };
    });
    assert(after.scrollTop > scrollAmount - 5, 'expected the panel to have actually scrolled, got scrollTop ' + after.scrollTop + ' (asked for ' + scrollAmount + ')');
    assert(after.barTop === before.barTop, 'expected the tab bar\'s on-screen position to be UNCHANGED after scrolling (sticky), but it moved from ' + before.barTop + ' to ' + after.barTop);
    assert(after.barLeft === before.barLeft, 'expected the tab bar\'s horizontal position to be unchanged too, got ' + before.barLeft + ' -> ' + after.barLeft);
    console.log('PASS: after scrolling ' + after.scrollTop + 'px, the tab bar stayed exactly in place —', after.barTop, '===', before.barTop);

    console.log('STEP 4: the tab bar is still visibly on top and clickable after scrolling, not covered by scrolled-under content');
    await frame.locator('#walletTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    console.log('PASS: clicking "Wallet" in the sticky bar, post-scroll, correctly switched screens');

    console.log('\nALL WALLET TAB BAR STICKINESS CHECKS PASSED');
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
