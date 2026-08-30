// Manual check for the wallet's search/filter inputs (Items, Counterparty's
// items, Resources categories on the main wallet screen) and for the
// Settings button's new home at the bottom of the panel, outside every
// accordion category. Not part of the permanent suite, same reasoning as
// the other manual-*.js scripts.
//
// Items and Resources both default OPEN on the main wallet screen, so
// unlike the identity-method tests in this suite, no category needs to be
// expanded before interacting with their search inputs.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-wallet-search');
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

    console.log('SETUP: creating identity, a counterparty, an item, and iron (self) + gold (counterparty)');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('search-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('search-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });

    // Identity now defaults to a collapsed category on the main wallet
    // screen (see viewer.html) — expand it before its buttons are clickable.
    await frame.locator('[data-category="identity"] .settings-category-toggle').click();
    await frame.locator('#createCounterpartyBtn').click();
    await frame.waitForFunction(() => !document.getElementById('counterpartyIdentity').textContent.includes('No counterparty yet'), { timeout: 5000 });

    await frame.locator('#requestItemBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfItemsList .wallet-item').length > 0, { timeout: 15000 });

    await frame.locator('#mintIronBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfResourceList .wallet-item').length > 0, { timeout: 10000 });
    await frame.locator('#mintGoldBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#counterpartyResourceList .wallet-item').length > 0, { timeout: 10000 });
    console.log('PASS: setup complete — one item (self), iron (self), gold (counterparty)');

    console.log('STEP 1: Settings button lives at the bottom of the panel, outside any accordion category, and still opens Settings');
    const settingsParentCategory = await frame.locator('#openSettingsBtn').evaluate((el) => !!el.closest('.settings-category'));
    if (settingsParentCategory) throw new Error('Expected #openSettingsBtn to no longer live inside a .settings-category');
    const footerParent = await frame.locator('#openSettingsBtn').evaluate((el) => el.closest('#walletPanelFooter') !== null);
    if (!footerParent) throw new Error('Expected #openSettingsBtn inside #walletPanelFooter');
    await frame.locator('#openSettingsBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#backFromSettingsBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    console.log('PASS: Settings button relocated to the panel footer and still works');

    console.log('STEP 2: searching Items for a substring of the item\'s class shows it; an unrelated query hides it and shows "No matches"');
    await frame.locator('#itemsSearchInput').fill('wearable');
    await frame.waitForFunction(() => {
      const cards = document.querySelectorAll('#selfItemsList .wallet-item');
      return cards.length > 0 && Array.from(cards).every((c) => !c.hidden);
    }, { timeout: 5000 });
    console.log('PASS: matching search term keeps the item visible');

    console.log('STEP 2b: searching by an asset.properties value (not just name/class) also matches — properties are folded into the search index');
    await frame.locator('#itemsSearchInput').fill('victorian');
    await frame.waitForFunction(() => {
      const cards = document.querySelectorAll('#selfItemsList .wallet-item');
      return cards.length > 0 && Array.from(cards).every((c) => !c.hidden);
    }, { timeout: 5000 });
    console.log('PASS: searching "victorian" (a com.example.era property value) finds the item');

    await frame.locator('#itemsSearchInput').fill('zzz-nomatch');
    await frame.waitForFunction(() => {
      const cards = document.querySelectorAll('#selfItemsList .wallet-item');
      return cards.length > 0 && Array.from(cards).every((c) => c.hidden) && !!document.querySelector('#selfItemsList .filter-empty-note');
    }, { timeout: 5000 });
    console.log('PASS: non-matching search term hides the item and shows a "No matches" note');

    await frame.locator('#itemsSearchInput').fill('');
    await frame.waitForFunction(() => {
      const cards = document.querySelectorAll('#selfItemsList .wallet-item');
      return cards.length > 0 && Array.from(cards).every((c) => !c.hidden) && !document.querySelector('#selfItemsList .filter-empty-note');
    }, { timeout: 5000 });
    console.log('PASS: clearing the search restores the item and drops the "No matches" note');

    console.log('STEP 3: Resources search filters BOTH the self and counterparty lists by the same query');
    await frame.locator('#resourcesSearchInput').fill('iron');
    await frame.waitForFunction(() => {
      const selfCards = document.querySelectorAll('#selfResourceList .wallet-item');
      const cpCards = document.querySelectorAll('#counterpartyResourceList .wallet-item');
      return selfCards.length > 0 && Array.from(selfCards).every((c) => !c.hidden)
        && cpCards.length > 0 && Array.from(cpCards).every((c) => c.hidden);
    }, { timeout: 5000 });
    console.log('PASS: "iron" keeps the self iron balance visible and hides the counterparty gold balance');

    await frame.locator('#resourcesSearchInput').fill('gold');
    await frame.waitForFunction(() => {
      const selfCards = document.querySelectorAll('#selfResourceList .wallet-item');
      const cpCards = document.querySelectorAll('#counterpartyResourceList .wallet-item');
      return selfCards.length > 0 && Array.from(selfCards).every((c) => c.hidden)
        && cpCards.length > 0 && Array.from(cpCards).every((c) => !c.hidden);
    }, { timeout: 5000 });
    console.log('PASS: "gold" flips it — self iron hidden, counterparty gold visible');

    await frame.locator('#resourcesSearchInput').fill('');
    await frame.waitForFunction(() => {
      const selfCards = document.querySelectorAll('#selfResourceList .wallet-item');
      const cpCards = document.querySelectorAll('#counterpartyResourceList .wallet-item');
      return Array.from(selfCards).every((c) => !c.hidden) && Array.from(cpCards).every((c) => !c.hidden);
    }, { timeout: 5000 });
    console.log('PASS: clearing the resources search restores both balances');

    console.log('STEP 4: the search text survives a list refresh (minting more iron re-renders the list; the filter re-applies)');
    await frame.locator('#resourcesSearchInput').fill('gold');
    await frame.waitForFunction(() => Array.from(document.querySelectorAll('#selfResourceList .wallet-item')).every((c) => c.hidden), { timeout: 5000 });
    await frame.locator('#mintIronBtn').click();
    await frame.waitForFunction(() => document.getElementById('mintIronBtn').disabled === false, { timeout: 10000 });
    const selfIronStillHidden = await frame.evaluate(() => Array.from(document.querySelectorAll('#selfResourceList .wallet-item')).every((c) => c.hidden));
    if (!selfIronStillHidden) throw new Error('Expected the "gold" filter to still hide the (now-larger) iron balance after a re-render');
    console.log('PASS: filter re-applied automatically after the list re-rendered from a fresh mint');

    console.log('STEP 5: each card with properties has a "Properties (N) ▸" link, collapsed by default, that expands/collapses its own detail panel');
    // STEP 4 left the resources search set to "gold", which hides the iron
    // card this step needs to click on — clear it back to an unfiltered view.
    await frame.locator('#resourcesSearchInput').fill('');
    await frame.waitForFunction(() => Array.from(document.querySelectorAll('#selfResourceList .wallet-item')).every((c) => !c.hidden), { timeout: 5000 });
    const itemPropsLink = frame.locator('#selfItemsList .wallet-item .properties-link');
    const itemPropsDetail = frame.locator('#selfItemsList .wallet-item .properties-detail');
    if (!(await itemPropsLink.textContent()).includes('Properties (4)')) throw new Error('Expected the item\'s properties link to read "Properties (4)" (atlas.rarity + com.example.era + com.example.material + com.example.condition)');
    if (!(await itemPropsDetail.isHidden())) throw new Error('Expected the item\'s properties detail to start collapsed');
    await itemPropsLink.click();
    await frame.waitForFunction(() => {
      const detail = document.querySelector('#selfItemsList .wallet-item .properties-detail');
      return detail && !detail.hidden
        && detail.textContent.includes('atlas.rarity: common')
        && detail.textContent.includes('com.example.era: Victorian')
        && detail.textContent.includes('com.example.material: brass')
        && detail.textContent.includes('com.example.condition: well-worn');
    }, { timeout: 5000 });
    console.log('PASS: clicking the item\'s Properties link reveals both properties');
    await itemPropsLink.click();
    await frame.waitForFunction(() => document.querySelector('#selfItemsList .wallet-item .properties-detail').hidden === true, { timeout: 5000 });
    console.log('PASS: clicking it again collapses the detail panel');

    const resourcePropsLink = frame.locator('#selfResourceList .wallet-item .properties-link').first();
    const resourcePropsDetail = frame.locator('#selfResourceList .wallet-item .properties-detail').first();
    if (!(await resourcePropsDetail.isHidden())) throw new Error('Expected the resource balance\'s properties detail to start collapsed');
    await resourcePropsLink.click();
    await frame.waitForFunction(() => {
      const detail = document.querySelector('#selfResourceList .wallet-item .properties-detail');
      return detail && !detail.hidden && detail.textContent.includes('atlas.purity: 99.9%');
    }, { timeout: 5000 });
    console.log('PASS: iron balance carries its class-level atlas.purity property and the same toggle link works on resource cards');

    console.log('STEP 5b: searching by a resource\'s property value also works, same as it already does for items');
    await frame.locator('#resourcesSearchInput').fill('99.9%');
    await frame.waitForFunction(() => {
      const cards = document.querySelectorAll('#selfResourceList .wallet-item');
      return cards.length > 0 && Array.from(cards).every((c) => !c.hidden);
    }, { timeout: 5000 });
    await frame.locator('#resourcesSearchInput').fill('');
    console.log('PASS: searching "99.9%" (the iron balance\'s atlas.purity value) finds it');

    console.log('\nALL WALLET SEARCH / SETTINGS-RELOCATION / PROPERTIES-LINK CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
