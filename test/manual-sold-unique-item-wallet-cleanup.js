// Manual UI check for the "sold item stays in my own wallet forever as
// ✗ revoked by issuer" bug — a seller's own report: "maybe i sold this
// and it didnt remove it, not sure." Confirmed root cause: for a
// same-domain Trading Station sale of a unique (non-fungible) item, or a
// fully-spent fungible balance, fulfillTradeSideSettlement's own
// remainder is always null (see that function's comment in
// issuer-server/server.js / issuer-php/lib/bootstrap.php), so it never
// appends an assetUpdates (supersession) record — only a bare
// revoke(id, 'superseded'). /atlas/mail/check can then only ever report
// {status: 'revoked', reason: 'superseded'} for that id, and
// processAssetUpdates() (extension/wallet.js) used to treat EVERY plain
// 'revoked' update the same way regardless of reason: just re-verify
// lastVerdict, never remove the stale entry. The seller's own wallet was
// left holding a permanent, unexplained "✗ revoked by issuer" ghost for
// an item they no longer own.
//
// Fix: processAssetUpdates() now special-cases reason === 'superseded'
// on a bare revocation — removes the stale entry and leaves an
// asset-update notice (same badge mechanism a reissue already uses),
// instead of merely re-verifying it. Every OTHER revocation reason
// (clawback, issuer-request, demo-self-serve, ...) is untouched — those
// still stay visible and flagged, since something involuntary happened
// to a still-HELD item there.
//
// Drives the real extension UI through an actual same-domain Trading
// Station sale (not a direct HTTP call to /atlas/trade/claim), same
// two-real-browser-profile pattern test/manual-trade-unique-item-ui.js
// already established for this exact sell/buy flow — this file adds the
// one check that one never made: what the SELLER's own wallet looks like
// afterward.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts. Run against the shared localhost:8001 dev server,
// with a freshly-reset atlas-serial-counters.json so the ring's own cap
// isn't already exhausted by an earlier run.

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

