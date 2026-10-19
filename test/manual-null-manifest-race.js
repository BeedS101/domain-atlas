// Regression check: refreshInventoryDisplay() runs once, unawaited, as soon as
// viewer.js parses — before loadManifest() has resolved and set
// currentManifest/currentWorld (both start out null). For a returning
// identity already in chrome.storage.local, the refresh must tolerate both
// being null instead of throwing an uncaught rejection. Whether the real race
// fires depends on timing, so this forces the state directly: create an
// identity, reset currentManifest/currentWorld to null and call
// refreshInventoryDisplay() from the page. Not part of the permanent suite,
// same reasoning as the other manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-null-manifest-race');
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

    console.log('SETUP: creating an identity (a returning user is what makes refreshInventoryDisplay() actually reach the vulnerable line)');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('race-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('race-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    console.log('PASS: identity created');

    console.log('STEP 1: forcing currentManifest/currentWorld back to null (the state they hold before loadManifest() resolves) and calling refreshInventoryDisplay() directly, the same unguarded call viewer.js makes at parse time');
    // currentManifest/currentWorld/refreshInventoryDisplay are bare top-level
    // identifiers in viewer.js's classic <script> — reachable directly here,
    // not via window.*, per the same gotcha noted in manual-drop-pickup.js.
    const result = await frame.evaluate(async () => {
      currentManifest = null;
      currentWorld = null;
      try {
        await refreshInventoryDisplay();
        return { ok: true };
      } catch (err) {
        return { ok: false, message: err.message };
      }
    });
    if (!result.ok) {
      throw new Error('refreshInventoryDisplay() threw with a null manifest/world: ' + result.message);
    }
    console.log('PASS: refreshInventoryDisplay() tolerated a null manifest/world instead of throwing');

    console.log('\nALL NULL-MANIFEST RACE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
