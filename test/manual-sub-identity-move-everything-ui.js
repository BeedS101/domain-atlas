// Sub-identities, moving everything out of an identity and the remove flow that offers it first, driven through
// the real wallet UI against a throw-away local issuer on localhost:8001. Throw-away identities only; nothing here
// touches a live site.
//
// Run with a display and the demo issuer up on port 8001, e.g.:  xvfb-run -a node test/manual-sub-identity-move-everything-ui.js
// Screenshots go to $SHOTS (default: the OS temp directory), never into the repository.

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const SHOTS = process.env.SHOTS || os.tmpdir();
const PASSWORD = 'sub-identity-move-everything-ui-pw-1';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-move-everything-ui-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });
  try {
    const page = await context.newPage();
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });
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

    await frame.locator('#mainWalletScreen [data-category="identity"] .settings-category-toggle').click();
    await frame.waitForSelector('#subIdentitiesSection', { state: 'visible', timeout: 5000 });
    const rows = () => frame.$$eval('#identityList .identity-row', (els) => els.map((e) => ({
      name: e.querySelector('.identity-row-name').textContent,
      active: e.classList.contains('active'),
      buttons: Array.from(e.querySelectorAll('button')).map((b) => b.textContent)
    })));
    const row = (name) => frame.locator('#identityList .identity-row', { hasText: name });
    const settle = (ms = 500) => page.waitForTimeout(ms);
    const badge = () => frame.evaluate(() => { const b = document.getElementById('actingAsBadge'); return { hidden: b.hidden, text: b.querySelector('.acting-as-name').textContent }; });
    const status = () => frame.locator('#subIdentityStatus').textContent();
    const panelHidden = () => frame.evaluate(() => document.getElementById('subIdentityMovePanel').hidden);
    const mint = (cls, qty) => frame.evaluate(async ({ cls, qty }) => AtlasWallet.mintAsset('self', 'localhost:8001', cls, qty), { cls, qty });
    const holdings = () => frame.evaluate(async () => {
      const me = await AtlasWallet.getIdentity();
      return (await AtlasWallet.getWallet(me.publicKey)).map((e) => e.credential.asset.class + ':' + e.credential.quantity).sort();
    });

    console.log('--- with one identity there is nothing to move to ---');
    await mint('atlas.demo.coupon');
    await mint('atlas.demo.coupon');
    await mint('atlas.currency.alpha', 10);
    let r = await rows();
    check('the only identity offers no Move everything', r.length === 1 && !r[0].buttons.includes('Move everything…'), r);

    console.log('--- from the identity that is acting ---');
    await frame.locator('#newSubIdentityInput').fill('Shopping');
    await frame.locator('#addSubIdentityBtn').click();
    await settle();
    r = await rows();
    check('the active identity offers it, an inactive one does not', r[0].buttons.includes('Move everything…') && !r[1].buttons.includes('Move everything…'), r);
    await row('Main identity').locator('button[data-action="move-all"]').click();
    await frame.waitForSelector('#subIdentityMovePanel:not([hidden])', { timeout: 5000 });
    const summary = await frame.locator('#subIdentityMoveSummary').textContent();
    check('the panel says what it holds', /holds 2 items and 1 balance\./.test(summary), summary);
    check('the targets are the other identities', (await frame.$$eval('#subIdentityMoveTarget option', (os) => os.map((o) => o.textContent))).join() === 'Shopping');
    check('it explains that issuers are involved and the button says what it does', /issuer/.test(await frame.locator('#subIdentityMoveNote').textContent()) && (await frame.locator('#subIdentityMoveGoBtn').textContent()) === 'Move everything');
    await page.screenshot({ path: path.join(SHOTS, 'sub-move-everything-panel.png') });
    await frame.locator('#subIdentityMoveGoBtn').click();
    await frame.waitForFunction(() => /^Moved 2 items and 1 balance to Shopping/.test(document.getElementById('subIdentityMoveStatus').textContent), null, { timeout: 30000 });
    check('it reports what moved', true);
    await settle(800);
    check('the main identity is empty and the badge is unchanged', (await holdings()).length === 0 && (await badge()).hidden === true, await holdings());
    await frame.locator('#subIdentityMoveCancelBtn').click();
    check('Cancel closes the panel', await panelHidden());

    console.log('--- Remove offers to move first ---');
    await row('Shopping').locator('button[data-action="remove"]').click();
    await frame.waitForSelector('#subIdentityMovePanel:not([hidden])', { timeout: 5000 });
    check('the panel names the identity being emptied', /Move everything out of Shopping/.test(await frame.locator('#subIdentityMoveTitle').textContent()), await frame.locator('#subIdentityMoveTitle').textContent());
    check('the targets are the others, main first', (await frame.$$eval('#subIdentityMoveTarget option', (os) => os.map((o) => o.textContent))).join() === 'Main identity');
    check('it says the wallet switches while this runs, and offers move then remove', /switches to Shopping/.test(await frame.locator('#subIdentityMoveNote').textContent()) && (await frame.locator('#subIdentityMoveGoBtn').textContent()) === 'Move everything, then remove');
    check('nothing was asked to be confirmed for removal yet', !(await rows()).some((x) => x.buttons.includes('Confirm remove')));
    await frame.locator('#subIdentityMoveGoBtn').click();
    await frame.waitForFunction(() => /^Moved 2 items and 1 balance to Main identity/.test(document.getElementById('subIdentityMoveStatus').textContent), null, { timeout: 30000 });
    await settle(800);
    check('the wallet acted as Shopping to move it', true);
    check('Confirm remove is now offered, with a message', (await row('Shopping').locator('button[data-action="remove"]').textContent()) === 'Confirm remove' && /Everything was moved/.test(await status()), await status());
    await row('Shopping').locator('button[data-action="remove"]').click();
    await settle(800);
    r = await rows();
    check('the identity is removed and the wallet is back on the main identity', r.length === 1 && r[0].name === 'Main identity' && r[0].active && (await badge()).hidden === true, r);
    check('the panel closed when its identity was removed', await panelHidden());
    check('the main identity holds everything again', (await holdings()).join() === 'atlas.currency.alpha:10,atlas.demo.coupon:1,atlas.demo.coupon:1', await holdings());

    console.log('--- an identity that only holds bound items ---');
    await frame.locator('#newSubIdentityInput').fill('Badges');
    await frame.locator('#addSubIdentityBtn').click();
    await settle();
    await row('Badges').locator('button[data-action="switch"]').click();
    await settle(700);
    await mint('atlas.badge');
    await frame.locator('#identityList .identity-row', { hasText: 'Main identity' }).locator('button[data-action="switch"]').click();
    await settle(700);
    await row('Badges').locator('button[data-action="remove"]').click();
    await frame.waitForSelector('#subIdentityMovePanel:not([hidden])', { timeout: 5000 });
    const boundSummary = await frame.locator('#subIdentityMoveSummary').textContent();
    check('it says nothing can be moved and that one is bound', /nothing that can be moved/.test(boundSummary) && /1 bound/.test(boundSummary), boundSummary);
    check('the move button is disabled', await frame.locator('#subIdentityMoveGoBtn').isDisabled());
    check('the identity is still there', (await rows()).some((x) => x.name === 'Badges'));
    await frame.locator('#subIdentityMoveCancelBtn').click();
    check('Cancel closes the panel', await panelHidden());
  } finally {
    await context.close().catch(() => {});
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (err) { /* scratch */ }
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL MOVE-EVERYTHING UI CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
