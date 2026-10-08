// Manual check for the wallet side of single-asset transfer files
// (SPEC.md §13.5): "Save to a file…" on an inventory card, "Import an asset
// file…" in Inventory, and the "Saved transfer files" list. The issuer side
// is covered by manual-asset-file-transfer.js; this drives the real wallet
// UI in real Chrome against an isolated issuer-server whose manifest has
// opted in with `fileTransfer`.
//
// Two independent wallets (separate profiles): Alice saves a ring to a file,
// Bob claims it.
//
// Checks:
//   1. Only a unique, unbound item offers "Save to a file…": a ring does, a
//      fungible balance and a bound badge do not.
//   2. Saving shows what will happen, downloads a file owned by a different
//      key, takes the ring out of Alice's wallet and lists it under "Saved
//      transfer files".
//   3. Bob importing the file sees a preview that says the issuer signature
//      checked out and the file is claimable; claiming adds a ring owned by
//      Bob's key.
//   4. Bob importing the same file again is recognised as already claimed by
//      him. Alice importing it is told someone has claimed it, and "Check if
//      claimed" removes her stored copy.
//   5. A genuine ring credential that is not a transfer file cannot be
//      claimed by Bob; Alice importing her own copy is told it is already in
//      her wallet; after deleting it, importing the copy offers to add it
//      back.
//   6. "Save file again" re-downloads the stored file and "Claim it back"
//      returns the item; the old file then reads as already claimed.
//   7. Files that are not JSON, are too large, are a whole-wallet export, or
//      name an issuer domain with a scheme are refused with a message and no
//      preview.
//   8. Text from a credential is escaped wherever it is rendered.
//   9. With the domain's opt-in removed, the dialog explains that saving to
//      a file is not enabled and offers no save button.
//
// Not part of the permanent suite, same reasoning as the other manual-*.js
// scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8221; // isolated, distinct from every other manual-*.js test
const DOMAIN = 'localhost:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-asset-file-wallet-'));
const DOCROOT_DIR = path.join(TMP, 'docroot');
const STATE_DIR = path.join(TMP, 'state');
const MANIFEST = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');
const RING = 'atlas.wearable.ring';

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}

async function openOverlay(context, label) {
  const page = await context.newPage();
  await page.goto('http://' + DOMAIN, { waitUntil: 'load' });
  await page.locator('#domain-atlas-enter-btn').click();
  const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
  const frame = await frameHandle.contentFrame();
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
  console.log('SETUP: ' + label + ' opened the overlay');
  return { page, frame };
}

async function createIdentity(frame, password) {
  await frame.locator('#walletBtn').click();
  await frame.locator('#chooseNewBtn').click();
  await frame.locator('#newPasswordInput').fill(password);
  await frame.locator('#newPasswordConfirmInput').fill(password);
  await frame.locator('#confirmCreateBtn').click();
  await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
  await frame.locator('#seedConfirmCheck').check();
  await frame.locator('#seedConfirmBtn').click();
  await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
  const publicKey = await frame.evaluate(() => AtlasWallet.getIdentity().then((i) => i.publicKey));
  await frame.locator('#walletBtn').click(); // closes the panel
  await frame.locator('#walletBtn').click(); // reopen it: the inventory lives inside
  return publicKey;
}

async function mint(frame, assetClass, quantity) {
  await frame.evaluate(([cls, qty]) => AtlasWallet.mintAsset('self', 'localhost:8221', cls, qty).then(() => refreshInventoryDisplay()), [assetClass, quantity]);
}

function cardByName(frame, name) {
  return frame.locator('#selfCollectiblesList .wallet-item').filter({ hasText: name });
}

async function openCardMenu(card) {
  await card.locator('.card-menu-toggle').click();
  await card.locator('.card-menu-items.show').waitFor({ state: 'visible', timeout: 3000 });
}

async function waitForDialog(frame) {
  await frame.waitForFunction(() => document.getElementById('bridgeOfferPreviewModal').classList.contains('active'), { timeout: 10000 });
  // The verification and status checks run before the dialog opens, so its
  // text is complete by now.
  return frame.locator('#bridgeOfferPreviewBox').innerText();
}

async function primaryVisible(frame) {
  return frame.evaluate(() => getComputedStyle(document.getElementById('bridgeOfferPreviewClaimBtn')).display !== 'none');
}

