// Asset Viewer previews on Trading Station cards (Buy and Listings): hovering, focusing or tapping a card side opens the
// floating Asset Viewer beside it. A unique item is shown as the exact listed item only when a trustworthy listing
// snapshot exists, otherwise as a labelled class preview; a fungible side is always a class preview. Models load only on
// request. The panel stays open while the pointer moves onto it, and the card's own buttons, scrolling and trading are
// untouched. The public listing carries only the item's public description, never ids, signatures or keys.
//
// Disposable Chromium profiles with the real extension; throw-away Node or PHP issuers. Nothing live is read or written.
//
//   xvfb-run -a node test/manual-trade-card-preview.js [node|php|both] [--only=P1]
'use strict';
const U = require('./manual-gen1-unique-recovery');
const { check, scenario, mint, live, sum } = U;
const { GOLD, IRON, MEMBER } = U.constants;
const RING = 'atlas.wearable.ring';

const records = (w) => w.W((k) => AtlasWallet.getSubmittedTrades(k), w.pub);
const refresh = (w) => w.W((k) => AtlasWallet.refreshSubmittedTrades(k), w.pub);
const checkMail = (w) => w.W(() => AtlasWallet.checkAllMail());

const post = (w, S, offerClass, offerQty, wantClass, wantQty) => w.W(async (a) => {
  const held = (await AtlasWallet.getWallet(a.k)).map((e) => e.credential);
  const membership = held.find((c) => c.asset.class === a.m && c.issuer.domain === a.s);
  const balance = held.find((c) => c.asset.class === a.oc && c.quantity >= a.oq);
  try { return await AtlasWallet.submitTradeIntent(a.s, membership, { class: a.oc, quantity: a.oq }, { class: a.wc, quantity: a.wq }, balance, 60); }
  catch (e) { return { error: String(e.message).slice(0, 200) }; }
}, { k: w.pub, m: MEMBER, s: S.domain, oc: offerClass, oq: offerQty, wc: wantClass, wq: wantQty });

const heldRing = (w) => w.W(async (k) => {
  const e = (await AtlasWallet.getWallet(k)).find((x) => x.credential.asset.class === 'atlas.wearable.ring');
  return e ? { id: e.credential.id, owner: e.credential.owner.publicKey, properties: e.credential.asset.properties } : null;
}, w.pub);

async function openViewer(w, subtab) {
  const id = new URL(w.sw.url()).host;
  const page = await w.context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('chrome-extension://' + id + '/viewer.html');
  await page.waitForFunction(() => typeof AtlasWallet !== 'undefined' && typeof refreshTradingBuyList === 'function', null, { timeout: 20000 });
  // Show the Trading Station screen and the wanted sub-tab.
  await page.evaluate(() => {
    document.querySelectorAll('.wallet-screen').forEach((s) => s.classList.remove('active'));
    document.getElementById('tradeScreen').classList.add('active');
    const panel = document.getElementById('walletPanel');
    if (panel) panel.classList.add('open');
  });
  await page.evaluate((t) => document.getElementById(t).click(), subtab === 'list' ? 'tradingListingsSubtabBtn' : 'tradingBuySubtabBtn');
  return page;
}

async function showBuy(page, S) {
  await page.evaluate(async (d) => {
    await refreshRemoteTradeStationOptions();
    const sel = document.getElementById('remoteTradeStationDomainSelect');
    sel.value = d;
    await refreshTradingBuyList();
  }, S.domain);
}

