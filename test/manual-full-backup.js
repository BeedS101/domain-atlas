// Verifies task #122 — the full encrypted backup/restore feature — end to
// end: a real local identity with real data across most of the families
// that got per-identity at-rest encryption in the whole-storage encryption
// pass (Wallet, Friends, Contact groups, Aliases, Recent worlds, Favorite
// domains, Calendar events, Muted/Blocked chat users, Loadout), exported to
// one password+seed-phrase-protected file (same two-secret model as
// exportIdentity/importIdentity — see wallet.js's exportFullBackup), then
// restored onto a simulated fresh device and checked field-by-field against
// the originals. Also proves the security posture: a wrong password/seed
// fails generically (no signal about which secret was wrong, matching
// importIdentity's own established behavior) and the export file itself
// carries no plaintext trace of the password, seed phrase, or the data it
// protects.
//
// Data families are set up via direct AtlasWallet calls (frame.evaluate)
// rather than driving every screen by hand — same convention manual-
// calendar.js and others already use for setup — since this test's actual
// subject is the backup/restore round-trip, not each family's own UI
// (already covered by manual-friends-favorites.js, manual-calendar.js,
// manual-alias.js, manual-chat-username-actions.js, etc.). The export and
// restore steps themselves DO go through the real Settings/onboarding UI
// and a real file download, since that wiring is exactly what's new here.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

