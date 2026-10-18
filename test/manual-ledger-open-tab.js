// The Open a ledger account panel in the Ledger tab, driven the way a person would: choosing the
// identity and coin, reading what will be sent where, approving the opening and (separately) the
// request for a reference, and recovering from a partial failure.
//
// The issuer is the real Node issuer from this repository, left switched off until the test plays
// the operator; the ledger is the STAND-IN. The browser reaches evtec.co.za through a local HTTPS
// front (see ledger-https-front.js). Nothing here touches a live site.
//
// Run: xvfb-run -a node test/manual-ledger-open-tab.js   (LEDGER_SHOTS=dir saves screenshots)
'use strict';
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const E = require('./call-e2e-lib');
const T = require('./ledger-test-lib');
const L = require('./ledger-issuance-lib');
const { makeCert, front, chromiumArgs } = require('./ledger-https-front');
const { check, sleep } = E;

(async () => {
  const tls = makeCert();
  const core = await L.startCoreStandin();
  const issuer = await L.startIssuer('node', core); // switched off until the test enables it
  const hits = [];
  const fr = await front(issuer.port, core, tls, hits, {});
  const w = await E.launchWallet('open-tab', { args: chromiumArgs(fr.port) });
  const shots = process.env.LEDGER_SHOTS || null;
  try {
    w.pub = (await w.wallet((pw) => AtlasWallet.createIdentity(pw), 'open-tab-password')).publicKey;
    const id = L.derivedId(L.NETWORK, 'GOPH', w.pub);
    const page = await w.context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('chrome-extension://' + w.extId + '/viewer.html');
    await page.waitForFunction(() => typeof routeWalletScreen === 'function' && typeof AtlasWallet !== 'undefined', null, { timeout: 15000 });
    await page.evaluate(() => routeWalletScreen());
    await page.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 10000 });
    await page.click('#ledgerSubtabBtn');
    await page.waitForSelector('#ledgerSubscreen.active');
    await page.waitForFunction(() => /Accounts for Password identity/.test(document.getElementById('ledgerIdentityBanner').innerText));

    const text = (sel) => page.locator(sel).innerText();
    const only = (re) => hits.filter((h) => re.test(h.url));
    const settled = async () => { await sleep(300); await page.waitForFunction(() => !/Talking to|Asking/.test(document.getElementById('ledgerOpenPending').innerText), null, { timeout: 10000 }); };
    const pendingCard = () => page.locator('#ledgerOpenPending .ledger-pending');
    const acctCard = () => page.locator('#ledgerAccountsList .ledger-account', { hasText: 'GOPH' });

    console.log('--- the panel, before anything is on ---');
    check('there is an Open a ledger account heading, marked experimental', /Open a ledger account \(experimental\)/i.test(await text('#ledgerOpenHeading')));
    const intro = await text('#ledgerOpenPanel');
    check('it says what it does, that it is experimental and that nothing is minted, deposited or spent', /experimental test service/.test(intro) && /nothing is minted, deposited or spent/.test(intro) && /no balance is looked up unless you separately allow it/.test(intro), intro);
    check('it says it needs the experimental interface, which is off', /Needs the experimental interface below to be on/.test(intro) && /Turn on the experimental ledger interface first/.test(await text('#ledgerOpenWhy')));
    check('the open button is disabled', await page.$eval('#ledgerOpenBtn', (e) => e.disabled));
    check('the identity is chosen in a labelled group, with the one identity selected', await page.$eval('#ledgerOpenIdentities legend', (e) => /Identity to open the account for/.test(e.textContent)) && (await page.$$('#ledgerOpenIdentities input[type=radio]')).length === 1 && await page.$eval('#ledgerOpenIdentities input[type=radio]', (e) => e.checked) && /Password identity .+ \(in use\)/.test(await text('#ledgerOpenIdentities')));
    check('the coin is chosen in a labelled select with the one supported coin', await page.$eval('label[for=ledgerOpenTarget]', (e) => /Coin/.test(e.textContent)) && JSON.stringify(await page.$$eval('#ledgerOpenTarget option', (os) => os.map((o) => o.textContent))) === '["GOPH on evtec.co.za"]');
    check('no requests have been made', hits.length === 0 && core.callCount() === 0);

    console.log('--- turning the experimental interface on ---');
    await page.click('#ledgerExperimental summary');
    await page.click('#exp-labs29');
    await page.click('#ledgerConfirmOk');
    await page.waitForFunction(() => !document.getElementById('ledgerOpenBtn').disabled, null, { timeout: 8000 });
    check('the open button is now enabled and nothing was sent', hits.length === 0 && /Nothing is sent until you approve/.test(await text('#ledgerOpenWhy')));

    console.log('--- step 1: opening the account ---');
    await page.click('#ledgerOpenBtn');
    let ask = await text('#ledgerConfirmText');
    check('the question names the destination domain and the exact address', ask.includes('evtec.co.za') && ask.includes('https://evtec.co.za/chain-labs/account30.php?action=open'), ask);
    check('...says it is experimental, that the account starts empty and that nothing is spent', /experimental test service/.test(ask) && /empty/.test(ask) && /Nothing is minted, deposited or spent/.test(ask) && /no credential is requested yet/.test(ask));
    check('...and the answer it starts on is Cancel', await page.evaluate(() => document.activeElement && document.activeElement.id === 'ledgerConfirmCancel') && (await text('#ledgerConfirmOk')) === 'Open account');
    await page.click('#ledgerConfirmCancel');
    check('cancelling sends nothing and leaves nothing pending', hits.length === 0 && (await pendingCard().count()) === 0);
    await page.click('#ledgerOpenBtn');
    await page.click('#ledgerConfirmOk');
    await pendingCard().first().waitFor({ timeout: 10000 });
    check('approving opens the account and says so', /Account opened, empty/.test(await text('#ledgerStatus')));
    check('exactly one request was sent, to the open address', hits.length === 1 && hits[0].url === '/chain-labs/account30.php?action=open', hits.map((h) => h.url));
    check('the ledger holds the account', core.holds(w.pub, 'GOPH'));
    let card = await pendingCard().first().innerText();
    check('a note shows the account is open and has no reference yet, and that nothing is held', /GOPH at evtec.co.za: account open, no reference yet/.test(card) && /Nothing is held here yet and no balance has been looked up/.test(card), card);
    check('the account list still has no accounts', /No ledger accounts yet/.test(await text('#ledgerAccountsList')) && (await acctCard().count()) === 0);
    check('the reference was not requested automatically', only(/account-credential/).length === 0);
    if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, 'ledger-open-pending.png') }); }

    console.log('--- step 2: a separate approval for the reference (issuer off) ---');
    await pendingCard().first().locator('button', { hasText: 'Request reference' }).click();
    ask = await text('#ledgerConfirmText');
    check('the second question names the issuer address and the listing address it relays', ask.includes('https://evtec.co.za/atlas/ledger/account-credential') && ask.includes('https://evtec.co.za/chain-labs/accounts31.php?action=accounts'), ask);
    check('...says it is experimental, may be off, checks the signature and revocation, and holds no balance', /experimental/.test(ask) && /switched off/.test(ask) && /revocation list/.test(ask) && /holds no balance/.test(ask));
    await page.click('#ledgerConfirmCancel');
    check('cancelling sends nothing', only(/account-credential/).length === 0);
    await pendingCard().first().locator('button', { hasText: 'Request reference' }).click();
    await page.click('#ledgerConfirmOk');
    await page.waitForFunction(() => /not issuing account references right now/.test(document.getElementById('ledgerStatus').innerText), null, { timeout: 10000 });
    await settled();
    card = await pendingCard().first().innerText();
    check('with the issuer off, the person is told the account stays open and can try again', /Your account stays open; try again when it is/.test(card) && (await pendingCard().first().locator('button', { hasText: 'Try again' }).count()) === 1, card);
    check('one request went to the issuer and none was repeated to the ledger', only(/account-credential/).length === 1 && only(/account30/).length === 1);
    check('nothing was collected', (await acctCard().count()) === 0 && core.holds(w.pub, 'GOPH'));

    console.log('--- the operator enables the issuer; try again ---');
    issuer.enable({ perClientPerMinute: 1000, perOwnerPerHour: 100, globalPerHour: 1000 });
    await pendingCard().first().locator('button', { hasText: 'Try again' }).click();
    await page.click('#ledgerConfirmOk');
    await acctCard().first().waitFor({ timeout: 15000 });
    await page.waitForFunction(() => /holds no balance and nothing has been looked up/.test(document.getElementById('ledgerStatus').innerText) && document.querySelectorAll('#ledgerOpenPending .ledger-pending').length === 0, null, { timeout: 10000 });
    check('the reference appears in the account list and the note is gone', (await acctCard().count()) === 1 && (await pendingCard().count()) === 0);
    check('the status says no balance has been looked up', /holds no balance and nothing has been looked up/.test(await text('#ledgerStatus')));
    check('the retry did not open the account again', only(/account30/).length === 1);
    let acct = await acctCard().innerText();
    check('the new card shows no balance', /Balance not loaded/.test(acct) && !/Reported balance/.test(acct), acct);
    check('lookups are available but not allowed, and background checks are off and unavailable', /Lookup: Available/.test(acct) && /Not allowed yet/.test(acct) && /Background check: Unavailable/.test(acct) && !(await acctCard().locator('input[type=checkbox]').isChecked()) && await acctCard().locator('input[type=checkbox]').isDisabled());
    check('no balance request was made', only(/ledger29/).length === 0);
    await acctCard().locator('button', { hasText: 'Allow lookups' }).click();
    check('a balance lookup is its own, separate question', /look up your GOPH balance/.test(await text('#ledgerConfirmText')) && only(/ledger29/).length === 0);
    await page.click('#ledgerConfirmCancel');
    check('cancelling it leaves the account without permission', only(/ledger29/).length === 0 && (await acctCard().locator('button', { hasText: 'Allow lookups' }).count()) === 1);
    const stored = await w.wallet((i) => AtlasWallet.getLedgerOverview().then((o) => o.accounts.find((a) => a.id === i)), id);
    check('the stored reference has no consent, no balance and background sync off', stored && stored.consent === null && stored.balance === null && stored.backgroundSync === false);
    if (shots) await page.screenshot({ path: path.join(shots, 'ledger-open-collected.png') });

    console.log('--- forgetting a note ---');
    await acctCard().locator('button', { hasText: 'Remove from wallet' }).click();
    await page.click('#ledgerConfirmOk');
    await page.waitForFunction(() => !/GOPH/.test(document.getElementById('ledgerAccountsList').innerText));
    await page.click('#ledgerOpenBtn');
    await page.click('#ledgerConfirmOk');
    await pendingCard().first().waitFor({ timeout: 10000 });
    check('opening after removing the reference finds the same account', /The ledger already had this account/.test(await pendingCard().first().innerText()) && /already had this account/.test(await text('#ledgerStatus')));
    const sentBefore = hits.length;
    await pendingCard().first().locator('button', { hasText: 'Forget this note' }).click();
    check('forgetting says only the note goes and the account stays open', /Only the note on this device is removed/.test(await text('#ledgerConfirmText')) && /stays open at the ledger/.test(await text('#ledgerConfirmText')));
    await page.click('#ledgerConfirmOk');
    await page.waitForFunction(() => document.querySelectorAll('#ledgerOpenPending .ledger-pending').length === 0);
    check('the note is gone, nothing was sent and the ledger account remains', hits.length === sentBefore && core.holds(w.pub, 'GOPH'));

    console.log('--- a passkey identity ---');
    const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const spki = T.b64url(new Uint8Array(await webcrypto.subtle.exportKey('spki', kp.publicKey)));
    await w.wallet(({ spki }) => {
      self.__credCalls = 0;
      Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get: async () => { self.__credCalls++; throw new Error('no authenticator is attached'); } } });
      return chrome.storage.local.set({ atlasWebAuthnIdentity: { credentialId: 'AAAAAAAAAAAAAAAAAAAAAA', publicKey: spki, createdAt: new Date().toISOString() }, atlasIdentityMode: 'webauthn' });
    }, { spki });
    await page.evaluate(() => renderLedger());
    await page.waitForFunction(() => document.querySelectorAll('#ledgerOpenIdentities input[type=radio]').length === 2, null, { timeout: 8000 });
    const idText = await text('#ledgerOpenIdentities');
    check('both identities are listed and the passkey one says the test ledger cannot check its proofs', /Password identity/.test(idText) && /Passkey identity .+ \(in use\)/.test(idText) && /cannot check passkey proofs yet, so no request would be made/.test(idText), idText);
    check('the open button is disabled and the reason is shown', await page.$eval('#ledgerOpenBtn', (e) => e.disabled) && /cannot check this kind of identity/.test(await text('#ledgerOpenWhy')));
    await page.click('#ledgerOpenBtn', { force: true, timeout: 1000 }).catch(() => {});
    check('pressing it anyway asks nothing and sends nothing', (await page.$eval('#ledgerConfirm', (e) => e.hidden)) && hits.length === sentBefore && (await w.wallet(() => self.__credCalls)) === 0);
    if (shots) await page.screenshot({ path: path.join(shots, 'ledger-open-passkey.png') });
    await page.click('#ledger-open-id-local');
    await page.waitForFunction(() => /Password identity .+ \(in use\)/.test(document.getElementById('ledgerOpenIdentities').innerText), null, { timeout: 10000 });
    check('choosing the password identity switches back to it, and opening is available again', !(await page.$eval('#ledgerOpenBtn', (e) => e.disabled)) && (await w.wallet(() => AtlasWallet.getIdentityMode())) === 'local');

    check('the page raised no errors', errors.length === 0, errors);
  } finally {
    await w.close();
    await fr.close();
    issuer.close();
    await core.close();
    fs.rmSync(tls.dir, { recursive: true, force: true });
  }
  process.exit(E.finish('manual-ledger-open-tab'));
})().catch((err) => { console.log('FATAL', err && err.stack || err); process.exit(1); });