const viewer = (page) => page.evaluate(() => {
  const w = document.getElementById('assetViewerWidget');
  const body = document.getElementById('assetViewerBody');
  const kind = body.querySelector('.asset-viewer-kind');
  return {
    open: !w.hidden,
    text: w.hidden ? '' : body.innerText.replace(/\s+/g, ' '),
    kind: kind ? kind.dataset.kind : null,
    hasImg: !!body.querySelector('img.asset-viewer-thumbnail'),
    modelBtn: !!document.getElementById('assetViewerShowModelBtn'),
    canvas: !!body.querySelector('canvas'),
    rect: w.hidden ? null : JSON.parse(JSON.stringify(w.getBoundingClientRect()))
  };
});
async function hoverSide(page, sel) {
  await page.locator(sel).scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);
  await page.hover(sel);
}
const cardSide = (id, which) => '.trade-card[data-pending-id="' + id + '"] .trade-side:' + (which === 'first' ? 'first-of-type' : 'last-of-type');
const waitViewer = (page, open, ms) => page.waitForFunction((o) => !document.getElementById('assetViewerWidget').hidden === o, open, { timeout: ms || 3000 }).then(() => true, () => false);
const waitText = (page, re, ms) => page.waitForFunction((s) => /./.test(document.getElementById('assetViewerBody').innerText) && new RegExp(s).test(document.getElementById('assetViewerBody').innerText), re, { timeout: ms || 5000 }).then(() => true, () => false);

