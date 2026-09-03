// Manual check for task #59: a mail message carrying an attached asset
// gift, claimed via an explicit button rather than auto-added — the
// design fork the user picked over silently adding it to the wallet the
// moment mail is checked (see extension/wallet.js's claimMailGift() and
// viewer.js's renderMailCard() for the actual implementation this proves).
//
// Builds on the exact setup manual-mail.js already uses (identity,
// subscribe to get a credentialId to attach mail to) and layers the gift
// checks on top:
//   1. /atlas/mail/send accepts giftAssetClass/giftOwnerPublicKey and
//      returns a message whose attachedAsset is a real, correctly-shaped
//      signed credential.
//   2. Checking mail surfaces the gift message with a Claim button naming
//      the gift — and the badge is NOT auto-added to the wallet just from
//      checking (the whole point of the explicit-Claim design).
//   3. Clicking Claim adds the credential to the wallet and flips the card
//      to a static "(claimed)" indicator, no more button.
//   4. Re-checking mail / re-rendering does not duplicate the wallet entry
//      or re-offer the Claim button.
//   5. Calling claimMailGift() again directly (bypassing the now-removed
//      button) is rejected — "already been claimed" — so there's no way
//      to double-claim even by going around the UI.
//
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
  const userDataDir = path.resolve(__dirname, '.chrome-profile-mail-gift');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  try {
    const page = await context.newPage();

    console.log('SETUP: identity + requesting a Domain Atlas Membership Card (atlas.membership) — this is the "subscribe" step, same as manual-mail.js');
    await page.goto('http://localhost:8001', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });
    await frame.locator('#walletBtn').click();
    await frame.locator('#chooseNewBtn').click();
    await frame.locator('#newPasswordInput').fill('mail-gift-test-password');
    await frame.locator('#newPasswordConfirmInput').fill('mail-gift-test-password');
    await frame.locator('#confirmCreateBtn').click();
    await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), { timeout: 5000 });
    await frame.locator('#seedConfirmCheck').check();
    await frame.locator('#seedConfirmBtn').click();
    await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), { timeout: 5000 });

    const membership = await frame.evaluate(async () => {
      return await AtlasWallet.mintAsset('self', 'localhost:8001', 'atlas.membership');
    });
    if (membership.verdict && membership.verdict.valid === false) throw new Error('Membership card did not verify: ' + membership.verdict.reason);
    const credentialId = membership.credential.id;
    const ownerPublicKey = membership.credential.owner.publicKey;
    console.log('PASS: membership card issued and held ->', membership.credential.asset.name, credentialId);

    console.log('STEP 1: domain sends a message with an attached gift (giftAssetClass on /atlas/mail/send)');
    const sent = await postJson(8001, '/atlas/mail/send', {
      credentialId,
      subject: 'A little gift',
      body: "Here's something for being an early visitor.",
      giftAssetClass: 'atlas.badge',
      giftOwnerPublicKey: ownerPublicKey
    });
    if (!sent.id) throw new Error('Expected /atlas/mail/send to return a signed message, got: ' + JSON.stringify(sent));
    if (!sent.attachedAsset || sent.attachedAsset.credential !== 'domain-atlas-asset/1.0') {
      throw new Error('Expected the message to carry a real attachedAsset credential, got: ' + JSON.stringify(sent));
    }
    if (sent.attachedAsset.asset.name !== 'Plaza Visitor Badge' || sent.attachedAsset.owner.publicKey !== ownerPublicKey) {
      throw new Error('Expected the attached gift to be a Plaza Visitor Badge owned by this identity, got: ' + JSON.stringify(sent.attachedAsset));
    }
    console.log('PASS: message sent, signed, and carrying a real gift credential ->', sent.attachedAsset.asset.name);

    console.log('STEP 2: checking mail surfaces the gift message with a Claim button, and the badge is NOT auto-added to the wallet');
    await frame.locator('#socialTabBtn').click();
    await frame.locator('#checkMailNowBtn').click();
    // 2 messages: this test's gift message + the auto-sent welcome message from subscribing.
    await frame.waitForFunction(() => document.querySelectorAll('#mailList .mail-card').length === 2, { timeout: 10000 });
    const giftCard = frame.locator('#mailList .mail-card', { hasText: 'A little gift' });
    const giftCardText = await giftCard.textContent();
    if (!giftCardText.includes('Gift: Plaza Visitor Badge')) throw new Error('Expected the gift card to name the gift: ' + giftCardText);
    const claimBtnCount = await giftCard.locator('button[data-action="claim-gift"]').count();
    if (claimBtnCount !== 1) throw new Error('Expected exactly one Claim button on the gift card, got: ' + claimBtnCount);

    const walletBeforeClaim = await frame.evaluate(async (pk) => {
      const wallet = await AtlasWallet.getWallet(pk);
      return wallet.filter((e) => e.credential.asset.class === 'atlas.badge').length;
    }, ownerPublicKey);
    if (walletBeforeClaim !== 0) throw new Error('Expected the badge to NOT be in the wallet before claiming, found ' + walletBeforeClaim);
    console.log('PASS: gift message shown with a Claim button, badge not yet in the wallet');

    console.log('STEP 3: clicking Claim adds the credential to the wallet and the card flips to a static "(claimed)" indicator');
    await giftCard.locator('button[data-action="claim-gift"]').click();
    await frame.waitForFunction(() => document.getElementById('status').textContent.includes('Claimed Plaza Visitor Badge'), { timeout: 5000 });
    await frame.waitForFunction(() => {
      const cards = Array.from(document.querySelectorAll('#mailList .mail-card'));
      const card = cards.find((c) => c.textContent.includes('A little gift'));
      return card && card.textContent.includes('(claimed)') && !card.querySelector('button[data-action="claim-gift"]');
    }, { timeout: 5000 });
    const walletAfterClaim = await frame.evaluate(async (pk) => {
      const wallet = await AtlasWallet.getWallet(pk);
      return wallet.filter((e) => e.credential.asset.class === 'atlas.badge').length;
    }, ownerPublicKey);
    if (walletAfterClaim !== 1) throw new Error('Expected exactly one badge in the wallet after claiming, found ' + walletAfterClaim);
    console.log('PASS: badge added to the wallet, card shows "(claimed)" with no more button');

    console.log('STEP 4: re-checking mail does not duplicate the message, re-offer the Claim button, or double-add the wallet entry');
    await frame.locator('#checkMailNowBtn').click();
    await frame.waitForTimeout(500);
    const cardCountAfterRecheck = await frame.locator('#mailList .mail-card').count();
    if (cardCountAfterRecheck !== 2) throw new Error('Expected still exactly two messages after re-checking, got: ' + cardCountAfterRecheck);
    const claimBtnAfterRecheck = await frame.locator('#mailList .mail-card', { hasText: 'A little gift' }).locator('button[data-action="claim-gift"]').count();
    if (claimBtnAfterRecheck !== 0) throw new Error('Expected the Claim button to stay gone after re-checking mail');
    const walletAfterRecheck = await frame.evaluate(async (pk) => {
      const wallet = await AtlasWallet.getWallet(pk);
      return wallet.filter((e) => e.credential.asset.class === 'atlas.badge').length;
    }, ownerPublicKey);
    if (walletAfterRecheck !== 1) throw new Error('Expected still exactly one badge in the wallet after re-checking, found ' + walletAfterRecheck);
    console.log('PASS: no duplication on re-check');

    console.log('STEP 5: calling claimMailGift() again directly (bypassing the UI, which no longer offers the button) is rejected');
    const doubleClaimError = await frame.evaluate(async (pk) => {
      try {
        await AtlasWallet.claimMailGift(pk, Array.from(document.querySelectorAll('#mailList .mail-card')).find((c) => c.textContent.includes('A little gift')).dataset.id);
        return null;
      } catch (err) {
        return err.message;
      }
    }, ownerPublicKey);
    if (!doubleClaimError || !doubleClaimError.includes('already been claimed')) {
      throw new Error('Expected a second claim attempt to be rejected as already claimed, got: ' + doubleClaimError);
    }
    console.log('PASS: double-claim rejected ->', doubleClaimError);

    console.log('\nALL MAIL-GIFT CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
})();
