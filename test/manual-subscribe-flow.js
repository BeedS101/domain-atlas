// Manual check for the Subscribe button (Mail tab) and the subscriber
// roster it feeds: a visitor should be able to get a domain's membership
// card without any of the existing per-world "Request item" wiring, the
// button should disappear once they already hold one, subscribing should
// auto-send a welcome message with no admin action needed, and the server
// should privately log the subscription (credential id + owner public key)
// so a domain operator has something to actually message later — this is
// the exact flow the earlier mail-system test (manual-mail.js) deliberately
// bypassed by calling AtlasWallet.mintAsset() directly. This test instead
// drives the real button, so the actual UI + server path a visitor and
// operator would hit gets exercised end to end. Not part of the permanent
// suite, same reasoning as the other manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');
const http = require('http');
const fs = require('fs');

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
  const userDataDir = path.resolve(__dirname, '.chrome-profile-subscribe');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: identity, no membership card yet');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('subscribe-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('subscribe-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });
    console.log('PASS: identity ready, no membership card');

    console.log('STEP 1: Mail tab shows a visible Subscribe section naming the current domain');
    await frame.locator('#socialTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
    await frame.waitForFunction(() => {
      const section = document.getElementById('subscribeSection');
      return section && !section.hidden;
    }, { timeout: 5000 });
    const subscribeLabel = await frame.locator('#subscribeBtn').textContent();
    if (!subscribeLabel.includes('localhost:8001')) throw new Error('Expected the Subscribe button to name the current domain: ' + subscribeLabel);
    console.log('PASS: Subscribe section visible ->', subscribeLabel);

    console.log('STEP 2: clicking Subscribe issues a membership card and the whole section disappears (not just the button — see #56)');
    await frame.locator('#subscribeBtn').click();
    await frame.waitForFunction(() => {
      const section = document.getElementById('subscribeSection');
      return section && section.hidden;
    }, { timeout: 10000 });
    const membershipCount = await frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      return wallet.filter((e) => e.credential.asset.class === 'atlas.membership').length;
    });
    if (membershipCount !== 1) throw new Error('Expected exactly one membership card in the wallet, got: ' + membershipCount);
    console.log('PASS: membership card issued, Subscribe section hidden');

    console.log('STEP 3: leaving and re-opening the Mail tab keeps the section hidden (state persists, not just a one-time UI flip)');
    await frame.locator('#walletTabBtn').click();
    await frame.locator('#socialTabBtn').click();
    await frame.waitForFunction(() => document.getElementById('mailSubscreen').classList.contains('active'), { timeout: 5000 });
    const stillHidden = await frame.locator('#subscribeSection').isHidden();
    if (!stillHidden) throw new Error('Expected Subscribe section to stay hidden across tab navigation');
    console.log('PASS: Subscribe section stays hidden');

    const credentialId = await frame.evaluate(async () => {
      const identity = await AtlasWallet.getIdentity();
      const wallet = await AtlasWallet.getWallet(identity.publicKey);
      return wallet.find((e) => e.credential.asset.class === 'atlas.membership').credential.id;
    });

    console.log('STEP 4: /atlas/asset/issue auto-sends a welcome message on subscribe — Check now picks it up with no admin action needed');
    await frame.locator('#checkMailNowBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#mailList .mail-card').length === 1, { timeout: 10000 });
    const welcomeText = await frame.locator('#mailList .mail-card').first().textContent();
    if (!welcomeText.includes('Welcome to localhost:8001')) throw new Error('Expected an auto-sent welcome message: ' + welcomeText);
    console.log('PASS: welcome message arrived automatically ->', welcomeText.split('\n')[0]);

    console.log('STEP 5: a second, manually-sent message for the same credential shows up alongside the welcome message');
    const sent = await postJson(8001, '/atlas/mail/send', {
      credentialId,
      subject: 'Thanks for subscribing',
      body: 'Real button, real membership card, real mail.'
    });
    if (!sent.id) throw new Error('Expected /atlas/mail/send to return a signed message, got: ' + JSON.stringify(sent));
    await frame.locator('#checkMailNowBtn').click();
    await frame.waitForFunction(() => document.querySelectorAll('#mailList .mail-card').length === 2, { timeout: 10000 });
    const listText = await frame.locator('#mailList').textContent();
    if (!listText.includes('Thanks for subscribing')) throw new Error('Expected the second message to render: ' + listText);
    console.log('PASS: both the welcome message and the follow-up message are present');

    console.log('STEP 6: the server actually logged this subscription in its (private, non-web-reachable) subscriber roster');
    const rosterPath = path.resolve(__dirname, '..', 'issuer-server', 'atlas-subscribers-store.json');
    const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
    const rosterEntry = roster.subscribers.find((s) => s.credentialId === credentialId);
    if (!rosterEntry) throw new Error('Expected a subscriber roster entry for ' + credentialId + ', got: ' + JSON.stringify(roster));
    if (!rosterEntry.ownerPublicKey || !rosterEntry.subscribedAt) throw new Error('Roster entry missing expected fields: ' + JSON.stringify(rosterEntry));
    console.log('PASS: subscriber roster recorded the subscription ->', rosterEntry.credentialId);

    console.log('\nALL SUBSCRIBE-FLOW CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
