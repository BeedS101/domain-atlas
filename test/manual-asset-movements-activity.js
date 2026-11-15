// Activity entries for every movement of assets in the wallet: mint, world pick-up and drop (including an item issued by
// another domain than the hosting world), split and consolidation (which never count as received), conversion, purchase,
// a trade claimed at a station and the seller's sale, moves between the identities of one wallet, and the unit an entry
// uses. The figures in each entry are checked against what the wallet really holds, retries and failed operations are
// checked to add nothing, and the card is read in the real viewer.
//
// Disposable Chromium profiles with the real extension; throw-away Node or PHP issuers (own keys, state, revocation lists).
// S is the first issuer (and the world host or station where one is needed), X a second issuer. Nothing live is touched.
//
//   xvfb-run -a node test/manual-asset-movements-activity.js [node|php|both] [--only=M2]
'use strict';
const U = require('./manual-gen1-unique-recovery');
const { check, scenario, mint, live, sum, trustPeers } = U;
const { GOLD, IRON, MEMBER } = U.constants;
const RING = 'atlas.wearable.ring';
const CREDIT = 'atlas.credit.balance';
const SANDWICH = 'atlas.demo.cafeteria.sandwich';
const TROPHY = 'atlas.trophy.chess';
const which = U.which;

const entries = (w) => w.W(() => AtlasWallet.getActivityLog());
const ofKind = (log, kind) => log.filter((e) => e.meta && e.meta.kind === kind);
const heldIds = (w, cls) => U.shown(w, cls).then((rows) => rows.filter((r) => r.held === null && r.valid));
const credentialsOf = (w, cls) => w.W(async (a) => (await AtlasWallet.getWallet(a.k)).map((e) => e.credential).filter((c) => c.asset.class === a.c), { k: w.pub, c: cls });

async function openViewer(w) {
  const id = new URL(w.sw.url()).host;
  const page = await w.context.newPage();
  await page.goto('chrome-extension://' + id + '/viewer.html');
  await page.waitForFunction(() => typeof AtlasWallet !== 'undefined' && typeof movementDetailsHtml === 'function', null, { timeout: 20000 });
  return page;
}
// The text of the Activity card whose first line starts with `prefix`, with its details and technical section.
const cardOf = (page, prefix) => page.evaluate(async (p) => {
  await refreshActivityLogDisplay();
  const card = Array.from(document.querySelectorAll('#activityLogList .info-card')).find((c) => c.querySelector('.name').textContent.startsWith(p));
  if (!card) return null;
  const tech = card.querySelector('details.activity-tech');
  // A space after every label and every line, as the eye reads them.
  const spaced = card.cloneNode(true);
  spaced.querySelectorAll('.k, li, .activity-leg, .name').forEach((el) => el.append(' '));
  const plain = spaced.cloneNode(true);
  plain.querySelectorAll('details').forEach((d) => d.remove());
  return {
    outside: plain.textContent.replace(/\s+/g, ' '), text: spaced.textContent.replace(/\s+/g, ' '), link: card.classList.contains('activity-link'),
    techPresent: !!tech, techOpen: !!(tech && tech.open), techText: tech ? Array.from(tech.querySelectorAll('li')).map((l) => l.textContent.replace(/^([^:]*:)/, '$1 ')).join(' ') : ''
  };
}, prefix);

