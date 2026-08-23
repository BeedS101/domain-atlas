// Manual check for the local identity alias/nickname: setting one replaces
// the raw public key in the wallet's own display, it survives a lock/
// unlock cycle, it's keyed per public key (so switching to a DIFFERENT
// identity shows a blank field, and switching back shows the original
// alias again), Enter submits the same as clicking Save, blanking the
// field and saving clears it back to the raw key, and the profanity
// filter rejects an obvious word AND a leetspeak-obscured variant of one
// while leaving an innocent nickname alone. Not part of the permanent
// suite, same reasoning as the other manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

// switchIdentityModeBtn lives under Settings -> "Identity method", a
// category collapsed by default, and a successful mode switch routes back
// to the main wallet screen — so every click on it needs Settings and that
// category re-opened first.
async function openIdentityMethodCategory(frame) {
  await frame.locator('#openSettingsBtn').click();
  await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
  const category = frame.locator('.settings-category[data-category="identity-method"]');
  if (!(await category.evaluate((el) => el.classList.contains('open')))) {
    await category.locator('.settings-category-toggle').click();
    await frame.waitForFunction(() => document.querySelector('.settings-category[data-category="identity-method"]').classList.contains('open'), { timeout: 5000 });
  }
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-alias');
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

    console.log('SETUP: creating a local password identity');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('alias-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('alias-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    const rawIdentityLabel = await frame.locator('#walletIdentity').textContent();
    if (!rawIdentityLabel.startsWith('Identity:')) throw new Error('Expected the raw-key display before any alias is set, got: ' + rawIdentityLabel);
    console.log('PASS: identity created, shown as the raw key before any alias exists ->', rawIdentityLabel);

    console.log('STEP 1: an obviously profane alias is rejected, nothing changes');
    await frame.locator('#aliasInput').fill('fuckface');
    await frame.locator('#setAliasBtn').click();
    await frame.waitForFunction(() => document.getElementById('aliasStatus').textContent === "That alias isn't allowed here — try something else.", { timeout: 5000 });
    const stillRaw = await frame.locator('#walletIdentity').textContent();
    if (!stillRaw.startsWith('Identity:')) throw new Error('Display should be unaffected by a rejected alias, got: ' + stillRaw);
    console.log('PASS: profane alias rejected, display unchanged');

    console.log('STEP 2: a leetspeak-obscured variant is ALSO caught (normalization before matching)');
    await frame.locator('#aliasInput').fill('5h1t-head');
    await frame.locator('#setAliasBtn').click();
    await frame.waitForFunction(() => document.getElementById('aliasStatus').textContent === "That alias isn't allowed here — try something else.", { timeout: 5000 });
    console.log('PASS: leetspeak dodge ("5h1t-head" -> normalizes to contain "shit") caught too');

    console.log('STEP 3: an innocent nickname is accepted — Enter submits it, same as clicking Save');
    await frame.locator('#aliasInput').fill('Nomad');
    await frame.locator('#aliasInput').press('Enter');
    await frame.waitForFunction(() => document.getElementById('aliasStatus').textContent === 'Saved.', { timeout: 5000 });
    const aliasedLabel = await frame.locator('#walletIdentity').textContent();
    if (!aliasedLabel.startsWith('Nomad ·')) throw new Error('Expected the display to lead with the alias, got: ' + aliasedLabel);
    console.log('PASS: alias accepted and now shown in place of "Identity:" ->', aliasedLabel);

    console.log('STEP 4: locking and unlocking again — the alias is still there (persisted, not session-only)');
    await openIdentityMethodCategory(frame);
    await frame.locator('#lockWalletBtn').click();
    await frame.waitForFunction(() => !document.getElementById('walletPanel').classList.contains('open'), { timeout: 5000 });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('unlockScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#unlockPasswordInput').fill('alias-test-password');
    await frame.locator('#unlockBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 10000 });
    const aliasAfterUnlock = await frame.locator('#walletIdentity').textContent();
    if (!aliasAfterUnlock.startsWith('Nomad ·')) throw new Error('Alias should survive a lock/unlock cycle, got: ' + aliasAfterUnlock);
    const aliasInputAfterUnlock = await frame.locator('#aliasInput').inputValue();
    if (aliasInputAfterUnlock !== 'Nomad') throw new Error('Alias input should be pre-filled with the saved alias, got: ' + aliasInputAfterUnlock);
    console.log('PASS: alias persisted across lock/unlock, and the field is pre-filled with it ->', aliasAfterUnlock);

    console.log('STEP 5: a DIFFERENT identity (a fresh passkey) has no alias of its own — keyed per public key, not global');
    await openIdentityMethodCategory(frame);
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true }
    });
    await frame.locator('#switchIdentityModeBtn').click();
    await frame.waitForFunction(() => document.getElementById('webauthnCreateScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#confirmWebAuthnCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 10000 });
    // mainWalletScreen going active happens synchronously; the async
    // refreshIdentityDisplay() that actually repaints #walletIdentity for
    // the NEW identity can still be in flight right after — waiting only
    // on the screen's active class risks reading the previous identity's
    // (aliased) label. Wait for the real value instead, same pattern used
    // in manual-webauthn-identity-mode.js for the identical race.
    await frame.waitForFunction(() => document.getElementById('walletIdentity').textContent.startsWith('Identity:'), { timeout: 5000 });
    const passkeyLabel = await frame.locator('#walletIdentity').textContent();
    if (!passkeyLabel.startsWith('Identity:')) throw new Error('The new passkey identity should show its raw key, no alias yet: ' + passkeyLabel);
    const passkeyAliasInput = await frame.locator('#aliasInput').inputValue();
    if (passkeyAliasInput !== '') throw new Error('Alias field should be blank for a different identity, got: ' + passkeyAliasInput);
    console.log('PASS: the fresh passkey identity has no alias of its own ->', passkeyLabel);

    console.log('STEP 6: switching back to the password identity brings its "Nomad" alias right back');
    await openIdentityMethodCategory(frame);
    await frame.locator('#switchIdentityModeBtn').click();
    await frame.waitForFunction(() => document.getElementById('walletIdentity').textContent.startsWith('Nomad ·'), { timeout: 5000 });
    console.log('PASS: switched back, "Nomad" reappeared automatically — the alias followed the key, not a global slot');

    console.log('STEP 7: clearing the alias (blank field + Save) reverts the display to the raw key');
    await frame.locator('#aliasInput').fill('');
    await frame.locator('#setAliasBtn').click();
    await frame.waitForFunction(() => document.getElementById('aliasStatus').textContent === 'Nickname cleared.', { timeout: 5000 });
    const clearedLabel = await frame.locator('#walletIdentity').textContent();
    if (!clearedLabel.startsWith('Identity:')) throw new Error('Expected the raw-key display back after clearing, got: ' + clearedLabel);
    console.log('PASS: cleared alias reverts the display to the raw key ->', clearedLabel);

    console.log('\nALL ALIAS CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
