// Manual check for task #212: Bruno asked for the Trade screen's four
// class dropdowns — Sell's "you offer"/"you want" and Convert's "convert
// from"/"convert to" — to select all their current text as soon as they
// get focus, the way a URL bar or search box does, so the very next
// keystroke starts a fresh filter instead of editing/appending to
// whatever label is already sitting there.
//
// These "dropdowns" are actually task #205's makeSearchableSelect()
// comboboxes (extension/viewer.js): a real, hidden <select> stays the
// source of truth, but what the visitor actually sees and focuses is a
// sibling `.searchable-select-input` text box that mirrors the selected
// option's label and filters a popover list as you type. The fix
// (input.select() alongside the existing openList() call in that
// function's 'focus' listener) is a single shared change, since all four
// fields are built by the same factory — this test exercises all four to
// prove that's actually true live, not just for whichever one happened
// to get eyeballed.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts. Assumes issuer-server is already running on 8001
// (see README §1).

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

// Clicks away first (so the upcoming click is a genuine focus transition,
// not a no-op on an already-focused element), then clicks into the
// combobox's own visible text input and checks that its ENTIRE current
// value ends up selected — not just focused with the caret dropped
// somewhere, and not empty (a real label has to already be there for
// "select all of it" to mean anything).
async function expectWholeLabelSelectedOnFocus(frame, selectId) {
  const wrapper = frame.locator('#' + selectId + ' >> xpath=..');
  const input = wrapper.locator('.searchable-select-input');
  await frame.locator('body').click({ position: { x: 5, y: 5 } }); // focus something neutral first
  await input.click();
  const sel = await input.evaluate((el) => ({
    isActive: document.activeElement === el,
    start: el.selectionStart,
    end: el.selectionEnd,
    value: el.value
  }));
  if (!sel.isActive) throw new Error('Expected #' + selectId + '\'s combobox input to actually hold focus after clicking it');
  if (!sel.value) throw new Error('Expected #' + selectId + '\'s combobox to already show a real label before this check — got an empty value');
  if (sel.start !== 0 || sel.end !== sel.value.length) {
    throw new Error(
      'Expected the full label "' + sel.value + '" to be selected on focus for #' + selectId +
      ', got selectionStart=' + sel.start + ' selectionEnd=' + sel.end + ' (value is ' + sel.value.length + ' chars)'
    );
  }
  return sel.value;
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-trade-combobox-focus');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: identity + an iron balance, so Sell/Convert have real classes to pick from');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('trade-combobox-focus-pw');
    await frame.locator('#newPasswordConfirmInput').fill('trade-combobox-focus-pw');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    await frame.evaluate(async () => { await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.element.iron', 20); await refreshInventoryDisplay(); });
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0, { timeout: 15000 });
    console.log('PASS: identity + iron balance ready');

    console.log('STEP 1: opening Trade -> Sell and joining this domain\'s Trading Station');
    await frame.locator('#tradeTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('tradeScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#tradingSellSubtabBtn').click();
    await frame.waitForFunction(() => document.getElementById('tradingSellSubscreen').classList.contains('active'), { timeout: 5000 });
    const alreadyJoined = await frame.evaluate(() => document.getElementById('tradingStationJoinSection').hidden);
    if (!alreadyJoined) {
      await frame.waitForFunction(() => !document.getElementById('tradingStationJoinSection').hidden, { timeout: 5000 });
      await frame.locator('#tradingStationJoinBtn').click();
      await frame.waitForFunction(() => document.getElementById('tradingStationJoinSection').hidden, { timeout: 10000 });
    }
    // "You offer" is populated from the wallet's own held fungible
    // balances (no membership needed for that part) — wait for the real
    // iron option, and for "You want" to finish its own live catalog
    // fetch, before either combobox's visible input can have settled on
    // a real, non-placeholder label.
    await frame.waitForFunction(() => {
      const offer = document.getElementById('tradingSellOfferClassSelect');
      const want = document.getElementById('tradingSellWantClassSelect');
      return offer && offer.value && want && want.value;
    }, { timeout: 10000 });
    console.log('PASS: Trading Station joined, "You offer"/"You want" both settled on a real class');

    console.log('STEP 2: focusing "You offer" selects its whole current label');
    const offerLabel = await expectWholeLabelSelectedOnFocus(frame, 'tradingSellOfferClassSelect');
    console.log('PASS: "You offer" selected its full label on focus -> "' + offerLabel + '"');

    console.log('STEP 3: focusing "You want" selects its whole current label');
    const wantLabel = await expectWholeLabelSelectedOnFocus(frame, 'tradingSellWantClassSelect');
    console.log('PASS: "You want" selected its full label on focus -> "' + wantLabel + '"');

    console.log('STEP 4: opening Trade -> Convert');
    await frame.locator('#tradingConvertSubtabBtn').click();
    await frame.waitForFunction(() => document.getElementById('tradingConvertSubscreen').classList.contains('active'), { timeout: 5000 });
    await frame.waitForFunction(() => {
      const from = document.getElementById('tradingConvertFromClassSelect');
      const to = document.getElementById('tradingConvertToClassSelect');
      return from && from.value && to && to.value;
    }, { timeout: 10000 });
    console.log('PASS: "Convert from"/"Convert to" both settled on a real class');

    console.log('STEP 5: focusing "Convert from" selects its whole current label');
    const fromLabel = await expectWholeLabelSelectedOnFocus(frame, 'tradingConvertFromClassSelect');
    console.log('PASS: "Convert from" selected its full label on focus -> "' + fromLabel + '"');

    console.log('STEP 6: focusing "Convert to" selects its whole current label');
    const toLabel = await expectWholeLabelSelectedOnFocus(frame, 'tradingConvertToClassSelect');
    console.log('PASS: "Convert to" selected its full label on focus -> "' + toLabel + '"');

    console.log('STEP 7: typing right after focus REPLACES the selection (a real end-to-end sanity check, not just selectionStart/End bookkeeping)');
    const wrapper = frame.locator('#tradingConvertToClassSelect >> xpath=..');
    const input = wrapper.locator('.searchable-select-input');
    await frame.locator('body').click({ position: { x: 5, y: 5 } });
    await input.click();
    await page.keyboard.type('Gold');
    const typedValue = await input.inputValue();
    if (typedValue !== 'Gold') throw new Error('Expected typing right after focus to REPLACE the selected label with "Gold", got: "' + typedValue + '"');
    console.log('PASS: typing immediately after focus replaced the old label instead of appending to it -> "' + typedValue + '"');

    console.log('\nALL TRADE COMBOBOX SELECT-ON-FOCUS CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
})();
