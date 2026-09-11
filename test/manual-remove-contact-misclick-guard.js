// Manual check: fixes Bruno's reported Contacts UX bug — the "Remove"
// link's inline "Confirm" button appears in EXACTLY the screen spot the
// link itself just was, so a double-click or a twitchy/sticky mouse
// button firing two close-together click events could land the second one
// squarely on Confirm, removing a contact nobody consciously decided to
// remove. Fix: REMOVE_CONTACT_CONFIRM_GRACE_MS (viewer.js, near
// renderFriendCard) — the Confirm button starts disabled the instant the
// row appears and only becomes clickable after a short pause, so the
// fastest an accidental double-click/twitch can manage still can't reach
// it. A genuine, deliberate click after the grace window still works
// exactly as before.
//
// Seeds a fake contact directly via AtlasWallet.addFriend() rather than
// running the full two-identity friend-request flow
// manual-friends-favorites.js already covers end to end — this test is
// only about the remove-button timing, not how a contact gets added.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts. Assumes issuer-server is already running on 8001.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-remove-contact-guard');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('remove-contact-guard-pw');
    await frame.locator('#newPasswordConfirmInput').fill('remove-contact-guard-pw');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });

    console.log('SETUP: seed one fake contact directly, open Contacts');
    await frame.evaluate(() => AtlasWallet.addFriend('fake-public-key-misclick-test', 'Misclick Test Contact'));
    await frame.locator('#socialTabBtn').click();
    await frame.locator('#contactsSubtabBtn').click();
    await frame.waitForFunction(() => document.getElementById('contactsSubscreen').classList.contains('active'), { timeout: 5000 });
    await frame.evaluate(() => refreshFriendsDisplay());
    await frame.waitForFunction(() => document.querySelectorAll('#contactsList .info-card').length > 0, { timeout: 5000 });
    const card = frame.locator('#contactsList .info-card', { hasText: 'Misclick Test Contact' });
    await card.waitFor({ timeout: 5000 });
    console.log('PASS: fake contact visible in Contacts');

    console.log('STEP 1: clicking Remove reveals the confirm row with Confirm DISABLED (the misclick guard)');
    await card.locator('button[data-action="remove-contact-ask"]').click();
    const confirmBtn = card.locator('button[data-action="remove-contact-confirm"]');
    await confirmBtn.waitFor({ state: 'visible', timeout: 2000 });
    const disabledImmediately = await confirmBtn.isDisabled();
    if (!disabledImmediately) throw new Error('Expected Confirm to be disabled the instant the row appears');
    console.log('PASS: Confirm starts disabled');

    console.log('STEP 2: shortly after (well inside the grace window), Confirm is STILL disabled — a real browser refuses to fire click on a disabled button at all, so this is what actually protects against a fast double-click/twitchy mouse landing on it');
    await new Promise((r) => setTimeout(r, 150));
    if (!(await confirmBtn.isDisabled())) throw new Error('Expected Confirm to still be disabled 150ms in, well inside the 400ms grace window');
    const stillThereMidGrace = await frame.locator('#contactsList .info-card', { hasText: 'Misclick Test Contact' }).count();
    if (stillThereMidGrace !== 1) throw new Error('Contact should still be present mid-grace-window');
    console.log('PASS: Confirm stays disabled through the grace window, contact untouched');

    console.log('STEP 3: after the grace window passes, Confirm becomes enabled and a genuine deliberate click still works');
    await frame.waitForFunction(() => {
      const btn = document.querySelector('button[data-action="remove-contact-confirm"]');
      return btn && !btn.disabled;
    }, { timeout: 2000 });
    console.log('PASS: Confirm became enabled after the grace window');
    await confirmBtn.click();
    await frame.waitForFunction(() => document.querySelectorAll('#contactsList .info-card').length === 0, { timeout: 3000 });
    console.log('PASS: a real, deliberate click after the grace window still removes the contact as intended');

    console.log('\nALL CHECKS PASSED — misclick guard blocks an immediate/accidental confirm while still letting a real confirm through.');
  } catch (err) {
    console.error('FAIL:', err.message);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