// Same searchable-combo driver manual-remote-trade.js / manual-trade-
// unique-item-ui.js already use (Task #205 wrapped every trading
// <select> in makeSearchableSelect).
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
  const dirA = path.resolve(__dirname, '.chrome-profile-sold-unique-cleanup-a');
  const dirB = path.resolve(__dirname, '.chrome-profile-sold-unique-cleanup-b');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };

  const contextA = await chromium.launchPersistentContext(dirA, launchOpts);
  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);

  try {
    const a = await openOverlay(contextA, 'Visitor A (seller)');
    const b = await openOverlay(contextB, 'Visitor B (buyer)');

    console.log('STEP 0: two visitors create their own real, independent wallet identities');
    const pkA = await createIdentity(a.frame, 'sold-unique-cleanup-test-password-a');
    const pkB = await createIdentity(b.frame, 'sold-unique-cleanup-test-password-b');
    if (pkA === pkB) throw new Error('Expected two independently created identities to differ');
    console.log('PASS: two independent identities ->', pkA.slice(0, 16) + '...', pkB.slice(0, 16) + '...');

    console.log('STEP 1: A mints a Signet Ring (non-fungible, local tradeScope); B mints gold');
    await a.frame.evaluate(async () => { await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.wearable.ring'); await refreshInventoryDisplay(); });
    await a.frame.waitForFunction(() => document.getElementById('selfCollectiblesList').textContent.includes("Merchant's Signet Ring"), { timeout: 15000 });
    const ringId = await a.frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      const entry = wallet.find((e) => e.credential.asset.class === 'atlas.wearable.ring');
      return entry ? entry.credential.id : null;
    });
    if (!ringId) throw new Error('Expected A to hold a freshly-minted ring');
    console.log('PASS: A holds the ring ->', ringId);

    await b.frame.evaluate(async () => { await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.element.gold', 10); await refreshInventoryDisplay(); });
    await b.frame.waitForFunction(() => document.getElementById('selfCollectiblesList').textContent.includes('Gold (Au) ×10 g'), { timeout: 15000 });
    console.log('PASS: B holds 10 gold');

    console.log('STEP 2: A sells the ring for 3 gold (same-domain Trading Station — tradeScope: local)');
    await openTradingSubtab(a.frame, 'tradingSellSubtabBtn', 'tradingSellSubscreen');
    await joinTradingStationIfNeeded(a.frame);
    await a.frame.waitForFunction(() => Array.from(document.getElementById('tradingSellOfferClassSelect').options).some((o) => o.value === 'atlas.wearable.ring'), { timeout: 10000 });
    await pickSearchable(a.frame, 'tradingSellOfferClassSelect', 'atlas.wearable.ring');
    await a.frame.waitForFunction(() => document.getElementById('tradingSellOfferQtyInput').disabled === true, { timeout: 5000 });
    await a.frame.waitForFunction(() => Array.from(document.getElementById('tradingSellWantClassSelect').options).some((o) => o.value === 'atlas.element.gold'), { timeout: 10000 });
    await pickSearchable(a.frame, 'tradingSellWantClassSelect', 'atlas.element.gold');
    await a.frame.locator('#tradingSellWantQtyInput').fill('3');
    await a.frame.locator('#tradingSellSubmitBtn').click();
    await a.frame.waitForFunction(() => document.getElementById('tradingSellStatus').textContent.startsWith('✓ Posted'), { timeout: 15000 });
    console.log('PASS: A\'s listing is posted ->', await a.frame.locator('#tradingSellStatus').textContent());

    console.log('STEP 3: B claims it — the ring is now genuinely B\'s, A\'s balance is spent server-side');
    await openTradingSubtab(b.frame, 'tradingBuySubtabBtn', 'tradingBuySubscreen');
    await joinTradingStationIfNeeded(b.frame);
    await b.frame.locator('#tradingBuyRefreshBtn').click();
    const buyRow = b.frame.locator('#tradingBuyList .wallet-item', { hasText: 'atlas.wearable.ring' });
    await buyRow.waitFor({ timeout: 15000 });
    await buyRow.locator('.trading-claim-btn').click();
    await b.frame.waitForFunction(() => document.getElementById('tradingBuyStatus').textContent.startsWith('✓ Traded'), { timeout: 15000 });
    console.log('PASS: B claimed the ring ->', await b.frame.locator('#tradingBuyStatus').textContent());

    console.log('STEP 4: before A ever checks mail, the server-side state is already the exact shape this bug needs — a bare revoked/superseded update, no assetUpdates record');
    const rawUpdate = await a.frame.evaluate(async (id) => {
      const res = await fetch('http://localhost:8001/atlas/mail/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentialIds: [id] }) });
      const body = await res.json();
      return body.updates.find((u) => u.id === id) || null;
    }, ringId);
    if (!rawUpdate || rawUpdate.status !== 'revoked' || rawUpdate.reason !== 'superseded' || rawUpdate.newCredential) {
      throw new Error('Expected a bare {status: revoked, reason: superseded} update with no newCredential, got: ' + JSON.stringify(rawUpdate));
    }
    console.log('PASS: confirmed the exact server shape that used to leave a ghost ->', JSON.stringify(rawUpdate));

    console.log('STEP 5: A checks mail — the fix should REMOVE the stale ring entry rather than leave it flagged revoked');
    const unseenBefore = await a.frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const notices = await AtlasWallet.getAssetUpdateNotices(identity.publicKey);
      return notices.filter((n) => !n.seen).length;
    });
    await a.frame.locator('#socialTabBtn').click();
    await a.frame.locator('#checkMailNowBtn').click();
    // The gold itself arrives as a mail-gift attachment needing its own
    // "claim-gift" click (same path manual-trade-unique-item-ui.js's own
    // STEP 7 exercises) — unrelated to this bug and not needed to prove
    // it, so just wait on the thing processAssetUpdates() actually does
    // synchronously within the same mail-check round trip: the ring
    // itself disappearing from the collectibles list.
    await a.frame.waitForFunction(() => !document.getElementById('selfCollectiblesList').textContent.includes("Merchant's Signet Ring"), { timeout: 15000 });

    const walletAfter = await a.frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      return wallet.map((e) => ({ id: e.credential.id, class: e.credential.asset.class, verdict: e.lastVerdict && e.lastVerdict.valid }));
    });
    const stillPresent = walletAfter.find((e) => e.id === ringId);
    if (stillPresent) throw new Error('Expected the sold ring to be GONE from A\'s own wallet, but found: ' + JSON.stringify(stillPresent));
    console.log('PASS: the sold ring is no longer in A\'s wallet at all ->', JSON.stringify(walletAfter.map((e) => e.class)));

    const ghostInDom = await a.frame.evaluate(() => document.getElementById('selfCollectiblesList').textContent.includes("Merchant's Signet Ring"));
    if (ghostInDom) throw new Error('Expected no "Merchant\'s Signet Ring" text left in the collectibles list DOM');
    console.log('PASS: no "revoked by issuer" ghost rendered for the ring either');

    console.log('STEP 6: a notice was left behind recording the sale, and the badge reflects it as unseen');
    const noticesAfter = await a.frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      return AtlasWallet.getAssetUpdateNotices(identity.publicKey);
    });
    const ringNotice = noticesAfter.find((n) => n.oldId === ringId);
    if (!ringNotice) throw new Error('Expected a notice recording the ring\'s removal, got notices: ' + JSON.stringify(noticesAfter));
    if (ringNotice.newId !== null) throw new Error('Expected newId: null on a "sold, nothing replaces it" notice, got: ' + JSON.stringify(ringNotice));
    const unseenAfter = noticesAfter.filter((n) => !n.seen).length;
    if (unseenAfter <= unseenBefore) throw new Error('Expected the unseen notice count to have increased, before=' + unseenBefore + ' after=' + unseenAfter);
    console.log('PASS: a "sold" notice was recorded ->', JSON.stringify(ringNotice));

    console.log('\nALL SOLD-UNIQUE-ITEM WALLET CLEANUP CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close();
    await contextB.close();
  }
})();
