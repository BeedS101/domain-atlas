// Manual check for the wallet's search/filter inputs — now just TWO of
// them (Collectibles, Documents), one shared search box per sub-tab that
// filters both the self and counterparty lists at once, since items and
// resource balances were unified into one Collectibles list (task #44) —
// and for the Settings button's home at the bottom of the panel, outside
// every accordion category. Not part of the permanent suite, same
// reasoning as the other manual-*.js scripts.
//
// Inventory defaults OPEN on the main wallet screen, so unlike the
// identity-method tests in this suite, no category needs to be expanded
// before interacting with its search input.

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

    console.log('SETUP: creating identity, a counterparty, an item, and iron (self) + gold (counterparty) — all land in the same Collectibles lists');
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
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0, { timeout: 15000 });

    await frame.locator('#mintIronBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 2, { timeout: 10000 });
    await frame.locator('#mintGoldBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#counterpartyCollectiblesList .wallet-item').length > 0, { timeout: 10000 });
    console.log('PASS: setup complete — item + iron balance (self), gold balance (counterparty), all under Collectibles');

    console.log('STEP 1: the old footer Settings button is gone (see #54) — Settings is reached via the top tab bar instead, and still opens Settings');
    const oldBtnCount = await frame.locator('#openSettingsBtn').count();
    if (oldBtnCount !== 0) throw new Error('Expected #openSettingsBtn to be gone entirely, found ' + oldBtnCount);
    await frame.locator('#settingsTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#backFromSettingsBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    console.log('PASS: old footer button gone, Settings tab still works');

    console.log('STEP 2: searching Collectibles for a substring of the item\'s class shows it and hides the unrelated iron balance in the SAME list');
    await frame.locator('#collectiblesSearchInput').fill('wearable');
    await frame.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item'));
      const itemCard = cards.find((c) => c.textContent.includes('Bronze Compass'));
      const ironCard = cards.find((c) => c.textContent.includes('Iron Ingot'));
      return itemCard && !itemCard.hidden && ironCard && ironCard.hidden;
    }, { timeout: 5000 });
    console.log('PASS: matching search term keeps the item visible and hides the non-matching iron balance in the same list');

    console.log('STEP 2b: searching by an asset.properties value (not just name/class) also matches — properties are folded into the search index');
    await frame.locator('#collectiblesSearchInput').fill('victorian');
    await frame.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item'));
      const itemCard = cards.find((c) => c.textContent.includes('Bronze Compass'));
      return itemCard && !itemCard.hidden;
    }, { timeout: 5000 });
    console.log('PASS: searching "victorian" (a com.example.era property value) finds the item');

    await frame.locator('#collectiblesSearchInput').fill('zzz-nomatch');
    await frame.waitForFunction(() => {
      const cards = document.querySelectorAll('#selfCollectiblesList .wallet-item');
      return cards.length > 0 && Array.from(cards).every((c) => c.hidden) && !!document.querySelector('#selfCollectiblesList .filter-empty-note');
    }, { timeout: 5000 });
    console.log('PASS: non-matching search term hides everything and shows a "No matches" note');

    await frame.locator('#collectiblesSearchInput').fill('');
    await frame.waitForFunction(() => {
      const cards = document.querySelectorAll('#selfCollectiblesList .wallet-item');
      return cards.length > 0 && Array.from(cards).every((c) => !c.hidden) && !document.querySelector('#selfCollectiblesList .filter-empty-note');
    }, { timeout: 5000 });
    console.log('PASS: clearing the search restores everything and drops the "No matches" note');

    console.log('STEP 3: the Collectibles search filters BOTH the self and counterparty lists by the same query');
    await frame.locator('#collectiblesSearchInput').fill('iron');
    await frame.waitForFunction(() => {
      const selfCards = Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item'));
      const ironCard = selfCards.find((c) => c.textContent.includes('Iron Ingot'));
      const compassCard = selfCards.find((c) => c.textContent.includes('Bronze Compass'));
      const cpCards = document.querySelectorAll('#counterpartyCollectiblesList .wallet-item');
      return ironCard && !ironCard.hidden && compassCard && compassCard.hidden
        && cpCards.length > 0 && Array.from(cpCards).every((c) => c.hidden);
    }, { timeout: 5000 });
    console.log('PASS: "iron" keeps the self iron balance visible, hides the self item, and hides the counterparty gold balance');

    await frame.locator('#collectiblesSearchInput').fill('gold');
    await frame.waitForFunction(() => {
      const selfCards = document.querySelectorAll('#selfCollectiblesList .wallet-item');
      const cpCards = document.querySelectorAll('#counterpartyCollectiblesList .wallet-item');
      return selfCards.length > 0 && Array.from(selfCards).every((c) => c.hidden)
        && cpCards.length > 0 && Array.from(cpCards).every((c) => !c.hidden);
    }, { timeout: 5000 });
    console.log('PASS: "gold" flips it — everything in self hidden, counterparty gold visible');

    await frame.locator('#collectiblesSearchInput').fill('');
    await frame.waitForFunction(() => {
      const selfCards = document.querySelectorAll('#selfCollectiblesList .wallet-item');
      const cpCards = document.querySelectorAll('#counterpartyCollectiblesList .wallet-item');
      return Array.from(selfCards).every((c) => !c.hidden) && Array.from(cpCards).every((c) => !c.hidden);
    }, { timeout: 5000 });
    console.log('PASS: clearing the search restores every card in both lists');

    console.log('STEP 4: the search text survives a list refresh (minting more iron re-renders the list; the filter re-applies)');
    await frame.locator('#collectiblesSearchInput').fill('gold');
    await frame.waitForFunction(() => Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item')).every((c) => c.hidden), { timeout: 5000 });
    await frame.locator('#mintIronBtn').click();
    await frame.waitForFunction(() => document.getElementById('mintIronBtn').disabled === false, { timeout: 10000 });
    const selfStillHidden = await frame.evaluate(() => Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item')).every((c) => c.hidden));
    if (!selfStillHidden) throw new Error('Expected the "gold" filter to still hide the self list (now with a larger iron balance) after a re-render');
    console.log('PASS: filter re-applied automatically after the list re-rendered from a fresh mint');

    console.log('STEP 5: each card with properties has a "Properties (N) ▸" link, collapsed by default, that expands/collapses its own detail panel');
    // STEP 4 left the search set to "gold", which hides the self cards this
    // step needs to click on — clear it back to an unfiltered view.
    await frame.locator('#collectiblesSearchInput').fill('');
    await frame.waitForFunction(() => Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item')).every((c) => !c.hidden), { timeout: 5000 });
    const itemCard = frame.locator('#selfCollectiblesList .wallet-item', { hasText: 'Bronze Compass' });
    const itemPropsLink = itemCard.locator('.properties-link');
    const itemPropsDetail = itemCard.locator('.properties-detail');
    if (!(await itemPropsLink.textContent()).includes('Properties (4)')) throw new Error('Expected the item\'s properties link to read "Properties (4)" (atlas.rarity + com.example.era + com.example.material + com.example.condition)');
    if (!(await itemPropsDetail.isHidden())) throw new Error('Expected the item\'s properties detail to start collapsed');
    await itemPropsLink.click();
    await frame.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item'));
      const card = cards.find((c) => c.textContent.includes('Bronze Compass'));
      const detail = card && card.querySelector('.properties-detail');
      return detail && !detail.hidden
        && detail.textContent.includes('atlas.rarity: common')
        && detail.textContent.includes('com.example.era: Victorian')
        && detail.textContent.includes('com.example.material: brass')
        && detail.textContent.includes('com.example.condition: well-worn');
    }, { timeout: 5000 });
    console.log('PASS: clicking the item\'s Properties link reveals all four properties');
    await itemPropsLink.click();
    await frame.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item'));
      const card = cards.find((c) => c.textContent.includes('Bronze Compass'));
      return card && card.querySelector('.properties-detail').hidden === true;
    }, { timeout: 5000 });
    console.log('PASS: clicking it again collapses the detail panel');

    const resourceCard = frame.locator('#selfCollectiblesList .wallet-item', { hasText: 'Iron Ingot' });
    const resourcePropsLink = resourceCard.locator('.properties-link');
    const resourcePropsDetail = resourceCard.locator('.properties-detail');
    if (!(await resourcePropsDetail.isHidden())) throw new Error('Expected the resource balance\'s properties detail to start collapsed');
    await resourcePropsLink.click();
    await frame.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item'));
      const card = cards.find((c) => c.textContent.includes('Iron Ingot'));
      const detail = card && card.querySelector('.properties-detail');
      return detail && !detail.hidden && detail.textContent.includes('atlas.purity: 99.9%');
    }, { timeout: 5000 });
    console.log('PASS: iron balance carries its class-level atlas.purity property and the same toggle link works on fungible cards, in the same list as items');

    console.log('STEP 5b: searching by a fungible balance\'s property value also works, same as it already does for items — same search box, same list');
    await frame.locator('#collectiblesSearchInput').fill('99.9%');
    await frame.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('#selfCollectiblesList .wallet-item'));
      const ironCard = cards.find((c) => c.textContent.includes('Iron Ingot'));
      return ironCard && !ironCard.hidden;
    }, { timeout: 5000 });
    await frame.locator('#collectiblesSearchInput').fill('');
    console.log('PASS: searching "99.9%" (the iron balance\'s atlas.purity value) finds it');

    console.log('\nALL WALLET SEARCH / SETTINGS-RELOCATION / PROPERTIES-LINK CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
