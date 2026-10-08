// Manual check for the #151 follow-up: "only show items compatible with
// this domain" on Inventory's Collectibles and Documents subscreens used
// to reset to unchecked on every login/reload — the checkbox's .checked
// was pure in-memory DOM state with nothing saving it anywhere. Fixed by
// a new device-level setting (AtlasWallet.getInventoryFilterSettings()/
// setInventoryFilterSettings(), wallet.js — same clamp-on-read-and-write,
// patch-based shape as getAssetViewerSettings()/setAssetViewerSettings())
// that viewer.js now restores on load and writes on every checkbox
// 'change', same reload-persistence pattern manual-asset-viewer.js's own
// STEP 8 already established for that panel's settings.
//
// Collectibles and Documents are each other's negative control here:
// checking one and reloading must leave the OTHER exactly as it was,
// proving the two checkboxes (and the two settings fields backing them)
// are independent rather than accidentally sharing one flag.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts. Assumes issuer-server is already running on 8001
// (see README §1) — domain B isn't needed here.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-inventory-filter-persistence');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: fresh identity in Example Plaza');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    let frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('inventory-filter-persist-pw');
    await frame.locator('#newPasswordConfirmInput').fill('inventory-filter-persist-pw');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    console.log('PASS: identity created, wallet open');

    console.log('STEP 1: before touching either checkbox, the persisted setting defaults both to false');
    const defaults = await frame.evaluate(() => AtlasWallet.getInventoryFilterSettings());
    if (defaults.collectiblesCompatOnly !== false || defaults.documentsCompatOnly !== false) {
      throw new Error('Expected both flags to default to false, got: ' + JSON.stringify(defaults));
    }
    console.log('PASS: defaults are both false');

    console.log('STEP 2: checking Collectibles\' checkbox persists immediately, Documents\' stays untouched');
    await frame.locator('#collectiblesSubtabBtn').click();
    await frame.locator('#collectiblesCompatOnlyCheckbox').check();
    await frame.page().waitForTimeout(200); // let setInventoryFilterSettings()/chrome.storage round-trip settle, same margin manual-asset-viewer.js's STEP 8 uses
    const afterCollectiblesCheck = await frame.evaluate(() => AtlasWallet.getInventoryFilterSettings());
    if (afterCollectiblesCheck.collectiblesCompatOnly !== true) throw new Error('Expected collectiblesCompatOnly to be persisted true, got: ' + JSON.stringify(afterCollectiblesCheck));
    if (afterCollectiblesCheck.documentsCompatOnly !== false) throw new Error('Expected documentsCompatOnly to remain false (independent flag), got: ' + JSON.stringify(afterCollectiblesCheck));
    console.log('PASS: collectiblesCompatOnly=true persisted, documentsCompatOnly untouched');

    console.log('STEP 3: reloading the page restores Collectibles\' checkbox to checked, Documents\' stays unchecked');
    await page.reload({ waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle2 = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    frame = await frameHandle2.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });
    // No AtlasWallet.unlockIdentity() call here — a fresh-local-identity
    // reload is exactly the "resets on login" symptom reported (a panel
    // reopening, re-rendering the Inventory screen from scratch), and
    // Inventory is its own always-open settings-category under the main
    // Wallet screen (see viewer.html), reachable the same way
    // manual-world-compatibility.js reaches it — no separate tab click.
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('collectiblesCompatOnlyCheckbox') !== null, null, { timeout: 5000 });
    await frame.page().waitForTimeout(300); // let AtlasWallet.getInventoryFilterSettings().then(...) run at startup
    const checkboxStateAfterReload = await frame.evaluate(() => ({
      collectibles: document.getElementById('collectiblesCompatOnlyCheckbox').checked,
      documents: document.getElementById('documentsCompatOnlyCheckbox').checked
    }));
    if (checkboxStateAfterReload.collectibles !== true) throw new Error('Expected the Collectibles checkbox to still be checked after reload, got: ' + JSON.stringify(checkboxStateAfterReload));
    if (checkboxStateAfterReload.documents !== false) throw new Error('Expected the Documents checkbox to remain unchecked after reload, got: ' + JSON.stringify(checkboxStateAfterReload));
    console.log('PASS: Collectibles checkbox survived the reload, Documents stayed independent');

    console.log('STEP 4: checking Documents\' checkbox now too, reloading again, both must come back checked');
    await frame.locator('#documentsSubtabBtn').click();
    await frame.locator('#documentsCompatOnlyCheckbox').check();
    await frame.page().waitForTimeout(200);
    const afterBothChecked = await frame.evaluate(() => AtlasWallet.getInventoryFilterSettings());
    if (afterBothChecked.collectiblesCompatOnly !== true || afterBothChecked.documentsCompatOnly !== true) {
      throw new Error('Expected both flags true before this second reload, got: ' + JSON.stringify(afterBothChecked));
    }

    await page.reload({ waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle3 = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    frame = await frameHandle3.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('collectiblesCompatOnlyCheckbox') !== null, null, { timeout: 5000 });
    await frame.page().waitForTimeout(300);
    const checkboxStateAfterSecondReload = await frame.evaluate(() => ({
      collectibles: document.getElementById('collectiblesCompatOnlyCheckbox').checked,
      documents: document.getElementById('documentsCompatOnlyCheckbox').checked
    }));
    if (!checkboxStateAfterSecondReload.collectibles || !checkboxStateAfterSecondReload.documents) {
      throw new Error('Expected BOTH checkboxes to survive this reload, got: ' + JSON.stringify(checkboxStateAfterSecondReload));
    }
    console.log('PASS: both checkboxes independently survived their own reload');

    console.log('STEP 5: the restored checkbox state is actually APPLIED to the Collectibles filter, not just sitting in storage');
    // Mints one compatible (Bronze Compass) and one incompatible (mined
    // iron) item so there is something for the still-checked filter to
    // actually hide, same two catalog items manual-world-compatibility.js
    // uses for the same reason.
    await frame.locator('#collectiblesSubtabBtn').click();
    await frame.locator('#requestItemBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0, null, { timeout: 15000 });
    await frame.evaluate(async () => { await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.element.iron', 20); await refreshInventoryDisplay(); });
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item, #selfCollectiblesList .resource-group-header').length >= 2, null, { timeout: 15000 });
    const cardState = await frame.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item'));
      const compass = cards.find((c) => c.querySelector('.name').textContent.includes('Bronze Compass'));
      const iron = cards.find((c) => c.querySelector('.name').textContent.includes('Iron'));
      return { compassHidden: compass ? compass.hidden : null, ironHidden: iron ? iron.hidden : null, checkboxChecked: document.getElementById('collectiblesCompatOnlyCheckbox').checked };
    });
    if (!cardState.checkboxChecked) throw new Error('Expected the Collectibles checkbox to still be checked at this point, got: ' + JSON.stringify(cardState));
    if (cardState.compassHidden !== false) throw new Error('Expected the compatible Bronze Compass to stay visible, got: ' + JSON.stringify(cardState));
    if (cardState.ironHidden !== true) throw new Error('Expected the incompatible mined iron to be hidden by the restored filter, got: ' + JSON.stringify(cardState));
    console.log('PASS: the restored checkbox state actually re-filtered the already-rendered list, not just set a checked attribute');

    console.log('\nALL CHECKS PASSED — the "only show items compatible with this domain" setting now survives a reload for both Collectibles and Documents independently.');
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
