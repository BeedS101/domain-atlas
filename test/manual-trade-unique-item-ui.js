// Manual UI check for task #250 fourth follow-up's WALLET-SIDE wiring
// (the actual ask being verified here: Bruno's "start wallet UI
// follow-up" request after the protocol/server side — checkPresentedUniqueAsset,
// transferUniqueAsset, validateTradeSideShape — had already been built and
// tested at the HTTP layer by test/manual-trade-unique-item.js).
//
// That earlier test proved the SERVER honors a non-fungible offer/want.
// This one proves a visitor can actually COMPOSE one through Sell and
// BROWSE + CLAIM one through Buy, driving the real extension UI end to
// end — no direct HTTP calls to the trade endpoints anywhere below, same
// two-real-browser-profile pattern manual-remote-trade.js already
// established for the fungible flow.
//
// Covers, end to end, against the real issuer-server (no mocking):
//   1. Visitor A mints a Signet Ring (non-fungible); Visitor B mints gold.
//   2. Sell's "You offer" dropdown lists the ring alongside fungible
//      balances (refreshTradingSellOfferOptions widened to include
//      held, non-bound non-fungible classes) — selecting it locks the
//      offer quantity input to "1" and disables it
//      (updateSellQuantityLocks), even after typing into the OTHER
//      (still-fungible) quantity field.
//   3. A posts "1 ring for 3 gold" — Buy's listing card shows the ring
//      side WITHOUT a misleading "g" mass suffix (formatTradeSideAmount).
//   4. B claims it — the trade confirmation line also omits "g" for the
//      ring side, and B's wallet receives the ACTUAL ring instance (its
//      real, randomly-rolled rarity/enchantments/serial survive, not a
//      fresh catalog-default stand-in — the same instance-preservation
//      transferUniqueAsset already guarantees at the protocol layer).
//   5. A's Listings tab (once the remainder/gift arrive via mail check)
//      also formats the ring side without a "g" suffix.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts. Run against the shared localhost:8001/8002 dev
// servers (same convention as manual-remote-trade.js/manual-drop-pickup.js
// — this drives the real overlay UI, which navigates to those URLs
// directly), with a freshly-reset atlas-serial-counters.json so the
// ring's own cap isn't already exhausted by an earlier run.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

async function openOverlay(context, label) {
  const page = await context.newPage();
  await page.goto('http://localhost:8001', { waitUntil: 'load' });
  await page.locator('#domain-atlas-enter-btn').click();
  const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
  const frame = await frameHandle.contentFrame();
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
  console.log('SETUP: ' + label + ' opened the overlay at Example Plaza');
  return { page, frame };
}

async function createIdentity(frame, password) {
  await frame.locator('#walletBtn').click();
  await frame.locator('#chooseNewBtn').click();
  await frame.locator('#newPasswordInput').fill(password);
  await frame.locator('#newPasswordConfirmInput').fill(password);
  await frame.locator('#confirmCreateBtn').click();
  await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
  await frame.locator('#seedConfirmCheck').check();
  await frame.locator('#seedConfirmBtn').click();
  await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
  const publicKey = await frame.evaluate(() => AtlasWallet.getIdentity().then((i) => i.publicKey));
  await frame.locator('#walletBtn').click(); // close the panel — later steps re-open it via the same toggle
  return publicKey;
}

async function openTradingSubtab(frame, subtabBtnId, subscreenId) {
  const panelOpen = await frame.evaluate(() => document.getElementById('walletPanel').classList.contains('open'));
  if (!panelOpen) await frame.locator('#walletBtn').click();
  await frame.locator('#tradeTabBtn').click();
  await frame.waitForFunction(() => document.getElementById('tradeScreen').classList.contains('active'), { timeout: 5000 });
  await frame.locator('#' + subtabBtnId).click();
  await frame.waitForFunction((id) => document.getElementById(id).classList.contains('active'), subscreenId, { timeout: 5000 });
}

// Same searchable-combo driver manual-remote-trade.js uses (Task #205
// wrapped every trading <select> in makeSearchableSelect).
async function pickSearchable(frame, selectId, value) {
  const label = await frame.locator('#' + selectId).evaluate((sel, v) => {
    const opt = Array.from(sel.options).find((o) => o.value === v);
    return opt ? opt.text : null;
  }, value);
  if (label === null) throw new Error('pickSearchable: no option with value "' + value + '" in #' + selectId);
  const partial = label.split(' ')[0];
  const wrapper = frame.locator('#' + selectId + ' >> xpath=..');
  const input = wrapper.locator('.searchable-select-input');
  await input.click();
  await input.fill(partial);
  await wrapper.locator('.searchable-select-option').filter({ hasText: label }).first().click();
  const actual = await frame.locator('#' + selectId).evaluate((sel) => sel.value);
  if (actual !== value) throw new Error('pickSearchable: expected #' + selectId + ' to end up as "' + value + '", got "' + actual + '"');
}