async function scenarios(kind) {
  await scenario(kind, 'P1 Buy tab: exact listed ring, class previews for gold, hover bridge, model on request, trading still works', async (w, S, ctx) => {
    const b = await ctx.fresh('buyer'); await b.create();
    for (const who of [w, b]) { const r = await mint(who, S, MEMBER); if (r !== 'ok') throw new Error('membership: ' + JSON.stringify(r)); }
    for (const [who, cls, q] of [[w, RING], [w, GOLD, 10], [b, IRON, 6]]) { const r = await mint(who, S, cls, q); if (r !== 'ok') throw new Error('mint ' + cls + ': ' + JSON.stringify(r)); }
    const ring = await heldRing(w);
    const ringListing = (await post(w, S, RING, 1, GOLD, 5)).pendingId;
    const goldListing = (await post(w, S, GOLD, 3, IRON, 2)).pendingId;
    const wantRingListing = (await post(w, S, GOLD, 2, RING, 1)).pendingId;
    check('three listings are posted: a ring, 3 gold, and 2 gold that wants a ring', !!ringListing && !!goldListing && !!wantRingListing, { ringListing, goldListing, wantRingListing });

    // The public listing: the ring's public description only.
    const listed = await (await fetch('http://' + S.domain + '/atlas/trade/listings')).json();
    const lr = listed.listings.find((l) => l.pendingId === ringListing);
    const lg = listed.listings.find((l) => l.pendingId === goldListing);
    check('the ring listing carries offerAsset: name, class, issuer, image, model and its own properties', !!lr.offerAsset && lr.offerAsset.class === RING && lr.offerAsset.name === "Merchant's Signet Ring" && lr.offerAsset.fungible === false && lr.offerAsset.issuerDomain === S.domain && /^https?:/.test(lr.offerAsset.thumbnail) && /^https?:/.test(lr.offerAsset.model) && lr.offerAsset.properties['atlas.serial'] === ring.properties['atlas.serial'], lr.offerAsset);
    check('the snapshot has no credential id, signature or owner key', !JSON.stringify(lr.offerAsset).includes(ring.id) && !JSON.stringify(lr.offerAsset).includes(ring.owner.slice(0, 20)) && !/signature|proof/i.test(JSON.stringify(lr.offerAsset)), Object.keys(lr.offerAsset));
    check('a fungible listing has no snapshot', lg && lg.offerAsset === undefined, lg);

    const page = await openViewer(b, 'buy');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await page.route(/\.png(\?|$)/, (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
    const models = [];
    page.on('request', (r) => { if (/\.glb(\?|$)/.test(r.url())) models.push(r.url()); });
    await showBuy(page, S);
    await page.waitForSelector('#tradingBuyList .trade-card[data-pending-id="' + ringListing + '"]');
    check('every side of an open trade is a keyboard-focusable preview target', await page.evaluate(() => Array.from(document.querySelectorAll('#tradingBuyList .trade-side')).every((s) => s.tabIndex === 0 && s.dataset.preview && s.getAttribute('role') === 'button')));

    // Hovering the unique ring that will be received.
    await hoverSide(page, cardSide(ringListing, 'last'));
    check('hovering the ring opens the viewer', await waitViewer(page, true));
    await waitText(page, 'atlas.serial');
    let v = await viewer(page);
    check('it is labelled as the exact listed item', v.kind === 'exact' && /exact listed item/i.test(v.text), v.text);
    check('it shows name, class and issuer', v.text.includes("Merchant's Signet Ring") && v.text.includes(RING) && v.text.includes('issued by ' + S.domain), v.text);
    check('it shows the listed ring\'s own properties (serial)', v.text.includes('atlas.serial: ' + ring.properties['atlas.serial']), v.text);
    check('it shows no wallet fields (id, owner key, model URL)', !v.text.includes(ring.id) && !/owner\.publicKey|issuer\.publicKey|\bid:/.test(v.text), v.text);
    check('there is a Show model button and no model was fetched yet', v.modelBtn && !v.canvas && models.length === 0, { v, models });
    await pollUntil(async () => (await viewer(page)).hasImg);
    check('the image loaded', (await viewer(page)).hasImg);

    // Moving onto the viewer keeps it open (sticky bridge).
    const box = (await viewer(page)).rect;
    await page.mouse.move(box.left + box.width / 2, box.top + box.height / 2, { steps: 6 });
    await page.waitForTimeout(500);
    check('the viewer stays open while the pointer is on it', (await viewer(page)).open);
    // Show model: lazy, fetched only now; the test issuer has no ring.glb file, so this also covers an unavailable model.
    await page.click('#assetViewerShowModelBtn');
    await waitText(page, 'model');
    check('Show model fetches the model on request', models.length === 1 && /ring\.glb/.test(models[0]), models);
    check('an unavailable or unrenderable model is reported, not thrown', /Could not (load|render) this model|Loading model/.test((await viewer(page)).text) || (await viewer(page)).canvas, (await viewer(page)).text);
    await page.mouse.move(5, 5, { steps: 4 });
    check('leaving the panel closes it after the grace period', await waitViewer(page, false, 2500));

    // The fungible side: class information, never "exact".
    await hoverSide(page, cardSide(ringListing, 'first'));
    check('hovering the 5 g of gold to give opens a class preview', await waitViewer(page, true));
    await waitText(page, 'Class properties');
    v = await viewer(page);
    check('it is identified as class information and not as an exact item', v.kind === 'class' && /class preview/i.test(v.text) && !/exact listed item/i.test(v.text) && /class information from/i.test(v.text), v.text);
    check('it shows the amount from the listing, the class, the station as issuer and the class properties', v.text.includes('5 g') && v.text.includes(GOLD) && v.text.includes('issued by ' + S.domain) && v.text.includes('atlas.symbol: Au'), v.text);
    check('its model is offered once the class description arrives', v.modelBtn, v);

    // Moving straight from one side to another switches without a gap or a stale body.
    await hoverSide(page, cardSide(goldListing, 'last'));
    await waitText(page, '3 g');
    v = await viewer(page);
    check('moving to another card\'s side switches the content (3 g of gold, class preview)', v.open && v.kind === 'class' && v.text.includes('3 g') && v.text.includes(GOLD), v.text);

    // A unique class that someone asks for: no specific item.
    await hoverSide(page, cardSide(wantRingListing, 'first'));
    await waitText(page, 'Class defaults');
    v = await viewer(page);
    check('a wanted unique item is a class preview that says it is not one specific item', v.kind === 'class' && /not this exact item/i.test(v.text) && /not one specific item/.test(v.text) && !/exact listed item/i.test(v.text), v.text);
    check('its properties are labelled as class defaults', /Class defaults/.test(v.text), v.text);

    // The Trade button still works with a preview open, and the panel does not cover it.
    await hoverSide(page, cardSide(goldListing, 'last'));
    await waitViewer(page, true);
    const btn = '.trade-card[data-pending-id="' + goldListing + '"] .trading-claim-btn';
    await page.hover(btn);
    check('moving to the Trade button closes the preview', await waitViewer(page, false, 2500));
    await page.click(btn);
    const got = await U.waitFor(async () => sum(await live(b, GOLD)) === 3, 20000);
    check('clicking Trade settles the trade as before: 3 g of gold received, 2 g of iron paid', got && sum(await live(b, IRON)) === 4, { gold: sum(await live(b, GOLD)), iron: sum(await live(b, IRON)) });
    await page.close();
  }, { workers: 4 });

  await scenario(kind, 'P2 Buy tab: a listing without a snapshot is a class preview; missing image; keyboard, touch, scroll and refresh', async (w, S, ctx) => {
    const b = await ctx.fresh('buyer'); await b.create();
    for (const who of [w, b]) { const r = await mint(who, S, MEMBER); if (r !== 'ok') throw new Error('membership: ' + JSON.stringify(r)); }
    for (const [who, cls, q] of [[w, RING], [w, GOLD, 10]]) { const r = await mint(who, S, cls, q); if (r !== 'ok') throw new Error('mint ' + cls + ': ' + JSON.stringify(r)); }
    const ringListing = (await post(w, S, RING, 1, GOLD, 5)).pendingId;
    const goldListing = (await post(w, S, GOLD, 3, IRON, 2)).pendingId;

    const page = await openViewer(b, 'buy');
    // The station (an older one, or one that withholds it) sends no snapshot, and the image cannot be fetched.
    await page.route('**/atlas/trade/listings', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.listings.forEach((l) => { delete l.offerAsset; });
      await route.fulfill({ response: res, json: body });
    });
    await page.route(/\.png(\?|$)/, (route) => route.abort());
    await showBuy(page, S);
    await page.waitForSelector('#tradingBuyList .trade-card[data-pending-id="' + ringListing + '"]');

    await hoverSide(page, cardSide(ringListing, 'last'));
    await waitViewer(page, true);
    await waitText(page, 'Class defaults');
    let v = await viewer(page);
    check('without a snapshot the ring is a class preview that says it is not this exact item', v.kind === 'class' && /not this exact item/i.test(v.text) && !/exact listed item/i.test(v.text), v.text);
    check('it does not present the class defaults as this item\'s own values (no "Exact", labelled defaults)', /Class defaults/.test(v.text) && /may differ/.test(v.text), v.text);
    check('an image that cannot be fetched leaves no broken image and does not stop the preview', v.open && !v.hasImg && v.text.includes("Merchant's Signet Ring"), v);
    await page.mouse.move(5, 5);
    await waitViewer(page, false, 2500);

    // A snapshot that names a different class than the listing is not trusted.
    await page.unroute('**/atlas/trade/listings');
    await page.route('**/atlas/trade/listings', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.listings.forEach((l) => { if (l.offerAsset) l.offerAsset.class = 'atlas.something.else'; });
      await route.fulfill({ response: res, json: body });
    });
    await showBuy(page, S);
    await hoverSide(page, cardSide(ringListing, 'last'));
    await waitViewer(page, true);
    v = await viewer(page);
    check('a snapshot that does not match the listed class is ignored (class preview)', v.kind === 'class' && !/exact listed item/i.test(v.text), v.text);
    await page.mouse.move(5, 5);
    await waitViewer(page, false, 2500);
    await page.unroute('**/atlas/trade/listings');
    await showBuy(page, S);

    // Keyboard: focus opens it, Enter pins it and moves to Show model, Escape returns to the side.
    const side = cardSide(ringListing, 'last');
    await page.focus(side);
    check('focusing a side opens its preview', await waitViewer(page, true));
    await waitText(page, 'Exact listed item');
    await page.keyboard.press('Enter');
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
    check('Enter pins the preview and moves focus to Show model', focused === 'assetViewerShowModelBtn', focused);
    await page.mouse.move(5, 5);
    await page.waitForTimeout(500);
    check('a pinned preview does not close when the pointer is elsewhere', (await viewer(page)).open);
    await page.keyboard.press('Escape');
    const back = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('trade-side'));
    check('Escape closes it and returns focus to the card side', !(await viewer(page)).open && back);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.focus(side);
    await waitViewer(page, true);
    await page.keyboard.press('Tab');
    check('tabbing to the next control closes a focus-opened preview', await waitViewer(page, false, 2500));

    // Touch: a tap pins, tapping again dismisses, tapping elsewhere dismisses; the mouse events of a tap are ignored.
    const tap = (sel) => page.evaluate((s) => {
      const el = document.querySelector(s);
      el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      el.click();
    }, sel);
    await tap(side);
    check('tapping a side opens its preview', await waitViewer(page, true));
    await page.mouse.move(5, 5);
    await page.waitForTimeout(500);
    check('a tapped preview stays open', (await viewer(page)).open);
    await tap(side);
    check('tapping the same side again closes it', await waitViewer(page, false, 1500));
    await tap(side);
    await waitViewer(page, true);
    await page.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true })));
    check('tapping elsewhere closes it', await waitViewer(page, false, 1500));

    // Scrolling closes a hover preview rather than leaving it floating over moved content; refresh does too.
    await hoverSide(page, side);
    await waitViewer(page, true);
    await page.evaluate(() => document.getElementById('tradingBuyList').parentElement.dispatchEvent(new Event('scroll')));
    check('scrolling closes the preview', await waitViewer(page, false, 1500));
    await hoverSide(page, cardSide(goldListing, 'last'));
    await waitViewer(page, true);
    await page.evaluate(() => refreshTradingBuyList());
    check('refreshing the list closes a preview whose card was replaced', await waitViewer(page, false, 2500));
    await page.close();
  }, { workers: 4 });

  await scenario(kind, 'P3 Listings tab: own open and settled listings, an older record without a snapshot', async (w, S, ctx) => {
    const b = await ctx.fresh('buyer'); await b.create();
    for (const who of [w, b]) { const r = await mint(who, S, MEMBER); if (r !== 'ok') throw new Error('membership: ' + JSON.stringify(r)); }
    for (const [who, cls, q] of [[w, RING], [w, GOLD, 10], [b, GOLD, 10]]) { const r = await mint(who, S, cls, q); if (r !== 'ok') throw new Error('mint ' + cls + ': ' + JSON.stringify(r)); }
    const ring = await heldRing(w);
    const ringListing = (await post(w, S, RING, 1, GOLD, 5)).pendingId;
    const goldListing = (await post(w, S, GOLD, 3, IRON, 2)).pendingId;
    const [rec] = (await records(w)).filter((r) => r.pendingId === ringListing);
    check('the wallet keeps a snapshot of the listed ring and none for gold', !!rec.offerSnapshot && rec.offerSnapshot.class === RING && rec.offerSnapshot.properties['atlas.serial'] === ring.properties['atlas.serial'] && !JSON.stringify(rec.offerSnapshot).includes(ring.id) && (await records(w)).find((r) => r.pendingId === goldListing).offerSnapshot === null, rec.offerSnapshot);

    const page = await openViewer(w, 'list');
    await page.evaluate(() => refreshTradingListingsList());
    await page.waitForSelector('#tradingListingsList .trade-card[data-pending-id="' + ringListing + '"]');
    await hoverSide(page, cardSide(ringListing, 'first'));
    await waitViewer(page, true);
    await waitText(page, 'atlas.serial');
    let v = await viewer(page);
    check('an open listing shows the exact ring still held, with its properties', v.kind === 'exact' && /exact listed item/i.test(v.text) && v.text.includes('atlas.serial: ' + ring.properties['atlas.serial']) && v.modelBtn, v.text);
    await hoverSide(page, cardSide(goldListing, 'first'));
    await waitText(page, 'Class properties');
    v = await viewer(page);
    check('an open gold listing is a class preview', v.kind === 'class' && v.text.includes('3 g') && !/exact listed item/i.test(v.text), v.text);
    await hoverSide(page, cardSide(goldListing, 'last'));
    await waitText(page, 'Iron');
    check('the asked-for side is a class preview too', (await viewer(page)).kind === 'class', (await viewer(page)).text);
    await page.hover('.trade-card[data-pending-id="' + ringListing + '"] .trading-cancel-btn');
    check('hovering the Cancel button shows no preview', await waitViewer(page, false, 2500));

    // The buyer takes the ring; the seller's listing settles on the settlement mail and the ring is gone from the wallet.
    const claimed = await b.W(async (a) => {
      const held = (await AtlasWallet.getWallet(a.k)).map((e) => e.credential);
      const membership = held.find((c) => c.asset.class === a.m && c.issuer.domain === a.s);
      const balance = held.find((c) => c.asset.class === a.g);
      const listing = (await AtlasWallet.fetchTradeListings(a.s)).find((l) => l.pendingId === a.id);
      try { await AtlasWallet.claimTradeListing(a.s, membership, listing, balance); return 'ok'; } catch (e) { return String(e.message).slice(0, 200); }
    }, { k: b.pub, m: MEMBER, s: S.domain, g: GOLD, id: ringListing });
    check('the buyer claims the ring listing', claimed === 'ok', claimed);
    await refresh(w); await checkMail(w);
    const settled = (await records(w)).find((r) => r.pendingId === ringListing);
    check('the listing is Settled and the ring has left the seller\'s wallet', settled.status === 'settled' && (await heldRing(w)) === null, settled);
    await page.evaluate(() => refreshTradingListingsList());
    await hoverSide(page, cardSide(ringListing, 'first'));
    await waitViewer(page, true);
    await waitText(page, 'atlas.serial');
    v = await viewer(page);
    check('a settled listing still shows the exact ring from the recorded snapshot', v.kind === 'exact' && v.text.includes('atlas.serial: ' + ring.properties['atlas.serial']) && /as recorded when you listed it/.test(v.text), v.text);
    check('the settled card still offers Delete and no Cancel', await page.evaluate((id) => { const c = document.querySelector('#tradingListingsList .trade-card[data-pending-id="' + id + '"]'); return !!c.querySelector('.trading-delete-listing-btn') && !c.querySelector('.trading-cancel-btn'); }, ringListing));

    // An older record has no snapshot: a labelled class preview, never an exact one.
    await page.evaluate(() => {
      const orig = AtlasWallet.getSubmittedTrades;
      AtlasWallet.getSubmittedTrades = async (k) => (await orig(k)).map((r) => { const c = { ...r }; delete c.offerSnapshot; return c; });
    });
    await page.evaluate(() => refreshTradingListingsList());
    await hoverSide(page, cardSide(ringListing, 'first'));
    await waitViewer(page, true);
    await waitText(page, 'Class defaults');
    v = await viewer(page);
    check('a settled record without a snapshot is a class preview that says it is not this exact item', v.kind === 'class' && /not this exact item/i.test(v.text) && !/exact listed item/i.test(v.text) && !v.text.includes('atlas.serial: ' + ring.properties['atlas.serial']), v.text);
    await page.close();
  }, { workers: 4 });
}

async function main() {
  const kinds = U.which === 'both' ? ['node', 'php'] : [U.which];
  for (const kind of kinds) await scenarios(kind);
  const { passes, failures } = U.counts();
  console.log(`\ntrade card previews: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}
async function pollUntil(fn, ms) { const end = Date.now() + (ms || 5000); while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; }
main().catch((e) => { console.error(e); process.exit(2); });
