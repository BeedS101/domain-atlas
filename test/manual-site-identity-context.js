// The identity a single page acts as (docs/sub-identities.md, section 7): a page that answers for a site is pinned
// to the identity the site is bound to, whichever identity the wallet window has selected. Runs the real extension
// in a scratch Chromium profile with two extension pages standing in for the wallet window and the page that
// answers for a site. Throw-away identities only; nothing contacts an issuer or a site.
//
// Run with a display, e.g.:  xvfb-run -a node test/manual-site-identity-context.js

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PASSWORD = 'site-identity-context-test-pw-1';
const SITE = 'https://shop.example.com';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-site-context-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = worker.url().split('/')[2];
    const openPage = async () => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extId}/viewer.html`);
      await page.waitForFunction(() => typeof AtlasWallet === 'object', null, { timeout: 10000 });
      return page;
    };
    const wallet = await openPage();
    const W = (fn, arg) => wallet.evaluate(fn, arg);
    const actingAs = (page) => page.evaluate(async () => (await AtlasWallet.getIdentity()).publicKey);

    const main = await W(async (pw) => (await AtlasWallet.createIdentity(pw)).publicKey, PASSWORD);
    const shopping = await W(() => AtlasWallet.createSubIdentity('Shopping'));
    const travel = await W(() => AtlasWallet.createSubIdentity('Travel'));
    const nameOf = (key) => key === main ? 'main' : key === shopping.publicKey ? 'shopping' : key === travel.publicKey ? 'travel' : '?';

    console.log('--- a page pinned to a site identity ---');
    await W((id) => AtlasWallet.switchIdentity(id), travel.id);
    const site = await openPage();
    check('an unpinned page follows the identity the wallet selected', nameOf(await actingAs(site)) === 'travel');
    await site.evaluate((k) => AtlasWallet.useIdentityInThisContext(k), main);
    check('a page pinned to the main identity acts as main while a sub-identity is selected', nameOf(await actingAs(site)) === 'main', nameOf(await actingAs(site)));
    check('the wallet window is untouched', nameOf(await actingAs(wallet)) === 'travel');
    check('the pinned page reports the main identity as active', (await site.evaluate(() => AtlasWallet.getActiveIdentityInfo())).kind === 'main');
    await site.evaluate((k) => AtlasWallet.useIdentityInThisContext(k), shopping.publicKey);
    check('a page pinned to a sub-identity acts as it', nameOf(await actingAs(site)) === 'shopping');
    const list = await site.evaluate(() => AtlasWallet.listSubIdentities());
    check('the list marks the identity the page acts as', list.filter((e) => e.active).map((e) => e.label).join() === 'Shopping', list);
    await site.evaluate(() => AtlasWallet.releaseIdentityContext());
    check('releasing the pin follows the selected identity again', nameOf(await actingAs(site)) === 'travel');

    console.log('--- following a site ---');
    check('a site with no binding follows the selected identity and says it has to be asked', await (async () => {
      const r = await site.evaluate((o) => AtlasWallet.followSiteIdentity(o), SITE);
      return r.state === 'ask' && nameOf(await actingAs(site)) === 'travel';
    })());
    await W(async (o) => AtlasWallet.setSiteIdentity(o, (await AtlasWallet.getAccountIdentity()).publicKey, { remember: true }), SITE);
    const bound = await site.evaluate((o) => AtlasWallet.followSiteIdentity(o), SITE);
    check('a site bound to the main identity pins it, though a sub-identity is selected', bound.state === 'bound' && bound.kind === 'main' && nameOf(await actingAs(site)) === 'main', bound);
    await W(async ({ o, k }) => AtlasWallet.setSiteIdentity(o, k, { remember: true }), { o: SITE, k: shopping.publicKey });
    const rebound = await site.evaluate((o) => AtlasWallet.followSiteIdentity(o), SITE);
    check('a rebinding is followed', rebound.state === 'bound' && rebound.label === 'Shopping' && nameOf(await actingAs(site)) === 'shopping', rebound);

    console.log('--- choosing an identity in a pinned page ---');
    await site.evaluate((id) => AtlasWallet.switchIdentity(id), travel.id);
    check('an explicit switch replaces the pin for that page', nameOf(await actingAs(site)) === 'travel');
    check('and selects it for the wallet window', nameOf(await actingAs(wallet)) === 'travel');

    console.log('--- removing and exporting what a page is pinned to ---');
    await site.evaluate((o) => AtlasWallet.followSiteIdentity(o), SITE);
    check('the page is pinned to Shopping again', nameOf(await actingAs(site)) === 'shopping');
    const exportRefused = await site.evaluate(async ({ id, pw }) => {
      try { await AtlasWallet.prepareSubIdentityExport(id, { password: pw }); return null; } catch (err) { return String(err.message); }
    }, { id: shopping.id, pw: PASSWORD });
    check('exporting the identity a page is pinned to is refused', /Switch back/.test(exportRefused || ''), exportRefused);
    const selectedRefused = await site.evaluate(async ({ id, pw }) => {
      try { await AtlasWallet.prepareSubIdentityExport(id, { password: pw }); return null; } catch (err) { return String(err.message); }
    }, { id: travel.id, pw: PASSWORD });
    check('exporting the selected identity is refused from a pinned page too', /Switch back/.test(selectedRefused || ''), selectedRefused);
    await site.evaluate((id) => AtlasWallet.removeSubIdentity(id), shopping.id);
    check('removing the identity a page is pinned to leaves it on a real identity', ['main', 'travel'].includes(nameOf(await actingAs(site))), nameOf(await actingAs(site)));
    check('and the identity the wallet selected is unaffected', nameOf(await actingAs(wallet)) === 'travel');
    const stale = await site.evaluate((o) => AtlasWallet.followSiteIdentity(o), SITE);
    check('a binding to a removed identity is gone, so the site asks again', stale.state === 'ask' || stale.state === 'default', stale);
  } finally {
    await context.close().catch(() => {});
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (err) { /* scratch */ }
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL SITE IDENTITY CONTEXT CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
