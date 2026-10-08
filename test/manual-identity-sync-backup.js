// Verifies "identity sync via chrome.storage.sync" (see wallet.js's own
// section comment for the full design) end to end: the already-encrypted
// local identity blob mirrors into chrome.storage.sync only once enabled,
// with no plaintext leakage; wrong password is rejected the same way
// enableIdentitySyncBackup's "prove you know it" check is meant to;
// restoring on a simulated fresh device (local + session storage cleared,
// sync storage left alone) recovers the SAME identity through the real
// onboarding UI, and only the identity — no wallet/friends/data comes
// back with it, unlike the file-based full backup elsewhere in this
// project; turning it off removes the synced copy; and creating a
// DIFFERENT identity on a device that still has sync enabled for an
// older one turns sync off automatically (reconcileIdentitySyncBackupOnIdentityChange)
// rather than silently overwriting the older identity's only synced copy.
//
// Unlike manual-auto-backup.js, this feature needs no native OS picker
// and no IndexedDB handle, so it's fully testable headlessly — including
// through the real onboarding UI, not just direct AtlasWallet calls.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PORT = 8148; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://' + NODE_DOMAIN;
const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-identity-sync-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-identity-sync-docroot-'));
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

  const userDataDir = path.resolve(__dirname, '.chrome-profile-identity-sync');
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

    console.log('STEP 1: fresh device — create identity A and seed a friend');
    await page.goto(NODE_BASE, { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.length > 0, null, { timeout: 10000 });

    const PASSWORD_A = 'identity-sync-test-password-a1';
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('onboardingChoiceScreen').classList.contains('active'), null, { timeout: 5000 });
    await frame.locator('#chooseNewBtn').click();
    await frame.waitForFunction(() => document.getElementById('createScreen').classList.contains('active'), null, { timeout: 5000 });
    await frame.locator('#newPasswordInput').fill(PASSWORD_A);
    await frame.locator('#newPasswordConfirmInput').fill(PASSWORD_A);
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });

    const step1 = await frame.evaluate(async () => {
      await AtlasWallet.addFriend('friend-public-key-xyz789', 'Identity Sync Friend');
      const identity = await AtlasWallet.getIdentity();
      return { publicKey: identity.publicKey };
    });
    console.log('PASS: identity A created and a friend seeded ->', step1.publicKey.slice(0, 24) + '…');

    console.log('STEP 2: identity sync starts out unset on a fresh device');
    const initial = await frame.evaluate(async () => ({
      settings: await AtlasWallet.getIdentitySyncBackupSettings(),
      available: await AtlasWallet.hasSyncedIdentityAvailable()
    }));
    assert(initial.settings.enabled === false, 'expected identity sync to start disabled');
    assert(initial.available === false, 'expected no synced identity to be available before anything is enabled');
    console.log('PASS: disabled and unavailable before opt-in');

    console.log('STEP 3: enabling with the WRONG password is rejected');
    const wrongPasswordResult = await frame.evaluate(async () => {
      try {
        await AtlasWallet.enableIdentitySyncBackup('not-the-real-password');
        return { rejected: false };
      } catch (err) {
        return { rejected: true, message: err.message };
      }
    });
    assert(wrongPasswordResult.rejected && wrongPasswordResult.message === 'Incorrect password.', 'expected a generic "Incorrect password." rejection, got: ' + JSON.stringify(wrongPasswordResult));
    console.log('PASS: wrong password rejected —', wrongPasswordResult.message);

    console.log('STEP 4: enabling with the correct password mirrors the identity blob, with no plaintext leakage');
    const enableResult = await frame.evaluate(async (password) => {
      await AtlasWallet.enableIdentitySyncBackup(password);
      const settings = await AtlasWallet.getIdentitySyncBackupSettings();
      const available = await AtlasWallet.hasSyncedIdentityAvailable();
      const raw = await chrome.storage.sync.get('atlasIdentitySyncBackup');
      return { settings, available, syncedBlob: raw.atlasIdentitySyncBackup };
    }, PASSWORD_A);
    assert(enableResult.settings.enabled === true, 'expected identity sync to be enabled after a correct-password call');
    assert(enableResult.available === true, 'expected hasSyncedIdentityAvailable() to be true right after enabling');
    assert(enableResult.syncedBlob && enableResult.syncedBlob.publicKey === step1.publicKey, 'synced blob is missing or tagged with the wrong public key');
    assert(enableResult.syncedBlob.salt && enableResult.syncedBlob.iv && enableResult.syncedBlob.ciphertext, 'synced blob is missing expected encrypted fields');
    const rawSyncedText = JSON.stringify(enableResult.syncedBlob);
    assert(!rawSyncedText.includes(PASSWORD_A), 'synced blob leaks the plaintext password');
    assert(!rawSyncedText.includes('Identity Sync Friend'), 'synced blob leaks data that was never supposed to be in scope — this channel is identity-only');
    console.log('PASS: synced blob is one opaque encrypted object, identity-only — no plaintext trace of the password or any wallet data');

    console.log('STEP 5: simulating a brand-new device — clearing LOCAL and SESSION storage, leaving SYNC alone');
    await frame.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
    });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 5000 });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('onboardingChoiceScreen').classList.contains('active'), null, { timeout: 5000 });
    console.log('PASS: fresh "device" state confirmed — routed back to onboarding');

    console.log('STEP 6: the onboarding screen itself offers the synced-identity restore box');
    const boxVisible = await frame.evaluate(() => {
      const box = document.getElementById('onboardingSyncedIdentityBox');
      return box && getComputedStyle(box).display !== 'none';
    });
    assert(boxVisible, 'expected the onboarding synced-identity box to be visible when a synced identity exists');
    console.log('PASS: onboarding screen surfaces the restore option');

    console.log('STEP 7: restoring through the real onboarding UI with the WRONG password fails, stays on onboarding');
    await frame.locator('#onboardingSyncedIdentityPasswordInput').fill('still-not-the-real-password');
    await frame.locator('#onboardingRestoreSyncedIdentityBtn').click();
    // The handler sets "Decrypting…" immediately, then the final error
    // text — wait past that transient state specifically, so this doesn't
    // assert on it by accident.
    await frame.waitForFunction(() => {
      const text = document.getElementById('onboardingSyncedIdentityStatus').textContent;
      return text.length > 0 && text !== 'Decrypting…';
    }, null, { timeout: 5000 });
    const wrongRestoreStatus = await frame.evaluate(() => document.getElementById('onboardingSyncedIdentityStatus').textContent);
    assert(wrongRestoreStatus === 'Incorrect password.', 'expected "Incorrect password." on the onboarding box, got: ' + wrongRestoreStatus);
    assert(await frame.evaluate(() => document.getElementById('onboardingChoiceScreen').classList.contains('active')), 'a failed restore should leave the onboarding screen active');
    console.log('PASS: wrong password on the real UI rejected, still on onboarding —', wrongRestoreStatus);

    console.log('STEP 8: restoring through the real onboarding UI with the CORRECT password recovers identity A only — no wallet/friend data');
    await frame.locator('#onboardingSyncedIdentityPasswordInput').fill(PASSWORD_A);
    await frame.locator('#onboardingRestoreSyncedIdentityBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
    const restore = await frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const friends = await AtlasWallet.getFriends();
      const syncSettings = await AtlasWallet.getIdentitySyncBackupSettings();
      return { publicKey: identity.publicKey, friendCount: friends.length, syncSettings };
    });
    assert(restore.publicKey === step1.publicKey, 'restored public key does not match original identity A: ' + restore.publicKey);
    assert(restore.friendCount === 0, 'expected NO friends to come back with an identity-only sync restore, got ' + restore.friendCount);
    assert(restore.syncSettings.enabled === true, 'restoreIdentityFromSync should leave sync enabled on this now-legitimate device, got: ' + JSON.stringify(restore.syncSettings));
    console.log('PASS: identity A recovered correctly through the real onboarding UI, with the data scope boundary intact (0 friends restored)');

    console.log('STEP 9: turning it off removes the synced copy');
    const disableResult = await frame.evaluate(async () => {
      await AtlasWallet.disableIdentitySyncBackup();
      return {
        settings: await AtlasWallet.getIdentitySyncBackupSettings(),
        available: await AtlasWallet.hasSyncedIdentityAvailable()
      };
    });
    assert(disableResult.settings.enabled === false, 'expected identity sync to be disabled after turning it off');
    assert(disableResult.available === false, 'expected the synced copy to be gone after turning it off');
    console.log('PASS: disabled, and the synced copy was actually removed, not just flagged off');

    console.log('STEP 10: a DIFFERENT identity replacing this one while sync is enabled turns sync off automatically, rather than overwriting');
    const mismatchResult = await frame.evaluate(async (passwordA) => {
      await AtlasWallet.enableIdentitySyncBackup(passwordA);
      const beforeNewIdentity = await AtlasWallet.getIdentitySyncBackupSettings();
      // A brand new identity becoming active on this device — same shape
      // as a reset-and-create-different-identity flow, without needing a
      // second exported file just to prove the mismatch guard works.
      await AtlasWallet.createIdentity('identity-sync-test-password-b1');
      const afterNewIdentity = await AtlasWallet.getIdentitySyncBackupSettings();
      const afterAvailable = await AtlasWallet.hasSyncedIdentityAvailable();
      return { beforeNewIdentity, afterNewIdentity, afterAvailable };
    }, PASSWORD_A);
    assert(mismatchResult.beforeNewIdentity.enabled === true, 'expected sync to be re-enabled for identity A just before creating the new one');
    assert(mismatchResult.afterNewIdentity.enabled === false, 'expected creating a DIFFERENT identity to turn sync off automatically (reconcile mismatch guard), got: ' + JSON.stringify(mismatchResult.afterNewIdentity));
    assert(mismatchResult.afterAvailable === false, 'expected the old identity\'s synced copy to be gone once the mismatch guard disabled it');
    console.log('PASS: reconcileIdentitySyncBackupOnIdentityChange correctly turned sync off instead of silently overwriting identity A\'s synced copy with identity B');

    console.log('\nALL IDENTITY SYNC BACKUP CHECKS PASSED');
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
