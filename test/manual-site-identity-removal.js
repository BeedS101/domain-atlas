// A site bound to an identity that is later removed must never be answered by another identity on its own: it
// asks, and receives a key only after an explicit choice. Covers remembered and session-only bindings, removing
// one of several identities and removing the last one, sites that never had a binding, locking, and full backups.
// Scratch Chromium profiles and throw-away identities only; nothing contacts an issuer or a site.
//
// Run with a display, e.g.:  xvfb-run -a node test/manual-site-identity-removal.js

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PASSWORD = 'site-identity-removal-test-pw-1';
const SEED = 'amber anchor apple arrow aspen atlas aurora autumn';
const SITE = (n) => 'https://site-' + n + '.example';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-site-removal-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = worker.url().split('/')[2];
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/viewer.html`);
  await page.waitForFunction(() => typeof AtlasWallet === 'object', null, { timeout: 10000 });
  const W = (fn, arg) => page.evaluate(fn, arg);
  const close = async () => { await context.close().catch(() => {}); fs.rmSync(profile, { recursive: true, force: true }); };
  return { W, close };
}

const answer = (W, site) => W((o) => AtlasWallet.getSiteIdentity(o), site);
const setSite = (W, site, key, remember) => W(({ o, k, r }) => AtlasWallet.setSiteIdentity(o, k, { remember: r }), { o: site, k: key, r: remember !== false });
const askedWithoutKey = (a) => a.state === 'ask' && !a.publicKey;

(async () => {
  const made = [];
  try {
    const A = await launch();
    made.push(A);
    const { W } = A;
    const main = await W(async (pw) => (await AtlasWallet.createIdentity(pw)).publicKey, PASSWORD);
    const work = await W(() => AtlasWallet.createSubIdentity('Work'));
    const shop = await W(() => AtlasWallet.createSubIdentity('Shopping'));
    await setSite(W, SITE('work'), work.publicKey);
    await setSite(W, SITE('work-session'), work.publicKey, false);
    await setSite(W, SITE('shop'), shop.publicKey);
    await setSite(W, SITE('main'), main);

    console.log('--- removing one of several identities ---');
    await W((id) => AtlasWallet.removeSubIdentity(id), work.id);
    check('a remembered site bound to the removed identity asks, with no key', askedWithoutKey(await answer(W, SITE('work'))), await answer(W, SITE('work')));
    check('a session-only site bound to it asks, with no key', askedWithoutKey(await answer(W, SITE('work-session'))), await answer(W, SITE('work-session')));
    const shopNow = await answer(W, SITE('shop'));
    check('a site bound to another identity is unaffected', shopNow.state === 'bound' && shopNow.publicKey === shop.publicKey, shopNow);
    const mainNow = await answer(W, SITE('main'));
    check('a site bound to the main identity is unaffected', mainNow.state === 'bound' && mainNow.publicKey === main, mainNow);
    check('the removed identity is gone and the others keep their keys', (await W(() => AtlasWallet.listSubIdentities())).map((e) => e.publicKey).join() === shop.publicKey);
    check('the removed identity is not listed among remembered sites', !(await W(() => AtlasWallet.listSiteIdentities())).some((e) => e.origin === SITE('work')));
    await setSite(W, SITE('work'), shop.publicKey);
    check('an explicit choice then binds the site', (await answer(W, SITE('work'))).publicKey === shop.publicKey);

    console.log('--- removing the last sub-identity ---');
    await setSite(W, SITE('shop-session'), shop.publicKey, false);
    await W((id) => AtlasWallet.removeSubIdentity(id), shop.id);
    check('the account has only its main identity', (await W(() => AtlasWallet.listSubIdentities())).length === 0);
    for (const n of ['shop', 'work', 'shop-session']) {
      const a = await answer(W, SITE(n));
      check('site "' + n + '", bound to the removed identity, asks and is not given the main key', askedWithoutKey(a), a);
    }
    const mainOnly = await answer(W, SITE('main'));
    check('a site bound to the main identity keeps it', mainOnly.state === 'bound' && mainOnly.publicKey === main, mainOnly);
    const never = await answer(W, SITE('never'));
    check('a site that never had a binding keeps the normal single-identity answer', never.state === 'default' && never.publicKey === main, never);

    console.log('--- locking ---');
    await W(() => AtlasWallet.lockIdentity());
    check('a locked wallet answers nothing', (await answer(W, SITE('shop'))).state === 'locked');
    await W(async (pw) => AtlasWallet.unlockIdentity(pw), PASSWORD);
    check('after unlocking, a remembered site still asks', askedWithoutKey(await answer(W, SITE('shop'))));
    check('a session-only choice made before locking is forgotten, as before', (await answer(W, SITE('shop-session'))).state === 'default');

    console.log('--- an explicit choice is the only way out ---');
    const chosen = await setSite(W, SITE('shop'), main);
    check('choosing the main identity answers with it', chosen.state === 'bound' && chosen.publicKey === main, chosen);
    check('and remembers the choice across a lock', await (async () => {
      await W(() => AtlasWallet.lockIdentity());
      await W(async (pw) => AtlasWallet.unlockIdentity(pw), PASSWORD);
      const a = await answer(W, SITE('shop'));
      return a.state === 'bound' && a.publicKey === main;
    })());
    const created = await W((o) => AtlasWallet.createSiteIdentity(o, 'Fresh'), SITE('work'));
    check('creating a new identity for a marked site binds it to that identity only', created.state === 'bound' && created.publicKey !== main, created);

    console.log('--- a full backup keeps the marker ---');
    const gone = await W(() => AtlasWallet.createSubIdentity('Temporary'));
    await setSite(W, SITE('temp'), gone.publicKey);
    await W((id) => AtlasWallet.removeSubIdentity(id), gone.id);
    const file = await W(async ({ pw, seed }) => AtlasWallet.exportFullBackup(pw, seed), { pw: PASSWORD, seed: SEED });
    const B = await launch();
    made.push(B);
    await B.W(async ({ file, pw, seed }) => AtlasWallet.importFullBackup(file, pw, seed), { file, pw: PASSWORD, seed: SEED });
    check('after a restore, the site bound to a removed identity still asks', askedWithoutKey(await answer(B.W, SITE('temp'))), await answer(B.W, SITE('temp')));
    const restoredMain = await answer(B.W, SITE('main'));
    check('and a site bound to the main identity is still bound to it', restoredMain.state === 'bound' && restoredMain.publicKey === main, restoredMain);
    const restoredFresh = await answer(B.W, SITE('work'));
    check('and a site bound to a sub-identity that was backed up keeps it', restoredFresh.state === 'bound' && restoredFresh.publicKey === created.publicKey, restoredFresh);
    check('and a site that never had a binding asks like any site in a wallet with sub-identities', askedWithoutKey(await answer(B.W, SITE('never'))));
  } catch (err) {
    console.error('FATAL', err);
    failures++;
  } finally {
    for (const m of made) await m.close();
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
