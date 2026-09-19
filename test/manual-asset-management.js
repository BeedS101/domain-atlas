// Manual check for the new per-asset management options: hiding a
// non-fungible item or a fungible balance from the local wallet view
// (reversible, via Settings -> Hidden assets), and consolidating multiple
// same-class/same-issuer fungible balances into one via the
// /atlas/asset/consolidate issuer endpoint. Not part of the permanent
// suite for the same reason the other manual-*.js scripts aren't — kept
// here as a throwaway, targeted check.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

// Task #211 moved every per-card action (Send half/Load/Simulate loss/
// Drop/Hide) on a .wallet-item asset card behind that card's own "⋯"
// menu, collapsed by default — clicking an action button directly (what
// this file used to do for "hide") no longer works since it starts out
// hidden. Opens the containing card's menu first, waits for the popover
// to actually show, then clicks the real action button inside it — same
// two-step a person would do by hand. Not needed for #hiddenAssetsList's
// own "unhide" buttons — those live on .info-card, not .wallet-item, and
// keep their always-visible action row unchanged.
async function clickCardMenuAction(actionLocator) {
  const card = actionLocator.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " wallet-item ")][1]');
  await card.locator('.card-menu-toggle').click();
  await card.locator('.card-menu-items.show').waitFor({ state: 'visible', timeout: 3000 });
  await actionLocator.click();
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-asset-mgmt');
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

    console.log('SETUP: identity + item, so there is something to delete');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('asset-management-test-pw');
    await frame.locator('#newPasswordConfirmInput').fill('asset-management-test-pw');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#requestItemBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0, { timeout: 15000 });
    console.log('PASS: identity + one item ready');

    console.log('STEP 1: settings screen holds the identity switch, lock, and backup controls, reachable from the main wallet screen');
    await frame.locator('#settingsTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    const hasSwitchBtn = await frame.locator('#switchIdentityModeBtn').count();
    const hasLockBtn = await frame.locator('#lockWalletBtn').count();
    const hasExportBtn = await frame.locator('#exportIdentityBtn').count();
    if (!hasSwitchBtn || !hasLockBtn || !hasExportBtn) throw new Error('Settings screen is missing expected controls');
    console.log('PASS: identity switch, lock, and backup all live under Settings');
    await frame.locator('#backFromSettingsBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    console.log('PASS: back from Settings returns to the main wallet screen');

    console.log('STEP 2: hiding the item — no confirm dialog (reversible), disappears from the main view but shows up in Settings');
    await clickCardMenuAction(frame.locator('#selfCollectiblesList button[data-action="hide"]'));
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 0, { timeout: 5000 });
    console.log('PASS: item removed from the main wallet view after hiding');

    await frame.locator('#settingsTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    // Settings categories are collapsed by default — open "Hidden assets" before checking its contents.
    await frame.locator('.settings-category[data-category="hidden-assets"] .settings-category-toggle').click();
    await frame.waitForFunction(() => document.querySelector('.settings-category[data-category="hidden-assets"]').classList.contains('open'), { timeout: 5000 });
    await frame.waitForFunction(() => document.querySelectorAll('#hiddenAssetsList .info-card').length === 1, { timeout: 5000 });
    console.log('PASS: hidden item is listed under Settings -> Hidden assets');

    await frame.locator('#hiddenAssetsList button[data-action="unhide"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('#hiddenAssetsList .info-card').length === 0, { timeout: 5000 });
    await frame.locator('#backFromSettingsBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 1, { timeout: 5000 });
    const unhiddenVerdict = await frame.locator('#selfCollectiblesList .wallet-item .verdict').textContent();
    if (!unhiddenVerdict.includes('✓')) throw new Error('Unhidden item did not still verify: ' + unhiddenVerdict);
    console.log('PASS: unhiding brought the item back to the main view, still verifying fine');

    console.log('STEP 2b: hiding it again, so STEP 3 starts from the same empty-list baseline as before');
    await clickCardMenuAction(frame.locator('#selfCollectiblesList button[data-action="hide"]'));
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 0, { timeout: 5000 });

    console.log('STEP 3: minting iron twice — should auto-consolidate into ONE balance, no manual click needed');
    // Task #211 removed the dev-only "Mine 20 iron (self)" Settings button
    // — mints the same way its handler used to: AtlasWallet.mintAsset()
    // (which itself awaits autoConsolidateAssetWallet() internally), then
    // the same refreshInventoryDisplay() call, awaited here in the test
    // instead of inferred from a button's disabled state.
    await frame.evaluate(async () => { await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.element.iron', 20); await refreshInventoryDisplay(); });
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length >= 1, { timeout: 15000 });
    await frame.evaluate(async () => { await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.element.iron', 20); await refreshInventoryDisplay(); });
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 1, { timeout: 15000 });
    const mergedName = await frame.locator('#selfCollectiblesList .wallet-item .name').textContent();
    if (!mergedName.includes('Iron (Fe) ×40 g')) throw new Error('Expected a single 40-iron balance after auto-consolidating, got: ' + mergedName);
    const mergedMeta = await frame.locator('#selfCollectiblesList .wallet-item .meta').textContent();
    if (!mergedMeta.includes('consolidated from 2 balances')) throw new Error('Expected the merged balance to note it was consolidated from 2, got: ' + mergedMeta);
    const mergedVerdict = await frame.locator('#selfCollectiblesList .wallet-item .verdict').textContent();
    if (!mergedVerdict.includes('✓')) throw new Error('Merged balance did not verify: ' + mergedVerdict);
    const groupHeaderVisible = await frame.locator('#selfCollectiblesList .resource-group-header').count();
    if (groupHeaderVisible) throw new Error('A group header should not appear — there is nothing left to manually consolidate');
    console.log('PASS: two 20-iron mints auto-merged into one real, issuer-signed 40-iron balance, no button click ->', mergedName.trim(), '/', mergedMeta.trim());

    console.log('STEP 4: minting a third time — should auto-merge into the existing balance again (40 -> 60)');
    await frame.evaluate(async () => { await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.element.iron', 20); await refreshInventoryDisplay(); });
    await frame.waitForFunction(() => {
      const name = document.querySelector('#selfCollectiblesList .wallet-item .name');
      return document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 1 && name && name.textContent.includes('Iron (Fe) ×60 g');
    }, { timeout: 15000 });
    console.log('PASS: a third mint merged straight into the running total -> Iron (Fe) ×60 g');

    console.log('STEP 5: hiding the merged resource balance too — no confirm dialog (reversible), disappears from the main view but shows up in Settings, same as items in STEP 2');
    await clickCardMenuAction(frame.locator('#selfCollectiblesList button[data-action="hide"]'));
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 0, { timeout: 5000 });
    console.log('PASS: resource balance removed from the main wallet view after hiding');

    await frame.locator('#settingsTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    // "Hidden assets" is a single unified accordion now — items and fungible
    // balances both land here (was two separate accordions pre-unification),
    // and it was already opened once in STEP 2, so its open/closed state
    // persists across this second visit to Settings — only click the toggle
    // if it isn't already open, or the click would close it instead.
    const hiddenAssetsAlreadyOpen = await frame.locator('.settings-category[data-category="hidden-assets"].open').count();
    if (!hiddenAssetsAlreadyOpen) {
      await frame.locator('.settings-category[data-category="hidden-assets"] .settings-category-toggle').click();
    }
    await frame.waitForFunction(() => document.querySelector('.settings-category[data-category="hidden-assets"]').classList.contains('open'), { timeout: 5000 });
    // Two entries here, not one: the Bronze Compass has stayed hidden ever
    // since STEP 2b re-hid it (it's never unhidden again after that), and
    // now the Iron (Fe) balance joins it — proving the unified list really
    // does hold both a non-fungible item and a fungible balance together.
    await frame.waitForFunction(() => document.querySelectorAll('#hiddenAssetsList .info-card').length === 2, { timeout: 5000 });
    const hiddenListText = await frame.locator('#hiddenAssetsList').textContent();
    if (!hiddenListText.includes('Bronze Compass') || !hiddenListText.includes('Iron (Fe)')) {
      throw new Error('Expected both the hidden item and the hidden resource balance listed together: ' + hiddenListText);
    }
    console.log('PASS: hidden item and hidden resource balance both listed together under Settings -> Hidden assets');

    // Unhide only the Iron (Fe) card — the Bronze Compass card must stay put.
    await frame.locator('#hiddenAssetsList .info-card', { hasText: 'Iron (Fe)' }).locator('button[data-action="unhide"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('#hiddenAssetsList .info-card').length === 1, { timeout: 5000 });
    const stillHiddenText = await frame.locator('#hiddenAssetsList').textContent();
    if (!stillHiddenText.includes('Bronze Compass')) throw new Error('Bronze Compass should still be hidden: ' + stillHiddenText);
    if (stillHiddenText.includes('Iron (Fe)')) throw new Error('Iron (Fe) should no longer be in the hidden list: ' + stillHiddenText);
    await frame.locator('#backFromSettingsBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 1, { timeout: 5000 });
    const stillOnlyResource = await frame.locator('#selfCollectiblesList').textContent();
    if (stillOnlyResource.includes('Bronze Compass')) throw new Error('Bronze Compass should stay hidden from the main view: ' + stillOnlyResource);
    const unhiddenResourceVerdict = await frame.locator('#selfCollectiblesList .wallet-item .verdict').textContent();
    if (!unhiddenResourceVerdict.includes('✓')) throw new Error('Unhidden resource balance did not still verify: ' + unhiddenResourceVerdict);
    console.log('PASS: unhiding just the resource balance brought it back to the main view, still verifying fine, while the item stayed hidden — Hide is the resource card\'s only action now, matching items');

    console.log('\nALL ASSET-MANAGEMENT CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
