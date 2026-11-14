// The in-page world overlay follows the identity its site is bound to (docs/sub-identities.md, section 7), driven
// through the real overlay against a throw-away local issuer on localhost:8001. Throw-away identities only;
// nothing here touches a live site.
//
// Run with a display and the demo issuer up on port 8001, e.g.:  xvfb-run -a node test/manual-site-identity-overlay-ui.js
// Screenshots go to $SHOTS (default: the OS temp directory), never into the repository.

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const SHOTS = process.env.SHOTS || os.tmpdir();
const PASSWORD = 'site-identity-overlay-ui-pw-1';
const SITE = 'http://localhost:8001';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-site-overlay-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = worker.url().split('/')[2];
    const page = await context.newPage();
    const settle = (ms = 600) => page.waitForTimeout(ms);

    const openOverlay = async () => {
      await page.goto(SITE, { waitUntil: 'load' });
      await page.locator('#domain-atlas-enter-btn').click();
      const handle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
      const frame = await handle.contentFrame();
      await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 15000 });
      return frame;
    };

    // Entering a world can open the panel itself and close it again once the identity is ready, and the button only
    // toggles, so let that settle before deciding whether the panel needs opening.
    const ensureWalletOpen = async (f) => {
      await page.waitForTimeout(1500);
      if (!(await f.evaluate(() => document.getElementById('walletPanel').classList.contains('open')))) await f.locator('#walletBtn').click();
      await f.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 5000 });
    };

    // The category may already be open from an earlier visit, so only toggle it when it is closed.
    const openIdentityCategory = async (f) => {
      const toggle = f.locator('#mainWalletScreen [data-category="identity"] .settings-category-toggle');
      await toggle.waitFor({ state: 'attached', timeout: 10000 });
      const open = await f.evaluate(() => { const s = document.getElementById('subIdentitiesSection'); return !!s && s.offsetParent !== null; });
      if (!open) await toggle.click({ timeout: 10000 });
    };

    let frame = await openOverlay();
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('onboardingChoiceScreen').classList.contains('active'), null, { timeout: 5000 });
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill(PASSWORD);
    await frame.locator('#newPasswordConfirmInput').fill(PASSWORD);
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });

    const main = await frame.evaluate(async () => (await AtlasWallet.getIdentity()).publicKey);
    const shopping = await frame.evaluate(() => AtlasWallet.createSubIdentity('Shopping'));
    const nameOf = (key) => key === main ? 'main' : key === shopping.publicKey ? 'shopping' : '?';
    const actingAs = (f) => f.evaluate(async () => (await AtlasWallet.getIdentity()).publicKey);
    const badge = (f) => f.evaluate(() => {
      const b = document.getElementById('actingAsBadge');
      return {
        hidden: b.hidden,
        text: b.querySelector('.acting-as-name').textContent,
        siteBtn: !document.getElementById('actingAsSiteBtn').hidden,
        backBtn: !document.getElementById('actingAsBackBtn').hidden
      };
    });

    console.log('--- a site with no binding ---');
    check('the overlay acts as the selected identity (main)', nameOf(await actingAs(frame)) === 'main');
    await frame.evaluate(() => refreshIdentityDisplay());
    await settle();
    check('the main identity on an unbound site shows no badge, as before', (await badge(frame)).hidden === true, await badge(frame));
    await frame.evaluate((id) => AtlasWallet.switchIdentity(id), shopping.id);
    await frame.evaluate(() => refreshIdentityDisplay());
    await settle();
    const ask = await badge(frame);
    check('a selected sub-identity on an unbound site offers to be used for the site', ask.hidden === false && ask.text === 'Acting as Shopping' && ask.siteBtn && ask.backBtn, ask);
    await frame.evaluate(() => AtlasWallet.switchIdentity(null));

    console.log('--- a site bound to a sub-identity ---');
    await frame.evaluate(async (o) => { const me = (await AtlasWallet.listSubIdentities())[0]; await AtlasWallet.setSiteIdentity(o, me.publicKey, { remember: true }); }, SITE);
    // A second page stands in for the wallet window, which keeps the main identity selected.
    const walletWindow = await context.newPage();
    await walletWindow.goto(`chrome-extension://${extId}/viewer.html`);
    await walletWindow.waitForFunction(() => typeof AtlasWallet === 'object', null, { timeout: 10000 });
    frame = await openOverlay();
    await ensureWalletOpen(frame);
    await settle(800);
    check('the overlay acts as the site’s identity', nameOf(await actingAs(frame)) === 'shopping', nameOf(await actingAs(frame)));
    check('the wallet window still has the main identity selected', nameOf(await actingAs(walletWindow)) === 'main');
    const bound = await badge(frame);
    check('the badge names the identity and the site, with no switch buttons', bound.hidden === false && bound.text === 'Acting as Shopping for localhost:8001' && !bound.siteBtn && !bound.backBtn, bound);
    check('the Identity area shows the name', /^Shopping · /.test(await frame.locator('#walletIdentity').textContent()), await frame.locator('#walletIdentity').textContent());
    await page.screenshot({ path: path.join(SHOTS, 'site-overlay-bound.png') });

    console.log('--- choosing another identity inside the overlay ---');
    await openIdentityCategory(frame);
    await frame.waitForSelector('#subIdentitiesSection', { state: 'visible', timeout: 5000 });
    await frame.locator('#identityList .identity-row', { hasText: 'Main identity' }).locator('button[data-action="switch"]').click();
    await settle(800);
    check('the overlay now acts as the chosen identity', nameOf(await actingAs(frame)) === 'main');
    const choosing = await badge(frame);
    check('the badge offers to remember it for this site', choosing.hidden === false && choosing.text === 'Acting as Main identity' && choosing.siteBtn, choosing);
    await frame.locator('#actingAsSiteBtn').click();
    await settle(800);
    const remembered = await badge(frame);
    check('remembering it binds the site to that identity', remembered.text === 'Acting as Main identity for localhost:8001' && !remembered.siteBtn, remembered);
    check('the binding is stored', (await frame.evaluate((o) => AtlasWallet.getSiteIdentity(o), SITE)).kind === 'main');

    console.log('--- a site bound to main while another identity is selected ---');
    await walletWindow.evaluate((id) => AtlasWallet.switchIdentity(id), shopping.id);
    check('the wallet window now has Shopping selected', nameOf(await actingAs(walletWindow)) === 'shopping');
    frame = await openOverlay();
    await ensureWalletOpen(frame);
    await settle(800);
    check('the overlay still acts as the main identity for this site', nameOf(await actingAs(frame)) === 'main', nameOf(await actingAs(frame)));
    const mainBound = await badge(frame);
    check('and says so', mainBound.hidden === false && mainBound.text === 'Acting as Main identity for localhost:8001', mainBound);

    console.log('--- changing the binding from the site list ---');
    await ensureWalletOpen(frame);
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 10000 });
    await openIdentityCategory(frame);
    await frame.waitForSelector('#siteIdentityList .identity-row select', { timeout: 5000 });
    await frame.locator('#siteIdentityList .identity-row select').selectOption({ label: 'Shopping' }).catch(async () => {
      await frame.locator('#siteIdentityList .identity-row select').selectOption(shopping.publicKey);
    });
    await settle(900);
    check('the overlay follows the new binding straight away', nameOf(await actingAs(frame)) === 'shopping', nameOf(await actingAs(frame)));
    check('the badge follows too', (await badge(frame)).text === 'Acting as Shopping for localhost:8001', await badge(frame));
  } finally {
    await context.close().catch(() => {});
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (err) { /* scratch */ }
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL SITE IDENTITY OVERLAY CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
