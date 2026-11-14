// Sub-identities, moving an item (docs/sub-identities.md, step 5), driven through the real wallet UI against a
// throw-away local issuer on localhost:8001. Throw-away identities only; nothing here touches a live site.
//
// Run with a display and the demo issuer up on port 8001, e.g.:  xvfb-run -a node test/manual-sub-identity-move-ui.js
// Screenshots go to $SHOTS (default: the OS temp directory), never into the repository.

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const SHOTS = process.env.SHOTS || os.tmpdir();
const PASSWORD = 'sub-identity-move-ui-password-1';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sub-move-ui-'));
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
    const settle = (ms = 600) => page.waitForTimeout(ms);

    console.log('--- with no second identity there is nothing to move to ---');
    await frame.evaluate(async () => { await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.demo.coupon'); await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.badge'); });
    await frame.evaluate(() => refreshInventoryDisplay());
    await settle();
    const menuItems = () => frame.$$eval('#selfDocumentsList .wallet-item, #selfCollectiblesList .wallet-item, #selfDocumentsList [data-action], #selfCollectiblesList [data-action]', (els) => els.map((e) => e.dataset.action || '').filter(Boolean));
    check('no Move action while this is the only identity', !(await menuItems()).includes('move-identity'), await menuItems());

    console.log('--- with a second identity ---');
    await frame.evaluate(async () => { await AtlasWallet.createSubIdentity('Shopping'); await refreshInventoryDisplay(); });
    await settle();
    const actions = await menuItems();
    check('the coupon offers Move', actions.filter((a) => a === 'move-identity').length === 1, actions);
    check('the bound badge does not', actions.filter((a) => a === 'move-identity').length === 1 && actions.includes('hide'));

    await frame.locator('#documentsSubtabBtn').click();
    const couponCard = frame.locator('#selfDocumentsList .wallet-item', { hasText: 'Coupon' }).first();
    await couponCard.locator('.card-menu-toggle').click();
    await couponCard.locator('button[data-action="move-identity"]').click();
    await frame.waitForSelector('#bridgeOfferPreviewModal.active', { timeout: 5000 });
    const dialogText = await frame.locator('#bridgeOfferPreviewBody').innerText();
    check('the dialog says the issuer moves it and links the identities', /localhost:8001/.test(dialogText) && /connected/.test(dialogText) && /cannot be moved/.test(dialogText), dialogText);
    const choices = await frame.$$eval('#assetFileDialogChoice option', (os) => os.map((o) => o.textContent));
    check('the choices are the other identities', choices.join() === 'Shopping', choices);
    await page.screenshot({ path: path.join(SHOTS, 'sub-move-dialog.png') });

    console.log('--- moving ---');
    await frame.locator('#bridgeOfferPreviewClaimBtn').click();
    await frame.waitForSelector('#bridgeOfferPreviewModal.active', { state: 'detached', timeout: 15000 }).catch(() => {});
    await settle(1500);
    const status = await frame.locator('#status').textContent().catch(() => '');
    check('the dialog closes and says where it went', !(await frame.evaluate(() => document.getElementById('bridgeOfferPreviewModal').classList.contains('active'))) && /Moved .* to Shopping/.test(status || await frame.evaluate(() => (typeof statusEl !== 'undefined' ? statusEl.textContent : ''))), status);
    check('the coupon is gone from this identity', (await frame.locator('#selfDocumentsList .wallet-item', { hasText: 'Coupon' }).count()) === 0);
    check('the bound badge stayed', (await frame.locator('#selfCollectiblesList .wallet-item', { hasText: 'Badge' }).count()) === 1);

    await frame.evaluate(async () => { const subs = await AtlasWallet.listSubIdentities(); await AtlasWallet.switchIdentity(subs[0].id); await refreshInventoryDisplay(); });
    await settle(1200);
    check('the other identity shows it, verified', (await frame.locator('#selfDocumentsList .wallet-item', { hasText: 'Coupon' }).count()) === 1
      && /verified|valid/i.test(await frame.locator('#selfDocumentsList .wallet-item .verdict').first().textContent()));
    const targetsBack = await frame.evaluate(async () => (await AtlasWallet.listMoveTargets()).map((t) => t.label));
    check('and can send it back to the main identity', targetsBack.join() === 'Main identity', targetsBack);
    await page.screenshot({ path: path.join(SHOTS, 'sub-move-received.png') });
    await page.setViewportSize({ width: 390, height: 800 });
    await settle(600);
    await page.screenshot({ path: path.join(SHOTS, 'sub-move-phone.png') });
    await page.setViewportSize({ width: 1280, height: 720 });

    console.log('--- a refusal is shown in the dialog ---');
    await frame.evaluate(async () => { await AtlasWallet.switchIdentity(null); await refreshInventoryDisplay(); });
    await settle();
    await frame.evaluate(async () => {
      const wallet = await AtlasWallet.getWallet((await AtlasWallet.getIdentity()).publicKey);
      window.__badgeId = wallet.find((e) => e.credential.asset.class === 'atlas.badge').credential.id;
      await beginMoveAssetToIdentity(window.__badgeId);
    });
    await frame.locator('#bridgeOfferPreviewClaimBtn').click();
    await settle(1500);
    check('moving a bound item from the dialog is refused with a message', /bound/.test(await frame.locator('#bridgeOfferPreviewStatus').textContent()), await frame.locator('#bridgeOfferPreviewStatus').textContent());
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL SUB-IDENTITY MOVE SCREEN CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error('ERROR', err); process.exit(1); });
