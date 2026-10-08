// Manual check for the wallet side of recovering an interrupted single-asset
// file export (SPEC.md §13.5.1). The issuer side is covered by
// manual-asset-file-recovery.js; this drives the real wallet UI in real
// Chrome against an isolated issuer-server and breaks the connection in the
// ways that matter, by replacing fetch() in the wallet page:
//   drop-reply   the request reaches the issuer and is completed, but the
//                wallet never sees the answer
//   unreachable  the request never leaves the wallet
//   refuse       the issuer's own clear refusal
//   fail-save    the answer arrives but the wallet's attempt to store it fails
//
// Two wallets: Alice exports rings, Bob claims what she saves.
//
// Checks:
//   1. A lost reply is recovered inside the same click: the file downloads,
//      the ring leaves the wallet, Bob can claim it.
//   2. A lost reply while the issuer cannot be asked leaves the ring in the
//      wallet, an "interrupted" entry in Saved transfer files and a message;
//      saving the same ring again is refused. After the issuer is restarted,
//      "Check again" finishes the export: the entry gets its file, the ring
//      leaves the wallet, Bob can claim the file.
//   3. An interrupted export is finished automatically when the wallet is
//      opened again, with nothing clicked.
//   4. An answer that arrives but cannot be stored is settled the same way.
//   5. A clear refusal leaves nothing behind: no interrupted entry, ring kept.
//   6. A request that never reached the issuer stays "interrupted" until the
//      record is old enough to be believed, then is dropped with the ring
//      still in the wallet, and the ring can be saved normally afterwards.
//   7. When someone else has claimed the file while the wallet was in the
//      dark, "Check again" reports it and removes the revoked original.
//
// Not part of the permanent suite, same reasoning as the other manual-*.js
// scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const REPO = path.resolve(__dirname, '..');
const PORT = 8222; // isolated, distinct from every other manual-*.js test
const DOMAIN = 'localhost:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-asset-file-wallet-recovery-'));
const DOCROOT_DIR = path.join(TMP, 'docroot');
const STATE_DIR = path.join(TMP, 'state');
const MANIFEST = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');
const EXPORTS_STORE = path.join(STATE_DIR, 'atlas-file-exports-store.json');
const RING = 'atlas.wearable.ring';

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}

let serverProc = null;
function startIssuer() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['issuer-server/server.js'], {
      cwd: REPO, detached: true,
      env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: DOCROOT_DIR },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); serverProc = proc; resolve(); } });
    proc.on('exit', () => { if (serverProc === proc) serverProc = null; });
  });
}
function stopIssuer() {
  return new Promise((resolve) => {
    if (!serverProc) return resolve();
    const proc = serverProc;
    proc.once('exit', () => setTimeout(resolve, 50));
    try { process.kill(-proc.pid, 'SIGKILL'); } catch (err) { proc.kill('SIGKILL'); }
  });
}
function exportRecords() {
  return fs.existsSync(EXPORTS_STORE) ? Object.values(JSON.parse(fs.readFileSync(EXPORTS_STORE, 'utf8')).exports) : [];
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
  await frame.locator('#walletBtn').click();
  await frame.locator('#walletBtn').click();
  return publicKey;
}

