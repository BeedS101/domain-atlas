// Manual check for four small wallet UI fixes (#53, #54, #55 — #56 is
// covered by manual-subscribe-flow.js's updated assertions):
//   #53 — the mail check-frequency input is labeled with its unit (minutes)
//   #54 — the redundant bottom "⚙ Settings" button is gone (Settings tab
//         at the top is the only way in now)
//   #55 — opening the wallet to the unlock screen focuses the password
//         field automatically
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-ui-fixes');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: identity, so there is a locked wallet to reopen later');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('ui-fixes-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('ui-fixes-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    console.log('PASS: identity ready');

    console.log('#53: mail check-frequency input is labeled with its unit');
    await frame.locator('#socialTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
    const intervalRowText = await frame.locator('#mailIntervalInput').locator('xpath=..').textContent();
    if (!intervalRowText.toLowerCase().includes('minute')) throw new Error('Expected "minutes" to appear next to the interval input: ' + intervalRowText);
    console.log('PASS: interval input labeled ->', intervalRowText.trim());

    console.log('#54: no redundant bottom Settings button anywhere in the wallet panel');
    const oldBtnCount = await frame.locator('#openSettingsBtn').count();
    if (oldBtnCount !== 0) throw new Error('Expected #openSettingsBtn to be gone entirely, found ' + oldBtnCount);
    const oldFooterCount = await frame.locator('#walletPanelFooter').count();
    if (oldFooterCount !== 0) throw new Error('Expected #walletPanelFooter to be gone entirely, found ' + oldFooterCount);
    // Settings must still be reachable — just only via the top tab now.
    await frame.locator('#settingsTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    console.log('PASS: old button/footer gone, Settings still reachable via the top tab');

    console.log('#55: locking and reopening the wallet auto-focuses the password field');
    await frame.evaluate(async () => { await AtlasWallet.lockIdentity(); });
    // Close and reopen the wallet panel via the Wallet button, same as a
    // real click sequence — routeWalletScreen() is what does the focusing.
    await frame.locator('#walletBtn').click(); // close (it was left open)
    await frame.locator('#walletBtn').click(); // reopen -> routes to unlockScreen
    await frame.waitForFunction(() => document.getElementById('unlockScreen').classList.contains('active'), { timeout: 5000 });
    const isFocused = await frame.evaluate(() => document.activeElement && document.activeElement.id === 'unlockPasswordInput');
    if (!isFocused) throw new Error('Expected #unlockPasswordInput to be the focused element on reopening a locked wallet');
    console.log('PASS: password field auto-focused on reopening a locked wallet');

    console.log('\nALL WALLET UI-FIX CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
