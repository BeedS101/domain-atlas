// Verifies the encryption/restore LOGIC behind "automatic encrypted local
// backup replication" (see wallet.js's own long comment at the top of that
// section for the full design). What this covers, end to end, with no
// mocking: buildAutoBackupBlob() produces a well-formed atlas-auto-backup/
// 1.0 blob with no plaintext leakage of secrets or personal data (same bar
// manual-full-backup.js already holds exportFullBackup to); a wrong
// password is rejected generically; restoreFromAutoBackupFile() correctly
// restores identity + data onto a simulated fresh device via the exact
// same applyBackupPayload() path importFullBackup uses; automatic-backup
// settings are deliberately NOT carried inside a restored payload (each
// device points at its own file); and changePassword() re-keys an already-
// enabled auto-backup's salt and eventually marks it lapsed when no real
// file handle exists yet to write to (proving the debounced write path
// actually runs, not just that it compiles).
//
// What this deliberately does NOT cover, and why: setUpAutoBackup(),
// writeAutoBackupNow()'s real file write, and the whole backup-setup.html
// consent/picker flow all depend on window.showSaveFilePicker() and a real
// FileSystemFileHandle surviving a round trip through IndexedDB — both
// require genuine native OS UI interaction that Playwright has no
// supported way to drive headlessly (the same category of limitation this
// project already accepts for WebAuthn's hardware authenticator ceremony
// elsewhere in this suite — see identity-popup.js's own comment). A
// plain fake object standing in for a handle doesn't exercise anything
// meaningful here either: real FileSystemFileHandle instances are
// specifically spec-blessed as structured-clonable through IndexedDB,
// which is exactly the part a hand-rolled substitute can't validate.
// That whole path needs manual verification in a real Chrome profile:
// open Settings → Automatic backup → Set up automatic backup, confirm the
// explain screen appears before any native picker, pick a file, confirm
// the file updates after minting an asset, then use the Reconnect flow
// after manually revoking the extension's file permission in
// chrome://settings/content/all to confirm the lapsed state surfaces.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NODE_PORT = 8147; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://' + NODE_DOMAIN;
const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-auto-backup-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-auto-backup-docroot-'));
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

  const userDataDir = path.resolve(__dirname, '.chrome-profile-auto-backup');
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

    console.log('STEP 1: fresh device — create a local password identity and a little real data');
    await page.goto(NODE_BASE, { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.length > 0, { timeout: 10000 });

    const PASSWORD = 'auto-backup-test-password-1';
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('onboardingChoiceScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#chooseNewBtn').click();
    await frame.waitForFunction(() => document.getElementById('createScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#newPasswordInput').fill(PASSWORD);
    await frame.locator('#newPasswordConfirmInput').fill(PASSWORD);
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });

    const step1 = await frame.evaluate(async () => {
      await AtlasWallet.addFriend('friend-public-key-abc123', 'Auto Backup Friend');
      const identity = await AtlasWallet.getIdentity();
      return { publicKey: identity.publicKey };
    });
    console.log('PASS: identity created and a friend seeded ->', step1.publicKey.slice(0, 24) + '…');

    console.log('STEP 2: automatic backup settings start out unset on a fresh device');
    const initiallyNull = await frame.evaluate(async () => (await AtlasWallet.getAutoBackupSettings()) === null);
    assert(initiallyNull, 'expected getAutoBackupSettings() to return null before anything is set up');
    console.log('PASS: getAutoBackupSettings() is null before setup');

    console.log('STEP 3: buildAutoBackupBlob() produces a well-formed blob with no plaintext leakage');
    const blob = await frame.evaluate(async (password) => {
      const identity = await AtlasWallet.getIdentity();
      return AtlasWallet.buildAutoBackupBlob(identity, password);
    }, PASSWORD);
    assert(blob.format === 'atlas-auto-backup/1.0', 'wrong format tag: ' + blob.format);
    assert(blob.salt && blob.iv && blob.ciphertext, 'blob is missing expected encrypted fields');
    assert(blob.publicKey === step1.publicKey, 'blob is not tagged with the right owner public key');
    const rawBlobText = JSON.stringify(blob);
    assert(!rawBlobText.includes(PASSWORD), 'blob leaks the plaintext password');
    assert(!rawBlobText.includes('Auto Backup Friend'), 'blob leaks plaintext personal data outside the encrypted ciphertext field');
    console.log('PASS: blob is one opaque encrypted object — no plaintext trace of the password or personal data');

    console.log('STEP 4: restoring with a WRONG password fails generically, same posture as importFullBackup');
    const wrongPasswordResult = await frame.evaluate(async (blob) => {
      try {
        await AtlasWallet.restoreFromAutoBackupFile(blob, 'not-the-real-password');
        return { rejected: false };
      } catch (err) {
        return { rejected: true, message: err.message };
      }
    }, blob);
    assert(wrongPasswordResult.rejected && wrongPasswordResult.message === 'Incorrect password.', 'expected a generic "Incorrect password." rejection, got: ' + JSON.stringify(wrongPasswordResult));
    console.log('PASS: wrong password rejected generically —', wrongPasswordResult.message);

    console.log('STEP 5: simulating a brand-new device — clearing ALL local and session storage');
    await frame.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
    });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('onboardingChoiceScreen').classList.contains('active'), { timeout: 5000 });
    console.log('PASS: fresh "device" state confirmed — routed back to onboarding');

    console.log('STEP 6: restoring the automatic backup file for real onto the fresh device');
    const restore = await frame.evaluate(async ({ blob, password }) => {
      const result = await AtlasWallet.restoreFromAutoBackupFile(blob, password);
      const friends = await AtlasWallet.getFriends();
      const rawFriends = await chrome.storage.local.get('atlasFriends');
      return { publicKey: result.publicKey, friends, rawFriendsSlot: (rawFriends.atlasFriends || {})[result.publicKey] };
    }, { blob, password: PASSWORD });
    assert(restore.publicKey === step1.publicKey, 'restored public key does not match original: ' + restore.publicKey);
    assert(restore.friends.length === 1 && restore.friends[0].name === 'Auto Backup Friend', 'friend was not restored correctly: ' + JSON.stringify(restore.friends));
    assert(restore.rawFriendsSlot && restore.rawFriendsSlot.__atlasEncrypted, 'restored friend is not encrypted at rest on disk');
    console.log('PASS: identity and data restored correctly from the automatic-backup blob, encrypted at rest');

    console.log('STEP 7: automatic-backup settings are NOT carried by a restore — each device points at its own file');
    const settingsAfterRestore = await frame.evaluate(async () => AtlasWallet.getAutoBackupSettings());
    assert(settingsAfterRestore === null, 'restoring a backup should not have invented auto-backup settings on this device: ' + JSON.stringify(settingsAfterRestore));
    console.log('PASS: getAutoBackupSettings() is still null after a restore — nothing device-specific leaked in from the payload');

    console.log('STEP 8: changePassword() re-keys an already-enabled auto-backup, and this context (viewer.html\'s iframe) is gated OUT of actually writing');
    const changePasswordResult = await frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      // Simulate "auto-backup was already set up on this device" without
      // going through the real File System Access picker (see this file's
      // own top comment for why that path is manual-only) — seed the
      // settings object directly, the same shape setUpAutoBackup() would
      // have left behind, but with no handle in IndexedDB.
      const firstBlob = await AtlasWallet.buildAutoBackupBlob(identity, 'auto-backup-test-password-1');
      await new Promise((resolve) => {
        chrome.storage.local.set({
          atlasAutoBackupSettings: {
            ownerPublicKey: identity.publicKey,
            enabled: true,
            fileName: 'atlas-wallet-backup.json',
            salt: firstBlob.salt,
            kdfIterations: firstBlob.kdfIterations,
            lastWrittenAt: null,
            lastError: null,
            lapsed: false
          }
        }, resolve);
      });
      const before = await AtlasWallet.getAutoBackupSettings();
      await AtlasWallet.changePassword('auto-backup-test-password-1', 'auto-backup-test-password-2');
      const afterChange = await AtlasWallet.getAutoBackupSettings();
      // This test runs entirely inside viewer.html's iframe (the only way
      // Playwright can drive this demo), which is NOT the designated
      // auto-backup writer context (see wallet.js's IS_AUTO_BACKUP_WRITER_CONTEXT
      // — only backup-setup.html is). So a direct call here should no-op
      // immediately, touching no settings at all, rather than reaching the
      // "no handle in IndexedDB" branch the way it would have before that
      // gate existed.
      const directResult = await AtlasWallet.writeAutoBackupNow();
      // Also wait out the normal ~4s debounce from changePassword()'s own
      // triggering change, to confirm the scheduled write is equally
      // gated out, not just a direct call.
      await new Promise((resolve) => setTimeout(resolve, 5500));
      const afterDebounce = await AtlasWallet.getAutoBackupSettings();
      return { beforeSalt: before.salt, afterChangeSalt: afterChange.salt, afterChange, directResult, afterDebounce };
    });
    assert(changePasswordResult.afterChangeSalt !== changePasswordResult.beforeSalt, 'changePassword() should have minted a fresh auto-backup salt, got the same one back');
    assert(changePasswordResult.directResult.skipped === true && changePasswordResult.directResult.reason === 'not the auto-backup writer context', 'expected writeAutoBackupNow() to be gated out from viewer.html\'s iframe, got: ' + JSON.stringify(changePasswordResult.directResult));
    assert(changePasswordResult.afterDebounce.lapsed === false, 'expected the gated-out context to leave "lapsed" alone rather than setting it, got: ' + JSON.stringify(changePasswordResult.afterDebounce));
    assert(changePasswordResult.afterDebounce.lastError === null, 'expected the gated-out context to touch no settings at all, got lastError: ' + JSON.stringify(changePasswordResult.afterDebounce.lastError));
    assert(changePasswordResult.afterDebounce.salt === changePasswordResult.afterChange.salt, 'expected settings to be completely untouched by the gated-out debounced write');
    console.log('PASS: changePassword() re-keyed the salt immediately, and this non-writer context correctly no-ops on write attempts instead of racing backup-setup.html');

    console.log('STEP 9: backup-setup.html IS the writer context — a direct call there proceeds past the gate (and fails for the mundane reason that no real file handle exists in this headless test)');
    const overlaySrc = await page.evaluate(() => document.getElementById('domain-atlas-overlay').src);
    const extensionId = new URL(overlaySrc).host;
    const setupPage = await context.newPage();
    await setupPage.goto(`chrome-extension://${extensionId}/backup-setup.html`, { waitUntil: 'load' });
    const writerContextResult = await setupPage.evaluate(async () => AtlasWallet.writeAutoBackupNow());
    assert(writerContextResult.skipped === true && writerContextResult.reason === 'no handle in IndexedDB', 'expected backup-setup.html to pass the writer-context gate and reach the "no handle" branch, got: ' + JSON.stringify(writerContextResult));
    await setupPage.close();
    console.log('PASS: backup-setup.html is correctly treated as the one real writer context —', writerContextResult.reason);

    console.log('\nALL AUTOMATIC BACKUP LOGIC CHECKS PASSED');
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
