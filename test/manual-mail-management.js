// Manual check for mail management (#58): deleting a single message,
// "Mark all read", and "Clear all" — none of which existed before (the
// Mail tab could only read a message by clicking it). The one real trap
// here is that checkAllMail() dedupes against ids already in the stored
// mail array, so deleting a message takes it OUT of that array and it
// would just come back on the next check unless deletions are tracked
// separately (see getDeletedMailIds/addDeletedMailIds in wallet.js) — this
// test specifically re-checks after deleting to prove that doesn't happen.
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');
const http = require('http');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

function postJson(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: 'localhost', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(chunks)); } catch (err) { reject(err); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  const userDataDir = path.resolve(__dirname, '.chrome-profile-mail-mgmt');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: identity, subscribe (auto-welcome mail), plus a second manual message — two messages total after Check now');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('mail-mgmt-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('mail-mgmt-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });

    const membership = await frame.evaluate(async () => {
      return await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.membership');
    });
    const credentialId = membership.credential.id;
    await postJson(8001, '/atlas/mail/send', { credentialId, subject: 'Second message', body: 'Just checking mail management works.' });

    await frame.locator('#socialTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#checkMailNowBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#mailList .mail-card').length === 2, { timeout: 10000 });
    console.log('PASS: two messages present (auto-welcome + the manual one), both unread');

    console.log('STEP 1: "Mark all read" clears the badge without opening either message');
    const badgeBefore = await frame.locator('#mailBadge').textContent();
    if (badgeBefore !== '2') throw new Error('Expected badge to show 2 before marking all read, got: ' + badgeBefore);
    await frame.locator('#markAllMailReadBtn').click();
    await frame.waitForFunction(() => !document.getElementById('mailBadge').classList.contains('show'), { timeout: 5000 });
    const stillTwoCards = await frame.locator('#mailList .mail-card').count();
    if (stillTwoCards !== 2) throw new Error('Mark all read should not remove any messages, got: ' + stillTwoCards);
    const anyUnread = await frame.locator('#mailList .mail-card.unread').count();
    if (anyUnread !== 0) throw new Error('Expected no .unread cards left after marking all read, got: ' + anyUnread);
    console.log('PASS: badge cleared, both messages marked read, neither was removed');

    console.log('STEP 2: deleting a single message asks for confirmation, then removes just that one');
    const deletedSubject = await frame.locator('#mailList .mail-card').first().locator('.mail-subject').textContent();
    page.once('dialog', (d) => d.accept());
    await frame.locator('#mailList .mail-card').first().locator('button[data-action="delete"]').click();
    await frame.waitForFunction(() => document.querySelectorAll('#mailList .mail-card').length === 1, { timeout: 5000 });
    const remainingText = await frame.locator('#mailList').textContent();
    if (remainingText.includes(deletedSubject)) throw new Error('Deleted message subject should no longer render: ' + deletedSubject);
    console.log('PASS: exactly one message deleted ->', deletedSubject);

    console.log('STEP 3: checking mail again does NOT bring the deleted message back');
    await frame.locator('#checkMailNowBtn').click();
    await frame.waitForTimeout(500);
    const countAfterRecheck = await frame.locator('#mailList .mail-card').count();
    if (countAfterRecheck !== 1) throw new Error('Deleted message resurfaced on re-check — expected 1, got: ' + countAfterRecheck);
    console.log('PASS: deleted message stays gone across a fresh check (deleted-ids tracking holding)');

    console.log('STEP 4: "Clear all" asks for confirmation, then removes everything');
    page.once('dialog', (d) => d.accept());
    await frame.locator('#clearAllMailBtn').click();
    await frame.waitForFunction(() => document.getElementById('mailList').textContent.includes('No mail yet'), { timeout: 5000 });
    console.log('PASS: all messages cleared');

    console.log('STEP 5: checking mail again does NOT bring anything back after Clear all either');
    await frame.locator('#checkMailNowBtn').click();
    await frame.waitForTimeout(500);
    const stillEmpty = await frame.locator('#mailList').textContent();
    if (!stillEmpty.includes('No mail yet')) throw new Error('Expected mail to stay empty after Clear all + re-check: ' + stillEmpty);
    const badgeAfterClear = await frame.locator('#mailBadge').textContent();
    if (badgeAfterClear !== '0') throw new Error('Expected badge to show 0 after Clear all, got: ' + badgeAfterClear);
    console.log('PASS: mail stays cleared, badge shows 0');

    console.log('\nALL MAIL MANAGEMENT CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
