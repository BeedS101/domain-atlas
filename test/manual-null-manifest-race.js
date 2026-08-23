// Regression check for a null-pointer race the drop/pick-up feature
// introduced: refreshItemsDisplay() runs once, unawaited, as soon as
// viewer.js parses (bottom of the file) — BEFORE loadManifest()'s fetch
// has resolved and set currentManifest/currentWorld (both start out
// `null`, see their declarations near the top of viewer.js). For a
// brand-new identity that's harmless (identity is falsy, so the
// dropped-items lookup is skipped entirely) but for a RETURNING identity —
// already sitting in chrome.storage.local from a previous page load — it
// reaches manifestDomainOf(currentManifest)/currentWorld.id while both are
// still null, throwing "Cannot read properties of null (reading 'domain')"
// as an uncaught promise rejection. This is exactly the error a real user
// hit; whether it fires in practice is a timing race between two sets of
// async chrome.storage.local calls and one network fetch, so instead of
// hoping to win that race under Playwright/localhost's much faster and
// more consistent timing, this forces the exact moment directly: create an
// identity, then reset currentManifest/currentWorld to null (simulating
// "the manifest fetch hasn't resolved yet") and call refreshItemsDisplay()
// straight from the page, the same way the bottom of viewer.js does. Not
// part of the permanent suite, same reasoning as the other manual-*.js
// scripts.

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

    console.log('SETUP: creating an identity (a returning user is what makes refreshItemsDisplay() actually reach the vulnerable line)');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('race-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('race-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    console.log('PASS: identity created');

    console.log('STEP 1: forcing currentManifest/currentWorld back to null (the state they hold before loadManifest() resolves) and calling refreshItemsDisplay() directly, the same unguarded call viewer.js makes at parse time');
    // currentManifest/currentWorld/refreshItemsDisplay are bare top-level
    // identifiers in viewer.js's classic <script> — reachable directly here,
    // not via window.*, per the same gotcha noted in manual-drop-pickup.js.
    const result = await frame.evaluate(async () => {
      currentManifest = null;
      currentWorld = null;
      try {
        await refreshItemsDisplay();
        return { ok: true };
      } catch (err) {
        return { ok: false, message: err.message };
      }
    });
    if (!result.ok) {
      throw new Error('refreshItemsDisplay() threw with a null manifest/world: ' + result.message);
    }
    console.log('PASS: refreshItemsDisplay() tolerated a null manifest/world instead of throwing');

    console.log('\nALL NULL-MANIFEST RACE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
