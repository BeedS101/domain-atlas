// Manual check for task #144 Phase 1 (remote trade settlement, reshaped to
// open listings in v1.14 — SPEC.md §7) and the task #160 bound-tradeScope
// enforcement it leans on.
//
// Runs between TWO REAL, INDEPENDENT WALLETS — two separate
// `chromium.launchPersistentContext` profiles, each with its own real
// identity — same two-browser pattern already used by
// manual-add-contact-from-mail.js / manual-postoffice-mail.js /
// manual-friends-favorites.js / this file's own earlier counterparty-pinned
// version.
//
// v1.14 replaced "submit to a specific counterparty" entirely with an open
// listings board: Sell posts naming no counterparty at all, Buy browses
// every open listing at a station and claims one outright, Listings shows
// (and can cancel) this wallet's own posted listings. This rewrite drops
// every use of #remoteTradeCounterpartyInput and the old single Remote
// sub-tab, replacing them with the three new sub-tabs. v1.15 went on to
// remove the old in-person mechanism (the #tradeBtn flow, self/counterparty
// in one profile) entirely — verify-loadout-trading.js's own regression
// coverage for it went with it — so this open-listings flow is now the
// only way to trade at all, and this file covers it exclusively.
//
// Covers, end to end, against the real issuer-server (no mocking):
//   1. Two independent visitors each create their own real wallet
//      identity and mine their own starting balance (20 iron / 10 gold).
//   2. Task #160 sanity check — a bound credential (atlas.membership)
//      cannot be traded at all.
//   3. Both visitors join localhost:8001's Trading Station the same
//      one-click way Post Office membership already works — no role
//      picker, no "use other local identity" shortcut; each just uses
//      their own wallet.
//   4. Visitor A posts an open listing (10 iron for 5 gold) on Sell —
//      naming no counterparty at all.
//   5. Visitor B, on Buy, sees A's listing appear (GET /atlas/trade/listings
//      is ungated) and claims it — since B is live for this call, the
//      station settles immediately and B's own wallet updates in the same
//      response.
//   6. Visitor A (not live at the moment of the claim) has NOT yet
//      received anything — proving delivery really is asynchronous across
//      two genuinely separate installs, not silently synchronous.
//   7. Checking A's mail is what actually delivers the rest: the
//      remainder (10 iron) arrives via the existing supersession-update
//      channel, and the received 5 gold arrives as a claimable mail gift,
//      reusing task #59's existing Claim mechanism unmodified.
//   8. Visitor A posts a second listing, then withdraws it via Listings ->
//      Cancel (POST /atlas/trade/cancel) — it disappears from A's own
//      Listings and from B's Buy browse alike.
//   9. A's now-settled first listing gets a Delete button in Listings, and
//      deleting it removes the local record.
//  10. A's canceled second listing also gets a Delete button (added so
//      canceled listings can be cleared out, not just settled/expired
//      ones), and deleting it removes the local record too.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');
const http = require('http');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

function postJson(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: 'localhost', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => { try { resolve(JSON.parse(chunks)); } catch (err) { reject(err); } });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

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
  await frame.locator('#walletBtn').click(); // close the panel — STEP 3 re-opens it via the same toggle
  return publicKey;
}

