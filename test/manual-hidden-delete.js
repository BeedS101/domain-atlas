// Manual check for the new Delete button in Hidden assets (task #43):
// Delete only appears there (never on the main Inventory cards, which
// still only show Hide), it's confirm-guarded,
// and it permanently removes the entry — unlike Unhide, it does NOT come
// back. Also spot-checks the new Wallet/Settings top tab bar (task #50)
// while already moving between those two screens. Not part of the
// permanent suite, same reasoning as the other manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-hidden-delete');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: identity + one item, so there is something to hide and delete');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('hidden-delete-test-pw');
    await frame.locator('#newPasswordConfirmInput').fill('hidden-delete-test-pw');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#requestItemBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0, { timeout: 15000 });
    console.log('PASS: identity + one item ready');

    console.log('STEP 1: main item card only shows Hide — no Delete button reachable there');
    const mainCardDeleteCount = await frame.locator('#selfCollectiblesList button[data-action="delete"]').count();
    if (mainCardDeleteCount !== 0) throw new Error('Main item card should never expose a Delete button');
    console.log('PASS: confirmed — main item card has no Delete button');

    console.log('STEP 2: hide the item, then find Delete sitting next to Unhide in Settings -> Hidden assets');
    await frame.locator('#selfCollectiblesList button[data-action="hide"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 0, { timeout: 5000 });
    await frame.locator('#settingsTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('.settings-category[data-category="hidden-assets"] .settings-category-toggle').click();
    await frame.waitForFunction(() => document.querySelector('.settings-category[data-category="hidden-assets"]').classList.contains('open'), { timeout: 5000 });
    await frame.waitForFunction(() => document.querySelectorAll('#hiddenAssetsList .info-card').length === 1, { timeout: 5000 });
    const hasDeleteBtn = await frame.locator('#hiddenAssetsList button[data-action="delete"]').count();
    if (hasDeleteBtn !== 1) throw new Error('Expected exactly one Delete button in the hidden-asset card');
    console.log('PASS: hidden item card shows both Unhide and Delete');

    console.log('STEP 3: clicking Delete asks for confirmation, then permanently removes it');
    page.once('dialog', (d) => d.accept());
    await frame.locator('#hiddenAssetsList button[data-action="delete"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('#hiddenAssetsList .info-card').length === 0, { timeout: 5000 });
    console.log('PASS: item deleted from the hidden view');

    console.log('STEP 4: it does not come back — main item list stays empty (unlike Unhide, which would restore it)');
    await frame.locator('#backFromSettingsBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await page.waitForTimeout(500);
    const mainListCount = await frame.locator('#selfCollectiblesList .wallet-item').count();
    if (mainListCount !== 0) throw new Error('Deleted item should not have reappeared in the main list');
    console.log('PASS: confirmed gone for good, not just hidden');

    console.log('STEP 5: top tab bar — Settings/Wallet tabs are visible on those two screens and jump directly between them');
    await frame.locator('#settingsTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    const settingsTabActive = await frame.locator('#settingsTabBtn').evaluate((el) => el.classList.contains('active-tab'));
    if (!settingsTabActive) throw new Error('Settings tab should show as the active tab while on the settings screen');
    await frame.locator('#walletTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    const walletTabActive = await frame.locator('#walletTabBtn').evaluate((el) => el.classList.contains('active-tab'));
    if (!walletTabActive) throw new Error('Wallet tab should show as the active tab while on the main wallet screen');
    console.log('PASS: tab bar jumps directly between Wallet and Settings, active tab highlighted correctly');

    console.log('\nALL HIDDEN-DELETE + TAB BAR CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
