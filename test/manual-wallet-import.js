// Manual check for the new "Import wallet file" button — the counterpart
// to the existing "Export wallet" button. Exports a wallet with one
// non-fungible item and one fungible balance, wipes the local wallet
// cache (simulating a fresh device that still has the SAME identity
// unlocked — this is about restoring the credential cache, not identity),
// re-imports the file, and checks everything reappears, independently
// re-verified. Also checks that importing the same file twice is a
// harmless no-op (duplicates skipped) and that a credential owned by a
// different identity is not silently imported as this wallet's own.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-wallet-import');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox'
    ]
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: identity, one item, one resource balance');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('wallet-import-test-pw');
    await frame.locator('#newPasswordConfirmInput').fill('wallet-import-test-pw');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#requestItemBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0, { timeout: 15000 });
    await frame.locator('#mintIronBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 2, { timeout: 15000 });
    console.log('PASS: identity + 1 item + 1 resource balance ready');

    console.log('STEP 1: exporting the wallet — Export/Import wallet now live under Settings');
    await frame.locator('#settingsTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    // Settings categories are collapsed by default — open "Wallet backup" before using its export button.
    await frame.locator('.settings-category[data-category="wallet-backup"] .settings-category-toggle').click();
    await frame.waitForFunction(() => document.querySelector('.settings-category[data-category="wallet-backup"]').classList.contains('open'), { timeout: 5000 });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      frame.locator('#exportBtn').click()
    ]);
    const exportPath = path.resolve(__dirname, 'atlas-wallet-export.json');
    await download.saveAs(exportPath);
    console.log('PASS: wallet exported ->', exportPath);

    console.log('STEP 2: wiping the local asset cache (identity stays unlocked)');
    await frame.evaluate(async () => {
      await chrome.storage.local.remove(['atlasWallets']);
    });
    await frame.locator('#walletBtn').click();
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 0, { timeout: 5000 });
    console.log('PASS: wallet appears empty (cache cleared, identity untouched)');

    console.log('STEP 3: importing the exported file back — should restore both, independently re-verified');
    await frame.locator('#importWalletFileInput').setInputFiles(exportPath);
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 2, { timeout: 10000 });
    const importStatus1 = await frame.locator('#importWalletStatus').textContent();
    if (!importStatus1.includes('2 asset(s) added')) {
      throw new Error('Unexpected import status: ' + importStatus1);
    }
    const restoredVerdicts = await frame.locator('#selfCollectiblesList .wallet-item .verdict').allTextContents();
    if (!restoredVerdicts.every((v) => v.includes('✓'))) throw new Error('A restored asset did not re-verify: ' + restoredVerdicts.join(', '));
    console.log('PASS: import restored the item and resource balance, both re-verified ->', importStatus1.trim());

    console.log('STEP 4: importing the SAME file again — should be a no-op (duplicates skipped)');
    await frame.locator('#importWalletFileInput').setInputFiles(exportPath);
    await frame.waitForFunction(() => document.getElementById('importWalletStatus').textContent.includes('already in this wallet'), { timeout: 5000 });
    const importStatus2 = await frame.locator('#importWalletStatus').textContent();
    const itemCountAfterReimport = await frame.locator('#selfCollectiblesList .wallet-item').count();
    if (itemCountAfterReimport !== 2) throw new Error('Re-importing duplicated an asset instead of skipping it, count=' + itemCountAfterReimport);
    console.log('PASS: re-importing the same file skipped duplicates, no double-counting ->', importStatus2.trim());

    console.log('STEP 5: a credential owned by a DIFFERENT identity should not be importable as this wallet\'s own');
    const fs = require('fs');
    const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    const foreignExport = JSON.parse(JSON.stringify(exported));
    foreignExport.credentials.forEach((c) => { c.id = c.id + '-foreign'; c.owner = { publicKey: 'not-actually-your-key' }; });
    const foreignPath = path.resolve(__dirname, 'atlas-wallet-export-foreign.json');
    fs.writeFileSync(foreignPath, JSON.stringify(foreignExport));
    await frame.locator('#importWalletFileInput').setInputFiles(foreignPath);
    await frame.waitForFunction(() => document.getElementById('importWalletStatus').textContent.includes('different identity'), { timeout: 5000 });
    const itemCountAfterForeign = await frame.locator('#selfCollectiblesList .wallet-item').count();
    if (itemCountAfterForeign !== 2) throw new Error('A foreign-owned credential was imported as this wallet\'s own, count=' + itemCountAfterForeign);
    console.log('PASS: foreign-owned credentials were skipped, not absorbed into this wallet ->', (await frame.locator('#importWalletStatus').textContent()).trim());
    fs.unlinkSync(foreignPath);

    console.log('\nALL WALLET IMPORT CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
