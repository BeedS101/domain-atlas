// Sub-identities, wallet screens (docs/sub-identities.md, step 3): the Identities list under Wallet -> Identity,
// the "acting as" badge under the tabs, and the switch / rename / remove flows, driven through the real wallet
// UI in a scratch Chromium profile. Throw-away identities only; the page served on localhost:8001 is the demo
// domain run locally (see README), and nothing here changes it.
//
// Run with a display and the demo issuer up on port 8001, e.g.:  xvfb-run -a node test/manual-sub-identities-ui.js
// Screenshots go to $SHOTS (default: the OS temp directory), never into the repository.

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const SHOTS = process.env.SHOTS || os.tmpdir();
const PASSWORD = 'sub-identities-ui-test-password-1';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sub-identities-ui-'));
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
    const mainKey = await frame.evaluate(async () => (await AtlasWallet.getIdentity()).publicKey);

    // Open the Identity category on the main wallet screen.
    await frame.locator('#mainWalletScreen [data-category="identity"] .settings-category-toggle').click();
    await frame.waitForSelector('#subIdentitiesSection', { state: 'visible', timeout: 5000 });
    const rows = () => frame.$$eval('#identityList .identity-row', (els) => els.map((e) => ({
      name: e.querySelector('.identity-row-name').textContent,
      active: e.classList.contains('active'),
      buttons: Array.from(e.querySelectorAll('button')).map((b) => b.textContent)
    })));
    const status = () => frame.locator('#subIdentityStatus').textContent();
    const badge = () => frame.evaluate(() => { const b = document.getElementById('actingAsBadge'); return { hidden: b.hidden, text: b.querySelector('.acting-as-name').textContent }; });
    const settle = (ms = 400) => page.waitForTimeout(ms);

    console.log('--- a new account ---');
    let r = await rows();
    check('only the main identity is listed, and it is active', r.length === 1 && r[0].name === 'Main identity' && r[0].active && r[0].buttons.length === 0, r);
    check('the acting-as badge is hidden', (await badge()).hidden === true);

    console.log('--- adding ---');
    await frame.locator('#newSubIdentityInput').fill('Shopping');
    await frame.locator('#addSubIdentityBtn').click();
    await settle();
    r = await rows();
    check('the new identity is listed, not active', r.length === 2 && r[1].name === 'Shopping' && !r[1].active && r[1].buttons.includes('Switch to this identity'), r);
    check('the form is cleared and says what happened', (await frame.locator('#newSubIdentityInput').inputValue()) === '' && /Added Shopping/.test(await status()), await status());
    await frame.locator('#newSubIdentityInput').fill('shopping');
    await frame.locator('#addSubIdentityBtn').click();
    await settle();
    check('a duplicate name is refused with a message', /already have an identity/.test(await status()) && (await rows()).length === 2, await status());
    await frame.locator('#newSubIdentityInput').fill('   ');
    await frame.locator('#addSubIdentityBtn').click();
    await settle();
    check('an empty name is refused with a message', /Give this identity a name/.test(await status()), await status());
    await frame.locator('#newSubIdentityInput').fill('Trading');
    await frame.locator('#newSubIdentityInput').press('Enter');
    await settle();
    check('Enter in the name field adds the identity', (await rows()).map((x) => x.name).join() === 'Main identity,Shopping,Trading');

    console.log('--- switching ---');
    await frame.locator('#identityList .identity-row', { hasText: 'Shopping' }).locator('button[data-action="switch"]').click();
    await settle(700);
    r = await rows();
    check('the active tag moves to the chosen identity', r.map((x) => x.name + (x.active ? '*' : '')).join() === 'Main identity,Shopping*,Trading', r);
    const b = await badge();
    check('the badge names the identity the wallet is acting as', b.hidden === false && b.text === 'Acting as Shopping', b);
    const shownKey = await frame.evaluate(async () => (await AtlasWallet.getIdentity()).publicKey);
    check('the wallet is acting as a different key', shownKey !== mainKey);
    check('the Identity area shows the name', /^Shopping · /.test(await frame.locator('#walletIdentity').textContent()), await frame.locator('#walletIdentity').textContent());
    await page.screenshot({ path: path.join(SHOTS, 'sub-identities-switched.png') });

    console.log('--- renaming ---');
    await frame.locator('#identityList .identity-row', { hasText: 'Shopping' }).locator('button[data-action="rename"]').click();
    await frame.waitForSelector('#identityList input[data-role="rename-input"]', { timeout: 3000 });
    const input = frame.locator('#identityList input[data-role="rename-input"]');
    check('the rename field starts with the current name', (await input.inputValue()) === 'Shopping');
    await input.fill('Weekend shopping');
    await input.press('Enter');
    await settle();
    check('Enter saves the new name and the badge follows', (await rows()).map((x) => x.name).join() === 'Main identity,Weekend shopping,Trading' && (await badge()).text === 'Acting as Weekend shopping', { rows: await rows(), badge: await badge() });
    await frame.locator('#identityList .identity-row', { hasText: 'Trading' }).locator('button[data-action="rename"]').click();
    await frame.waitForSelector('#identityList input[data-role="rename-input"]', { timeout: 3000 });
    await frame.locator('#identityList input[data-role="rename-input"]').fill('weekend SHOPPING');
    await frame.locator('#identityList button[data-action="rename-save"]').click();
    await settle();
    check('a clashing name is refused and the row stays editable', /already have an identity/.test(await status()) && (await frame.$$('#identityList input[data-role="rename-input"]')).length === 1, await status());
    await frame.locator('#identityList button[data-action="rename-cancel"]').click();
    await settle();
    check('cancel leaves the old name', (await rows()).map((x) => x.name).join() === 'Main identity,Weekend shopping,Trading');

    console.log('--- names are text, never markup ---');
    await frame.locator('#newSubIdentityInput').fill('<img src=x onerror="window.__pwned=1">');
    await frame.locator('#addSubIdentityBtn').click();
    await settle(700);
    check('a name with markup is shown literally', (await frame.$$('#identityList img')).length === 0 && (await rows()).some((x) => x.name.includes('<img')), await rows());
    check('...and nothing ran', (await frame.evaluate(() => window.__pwned)) === undefined);
    await frame.locator('#identityList .identity-row', { hasText: '<img' }).locator('button[data-action="remove"]').click();
    await frame.locator('#identityList .identity-row', { hasText: '<img' }).locator('button[data-action="remove"]').click();
    await settle();

    console.log('--- going back, removing ---');
    await frame.locator('#actingAsBackBtn').click();
    await settle(700);
    check('"Back to main" returns to the main identity and hides the badge', (await badge()).hidden === true && (await frame.evaluate(async () => (await AtlasWallet.getIdentity()).publicKey)) === mainKey);
    check('the main identity row is active again', (await rows())[0].active === true);
    await frame.locator('#identityList .identity-row', { hasText: 'Trading' }).locator('button[data-action="remove"]').click();
    await settle();
    r = await rows();
    check('Remove asks for confirmation first and removes nothing yet', r.length === 3 && r[2].buttons.includes('Confirm remove') && /Press Confirm remove/.test(await status()), { r, status: await status() });
    await frame.locator('#identityList .identity-row', { hasText: 'Weekend shopping' }).locator('button[data-action="rename"]').click();
    await frame.locator('#identityList button[data-action="rename-cancel"]').click();
    await settle();
    check('doing something else cancels the pending removal', (await rows()).every((x) => !x.buttons.includes('Confirm remove')), await rows());
    await frame.locator('#identityList .identity-row', { hasText: 'Trading' }).locator('button[data-action="remove"]').click();
    await frame.locator('#identityList .identity-row', { hasText: 'Trading' }).locator('button[data-action="remove"]').click();
    await settle();
    check('the second press removes it', (await rows()).map((x) => x.name).join() === 'Main identity,Weekend shopping' && /Removed/.test(await status()), { rows: await rows(), status: await status() });

    console.log('--- an identity that holds something is not removed ---');
    const shopId = await frame.evaluate(async () => (await AtlasWallet.listSubIdentities())[0].publicKey);
    await frame.evaluate(async (pk) => {
      const { atlasWallets } = await chrome.storage.local.get('atlasWallets');
      const all = atlasWallets || {};
      all[pk] = [{ credential: { credential: 'domain-atlas-asset/1.0', n: 1 } }];
      await chrome.storage.local.set({ atlasWallets: all });
    }, shopId);
    await frame.locator('#identityList .identity-row', { hasText: 'Weekend shopping' }).locator('button[data-action="remove"]').click();
    await frame.locator('#identityList .identity-row', { hasText: 'Weekend shopping' }).locator('button[data-action="remove"]').click();
    await settle();
    check('the wallet explains why, and the identity stays', /still holds items/.test(await status()) && (await rows()).length === 2, await status());

    console.log('--- layout ---');
    await frame.locator('#newSubIdentityInput').fill('A rather long identity name that keeps going');
    await frame.locator('#addSubIdentityBtn').click();
    await frame.locator('#identityList .identity-row', { hasText: 'A rather long' }).locator('button[data-action="switch"]').click();
    await settle(700);
    const overflow = await frame.evaluate(() => {
      const p = document.getElementById('walletPanel');
      const bar = document.getElementById('walletTabBar');
      const bad = Array.from(document.querySelectorAll('#identityList *, #actingAsBadge, #actingAsBadge *')).filter((e) => e.getBoundingClientRect().right > p.getBoundingClientRect().right + 1).length;
      return { panelScroll: p.scrollWidth - p.clientWidth, outside: bad, barScroll: bar.scrollWidth - bar.clientWidth };
    });
    check('nothing overflows the wallet panel with a long name', overflow.panelScroll <= 1 && overflow.outside === 0 && overflow.barScroll <= 1, overflow);
    await page.screenshot({ path: path.join(SHOTS, 'sub-identities-list.png') });

    await page.setViewportSize({ width: 390, height: 800 });
    await settle(700);
    const narrow = await frame.evaluate(() => {
      const p = document.getElementById('walletPanel');
      const right = p.getBoundingClientRect().right;
      const bad = Array.from(document.querySelectorAll('#identityList *, #actingAsBadge, #actingAsBadge *, #walletTabBar *')).filter((e) => e.getBoundingClientRect().right > right + 1).length;
      return { panelScroll: p.scrollWidth - p.clientWidth, outside: bad };
    });
    check('nothing overflows at phone width either', narrow.panelScroll <= 1 && narrow.outside === 0, narrow);
    await page.screenshot({ path: path.join(SHOTS, 'sub-identities-phone.png') });
    await page.setViewportSize({ width: 1280, height: 720 });

    console.log('--- locking ---');
    await frame.evaluate(() => AtlasWallet.lockIdentity());
    await settle(700);
    check('the badge is hidden once the wallet is locked', (await badge()).hidden === true);
    const sectionHidden = await frame.evaluate(() => document.getElementById('subIdentitiesSection').hidden);
    check('the identities list is hidden while locked', sectionHidden === true);
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL SUB-IDENTITY SCREEN CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error('ERROR', err); process.exit(1); });
