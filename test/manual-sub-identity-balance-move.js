// Moving a fungible balance, all or part, between identities of the same wallet (docs/sub-identities.md, section
// 8), through the issuer's split with the other identity's key as the recipient. Runs the real extension in a
// scratch Chromium profile against a throw-away local issuer on localhost:8001 (see README; use an isolated state
// directory). Only throw-away identities are used.
//
// Run with a display and the demo issuer up on port 8001, e.g.:  xvfb-run -a node test/manual-sub-identity-balance-move.js

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PASSWORD = 'sub-identity-balance-move-password-1';
const CLASS = 'atlas.currency.alpha';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-balance-move-'));
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
    const spare = await W(() => AtlasWallet.createSubIdentity('Spare'));
    const mint = (cls, qty) => W(async ({ cls, qty }) => AtlasWallet.mintAsset('self', 'localhost:8001', cls, qty), { cls, qty });
    const stacksOf = (pk) => W(async (pk) => (await AtlasWallet.getWallet(pk)).filter((e) => e.credential.asset.class === 'atlas.currency.alpha')
      .map((e) => ({ id: e.credential.id, qty: e.credential.quantity, owner: e.credential.owner.publicKey, valid: !!(e.lastVerdict && e.lastVerdict.valid) })), pk);
    const total = async (pk) => (await stacksOf(pk)).reduce((n, e) => n + e.qty, 0);
    const journalOf = (pk) => W(async (pk) => (await AtlasWallet.getPendingOperations(pk)).length, pk);
    const move = (id, to, amount) => W(async (a) => AtlasWallet.moveBalanceToIdentity(a.id, a.to, a.amount), { id, to, amount });

    await mint(CLASS, 10);
    const coupon = await mint('atlas.demo.coupon');
    const start = await stacksOf(main);
    check('the main identity holds one balance of 10', start.length === 1 && start[0].qty === 10, start);
    const balanceId = start[0].id;

    console.log('--- what the dialog is told ---');
    const info = await W(async (id) => AtlasWallet.getBalanceMoveInfo(id), balanceId);
    check('the move info names the class, issuer and total', info.assetClass === CLASS && info.domain === 'localhost:8001' && info.total === 10 && info.stacks === 1, info);

    console.log('--- refusals ---');
    check('zero is refused', /whole amount/.test(await fails(async (A, a) => A.moveBalanceToIdentity(a.id, a.to, 0), { id: balanceId, to: shopping.publicKey })));
    check('a fraction is refused', /whole amount/.test(await fails(async (A, a) => A.moveBalanceToIdentity(a.id, a.to, 1.5), { id: balanceId, to: shopping.publicKey })));
    check('more than the balance is refused', /Only 10/.test(await fails(async (A, a) => A.moveBalanceToIdentity(a.id, a.to, 11), { id: balanceId, to: shopping.publicKey })));
    check('a key that is not in this wallet is refused', /not in this wallet/.test(await fails(async (A, a) => A.moveBalanceToIdentity(a.id, 'not-a-key', 1), { id: balanceId })));
    check('an unknown balance is refused', /not in the identity/.test(await fails(async (A, a) => A.moveBalanceToIdentity('urn:atlas:asset:nope', a, 1), shopping.publicKey)));
    const couponId = (await W(async () => (await AtlasWallet.getWallet((await AtlasWallet.getIdentity()).publicKey)).find((e) => e.credential.asset.class === 'atlas.demo.coupon').credential.id));
    check('a unique item is refused here', /unique item/.test(await fails(async (A, a) => A.moveBalanceToIdentity(a.id, a.to, 1), { id: couponId, to: shopping.publicKey })));
    check('nothing was moved by the refusals', (await total(main)) === 10 && (await journalOf(main)) === 0);

    console.log('--- part of a balance ---');
    const part = await move(balanceId, shopping.publicKey, 4);
    check('the move reports what moved and where', part.moved === 4 && part.to.label === 'Shopping' && part.steps === 1, part);
    const mainAfter = await stacksOf(main);
    check('the acting identity keeps the rest, verified', mainAfter.length === 1 && mainAfter[0].qty === 6 && mainAfter[0].valid && mainAfter[0].owner === main, mainAfter);
    check('the old balance is revoked at the issuer', await W(async (id) => {
      const doc = await (await fetch('http://localhost:8001/.well-known/atlas-revocations.json', { cache: 'no-store' })).json();
      return (doc.revoked || []).some((r) => r.id === id);
    }, balanceId));
    check('the journal is empty again', (await journalOf(main)) === 0 && (await journalOf(shopping.publicKey)) === 0);
    const stored = await W(async (pk) => JSON.stringify((await chrome.storage.local.get('atlasWallets')).atlasWallets[pk]).slice(0, 60), shopping.publicKey);
    check('the other identity\'s wallet is stored encrypted', /__atlasEncrypted/.test(stored), stored);
    await W(async (id) => AtlasWallet.switchIdentity(id), shopping.id);
    const shoppingStacks = await stacksOf(shopping.publicKey);
    check('the other identity reads it, it names that identity and verifies', shoppingStacks.length === 1 && shoppingStacks[0].qty === 4 && shoppingStacks[0].owner === shopping.publicKey && shoppingStacks[0].valid, shoppingStacks);
    await W(async () => AtlasWallet.switchIdentity(null));

    console.log('--- the whole of what is left ---');
    const restId = (await stacksOf(main))[0].id;
    const whole = await move(restId, travel.publicKey, 6);
    check('moving all of it leaves nothing behind', whole.moved === 6 && (await stacksOf(main)).length === 0, await stacksOf(main));
    await W(async (id) => AtlasWallet.switchIdentity(id), travel.id);
    const travelStacks = await stacksOf(travel.publicKey);
    check('the other identity holds all 6 as one verified balance', travelStacks.length === 1 && travelStacks[0].qty === 6 && travelStacks[0].valid && travelStacks[0].owner === travel.publicKey, travelStacks);

    console.log('--- moving some back, and onto a balance that exists ---');
    const back = await move(travelStacks[0].id, shopping.publicKey, 2);
    check('a sub-identity can move part to another sub-identity', back.moved === 2 && (await total(travel.publicKey)) === 4, back);
    await W(async (id) => AtlasWallet.switchIdentity(id), shopping.id);
    check('the receiving identity holds its old 4 and the new 2', (await total(shopping.publicKey)) === 6, await stacksOf(shopping.publicKey));
    check('everything is verified', (await stacksOf(shopping.publicKey)).every((e) => e.valid));
    await W(async () => AtlasWallet.switchIdentity(null));

    console.log('--- an answer that never arrives ---');
    await W(async (id) => AtlasWallet.switchIdentity(id), travel.id);
    const travelNow = (await stacksOf(travel.publicKey))[0];
    await W(() => {
      window.__realFetch = window.fetch;
      window.__dropped = 0;
      window.fetch = async (url, opts) => {
        const res = await window.__realFetch(url, opts);
        if (typeof url === 'string' && url.endsWith('/atlas/asset/split') && window.__dropped === 0) {
          window.__dropped++;
          await res.text();
          throw new TypeError('network error (answer lost)');
        }
        return res;
      };
    });
    const lost = await fails(async (A, a) => A.moveBalanceToIdentity(a.id, a.to, 3), { id: travelNow.id, to: spare.publicKey });
    check('the move reports that it is saved and will be retried', /saved and will be retried/.test(lost), lost);
    check('the journal holds the request', (await journalOf(travel.publicKey)) === 1);
    check('the original balance is held back, not shown as verified', await W(async (a) => {
      const held = (await AtlasWallet.getWallet(a.pk)).find((e) => e.credential.id === a.id);
      return !!held && !!held.pendingOutcome;
    }, { pk: travel.publicKey, id: travelNow.id }));
    check('removing the receiving identity is refused while the move is unfinished', /move to this identity is unfinished/.test(await fails(async (A, id) => A.removeSubIdentity(id), spare.id)));
    check('exporting it is refused too', /unfinished/.test(await fails(async (A, a) => A.prepareSubIdentityExport(a.id, { password: a.pw }), { id: spare.id, pw: PASSWORD })));
    const outcomes = await W(async (pk) => AtlasWallet.recoverPendingOperations(pk), travel.publicKey);
    check('recovery asks again and the issuer returns the same result', outcomes.length === 1 && outcomes[0].status === 'completed', outcomes);
    await W(() => { window.fetch = window.__realFetch; });
    await W(async () => AtlasWallet.switchIdentity(null));
    check('the journal is empty and the amount arrived once', (await journalOf(travel.publicKey)) === 0 && (await total(spare.publicKey)) === 3 && (await total(travel.publicKey)) === 1, { spare: await total(spare.publicKey), travel: await total(travel.publicKey) });
    check('the total across identities is still 10', (await total(main)) + (await total(shopping.publicKey)) + (await total(travel.publicKey)) + (await total(spare.publicKey)) === 10);

    console.log('--- a request that spans several stacks ---');
    // An identity that is not acting does not merge what it receives, so Shopping holds its 4 and 2 separately.
    await W(async (id) => AtlasWallet.switchIdentity(id), shopping.id);
    const twoStacks = await stacksOf(shopping.publicKey);
    check('the identity holds two stacks, 4 and 2', twoStacks.map((e) => e.qty).sort().join() === '2,4', twoStacks);
    check('the move info counts both', (await W(async (id) => AtlasWallet.getBalanceMoveInfo(id), twoStacks[0].id)).total === 6);
    const spanning = await move(twoStacks[0].id, main, 5);
    check('5 is taken as the whole 4 and 1 from the 2, in two steps', spanning.moved === 5 && spanning.steps === 2, spanning);
    check('1 is left, and it verifies', (await total(shopping.publicKey)) === 1 && (await stacksOf(shopping.publicKey)).every((e) => e.valid), await stacksOf(shopping.publicKey));
    check('no request is left in the journal', (await journalOf(shopping.publicKey)) === 0);
    await W(async () => AtlasWallet.switchIdentity(null));
    check('the main identity gained exactly 5, verified', (await total(main)) === 5 && (await stacksOf(main)).every((e) => e.valid && e.owner === main), await stacksOf(main));
    check('the total across identities is still 10', (await total(main)) + (await total(shopping.publicKey)) + (await total(travel.publicKey)) + (await total(spare.publicKey)) === 10);

    console.log('--- removal rules ---');
    check('an identity that holds a balance cannot be removed', /still holds items/.test(await fails(async (A, id) => A.removeSubIdentity(id), spare.id)));
  } finally {
    await context.close().catch(() => {});
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (err) { /* scratch */ }
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL SUB-IDENTITY BALANCE MOVE CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