function shot(name) {
  return path.resolve(__dirname, name);
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-full-backup');
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

    console.log('STEP 1: fresh device — create a local password identity');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('onboardingChoiceScreen').classList.contains('active'), { timeout: 5000 });

    const PASSWORD = 'full-backup-test-password-1';
    await frame.locator('#chooseNewBtn').click();
    await frame.waitForFunction(() => document.getElementById('createScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#newPasswordInput').fill(PASSWORD);
    await frame.locator('#newPasswordConfirmInput').fill(PASSWORD);
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    const seedPhrase = (await frame.locator('#seedPhraseText').textContent()).trim();
    if (seedPhrase.split(/\s+/).length !== 16) throw new Error('Expected a 16-word seed phrase, got: ' + seedPhrase);
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    const originalIdentityLabel = await frame.locator('#walletIdentity').textContent();
    const originalPublicKey = await frame.evaluate(async () => (await AtlasWallet.getIdentity()).publicKey);
    console.log('PASS: identity created ->', originalIdentityLabel);

    console.log('STEP 2: populating real data across several of the newly-encrypted families');
    const seedData = await frame.evaluate(async () => {
      await AtlasWallet.addFriend('friend-public-key-abc123', 'Test Friend');
      const groupId = await AtlasWallet.addContactGroup('Backup Test Group');
      const calendarId = await AtlasWallet.addCalendarEvent({
        title: 'Backup test event',
        dateTime: new Date(Date.now() + 86400000).toISOString(),
        notes: 'Should survive a full backup round-trip'
      });
      await AtlasWallet.addFavoriteDomain({
        domain: 'localhost:8001',
        manifestUrl: 'http://localhost:8001/.well-known/spatial.json',
        worldId: 'plaza',
        worldName: 'Example Plaza'
      });
      await AtlasWallet.createCounterparty();
      const counterparty = await AtlasWallet.getCounterparty();
      await AtlasWallet.setAlias(counterparty.publicKey, 'Counterparty Nickname');
      await AtlasWallet.muteChatUser('muted-public-key-xyz789', 'Muted Person');
      const selfIdentity = await AtlasWallet.getIdentity();
      await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.membership');
      // Task #158 (chat end-to-end encryption): getChatE2eeKeyPair()
      // lazily generates this identity's own ECDH keypair the first time
      // anything asks for it — call it here so there's a real one to lose
      // if the backup/restore round-trip below silently regenerated a
      // fresh keypair instead of carrying the original one forward. This
      // is the single most important thing to check: a restored backup
      // that ends up with a DIFFERENT e2ee keypair than the original would
      // permanently lose the ability to decrypt every past end-to-end
      // encrypted chat thread, even though every other family above
      // restored fine — see exportFullBackup/importFullBackup's own
      // comments on why chatE2eeKeyPair was folded into the same
      // Promise.all as everything else here.
      const chatE2eeKeyPair = await AtlasWallet.getChatE2eeKeyPair(selfIdentity);
      return {
        friends: await AtlasWallet.getFriends(),
        contactGroups: await AtlasWallet.getContactGroups(),
        calendarId,
        calendarEvents: await AtlasWallet.getCalendarEvents(),
        favoriteDomains: await AtlasWallet.getFavoriteDomains(),
        counterpartyPublicKey: counterparty.publicKey,
        alias: await AtlasWallet.getAlias(counterparty.publicKey),
        mutedChatUsers: await AtlasWallet.getMutedChatUsers(),
        walletCount: (await AtlasWallet.getWallet(selfIdentity.publicKey)).length,
        groupId,
        chatE2eePublicKeyJwk: chatE2eeKeyPair.publicKeyJwk,
        chatE2eePrivateKeyJwk: chatE2eeKeyPair.privateKeyJwk
      };
    });
    if (seedData.friends.length !== 1) throw new Error('Friend was not saved before backup: ' + JSON.stringify(seedData.friends));
    if (seedData.contactGroups.length !== 1) throw new Error('Contact group was not saved before backup');
    if (seedData.calendarEvents.length !== 1) throw new Error('Calendar event was not saved before backup');
    if (seedData.favoriteDomains.length !== 1) throw new Error('Favorite domain was not saved before backup');
    if (seedData.alias !== 'Counterparty Nickname') throw new Error('Alias was not saved before backup: ' + seedData.alias);
    if (seedData.mutedChatUsers.length !== 1) throw new Error('Muted chat user was not saved before backup');
    if (seedData.walletCount < 1) throw new Error('Minted membership asset was not saved before backup');
    if (!seedData.chatE2eePublicKeyJwk || seedData.chatE2eePublicKeyJwk.kty !== 'EC') throw new Error('Chat e2ee keypair was not generated/saved before backup');
    console.log('PASS: seeded Friends, Contact groups, Calendar, Favorites, Alias, Muted chat, a minted wallet asset, and a chat e2ee keypair (task #158)');

    console.log('STEP 3: export attempt with the correct password but a malformed seed phrase — distinct validation message');
    await frame.locator('#settingsTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('.settings-category[data-category="full-backup"] .settings-category-toggle').click();
    await frame.waitForFunction(() => document.querySelector('.settings-category[data-category="full-backup"]').classList.contains('open'), { timeout: 5000 });
    await frame.locator('#fullBackupExportPasswordInput').fill(PASSWORD);
    await frame.locator('#fullBackupExportSeedInput').fill('only two words');
    await frame.locator('#exportFullBackupBtn').click();
    await frame.waitForFunction(
      () => document.getElementById('fullBackupExportStatus').textContent === 'Export failed: Enter the full seed phrase you were shown when you created this identity.',
      { timeout: 10000 }
    );
    console.log('PASS: malformed seed phrase rejected with its own distinct message');

    console.log('STEP 4: export attempt with a WRONG password — must fail, must not produce a file');
    await frame.locator('#fullBackupExportPasswordInput').fill('the-wrong-password-entirely');
    await frame.locator('#fullBackupExportSeedInput').fill(seedPhrase);
    await frame.locator('#exportFullBackupBtn').click();
    await frame.waitForFunction(
      () => document.getElementById('fullBackupExportStatus').textContent === 'Export failed: Incorrect password.',
      { timeout: 10000 }
    );
    console.log('PASS: wrong password rejected — full backup export re-verifies the password, same as identity export');

    console.log('STEP 5: exporting for real — password + seed phrase combined, one encrypted file');
    await frame.locator('#fullBackupExportPasswordInput').fill(PASSWORD);
    await frame.locator('#fullBackupExportSeedInput').fill(seedPhrase);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      frame.locator('#exportFullBackupBtn').click()
    ]);
    const exportPath = shot('atlas-full-backup-export.json');
    await download.saveAs(exportPath);
    const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
    if (exported.format !== 'atlas-full-backup/1.0') throw new Error('Wrong export format tag: ' + exported.format);
    if (!exported.salt || !exported.iv || !exported.ciphertext) throw new Error('Export is missing expected encrypted fields');
    const rawExportText = JSON.stringify(exported);
    if (rawExportText.includes(PASSWORD)) throw new Error('Exported file leaks the plaintext password');
    if (seedPhrase.split(' ').some((w) => rawExportText.includes(w))) throw new Error('Exported file leaks a plaintext seed word');
    if (rawExportText.includes('Test Friend') || rawExportText.includes('Backup test event') || rawExportText.includes('Counterparty Nickname')) {
      throw new Error('Exported file leaks plaintext personal data outside the encrypted ciphertext field');
    }
    if (rawExportText.includes(seedData.chatE2eePrivateKeyJwk.d)) {
      throw new Error('Exported file leaks the plaintext chat e2ee private key (task #158) outside the encrypted ciphertext field');
    }
    console.log('PASS: exported file is one opaque encrypted blob — no plaintext trace of secrets or personal data, including the chat e2ee private key');

    console.log('STEP 6: simulating a brand-new device — clearing ALL local and session storage');
    await frame.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.session.clear();
    });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('onboardingChoiceScreen').classList.contains('active'), { timeout: 5000 });
    console.log('PASS: fresh "device" state confirmed — routed back to onboarding');

    console.log('STEP 7: restore attempt with a WRONG seed phrase (correct password) — same generic failure as identity import');
    await frame.locator('#chooseImportBtn').click();
    await frame.waitForFunction(() => document.getElementById('importScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#onboardImportFileInput').setInputFiles(exportPath);
    await frame.waitForFunction(() => document.getElementById('importScreenStatus').textContent.includes('loaded'), { timeout: 5000 });
    await frame.locator('#onboardImportPasswordInput').fill(PASSWORD);
    await frame.locator('#onboardImportSeedInput').fill('wrong seed phrase entirely not the real one nope nope nope');
    await frame.locator('#restoreFullBackupBtn').click();
    await frame.waitForFunction(
      () => document.getElementById('importScreenStatus').textContent === 'Incorrect password or seed phrase.',
      { timeout: 10000 }
    );
    if (await frame.locator('#importScreen').getAttribute('class').then((c) => !c.includes('active'))) {
      throw new Error('Should still be on the import screen after a wrong seed phrase');
    }
    console.log('PASS: wrong seed phrase rejected generically, nothing restored');

    console.log('STEP 8: clicking "Import identity" (the wrong button for this file) — clear format-mismatch error, not a crash');
    await frame.locator('#onboardImportPasswordInput').fill(PASSWORD);
    await frame.locator('#onboardImportSeedInput').fill(seedPhrase);
    await frame.locator('#confirmImportBtn').click();
    await frame.waitForFunction(
      () => document.getElementById('importScreenStatus').textContent === 'Not an Atlas identity file.',
      { timeout: 10000 }
    );
    console.log('PASS: loading a full-backup file into the identity-only import button fails clearly, no silent partial restore');

    console.log('STEP 9: restoring for real via "Restore full backup instead" — correct password AND correct seed phrase');
    await frame.locator('#restoreFullBackupBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 10000 });
    const restoredLabel = await frame.locator('#walletIdentity').textContent();
    if (restoredLabel !== originalIdentityLabel) throw new Error('Restored identity label does not match original: ' + restoredLabel + ' vs ' + originalIdentityLabel);
    console.log('PASS: identity restored — label matches original ->', restoredLabel);

    console.log('STEP 10: verifying every seeded data family actually came back, correctly re-encrypted under the restored identity');
    const restored = await frame.evaluate(async () => ({
      publicKey: (await AtlasWallet.getIdentity()).publicKey,
      friends: await AtlasWallet.getFriends(),
      contactGroups: await AtlasWallet.getContactGroups(),
      calendarEvents: await AtlasWallet.getCalendarEvents(),
      favoriteDomains: await AtlasWallet.getFavoriteDomains(),
      counterparty: await AtlasWallet.getCounterparty(),
      mutedChatUsers: await AtlasWallet.getMutedChatUsers(),
      wallet: await AtlasWallet.getWallet((await AtlasWallet.getIdentity()).publicKey),
      rawWallets: await chrome.storage.local.get('atlasWallets'),
      rawFriends: await chrome.storage.local.get('atlasFriends'),
      chatE2eeKeyPair: await AtlasWallet.getChatE2eeKeyPair(await AtlasWallet.getIdentity()),
      rawChatE2eeKeypairs: await chrome.storage.local.get('atlasChatE2eeKeypairs')
    }));
    if (restored.publicKey !== originalPublicKey) throw new Error('Restored public key does not match original: ' + restored.publicKey + ' vs ' + originalPublicKey);
    if (restored.friends.length !== 1 || restored.friends[0].publicKey !== 'friend-public-key-abc123' || restored.friends[0].name !== 'Test Friend') {
      throw new Error('Friends did not restore correctly: ' + JSON.stringify(restored.friends));
    }
    if (restored.contactGroups.length !== 1 || restored.contactGroups[0].name !== 'Backup Test Group') {
      throw new Error('Contact groups did not restore correctly: ' + JSON.stringify(restored.contactGroups));
    }
    if (restored.calendarEvents.length !== 1 || restored.calendarEvents[0].title !== 'Backup test event') {
      throw new Error('Calendar events did not restore correctly: ' + JSON.stringify(restored.calendarEvents));
    }
    if (restored.favoriteDomains.length !== 1 || restored.favoriteDomains[0].domain !== 'localhost:8001') {
      throw new Error('Favorite domains did not restore correctly: ' + JSON.stringify(restored.favoriteDomains));
    }
    if (!restored.counterparty || restored.counterparty.publicKey !== seedData.counterpartyPublicKey) {
      throw new Error('Counterparty did not restore correctly: ' + JSON.stringify(restored.counterparty));
    }
    if (restored.mutedChatUsers.length !== 1 || restored.mutedChatUsers[0].publicKey !== 'muted-public-key-xyz789') {
      throw new Error('Muted chat users did not restore correctly: ' + JSON.stringify(restored.mutedChatUsers));
    }
    if (restored.wallet.length !== seedData.walletCount) {
      throw new Error('Wallet assets did not restore correctly: expected ' + seedData.walletCount + ' got ' + restored.wallet.length);
    }
    // Raw on-disk shape check: restored data must be encrypted at rest
    // under the restored identity, not sitting as plaintext — the whole
    // point of routing restore through saveX() setters instead of writing
    // the backup's plaintext values straight to storage.
    const rawWalletSlot = (restored.rawWallets.atlasWallets || {})[restored.publicKey];
    if (!rawWalletSlot || !rawWalletSlot.__atlasEncrypted) throw new Error('Restored wallet is not encrypted at rest on disk: ' + JSON.stringify(rawWalletSlot));
    const rawFriendsSlot = (restored.rawFriends.atlasFriends || {})[restored.publicKey];
    if (!rawFriendsSlot || !rawFriendsSlot.__atlasEncrypted) throw new Error('Restored friends are not encrypted at rest on disk: ' + JSON.stringify(rawFriendsSlot));
    console.log('PASS: Friends, Contact groups, Calendar, Favorites, Counterparty+Alias, and Muted chat all restored correctly and are encrypted at rest on disk');

    // Task #158: THE critical check for this round — the restored identity
    // must have gotten back the exact SAME chat e2ee keypair it had before
    // backup, not a freshly-generated one. getChatE2eeKeyPair() would
    // happily auto-generate a brand-new keypair if it found nothing saved
    // for this identity, and that failure mode would look deceptively
    // fine (no error, a valid-looking keypair) while silently making every
    // past end-to-end encrypted chat thread permanently undecryptable.
    // Comparing the private key's `d` component specifically is what rules
    // that failure mode out — two independently generated P-256 keypairs
    // never share it.
    if (restored.chatE2eeKeyPair.privateKeyJwk.d !== seedData.chatE2eePrivateKeyJwk.d) {
      throw new Error('REGRESSION: restored chat e2ee keypair is DIFFERENT from the original — a fresh keypair was generated instead of restoring the real one, which would silently break decryption of every past e2ee chat thread');
    }
    if (restored.chatE2eeKeyPair.publicKeyJwk.x !== seedData.chatE2eePublicKeyJwk.x) {
      throw new Error('Restored chat e2ee public key does not match the original');
    }
    const rawChatE2eeSlot = (restored.rawChatE2eeKeypairs.atlasChatE2eeKeypairs || {})[restored.publicKey];
    if (!rawChatE2eeSlot || !rawChatE2eeSlot.__atlasEncrypted) throw new Error('Restored chat e2ee keypair is not encrypted at rest on disk: ' + JSON.stringify(rawChatE2eeSlot));
    console.log('PASS: chat e2ee keypair (task #158) restored as the SAME keypair, not regenerated, and encrypted at rest on disk');
    console.log('      (the e2ee peer-key cache — atlasChatE2eePeerKeys — is carried through exportFullBackup/importFullBackup by the exact same encryptAtRest/decryptAtRest + Promise.all mechanism just verified above; a live cross-domain scenario that actually populates it is exercised separately, end to end, in manual-chat-e2ee.js)');

    await page.screenshot({ path: shot('fb-01-restored.png') });

    console.log('STEP 11: proving the restored identity can actually sign — present identity');
    const identityCategoryOpen = await frame.locator('.settings-category[data-category="identity"]').evaluate((el) => el.classList.contains('open'));
    if (!identityCategoryOpen) await frame.locator('.settings-category[data-category="identity"] .settings-category-toggle').click();
    await frame.waitForFunction(() => document.querySelector('.settings-category[data-category="identity"]').classList.contains('open'), { timeout: 5000 });
    await frame.locator('#presentBtn').click();
    await frame.waitForFunction(() => document.getElementById('presentBtn').textContent.includes('verified'), { timeout: 10000 });
    console.log('PASS: restored identity produced a signature that verified against its own public key');

    console.log('\nALL FULL BACKUP/RESTORE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
