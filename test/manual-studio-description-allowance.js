// The Asset Studio page in a real browser with the real wallet extension and a real PHP issuer: the description that
// follows the name, and the wallet's remaining-mint line. Run with a display:
//   xvfb-run -a node test/manual-studio-description-allowance.js
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StudioLab } = require('./studio-lab');
const BP = require('./lib/bridge-prompt');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-allowance-profile-'));
const CLASS = 'atlas.demo.studio.collectible';
const MINT = 'atlas.studio.mint/1';
const QUOTA = 'atlas.studio.quota/1';

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 700)));
  if (!ok) failures++;
};

function writeManifest(lab, sign) {
  const spatial = {
    spec: 'domain-atlas/1.0', domain: lab.host, owner: { name: 'Studio Test Domain', contact: 'demo@localhost' }, defaultWorld: 'lobby',
    worlds: [
      { id: 'lobby', name: 'Lobby', entry: { scene: '/spatial/lobby/scene.json', renderer: ['procedural-v1'] },
        policy: { guestAccess: 'open', discoverable: true, identityRequired: false, itemDropsAllowed: false, acceptedItemClasses: [], trustedIssuers: 'any' } },
      { id: 'studio', name: 'Asset Studio', policy: { walletBridge: { read: true, sign, offer: [CLASS] } } },
    ],
    updated: '2026-10-02T00:00:00Z',
  };
  fs.mkdirSync(path.join(lab.docroot, '.well-known'), { recursive: true });
  fs.writeFileSync(path.join(lab.docroot, '.well-known', 'spatial.json'), JSON.stringify(spatial, null, 2));
}