async function scenarios(kind) {
  await scenario(kind, 'M1 minting records the exact balances measured around the mint', async (w, S) => {
    check('first gold mint ok', (await mint(w, S, GOLD, 6)) === 'ok');
    check('second gold mint ok', (await mint(w, S, GOLD, 1)) === 'ok');
    const log = await entries(w);
    const mints = ofKind(log, 'mint');
    const second = mints[0], first = mints[1];
    check('two mint entries, newest first, with the quantity actually issued', mints.length === 2 && second.meta.legs[0].quantity === 1 && first.meta.legs[0].quantity === 6, mints.map((m) => m.text));
    check('the entry reads "Minted 1 g Gold (Au)"', second.text === 'Minted 1 g Gold (Au)', second.text);
    check('previous balance 6 g, change +1 g, new balance 7 g, from the wallet itself', second.meta.legs[0].previousBalance === 6 && second.meta.legs[0].newBalance === 7 && first.meta.legs[0].previousBalance === 0 && first.meta.legs[0].newBalance === 6, [first.meta.legs[0], second.meta.legs[0]]);
    const rows = await heldIds(w, GOLD);
    check('the wallet merged them into one 7 g balance, which was not logged as anything received', rows.length === 1 && rows[0].q === 7 && !log.some((e) => /^Received|^Consolidated/.test(e.text)), { rows, texts: log.map((e) => e.text) });
    check('the entry names the issuer, the identity, the request and the credential', second.meta.legs[0].domain === S.domain && second.meta.identity.label === 'Main identity' && !!second.meta.requestId && !!second.meta.legs[0].assetId, second.meta);
    const text = JSON.stringify(log);
    check('no key material is written into Activity', !/privateKey|"d":|privateKeyJwk|seed/i.test(text), null);

    const ring = await mint(w, S, RING);
    const unique = ofKind(await entries(w), 'mint')[0];
    check('a unique mint is recorded as the item, with no unit and no balances', ring === 'ok' && unique.meta.legs[0].fungible === false && unique.meta.legs[0].unit === null && unique.meta.legs[0].previousBalance === undefined && !/\bg\b/.test(unique.text), unique);

    const page = await openViewer(w);
    const card = await cardOf(page, 'Minted 1 g Gold');
    check('the card shows Issuer, Identity, Previous balance 6 g, Change +1 g and New balance 7 g', !!card && card.text.includes('Issuer: ' + S.domain) && card.text.includes('Identity: Main identity') && /Previous balance: 6 g/.test(card.text) && /Change: \+1 g/.test(card.text) && /New balance: 7 g/.test(card.text), card && card.text);
    check('technical identifiers sit in a collapsed Details section', !!card && card.techPresent && !card.techOpen && /Request ID/.test(card.techText) && /Received credential/.test(card.techText) && !/Request ID|credential:/.test(card.outside), card && card.techText);
    check('Show in inventory is kept for an item that is still held', !!card && card.link, card);
    await page.close();
  }, { workers: 4 });

  await scenario(kind, 'M2 a world drop and pick-up of an item issued by another domain', async (w, S, ctx) => {
    const X = await ctx.issuer(kind, { workers: 4 });
    trustPeers(S, [X.domain]); trustPeers(X, [S.domain]);
    check('gold issued by X', (await mint(w, X, GOLD, 20)) === 'ok');
    const before = (await heldIds(w, GOLD))[0];
    const piece = await w.W(async (a) => {
      const c = (await AtlasWallet.getWallet(a.k)).map((e) => e.credential).find((x) => x.asset.class === a.c);
      return AtlasWallet.splitForDrop(c, 3);
    }, { k: w.pub, c: GOLD });
    check('3 g carved off for the drop, still held (nothing logged yet)', piece.quantity === 3 && !(await entries(w)).some((e) => e.meta && e.meta.kind === 'drop'));

    // A drop that fails is not recorded and keeps the item.
    const failed = await w.W((a) => AtlasWallet.dropItem(a.c, '127.0.0.1:9', 'market', [1, 0, 1]).then(() => 'dropped', (e) => 'failed'), { c: piece });
    check('a drop that cannot reach its world fails and records nothing', failed === 'failed' && ofKind(await entries(w), 'drop').length === 0 && sum(await heldIds(w, GOLD)) === 20, failed);

    await w.W((a) => AtlasWallet.dropItem(a.c, a.d, 'market', [1, 0, 1]), { c: piece, d: S.domain });
    const drop = ofKind(await entries(w), 'drop');
    check('one drop entry: "Dropped 3 g Gold (Au)"', drop.length === 1 && drop[0].text === 'Dropped 3 g Gold (Au)', drop.map((d) => d.text));
    const dl = drop[0] && drop[0].meta.legs[0];
    check('issuer X and world S/market are recorded separately; previous 20 g, change -3 g, new 17 g', !!dl && dl.domain === X.domain && drop[0].meta.world.domain === S.domain && drop[0].meta.world.id === 'market' && dl.previousBalance === 20 && dl.newBalance === 17 && dl.direction === 'out', drop[0] && drop[0].meta);
    check('the wallet holds 17 g', sum(await heldIds(w, GOLD)) === 17);

    const drops = await w.W((a) => AtlasWallet.getWorldDrops(a.d, 'market'), { d: S.domain });
    const picked = await w.W((a) => AtlasWallet.pickUpItem(a.d, a.id, 'market').then((c) => ({ ok: true, q: c.quantity }), (e) => ({ error: e.message })), { d: S.domain, id: drops[0].dropId });
    check('the pick-up (relayed to X) returns 3 g', picked.ok === true && picked.q === 3, picked);
    const pickups = ofKind(await entries(w), 'pickup');
    const pl = pickups[0] && pickups[0].meta.legs[0];
    check('one pick-up entry: "Picked up 3 g Gold (Au)", previous 17 g, change +3 g, new 20 g', pickups.length === 1 && pickups[0].text === 'Picked up 3 g Gold (Au)' && pl.previousBalance === 17 && pl.newBalance === 20 && pl.direction === 'in', pickups.map((p) => p.meta));
    check('hosting world S/market and issuer X are recorded separately', pickups[0].meta.world.domain === S.domain && pickups[0].meta.world.id === 'market' && pl.domain === X.domain, pickups[0].meta);
    const rows = await heldIds(w, GOLD);
    check('merging 17 g and 3 g was housekeeping: one 20 g balance and no entry for it', rows.length === 1 && rows[0].q === 20 && !(await entries(w)).some((e) => /^Received|^Consolidated/.test(e.text)), rows);

    const again = await w.W((a) => AtlasWallet.pickUpItem(a.d, a.id, 'market').then((c) => ({ ok: true, id: c.id }), (e) => ({ refused: e.message })), { d: S.domain, id: drops[0].dropId });
    check('picking the same drop up again adds no second entry and no second balance', ofKind(await entries(w), 'pickup').length === 1 && sum(await heldIds(w, GOLD)) === 20, { again, rows: await heldIds(w, GOLD) });

    // A whole unique item dropped and recovered.
    check('a trophy', (await mint(w, S, TROPHY)) === 'ok');
    const trophy = (await credentialsOf(w, TROPHY))[0];
    await w.W((a) => AtlasWallet.dropItem(a.c, a.d, 'market', [0, 0, 0]), { c: trophy, d: S.domain });
    const tdrop = ofKind(await entries(w), 'drop')[0];
    check('a unique item drop records the item and no balances or mass units', tdrop.meta.legs[0].fungible === false && tdrop.meta.legs[0].previousBalance === undefined && !/\bg\b/.test(tdrop.text), tdrop);

    // The entries survive the asset being spent (dropped) and merged.
    const page = await openViewer(w);
    const card = await cardOf(page, 'Dropped 3 g Gold');
    check('the drop card shows Issuer, World, Identity, Previous 20 g, Change −3 g, New 17 g', !!card && card.text.includes('Issuer: ' + X.domain) && card.text.includes('World: ' + S.domain + '/market') && card.text.includes('Identity: Main identity') && /Previous balance: 20 g/.test(card.text) && /Change: −3 g/.test(card.text) && /New balance: 17 g/.test(card.text), card && card.text);
    const mintCard = await cardOf(page, 'Minted 20 g Gold');
    check('the original mint card is still readable after those 20 g were split, dropped and merged', !!mintCard && /New balance: 20 g/.test(mintCard.text), mintCard && mintCard.text);
    const dropLink = await cardOf(page, 'Dropped 3 g Gold');
    check('a card for something that left the wallet offers no jump to the inventory', !!dropLink && dropLink.link === false, dropLink);
    void before;
    await page.close();
  }, { workers: 4 });

  await scenario(kind, 'M3 split and consolidation change no total; convert and purchase record both sides', async (w, S) => {
    check('30 gold', (await mint(w, S, GOLD, 30)) === 'ok');
    const gold = (await credentialsOf(w, GOLD))[0];
    const out = await w.W((a) => AtlasWallet.splitAsset('self', a.c, 10, 'self').then(() => 'ok', (e) => String(e.message)), { c: gold });
    let log = await entries(w);
    const split = ofKind(log, 'split')[0];
    check('a split inside the wallet is recorded with the total unchanged (30 g before and after)', out === 'ok' && !!split && split.text === 'Split 10 g Gold (Au) within your own wallet' && split.meta.legs[0].direction === 'same' && split.meta.legs[0].previousBalance === 30 && split.meta.legs[0].newBalance === 30 && split.meta.split.sent === 10 && split.meta.split.remainder === 20, split);
    check('the split is not income: no Received entry, wallet total still 30 g', !log.some((e) => /^Received/.test(e.text)) && sum(await heldIds(w, GOLD)) === 30);

    // Two separate balances, merged by the person.
    const g2 = (await credentialsOf(w, GOLD))[0];
    const piece = await w.W((a) => AtlasWallet.splitForDrop(a.c, 5), { c: g2 });
    const pair = await credentialsOf(w, GOLD);
    check('two balances are held (25 g and 5 g)', pair.length === 2 && sum(pair.map((c) => ({ q: c.quantity }))) === 30, pair.map((c) => c.quantity));
    const merged = await w.W((a) => AtlasWallet.consolidateAsset('self', a.cs).then((c) => ({ q: c.quantity }), (e) => ({ error: e.message })), { cs: pair });
    log = await entries(w);
    const cons = ofKind(log, 'consolidate');
    check('consolidation: one entry, 30 g before and after, nothing received', merged.q === 30 && cons.length === 1 && cons[0].meta.legs[0].previousBalance === 30 && cons[0].meta.legs[0].newBalance === 30 && cons[0].meta.consolidated.from === 2 && cons[0].text === 'Consolidated 2 balances of Gold (Au) into one' && !log.some((e) => /^Received/.test(e.text)), cons);
    void piece;

    // Convert iron into gold at the issuer's own rate.
    check('40 iron', (await mint(w, S, IRON, 40)) === 'ok');
    const iron = (await credentialsOf(w, IRON))[0];
    const conv = await w.W((a) => AtlasWallet.convertAsset('self', a.c, 40, a.to).then((r) => ({ q: r.received.quantity }), (e) => ({ error: String(e.message) })), { c: iron, to: GOLD });
    const cv = ofKind(await entries(w), 'convert')[0];
    check('a conversion records both sides: gave 40 g Iron, received the gold at the issuer\'s rate', conv.q >= 1 && !!cv && cv.meta.legs.length === 2 && cv.meta.legs[0].direction === 'out' && cv.meta.legs[0].quantity === 40 && cv.meta.legs[0].previousBalance === 40 && cv.meta.legs[0].newBalance === 0 && cv.meta.legs[1].direction === 'in' && cv.meta.legs[1].quantity === conv.q && cv.meta.legs[1].previousBalance === 30 && cv.meta.legs[1].newBalance === 30 + conv.q, { conv, cv });
    check('the wallet agrees: 30 + received gold, no iron', sum(await heldIds(w, GOLD)) === 30 + conv.q && sum(await heldIds(w, IRON)) === 0);

    // Spending Balance is a fungible class that is not measured in grams.
    check('20 spending balance', (await mint(w, S, CREDIT, 20)) === 'ok');
    const mintedCredit = ofKind(await entries(w), 'mint')[0];
    check('its unit is not grams: no "g" in the entry', mintedCredit.meta.legs[0].unit === null && mintedCredit.text === 'Minted 20 Spending Balance', mintedCredit.text);
    const bought = await w.W((a) => AtlasWallet.purchaseAsset('self', a.d, a.c, 1).then(() => 'ok', (e) => String(e.message)), { d: S.domain, c: SANDWICH });
    const pur = ofKind(await entries(w), 'purchase')[0];
    check('a purchase records what was paid and what was received', bought === 'ok' && !!pur && pur.meta.legs[0].direction === 'out' && pur.meta.legs[0].quantity === 5 && pur.meta.legs[0].previousBalance === 20 && pur.meta.legs[0].newBalance === 15 && pur.meta.legs[1].direction === 'in' && pur.meta.legs[1].assetClass === SANDWICH && pur.meta.legs[1].fungible === false, pur);
    check('the paid side reads "5 Spending Balance", not grams', !!pur && /^Purchased .* for 5 Spending Balance$/.test(pur.text), pur && pur.text);

    const page = await openViewer(w);
    const cvCard = await cardOf(page, 'Converted');
    check('the conversion card lists both sides with their own balances', !!cvCard && /Gave 40 g/.test(cvCard.text) && /Received /.test(cvCard.text) && /Previous balance: 40 g/.test(cvCard.text) && /Previous balance: 30 g/.test(cvCard.text), cvCard && cvCard.text);
    const purCard = await cardOf(page, 'Purchased');
    check('the purchase card shows the unit-less balance as a plain count', !!purCard && /Previous balance: 20(?! g)/.test(purCard.text) && /New balance: 15(?! g)/.test(purCard.text), purCard && purCard.text);
    const consCard = await cardOf(page, 'Consolidated');
    check('the consolidation card says the total is unchanged', !!consCard && /the total is unchanged/.test(consCard.text) && /Change: no change/.test(consCard.text), consCard && consCard.text);
    await page.close();
  }, { workers: 4 });

  await scenario(kind, 'M4 moves between identities of one wallet; each identity has its own log', async (w, S) => {
    check('20 gold and a ring', (await mint(w, S, GOLD, 20)) === 'ok' && (await mint(w, S, RING)) === 'ok');
    const sub = await w.W(() => AtlasWallet.createSubIdentity('Travel'));
    const gold = (await credentialsOf(w, GOLD))[0];
    const moved = await w.W((a) => AtlasWallet.moveBalanceToIdentity(a.id, a.to, 5).then((r) => ({ moved: r.moved }), (e) => ({ error: e.message })), { id: gold.id, to: sub.publicKey });
    const mv = ofKind(await entries(w), 'move')[0];
    check('moving 5 g records the outgoing quantity and the sender\'s balances (20 g to 15 g)', moved.moved === 5 && !!mv && mv.meta.legs[0].direction === 'out' && mv.meta.legs[0].quantity === 5 && mv.meta.legs[0].previousBalance === 20 && mv.meta.legs[0].newBalance === 15, { moved, mv });
    check('it names the receiving identity and what it received', mv.meta.to.label === 'Travel' && mv.meta.to.quantity === 5 && mv.meta.identity.label === 'Main identity' && /Travel/.test(mv.text), mv.meta);
    const ring = (await credentialsOf(w, RING))[0];
    const movedRing = await w.W((a) => AtlasWallet.moveAssetToIdentity(a.id, a.to).then(() => 'ok', (e) => String(e.message)), { id: ring.id, to: sub.publicKey });
    const mr = ofKind(await entries(w), 'move')[0];
    check('moving a unique item records the item with no balances', movedRing === 'ok' && mr.meta.legs[0].fungible === false && mr.meta.legs[0].previousBalance === undefined && mr.meta.to.label === 'Travel', mr);
    const mainLog = await entries(w);
    check('the main identity\'s log holds its own mints and moves', ofKind(mainLog, 'mint').length === 2 && ofKind(mainLog, 'move').length === 2, mainLog.map((e) => e.text));

    await w.W((id) => AtlasWallet.switchIdentity(id), sub.id);
    const subLog = await entries(w);
    check('the Travel identity has its own log, with none of the main identity\'s entries', !subLog.some((e) => e.meta && (e.meta.kind === 'mint' || e.meta.kind === 'move')), subLog.map((e) => e.text));
    const subHeld = await w.W(async (k) => (await AtlasWallet.getWallet(k)).map((e) => e.credential.asset.class + ':' + e.credential.quantity), sub.publicKey);
    check('and it holds the 5 g and the ring that moved to it', subHeld.includes(GOLD + ':5') && subHeld.includes(RING + ':1'), subHeld);
    await w.W(() => AtlasWallet.switchIdentity(null));
  }, { workers: 4 });

  await scenario(kind, 'M5 a trade at a station: the buyer\'s entry and the seller\'s sale, once each', async (w, S, ctx) => {
    const X = await ctx.issuer(kind, { workers: 4 });
    trustPeers(S, [X.domain]); trustPeers(X, [S.domain]);
    const b = await ctx.fresh('buyer'); await b.create();
    for (const wallet of [w, b]) check('membership', (await mint(wallet, S, MEMBER)) === 'ok');
    check('seller has a ring from X and 4 gold', (await mint(w, X, RING)) === 'ok' && (await mint(w, S, GOLD, 4)) === 'ok');
    check('buyer has 10 gold', (await mint(b, S, GOLD, 10)) === 'ok');
    const posted = await w.W(async (a) => {
      const held = (await AtlasWallet.getWallet(a.k)).map((e) => e.credential);
      const membership = held.find((c) => c.asset.class === a.m && c.issuer.domain === a.s);
      const balance = held.find((c) => c.asset.class === a.oc);
      return AtlasWallet.submitTradeIntent(a.s, membership, { class: a.oc, quantity: 1 }, { class: a.wc, quantity: 5 }, balance, 60);
    }, { k: w.pub, m: MEMBER, s: S.domain, oc: RING, wc: GOLD });
    check('listed', posted.status === 'pending', posted);
    const out = await b.W(async (a) => {
      const held = (await AtlasWallet.getWallet(a.k)).map((e) => e.credential);
      const membership = held.find((c) => c.asset.class === a.m && c.issuer.domain === a.s);
      const balance = held.find((c) => c.asset.class === a.g);
      const listings = await AtlasWallet.fetchTradeListings(a.s);
      try { await AtlasWallet.claimTradeListing(a.s, membership, listings[0], balance); return 'ok'; } catch (e) { return String(e.message); }
    }, { k: b.pub, m: MEMBER, s: S.domain, g: GOLD });
    check('the buyer claims it', out === 'ok', out);
    const bl = ofKind(await entries(b), 'trade');
    check('the buyer\'s entry: gave 5 g Gold (10 g to 5 g), received the ring (issued by X)', bl.length === 1 && bl[0].meta.legs[0].direction === 'out' && bl[0].meta.legs[0].quantity === 5 && bl[0].meta.legs[0].previousBalance === 10 && bl[0].meta.legs[0].newBalance === 5 && bl[0].meta.legs[1].assetClass === RING && bl[0].meta.legs[1].domain === X.domain && bl[0].meta.legs[1].fungible === false && bl[0].meta.station === S.domain, bl);
    check('the buyer holds the ring and 5 g, nothing extra logged', (await heldIds(b, RING)).length === 1 && sum(await heldIds(b, GOLD)) === 5 && (await entries(b)).filter((e) => e.type === 'trade').length === 1, (await entries(b)).map((e) => e.text));

    await w.W(() => AtlasWallet.checkAllMail());
    await w.W(() => AtlasWallet.checkAllMail());
    const sold = ofKind(await entries(w), 'sold');
    check('after settlement the seller has exactly one "Sold" entry, even after checking mail twice', sold.length === 1 && /^Sold /.test(sold[0].text) && sold[0].meta.legs[0].direction === 'out' && sold[0].meta.legs[0].assetClass === RING && sold[0].meta.legs[0].domain === X.domain && sold[0].meta.station === S.domain, sold.map((e) => e.text));
    const mail = (await w.W((k) => AtlasWallet.getMail(k), w.pub)).find((e) => e.message.subject === 'Listing claimed at ' + S.domain);
    await w.W((a) => AtlasWallet.claimMailGift(a.k, a.id), { k: w.pub, id: mail.message.id });
    const claims = ofKind(await entries(w), 'mail-claim');
    check('the payment claimed from Mail is still recorded as before (4 g to 9 g)', claims.length === 1 && claims[0].meta.previousBalance === 4 && claims[0].meta.newBalance === 9 && claims[0].meta.source === 'Trading Station payment', claims);
    const page = await openViewer(w);
    const card = await cardOf(page, 'Received 5 g Gold');
    check('and its card still shows Issuer, Source, Previous balance 4 g, Change +5 g, New balance 9 g', !!card && /Source: Trading Station payment/.test(card.text) && /Previous balance: 4 g/.test(card.text) && /Change: \+5 g/.test(card.text) && /New balance: 9 g/.test(card.text), card && card.text);
    await page.close();
  }, { workers: 4 });

  await scenario(kind, 'M6 older entries stay readable and nothing is invented for them', async (w) => {
    const page = await openViewer(w);
    const out = await page.evaluate(() => ({
      legacyMail: movementDetailsHtml({ kind: 'mail-claim', messageId: 'm1', assetClass: 'atlas.element.gold', domain: 'old.example', assetName: 'Gold (Au)', symbol: 'Au', fungible: true, quantity: 3, source: 'Gift from old.example', previousBalance: 1, newBalance: 4 }),
      legacyText: movementDetailsHtml({}),
      noBalances: movementDetailsHtml({ kind: 'mint', movement: true, legs: [{ direction: 'in', assetClass: 'c', assetName: 'Thing', domain: 'a.example', fungible: true, unit: null, quantity: 3 }] }),
      units: [formatActivityQuantity(5, null), formatActivityQuantity(5, 'pts'), formatActivityQuantity(1500, null), formatActivityQuantity(4993, 'g'), formatSignedQuantity(-3, 'g'), formatSignedQuantity(0, 'g')]
    }));
    const text = (h) => h.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    check('an older Mail claim entry still shows its recorded figures, in grams', /Previous balance: 1 g/.test(text(out.legacyMail)) && /Change: \+3 g/.test(text(out.legacyMail)) && /New balance: 4 g/.test(text(out.legacyMail)), text(out.legacyMail));
    check('an entry with no recorded detail shows no detail', out.legacyText === '', out.legacyText);
    check('a side whose balances were not measured shows none, rather than invented numbers', !/Previous balance|New balance|Change/.test(text(out.noBalances)) && /Issuer: a.example/.test(text(out.noBalances)), text(out.noBalances));
    check('units follow the entry: plain count, own unit, exact grams, signed change', JSON.stringify(out.units) === JSON.stringify(['5', '5 pts', '1,500', '4,993 g (4.993 kg)', '−3 g', 'no change']), out.units);
    await page.close();
  });
}

async function main() {
  const kinds = which === 'both' ? ['node', 'php'] : [which];
  for (const kind of kinds) await scenarios(kind);
  const { passes, failures } = U.counts();
  console.log(`\nasset movement activity: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
