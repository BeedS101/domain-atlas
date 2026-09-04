// Manual check for the new dual-mode "self" identity: local password
// identity vs. WebAuthn passkey identity, chosen at onboarding and
// switchable afterward. Not part of the permanent suite (test/verify*.js)
// because it depends on a CDP virtual authenticator, which is heavier
// machinery than the other tests need — kept here as a throwaway script,
// same pattern as the other manual-*.js files.
//
// Also exists to answer a real open question: does the WebAuthn
// Permissions-Policy delegation on the overlay iframe (content.js's
// `iframe.allow = 'publickey-credentials-create; publickey-credentials-get'`)
// actually let navigator.credentials.create()/.get() run inside that
// cross-origin iframe at all? A CDP virtual authenticator attached to the
// page answers that empirically instead of by inspecting comments.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

// switchIdentityModeBtn (and identityModeLabel) live under Settings ->
// "Identity method", a category that's collapsed by default and that a
// successful switch navigates away from (routeWalletScreen sends you back
// to mainWalletScreen). So every click on the switch button needs Settings
// re-opened and that category re-opened first.
async function openIdentityMethodCategory(frame) {
  await frame.locator('#settingsTabBtn').click();
  await frame.waitForFunction(() => document.getElementById('settingsScreen').classList.contains('active'), { timeout: 5000 });
  const category = frame.locator('.settings-category[data-category="identity-method"]');
  if (!(await category.evaluate((el) => el.classList.contains('open')))) {
    await category.locator('.settings-category-toggle').click();
    await frame.waitForFunction(() => document.querySelector('.settings-category[data-category="identity-method"]').classList.contains('open'), { timeout: 5000 });
  }
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-webauthn-mode');
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

    // A virtual platform authenticator (internal transport, like Windows
    // Hello/Touch ID) attached at the page level via CDP — this is what
    // answers navigator.credentials.create()/.get() calls instead of a
    // real hardware prompt.
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true
      }
    });
    console.log('Virtual platform authenticator attached:', authenticatorId);

    console.log('STEP 1: opening the wallet panel on a fresh device');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.waitForFunction(() => document.getElementById('onboardingChoiceScreen').classList.contains('active'), { timeout: 5000 });
    console.log('PASS: no identity yet, routed to onboarding, both options offered');

    console.log('STEP 2: choosing the passkey option, creating it inside the cross-origin overlay iframe');
    await frame.locator('#chooseWebAuthnBtn').click();
    await frame.waitForFunction(() => document.getElementById('webauthnCreateScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#confirmWebAuthnCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 10000 });
    // mainWalletScreen going active happens synchronously; the async
    // refreshIdentityDisplay()/refreshItemsDisplay() chain that actually
    // fills in identityModeLabel and selfCollectiblesList can still be in flight
    // right after — wait for the label's real value, not just the screen.
    await frame.waitForFunction(() => document.getElementById('identityModeLabel').textContent === 'Using: passkey identity', { timeout: 5000 });
    const modeAfterCreate = await frame.locator('#identityModeLabel').textContent();
    console.log('PASS: passkey identity created inside the iframe and activated as self ->', await frame.locator('#walletIdentity').textContent());

    console.log('STEP 3: presenting identity — a real per-signature WebAuthn assertion ceremony, also inside the iframe');
    // Task #73 moved Present identity into the Identity accordion, closed
    // by default (it used to sit in Inventory, open by default) — open it
    // first, same as a real user would need to.
    const identityCategoryOpen = await frame.locator('.settings-category[data-category="identity"]').evaluate((el) => el.classList.contains('open'));
    if (!identityCategoryOpen) await frame.locator('.settings-category[data-category="identity"] .settings-category-toggle').click();
    await frame.locator('#presentBtn').click();
    await frame.waitForFunction(
      () => document.getElementById('presentBtn').textContent.includes('verified') || document.getElementById('presentBtn').textContent.includes('failed'),
      { timeout: 10000 }
    );
    const presentResult = await frame.locator('#presentBtn').textContent();
    if (!presentResult.includes('verified')) throw new Error('Presentation did not verify: ' + presentResult);
    console.log('PASS: WebAuthn assertion signed and verified ->', presentResult);

    console.log('STEP 4: requesting a real item while "self" is the passkey identity — proves signing dispatch, not just presence checks');
    await frame.locator('#requestItemBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0, { timeout: 15000 });
    console.log('PASS: item issued to the passkey identity\'s public key');

    console.log('STEP 5: switching to a password identity — none exists yet, should route to set one up');
    await openIdentityMethodCategory(frame);
    const switchLabelBefore = await frame.locator('#switchIdentityModeBtn').textContent();
    if (switchLabelBefore !== 'Set up a password identity') throw new Error('Expected "Set up a password identity", got: ' + switchLabelBefore);
    await frame.locator('#switchIdentityModeBtn').click();
    await frame.waitForFunction(() => document.getElementById('createScreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#newPasswordInput').fill('a-second-identity-password');
    await frame.locator('#newPasswordConfirmInput').fill('a-second-identity-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    // Same reasoning as STEP 2 above: wait for the label's real value
    // rather than reading it the instant the screen flips active.
    await frame.waitForFunction(() => document.getElementById('identityModeLabel').textContent === 'Using: password identity', { timeout: 5000 });
    const passwordIdentityLabel = await frame.locator('#walletIdentity').textContent();
    console.log('PASS: password identity created and auto-activated ->', passwordIdentityLabel);

    console.log('STEP 6: the password identity\'s wallet is separate — should show no items (the item above belongs to the passkey key)');
    // refreshItemsDisplay() for the new identity can still be in flight
    // right after the mode label updates — wait for the list to actually
    // settle at empty instead of reading .count() immediately, which could
    // catch a stale render still showing the passkey identity's item.
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length === 0, { timeout: 5000 });
    console.log('PASS: password identity\'s wallet is empty — confirms each identity mechanism keeps its own separate wallet');

    console.log('STEP 7: switching back to the passkey identity — should be instant (no re-creation), and its item should reappear');
    await openIdentityMethodCategory(frame);
    const switchLabelNow = await frame.locator('#switchIdentityModeBtn').textContent();
    if (switchLabelNow !== 'Switch to passkey identity') throw new Error('Expected "Switch to passkey identity", got: ' + switchLabelNow);
    await frame.locator('#switchIdentityModeBtn').click();
    await frame.waitForFunction(() => document.getElementById('identityModeLabel').textContent === 'Using: passkey identity', { timeout: 5000 });
    await frame.waitForFunction(() => document.querySelectorAll('#selfCollectiblesList .wallet-item').length > 0, { timeout: 5000 });
    const walletIdentityAfterSwitchBack = await frame.locator('#walletIdentity').textContent();
    console.log('PASS: switched back to the passkey identity instantly, its item is back ->', walletIdentityAfterSwitchBack);

    console.log('STEP 8: switching to the password identity again — should now be instant too (it already exists)');
    await openIdentityMethodCategory(frame);
    await frame.locator('#switchIdentityModeBtn').click();
    await frame.waitForFunction(() => document.getElementById('identityModeLabel').textContent === 'Using: password identity', { timeout: 5000 });
    const walletIdentityBackToPassword = await frame.locator('#walletIdentity').textContent();
    if (walletIdentityBackToPassword !== passwordIdentityLabel) throw new Error('Password identity public key changed across switches: ' + walletIdentityBackToPassword + ' vs ' + passwordIdentityLabel);
    console.log('PASS: switched back to the SAME password identity, same public key, no re-creation ->', walletIdentityBackToPassword);

    console.log('\nALL WEBAUTHN / DUAL-IDENTITY-MODE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