async function joinTradingStationIfNeeded(frame) {
  const alreadyJoined = await frame.evaluate(() => document.getElementById('tradingStationJoinSection').hidden);
  if (alreadyJoined) return;
  await frame.waitForFunction(() => !document.getElementById('tradingStationJoinSection').hidden, { timeout: 5000 });
  await frame.locator('#tradingStationJoinBtn').click();
  await frame.waitForFunction(() => document.getElementById('tradingStationJoinSection').hidden, { timeout: 10000 });
  await frame.waitForFunction(() => Array.from(document.getElementById('remoteTradeStationDomainSelect').options).some((o) => o.value === 'localhost:8001'), { timeout: 5000 });
}

(async () => {
  const dirA = path.resolve(__dirname, '.chrome-profile-trade-unique-ui-a');
  const dirB = path.resolve(__dirname, '.chrome-profile-trade-unique-ui-b');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };

  const contextA = await chromium.launchPersistentContext(dirA, launchOpts);
  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);

  try {
    const a = await openOverlay(contextA, 'Visitor A');
    const b = await openOverlay(contextB, 'Visitor B');

    console.log('STEP 0: two visitors create their own real, independent wallet identities');
    const pkA = await createIdentity(a.frame, 'trade-unique-ui-test-password-a');
    const pkB = await createIdentity(b.frame, 'trade-unique-ui-test-password-b');
    if (pkA === pkB) throw new Error('Expected two independently created identities to differ');
    console.log('PASS: two independent identities ->', pkA.slice(0, 16) + '...', pkB.slice(0, 16) + '...');

    console.log('STEP 1: A mints a Signet Ring (non-fungible); B mints gold');
    await a.frame.evaluate(async () => { await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.wearable.ring'); await refreshInventoryDisplay(); });
    await a.frame.waitForFunction(() => document.getElementById('selfCollectiblesList').textContent.includes("Merchant's Signet Ring"), { timeout: 15000 });
    const mintedRing = await a.frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      const entry = wallet.find((e) => e.credential.asset.class === 'atlas.wearable.ring');
      return entry ? entry.credential.asset.properties : null;
    });
    if (!mintedRing || !mintedRing['atlas.serial']) throw new Error('Expected A\'s freshly-minted ring to carry atlas.serial, got: ' + JSON.stringify(mintedRing));
    console.log('PASS: A holds a Signet Ring -> rarity=' + mintedRing['atlas.rarity'] + ' serial=' + mintedRing['atlas.serial'] + ' enchantments=' + JSON.stringify(mintedRing['com.example.enchantments']));

    await b.frame.evaluate(async () => { await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.element.gold', 10); await refreshInventoryDisplay(); });
    await b.frame.waitForFunction(() => document.getElementById('selfCollectiblesList').textContent.includes('Gold (Au) ×10 g'), { timeout: 15000 });
    console.log('PASS: B holds 10 gold');

    console.log('STEP 2: A opens Sell, joins the Trading Station, and finds the ring in "You offer" alongside fungible balances');
    await openTradingSubtab(a.frame, 'tradingSellSubtabBtn', 'tradingSellSubscreen');
    await joinTradingStationIfNeeded(a.frame);
    await a.frame.waitForFunction(() => Array.from(document.getElementById('tradingSellOfferClassSelect').options).some((o) => o.value === 'atlas.wearable.ring'), { timeout: 10000 });
    console.log('PASS: the ring is listed in "You offer"');

    console.log('STEP 3: selecting the ring as the offer locks its quantity input to 1 and disables it');
    await pickSearchable(a.frame, 'tradingSellOfferClassSelect', 'atlas.wearable.ring');
    await a.frame.waitForFunction(() => document.getElementById('tradingSellOfferQtyInput').disabled === true, { timeout: 5000 });
    const lockedOfferQty = await a.frame.evaluate(() => document.getElementById('tradingSellOfferQtyInput').value);
    if (lockedOfferQty !== '1') throw new Error('Expected the offer quantity to be locked to "1" for a unique item, got: ' + lockedOfferQty);
    console.log('PASS: offer quantity locked to 1 and disabled');

    await a.frame.waitForFunction(() => Array.from(document.getElementById('tradingSellWantClassSelect').options).some((o) => o.value === 'atlas.element.gold'), { timeout: 10000 });
    await pickSearchable(a.frame, 'tradingSellWantClassSelect', 'atlas.element.gold');
    await a.frame.locator('#tradingSellWantQtyInput').fill('3');
    const stillLockedAfterTypingWant = await a.frame.evaluate(() => ({
      disabled: document.getElementById('tradingSellOfferQtyInput').disabled,
      value: document.getElementById('tradingSellOfferQtyInput').value,
    }));
    if (!stillLockedAfterTypingWant.disabled || stillLockedAfterTypingWant.value !== '1') {
      throw new Error('Expected the ring\'s offer quantity to stay locked at 1 even after typing into "You want", got: ' + JSON.stringify(stillLockedAfterTypingWant));
    }
    console.log('PASS: typing a real quantity into the fungible "You want" side does not disturb the locked non-fungible offer side');

    console.log('STEP 4: A posts the listing (1 ring for 3 gold)');
    await a.frame.locator('#tradingSellSubmitBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('tradingSellStatus').textContent.startsWith('✓ Posted'), { timeout: 15000 });
    console.log('PASS: A\'s listing is posted ->', await a.frame.locator('#tradingSellStatus').textContent());

    console.log('STEP 5: B\'s Buy tab shows the ring side WITHOUT a misleading "g" mass suffix');
    await openTradingSubtab(b.frame, 'tradingBuySubtabBtn', 'tradingBuySubscreen');
    await joinTradingStationIfNeeded(b.frame);
    await b.frame.locator('#tradingBuyRefreshBtn').click();
    const buyRow = b.frame.locator('#tradingBuyList .wallet-item', { hasText: 'atlas.wearable.ring' });
    await buyRow.waitFor({ timeout: 15000 });
    const buyRowText = await buyRow.textContent();
    if (/\d+\s*g\s+atlas\.wearable\.ring/.test(buyRowText)) {
      throw new Error('Expected the ring side to render without a mass suffix, got: ' + buyRowText);
    }
    if (!buyRowText.includes('3 g atlas.element.gold')) throw new Error('Expected the gold side to still render with its mass suffix, got: ' + buyRowText);
    console.log('PASS: listing card renders the ring without a "g" suffix, and gold with one ->', buyRowText.trim().split('\n')[0]);

    console.log('STEP 6: B claims the listing — receives the ACTUAL ring instance, and the confirmation line also omits "g" for it');
    await buyRow.locator('.trading-claim-btn').click();
    await b.frame.waitForFunction(() => document.getElementById('tradingBuyStatus').textContent.startsWith('✓ Traded'), { timeout: 15000 });
    const tradedStatusText = await b.frame.locator('#tradingBuyStatus').textContent();
    if (!tradedStatusText.includes('received atlas.wearable.ring')) throw new Error('Expected the confirmation to read "received atlas.wearable.ring" with no mass suffix, got: ' + tradedStatusText);
    if (!tradedStatusText.includes('sent 3 g atlas.element.gold')) throw new Error('Expected the confirmation to still show "sent 3 g atlas.element.gold", got: ' + tradedStatusText);
    console.log('PASS:', tradedStatusText);

    const receivedRing = await b.frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      const entry = wallet.find((e) => e.credential.asset.class === 'atlas.wearable.ring');
      return entry ? entry.credential.asset.properties : null;
    });
    if (!receivedRing) throw new Error('Expected B\'s wallet to now hold the ring');
    if (receivedRing['atlas.serial'] !== mintedRing['atlas.serial'] || JSON.stringify(receivedRing['com.example.enchantments']) !== JSON.stringify(mintedRing['com.example.enchantments'])) {
      throw new Error('Expected B to receive the SAME ring instance A minted, got: ' + JSON.stringify(receivedRing) + ' vs original: ' + JSON.stringify(mintedRing));
    }
    console.log('PASS: B received the exact same ring instance (serial=' + receivedRing['atlas.serial'] + ', enchantments=' + JSON.stringify(receivedRing['com.example.enchantments']) + ') — nothing re-rolled or re-derived from the catalog');

    console.log('STEP 7: A checks mail — receives the gold, and Listings shows the ring side without a "g" suffix too');
    await a.frame.locator('#socialTabBtn').click();
    await a.frame.locator('#checkMailNowBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('selfCollectiblesList').textContent.includes('Gold (Au)') || document.getElementById('mailList').textContent.includes('Gold (Au)'), { timeout: 15000 });
    const giftCard = a.frame.locator('#mailList .mail-card').filter({ hasText: 'atlas.wearable.ring' }).first();
    await giftCard.waitFor({ timeout: 15000 });
    await giftCard.locator('button[data-action="claim-gift"]').click();
    await a.frame.waitForFunction(() => document.getElementById('status').textContent.includes('Claimed'), { timeout: 5000 });
    const finalGoldA = await a.frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      const gold = wallet.find((e) => e.credential.asset.class === 'atlas.element.gold');
      return gold ? gold.credential.quantity : 0;
    });
    if (finalGoldA !== 3) throw new Error('Expected A to hold exactly 3 gold after claiming the gift, got: ' + finalGoldA);
    console.log('PASS: A received the 3 gold via the ordinary mail-check path');

    await openTradingSubtab(a.frame, 'tradingListingsSubtabBtn', 'tradingListingsSubscreen');
    const listingsRow = a.frame.locator('#tradingListingsList .wallet-item', { hasText: 'atlas.wearable.ring' });
    await listingsRow.waitFor({ timeout: 10000 });
    const listingsRowText = await listingsRow.textContent();
    if (/\d+\s*g\s+atlas\.wearable\.ring/.test(listingsRowText)) throw new Error('Expected Listings to also render the ring side without a "g" suffix, got: ' + listingsRowText);
    if (!listingsRowText.includes('settled')) throw new Error('Expected A\'s listing to show settled status, got: ' + listingsRowText);
    console.log('PASS: Listings also renders the ring side without a "g" suffix ->', listingsRowText.trim());

    console.log('\nALL TRADE UNIQUE-ITEM WALLET UI (TASK #250 FOURTH FOLLOW-UP) CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close();
    await contextB.close();
  }
})();
