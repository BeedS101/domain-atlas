// Sub-identities, moving a balance in whole or in part (docs/sub-identities.md, section 8), driven through the real
// wallet UI against a throw-away local issuer on localhost:8001. Throw-away identities only; nothing here touches a
// live site.
//
// Run with a display and the demo issuer up on port 8001, e.g.:  xvfb-run -a node test/manual-sub-identity-balance-move-ui.js
// Screenshots go to $SHOTS (default: the OS temp directory), never into the repository.

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const SHOTS = process.env.SHOTS || os.tmpdir();
const PASSWORD = 'sub-identity-balance-move-ui-password-1';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sub-balance-move-ui-'));
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

    await frame.evaluate(async () => { await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.currency.alpha', 10); await refreshInventoryDisplay(); });
    await settle();
    const moveButtons = () => frame.$$eval('button[data-action="move-balance"]', (els) => els.length);

    console.log('--- with no second identity there is nothing to move to ---');
    check('no Move balance action while this is the only identity', (await moveButtons()) === 0);

    console.log('--- with a second identity ---');
    await frame.evaluate(async () => { await AtlasWallet.createSubIdentity('Shopping'); await refreshInventoryDisplay(); });
    await settle();
    check('the balance offers Move balance', (await moveButtons()) === 1, await moveButtons());
    const card = frame.locator('.wallet-item', { has: frame.locator('button[data-action="move-balance"]') }).first();
    await card.locator('.card-menu-toggle').click();
    await card.locator('button[data-action="move-balance"]').click();
    await frame.waitForSelector('#bridgeOfferPreviewModal.active', { timeout: 5000 });
    const dialogText = await frame.locator('#bridgeOfferPreviewBody').innerText();
    check('the dialog says the issuer does it, that part or all can move, and that the identities are linked', /localhost:8001/.test(dialogText) && /all of it or part/.test(dialogText) && /connected/.test(dialogText), dialogText);
    check('the amount starts at the whole balance', (await frame.locator('#assetFileDialogAmount').inputValue()) === '10' && (await frame.locator('#assetFileDialogAmount').getAttribute('max')) === '10');
    check('the choices are the other identities', (await frame.$$eval('#assetFileDialogChoice option', (os) => os.map((o) => o.textContent))).join() === 'Shopping');
    await page.screenshot({ path: path.join(SHOTS, 'sub-balance-move-dialog.png') });

    console.log('--- a bad amount is refused in the dialog ---');
    await frame.locator('#assetFileDialogAmount').fill('0');
    await frame.locator('#bridgeOfferPreviewClaimBtn').click();
    await settle(800);
    check('zero is refused with a message and nothing moves', /whole amount/.test(await frame.locator('#bridgeOfferPreviewStatus').textContent()), await frame.locator('#bridgeOfferPreviewStatus').textContent());
    await frame.locator('#assetFileDialogAmount').fill('11');
    await frame.locator('#bridgeOfferPreviewClaimBtn').click();
    await settle(800);
    check('more than the balance is refused', /Only 10/.test(await frame.locator('#bridgeOfferPreviewStatus').textContent()), await frame.locator('#bridgeOfferPreviewStatus').textContent());

    console.log('--- moving part ---');
    await frame.locator('#assetFileDialogAmount').fill('4');
    await frame.locator('#bridgeOfferPreviewClaimBtn').click();
    await frame.waitForFunction(() => !document.getElementById('bridgeOfferPreviewModal').classList.contains('active'), null, { timeout: 15000 });
    await settle(1200);
    const status = await frame.evaluate(() => document.getElementById('status').textContent);
    check('the dialog closes and says what moved and where', /Moved 4 g of .* to Shopping/.test(status), status);
    const remaining = await frame.$$eval('.wallet-item', (els) => els.filter((e) => /alpha/.test(e.dataset.search || '')).map((e) => e.querySelector('.name span').textContent));
    check('the card now shows the rest', remaining.length === 1 && /6 g/.test(remaining[0]), remaining);

    console.log('--- the other identity ---');
    await frame.evaluate(async () => { const subs = await AtlasWallet.listSubIdentities(); await AtlasWallet.switchIdentity(subs[0].id); await refreshInventoryDisplay(); });
    await settle(1200);
    const received = await frame.$$eval('.wallet-item', (els) => els.filter((e) => /alpha/.test(e.dataset.search || '')).map((e) => ({ name: e.querySelector('.name span').textContent, verdict: e.querySelector('.verdict').textContent })));
    check('it shows 4 g, verified', received.length === 1 && /4 g/.test(received[0].name) && /verified|valid/i.test(received[0].verdict), received);
    await page.screenshot({ path: path.join(SHOTS, 'sub-balance-move-received.png') });

    console.log('--- moving all with the All button ---');
    const card2 = frame.locator('.wallet-item', { has: frame.locator('button[data-action="move-balance"]') }).first();
    await card2.locator('.card-menu-toggle').click();
    await card2.locator('button[data-action="move-balance"]').click();
    await frame.waitForSelector('#bridgeOfferPreviewModal.active', { timeout: 5000 });
    await frame.locator('#assetFileDialogAmount').fill('1');
    await frame.locator('#assetFileDialogAmountAll').click();
    check('All puts the whole balance in the box', (await frame.locator('#assetFileDialogAmount').inputValue()) === '4');
    await frame.locator('#bridgeOfferPreviewClaimBtn').click();
    await frame.waitForFunction(() => !document.getElementById('bridgeOfferPreviewModal').classList.contains('active'), null, { timeout: 15000 });
    await settle(1200);
    check('nothing is left here', (await frame.$$eval('.wallet-item', (els) => els.filter((e) => /alpha/.test(e.dataset.search || '')).length)) === 0);
    await frame.evaluate(async () => { await AtlasWallet.switchIdentity(null); await refreshInventoryDisplay(); });
    await settle(1200);
    const back = await frame.$$eval('.wallet-item', (els) => els.filter((e) => /alpha/.test(e.dataset.search || '')).map((e) => e.querySelector('.name span').textContent));
    check('the main identity has all 10 again (as the 6 it kept and the 4 that came back, merged when the wallet is next checked)', back.length >= 1 && back.reduce((n, t) => n + Number((/×(\d+) g/.exec(t) || [0, 0])[1]), 0) === 10, back);
    await page.setViewportSize({ width: 390, height: 800 });
    await settle(600);
    await page.screenshot({ path: path.join(SHOTS, 'sub-balance-move-phone.png') });
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL SUB-IDENTITY BALANCE MOVE SCREEN CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error('ERROR', err); process.exit(1); });
