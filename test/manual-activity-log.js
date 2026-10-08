// Verifies the wallet activity log — see wallet.js's own "wallet
// activity log" section comment for the full design: a per-identity,
// encrypted-at-rest, newest-first feed of identity/security and
// asset/trade events, capped and included in full-backup export/restore
// like any other data family.
//
// Covers: identity creation logs an entry; minting an asset logs an entry
// on top of it (newest-first ordering); a password change logs an entry;
// exporting a full backup logs an entry; restoring that backup brings the
// PRIOR history back (not a blank log) and appends its own "restored"
// entry on top, in the right order; clearing the log actually empties it;
// and the real Settings/Wallet UI (Activity log category) renders what's
// there.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PORT = 8149; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://' + NODE_DOMAIN;
const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-activity-log-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-activity-log-docroot-'));
const EXT_PATH = path.resolve(__dirname, '..', 'extension');

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}

(async () => {
  console.log('SETUP: copying demo-domain-a into an isolated docroot and starting its own issuer-server instance on port ' + NODE_PORT);
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-a'), NODE_DOCROOT_DIR, { recursive: true });
  const nodeProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(NODE_PORT), ATLAS_DOMAIN: NODE_DOMAIN, ATLAS_STATE_DIR: NODE_STATE_DIR, ATLAS_DOCROOT: NODE_DOCROOT_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    nodeProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    nodeProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-server up on port ' + NODE_PORT);

  const userDataDir = path.resolve(__dirname, '.chrome-profile-activity-log');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox'
    ]
  });

  try {
    const page = await context.newPage();

    console.log('STEP 1: fresh device — create an identity; it should log its own creation');
    await page.goto(NODE_BASE, { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.length > 0, null, { timeout: 10000 });

    const PASSWORD_1 = 'activity-log-test-password-1';
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('onboardingChoiceScreen').classList.contains('active'), null, { timeout: 5000 });
    await frame.locator('#chooseNewBtn').click();
    await frame.waitForFunction(() => document.getElementById('createScreen').classList.contains('active'), null, { timeout: 5000 });
    await frame.locator('#newPasswordInput').fill(PASSWORD_1);
    await frame.locator('#newPasswordConfirmInput').fill(PASSWORD_1);
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });

    const afterCreate = await frame.evaluate(async () => AtlasWallet.getActivityLog());
    assert(afterCreate.length === 1, 'expected exactly one entry right after creating an identity, got ' + afterCreate.length);
    assert(afterCreate[0].text === 'Identity created', 'expected "Identity created", got: ' + JSON.stringify(afterCreate[0]));
    assert(afterCreate[0].type === 'identity', 'expected type "identity", got: ' + afterCreate[0].type);
    console.log('PASS: identity creation logged its own entry —', afterCreate[0].text);

    console.log('STEP 2: minting an asset logs a second entry, newest first, without disturbing the first');
    await frame.evaluate(async (domain) => {
      await AtlasWallet.mintAsset('self', domain, 'atlas.element.iron', 20);
    }, NODE_DOMAIN);
    const afterMint = await frame.evaluate(async () => AtlasWallet.getActivityLog());
    assert(afterMint.length === 2, 'expected two entries after a mint, got ' + afterMint.length);
    assert(afterMint[0].type === 'asset' && afterMint[0].text.indexOf('Minted 20 atlas.element.iron from ' + NODE_DOMAIN) === 0, 'unexpected newest entry after mint: ' + JSON.stringify(afterMint[0]));
    assert(afterMint[1].text === 'Identity created', 'expected the original entry to still be there, second from the top');
    console.log('PASS: newest-first ordering holds —', afterMint[0].text);

    console.log('STEP 3: changing the password logs an entry too');
    const PASSWORD_2 = 'activity-log-test-password-2';
    await frame.evaluate(async (pwds) => {
      await AtlasWallet.changePassword(pwds.oldPw, pwds.newPw);
    }, { oldPw: PASSWORD_1, newPw: PASSWORD_2 });
    const afterPwChange = await frame.evaluate(async () => AtlasWallet.getActivityLog());
    assert(afterPwChange.length === 3, 'expected three entries after a password change, got ' + afterPwChange.length);
    assert(afterPwChange[0].text === 'Wallet password changed', 'expected "Wallet password changed" on top, got: ' + JSON.stringify(afterPwChange[0]));
    console.log('PASS: password change logged —', afterPwChange[0].text);

    console.log('STEP 4: exporting a full backup logs its own entry, then restoring it brings the PRIOR history back plus a new "restored" entry on top');
    // exportFullBackup needs the seed phrase as a second factor, and this
    // test never captured the one shown once at STEP 1's transient reveal
    // screen — simplest is a fresh identity here (whose seed phrase
    // createIdentity() hands straight back), which is just as valid for
    // what this step actually verifies: does export/restore touch the
    // activity log correctly. A brand-new public key has never been a key
    // in atlasActivityLog before, so its log starts clean on its own —
    // nothing to explicitly clear.
    const fresh = await frame.evaluate(async () => {
      const { publicKey, seedPhrase } = await AtlasWallet.createIdentity('activity-log-test-password-fresh');
      return { publicKey, seedPhrase };
    });
    const afterFreshCreate = await frame.evaluate(async () => AtlasWallet.getActivityLog());
    assert(afterFreshCreate.length === 1 && afterFreshCreate[0].text === 'Identity created', 'expected a clean single-entry log for the fresh identity, got: ' + JSON.stringify(afterFreshCreate));

    await frame.evaluate(async (domain) => {
      await AtlasWallet.mintAsset('self', domain, 'atlas.element.iron', 5);
    }, NODE_DOMAIN);
    const beforeExport = await frame.evaluate(async () => AtlasWallet.getActivityLog());
    assert(beforeExport.length === 2, 'expected 2 entries (create + mint) before export, got ' + beforeExport.length);

    const backupFile = await frame.evaluate(async (args) => {
      return AtlasWallet.exportFullBackup(args.password, args.seedPhrase);
    }, { password: 'activity-log-test-password-fresh', seedPhrase: fresh.seedPhrase });
    const afterExport = await frame.evaluate(async () => AtlasWallet.getActivityLog());
    assert(afterExport.length === 3, 'expected an export entry on top, got ' + afterExport.length);
    assert(afterExport[0].text === 'Full wallet backup exported to a file', 'expected the export entry on top, got: ' + JSON.stringify(afterExport[0]));
    console.log('PASS: export logged its own entry without disturbing the prior two —', afterExport[0].text);

    console.log('STEP 4b: simulating a fresh device (local+session cleared) and restoring — prior history should come back, plus a new entry on top');
    await frame.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
    });
    const restore = await frame.evaluate(async (args) => {
      const result = await AtlasWallet.importFullBackup(args.backupFile, args.password, args.seedPhrase);
      const log = await AtlasWallet.getActivityLog();
      return { result, log };
    }, { backupFile, password: 'activity-log-test-password-fresh', seedPhrase: fresh.seedPhrase });
    assert(restore.result.publicKey === fresh.publicKey, 'restored public key does not match the original fresh identity');
    // Only 3, not 4: buildBackupPayload() snapshots the activity log BEFORE
    // exportFullBackup logs its own "exported" entry (the snapshot has to
    // be taken before the file is actually written), so that entry is
    // correctly local to the ORIGINAL device only — same as any other
    // activity that happens after a snapshot is captured — and never
    // travels inside the file itself.
    assert(restore.log.length === 3, 'expected the 2 pre-export entries plus a new "restored" entry, got ' + restore.log.length + ': ' + JSON.stringify(restore.log));
    assert(restore.log[0].text === 'Restored full wallet backup from a backup file', 'expected the restore entry on top, got: ' + JSON.stringify(restore.log[0]));
    assert(restore.log[1].text === 'Minted 5 atlas.element.iron from ' + NODE_DOMAIN, 'expected the pre-export mint entry preserved second, got: ' + JSON.stringify(restore.log[1]));
    assert(restore.log[2].text === 'Identity created', 'expected the original creation entry preserved at the bottom, got: ' + JSON.stringify(restore.log[2]));
    console.log('PASS: restore preserved prior (pre-snapshot) history and appended its own entry on top, in the right order');

    console.log('STEP 5: clearing the log actually empties it');
    await frame.evaluate(async () => AtlasWallet.clearActivityLog());
    const afterClear = await frame.evaluate(async () => AtlasWallet.getActivityLog());
    assert(afterClear.length === 0, 'expected an empty log after clearing, got ' + afterClear.length);
    console.log('PASS: log cleared');

    console.log('STEP 6: the real Settings/Wallet UI (Activity log category) renders whatever is actually logged');
    await frame.evaluate(async (domain) => {
      await AtlasWallet.mintAsset('self', domain, 'atlas.element.iron', 1);
      await refreshInventoryDisplay();
    }, NODE_DOMAIN);
    await frame.locator('#walletTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    const activityCategoryToggle = frame.locator('.settings-category[data-category="activity-log"] .settings-category-toggle');
    await activityCategoryToggle.click();
    await frame.waitForFunction(() => {
      const list = document.getElementById('activityLogList');
      return list && list.querySelector('.info-card');
    }, null, { timeout: 5000 });
    const uiRowText = await frame.evaluate(() => document.querySelector('#activityLogList .info-card .name').textContent);
    assert(uiRowText.indexOf('Minted 1 atlas.element.iron') === 0, 'expected the UI to render the freshly-minted entry, got: ' + uiRowText);
    console.log('PASS: UI renders the current activity log —', uiRowText);

    console.log('\nALL ACTIVITY LOG CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
    nodeProc.kill();
    try { fs.rmSync(NODE_STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(NODE_DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
