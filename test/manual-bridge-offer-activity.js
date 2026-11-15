// Activity for a claimed bridge offer, and how a newly queued offer is brought into view. The wallet claims real
// issuer-signed credentials from throw-away Node or PHP issuers in a disposable Chromium profile with the real extension.
// The real Asset Studio page is covered by manual-asset-studio-activity.js; here the offers arrive the way any website's
// do, which also covers the origin label, a fungible balance, a second identity, and the cases that must record nothing.
//
//   xvfb-run -a node test/manual-bridge-offer-activity.js [node|php|both]
'use strict';
const U = require('./manual-gen1-unique-recovery');
const { check, scenario, mint, live, sum } = U;
const { GOLD } = U.constants;
const RING = 'atlas.wearable.ring';
const SHOP = 'https://shop.example';
const which = U.which;

const entries = (w) => w.W(() => AtlasWallet.getActivityLog());
const claims = (log) => log.filter((e) => e.meta && e.meta.kind === 'bridge-claim');
const queue = (w, owner, origin, cred) => w.W((a) => AtlasWallet.queueBridgeOffer(a.k, a.o, a.c).then((e) => ({ id: e.id }), (e) => ({ error: String(e.message) })), { k: owner, o: origin, c: cred });
const claim = (w, owner, id) => w.W((a) => AtlasWallet.claimBridgeOffer(a.k, a.id).then((r) => ({ valid: !!(r.verdict && r.verdict.valid) }), (e) => ({ error: String(e.message) })), { k: owner, id });
const offersOf = (w, owner) => w.W((k) => AtlasWallet.getBridgeOffers(k), owner);
const issueTo = (iss, pub, cls, q) => U.rawIssue(iss, { pub }, cls, q);
const heldCount = (w, owner, id) => w.W(async (a) => (await AtlasWallet.getWallet(a.k)).filter((e) => e.credential.id === a.id).length, { k: owner, id });