// Opens Trade -> Sell (or Buy/Listings) and, if not already a member,
// joins the Trading Station first. Shared across steps since all three
// sub-tabs need membership before Sell/claim will work, and the join
// control lives above all three (see viewer.html's #tradingStationBar)
// rather than being duplicated per sub-tab.
async function openTradingSubtab(frame, subtabBtnId, subscreenId) {
  // #walletBtn TOGGLES the panel rather than always opening it, so only
  // click it when the panel isn't already open — this is called both
  // right after createIdentity() (which leaves the panel closed) and,
  // later in the run, right after a mail check (which leaves it open),
  // and clicking an already-open panel closed here would make the very
  // next #tradeTabBtn click fail with "element is not visible".
  const panelOpen = await frame.evaluate(() => document.getElementById('walletPanel').classList.contains('open'));
  if (!panelOpen) await frame.locator('#walletBtn').click();
  await frame.locator('#tradeTabBtn').click();
  await frame.waitForFunction(() => document.getElementById('tradeScreen').classList.contains('active'), { timeout: 5000 });
  await frame.locator('#' + subtabBtnId).click();
  await frame.waitForFunction((id) => document.getElementById(id).classList.contains('active'), subscreenId, { timeout: 5000 });
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
  const dirA = path.resolve(__dirname, '.chrome-profile-remote-trade-a');
  const dirB = path.resolve(__dirname, '.chrome-profile-remote-trade-b');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };

  const contextA = await chromium.launchPersistentContext(dirA, launchOpts);
  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);

  try {
    const a = await openOverlay(contextA, 'Visitor A');
    const b = await openOverlay(contextB, 'Visitor B');

    console.log('STEP 0: two visitors create their own real, independent wallet identities');
    const pkA = await createIdentity(a.frame, 'remote-trade-test-password-a');
    const pkB = await createIdentity(b.frame, 'remote-trade-test-password-b');
    if (pkA === pkB) throw new Error('Expected two independently created identities to differ');
    console.log('PASS: two independent identities ->', pkA.slice(0, 16) + '...', pkB.slice(0, 16) + '...');

    console.log('STEP 1: each visitor mines their own starting balance directly into their own "self" wallet');
    // Bypasses the market's own stalls on purpose — both visitors would
    // otherwise need to navigate their own separate profile all the way
    // through Plaza and into the Trading Post just to click a stall, and
    // this test cares about trading, not portal navigation. Calling
    // AtlasWallet.mintAsset('self', ...) directly is exactly what the
    // market's own "Mine Gold" stall does under the hood as of v1.15 (it
    // used to mint to role: 'counterparty' by mistake, fixed alongside
    // in-person trading's removal) — see handleInteractable's 'mint'
    // branch in viewer.js. refreshInventoryDisplay() is called explicitly
    // since this bypasses the click handler that normally triggers it.
    await a.frame.evaluate(async () => { await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.element.iron', 20); await refreshInventoryDisplay(); });
    await a.frame.waitForFunction(() => document.getElementById('selfCollectiblesList').textContent.includes('Iron Ingot ×20'), { timeout: 15000 });
    await b.frame.evaluate(async () => { await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.element.gold', 10); await refreshInventoryDisplay(); });
    await b.frame.waitForFunction(() => document.getElementById('selfCollectiblesList').textContent.includes('Gold Ingot ×10'), { timeout: 15000 });
    console.log('PASS: A holds 20 iron, B holds 10 gold — each in their own wallet, no counterparty involved');

    console.log('STEP 2: task #160 sanity check — a bound credential (atlas.membership) cannot be traded at all');
    const membershipCred = await postJson(8001, '/atlas/asset/issue', { ownerPublicKey: pkA, assetClass: 'atlas.membership' });
    if (membershipCred.asset.tradeScope !== 'bound') throw new Error('Expected atlas.membership to carry tradeScope: bound, got: ' + JSON.stringify(membershipCred.asset));
    const rejectedSplit = await postJson(8001, '/atlas/asset/split', { credential: membershipCred, sendAmount: 1, toPublicKey: pkA });
    if (!rejectedSplit.error || !rejectedSplit.error.includes('bound')) throw new Error('Expected a bound credential to be rejected with a "bound" reason, got: ' + JSON.stringify(rejectedSplit));
    console.log('PASS: bound credential rejected ->', rejectedSplit.error);

    console.log('STEP 3: A opens Sell and B opens Buy — each joins the Trading Station under their own identity, no role picker anywhere');
    await openTradingSubtab(a.frame, 'tradingSellSubtabBtn', 'tradingSellSubscreen');
    await joinTradingStationIfNeeded(a.frame);
    await openTradingSubtab(b.frame, 'tradingBuySubtabBtn', 'tradingBuySubscreen');
    await joinTradingStationIfNeeded(b.frame);
    console.log('PASS: both A and B joined the Trading Station, each under their own single identity');

    console.log('STEP 4: A posts an open listing (10 iron for 5 gold) on Sell — naming no counterparty at all');
    // "You offer" is a dropdown of A's own held fungible balances (v1.14
    // tweak) rather than free text — wait for it to actually populate with
    // the 20-iron balance minted back in STEP 1 before selecting it.
    await a.frame.waitForFunction(() => Array.from(document.getElementById('tradingSellOfferClassSelect').options).some((o) => o.value === 'atlas.element.iron'), { timeout: 10000 });
    await a.frame.locator('#tradingSellOfferClassSelect').selectOption('atlas.element.iron');
    await a.frame.locator('#tradingSellOfferQtyInput').fill('10');
    await a.frame.locator('#tradingSellWantClassSelect').selectOption('atlas.element.gold');
    await a.frame.locator('#tradingSellWantQtyInput').fill('5');
    await a.frame.locator('#tradingSellSubmitBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('tradingSellStatus').textContent.startsWith('✓ Posted'), { timeout: 15000 });
    console.log('PASS: A\'s listing is posted ->', await a.frame.locator('#tradingSellStatus').textContent());

    console.log('STEP 5: B\'s Buy tab shows A\'s listing (ungated browse) and claims it — settles immediately since B is live right now');
    await b.frame.locator('#tradingBuyRefreshBtn').click();
    const buyRow = b.frame.locator('#tradingBuyList .wallet-item', { hasText: '10 atlas.element.iron' });
    await buyRow.waitFor({ timeout: 15000 });
    await buyRow.locator('.trading-claim-btn').click();
    await b.frame.waitForFunction(() => document.getElementById('tradingBuyStatus').textContent.startsWith('✓ Traded'), { timeout: 15000 });
    console.log('PASS:', await b.frame.locator('#tradingBuyStatus').textContent());

    await b.frame.waitForFunction(
      () => document.getElementById('selfCollectiblesList').textContent.includes('Iron Ingot ×10') &&
            document.getElementById('selfCollectiblesList').textContent.includes('Gold Ingot ×5'),
      { timeout: 10000 }
    );
    console.log('PASS: B\'s own wallet updated immediately — received 10 iron, kept a 5-gold remainder');

    console.log('STEP 6: A has NOT received anything yet — settlement delivery to an absent, genuinely separate install is real, not silently synchronous');
    const aTextBeforeMailCheck = await a.frame.locator('#selfCollectiblesList').textContent();
    if (aTextBeforeMailCheck.includes('Gold Ingot')) throw new Error('A should not have gold yet — it should only arrive via mail check');
    if (!aTextBeforeMailCheck.includes('Iron Ingot ×20')) throw new Error('A\'s balance should still show the old, not-yet-superseded 20 iron: ' + aTextBeforeMailCheck);
    console.log('PASS: A\'s wallet is unchanged so far ->', aTextBeforeMailCheck.match(/Iron Ingot[^<]*/)[0]);

    console.log('STEP 7: checking A\'s mail delivers the remainder (via asset-update) and surfaces the received gold as a claimable gift');
    await a.frame.locator('#socialTabBtn').click();
    await a.frame.locator('#checkMailNowBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('selfCollectiblesList').textContent.includes('Iron Ingot ×10'), { timeout: 15000 });
    console.log('PASS: A\'s iron balance superseded to the 10-iron remainder automatically');

    const giftCard = a.frame.locator('#mailList .mail-card', { hasText: 'Listing claimed at localhost:8001' });
    await giftCard.waitFor({ timeout: 20000 });
    const giftCardText = await giftCard.textContent();
    if (!giftCardText.includes('Gold Ingot')) throw new Error('Expected the settlement mail to name the received gold: ' + giftCardText);

    // Tweak: a mail card carrying an unclaimed gift can't be deleted yet —
    // that gift's only copy lives on the card until Claim moves it into
    // the wallet, so Delete must stay disabled until then.
    const isUnclaimedYet = await giftCard.evaluate((el) => el.classList.contains('unread') && el.querySelector('button[data-action="delete"]').disabled);
    if (!isUnclaimedYet) throw new Error('Expected the unclaimed gift card to be unread with Delete disabled');
    console.log('PASS: unclaimed gift card is unread with Delete disabled');

    await giftCard.locator('button[data-action="claim-gift"]').click();
    await a.frame.waitForFunction(() => document.getElementById('status').textContent.includes('Claimed'), { timeout: 5000 });
    console.log('PASS: settlement notice mail received and gold claimed ->', giftCardText.trim());

    // Tweak: clicking Claim should mark the mail read AND unblock Delete.
    const isReadAndDeletableNow = await giftCard.evaluate((el) => !el.classList.contains('unread') && !el.querySelector('button[data-action="delete"]').disabled);
    if (!isReadAndDeletableNow) throw new Error('Expected claiming the gift to mark the card read and enable Delete');
    console.log('PASS: claiming the gift marked the mail read and enabled Delete');

    const finalGold = await a.frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      const gold = wallet.find((e) => e.credential.asset.class === 'atlas.element.gold');
      return gold ? gold.credential.quantity : 0;
    });
    if (finalGold !== 5) throw new Error('Expected A to hold exactly 5 gold after claiming, got: ' + finalGold);
    console.log('PASS: A ends up with the full trade result — 10 iron remainder + 5 gold received — settled entirely between two separate real installs, no counterparty stand-in anywhere');

    console.log('STEP 8: A posts a second listing, then withdraws it via Listings -> Cancel — it disappears from both A\'s Listings and B\'s Buy browse');
    await openTradingSubtab(a.frame, 'tradingSellSubtabBtn', 'tradingSellSubscreen');
    await a.frame.waitForFunction(() => Array.from(document.getElementById('tradingSellOfferClassSelect').options).some((o) => o.value === 'atlas.element.iron'), { timeout: 10000 });
    await a.frame.locator('#tradingSellOfferClassSelect').selectOption('atlas.element.iron');
    await a.frame.locator('#tradingSellOfferQtyInput').fill('3');
    await a.frame.locator('#tradingSellWantClassSelect').selectOption('atlas.element.gold');
    await a.frame.locator('#tradingSellWantQtyInput').fill('1');
    await a.frame.locator('#tradingSellSubmitBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('tradingSellStatus').textContent.startsWith('✓ Posted'), { timeout: 15000 });

    await openTradingSubtab(b.frame, 'tradingBuySubtabBtn', 'tradingBuySubscreen');
    await b.frame.locator('#tradingBuyRefreshBtn').click();
    const secondBuyRow = b.frame.locator('#tradingBuyList .wallet-item', { hasText: '3 atlas.element.iron' });
    await secondBuyRow.waitFor({ timeout: 15000 });
    console.log('PASS: B sees A\'s second listing on Buy before it\'s withdrawn');

    await openTradingSubtab(a.frame, 'tradingListingsSubtabBtn', 'tradingListingsSubscreen');
    const listingsRow = a.frame.locator('#tradingListingsList .wallet-item', { hasText: '3 atlas.element.iron' });
    await listingsRow.waitFor({ timeout: 10000 });
    await listingsRow.locator('.trading-cancel-btn').click();
    await a.frame.waitForFunction(
      () => Array.from(document.querySelectorAll('#tradingListingsList .wallet-item')).some((el) => el.textContent.includes('3 atlas.element.iron') && el.textContent.includes('canceled')),
      { timeout: 10000 }
    );
    console.log('PASS: A\'s second listing shows canceled in Listings');

    await b.frame.locator('#tradingBuyRefreshBtn').click();
    await b.frame.waitForFunction(
      () => !Array.from(document.querySelectorAll('#tradingBuyList .wallet-item')).some((el) => el.textContent.includes('3 atlas.element.iron')),
      { timeout: 10000 }
    );
    console.log('PASS: the withdrawn listing is gone from B\'s Buy browse too');

    console.log('STEP 9: A\'s first (now settled) listing gets a Delete button in Listings, and deleting it removes the local record');
    await openTradingSubtab(a.frame, 'tradingListingsSubtabBtn', 'tradingListingsSubscreen');
    const settledRow = a.frame.locator('#tradingListingsList .wallet-item', { hasText: '10 atlas.element.iron' });
    await settledRow.waitFor({ timeout: 10000 });
    const settledRowText = await settledRow.textContent();
    if (!settledRowText.includes('settled')) throw new Error('Expected A\'s first listing to show settled status, got: ' + settledRowText);
    await settledRow.locator('.trading-delete-listing-btn').click();
    await a.frame.waitForFunction(
      () => !Array.from(document.querySelectorAll('#tradingListingsList .wallet-item')).some((el) => el.textContent.includes('10 atlas.element.iron')),
      { timeout: 10000 }
    );
    console.log('PASS: deleting the settled listing removed it from A\'s Listings');

    console.log('STEP 10: A\'s canceled listing (from STEP 8) also gets a Delete button, and deleting it removes the local record too');
    const canceledRow = a.frame.locator('#tradingListingsList .wallet-item', { hasText: '3 atlas.element.iron' });
    await canceledRow.waitFor({ timeout: 10000 });
    const canceledRowText = await canceledRow.textContent();
    if (!canceledRowText.includes('canceled')) throw new Error('Expected A\'s second listing to still show canceled status, got: ' + canceledRowText);
    await canceledRow.locator('.trading-delete-listing-btn').click();
    await a.frame.waitForFunction(
      () => !Array.from(document.querySelectorAll('#tradingListingsList .wallet-item')).some((el) => el.textContent.includes('3 atlas.element.iron')),
      { timeout: 10000 }
    );
    console.log('PASS: deleting the canceled listing removed it from A\'s Listings');

    console.log('\nALL REMOTE TRADE (OPEN LISTINGS) CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close();
    await contextB.close();
  }
})();
