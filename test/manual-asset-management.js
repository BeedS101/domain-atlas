// Manual check for the new per-asset management options: deleting an item
// or resource balance from the local wallet view, and consolidating
// multiple same-class/same-issuer resource balances into one via the new
// /atlas/resource/consolidate issuer endpoint. Not part of the permanent
// suite for the same reason the other manual-*.js scripts aren't — kept
// here as a throwaway, targeted check.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

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
    await frame.waitForFunction(() => document.querySelectorAll('#selfItemsList .wallet-item').length > 0, { timeout: 15000 });
    console.log('PASS: identity + one item ready');

    console.log('STEP 1: settings screen holds the identity switch, lock, and backup controls, reachable from the main wallet screen');
    await frame.locator('#openSettingsBtn').click();
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
    await frame.locator('#selfItemsList button[data-action="hide"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfItemsList .wallet-item').length === 0, { timeout: 5000 });
    console.log('PASS: item removed from the main wallet view after hiding');

    await frame.locator('#openSettingsBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    // Settings categories are collapsed by default — open "Hidden items" before checking its contents.
    await frame.locator('.settings-category[data-category="hidden-items"] .settings-category-toggle').click();
    await frame.waitForFunction(() => document.querySelector('.settings-category[data-category="hidden-items"]').classList.contains('open'), { timeout: 5000 });
    await frame.waitForFunction(() => document.querySelectorAll('#hiddenItemsList .info-card').length === 1, { timeout: 5000 });
    console.log('PASS: hidden item is listed under Settings -> Hidden items');

    await frame.locator('#hiddenItemsList button[data-action="unhide"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('#hiddenItemsList .info-card').length === 0, { timeout: 5000 });
    await frame.locator('#backFromSettingsBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.waitForFunction(() => document.querySelectorAll('#selfItemsList .wallet-item').length === 1, { timeout: 5000 });
    const unhiddenVerdict = await frame.locator('#selfItemsList .wallet-item .verdict').textContent();
    if (!unhiddenVerdict.includes('✓')) throw new Error('Unhidden item did not still verify: ' + unhiddenVerdict);
    console.log('PASS: unhiding brought the item back to the main view, still verifying fine');

    console.log('STEP 2b: hiding it again, so STEP 3 starts from the same empty-list baseline as before');
    await frame.locator('#selfItemsList button[data-action="hide"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfItemsList .wallet-item').length === 0, { timeout: 5000 });

    console.log('STEP 3: minting iron twice — should auto-consolidate into ONE balance, no manual click needed');
    // mintIronBtn is disabled (and re-labeled "Mining…") for the duration of each mint,
    // including the awaited autoConsolidateResourceWallet() call inside mintResource() —
    // so waiting for the button to re-enable is the reliable signal that a given mint
    // (and any merge it triggered) has fully landed in the DOM before the next click.
    await frame.locator('#mintIronBtn').click();
    await frame.waitForFunction(() => document.getElementById('mintIronBtn').disabled === true, { timeout: 5000 }).catch(() => {});
    await frame.waitForFunction(() => document.getElementById('mintIronBtn').disabled === false, { timeout: 15000 });
    await frame.waitForFunction(() => document.querySelectorAll('#selfResourceList .wallet-item').length >= 1, { timeout: 15000 });
    await frame.locator('#mintIronBtn').click();
    await frame.waitForFunction(() => document.getElementById('mintIronBtn').disabled === true, { timeout: 5000 }).catch(() => {});
    await frame.waitForFunction(() => document.getElementById('mintIronBtn').disabled === false, { timeout: 15000 });
    await frame.waitForFunction(() => document.querySelectorAll('#selfResourceList .wallet-item').length === 1, { timeout: 15000 });
    const mergedName = await frame.locator('#selfResourceList .wallet-item .name').textContent();
    if (!mergedName.includes('40') || !mergedName.includes('atlas.element.iron')) throw new Error('Expected a single 40-iron balance after auto-consolidating, got: ' + mergedName);
    const mergedMeta = await frame.locator('#selfResourceList .wallet-item .meta').textContent();
    if (!mergedMeta.includes('consolidated from 2 balances')) throw new Error('Expected the merged balance to note it was consolidated from 2, got: ' + mergedMeta);
    const mergedVerdict = await frame.locator('#selfResourceList .wallet-item .verdict').textContent();
    if (!mergedVerdict.includes('✓')) throw new Error('Merged balance did not verify: ' + mergedVerdict);
    const groupHeaderVisible = await frame.locator('#selfResourceList .resource-group-header').count();
    if (groupHeaderVisible) throw new Error('A group header should not appear — there is nothing left to manually consolidate');
    console.log('PASS: two 20-iron mints auto-merged into one real, issuer-signed 40-iron balance, no button click ->', mergedName.trim(), '/', mergedMeta.trim());

    console.log('STEP 4: minting a third time — should auto-merge into the existing balance again (40 -> 60)');
    await frame.locator('#mintIronBtn').click();
    await frame.waitForFunction(() => document.getElementById('mintIronBtn').disabled === true, { timeout: 5000 }).catch(() => {});
    await frame.waitForFunction(() => document.getElementById('mintIronBtn').disabled === false, { timeout: 15000 });
    await frame.waitForFunction(() => {
      const name = document.querySelector('#selfResourceList .wallet-item .name');
      return document.querySelectorAll('#selfResourceList .wallet-item').length === 1 && name && name.textContent.includes('60');
    }, { timeout: 15000 });
    console.log('PASS: a third mint merged straight into the running total -> 60 × atlas.element.iron');

    console.log('STEP 5: deleting the merged resource balance too');
    page.once('dialog', (d) => d.accept());
    await frame.locator('#selfResourceList button[data-action="delete"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfResourceList .wallet-item').length === 0, { timeout: 5000 });
    console.log('PASS: resource balance removed from the local wallet view after confirming');

    console.log('\nALL ASSET-MANAGEMENT CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
