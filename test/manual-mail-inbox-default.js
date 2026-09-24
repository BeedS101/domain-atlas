// Manual check for #128: the very first time the wallet reaches Mail via a
// plain click (Social tab, or the Mail sub-tab itself), it should land on
// Inbox specifically rather than whatever inner sub-tab the DOM happened to
// default to — and every visit AFTER that first one should respect wherever
// the user last navigated (Sent/Compose/Mail Settings), never forcing back
// to Inbox. See viewer.js's `mailEverOpened` flag and its two call sites
// (socialTabBtn/mailSubtabBtn's click handlers) plus openComposeReply's own
// early set of the same flag (that third path — reaching Mail for the very
// first time via the quick-reply/private-message deep link rather than a
// plain click — isn't exercised here, since it needs the heavier Post
// Office relay-mail setup manual-mail.js/manual-postoffice-mail.js already
// cover; reviewed in code, not re-verified live in this script).
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-mail-inbox-default');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: fresh identity');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('inbox-default-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('inbox-default-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });

    console.log('STEP 1: first-ever click on Social lands on Mail -> Inbox');
    await frame.locator('#socialTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
    const inboxActiveOnFirstVisit = await frame.evaluate(() => ({
      subscreen: document.getElementById('mailBoxInboxSubscreen').classList.contains('active'),
      tabBtn: document.getElementById('mailBoxInboxSubtabBtn').classList.contains('active-subtab')
    }));
    if (!inboxActiveOnFirstVisit.subscreen || !inboxActiveOnFirstVisit.tabBtn) {
      throw new Error('Expected Inbox to be the active mail sub-tab on first visit, got: ' + JSON.stringify(inboxActiveOnFirstVisit));
    }
    console.log('PASS: Inbox is active on the very first visit to Mail');

    console.log('STEP 2: manually navigate to Compose');
    await frame.locator('#mailBoxComposeSubtabBtn').click();
    const composeActive = await frame.evaluate(() => document.getElementById('mailBoxComposeSubscreen').classList.contains('active'));
    if (!composeActive) throw new Error('Expected Compose to be active after clicking it');
    console.log('PASS: Compose is active after manual navigation');

    console.log('STEP 3: leave Mail (Contacts) and come back — should still show Compose, NOT reset to Inbox');
    // #friendsSubtabBtn/#friendsSubscreen were renamed to #contactsSubtabBtn/
    // #contactsSubscreen when Friends became Contacts (commit 6ae2ac7) — this
    // stray reference just never got updated; unrelated to today's change,
    // fixed in passing, same as manual-mail.js's own identical fix.
    await frame.locator('#contactsSubtabBtn').click();
    await frame.waitForFunction(() => document.getElementById('contactsSubscreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#mailSubtabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
    const stillCompose = await frame.evaluate(() => ({
      compose: document.getElementById('mailBoxComposeSubscreen').classList.contains('active'),
      inbox: document.getElementById('mailBoxInboxSubscreen').classList.contains('active')
    }));
    if (!stillCompose.compose || stillCompose.inbox) {
      throw new Error('Expected the second Mail visit to still show Compose (not reset to Inbox), got: ' + JSON.stringify(stillCompose));
    }
    console.log('PASS: second visit to Mail respects the last-used sub-tab (Compose), does not force back to Inbox');

    console.log('\nALL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
  }
})();