// Replaces fetch() in the wallet page. `window.__fault` maps 'export' and
// 'recover' to a mode; see the header comment.
async function installFaults(frame) {
  await frame.evaluate(() => {
    window.__fault = { export: null, recover: null };
    window.__failLedgerOnce = false;
    const real = window.fetch.bind(window);
    window.__realFetch = real;
    window.fetch = async (url, opts) => {
      const u = String(url);
      const kind = u.includes('/atlas/asset/transfer-to-file') ? 'export' : u.includes('/atlas/asset/recover-file-export') ? 'recover' : null;
      const mode = kind && window.__fault[kind];
      if (mode === 'drop-reply') { await real(url, opts); throw new TypeError('Failed to fetch'); }
      if (mode === 'unreachable') throw new TypeError('Failed to fetch');
      if (mode === 'refuse') return new Response(JSON.stringify({ error: 'refused by the test issuer', code: 'class-not-allowed' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      if (mode === 'fail-save') { const r = await real(url, opts); window.__failLedgerOnce = true; return r; }
      return real(url, opts);
    };
    const realSet = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = (items, cb) => {
      if (window.__failLedgerOnce && items && Object.prototype.hasOwnProperty.call(items, 'atlasAssetFiles')) {
        window.__failLedgerOnce = false;
        return Promise.reject(new Error('simulated storage failure'));
      }
      return realSet(items, cb);
    };
  });
}
async function setFault(frame, kind, mode) {
  await frame.evaluate(([k, m]) => { window.__fault[k] = m; }, [kind, mode]);
}

async function mintRing(frame) {
  await frame.evaluate((domain) => AtlasWallet.mintAsset('self', domain, 'atlas.wearable.ring', undefined).then(() => refreshInventoryDisplay()), DOMAIN);
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
  return frame.locator('#bridgeOfferPreviewBox').innerText();
}
async function startSave(frame) {
  const card = cardByName(frame, 'Signet Ring').first();
  await openCardMenu(card);
  await card.locator('button[data-action="save-file"]').click();
  await waitForDialog(frame);
}
async function waitAsync(frame, fn, arg, timeout) {
  const end = Date.now() + (timeout || 15000);
  for (;;) {
    if (await frame.evaluate(fn, arg)) return;
    if (Date.now() > end) throw new Error('timed out waiting for ' + fn.toString().slice(0, 120));
    await new Promise((r) => setTimeout(r, 250));
  }
}
async function holdings(frame) {
  return frame.evaluate(() => AtlasWallet.getIdentity().then(async (id) => (await AtlasWallet.getWallet(id.publicKey)).map((e) => ({ id: e.credential.id, cls: e.credential.asset.class }))));
}
async function ledger(frame) {
  return frame.evaluate(() => AtlasWallet.getIdentity().then((id) => AtlasWallet.getAssetFiles(id.publicKey)));
}
async function backdate(frame, sourceId, ms) {
  await frame.evaluate(async ([sid, delta]) => {
    const id = await AtlasWallet.getIdentity();
    const l = await AtlasWallet.getAssetFiles(id.publicKey);
    const r = l.find((x) => x.sourceId === sid);
    r.at = new Date(Date.parse(r.at) - delta).toISOString();
    await AtlasWallet.saveAssetFiles(id.publicKey, l);
  }, [sourceId, ms]);
}
async function claimFileAsBob(bob, file) {
  return bob.frame.evaluate((f) => AtlasWallet.claimAssetFile(f).then((c) => ({ ok: true, owner: c.owner.publicKey })).catch((e) => ({ ok: false, code: e.code, message: e.message })), file);
}
async function pendingFile(frame, sourceId) {
  const l = await ledger(frame);
  return l.find((r) => r.sourceId === sourceId && r.state === 'pending' && r.file) || null;
}
async function statusText(frame) {
  return frame.locator('#status').innerText().catch(() => '');
}

(async () => {
  console.log('SETUP: isolated issuer-server on port ' + PORT + ' with fileTransfer enabled');
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.cpSync(path.join(REPO, 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  manifest.domain = DOMAIN;
  manifest.chat = false;
  manifest.calendar = false;
  manifest.tradingStation = false;
  manifest.fileTransfer = { classes: [RING] };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
  await startIssuer();

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
    const aliceCtx = await launch('alice');
    let alice = await openOverlay(aliceCtx, 'Alice');
    const bob = await openOverlay(await launch('bob'), 'Bob');
    const aliceKey = await createIdentity(alice.frame, 'recovery-test-password-a');
    await createIdentity(bob.frame, 'recovery-test-password-b');
    await installFaults(alice.frame);

    console.log('STEP 1: a lost reply is recovered inside the same click');
    await mintRing(alice.frame);
    await alice.frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length >= 1, { timeout: 15000 });
    const ring1 = (await holdings(alice.frame)).find((h) => h.cls === RING);
    await setFault(alice.frame, 'export', 'drop-reply');
    await startSave(alice.frame);
    const [download1] = await Promise.all([alice.page.waitForEvent('download'), alice.frame.locator('#bridgeOfferPreviewClaimBtn').click()]);
    const file1Path = path.join(TMP, 'file1.json');
    await download1.saveAs(file1Path);
    const file1 = JSON.parse(fs.readFileSync(file1Path, 'utf8'));
    assert(file1.supersedes === ring1.id, 'the downloaded file should be the export of the ring: ' + JSON.stringify(file1.supersedes));
    await alice.frame.waitForFunction(() => !document.getElementById('pendingExportsSection').hidden, { timeout: 15000 });
    assert((await holdings(alice.frame)).every((h) => h.cls !== RING), 'the ring should have left the wallet');
    const rec1 = await pendingFile(alice.frame, ring1.id);
    assert(rec1 && rec1.fileId === file1.id && !rec1.credential, 'the ledger should hold the pending export without the old copy: ' + JSON.stringify(rec1 && Object.keys(rec1)));
    assert(exportRecords().length === 1 && exportRecords()[0].state === 'pending', 'the issuer should hold exactly one pending export');
    const bobClaim1 = await claimFileAsBob(bob, file1);
    assert(bobClaim1.ok, 'Bob should be able to claim: ' + JSON.stringify(bobClaim1));
    console.log('PASS: reply lost, file recovered in the same click, ring gone from the wallet, Bob claimed it');

    console.log('STEP 2: a lost reply with the issuer unreachable leaves an interrupted entry, then "Check again" settles it');
    await mintRing(alice.frame);
    await alice.frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length >= 1, { timeout: 15000 });
    const ring2 = (await holdings(alice.frame)).find((h) => h.cls === RING);
    await setFault(alice.frame, 'export', 'drop-reply');
    await setFault(alice.frame, 'recover', 'unreachable');
    await startSave(alice.frame);
    await alice.frame.locator('#bridgeOfferPreviewClaimBtn').click();
    await alice.frame.waitForFunction(() => !document.getElementById('bridgeOfferPreviewModal').classList.contains('active'), { timeout: 15000 });
    await alice.frame.waitForFunction(() => /was lost/.test(document.getElementById('status').textContent), { timeout: 5000 });
    assert((await holdings(alice.frame)).some((h) => h.id === ring2.id), 'the ring must stay in the wallet until the issuer confirms');
    const listText = await alice.frame.locator('#pendingExportsList').innerText();
    assert(/save interrupted/.test(listText) && /Check again/.test(listText), 'expected an interrupted entry with a retry button: ' + listText);
    const l2 = (await ledger(alice.frame)).find((r) => r.sourceId === ring2.id);
    assert(l2 && l2.state === 'interrupted' && l2.credential && l2.credential.id === ring2.id, 'expected an interrupted record holding the original: ' + JSON.stringify(l2 && l2.state));
    assert(exportRecords().filter((r) => r.originalId === ring2.id)[0].state === 'pending', 'the issuer did finish the export');
    // Saving the same ring again is refused while this is unsettled.
    const again = await alice.frame.evaluate((id) => AtlasWallet.exportAssetToFile(id).then(() => 'saved', (e) => e.message), ring2.id);
    assert(/still being settled/.test(again), 'a second save of the same ring must be refused, got ' + again);
    await stopIssuer();
    await startIssuer();
    await setFault(alice.frame, 'recover', null);
    await alice.frame.locator('#pendingExportsList button[data-action="pe-retry"]').click();
    await waitAsync(alice.frame, async (id) => { const i = await AtlasWallet.getIdentity(); return (await AtlasWallet.getAssetFiles(i.publicKey)).some((r) => r.sourceId === id && r.state === 'pending' && r.file) && !(await AtlasWallet.getWallet(i.publicKey)).some((e) => e.credential.id === id); }, ring2.id, 15000);
    assert((await holdings(alice.frame)).every((h) => h.id !== ring2.id), 'the ring should now have left the wallet');
    const rec2 = await pendingFile(alice.frame, ring2.id);
    assert(rec2 && !rec2.credential, 'the export should now be pending with its file');
    const bobClaim2 = await claimFileAsBob(bob, rec2.file);
    assert(bobClaim2.ok, 'Bob should be able to claim the recovered file: ' + JSON.stringify(bobClaim2));
    console.log('PASS: interrupted entry kept the ring, survived an issuer restart, "Check again" finished it');

    console.log('STEP 3: an interrupted export is finished by itself when the wallet is opened again');
    await mintRing(alice.frame);
    await alice.frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length >= 1, { timeout: 15000 });
    const ring3 = (await holdings(alice.frame)).find((h) => h.cls === RING);
    await setFault(alice.frame, 'export', 'drop-reply');
    await setFault(alice.frame, 'recover', 'unreachable');
    await startSave(alice.frame);
    await alice.frame.evaluate(() => { document.getElementById('status').textContent = ''; });
    await alice.frame.locator('#bridgeOfferPreviewClaimBtn').click();
    await alice.frame.waitForFunction(() => /was lost/.test(document.getElementById('status').textContent), { timeout: 15000 });
    assert((await ledger(alice.frame)).find((r) => r.sourceId === ring3.id).state === 'interrupted', 'expected an interrupted record');
    await alice.page.close();
    alice = await openOverlay(aliceCtx, 'Alice (reopened)');
    const unlocked = await alice.frame.evaluate(() => AtlasWallet.getIdentity().then((i) => !!i));
    assert(unlocked, 'the wallet should still be unlocked for the new page');
    await alice.frame.locator('#walletBtn').click();
    await waitAsync(alice.frame, async (id) => { const i = await AtlasWallet.getIdentity(); return (await AtlasWallet.getAssetFiles(i.publicKey)).some((r) => r.sourceId === id && r.state === 'pending' && r.file); }, ring3.id, 20000);
    assert((await holdings(alice.frame)).every((h) => h.id !== ring3.id), 'the ring should have left the wallet without any click');
    await installFaults(alice.frame);
    console.log('PASS: reopening the wallet settled it automatically');

    console.log('STEP 4: an answer that arrives but cannot be stored is settled the same way');
    await mintRing(alice.frame);
    await alice.frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length >= 1, { timeout: 15000 });
    const ring4 = (await holdings(alice.frame)).find((h) => h.cls === RING);
    await setFault(alice.frame, 'export', 'fail-save');
    await setFault(alice.frame, 'recover', 'unreachable');
    await startSave(alice.frame);
    await alice.frame.evaluate(() => { document.getElementById('status').textContent = ''; });
    await alice.frame.locator('#bridgeOfferPreviewClaimBtn').click();
    await alice.frame.waitForFunction(() => /was lost/.test(document.getElementById('status').textContent), { timeout: 15000 });
    const l4 = (await ledger(alice.frame)).find((r) => r.sourceId === ring4.id);
    assert(l4 && l4.state === 'interrupted', 'expected an interrupted record after the failed save, got ' + (l4 && l4.state));
    assert((await holdings(alice.frame)).some((h) => h.id === ring4.id), 'the ring must not leave the wallet when its file was not stored');
    await setFault(alice.frame, 'export', null);
    await setFault(alice.frame, 'recover', null);
    const settled4 = await alice.frame.evaluate(() => AtlasWallet.recoverInterruptedExports({ auto: false }));
    assert(settled4.some((r) => r.sourceId === ring4.id && r.outcome === 'recovered'), 'expected the export to be recovered, got ' + JSON.stringify(settled4));
    assert(await pendingFile(alice.frame, ring4.id), 'the export should now be pending with its file');
    console.log('PASS: failed local save left an interrupted record, recovery stored the file');

    console.log('STEP 5: a clear refusal leaves nothing behind');
    await mintRing(alice.frame);
    await alice.frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length >= 1, { timeout: 15000 });
    const ring5 = (await holdings(alice.frame)).find((h) => h.cls === RING);
    await setFault(alice.frame, 'export', 'refuse');
    await startSave(alice.frame);
    await alice.frame.locator('#bridgeOfferPreviewClaimBtn').click();
    await alice.frame.waitForFunction(() => /refused by the test issuer/.test(document.getElementById('bridgeOfferPreviewStatus').textContent), { timeout: 10000 });
    assert(!(await ledger(alice.frame)).some((r) => r.sourceId === ring5.id), 'a refusal must not leave a record');
    assert((await holdings(alice.frame)).some((h) => h.id === ring5.id), 'the ring should still be in the wallet');
    await alice.frame.locator('#bridgeOfferPreviewDismissBtn').click();
    await setFault(alice.frame, 'export', null);
    console.log('PASS: refusal left no record and kept the ring');

    console.log('STEP 6: a request that never reached the issuer is only believed once it is old enough');
    await setFault(alice.frame, 'export', 'unreachable');
    await startSave(alice.frame);
    await alice.frame.evaluate(() => { document.getElementById('status').textContent = ''; });
    await alice.frame.locator('#bridgeOfferPreviewClaimBtn').click();
    await alice.frame.waitForFunction(() => /was lost/.test(document.getElementById('status').textContent), { timeout: 15000 });
    assert((await ledger(alice.frame)).find((r) => r.sourceId === ring5.id).state === 'interrupted', 'expected an interrupted record');
    await setFault(alice.frame, 'export', null);
    await alice.frame.locator('#pendingExportsList button[data-action="pe-retry"]').click();
    await alice.frame.waitForFunction(() => /Checking again shortly/.test(document.querySelector('#pendingExportsList .pe-status').textContent), { timeout: 10000 });
    assert((await ledger(alice.frame)).some((r) => r.sourceId === ring5.id && r.state === 'interrupted'), 'a young record must not be dropped on the issuer\'s say-so');
    await backdate(alice.frame, ring5.id, 3 * 60 * 1000);
    await alice.frame.locator('#pendingExportsList button[data-action="pe-retry"]').click();
    await alice.frame.waitForFunction(() => document.getElementById('pendingExportsList').querySelectorAll('[data-action="pe-retry"]').length === 0, { timeout: 10000 });
    assert(!(await ledger(alice.frame)).some((r) => r.sourceId === ring5.id), 'the record should be gone');
    assert((await holdings(alice.frame)).some((h) => h.id === ring5.id), 'the ring should still be in the wallet');
    await startSave(alice.frame);
    const [download6] = await Promise.all([alice.page.waitForEvent('download'), alice.frame.locator('#bridgeOfferPreviewClaimBtn').click()]);
    assert(/\.atlas-asset\.json$/.test(download6.suggestedFilename()), 'the ring should now save normally');
    console.log('PASS: kept until old enough, then dropped with the ring in place, and the ring then saved normally');

    console.log('STEP 7: someone else claimed the file while the wallet was in the dark');
    await mintRing(alice.frame);
    await alice.frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length >= 1, { timeout: 15000 });
    const ring7 = (await holdings(alice.frame)).find((h) => h.cls === RING);
    await setFault(alice.frame, 'export', 'drop-reply');
    await setFault(alice.frame, 'recover', 'unreachable');
    await startSave(alice.frame);
    await alice.frame.evaluate(() => { document.getElementById('status').textContent = ''; });
    await alice.frame.locator('#bridgeOfferPreviewClaimBtn').click();
    await alice.frame.waitForFunction(() => /was lost/.test(document.getElementById('status').textContent), { timeout: 15000 });
    // The file reaches Bob by some other route: the owner's own signed recovery request, made outside the wallet UI.
    const stolen = await alice.frame.evaluate(async ([id, base]) => {
      const c = await (await window.__realFetch(base + '/atlas/asset/recover-file-export-challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentialId: id }) })).json();
      const payload = { credentialId: id, action: 'recover-file-export', challenge: c.challenge };
      const proof = await AtlasWallet.signWithSelf(payload);
      const r = await window.__realFetch(base + '/atlas/asset/recover-file-export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intent: { payload, proof } }) });
      return (await r.json()).file;
    }, [ring7.id, 'http://' + DOMAIN]);
    assert(stolen && stolen.supersedes === ring7.id, 'expected to obtain the file');
    assert((await claimFileAsBob(bob, stolen)).ok, 'Bob should claim it');
    await setFault(alice.frame, 'recover', null);
    await alice.frame.locator('#pendingExportsList button[data-action="pe-retry"]').click();
    await waitAsync(alice.frame, async (id) => { const i = await AtlasWallet.getIdentity(); return (await AtlasWallet.getAssetFiles(i.publicKey)).some((r) => r.sourceId === id && r.state === 'claimed-by-other'); }, ring7.id, 15000);
    assert((await holdings(alice.frame)).every((h) => h.id !== ring7.id), 'the revoked original should have been removed');
    assert(!(await ledger(alice.frame)).find((r) => r.sourceId === ring7.id).credential, 'the settled record should not keep the old copy');
    console.log('PASS: reported as claimed by someone else, original removed');

    console.log('\nALL ASSET FILE WALLET RECOVERY CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    for (const c of contexts) await c.close().catch(() => {});
    await stopIssuer();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (err) {}
    process.exit(process.exitCode || 0);
  }
})();
