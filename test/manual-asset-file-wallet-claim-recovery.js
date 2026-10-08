// Manual check for the wallet side of recovering an interrupted claim of a
// transfer file (SPEC.md §13.5.2). The issuer side is covered by
// manual-asset-file-claim-recovery.js; this drives the real wallet in real
// Chrome against an isolated issuer-server and breaks the connection by
// replacing fetch() in the claiming wallet's page:
//   drop-reply   the claim reaches the issuer and is committed, but the
//                wallet never sees the answer
//   unreachable  the claim never leaves the wallet
//   slow         answers come back alternately fast and slow, so simultaneous
//                attempts finish one after another
//   wrong-owner  the answer carries a credential that is not Bob's
//   fail-save    the answer arrives but storing the item in the wallet fails
//
// Two wallets: Alice exports rings to files, Bob claims them.
//
// Checks:
//   1. A lost reply leaves a "claim interrupted" entry and no item; opening
//      the same file says the claim is being finished, not that it was taken;
//      "Check again" adds exactly the item the issuer minted, once.
//   2. An interrupted claim is finished by itself when the wallet is opened
//      again, with nothing clicked.
//   3. An answer that arrives but cannot be stored is settled the same way,
//      and two settle attempts at once add the item once.
//   4. If someone else claimed the file while the wallet was in the dark,
//      the entry is removed and nothing is added.
//   5. After the issuer's replay window only a receipt remains: no item, an
//      entry that says so, and a Dismiss that removes it.
//   6. A claim that is simply refused leaves no entry behind.
//   7. An answer carrying someone else's credential is not accepted.
//   8. A claim settled while "Re-verify wallet" is still checking is not
//      lost when that check writes the wallet back.
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
const PORT = 8251; // isolated, distinct from every other manual-*.js test
const DOMAIN = 'localhost:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-asset-file-wallet-claim-recovery-'));
const DOCROOT_DIR = path.join(TMP, 'docroot');
const STATE_DIR = path.join(TMP, 'state');
const MANIFEST = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');
const CLAIMS_STORE = path.join(STATE_DIR, 'atlas-file-claims-store.json');
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
function claimRecords() {
  return fs.existsSync(CLAIMS_STORE) ? JSON.parse(fs.readFileSync(CLAIMS_STORE, 'utf8')).claims : {};
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

// Replaces fetch() in the wallet page. `window.__fault.claim` is a mode.
async function installFaults(frame) {
  await frame.evaluate(() => {
    window.__fault = { claim: null };
    window.__failWalletOnce = false;
    const real = window.fetch.bind(window);
    window.__realFetch = real;
    window.__slowVerifyMs = 0;
    window.fetch = async (url, opts) => {
      if (window.__slowVerifyMs && String(url).includes('/.well-known/atlas-key.json')) await new Promise((x) => setTimeout(x, window.__slowVerifyMs));
      const mode = String(url).includes('/atlas/asset/claim-from-file') ? window.__fault.claim : null;
      if (mode === 'drop-reply') { await real(url, opts); throw new TypeError('Failed to fetch'); }
      if (mode === 'slow') { const r = await real(url, opts); window.__n = (window.__n || 0) + 1; await new Promise((x) => setTimeout(x, window.__n % 2 ? 40 : 700)); return r; }
      if (mode === 'wrong-owner') { const r = await real(url, opts); const body = await r.json(); if (body.credential) body.credential.owner = { publicKey: 'AAAA' }; return new Response(JSON.stringify(body), { status: r.status, headers: { 'Content-Type': 'application/json' } }); }
      if (mode === 'unreachable') throw new TypeError('Failed to fetch');
      if (mode === 'refuse') return new Response(JSON.stringify({ error: 'refused by the test issuer', code: 'not-claimable' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      if (mode === 'fail-save') { const r = await real(url, opts); window.__failWalletOnce = true; return r; }
      return real(url, opts);
    };
    const realSet = chrome.storage.local.set.bind(chrome.storage.local);
    chrome.storage.local.set = (items, cb) => {
      if (window.__failWalletOnce && items && Object.prototype.hasOwnProperty.call(items, 'atlasWallets')) {
        window.__failWalletOnce = false;
        return Promise.reject(new Error('simulated storage failure'));
      }
      return realSet(items, cb);
    };
  });
}
async function setFault(frame, mode) {
  await frame.evaluate((m) => { window.__fault.claim = m; }, mode);
}

async function mintRing(frame) {
  await frame.evaluate((domain) => AtlasWallet.mintAsset('self', domain, 'atlas.wearable.ring', undefined).then(() => refreshInventoryDisplay()), DOMAIN);
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

// Alice saves a fresh ring to a file and returns the file.
async function newFile(alice) {
  await mintRing(alice.frame);
  await waitAsync(alice.frame, async () => { const i = await AtlasWallet.getIdentity(); return (await AtlasWallet.getWallet(i.publicKey)).some((e) => e.credential.asset.class === 'atlas.wearable.ring'); });
  const ring = (await holdings(alice.frame)).find((h) => h.cls === RING);
  return alice.frame.evaluate((id) => AtlasWallet.exportAssetToFile(id), ring.id);
}
async function bobClaim(bob, file) {
  return bob.frame.evaluate((f) => AtlasWallet.claimAssetFile(f).then((c) => ({ ok: true, id: c.id })).catch((e) => ({ ok: false, code: e.code, interrupted: !!e.interrupted, message: e.message, receipt: e.receipt || null })), file);
}
async function claimingRecords(frame) {
  return (await ledger(frame)).filter((r) => r.direction === 'claiming');
}
async function ringsHeld(frame) {
  return (await holdings(frame)).filter((h) => h.cls === RING);
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
    const bobCtx = await launch('bob');
    const alice = await openOverlay(await launch('alice'), 'Alice');
    let bob = await openOverlay(bobCtx, 'Bob');
    await createIdentity(alice.frame, 'claim-recovery-password-a');
    const bobKey = await createIdentity(bob.frame, 'claim-recovery-password-b');
    await installFaults(bob.frame);

    console.log('STEP 1: a lost reply leaves an interrupted entry; "Check again" adds the item once');
    const file1 = await newFile(alice);
    await setFault(bob.frame, 'drop-reply');
    const r1 = await bobClaim(bob, file1);
    assert(!r1.ok && r1.interrupted, 'the claim should report an interrupted state, got ' + JSON.stringify(r1));
    assert((await ringsHeld(bob.frame)).length === 0, 'no item may be in the wallet before the issuer confirms');
    let recs = await claimingRecords(bob.frame);
    assert(recs.length === 1 && recs[0].fileId === file1.id && recs[0].state === 'interrupted' && recs[0].file && recs[0].file.id === file1.id, 'expected one interrupted claim record holding the file: ' + JSON.stringify(recs.map((r) => r.state)));
    const issuerRec1 = claimRecords()[file1.id];
    assert(issuerRec1 && issuerRec1.claimantPublicKey === bobKey, 'the issuer did commit the claim for Bob');
    const inspected = await bob.frame.evaluate((f) => AtlasWallet.inspectAssetFile(JSON.stringify(f)).then((r) => ({ relation: r.relation, canFinishClaim: r.canFinishClaim, canClaim: r.canClaim })), file1);
    assert(inspected.relation === 'claim-interrupted' && inspected.canFinishClaim && !inspected.canClaim, 'opening the file should offer to finish the claim, got ' + JSON.stringify(inspected));
    await bob.frame.locator('#walletBtn').click();
    await bob.frame.locator('#walletBtn').click();
    await bob.frame.waitForFunction(() => /claim interrupted/.test(document.getElementById('pendingExportsList').innerText), { timeout: 15000 });
    await setFault(bob.frame, null);
    await bob.frame.locator('#pendingExportsList button[data-action="cl-retry"]').click();
    await waitAsync(bob.frame, async () => { const i = await AtlasWallet.getIdentity(); return (await AtlasWallet.getWallet(i.publicKey)).some((e) => e.credential.asset.class === 'atlas.wearable.ring'); }, null, 15000);
    const held1 = await ringsHeld(bob.frame);
    assert(held1.length === 1 && held1[0].id === issuerRec1.mintedId, 'the wallet should hold exactly the item the issuer minted');
    assert((await claimingRecords(bob.frame)).length === 0, 'the claim record should be gone');
    assert((await ledger(bob.frame)).filter((r) => r.direction === 'claimed' && r.fileId === file1.id).length === 1, 'one claimed entry expected');
    console.log('PASS: item added once, same id the issuer minted, record cleared');

    console.log('STEP 2: an interrupted claim is finished by itself when the wallet is opened again');
    const file2 = await newFile(alice);
    await setFault(bob.frame, 'unreachable');
    const r2 = await bobClaim(bob, file2);
    assert(!r2.ok && r2.interrupted, 'expected an interrupted claim, got ' + JSON.stringify(r2));
    assert(!claimRecords()[file2.id], 'the issuer never saw this claim');
    await bob.page.close();
    bob = await openOverlay(bobCtx, 'Bob (reopened)');
    await bob.frame.locator('#walletBtn').click();
    await waitAsync(bob.frame, async (id) => { const i = await AtlasWallet.getIdentity(); return (await AtlasWallet.getAssetFiles(i.publicKey)).some((r) => r.direction === 'claimed' && r.fileId === id); }, file2.id, 20000);
    assert((await ringsHeld(bob.frame)).length === 2, 'Bob should now hold both rings');
    assert((await claimingRecords(bob.frame)).length === 0, 'the claim record should be gone');
    await installFaults(bob.frame);
    console.log('PASS: reopening the wallet settled it automatically');

    console.log('STEP 3: an answer that cannot be stored is settled, and two attempts at once add the item once');
    const file3 = await newFile(alice);
    await setFault(bob.frame, 'fail-save');
    const r3 = await bobClaim(bob, file3);
    assert(!r3.ok, 'storing the item failed, so the claim cannot have reported success: ' + JSON.stringify(r3));
    assert((await ringsHeld(bob.frame)).length === 2, 'the failed save must not add the item');
    assert((await claimingRecords(bob.frame)).length === 1, 'the claim must stay recorded');
    await setFault(bob.frame, 'slow');
    const both = await bob.frame.evaluate((id) => Promise.all([1, 2, 3, 4].map(() => AtlasWallet.recoverInterruptedClaim(id))).then((rs) => rs.map((r) => r.outcome)), file3.id);
    await setFault(bob.frame, null);
    assert(both.every((o) => o === 'claimed'), 'both attempts should report the claim, got ' + both.join(','));
    assert((await ringsHeld(bob.frame)).length === 3, 'exactly one more item expected, Bob holds ' + (await ringsHeld(bob.frame)).length);
    assert((await ledger(bob.frame)).filter((r) => r.direction === 'claimed' && r.fileId === file3.id).length === 1, 'one claimed entry expected');
    console.log('PASS: settled once, however many attempts');

    console.log('STEP 4: someone else claimed the file while the wallet was in the dark');
    const file4 = await newFile(alice);
    await setFault(bob.frame, 'unreachable');
    assert((await bobClaim(bob, file4)).interrupted, 'expected an interrupted claim');
    const aliceClaim = await alice.frame.evaluate((f) => AtlasWallet.claimAssetFile(f).then(() => 'ok', (e) => e.message), file4);
    assert(aliceClaim === 'ok', 'Alice should be able to claim her own file back: ' + aliceClaim);
    await setFault(bob.frame, null);
    const s4 = await bob.frame.evaluate((id) => AtlasWallet.recoverInterruptedClaim(id), file4.id);
    assert(s4.outcome === 'claimed-by-other', 'expected claimed-by-other, got ' + JSON.stringify(s4));
    assert((await claimingRecords(bob.frame)).length === 0 && (await ringsHeld(bob.frame)).length === 3, 'nothing added, record removed');
    console.log('PASS: reported as claimed by someone else, nothing added');

    console.log('STEP 5: after the replay window only a receipt remains');
    const file5 = await newFile(alice);
    await setFault(bob.frame, 'drop-reply');
    assert((await bobClaim(bob, file5)).interrupted, 'expected an interrupted claim');
    await setFault(bob.frame, null);
    const doc = JSON.parse(fs.readFileSync(CLAIMS_STORE, 'utf8'));
    doc.claims[file5.id].claimedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(CLAIMS_STORE, JSON.stringify(doc, null, 2));
    const other = await newFile(alice);
    assert((await alice.frame.evaluate((f) => AtlasWallet.claimAssetFile(f).then(() => 'ok', (e) => e.message), other)) === 'ok', 'a later claim should work');
    assert(!claimRecords()[file5.id].minted, 'the issuer should have dropped the stored credential');
    const s5 = await bob.frame.evaluate((id) => AtlasWallet.recoverInterruptedClaim(id), file5.id);
    assert(s5.outcome === 'receipt-only' && s5.receipt.mintedId === claimRecords()[file5.id].mintedId, 'expected a receipt, got ' + JSON.stringify(s5));
    assert((await ringsHeld(bob.frame)).length === 3, 'no item can be added without the credential');
    await bob.frame.locator('#walletBtn').click();
    await bob.frame.locator('#walletBtn').click();
    await bob.frame.waitForFunction(() => /claimed, credential not kept/.test(document.getElementById('pendingExportsList').innerText), { timeout: 15000 });
    const again5 = await bobClaim(bob, file5);
    assert(!again5.ok && again5.code === 'already-claimed' && again5.receipt, 'claiming again should show the receipt, got ' + JSON.stringify(again5));
    await bob.frame.locator('#pendingExportsList button[data-action="cl-dismiss"]').click();
    await bob.frame.waitForFunction(() => !/credential not kept/.test(document.getElementById('pendingExportsList').innerText), { timeout: 10000 });
    assert((await claimingRecords(bob.frame)).length === 0, 'dismissed');
    console.log('PASS: receipt shown, no item invented, entry dismissable');

    console.log('STEP 6: a refused claim leaves nothing behind');
    const file6 = await newFile(alice);
    await setFault(bob.frame, 'refuse');
    const r6 = await bobClaim(bob, file6);
    assert(!r6.ok && !r6.interrupted && /refused by the test issuer/.test(r6.message), 'expected the refusal, got ' + JSON.stringify(r6));
    assert((await claimingRecords(bob.frame)).length === 0, 'a refusal must not leave a record');
    await setFault(bob.frame, null);
    assert((await bobClaim(bob, file6)).ok, 'the file is still claimable after a refusal that never reached the issuer');
    console.log('PASS: refusal left no record');

    console.log('STEP 7: an answer carrying someone else\'s credential is not accepted');
    const file7 = await newFile(alice);
    await setFault(bob.frame, 'wrong-owner');
    const r7 = await bobClaim(bob, file7);
    assert(!r7.ok && r7.interrupted, 'a credential for another key must not be taken as the answer, got ' + JSON.stringify(r7));
    assert((await ringsHeld(bob.frame)).length === 4, 'Bob must not hold anything new from it');
    await setFault(bob.frame, null);
    assert((await bob.frame.evaluate((id) => AtlasWallet.recoverInterruptedClaim(id), file7.id)).outcome === 'claimed', 'a good answer settles it');
    assert((await ringsHeld(bob.frame)).length === 5, 'now the item is held');
    console.log('PASS: wrong credential refused, right one accepted on retry');

    console.log('STEP 8: a claim settled during a slow wallet re-verification is not lost');
    const file8 = await newFile(alice);
    await setFault(bob.frame, 'drop-reply');
    assert((await bobClaim(bob, file8)).interrupted, 'expected an interrupted claim');
    await setFault(bob.frame, null);
    const held8 = (await ringsHeld(bob.frame)).length;
    await bob.frame.evaluate(() => { window.__slowVerifyMs = 400; });
    const outcome8 = await bob.frame.evaluate(async (id) => {
      const verifying = AtlasWallet.reverifyAll();
      await new Promise((r) => setTimeout(r, 300));
      window.__slowVerifyMs = 0;
      const claim = await AtlasWallet.recoverInterruptedClaim(id);
      await verifying;
      return claim.outcome;
    }, file8.id);
    assert(outcome8 === 'claimed', 'the claim should settle, got ' + outcome8);
    assert((await ringsHeld(bob.frame)).length === held8 + 1, 'the claimed item must survive the re-verification, Bob holds ' + (await ringsHeld(bob.frame)).length + ' of ' + (held8 + 1));
    console.log('PASS: re-verification kept the newly claimed item');

    console.log('\nALL ASSET FILE WALLET CLAIM RECOVERY CHECKS PASSED');
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