async function openViewer(w) {
  const id = new URL(w.sw.url()).host;
  const page = await w.context.newPage();
  await page.goto('chrome-extension://' + id + '/viewer.html');
  await page.waitForFunction(() => typeof AtlasWallet !== 'undefined' && typeof revealBridgeOffer === 'function', null, { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('mainWalletScreen') && !!document.querySelector('.wallet-screen.active'), null, { timeout: 20000 });
  await page.evaluate(() => refreshBridgeOffersDisplay());
  return page;
}
const viewState = (page) => page.evaluate(() => ({
  screen: (document.querySelector('.wallet-screen.active') || {}).id,
  highlighted: Array.from(document.querySelectorAll('#bridgeOffersList .bridge-offer-new')).map((c) => c.dataset.id),
  cards: Array.from(document.querySelectorAll('#bridgeOffersList .wallet-item')).map((c) => ({ id: c.dataset.id, claim: !!c.querySelector('[data-action="claim-bridge-offer"]') })),
  badge: (document.getElementById('socialBadge') || {}).textContent || ''
}));
const settle = (page) => page.waitForTimeout(700);

async function scenarios(kind) {
  await scenario(kind, 'B1 a fungible website offer: measured balances, one entry, a website label', async (w, S) => {
    check('5 g gold held first', (await mint(w, S, GOLD, 5)) === 'ok');
    const cred = await issueTo(S, w.pub, GOLD, 4);
    const q = await queue(w, w.pub, SHOP, cred);
    let log = await entries(w);
    check('queuing records nothing', !q.error && claims(log).length === 0, q);
    const out = await claim(w, w.pub, q.id);
    log = await entries(w);
    const e = claims(log);
    check('the claim verifies and the gold is merged into one 9 g balance', out.valid === true && sum(await live(w, GOLD)) === 9 && (await live(w, GOLD)).length === 1, { out, rows: await live(w, GOLD) });
    check('one entry "Received 4 g Gold (Au)"', e.length === 1 && e[0].text === 'Received 4 g Gold (Au)', e.map((x) => x.text));
    const leg = e[0].meta.legs[0];
    check('previous 5 g, change +4 g, new 9 g, measured from the wallet', leg.previousBalance === 5 && leg.quantity === 4 && leg.newBalance === 9 && leg.fungible === true && leg.unit === 'g', leg);
    check('issuer, receiving identity, credential id and the offering site are recorded', leg.domain === S.domain && leg.assetId === cred.id && e[0].meta.identity.label === 'Main identity' && e[0].meta.offeredBy === SHOP && e[0].meta.offerId === q.id, e[0].meta);
    check('an ordinary website offer is not labelled Asset Studio', e[0].meta.source === 'Website asset offer', e[0].meta.source);
    check('the consolidation that followed was not logged as a receipt', !log.some((x) => /^Received/.test(x.text) && x !== e[0]) && !log.some((x) => /Consolidat/i.test(x.text)), log.map((x) => x.text));

    const page = await openViewer(w);
    const text = await page.evaluate(async () => {
      await refreshActivityLogDisplay();
      const c = Array.from(document.querySelectorAll('#activityLogList .info-card')).find((x) => x.querySelector('.name').textContent.startsWith('Received 4 g'));
      if (!c) return null;
      const s = c.cloneNode(true);
      s.querySelectorAll('.k, li, .activity-leg, .name').forEach((el) => el.append(' '));
      const t = c.querySelector('details.activity-tech');
      return { text: s.textContent.replace(/\s+/g, ' '), link: c.classList.contains('activity-link'), techOpen: !!(t && t.open), tech: !!t };
    });
    check('the card shows previous, change and new balance, the source, and the site', !!text && /Previous balance: 5 g/.test(text.text) && /Change: \+4 g/.test(text.text) && /New balance: 9 g/.test(text.text) && /Source: Website asset offer/.test(text.text) && text.text.includes('Offered by: ' + SHOP), text && text.text);
    check('Show in inventory and a collapsed Details section are kept', !!text && text.link && text.tech && !text.techOpen, text);
    await page.close();
  }, { workers: 4 });

  await scenario(kind, 'B2 nothing is recorded for an offer that is only queued, dismissed, forged or someone else\'s', async (w, S, ctx) => {
    const cred = await issueTo(S, w.pub, GOLD, 3);
    const q = await queue(w, w.pub, SHOP, cred);
    check('queued: no entry, nothing held', claims(await entries(w)).length === 0 && sum(await live(w, GOLD)) === 0);
    await w.W((a) => AtlasWallet.dismissBridgeOffer(a.k, a.id), { k: w.pub, id: q.id });
    check('dismissed: no entry, nothing held, the offer is gone', claims(await entries(w)).length === 0 && sum(await live(w, GOLD)) === 0 && !(await offersOf(w, w.pub)).some((o) => o.id === q.id));

    const forged = JSON.parse(JSON.stringify(await issueTo(S, w.pub, GOLD, 2)));
    forged.quantity = 2000;
    const qf = await queue(w, w.pub, SHOP, forged);
    const outF = await claim(w, w.pub, qf.id);
    check('forged quantity: the claim does not succeed, nothing held, no entry', outF.valid !== true && sum(await live(w, GOLD)) === 0 && claims(await entries(w)).length === 0, outF);

    const other = await U.rawIdentity();
    const foreign = await issueTo(S, other.pub, GOLD, 5);
    const qo = await queue(w, w.pub, SHOP, foreign);
    const outO = await claim(w, w.pub, qo.id);
    check('a credential owned by someone else: refused, nothing held, no entry', outO.valid !== true && sum(await live(w, GOLD)) === 0 && claims(await entries(w)).length === 0, { qo, outO });

    const real = await issueTo(S, w.pub, GOLD, 6);
    const qr = await queue(w, w.pub, SHOP, real);
    const first = await claim(w, w.pub, qr.id);
    check('a genuine offer after all that is recorded normally, once', first.valid === true && claims(await entries(w)).length === 1 && sum(await live(w, GOLD)) === 6, first);
  }, { workers: 4 });

  await scenario(kind, 'B3 the same offer claimed twice, or offered twice, is recorded once', async (w, S) => {
    const cred = await issueTo(S, w.pub, GOLD, 4);
    const a = await queue(w, w.pub, SHOP, cred);
    const first = await claim(w, w.pub, a.id);
    const again = await claim(w, w.pub, a.id);
    check('claiming the same offer again changes nothing', first.valid === true && sum(await live(w, GOLD)) === 4 && claims(await entries(w)).length === 1, { first, again });
    const b = await queue(w, w.pub, SHOP, cred);
    const second = await claim(w, w.pub, b.id);
    const log = await entries(w);
    check('the same credential offered again and claimed is still one entry, with no extra gold', claims(log).length === 1 && sum(await live(w, GOLD)) === 4, { second, texts: log.map((x) => x.text) });
  }, { workers: 4 });

  await scenario(kind, 'B4 an offer for another identity of the wallet is logged under that identity', async (w, S) => {
    const sub = await w.W(() => AtlasWallet.createSubIdentity('Travel'));
    const cred = await issueTo(S, sub.publicKey, RING, 1);
    const q = await queue(w, sub.publicKey, SHOP, cred);
    const out = await claim(w, sub.publicKey, q.id);
    check('the ring is claimed into the Travel identity', out.valid === true && (await heldCount(w, sub.publicKey, cred.id)) === 1 && (await heldCount(w, w.pub, cred.id)) === 0, out);
    check('the acting identity\'s log is untouched', claims(await entries(w)).length === 0);
    await w.W((id) => AtlasWallet.switchIdentity(id), sub.id);
    const subClaims = claims(await entries(w));
    check('the Travel identity\'s log has the entry, naming Travel, as a unique item with no balances', subClaims.length === 1 && subClaims[0].meta.identity.label === 'Travel' && subClaims[0].meta.legs[0].fungible === false && subClaims[0].meta.legs[0].previousBalance === undefined, subClaims.map((x) => x.meta));
    await w.W(() => AtlasWallet.switchIdentity(null));
  }, { workers: 4 });

  await scenario(kind, 'B5 a queued offer is brought into view only when the wallet is free, and is never claimed', async (w, S) => {
    const page = await openViewer(w);
    const fresh = async (cls, q) => issueTo(S, w.pub, cls || GOLD, q || 1);

    // Free on the wallet's home screen.
    await page.evaluate(() => showWalletScreen('mainWalletScreen'));
    const c1 = await fresh(GOLD, 2);
    const q1 = await queue(w, w.pub, SHOP, c1);
    await page.waitForFunction(() => document.getElementById('socialScreen').classList.contains('active'), null, { timeout: 8000 });
    await settle(page);
    let st = await viewState(page);
    check('free: the Social tab is selected with the new offer highlighted and claimable', st.screen === 'socialScreen' && st.highlighted.length === 1 && st.highlighted[0] === q1.id && st.cards.some((c) => c.id === q1.id && c.claim), st);
    check('it was not claimed: no gold, no entry', sum(await live(w, GOLD)) === 0 && claims(await entries(w)).length === 0);

    // Two pending: the newest is highlighted.
    const c2 = await fresh(GOLD, 3);
    const q2 = await queue(w, w.pub, SHOP, c2);
    await page.waitForFunction((id) => !!document.querySelector('#bridgeOffersList .bridge-offer-new[data-id="' + id + '"]'), q2.id, { timeout: 8000 });
    st = await viewState(page);
    check('two pending: only the newer is highlighted and both keep their Claim', st.highlighted.length === 1 && st.highlighted[0] === q2.id && st.cards.length === 2 && st.cards.every((c) => c.claim), st);

    // Busy on another screen: left alone.
    await page.evaluate(() => showWalletScreen('settingsScreen'));
    const before = (await viewState(page)).screen;
    const c3 = await fresh(GOLD, 1);
    const q3 = await queue(w, w.pub, SHOP, c3);
    await settle(page);
    st = await viewState(page);
    check('on another screen: the wallet stays where it is, the offer waits as pending', st.screen === before && before === 'settingsScreen' && (await offersOf(w, w.pub)).some((o) => o.id === q3.id && !o.claimed), st);

    // Typing in a field: left alone.
    await page.evaluate(() => { showWalletScreen('mainWalletScreen'); const i = document.createElement('input'); i.id = 'probeInput'; i.type = 'text'; document.getElementById('mainWalletScreen').appendChild(i); i.focus(); });
    const c4 = await fresh(GOLD, 1);
    await queue(w, w.pub, SHOP, c4);
    await settle(page);
    st = await viewState(page);
    check('while typing: the wallet does not switch screens', st.screen === 'mainWalletScreen', st);
    await page.evaluate(() => { const i = document.getElementById('probeInput'); i.blur(); i.remove(); });

    // Wallet panel closed: nothing is forced open, the badge shows the pending offers.
    await page.evaluate(() => { document.getElementById('walletPanel').classList.remove('open'); showWalletScreen('mainWalletScreen'); });
    const c5 = await fresh(GOLD, 1);
    await queue(w, w.pub, SHOP, c5);
    await settle(page);
    st = await viewState(page);
    const panelOpen = await page.evaluate(() => document.getElementById('walletPanel').classList.contains('open'));
    check('wallet closed: it is not opened or switched, and the pending offers are counted in the Social badge', !panelOpen && st.screen === 'mainWalletScreen' && /\d/.test(st.badge), { panelOpen, st });
    await page.evaluate(() => document.getElementById('walletPanel').classList.add('open'));

    // A claim or dismissal brings nothing new into view.
    await page.evaluate(() => showWalletScreen('mainWalletScreen'));
    await w.W((a) => AtlasWallet.dismissBridgeOffer(a.k, a.id), { k: w.pub, id: q3.id });
    await settle(page);
    st = await viewState(page);
    check('dismissing an offer does not pull the wallet to Social', st.screen === 'mainWalletScreen', st);

    // Claim through the card as a person would.
    await page.evaluate(() => showWalletScreen('socialScreen'));
    await page.evaluate(() => refreshBridgeOffersDisplay());
    const heldBefore = sum(await live(w, GOLD));
    await page.locator('#bridgeOffersList .wallet-item[data-id="' + q2.id + '"] [data-action="claim-bridge-offer"]').click();
    await page.waitForFunction((id) => !document.querySelector('#bridgeOffersList .wallet-item[data-id="' + id + '"]'), q2.id, { timeout: 15000 });
    const log = await entries(w);
    const e = claims(log).filter((x) => x.meta.offerId === q2.id);
    check('pressing Claim adds the gold (3 g) and records exactly that offer, with balances', heldBefore === 0 && sum(await live(w, GOLD)) === 3 && e.length === 1 && e[0].meta.legs[0].previousBalance === 0 && e[0].meta.legs[0].newBalance === 3, { heldBefore, e: e.map((x) => x.meta) });
    check('the other pending offers are still unclaimed', (await offersOf(w, w.pub)).filter((o) => !o.claimed).length >= 3 && claims(log).length === 1);
    await page.close();
  }, { workers: 4 });
}

async function main() {
  const kinds = which === 'both' ? ['node', 'php'] : [which];
  for (const kind of kinds) await scenarios(kind);
  const { passes, failures } = U.counts();
  console.log(`\nbridge offer activity: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
