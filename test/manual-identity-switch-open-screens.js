// A screen that is already open when the acting identity changes shows the new identity's data without being reopened:
// the Contacts list on the Social screen, and the Wallet screen's identity line, switched back and forth between the main
// identity and a sub-identity from another extension page (the wallet window). Throw-away identities; nothing contacts a domain.
//
// Run: xvfb-run -a node test/manual-identity-switch-open-screens.js
'use strict';
const L = require('./call-e2e-lib');
const { check, until } = L;

(async () => {
  const w = await L.launchWallet('identity-switch-screens');
  try {
    const main = (await w.wallet((pw) => AtlasWallet.createIdentity(pw), 'identity-switch-screens-password')).publicKey;
    const shopping = await w.wallet(() => AtlasWallet.createSubIdentity('Shopping'));
    const friendKey = await w.wallet(async () => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
      return btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    });

    const page = await w.context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('chrome-extension://' + w.extId + '/viewer.html');
    await page.waitForFunction(() => typeof routeWalletScreen === 'function' && typeof AtlasWallet !== 'undefined', null, { timeout: 15000 });
    await page.evaluate(() => routeWalletScreen());
    await page.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 10000 });

    // The main identity has one contact; Shopping has none.
    await page.evaluate(([k, n]) => AtlasWallet.addFriend(k, n), [friendKey, 'Main Only Friend']);
    const asMain = () => w.wallet(() => AtlasWallet.switchIdentity(null));
    const asShopping = () => w.wallet((id) => AtlasWallet.switchIdentity(id), shopping.id);
    const contacts = () => page.locator('#contactsList').innerText();
    const shows = (re) => page.waitForFunction((s) => new RegExp(s).test(document.getElementById('contactsList').innerText), re.source, { timeout: 8000 }).then(() => true, () => false);

    await page.click('#socialTabBtn');
    await page.click('#contactsSubtabBtn');
    check('the main identity\'s contact is listed', await shows(/Main Only Friend/), await contacts());

    console.log('--- switching from another window while Contacts is open ---');
    for (let round = 1; round <= 3; round++) {
      await asShopping();
      check('round ' + round + ': Shopping\'s contacts replace the main identity\'s', await shows(/No contacts saved yet/) && !/Main Only Friend/.test(await contacts()), await contacts());
      await asMain();
      check('round ' + round + ': the main identity\'s contact returns', await shows(/Main Only Friend/), await contacts());
    }

    console.log('--- the Wallet screen ---');
    await page.click('#walletTabBtn');
    await page.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'));
    await asShopping();
    check('the identity line names Shopping', await page.waitForFunction(() => /^Shopping/.test(document.getElementById('walletIdentity').textContent), null, { timeout: 8000 }).then(() => true, () => false), await page.locator('#walletIdentity').innerText());
    await asMain();
    check('and the main identity again', await page.waitForFunction(() => !/^Shopping/.test(document.getElementById('walletIdentity').textContent) && /Identity: /.test(document.getElementById('walletIdentity').textContent), null, { timeout: 8000 }).then(() => true, () => false), await page.locator('#walletIdentity').innerText());
    check('no page errors in the wallet page', errors.length === 0, errors);
  } finally {
    await w.close();
  }
  process.exit(L.finish('manual-identity-switch-open-screens'));
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
