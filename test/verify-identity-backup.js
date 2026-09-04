// Verifies the merged, password-protected identity's full lifecycle: the
// onboarding routing (new device -> choose new/import; known device, locked
// -> unlock; unlocked -> straight into the wallet), a real software keypair
// created and encrypted at rest under the password alone, session-scoped
// unlock via chrome.storage.session (lockable, and cleared by simulating a
// fresh device), and export/import protected by password + seed phrase
// COMBINED (not checked separately — see wallet.js's deriveAesKey for why).
// Also proves the security property the whole design is built around: a
// wrong password alone and a wrong seed phrase alone both fail import with
// the exact same generic message, so neither guess leaks anything about the
// other secret.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

function shot(name) {
  return path.resolve(__dirname, name);
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-identity-backup');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox'
    ]
  });

  try {
    const page = await context.newPage();

    console.log('STEP 1: visiting http://localhost:8001 and opening the wallet panel on a fresh device');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    await frame.waitForFunction(() => document.getElementById('onboardingChoiceScreen').classList.contains('active'), { timeout: 5000 });
    console.log('PASS: no identity on this device yet, routed straight to the new/import choice');

    console.log('STEP 2: password-mismatch validation on the create screen');
    await frame.locator('#chooseNewBtn').click();
    await frame.waitForFunction(() => document.getElementById('createScreen').classList.contains('active'), { timeout: 5000 });
    const PASSWORD = 'correct-horse-battery-staple-1';
    await frame.locator('#newPasswordInput').fill(PASSWORD);
    await frame.locator('#newPasswordConfirmInput').fill('a-different-password-entirely');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(
      () => document.getElementById('createScreenStatus').textContent === 'Passwords do not match.',
      { timeout: 5000 }
    );
    if (await frame.locator('#createScreen').getAttribute('class').then((c) => !c.includes('active'))) {
      throw new Error('Should still be on the create screen after a mismatch');
    }
    console.log('PASS: mismatched passwords rejected, stayed on the create screen');

    console.log('STEP 3: creating the identity for real and capturing the one-time 16-word seed phrase');
    await frame.locator('#newPasswordConfirmInput').fill(PASSWORD);
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    const seedPhrase = (await frame.locator('#seedPhraseText').textContent()).trim();
    if (seedPhrase.split(/\s+/).length !== 16) throw new Error('Expected a 16-word seed phrase, got: ' + seedPhrase);
    await page.screenshot({ path: shot('idb-01-seed-revealed.png') });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    const originalIdentityLabel = await frame.locator('#walletIdentity').textContent();
    if (!originalIdentityLabel.startsWith('Identity:')) throw new Error('Identity was not created: ' + originalIdentityLabel);
    console.log('PASS: identity created, 16-word seed phrase captured ->', originalIdentityLabel);

    console.log('STEP 4: locking the wallet, then reopening — should route to the unlock screen, not onboarding');
    await frame.locator('#settingsTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    // Settings categories are collapsed by default — open "Identity method" before using its lock button.
    await frame.locator('.settings-category[data-category="identity-method"] .settings-category-toggle').click();
    await frame.waitForFunction(() => document.querySelector('.settings-category[data-category="identity-method"]').classList.contains('open'), { timeout: 5000 });
    await frame.locator('#lockWalletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('unlockScreen').classList.contains('active'), { timeout: 5000 });
    console.log('PASS: identity exists on this device but is locked -> unlock screen (not onboarding)');

    console.log('STEP 5: unlocking with a WRONG password — must fail generically, must not unlock');
    await frame.locator('#unlockPasswordInput').fill('definitely-the-wrong-password');
    await frame.locator('#unlockBtn').click();
    await frame.waitForFunction(
      () => document.getElementById('unlockScreenStatus').textContent === 'Incorrect password.',
      { timeout: 10000 }
    );
    if (await frame.locator('#unlockScreen').getAttribute('class').then((c) => !c.includes('active'))) {
      throw new Error('Should still be on the unlock screen after a wrong password');
    }
    console.log('PASS: wrong password rejected, still locked');

    console.log('STEP 6: unlocking with the CORRECT password');
    await frame.locator('#unlockPasswordInput').fill(PASSWORD);
    await frame.locator('#unlockBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 10000 });
    const unlockedLabel = await frame.locator('#walletIdentity').textContent();
    if (unlockedLabel !== originalIdentityLabel) throw new Error('Unlocked identity does not match the original: ' + unlockedLabel + ' vs ' + originalIdentityLabel);
    console.log('PASS: unlocked with the correct password, same identity ->', unlockedLabel);

    console.log('STEP 7: export with the correct password but a malformed (too-short) seed phrase — distinct validation message');
    await frame.locator('#settingsTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    // Settings categories are collapsed by default — open "Identity backup" before using its export fields.
    await frame.locator('.settings-category[data-category="identity-backup"] .settings-category-toggle').click();
    await frame.waitForFunction(() => document.querySelector('.settings-category[data-category="identity-backup"]').classList.contains('open'), { timeout: 5000 });
    await frame.locator('#exportPasswordInput').fill(PASSWORD);
    await frame.locator('#exportSeedInput').fill('only two words');
    await frame.locator('#exportIdentityBtn').click();
    await frame.waitForFunction(
      () => document.getElementById('exportStatus').textContent === 'Export failed: Enter the full seed phrase you were shown when you created this identity.',
      { timeout: 10000 }
    );
    console.log('PASS: malformed seed phrase rejected with its own distinct message (not the generic import one)');

    console.log('STEP 8: exporting for real — password + seed phrase combined, one encrypted file');
    await frame.locator('#exportPasswordInput').fill(PASSWORD);
    await frame.locator('#exportSeedInput').fill(seedPhrase);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      frame.locator('#exportIdentityBtn').click()
    ]);
    const exportPath = shot('atlas-identity-export.json');
    await download.saveAs(exportPath);
    const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    if (exported.format !== 'atlas-identity-export/1.0') throw new Error('Wrong export format tag');
    if (!exported.salt || !exported.iv || !exported.ciphertext) throw new Error('Export is missing expected encrypted fields');
    if (JSON.stringify(exported).includes(PASSWORD)) throw new Error('Exported file leaks the plaintext password');
    if (seedPhrase.split(' ').some((w) => JSON.stringify(exported).includes(w))) throw new Error('Exported file leaks a plaintext seed word');
    console.log('PASS: exported file is encrypted — no plaintext trace of the password or seed phrase in it');

    console.log('STEP 9: simulating a brand-new device — clearing local AND session storage for this identity');
    await frame.evaluate(async () => {
      await chrome.storage.local.remove('atlasIdentity');
      await chrome.storage.session.remove('atlasUnlockedIdentity');
    });
    await frame.locator('#walletBtn').click(); // close
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    await frame.locator('#walletBtn').click(); // reopen -> re-route
    await frame.waitForFunction(() => document.getElementById('onboardingChoiceScreen').classList.contains('active'), { timeout: 5000 });
    console.log('PASS: with local storage cleared, this "device" is routed to onboarding again, not unlock');
    await page.screenshot({ path: shot('idb-02-fresh-device.png') });

    console.log('STEP 10: import with a WRONG password (correct seed phrase) — must fail generically, must not restore anything');
    await frame.locator('#chooseImportBtn').click();
    await frame.waitForFunction(() => document.getElementById('importScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#onboardImportFileInput').setInputFiles(exportPath);
    await frame.waitForFunction(() => document.getElementById('importScreenStatus').textContent.includes('loaded'), { timeout: 5000 });
    await frame.locator('#onboardImportPasswordInput').fill('definitely-the-wrong-password');
    await frame.locator('#onboardImportSeedInput').fill(seedPhrase);
    await frame.locator('#confirmImportBtn').click();
    await frame.waitForFunction(
      () => document.getElementById('importScreenStatus').textContent === 'Incorrect password or seed phrase.',
      { timeout: 10000 }
    );
    if (await frame.locator('#importScreen').getAttribute('class').then((c) => !c.includes('active'))) {
      throw new Error('Should still be on the import screen after a wrong password');
    }
    console.log('PASS: wrong password rejected with the generic message, nothing restored');

    console.log('STEP 11: import with the CORRECT password but a WRONG seed phrase — same generic failure, same non-restoration');
    await frame.locator('#onboardImportPasswordInput').fill(PASSWORD);
    await frame.locator('#onboardImportSeedInput').fill('wrong seed phrase entirely not the real one at all here whatsoever nope');
    await frame.locator('#confirmImportBtn').click();
    await frame.waitForFunction(
      () => document.getElementById('importScreenStatus').textContent === 'Incorrect password or seed phrase.',
      { timeout: 10000 }
    );
    if (await frame.locator('#importScreen').getAttribute('class').then((c) => !c.includes('active'))) {
      throw new Error('Should still be on the import screen after a wrong seed phrase');
    }
    console.log('PASS: wrong seed phrase rejected with the IDENTICAL generic message — no signal about which secret was wrong');
    await page.screenshot({ path: shot('idb-03-import-rejected.png') });

    console.log('STEP 12: import with the correct password AND the correct seed phrase together');
    await frame.locator('#onboardImportPasswordInput').fill(PASSWORD);
    await frame.locator('#onboardImportSeedInput').fill(seedPhrase);
    await frame.locator('#confirmImportBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 10000 });
    const restoredLabel = await frame.locator('#walletIdentity').textContent();
    if (restoredLabel !== originalIdentityLabel) throw new Error('Restored public key does not match the original: ' + restoredLabel + ' vs ' + originalIdentityLabel);
    console.log('PASS: identity restored on this "device" — public key matches the original exactly ->', restoredLabel);
    await page.screenshot({ path: shot('idb-04-restored.png') });

    console.log('STEP 13: proving the restored identity can actually sign — present identity');
    // Task #73 moved Present identity into the Identity accordion, closed
    // by default (it used to sit in Inventory, open by default) — open it
    // first, same as a real user would need to.
    const identityCategoryOpen = await frame.locator('.settings-category[data-category="identity"]').evaluate((el) => el.classList.contains('open'));
    if (!identityCategoryOpen) await frame.locator('.settings-category[data-category="identity"] .settings-category-toggle').click();
    await frame.locator('#presentBtn').click();
    await frame.waitForFunction(
      () => document.getElementById('presentBtn').textContent.includes('verified'),
      { timeout: 10000 }
    );
    console.log('PASS: restored identity produced a signature that verified against its own public key');

    console.log('\nALL IDENTITY BACKUP CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
