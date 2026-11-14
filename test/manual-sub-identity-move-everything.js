// Moving everything an identity holds to another identity of the same wallet (docs/sub-identities.md). Runs the
// real extension in a scratch Chromium profile against a throw-away local issuer on localhost:8001 (use an
// isolated state directory). Only throw-away identities are used.
//
// Run with a display and the demo issuer up on port 8001, e.g.:  xvfb-run -a node test/manual-sub-identity-move-everything.js

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PASSWORD = 'sub-identity-move-everything-pw-1';
const DOMAIN = 'localhost:8001';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-move-everything-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = worker.url().split('/')[2];
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/viewer.html`);
    await page.waitForFunction(() => typeof AtlasWallet === 'object', null, { timeout: 10000 });
    const W = (fn, arg) => page.evaluate(fn, arg);
    const fails = async (fn, arg) => page.evaluate(async ({ src, arg }) => {
      try { await (new Function('A', 'arg', 'return (' + src + ')(A, arg)'))(AtlasWallet, arg); return null; } catch (err) { return String(err.message || err); }
    }, { src: fn.toString(), arg });

    const main = await W(async (pw) => (await AtlasWallet.createIdentity(pw)).publicKey, PASSWORD);
    const shopping = await W(() => AtlasWallet.createSubIdentity('Shopping'));
    const travel = await W(() => AtlasWallet.createSubIdentity('Travel'));
    const mint = (cls, qty) => W(async ({ cls, qty, domain }) => AtlasWallet.mintAsset('self', domain, cls, qty), { cls, qty, domain: DOMAIN });
    const held = (pk) => W(async (pk) => (await AtlasWallet.getWallet(pk)).map((e) => ({
      cls: e.credential.asset.class, qty: e.credential.quantity, owner: e.credential.owner.publicKey,
      valid: !!(e.lastVerdict && e.lastVerdict.valid), id: e.credential.id
    })), pk);
    const count = (list, cls) => list.filter((e) => e.cls === cls).length;
    const sum = (list, cls) => list.filter((e) => e.cls === cls).reduce((n, e) => n + e.qty, 0);
    const journalOf = (pk) => W(async (pk) => (await AtlasWallet.getPendingOperations(pk)).length, pk);
    const moveAll = (to) => W(async (to) => AtlasWallet.moveEverythingToIdentity(to), to);

    await mint('atlas.demo.coupon');
    await mint('atlas.demo.coupon');
    await mint('atlas.badge');
    await mint('atlas.currency.alpha', 10);
    await mint('atlas.currency.alpha', 5);
    await mint('atlas.currency.beta', 7);

    console.log('--- the plan ---');
    const plan = await W(() => AtlasWallet.getMoveEverythingPlan());
    check('the plan counts items and balances, and what cannot move', plan.items === 2 && plan.balances === 2 && plan.bound === 1 && plan.heldBack === 0, plan);
    check('a target that is not in this wallet is refused', /not in this wallet/.test(await fails(async (A) => A.moveEverythingToIdentity('not-a-key'))));
    check('the acting identity is not a target', /not in this wallet/.test(await fails(async (A, k) => A.moveEverythingToIdentity(k), main)));
    check('nothing moved by the refusals', (await held(main)).length >= 5 && (await journalOf(main)) === 0);

    console.log('--- everything from the main identity ---');
    const progress = [];
    const result = await W(async (to) => {
      const seen = [];
      const r = await AtlasWallet.moveEverythingToIdentity(to, (d, t) => seen.push(d + '/' + t));
      return Object.assign(r, { seen });
    }, shopping.publicKey);
    check('it reports what moved and where', result.moved.items === 2 && result.moved.balances === 2 && result.to.label === 'Shopping' && result.failed.length === 0, result);
    check('it lists what was left behind and why', result.left.length === 1 && /bound/.test(result.left[0].reason), result.left);
    check('progress is reported for each step', result.seen.join() === '1/4,2/4,3/4,4/4', result.seen);
    const mainLeft = await held(main);
    check('the main identity keeps only the bound item', mainLeft.length === 1 && mainLeft[0].cls === 'atlas.badge', mainLeft);
    await W((id) => AtlasWallet.switchIdentity(id), shopping.id);
    const shop = await held(shopping.publicKey);
    check('the other identity holds two coupons and both balances in full', count(shop, 'atlas.demo.coupon') === 2 && sum(shop, 'atlas.currency.alpha') === 15 && sum(shop, 'atlas.currency.beta') === 7, shop);
    check('everything it received verifies and names it', shop.every((e) => e.valid && e.owner === shopping.publicKey), shop);
    check('no request is left in any journal', (await journalOf(main)) === 0 && (await journalOf(shopping.publicKey)) === 0);

    console.log('--- what an identity holds, for removing it ---');
    const holdings = await W((id) => AtlasWallet.getSubIdentityHoldings(id), shopping.id);
    check('a holding identity reports its items and balances', holdings.state === 'held' && holdings.items === 2 && holdings.balances === 2 && !holdings.unfinished, holdings);
    const emptyHoldings = await W((id) => AtlasWallet.getSubIdentityHoldings(id), travel.id);
    check('an empty identity reports nothing', emptyHoldings.state === 'empty' && emptyHoldings.items === 0, emptyHoldings);
    check('removal is still refused while it holds items', /still holds items/.test(await fails(async (A, id) => A.removeSubIdentity(id), shopping.id)));

    console.log('--- from a sub-identity to another sub-identity ---');
    const second = await moveAll(travel.publicKey);
    check('everything it held moves', second.moved.items === 2 && second.moved.balances === 2 && second.failed.length === 0 && second.left.length === 0, second);
    check('it is empty afterwards', (await held(shopping.publicKey)).length === 0);
    await W(() => AtlasWallet.switchIdentity(null));
    check('an emptied identity can now be removed', (await fails(async (A, id) => A.removeSubIdentity(id), shopping.id)) === null);

    console.log('--- an issuer that does not answer ---');
    await W((id) => AtlasWallet.switchIdentity(id), travel.id);
    await W(() => {
      window.__realFetch = window.fetch;
      window.__failing = true;
      window.fetch = async (url, opts) => {
        if (window.__failing && typeof url === 'string' && url.indexOf('/atlas/asset/') !== -1) throw new TypeError('network error');
        return window.__realFetch(url, opts);
      };
    });
    const stalled = await moveAll(main);
    check('nothing moves, and each item says why', stalled.moved.items === 0 && stalled.moved.balances === 0 && stalled.failed.length === 4, stalled);
    check('after the first no-answer, the rest are not asked', stalled.failed.slice(1).every((f) => /did not answer earlier/.test(f.reason)), stalled.failed);
    await W(() => { window.__failing = false; });
    const recovered = await W(async (pk) => AtlasWallet.recoverPendingOperations(pk), travel.publicKey);
    check('what was saved is retried and completes', Array.isArray(recovered) && recovered.every((o) => o.status === 'completed'), recovered);
    const again = await moveAll(main);
    await W(() => { window.fetch = window.__realFetch; });
    const travelLeft = await held(travel.publicKey);
    await W(() => AtlasWallet.switchIdentity(null));
    const mainNow = await held(main);
    check('after retrying, every item and balance is in exactly one place', travelLeft.length === 0
      && count(mainNow, 'atlas.demo.coupon') === 2 && sum(mainNow, 'atlas.currency.alpha') === 15 && sum(mainNow, 'atlas.currency.beta') === 7
      && count(mainNow, 'atlas.badge') === 1, { again, travelLeft, mainNow });
    check('nothing is left in any journal', (await journalOf(main)) === 0 && (await journalOf(travel.publicKey)) === 0);
  } finally {
    await context.close().catch(() => {});
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (err) { /* scratch */ }
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL MOVE-EVERYTHING CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