async function closeDialog(frame) {
  await frame.locator('#bridgeOfferPreviewDismissBtn').click();
  await frame.waitForFunction(() => !document.getElementById('bridgeOfferPreviewModal').classList.contains('active'), { timeout: 3000 });
}

async function importFile(frame, file) {
  await frame.locator('#importAssetFileInput').setInputFiles(file);
}

async function holdingsOf(frame) {
  return frame.evaluate(() => AtlasWallet.getIdentity().then(async (id) => (await AtlasWallet.getWallet(id.publicKey)).map((e) => ({ id: e.credential.id, cls: e.credential.asset.class, owner: e.credential.owner.publicKey }))));
}

(async () => {
  console.log('SETUP: isolated issuer-server on port ' + PORT + ' with a copy of demo-domain-a whose manifest opts in to fileTransfer');
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  manifest.domain = DOMAIN;
  manifest.chat = false;
  manifest.calendar = false;
  manifest.tradingStation = false;
  manifest.fileTransfer = { classes: [RING] };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  const serverProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: DOCROOT_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    serverProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });

  const contexts = [];
  async function launch(label) {
    const profile = path.join(TMP, 'profile-' + label);
    const context = await chromium.launchPersistentContext(profile, {
      headless: false,
      executablePath: '/opt/pw-browsers/chromium',
      acceptDownloads: true,
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
    });
    contexts.push(context);
    return context;
  }

  try {
    const alice = await openOverlay(await launch('alice'), 'Alice');
    const bob = await openOverlay(await launch('bob'), 'Bob');
    const aliceKey = await createIdentity(alice.frame, 'asset-file-test-password-a');
    const bobKey = await createIdentity(bob.frame, 'asset-file-test-password-b');
    assert(aliceKey !== bobKey, 'two identities should differ');

    console.log('STEP 1: only a unique, unbound item offers "Save to a file…"');
    await mint(alice.frame, RING);
    await mint(alice.frame, 'atlas.element.iron', 5);
    await mint(alice.frame, 'atlas.badge', 1);
    await alice.frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length >= 3, { timeout: 15000 });
    const saveButtons = await alice.frame.$$eval('#selfCollectiblesList .wallet-item', (cards) => cards.map((c) => ({ text: c.querySelector('.name').textContent, has: !!c.querySelector('button[data-action="save-file"]') })));
    assert(saveButtons.find((c) => /Signet Ring/.test(c.text) && c.has), 'the ring should offer Save to a file: ' + JSON.stringify(saveButtons));
    assert(saveButtons.filter((c) => !/Signet Ring/.test(c.text)).every((c) => !c.has), 'the balance and the bound badge must not: ' + JSON.stringify(saveButtons));
    console.log('PASS: ring offers it; iron balance and bound badge do not');

    console.log('STEP 2: saving shows what will happen, downloads a file, and moves the ring to Saved transfer files');
    const ringCard = cardByName(alice.frame, 'Signet Ring');
    await openCardMenu(ringCard);
    await ringCard.locator('button[data-action="save-file"]').click();
    const saveDialogText = await waitForDialog(alice.frame);
    assert(/takes the item out of your wallet/.test(saveDialogText) && /first person to claim/.test(saveDialogText), 'the dialog should explain the consequences: ' + saveDialogText);
    assert(/Signet Ring/.test(saveDialogText), 'the dialog should preview the item');
    const [download] = await Promise.all([alice.page.waitForEvent('download'), alice.frame.locator('#bridgeOfferPreviewClaimBtn').click()]);
    const file1Path = path.join(TMP, 'file1.atlas-asset.json');
    await download.saveAs(file1Path);
    assert(/\.atlas-asset\.json$/.test(download.suggestedFilename()), 'unexpected file name ' + download.suggestedFilename());
    const file1 = JSON.parse(fs.readFileSync(file1Path, 'utf8'));
    assert(file1.owner.publicKey !== aliceKey && file1.asset.class === RING && file1.issuer.domain === DOMAIN, 'the file should be a ring credential owned by a different key');
    await alice.frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 2 && !document.getElementById('pendingExportsSection').hidden, { timeout: 15000 });
    assert((await holdingsOf(alice.frame)).every((h) => h.cls !== RING), 'the ring should have left Alice\'s wallet');
    const pendingText = await alice.frame.locator('#pendingExportsList').innerText();
    assert(/Signet Ring/.test(pendingText), 'the pending list should show the ring: ' + pendingText);
    console.log('PASS: file downloaded, ring left the wallet, pending list shows it');

    console.log('STEP 3: Bob previews the file, then claims it');
    await importFile(bob.frame, file1Path);
    const claimDialogText = await waitForDialog(bob.frame);
    assert(/Signed by localhost:8221/.test(claimDialogText) && /Claimable right now/.test(claimDialogText), 'the preview should state the verification: ' + claimDialogText);
    assert(/Signet Ring/.test(claimDialogText) && /uses up the file/.test(claimDialogText), 'the preview should show the item and the consequence: ' + claimDialogText);
    assert((await bob.frame.locator('#bridgeOfferPreviewClaimBtn').innerText()) === 'Claim into my wallet', 'unexpected primary button');
    assert((await holdingsOf(bob.frame)).length === 0, 'previewing must not change the wallet');
    await bob.frame.locator('#bridgeOfferPreviewClaimBtn').click();
    await bob.frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 1, { timeout: 15000 });
    const bobHolds = await holdingsOf(bob.frame);
    assert(bobHolds.length === 1 && bobHolds[0].cls === RING && bobHolds[0].owner === bobKey, 'Bob should now own the ring: ' + JSON.stringify(bobHolds));
    console.log('PASS: preview first, then the ring is Bob\'s');

    console.log('STEP 4: importing the same file again is recognised; Alice is told it is claimed');
    await importFile(bob.frame, file1Path);
    const againText = await waitForDialog(bob.frame);
    assert(/already claimed this file/.test(againText) && !(await primaryVisible(bob.frame)), 'Bob should be told he already claimed it, with nothing to click: ' + againText);
    await closeDialog(bob.frame);
    await alice.frame.locator('#pendingExportsList button[data-action="pe-check"]').click();
    await alice.frame.waitForFunction(() => document.getElementById('pendingExportsSection').hidden === true, { timeout: 10000 });
    assert(/claimed/.test(await alice.frame.locator('#importAssetFileStatus').innerText()), 'Alice should be told it was claimed');
    await importFile(alice.frame, file1Path);
    const aliceTooLate = await waitForDialog(alice.frame);
    assert(/already claimed this file/.test(aliceTooLate) && !(await primaryVisible(alice.frame)), 'Alice should be told someone claimed it: ' + aliceTooLate);
    await closeDialog(alice.frame);
    console.log('PASS: repeat import recognised; Alice told it is gone and her stored copy dropped');

    console.log('STEP 5: a genuine credential that is not a transfer file cannot be claimed; copies are recognised');
    await mint(alice.frame, RING);
    const ring2 = await alice.frame.evaluate(() => AtlasWallet.getIdentity().then(async (id) => (await AtlasWallet.getWallet(id.publicKey)).find((e) => e.credential.asset.class === 'atlas.wearable.ring').credential));
    const ring2Path = path.join(TMP, 'ring2.json');
    fs.writeFileSync(ring2Path, JSON.stringify(ring2));
    await importFile(bob.frame, ring2Path);
    const notFileText = await waitForDialog(bob.frame);
    assert(/cannot be claimed/.test(notFileText) && !(await primaryVisible(bob.frame)), 'a copied wallet credential must not be claimable: ' + notFileText);
    await closeDialog(bob.frame);
    await importFile(alice.frame, ring2Path);
    const ownText = await waitForDialog(alice.frame);
    assert(/already in your wallet/.test(ownText) && !(await primaryVisible(alice.frame)), 'Alice importing her own item should be told it is already there: ' + ownText);
    await closeDialog(alice.frame);
    await alice.frame.evaluate((id) => AtlasWallet.getIdentity().then((i) => AtlasWallet.deleteAsset(i.publicKey, id)).then(() => refreshInventoryDisplay()), ring2.id);
    await importFile(alice.frame, ring2Path);
    const restoreText = await waitForDialog(alice.frame);
    assert(/copy of an item that belongs to your key/.test(restoreText) && (await alice.frame.locator('#bridgeOfferPreviewClaimBtn').innerText()) === 'Add to my wallet', 'a copy of her own item should offer to add it back: ' + restoreText);
    await alice.frame.locator('#bridgeOfferPreviewClaimBtn').click();
    await alice.frame.waitForFunction((id) => AtlasWallet.getIdentity().then(async (i) => (await AtlasWallet.getWallet(i.publicKey)).some((e) => e.credential.id === id)), ring2.id, { timeout: 10000 });
    assert((await holdingsOf(bob.frame)).length === 1, 'Bob\'s wallet must be unchanged');
    console.log('PASS: not claimable by Bob; Alice\'s own copy recognised, then restored');

    console.log('STEP 6: save file again, then claim it back');
    const ringCard2 = cardByName(alice.frame, 'Signet Ring');
    await openCardMenu(ringCard2);
    await ringCard2.locator('button[data-action="save-file"]').click();
    await waitForDialog(alice.frame);
    const [download2] = await Promise.all([alice.page.waitForEvent('download'), alice.frame.locator('#bridgeOfferPreviewClaimBtn').click()]);
    const file2Path = path.join(TMP, 'file2.atlas-asset.json');
    await download2.saveAs(file2Path);
    await alice.frame.waitForFunction(() => !document.getElementById('pendingExportsSection').hidden, { timeout: 15000 });
    const [download3] = await Promise.all([alice.page.waitForEvent('download'), alice.frame.locator('#pendingExportsList button[data-action="pe-save"]').click()]);
    const file2Again = path.join(TMP, 'file2-again.atlas-asset.json');
    await download3.saveAs(file2Again);
    assert(fs.readFileSync(file2Path, 'utf8') === fs.readFileSync(file2Again, 'utf8'), 'saving again should give the same file');
    await alice.frame.locator('#pendingExportsList button[data-action="pe-claim-back"]').click();
    await alice.frame.waitForFunction(() => document.getElementById('pendingExportsSection').hidden === true, { timeout: 10000 });
    const aliceBack = await holdingsOf(alice.frame);
    assert(aliceBack.some((h) => h.cls === RING && h.owner === aliceKey), 'the ring should be back with Alice');
    await importFile(bob.frame, file2Path);
    const staleText = await waitForDialog(bob.frame);
    assert(/already claimed this file/.test(staleText) && !(await primaryVisible(bob.frame)), 'the old file should now read as claimed: ' + staleText);
    await closeDialog(bob.frame);
    console.log('PASS: same file re-saved, item claimed back, old file dead');

    console.log('STEP 7: unusable files are refused with a message and no preview');
    const status = bob.frame.locator('#importAssetFileStatus');
    const refusals = [
      ['not JSON', { name: 'a.json', mimeType: 'application/json', buffer: Buffer.from('this is not json') }, /not valid JSON/],
      ['too large', { name: 'b.json', mimeType: 'application/json', buffer: Buffer.alloc(300 * 1024, 32) }, /too large/],
      ['whole-wallet export', { name: 'c.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'atlas-wallet-export/1.0', credentials: [] })) }, /whole-wallet export/],
      ['issuer domain with a scheme', { name: 'd.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...file1, issuer: { ...file1.issuer, domain: 'http://evil.example' } })) }, /issuer domain/]
    ];
    for (const [label, file, pattern] of refusals) {
      await importFile(bob.frame, file);
      await bob.frame.waitForFunction((src) => new RegExp(src).test(document.getElementById('importAssetFileStatus').textContent), pattern.source, { timeout: 5000 });
      assert(!(await bob.frame.evaluate(() => document.getElementById('bridgeOfferPreviewModal').classList.contains('active'))), label + ' must not open a preview');
    }
    console.log('PASS: four refusals, no preview');

    console.log('STEP 8: credential text is escaped when rendered');
    const rendered = await alice.frame.evaluate(() => renderAssetViewerProperties({ '<b>key</b>': '<img src=x onerror=window.__xss=1>' }));
    assert(!/<img|<b>/.test(rendered) && /&lt;img/.test(rendered), 'markup must be escaped, got: ' + rendered);
    console.log('PASS: markup rendered as text');

    console.log('STEP 9: when the domain stops offering file transfers the dialog says so');
    const off = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    delete off.fileTransfer;
    fs.writeFileSync(MANIFEST, JSON.stringify(off, null, 2));
    await alice.page.waitForTimeout(61000); // the wallet caches a domain's answer for 60 seconds
    const ringCard3 = cardByName(alice.frame, 'Signet Ring');
    await openCardMenu(ringCard3);
    await ringCard3.locator('button[data-action="save-file"]').click();
    const disabledText = await waitForDialog(alice.frame);
    assert(/has not enabled saving items to a file/.test(disabledText) && !(await primaryVisible(alice.frame)), 'expected an explanation and no save button: ' + disabledText);
    await closeDialog(alice.frame);
    console.log('PASS: explained, nothing to click');

    console.log('\nALL ASSET FILE WALLET CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
    serverProc.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (err) {}
    process.exit(process.exitCode || 0);
  }
})();
