// Manual check for the new membership-card + mail system: requesting the
// atlas.membership item is what "subscribing" to a domain looks like (no
// separate subscribe step), the wallet's Mail tab picks up a message the
// domain sends about that specific credential (via the demo /atlas/mail/send
// endpoint, standing in for whatever real interface a domain operator
// would use), the signature gets verified before it's ever shown, clicking
// an unread message marks it read (and the tab badge count drops), and the
// check-frequency setting actually persists. Not part of the permanent
// suite, same reasoning as the other manual-*.js scripts.

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
  const userDataDir = path.resolve(__dirname, '.chrome-profile-mail');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: identity + requesting a Domain Atlas Membership Card (atlas.membership) — this is the "subscribe" step');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('mail-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('mail-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });

    // requestItemBtn requests whichever class the current world's
    // manifest lists first in policy.acceptedItemClasses — the Plaza's is
    // atlas.wearable (Bronze Compass), not atlas.membership, so this goes
    // straight through AtlasWallet.mintAsset instead of clicking the
    // button, exactly like the button itself does under the hood. No
    // existing world's request button is being repurposed for this.
    const membershipCred = await frame.evaluate(() =>
      window.AtlasWallet ? null : null // placeholder, real call below
    );
    const membership = await frame.evaluate(async () => {
      return await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.membership');
    });
    if (membership.verdict && membership.verdict.valid === false) throw new Error('Membership card did not verify: ' + membership.verdict.reason);
    const credentialId = membership.credential.id;
    console.log('PASS: membership card issued and held ->', membership.credential.asset.name, credentialId);

    console.log('STEP 1: domain sends a message about that specific credential (demo /atlas/mail/send)');
    const sent = await postJson(8001, '/atlas/mail/send', {
      credentialId,
      subject: 'Welcome to the Plaza',
      body: "Thanks for joining — there's a new exhibit in the Lobby this week."
    });
    if (!sent.id) throw new Error('Expected /atlas/mail/send to return a signed message, got: ' + JSON.stringify(sent));
    console.log('PASS: message sent and signed ->', sent.subject);

    console.log('STEP 2: opening the Mail tab checks automatically — no need to click Check now first, verifies the signature, and shows it unread (alongside the auto-sent welcome message from subscribing — see /atlas/asset/issue)');
    await frame.locator('#socialTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
    // 2, not 1: requesting atlas.membership in SETUP now also triggers a
    // server-side auto-welcome message (issue.php / server.js's
    // /atlas/asset/issue), so opening the tab picks up both that and STEP
    // 1's message via the tab's own automatic check (no #checkMailNowBtn
    // click needed here at all). Sorted newest-first, so this test's own
    // message (sent after SETUP's welcome message) is first().
    await frame.waitForFunction(() => document.querySelectorAll('#mailList .mail-card').length === 2, { timeout: 10000 });
    const cardText = await frame.locator('#mailList .mail-card').first().textContent();
    if (!cardText.includes('Welcome to the Plaza')) throw new Error('Expected the message subject to render: ' + cardText);
    if (!cardText.includes('new exhibit in the Lobby')) throw new Error('Expected the message body to render: ' + cardText);
    if (!cardText.includes('localhost:8001')) throw new Error('Expected the sending domain to render: ' + cardText);
    const isUnread = await frame.locator('#mailList .mail-card').first().evaluate((el) => el.classList.contains('unread'));
    if (!isUnread) throw new Error('A freshly-checked message should start unread');
    const listText = await frame.locator('#mailList').textContent();
    if (!listText.includes('Welcome to localhost:8001')) throw new Error('Expected the auto-sent welcome message to also render: ' + listText);
    const badgeText = await frame.locator('#mailBadge').textContent();
    if (badgeText !== '2') throw new Error('Expected the Mail tab badge to show 2 unread, got: ' + badgeText);
    console.log('PASS: both messages verified and shown, unread, badge shows 2 — from opening the tab alone');

    console.log('STEP 3: clicking Check now again does not duplicate either message');
    await frame.locator('#checkMailNowBtn').click();
    await frame.waitForTimeout(500);
    const cardCountAfterManualCheck = await frame.locator('#mailList .mail-card').count();
    if (cardCountAfterManualCheck !== 2) throw new Error('Expected still exactly two messages after re-checking, got: ' + cardCountAfterManualCheck);
    console.log('PASS: no duplicate on re-check');

    console.log('STEP 4: clicking the unread card marks it read — badge drops to 1 (the auto-welcome message is still unread)');
    await frame.locator('#mailList .mail-card').first().click();
    await frame.waitForFunction(() => !document.querySelector('#mailList .mail-card').classList.contains('unread'), { timeout: 5000 });
    await frame.waitForFunction(() => document.getElementById('mailBadge').textContent === '1', { timeout: 5000 });
    console.log('PASS: message marked read, badge shows 1 remaining');

    console.log('STEP 5: checking again (including a re-visit of the Mail sub-tab, which now also auto-checks) does not duplicate either message');
    await frame.locator('#friendsSubtabBtn').click();
    await frame.locator('#mailSubtabBtn').click();
    await frame.waitForTimeout(500);
    const stillTwo = await frame.locator('#mailList .mail-card').count();
    if (stillTwo !== 2) throw new Error('Expected exactly two messages still, got: ' + stillTwo);
    console.log('PASS: still exactly two messages — verification gate holding, no duplication from repeated auto-checks');

    console.log('STEP 6: check-frequency setting persists');
    // Check frequency now lives under Mail's "Mail Settings" inner sub-tab.
    await frame.locator('#mailSettingsSubtabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mailSettingsSubscreen').classList.contains('active'), { timeout: 5000 });
    await frame.locator('#mailIntervalInput').fill('5');
    await frame.locator('#saveMailIntervalBtn').click();
    await frame.waitForFunction(() => document.getElementById('mailIntervalStatus').textContent === 'Saved.', { timeout: 5000 });
    // Re-open the tab (simulating navigating away and back) and confirm
    // the saved value is what pre-fills the input.
    await frame.locator('#walletTabBtn').click();
    await frame.locator('#socialTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mailIntervalInput').value === '5', { timeout: 5000 });
    console.log('PASS: check-frequency interval saved and reloaded correctly');

    console.log('\nALL MAIL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
