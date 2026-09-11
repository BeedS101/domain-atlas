// Regression test for a same-day bug introduced by task #118 (raising the
// wallet-unlock PBKDF2 iteration count 250,000 -> 600,000): that change
// hardcoded the new count into deriveAesKey() with no way to tell what an
// EXISTING encrypted wallet blob was actually created under, so unlocking
// any wallet that already existed before #118 shipped derived the WRONG
// key and failed with "Incorrect password" — a real lockout for anyone
// with a pre-existing wallet, not a hardening improvement.
//
// This builds a wallet blob EXACTLY the way the pre-fix code did (250,000
// iterations, no `kdfIterations` field at all — since that field didn't
// exist yet), then proves:
//   1. AtlasWallet.unlockIdentity() with the CORRECT password still
//      succeeds against that legacy blob (this is the actual bug: before
//      the fix, this throws "Incorrect password").
//   2. A successful legacy unlock transparently migrates the stored blob
//      to the current iteration count (fresh salt/iv/ciphertext, a real
//      `kdfIterations: 600000` field) — self-healing, no separate step.
//   3. The migrated blob still unlocks correctly afterward (the migration
//      didn't corrupt anything).
//   4. A brand-new identity (createIdentity) records its iteration count
//      up front, so this same class of bug can't recur silently for it.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-kdf-migration-fix');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: loading the extension (no identity created through the UI — we inject a legacy blob directly)');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });

    console.log('STEP 1: injecting a wallet blob built EXACTLY the way the pre-#118-fix code built one — 250,000 iterations, no kdfIterations field at all');
    const PASSWORD = 'a-real-pre-existing-password-1';
    const { publicKey: expectedPublicKey, originalCiphertext } = await frame.evaluate(async (password) => {
      function b64urlEncode(buf) {
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      }
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const rawPublic = await crypto.subtle.exportKey('raw', pair.publicKey);
      const privateKeyJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
      const publicKey = b64urlEncode(rawPublic);

      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      // The exact pre-fix deriveAesKey: one secret, digested, PBKDF2 at
      // the OLD hardcoded 250,000 — no kdfIterations concept existed yet.
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
      const baseKey = await crypto.subtle.importKey('raw', new Uint8Array(digest), 'PBKDF2', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
        baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
      );
      const plaintext = new TextEncoder().encode(JSON.stringify({ publicKey, privateKeyJwk }));
      const ciphertext = b64urlEncode(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));

      const legacyBlob = {
        format: 'atlas-identity-local/1.0',
        publicKey,
        salt: b64urlEncode(salt.buffer),
        iv: b64urlEncode(iv.buffer),
        ciphertext,
        // deliberately NO kdfIterations field
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      };
      await chrome.storage.local.set({ atlasIdentity: legacyBlob, atlasIdentityMode: 'local' });
      return { publicKey, originalCiphertext: ciphertext };
    }, PASSWORD);
    console.log('PASS: legacy-shaped blob (250,000 iterations, no kdfIterations field) injected ->', expectedPublicKey.slice(0, 16) + '...');

    console.log('STEP 2: unlocking with the CORRECT password — this is the actual bug: before the fix, deriveAesKey assumed 600,000 for every blob and this throws "Incorrect password"');
    const unlockResult = await frame.evaluate(async (password) => {
      try {
        return { ok: true, result: await AtlasWallet.unlockIdentity(password) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }, PASSWORD);
    if (!unlockResult.ok) throw new Error('REGRESSION: unlockIdentity rejected the correct password for a legacy (250,000-iteration) wallet -> ' + unlockResult.error);
    if (unlockResult.result.publicKey !== expectedPublicKey) throw new Error('Unlocked identity public key mismatch');
    console.log('PASS: legacy wallet unlocked successfully with its real password');

    console.log('STEP 3: the successful legacy unlock should have transparently migrated the stored blob to the current iteration count');
    const migrated = await frame.evaluate(async () => {
      const { atlasIdentity } = await chrome.storage.local.get('atlasIdentity');
      return atlasIdentity;
    });
    if (migrated.kdfIterations !== 600000) throw new Error('Expected the blob to be migrated to kdfIterations: 600000, got: ' + JSON.stringify(migrated.kdfIterations));
    if (migrated.ciphertext === originalCiphertext) throw new Error('Expected a fresh salt/iv/ciphertext after migration, got the same ciphertext');
    console.log('PASS: blob migrated in place -> kdfIterations: 600000, fresh salt/iv/ciphertext');

    console.log('STEP 4: the migrated blob still unlocks correctly (migration did not corrupt anything)');
    await frame.evaluate(async () => { await AtlasWallet.lockIdentity(); });
    const relockedUnlockable = await frame.evaluate(async () => !(await AtlasWallet.isUnlocked()));
    if (!relockedUnlockable) throw new Error('Expected the identity to be locked after lockIdentity()');
    const secondUnlock = await frame.evaluate(async (password) => {
      try {
        return { ok: true, result: await AtlasWallet.unlockIdentity(password) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }, PASSWORD);
    if (!secondUnlock.ok) throw new Error('Migrated blob failed to unlock on a second attempt -> ' + secondUnlock.error);
    if (secondUnlock.result.publicKey !== expectedPublicKey) throw new Error('Second unlock public key mismatch');
    console.log('PASS: migrated wallet unlocks correctly on a fresh attempt too');

    console.log('STEP 5: a brand-new identity records its own iteration count immediately, so this class of bug can\'t silently recur for it');
    await frame.evaluate(async () => { await chrome.storage.local.remove(['atlasIdentity', 'atlasIdentityMode']); });
    const freshBlob = await frame.evaluate(async () => {
      await AtlasWallet.createIdentity('a-brand-new-password-1');
      const { atlasIdentity } = await chrome.storage.local.get('atlasIdentity');
      return atlasIdentity;
    });
    if (freshBlob.kdfIterations !== 600000) throw new Error('Expected a freshly created identity to record kdfIterations: 600000, got: ' + JSON.stringify(freshBlob.kdfIterations));
    console.log('PASS: a fresh identity records its iteration count up front');

    console.log('\nALL KDF-MIGRATION-FIX CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
