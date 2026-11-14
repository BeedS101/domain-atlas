// Sub-identities, export and import screens (docs/sub-identities.md, step 4): the Export panel and the Import
// section under Wallet -> Identity -> Identities, driven through the real wallet UI in a scratch Chromium
// profile. Throw-away identities only; the page served on localhost:8001 is the demo domain run locally (see
// README), and nothing here changes it.
//
// Run with a display and the demo issuer up on port 8001, e.g.:  xvfb-run -a node test/manual-sub-identity-export-ui.js
// Screenshots go to $SHOTS (default: the OS temp directory), never into the repository.

const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const SHOTS = process.env.SHOTS || os.tmpdir();
const PASSWORD = 'sub-identity-export-ui-password-1';

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail)));
  if (!ok) failures++;
}

// The secondary identity actions sit behind each row's "more actions" menu; the second click of Remove (Confirm remove) is a visible button.
async function menuClick(row, action) {
  const item = row.locator('button[data-action="' + action + '"]');
  if (!(await item.isVisible())) await row.locator('.card-menu-toggle').click();
  await item.click();
}

// Types the words the proof step asks for, taken from the code.
async function typeProofWords(frame, code, transform) {
  const words = code.trim().split(/\s+/);
  const labels = await frame.locator('#subExportConfirmWords label').evaluateAll((ls) => ls.map((l) => l.firstChild.textContent));
  const inputs = frame.locator('#subExportConfirmWords input');
  for (let i = 0; i < labels.length; i++) {
    const position = Number(labels[i].replace('Word ', ''));
    await inputs.nth(i).fill(transform ? transform(words[position - 1]) : words[position - 1]);
  }
  return labels.map((l) => Number(l.replace('Word ', '')));
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sub-export-ui-'));
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-sub-export-dl-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    acceptDownloads: true,
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
    const names = () => frame.$$eval('#identityList .identity-row-name', (els) => els.map((e) => e.textContent));
    const settle = (ms = 500) => page.waitForTimeout(ms);
    const rowFor = (name) => frame.locator('#identityList .identity-row', { hasText: name });
    const exportStatus = () => frame.locator('#subIdentityExportStatus').textContent();
    const listStatus = () => frame.locator('#subIdentityStatus').textContent();
    const importStatus = () => frame.locator('#subImportStatus').textContent();
    const panelHidden = () => frame.evaluate(() => document.getElementById('subIdentityExportPanel').hidden);

    for (const name of ['Shopping', 'Travel']) {
      await frame.locator('#newSubIdentityInput').fill(name);
      await frame.locator('#addSubIdentityBtn').click();
      await settle();
    }
    const shopping = await frame.evaluate(async () => (await AtlasWallet.listSubIdentities()).find((e) => e.label === 'Shopping'));
    await frame.evaluate(async (id) => {
      await AtlasWallet.switchIdentity(id);
      await AtlasWallet.addFriend('shopping-friend-key', 'Shopping Pal');
      await AtlasWallet.switchIdentity(null);
    }, shopping.id);
    await settle();

    console.log('--- opening the export panel ---');
    check('the panel is closed to start with', await panelHidden());
    check('only sub-identities have an Export button', (await frame.$$eval('#identityList .identity-row', (els) => els.map((e) => !!e.querySelector('button[data-action="export"]')))).join() === 'false,true,true');
    await menuClick(rowFor('Shopping'), 'export');
    check('the panel opens for the chosen identity', !(await panelHidden()) && /Export Shopping/.test(await frame.locator('#subIdentityExportTitle').textContent()));
    check('the file password field is hidden until asked for', await frame.locator('#subExportFilePasswordInput').isHidden());
    check('data is included by default', await frame.locator('#subExportIncludeDataCheck').isChecked());
    await page.screenshot({ path: path.join(SHOTS, 'sub-export-step1.png') });

    console.log('--- a wrong password changes nothing ---');
    await frame.locator('#subExportPasswordInput').fill('not-the-wallet-password');
    await frame.locator('#subExportCreateBtn').click();
    await settle(1500);
    check('it says the password is wrong and stays on step one', /Incorrect password/.test(await exportStatus()) && await frame.locator('#subIdentityExportStep1').isVisible(), await exportStatus());
    check('the identity is still listed', (await names()).includes('Shopping'));

    console.log('--- a different password for the file needs to be long enough ---');
    await frame.locator('#subExportPasswordInput').fill(PASSWORD);
    await frame.locator('#subExportOtherPasswordCheck').check();
    check('the file password field appears', await frame.locator('#subExportFilePasswordInput').isVisible());
    await frame.locator('#subExportFilePasswordInput').fill('short');
    await frame.locator('#subExportCreateBtn').click();
    await settle(500);
    check('a short file password is refused', /at least 8/.test(await exportStatus()), await exportStatus());
    await frame.locator('#subExportOtherPasswordCheck').uncheck();
    check('unticking hides and clears the field', await frame.locator('#subExportFilePasswordInput').isHidden() && (await frame.locator('#subExportFilePasswordInput').inputValue()) === '');

    console.log('--- creating the file ---');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      frame.locator('#subExportCreateBtn').click()
    ]);
    const filePath = path.join(downloads, download.suggestedFilename());
    await download.saveAs(filePath);
    const file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    check('a file was downloaded with the export format', file.format === 'atlas-sub-identity-export/1.0' && /^atlas-identity-shopping-/.test(download.suggestedFilename()), { format: file.format, name: download.suggestedFilename() });
    check('the file holds no plaintext', !/Shopping|Pal/.test(fs.readFileSync(filePath, 'utf8')));
    check('step two shows the code and nothing has been removed', await frame.locator('#subIdentityExportStep2').isVisible() && (await names()).includes('Shopping'));
    const code = (await frame.locator('#subExportCodeText').textContent()).trim();
    await settle(1200);
    check('the code and the words to type are scrolled into view', await frame.evaluate(() => {
      const box = document.getElementById('subExportCodeText').getBoundingClientRect(), words = document.getElementById('subExportConfirmWords').getBoundingClientRect();
      return box.top >= 0 && words.bottom <= window.innerHeight;
    }));
    await page.screenshot({ path: path.join(SHOTS, 'sub-export-step2.png') });
    check('the code is 16 words', code.split(/\s+/).length === 16, code);
    check('the password note says which password protects the file', /wallet password/.test(await frame.locator('#subExportPasswordNote').textContent()));
    check('Finish is disabled until the person confirms', await frame.locator('#subExportFinishBtn').isDisabled());
    const positions = await frame.locator('#subExportConfirmWords label').evaluateAll((ls) => ls.map((l) => l.firstChild.textContent));
    check('three different words of the code are asked for', positions.length === 3 && new Set(positions).size === 3 && positions.every((p) => /^Word \d+$/.test(p)), positions);
    check('the box warns that the code is shown once and not kept', /shown once and is not kept/.test(await frame.locator('#subIdentityExportStep2').textContent()));
    await frame.locator('#subExportSavedCheck').check();
    check('marking the file saved is not enough to finish', await frame.locator('#subExportFinishBtn').isDisabled());
    await frame.locator('#subExportConfirmWords input').first().fill('wrongword');
    await frame.locator('#subExportConfirmWords input').nth(1).fill('wrongword');
    await frame.locator('#subExportConfirmWords input').nth(2).fill('wrongword');
    check('wrong words keep Finish disabled and say so', await frame.locator('#subExportFinishBtn').isDisabled() && /do not match/.test(await frame.locator('#subExportConfirmStatus').textContent()), await frame.locator('#subExportConfirmStatus').textContent());
    await typeProofWords(frame, code);
    await frame.locator('#subExportConfirmWords input').nth(2).fill('');
    check('two right words and an empty one keep it disabled', await frame.locator('#subExportFinishBtn').isDisabled());
    await frame.locator('#subExportSavedCheck').uncheck();
    await typeProofWords(frame, code, (w) => '  ' + w.toUpperCase() + ' ');
    check('right words with different case and spaces match, but the file must be marked saved too', await frame.locator('#subExportFinishBtn').isDisabled() && /match the code/.test(await frame.locator('#subExportConfirmStatus').textContent()));
    await frame.locator('#subExportSavedCheck').check();
    check('Finish is enabled once the words match and the file is marked saved', await frame.locator('#subExportFinishBtn').isEnabled());
    await frame.locator('#subExportSavedCheck').uncheck();
    await menuClick(rowFor('Shopping'), 'remove');
    await settle(500);
    check('the identity cannot be removed while its export waits for the second step', (await names()).includes('Shopping') && /being exported/.test(await listStatus()), await listStatus());
    check('the code is not in the wallet\'s storage anywhere', await frame.evaluate(async (c) => {
      const all = JSON.stringify(await chrome.storage.local.get(null)) + JSON.stringify(await chrome.storage.session.get(null));
      return !all.includes(c);
    }, code));
    await page.setViewportSize({ width: 390, height: 800 });
    await settle(600);
    check('the panel fits a phone width', await frame.evaluate(() => { const p = document.getElementById('subIdentityExportPanel'); return p.scrollWidth <= p.clientWidth + 1; }));
    await page.screenshot({ path: path.join(SHOTS, 'sub-export-phone.png') });
    await page.setViewportSize({ width: 1280, height: 720 });

    console.log('--- keeping it instead ---');
    await frame.locator('#subExportKeepBtn').click();
    check('keeping closes the panel and removes nothing', await panelHidden() && (await names()).includes('Shopping') && /Nothing was removed/.test(await listStatus()), await listStatus());
    check('the code is gone from the page', !(await frame.evaluate((c) => document.body.innerText.includes(c), code)));

    console.log('--- finishing ---');
    await menuClick(rowFor('Shopping'), 'export');
    await frame.locator('#subExportPasswordInput').fill(PASSWORD);
    await frame.locator('#subExportOtherPasswordCheck').check();
    await frame.locator('#subExportFilePasswordInput').fill('a-separate-file-password');
    const [download2] = await Promise.all([
      page.waitForEvent('download', { timeout: 20000 }),
      frame.locator('#subExportCreateBtn').click()
    ]);
    const filePath2 = path.join(downloads, 'second-' + download2.suggestedFilename());
    await download2.saveAs(filePath2);
    const code2 = (await frame.locator('#subExportCodeText').textContent()).trim();
    check('the second code is different', code2 !== code);
    check('the note names the separate password', /separate password/.test(await frame.locator('#subExportPasswordNote').textContent()));
    await frame.locator('#subExportSavedCheck').check();
    check('Finish stays disabled until the words are typed', await frame.locator('#subExportFinishBtn').isDisabled());
    await typeProofWords(frame, code2);
    check('Finish is enabled after confirming', await frame.locator('#subExportFinishBtn').isEnabled());
    await frame.locator('#subExportFinishBtn').click();
    await settle(1000);
    check('the identity is gone and the panel is closed', !(await names()).includes('Shopping') && await panelHidden());
    check('the message says where it now lives and warns about earlier backups', /now exists only in the file/.test(await listStatus()) && /Backups made before now/.test(await listStatus()), await listStatus());
    check('the code is no longer on the page', !(await frame.evaluate((c) => document.body.innerText.includes(c), code2)));

    console.log('--- importing it back ---');
    await frame.locator('#subImportFileInput').setInputFiles(filePath2);
    await frame.locator('#subImportPasswordInput').fill(PASSWORD);
    await frame.locator('#subImportCodeInput').fill(code2);
    await frame.locator('#subImportBtn').click();
    await settle(1500);
    check('the wallet password alone does not open a file made with a separate password', /Incorrect password or code/.test(await importStatus()), await importStatus());
    check('nothing was added by the failed attempt', !(await names()).includes('Shopping'));
    await frame.locator('#subImportPasswordInput').fill('a-separate-file-password');
    await frame.locator('#subImportCodeInput').fill(code);
    await frame.locator('#subImportBtn').click();
    await settle(1500);
    check('the first code does not open the second file', /Incorrect password or code/.test(await importStatus()), await importStatus());
    await frame.locator('#subImportCodeInput').fill(code2.toUpperCase());
    await frame.locator('#subImportNameInput').fill('Shopping, restored');
    await page.screenshot({ path: path.join(SHOTS, 'sub-import-form.png') });
    await frame.locator('#subImportBtn').click();
    await settle(2000);
    check('the identity is back under the new name, with its data', (await names()).includes('Shopping, restored') && /with its items, mail and contacts/.test(await importStatus()), { names: await names(), status: await importStatus() });
    check('the form was cleared', (await frame.locator('#subImportPasswordInput').inputValue()) === '' && (await frame.locator('#subImportCodeInput').inputValue()) === '');
    await frame.locator('#identityList .identity-row', { hasText: 'Shopping, restored' }).locator('button[data-action="switch"]').click();
    await settle(900);
    check('its friends came back', await frame.evaluate(async () => (await AtlasWallet.getFriends()).map((f) => f.name).join() === 'Shopping Pal'));
    await frame.evaluate(() => AtlasWallet.switchIdentity(null));
    await settle(500);

    console.log('--- other refusals ---');
    await frame.locator('#subImportFileInput').setInputFiles(filePath2);
    await frame.locator('#subImportPasswordInput').fill('a-separate-file-password');
    await frame.locator('#subImportCodeInput').fill(code2);
    await frame.locator('#subImportBtn').click();
    await settle(1500);
    check('importing the same identity twice is refused', /already in your wallet/.test(await importStatus()), await importStatus());
    const junk = path.join(downloads, 'junk.json');
    fs.writeFileSync(junk, 'not json at all');
    await frame.locator('#subImportFileInput').setInputFiles(junk);
    await frame.locator('#subImportBtn').click();
    await settle(800);
    check('a file that is not JSON is refused', /not an Atlas identity file/i.test(await importStatus()), await importStatus());
    await frame.locator('#subImportFileInput').setInputFiles([]);
    await frame.locator('#subImportBtn').click();
    await settle(300);
    check('no file chosen is refused', /Choose an export file/.test(await importStatus()));

    console.log('--- an identity that is active cannot be exported ---');
    await rowFor('Travel').locator('button[data-action="switch"]').click();
    await settle(900);
    await menuClick(rowFor('Travel'), 'export');
    await frame.locator('#subExportPasswordInput').fill(PASSWORD);
    await frame.locator('#subExportCreateBtn').click();
    await settle(1500);
    check('the panel says to switch back first', /Switch back/.test(await exportStatus()), await exportStatus());
    await frame.locator('#subExportCancelBtn').click();
    check('cancel closes the panel and clears the password', await panelHidden() && (await frame.locator('#subExportPasswordInput').inputValue()) === '');
  } finally {
    await context.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(downloads, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL SUB-IDENTITY EXPORT SCREEN CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error('ERROR', err); process.exit(1); });