(async () => {
  const base = { mintsPerIpPerHour: 1000, challengesPerIpPerHour: 1000, maxMintsPerActorPerDay: 100, maxMintsPerNetworkPerDay: 100, maxMintsPerDay: 1000 };
  const lab = await StudioLab.start({ mint: true, config: Object.assign({ maxMintsPerRecipientPerDay: 2 }, base) });
  const noQuota = await StudioLab.start({ mint: true, config: Object.assign({ maxMintsPerRecipientPerDay: 3 }, base) });
  const off = await StudioLab.start({ mint: false });
  writeManifest(lab, [MINT, QUOTA]);
  writeManifest(noQuota, [MINT]);
  writeManifest(off, [MINT, QUOTA]);

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, executablePath: '/opt/pw-browsers/chromium',
    args: ['--disable-extensions-except=' + EXT_PATH, '--load-extension=' + EXT_PATH, '--no-sandbox'],
  });
  try {
    let background = context.serviceWorkers()[0];
    if (!background) background = await context.waitForEvent('serviceworker');
    const extensionId = new URL(background.url()).host;

    const wallet = await context.newPage();
    await wallet.goto('chrome-extension://' + extensionId + '/viewer.html', { waitUntil: 'load' });
    await wallet.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 10000 });
    await wallet.locator('#chooseNewBtn').click();
    await wallet.locator('#newPasswordInput').fill('studio-allowance-test-pw');
    await wallet.locator('#newPasswordConfirmInput').fill('studio-allowance-test-pw');
    await wallet.locator('#confirmCreateBtn').click();
    await wallet.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await wallet.locator('#seedConfirmCheck').check();
    await wallet.locator('#seedConfirmBtn').click();
    await wallet.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    const main = await wallet.evaluate(() => AtlasWallet.getIdentity());

    async function openStudio(l) {
      const page = await context.newPage();
      await page.goto(l.origin + '/atlas/studio/index.html', { waitUntil: 'load' });
      await page.bringToFront();
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      return page;
    }
    const text = (page, id) => page.locator('#' + id).innerText();
    const allowance = (page) => text(page, 'allowance');
    const waitAllowance = (page, re, ms) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('allowance').textContent), re.source, { timeout: ms || 15000 });
    const prompt = (page) => BP.frame(page);
    const promptOpen = (page) => BP.count(page);
    async function answerSign(page, approve) {
      await BP.wait(page, { timeout: 15000 });
      const frame = prompt(page);
      await frame.locator('#readyState').waitFor({ state: 'visible', timeout: 10000 });
      const shown = { purpose: await frame.locator('#purposeText').innerText(), payload: await frame.locator('#payloadBox').innerText() };
      await frame.locator(approve ? '#approveBtn' : '#denyBtn').click();
      return shown;
    }

    // ---- 1. the description follows the name until the visitor writes their own ----
    const studio = await openStudio(lab);
    await studio.waitForFunction(() => !!document.getElementById('assetName'));
    const pickTile = (v) => studio.locator('#templateTiles [data-value="' + v + '"]').click();
    const nd = async () => ({ name: await studio.locator('#assetName').inputValue(), desc: await studio.locator('#description').inputValue() });
    let v = await nd();
    check('the page starts with the description equal to the name', v.name === 'Achievement Trophy' && v.desc === v.name, v);
    for (const [tile, title] of [['sword', 'Ember Blade'], ['shield', 'Oak Bulwark'], ['ring', 'Signet Ring']]) {
      await pickTile(tile);
      v = await nd();
      check('selecting ' + tile + ' sets name and description to "' + title + '"', v.name === title && v.desc === title, v);
    }
    check('the preview and the design JSON carry the new description', (await text(studio, 'previewDescription')) === 'Signet Ring' && JSON.parse(await studio.evaluate(() => document.getElementById('json').textContent)).description === 'Signet Ring', null);
    await studio.locator('#assetName').fill('My Ring');
    v = await nd();
    check('typing a new name keeps an automatic description in step', v.name === 'My Ring' && v.desc === 'My Ring', v);
    await studio.locator('#assetName').pressSequentially(' of Dawn');
    v = await nd();
    check('and keeps following as the name is typed', v.desc === 'My Ring of Dawn', v);
    await studio.locator('#description').fill('Worn by the first rider.');
    await studio.locator('#assetName').pressSequentially('!');
    await studio.locator('#assetName').fill('Renamed Ring');
    v = await nd();
    check('once the visitor writes a description, naming no longer touches it', v.name === 'Renamed Ring' && v.desc === 'Worn by the first rider.', v);
    await studio.locator('#description').pressSequentially(' It hums.');
    v = await nd();
    check('the description stays editable', v.desc === 'Worn by the first rider. It hums.', v);
    await pickTile('sword');
    v = await nd();
    check('choosing another template starts over, with name and description matching again', v.name === 'Ember Blade' && v.desc === 'Ember Blade', v);
    await studio.locator('#assetName').fill('Dawn Blade');
    v = await nd();
    check('and the description follows the name again', v.desc === 'Dawn Blade', v);
    await studio.locator('#description').fill('');
    await studio.locator('#assetName').fill('Dusk Blade');
    v = await nd();
    check('an emptied description is the visitor\'s choice and stays empty', v.desc === '', v);
    await studio.locator('#description').fill('Dusk Blade');
    await studio.locator('#assetName').fill('Dawn Blade');
    v = await nd();
    check('writing the name back as the description hands it back to the name', v.desc === 'Dawn Blade', v);
    await pickTile('trophy');

    // ---- 2. the allowance line ----
    await waitAllowance(studio, /up to 2 per 24 hours/);
    check('before any approval the line shows the issuer\'s own limit (2) with a Check button, and no wallet prompt opened', /Wallet mint allowance: up to 2 per 24 hours/.test(await allowance(studio)) && await studio.locator('#allowanceCheck').isVisible() && (await promptOpen(studio)) === 0, await allowance(studio));
    await studio.locator('#allowanceCheck').click();
    let shown = await answerSign(studio, false);
    check('Check asks the wallet to sign one read-only request, shown in full', shown.purpose === QUOTA && /Read how many Asset Studio mints/.test(shown.payload) && shown.payload.includes(main.publicKey), shown);
    await waitAllowance(studio, /up to 2 per 24 hours/);
    check('declining shows nothing invented and leaves the Check button', await studio.locator('#allowanceCheck').isVisible(), await allowance(studio));
    await studio.locator('#allowanceCheck').click();
    await answerSign(studio, true);
    await waitAllowance(studio, /2 of 2 remaining/);
    let note = await text(studio, 'allowanceNote');
    check('after approval: "Wallet mint allowance: 2 of 2 remaining", with the per-wallet note', (await allowance(studio)) === 'Wallet mint allowance: 2 of 2 remaining' && /per-wallet allowance over a rolling 24 hours/.test(note) && /Network and issuer-wide limits are separate/.test(note), { a: await allowance(studio), note });

    await studio.reload({ waitUntil: 'load' });
    await waitAllowance(studio, /2 of 2 remaining/);
    check('a reload refreshes it from the issuer without asking the wallet again', (await promptOpen(studio)) === 0, await allowance(studio));

    // ---- 3. mints change the line; refused and declined mints do not ----
    async function mintOnce(approveSignature, offer) {
      await studio.locator('#mint').click();
      await answerSign(studio, approveSignature);
      if (!approveSignature) { await studio.waitForFunction(() => /declined|timed out/.test(document.getElementById('message').textContent), null, { timeout: 15000 }); return; }
      await BP.gone(studio, { timeout: 15000 }).catch(() => {});
      await BP.wait(studio, { timeout: 15000 });
      const f = prompt(studio);
      await f.locator('#offerState').waitFor({ state: 'visible', timeout: 15000 });
      await f.locator(offer ? '#offerApproveBtn' : '#offerDenyBtn').click();
      await studio.waitForFunction(() => /Offered to your wallet|Added to your wallet|declined|timed out|not permitted/.test(document.getElementById('message').textContent), null, { timeout: 15000 });
    }
    await mintOnce(false);
    await studio.waitForTimeout(500);
    check('declining the mint signature uses nothing: still 2 of 2', (await allowance(studio)) === 'Wallet mint allowance: 2 of 2 remaining', await allowance(studio));
    await mintOnce(true, true);
    await waitAllowance(studio, /1 of 2 remaining/);
    check('a successful mint updates the line to 1 of 2, without a wallet prompt for the refresh', (await allowance(studio)) === 'Wallet mint allowance: 1 of 2 remaining' && (await promptOpen(studio)) === 0, await allowance(studio));
    await mintOnce(true, false);
    await waitAllowance(studio, /0 of 2 remaining/);
    const spent = await allowance(studio);
    check('a mint whose wallet offer was declined is still counted by the issuer: 0 of 2, with when it is available again', /^Wallet mint allowance: 0 of 2 remaining\. Available again .+/.test(spent), spent);
    await studio.locator('#mint').click();
    await answerSign(studio, true);
    await studio.waitForFunction(() => /Mint refused: quota-recipient/.test(document.getElementById('message').textContent), null, { timeout: 15000 });
    await waitAllowance(studio, /^Wallet mint allowance: 0 of 2 remaining/);
    check('a mint beyond the allowance is refused by the issuer and the line stays at 0 of 2', /^Wallet mint allowance: 0 of 2 remaining/.test(await allowance(studio)), await allowance(studio));
    check('nothing but the two allowed attempts is on the issuer\'s ledger', lab.studioFiles('mint-receipts').filter((f) => /^attempt-/.test(f)).length === 2, lab.studioFiles('mint-receipts'));

    // ---- 4. another identity has its own line ----
    // The page's identity is the one the wallet binds to this site, so a change of identity is a change of that binding.
    await wallet.evaluate((a) => AtlasWallet.setSiteIdentity(a.o, a.k), { o: lab.origin, k: main.publicKey });
    const sub = await wallet.evaluate(() => AtlasWallet.createSubIdentity('Travel'));
    await wallet.evaluate((a) => AtlasWallet.setSiteIdentity(a.o, a.k), { o: lab.origin, k: sub.publicKey });
    await studio.bringToFront();
    await studio.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitAllowance(studio, /up to 2 per 24 hours/);
    check('a change of identity for this site moves the line to that identity, not yet checked (nothing is shown from the other one)', await studio.locator('#allowanceCheck').isVisible() && !/remaining/.test(await allowance(studio)), await allowance(studio));
    await studio.locator('#allowanceCheck').click();
    await answerSign(studio, true);
    await waitAllowance(studio, /2 of 2 remaining/);
    check('the other identity has its full 2 of 2', (await allowance(studio)) === 'Wallet mint allowance: 2 of 2 remaining', await allowance(studio));
    await wallet.evaluate((a) => AtlasWallet.setSiteIdentity(a.o, a.k), { o: lab.origin, k: main.publicKey });
    await studio.bringToFront();
    await studio.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitAllowance(studio, /0 of 2 remaining/);
    check('switching back shows the first identity\'s 0 of 2 again, from the issuer, with no new prompt', (await promptOpen(studio)) === 0, await allowance(studio));

    // ---- 5. an issuer-wide limit is shown apart from the wallet's share ----
    await studio.route('**/api.php?op=quota', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, wallet: { limit: 2, used: 0, remaining: 2, windowSeconds: 86400, nextSlotAt: null }, otherLimit: 'quota-actor', now: Math.floor(Date.now() / 1000) }) }));
    await studio.reload({ waitUntil: 'load' });
    await waitAllowance(studio, /2 of 2 remaining/);
    note = await text(studio, 'allowanceNote');
    check('when the network is at its own limit the line says so apart from the wallet\'s 2 of 2', /is currently reached, so a mint can be refused even while this wallet has some left/.test(note) && /your network/.test(note), note);
    await studio.unroute('**/api.php?op=quota');

    // ---- 6. unavailable, never invented ----
    await studio.route('**/api.php?op=quota', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false,"error":"internal-error"}' }));
    await studio.reload({ waitUntil: 'load' });
    await waitAllowance(studio, /unavailable/);
    check('an issuer error shows "Allowance unavailable", with no count', (await allowance(studio)) === 'Wallet mint allowance: Allowance unavailable', await allowance(studio));
    await studio.unroute('**/api.php?op=quota');
    await studio.route('**/api.php?op=quota', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"wallet":{"limit":2,"remaining":"lots"}}' }));
    await studio.reload({ waitUntil: 'load' });
    await waitAllowance(studio, /unavailable/);
    check('an answer that is not a count is not displayed', (await allowance(studio)) === 'Wallet mint allowance: Allowance unavailable', await allowance(studio));
    await studio.unroute('**/api.php?op=quota');
    await studio.close();

    for (const l of [noQuota, off]) await wallet.evaluate((a) => AtlasWallet.setSiteIdentity(a.o, a.k), { o: l.origin, k: main.publicKey });
    const noPurpose = await openStudio(noQuota);
    await waitAllowance(noPurpose, /up to 3 per 24 hours/);
    check('an issuer with the default limit shows 3', /up to 3 per 24 hours/.test(await allowance(noPurpose)), await allowance(noPurpose));
    await noPurpose.locator('#allowanceCheck').click();
    await waitAllowance(noPurpose, /unavailable/);
    check('a page the wallet is not set up to sign this request for shows "Allowance unavailable" and no prompt', (await promptOpen(noPurpose)) === 0 && (await allowance(noPurpose)) === 'Wallet mint allowance: Allowance unavailable', await allowance(noPurpose));
    await noPurpose.close();

    const disabled = await openStudio(off);
    await waitAllowance(disabled, /unavailable/);
    check('an issuer with minting off shows "Allowance unavailable"', (await allowance(disabled)) === 'Wallet mint allowance: Allowance unavailable', await allowance(disabled));
    check('and the Mint button is disabled as before', await disabled.locator('#mint').isDisabled(), null);
  } finally {
    await context.close().catch(() => {});
    for (const l of [lab, noQuota, off]) { await l.stop(); l.cleanup(); }
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  }
  console.log(failures ? '\nFAILED: ' + failures : '\nAll Studio description and allowance checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FAIL: ' + (e && e.stack || e)); process.exit(1); });
