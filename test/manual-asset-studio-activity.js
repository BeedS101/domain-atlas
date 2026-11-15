// Asset Studio mint -> wallet offer -> Social tab -> explicit Claim -> Activity, in a real browser: the actual Studio page, the
// actual wallet extension and a real PHP issuer (isolated copy, fresh key and state). Run with a display:
//   xvfb-run -a node test/manual-asset-studio-activity.js
//
// Proves: (1) an approved offer opens the wallet's Social tab at Pending offers and highlights that offer with its Claim
// button, without claiming it and without recording anything; (2) only Claim adds the item, and then one detailed Activity
// entry exists (name, issuer, identity, credential id, source "Asset Studio") that keeps Show in inventory and a collapsed
// Details section; (3) a denied offer queues nothing, moves nothing and records nothing; (4) the same credential offered
// again and claimed again is recorded once; (5) with several offers pending, the newest one is highlighted; (6) an offer
// from another origin is labelled as a website offer, not Asset Studio.
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StudioLab } = require('./studio-lab');
const BP = require('./lib/bridge-prompt');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-activity-profile-'));
const CLASS = 'atlas.demo.studio.collectible';

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 700)));
  if (!ok) failures++;
};

(async () => {
  const lab = await StudioLab.start({ mint: true, config: { mintsPerIpPerHour: 100, challengesPerIpPerHour: 100, maxMintsPerRecipientPerDay: 50, maxMintsPerActorPerDay: 50, maxMintsPerNetworkPerDay: 50 } });
  const spatial = {
    spec: 'domain-atlas/1.0', domain: lab.host, owner: { name: 'Studio Test Domain', contact: 'demo@localhost' },
    defaultWorld: 'lobby',
    worlds: [
      { id: 'lobby', name: 'Lobby', entry: { scene: '/spatial/lobby/scene.json', renderer: ['procedural-v1'] },
        policy: { guestAccess: 'open', discoverable: true, identityRequired: false, itemDropsAllowed: false, acceptedItemClasses: [], trustedIssuers: 'any' } },
      { id: 'studio', name: 'Asset Studio', policy: { walletBridge: { read: true, sign: ['atlas.studio.mint/1'], offer: [CLASS] } } },
    ],
    updated: '2026-10-02T00:00:00Z',
  };
  fs.mkdirSync(path.join(lab.docroot, '.well-known'), { recursive: true });
  fs.writeFileSync(path.join(lab.docroot, '.well-known', 'spatial.json'), JSON.stringify(spatial, null, 2));

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, executablePath: '/opt/pw-browsers/chromium',
    args: ['--disable-extensions-except=' + EXT_PATH, '--load-extension=' + EXT_PATH, '--no-sandbox'],
  });
  try {
    let background = context.serviceWorkers()[0];
    if (!background) background = await context.waitForEvent('serviceworker');
    const extensionId = new URL(background.url()).host;

    // The wallet, created through its own screens, stays open in the background.
    const wallet = await context.newPage();
    await wallet.goto('chrome-extension://' + extensionId + '/viewer.html', { waitUntil: 'load' });
    await wallet.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 10000 });
    await wallet.locator('#chooseNewBtn').click();
    await wallet.locator('#newPasswordInput').fill('studio-activity-test-pw');
    await wallet.locator('#newPasswordConfirmInput').fill('studio-activity-test-pw');
    await wallet.locator('#confirmCreateBtn').click();
    await wallet.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await wallet.locator('#seedConfirmCheck').check();
    await wallet.locator('#seedConfirmBtn').click();
    await wallet.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    const me = (await wallet.evaluate(() => AtlasWallet.getIdentity())).publicKey;
    // Whatever was pending before is already known; only later arrivals are new.
    await wallet.evaluate(() => refreshBridgeOffersDisplay());

    const studio = await context.newPage();
    await studio.goto(lab.origin + '/atlas/studio/index.html', { waitUntil: 'load' });
    await studio.bringToFront();
    await studio.evaluate(() => window.dispatchEvent(new Event('focus')));
    await studio.waitForFunction(() => !document.getElementById('mint').disabled, null, { timeout: 20000 });

    const pendingOffers = () => wallet.evaluate((k) => AtlasWallet.getBridgeOffers(k), me);
    const held = () => wallet.evaluate(async (k) => (await AtlasWallet.getWallet(k)).map((e) => e.credential), me);
    const log = () => wallet.evaluate(() => AtlasWallet.getActivityLog());
    const screenState = () => wallet.evaluate(() => ({
      screen: (document.querySelector('.wallet-screen.active') || {}).id, social: document.getElementById('socialScreen').classList.contains('active'),
      inbox: document.getElementById('mailBoxInboxSubscreen').classList.contains('active'), sectionShown: document.getElementById('bridgeOffersSection').style.display === 'block',
      highlighted: Array.from(document.querySelectorAll('#bridgeOffersList .bridge-offer-new')).map((c) => c.dataset.id),
      cards: Array.from(document.querySelectorAll('#bridgeOffersList .wallet-item')).map((c) => ({ id: c.dataset.id, claim: !!c.querySelector('[data-action="claim-bridge-offer"]'), text: c.textContent.replace(/\s+/g, ' ') }))
    }));

    // Mints through the Studio page. `decision` is what is pressed at the wallet's offer prompt.
    async function studioMint(name, decision) {
      await studio.bringToFront();
      await BP.gone(studio, { timeout: 15000 });
      await studio.waitForFunction(() => !document.getElementById('mint').disabled, null, { timeout: 15000 });
      await studio.locator('#assetName').fill(name);
      await studio.locator('#mint').click();
      await BP.wait(studio, { timeout: 15000 });
      let frame = BP.frame(studio);
      await frame.locator('#readyState').waitFor({ state: 'visible', timeout: 10000 });
      await frame.locator('#approveBtn').click();
      await BP.gone(studio, { timeout: 15000 }).catch(() => {});
      await BP.wait(studio, { timeout: 15000 });
      frame = BP.frame(studio);
      await frame.locator('#offerState').waitFor({ state: 'visible', timeout: 15000 });
      await frame.locator(decision === 'approve' ? '#offerApproveBtn' : '#offerDenyBtn').click();
      await studio.waitForFunction(() => /Offered to your wallet|Added to your wallet|declined|timed out|not permitted/.test(document.getElementById('message').textContent), null, { timeout: 15000 });
    }
    const goHome = () => wallet.evaluate(() => showWalletScreen('mainWalletScreen'));

    // 1. An approved offer is brought to the Social tab, highlighted, not claimed, not recorded.
    await goHome();
    await studioMint('Walkthrough Trophy', 'approve');
    await wallet.waitForFunction(() => document.getElementById('socialScreen').classList.contains('active'), null, { timeout: 10000 });
    let offers = await pendingOffers();
    const first = offers.find((e) => e.credential.asset.name === 'Walkthrough Trophy');
    let st = await screenState();
    check('the offer is queued unclaimed', !!first && !first.claimed && first.origin === lab.origin, offers.map((o) => o.origin));
    check('the wallet moved to Social, Mail inbox, with Pending offers showing', st.social && st.inbox && st.sectionShown, st);
    check('the new offer is highlighted and shows its Claim action', st.highlighted.length === 1 && st.highlighted[0] === first.id && st.cards.find((c) => c.id === first.id).claim && /Walkthrough Trophy/.test(st.cards.find((c) => c.id === first.id).text), st);
    check('nothing was claimed: the item is not held and Activity has no entry for it', !(await held()).some((c) => c.id === first.credential.id) && !(await log()).some((e) => e.meta && e.meta.kind === 'bridge-claim'), await log());

    // 2. Claiming by hand adds it and records it once.
    await wallet.locator('#bridgeOffersList .bridge-offer-new [data-action="claim-bridge-offer"]').click();
    await wallet.waitForFunction((id) => !document.querySelector('#bridgeOffersList .wallet-item[data-id="' + id + '"]'), first.id, { timeout: 10000 });
    check('Claim added the item to the inventory', (await held()).some((c) => c.id === first.credential.id));
    let entries = (await log()).filter((e) => e.meta && e.meta.kind === 'bridge-claim');
    const one = entries[0];
    check('one Activity entry: "Received Walkthrough Trophy"', entries.length === 1 && one.text === 'Received Walkthrough Trophy', entries.map((e) => e.text));
    check('it records the issuer, the receiving identity, the credential id and the source "Asset Studio"', one.meta.legs[0].domain === lab.host && one.meta.identity.label === 'Main identity' && one.meta.identity.publicKey === me && one.meta.legs[0].assetId === first.credential.id && one.meta.source === 'Asset Studio' && one.meta.offeredBy === lab.origin && one.meta.offerId === first.id, one.meta);
    check('a unique item: its name and one item, no mass unit, no balances', one.meta.legs[0].fungible === false && one.meta.legs[0].unit === null && one.meta.legs[0].quantity === 1 && one.meta.legs[0].previousBalance === undefined, one.meta.legs[0]);
    const card = await wallet.evaluate(async (prefix) => {
      await refreshActivityLogDisplay();
      const c = Array.from(document.querySelectorAll('#activityLogList .info-card')).find((x) => x.querySelector('.name').textContent.startsWith(prefix));
      if (!c) return null;
      const spaced = c.cloneNode(true);
      spaced.querySelectorAll('.k, li, .name').forEach((el) => el.append(' '));
      const tech = c.querySelector('details.activity-tech');
      return { text: spaced.textContent.replace(/\s+/g, ' '), link: c.classList.contains('activity-link'), tech: !!tech, open: !!(tech && tech.open), techText: tech ? tech.textContent : '' };
    }, 'Received Walkthrough Trophy');
    check('the card shows Issuer, Identity, Source and Offered by', !!card && card.text.includes('Issuer: ' + lab.host) && card.text.includes('Identity: Main identity') && card.text.includes('Source: Asset Studio') && card.text.includes('Offered by: ' + lab.origin), card && card.text);
    check('Show in inventory is kept and the Details section is collapsed with the credential id', !!card && card.link && card.tech && !card.open && card.techText.includes(first.credential.id), card);

    // 3. A denied offer queues nothing, moves nothing, records nothing.
    await goHome();
    const queuedBefore = (await pendingOffers()).length;
    await studioMint('Denied Trophy', 'deny');
    await wallet.waitForTimeout(800);
    st = await screenState();
    check('a denied offer: nothing queued, the wallet stays on its own screen, nothing recorded', (await pendingOffers()).length === queuedBefore && st.screen === 'mainWalletScreen' && !(await held()).some((c) => c.asset.name === 'Denied Trophy') && (await log()).filter((e) => e.meta && e.meta.kind === 'bridge-claim').length === 1, { st, queuedBefore });

    // 4. The same credential offered again: both claims are possible calls, but it is recorded and held once.
    await goHome();
    const dup = studio.evaluate((c) => window.atlasWallet.offerAsset(c), first.credential);
    dup.catch(() => {});
    await studio.bringToFront();
    await BP.wait(studio, { timeout: 15000 });
    const dframe = BP.frame(studio);
    await dframe.locator('#offerState').waitFor({ state: 'visible', timeout: 15000 });
    await dframe.locator('#offerApproveBtn').click();
    await dup;
    await wallet.waitForFunction(() => document.getElementById('socialScreen').classList.contains('active'), null, { timeout: 10000 });
    offers = await pendingOffers();
    const second = offers.find((e) => !e.claimed && e.credential.id === first.credential.id);
    check('the duplicate offer is queued as its own entry', !!second && second.id !== first.id, offers.map((o) => [o.id, o.claimed]));
    const heldBefore = (await held()).filter((c) => c.id === first.credential.id).length;
    const dupClaim = await wallet.evaluate((a) => AtlasWallet.claimBridgeOffer(a.k, a.id).then(() => 'claimed', (e) => String(e.message)), { k: me, id: second.id });
    entries = (await log()).filter((e) => e.meta && e.meta.kind === 'bridge-claim' && e.meta.legs[0].assetId === first.credential.id);
    check('claiming the duplicate leaves one Activity entry and one held copy', entries.length === 1 && (await held()).filter((c) => c.id === first.credential.id).length === heldBefore, { dupClaim, entries: entries.length, held: (await held()).filter((c) => c.id === first.credential.id).length });
    await wallet.evaluate((a) => AtlasWallet.dismissBridgeOffer(a.k, a.id).catch(() => null), { k: me, id: second.id });

    // 5. Several pending offers: the newest is the one highlighted.
    await goHome();
    await studioMint('Second Trophy', 'approve');
    await wallet.waitForFunction(() => document.querySelectorAll('#bridgeOffersList .bridge-offer-new').length === 1, null, { timeout: 10000 });
    const secondOffer = (await pendingOffers()).find((e) => !e.claimed && e.credential.asset.name === 'Second Trophy');
    await studioMint('Third Trophy', 'approve');
    const thirdOffer = (await pendingOffers()).find((e) => !e.claimed && e.credential.asset.name === 'Third Trophy');
    await wallet.waitForFunction((id) => !!document.querySelector('#bridgeOffersList .bridge-offer-new[data-id="' + id + '"]'), thirdOffer.id, { timeout: 10000 });
    st = await screenState();
    check('with two offers pending the new one is highlighted, the older one is not, and both keep their Claim', st.highlighted.length === 1 && st.highlighted[0] === thirdOffer.id && st.cards.length === 2 && st.cards.every((c) => c.claim), st);
    check('neither was claimed for the person', !(await held()).some((c) => c.id === secondOffer.credential.id || c.id === thirdOffer.credential.id), null);

    // 6. The same credential type offered from another origin is a website offer.
    const other = await wallet.evaluate(async (a) => {
      const entry = await AtlasWallet.queueBridgeOffer(a.k, 'https://shop.example', a.c);
      return { id: entry.id };
    }, { k: me, c: thirdOffer.credential });
    await wallet.evaluate((a) => AtlasWallet.dismissBridgeOffer(a.k, a.id), { k: me, id: thirdOffer.id });
    await wallet.evaluate((a) => AtlasWallet.claimBridgeOffer(a.k, a.id), { k: me, id: other.id });
    const site = (await log()).find((e) => e.meta && e.meta.kind === 'bridge-claim' && e.meta.legs[0].assetId === thirdOffer.credential.id);
    check('an offer from another origin is recorded as a "Website asset offer" with that origin', !!site && site.meta.source === 'Website asset offer' && site.meta.offeredBy === 'https://shop.example', site && site.meta);
  } finally {
    await context.close().catch(() => {});
    await lab.stop();
    lab.cleanup();
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  }
  console.log(failures ? '\nFAILED: ' + failures : '\nAll Asset Studio activity checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FAIL: ' + (e && e.stack || e)); process.exit(1); });
