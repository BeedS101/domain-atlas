// Per-site identities (docs/sub-identities.md, step 6), wallet screen: the Site identities list under
// Wallet -> Identity shows each remembered site with the identity it answers as, and lets the person change or
// forget it. Throw-away identities in a scratch Chromium profile; no site is contacted.
//
// Run with a display, e.g.:  xvfb-run -a node test/manual-site-identities-ui.js

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PASSWORD = 'site-identities-ui-password-1';
const SITE_A = 'https://shop.example.com';
const SITE_B = 'http://localhost:3000';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-site-id-ui-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = worker.url().split('/')[2];
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/viewer.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 10000 });
    await page.locator('#chooseNewBtn').click();
    await page.locator('#newPasswordInput').fill(PASSWORD);
    await page.locator('#newPasswordConfirmInput').fill(PASSWORD);
    await page.locator('#confirmCreateBtn').click();
    await page.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await page.locator('#seedConfirmCheck').check();
    await page.locator('#seedConfirmBtn').click();
    await page.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    const main = await page.evaluate(async () => (await AtlasWallet.getIdentity()).publicKey);
    const shopping = await page.evaluate(() => AtlasWallet.createSubIdentity('Shopping'));
    await page.evaluate(async ({ a, pk }) => AtlasWallet.setSiteIdentity(a, pk), { a: SITE_A, pk: shopping.publicKey });
    await page.evaluate(async ({ b, pk }) => AtlasWallet.setSiteIdentity(b, pk), { b: SITE_B, pk: main });

    await page.locator('#mainWalletScreen [data-category="identity"] .settings-category-toggle').click();
    await page.waitForSelector('#siteIdentityList', { state: 'visible', timeout: 5000 });
    await page.evaluate(() => refreshSubIdentitiesDisplay());
    const rows = () => page.$$eval('#siteIdentityList .identity-row', (els) => els.map((e) => ({
      origin: e.dataset.origin,
      chosen: e.querySelector('select').selectedOptions[0].textContent,
      options: Array.from(e.querySelectorAll('option')).map((o) => o.textContent)
    })));
    const status = () => page.locator('#siteIdentityStatus').textContent();
    const settle = (ms = 400) => page.waitForTimeout(ms);

    console.log('--- the list ---');
    let r = await rows();
    check('each remembered site is listed with its identity', JSON.stringify(r.map((x) => [x.origin, x.chosen])) === JSON.stringify([[SITE_B, 'Main identity'], [SITE_A, 'Shopping']].sort((x, y) => x[0].localeCompare(y[0]))), r);
    check('every identity can be picked', r.every((x) => x.options.join() === 'Main identity,Shopping'), r);

    console.log('--- changing ---');
    await page.locator('#siteIdentityList .identity-row[data-origin="' + SITE_B + '"] select').selectOption({ label: 'Shopping' });
    await settle();
    r = await rows();
    check('the new identity is shown and said to be saved', r.find((x) => x.origin === SITE_B).chosen === 'Shopping' && /Saved for/.test(await status()), { r, s: await status() });
    check('it is what the wallet now answers that site with', (await page.evaluate(async (o) => AtlasWallet.getSiteIdentity(o), SITE_B)).publicKey === shopping.publicKey);
    check('the wallet window is still on the main identity', (await page.evaluate(() => AtlasWallet.getActiveIdentityInfo())).kind === 'main');

    console.log('--- forgetting ---');
    await page.locator('#siteIdentityList .identity-row[data-origin="' + SITE_A + '"] button[data-action="forget-site"]').click();
    await settle();
    r = await rows();
    check('the site is gone from the list', r.length === 1 && r[0].origin === SITE_B, r);
    check('and says that it will ask again', /ask again/.test(await status()), await status());
    check('the wallet will ask the site again', (await page.evaluate(async (o) => AtlasWallet.getSiteIdentity(o), SITE_A)).state === 'ask');
    await page.locator('#siteIdentityList .identity-row[data-origin="' + SITE_B + '"] button[data-action="forget-site"]').click();
    await settle();
    check('an empty list says so', (await rows()).length === 0 && /No sites are remembered/.test(await page.locator('#siteIdentityEmpty').textContent()));
  } finally {
    await context.close().catch(() => {});
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (err) { /* scratch */ }
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
