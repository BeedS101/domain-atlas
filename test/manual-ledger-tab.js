// The Ledger sub-tab in the wallet page, driven the way a person would: adding an account,
// allowing lookups, the capability indicators, the background switch, and removing a reference.
//
// The issuer and the ledger are local test doubles (test/ledger-test-lib.js); the ledger is a
// SIMULATION with an invented request shape. This checks the wallet's own screen and rules.
//
// Needs no demo domain. Run: xvfb-run -a node test/manual-ledger-tab.js
'use strict';
const path = require('path');
const fs = require('fs');
const L = require('./call-e2e-lib');
const T = require('./ledger-test-lib');
const { check, until, sleep } = L;

(async () => {
  const issuer = await T.startIssuer();
  const ledger = await T.startLedger();
  issuer.state.endpoint = ledger.origin;
  const w = await L.launchWallet('ledger-tab');
  const NET = 'test-network-1';
  const shots = process.env.LEDGER_SHOTS || null;
  try {
    w.pub = (await w.wallet((pw) => AtlasWallet.createIdentity(pw), 'ledger-tab-password')).publicKey;
    const page = await w.context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('chrome-extension://' + w.extId + '/viewer.html');
    await page.waitForFunction(() => typeof routeWalletScreen === 'function' && typeof AtlasWallet !== 'undefined', null, { timeout: 15000 });
    await page.evaluate(() => routeWalletScreen());
    await page.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 10000 });

    const card = (coin) => page.locator('#ledgerAccountsList .ledger-account', { hasText: coin });
    const calls = () => ledger.state.requests.length;
    const openLedger = async () => { await page.click('#ledgerSubtabBtn'); await page.waitForSelector('#ledgerSubscreen.active'); };
    const text = (sel) => page.locator(sel).innerText();

    console.log('--- the tab beside Collectibles and Documents ---');
    const labels = await page.$$eval('#inventorySubtabBar button', (bs) => bs.map((b) => b.textContent.trim()));
    check('Ledger is a third sub-tab after Collectibles and Documents', JSON.stringify(labels) === JSON.stringify(['Collectibles', 'Documents', 'Ledger']), labels);
    check('Collectibles is still the one showing at first', await page.$eval('#collectiblesSubscreen', (e) => e.classList.contains('active')) && !(await page.$eval('#ledgerSubscreen', (e) => e.classList.contains('active'))));
    await openLedger();
    check('opening Ledger shows only the ledger sub-screen and marks its button', await page.$eval('#ledgerSubscreen', (e) => e.classList.contains('active')) && !(await page.$eval('#collectiblesSubscreen', (e) => e.classList.contains('active'))) && await page.$eval('#ledgerSubtabBtn', (e) => e.classList.contains('active-subtab')));
    await page.click('#documentsSubtabBtn');
    check('Documents still opens as before', await page.$eval('#documentsSubscreen', (e) => e.classList.contains('active')) && !(await page.$eval('#ledgerSubscreen', (e) => e.classList.contains('active'))) && await page.$eval('#documentsSubtabBtn', (e) => e.classList.contains('active-subtab')) && !(await page.$eval('#ledgerSubtabBtn', (e) => e.classList.contains('active-subtab'))));
    await page.click('#collectiblesSubtabBtn');
    check('Collectibles still opens as before', await page.$eval('#collectiblesSubscreen', (e) => e.classList.contains('active')));
    await openLedger();
    await page.waitForFunction(() => /Accounts for Password identity/.test(document.getElementById('ledgerIdentityBanner').innerText));
    check('the tab names the identity whose accounts it shows', /Accounts for Password identity/.test(await text('#ledgerIdentityBanner')));
    check('with nothing added the list says so', /No ledger accounts yet/.test(await text('#ledgerAccountsList')));
    check('the page says balances live on the ledger, not in the wallet', /kept by the ledger that issued it/.test(await text('#ledgerExplainer')));
    check('finding accounts is disabled, with the reason, while no ledger interface is installed', await page.$eval('#ledgerFindBtn', (e) => e.disabled) && /no ledger service interface installed/.test(await text('#ledgerFindNote')));

    console.log('--- adding an account ---');
    const gop = await issuer.issue(w.pub, { network: NET, coin: 'GOPH' });
    const mwc = await issuer.issue(w.pub, { network: NET, coin: 'MWC' });
    await page.fill('#ledgerCredentialInput', 'not json');
    await page.click('#ledgerAddBtn');
    check('text that is not JSON is rejected on the spot', /not valid JSON/.test(await text('#ledgerStatus')) && issuer.state.requests.length === 0);
    await page.fill('#ledgerCredentialInput', JSON.stringify(Object.assign({}, gop, { balance: '500' })));
    await page.click('#ledgerAddBtn');
    check('a credential with a balance is rejected on the spot, before any request', /must not carry a balance/.test(await text('#ledgerStatus')) && issuer.state.requests.length === 0);
    await page.fill('#ledgerCredentialInput', JSON.stringify(gop));
    await page.click('#ledgerAddBtn');
    check('adding asks first, naming the domain that will be contacted', !(await page.$eval('#ledgerConfirm', (e) => e.hidden)) && (await text('#ledgerConfirmText')).includes(issuer.domain) && issuer.state.requests.length === 0);
    check('the question starts on its safe answer', await page.evaluate(() => document.activeElement && document.activeElement.id === 'ledgerConfirmCancel'));
    await page.click('#ledgerConfirmCancel');
    check('cancelling adds nothing and sends nothing', (await page.$$('#ledgerAccountsList .ledger-account')).length === 0 && issuer.state.requests.length === 0);
    await page.click('#ledgerAddBtn');
    await page.click('#ledgerConfirmOk');
    await card('GOPH').waitFor({ timeout: 8000 });
    check('after agreeing the account appears', (await card('GOPH').count()) === 1);
    check('only the issuing domain was contacted to check it', calls() === 0 && issuer.state.requests.every((q) => /well-known\/atlas-(key|revocations)/.test(q)));
    await page.fill('#ledgerCredentialInput', JSON.stringify(mwc));
    await page.click('#ledgerAddBtn'); await page.click('#ledgerConfirmOk');
    await card('MWC').waitFor({ timeout: 8000 });
    check('a second account sits beside the first', (await page.$$('#ledgerAccountsList .ledger-account')).length === 2);

    console.log('--- what a new card says ---');
    let t = await card('GOPH').innerText();
    check('the card names the coin, network, issuer and a shortened owner', /GOPH/.test(t) && t.includes(NET) && t.includes(issuer.domain) && /owner .{6}…/.test(t));
    check('it says the balance is not loaded rather than showing zero', /Balance not loaded/.test(t) && !/Reported balance: 0/.test(t));
    check('with no ledger interface the lookup is marked unavailable, in words', /Lookup: Unavailable/.test(t) && /no way to reach this ledger/.test(t));
    check('the background check is unavailable as well', /Background check: Unavailable/.test(t));
    check('the background switch is off and cannot be used yet', !(await card('GOPH').locator('input[type=checkbox]').isChecked()) && await card('GOPH').locator('input[type=checkbox]').isDisabled());
    check('there is no Allow lookups button while nothing can be reached', (await card('GOPH').locator('button', { hasText: 'Allow lookups' }).count()) === 0);

    console.log('--- a ledger interface becomes available ---');
    await page.evaluate(T.installSimulatedAdapter, {});
    await page.waitForFunction(() => /Lookup: Available/.test(document.querySelector('#ledgerAccountsList .ledger-account').innerText));
    t = await card('GOPH').innerText();
    check('lookup is now marked available, and says it is not allowed yet', /Lookup: Available/.test(t) && /Not allowed yet/.test(t));
    check('the background check is still unavailable until lookups are allowed', /Background check: Unavailable/.test(t) && /Allow checking this account first/.test(t));
    check('finding accounts is now enabled', !(await page.$eval('#ledgerFindBtn', (e) => e.disabled)));
    check('the three levels are told apart by a glyph and a word, not by colour alone', await page.$$eval('#ledgerAccountsList .ledger-ind', (els) => els.every((e) => e.querySelector('.ledger-glyph[aria-hidden="true"]') && /: (Unavailable|Available|Enabled|Connecting)$/.test(e.textContent))));
    check('every indicator also carries its explanation as visible text', await page.$$eval('#ledgerAccountsList .ledger-account', (cs) => cs.every((c) => c.querySelectorAll('.ledger-detail').length === 2)));
    check('the cards and the status line are exposed to assistive technology', await page.$eval('#ledgerStatus', (e) => e.getAttribute('role') === 'status' && e.getAttribute('aria-live') === 'polite') && await page.$$eval('#ledgerAccountsList .ledger-account', (cs) => cs.every((c) => c.getAttribute('role') === 'group' && /\bat\b/.test(c.getAttribute('aria-label')))));

    console.log('--- allowing lookups ---');
    const before = calls();
    await card('GOPH').locator('button', { hasText: 'Allow lookups' }).click();
    t = await text('#ledgerConfirmText');
    check('the question names the domain, says it follows the ledger address, and that background checks stay off', t.includes(issuer.domain) && /ledger address it names/.test(t) && /Background checks stay off/.test(t));
    await page.click('#ledgerConfirmCancel');
    check('cancelling leaves the account as it was, and sends nothing', calls() === before && /Lookup: Available/.test(await card('GOPH').innerText()));
    ledger.open(w.pub, NET, 'GOPH', '1250', 2);
    await card('GOPH').locator('button', { hasText: 'Allow lookups' }).click();
    await page.click('#ledgerConfirmOk');
    await page.waitForFunction(() => /Reported balance: 12\.50/.test(document.querySelector('#ledgerAccountsList .ledger-account').innerText), null, { timeout: 10000 });
    t = await card('GOPH').innerText();
    check('allowing lookups fetches the balance once, and shows it with the ledger\'s time', /Reported balance: 12\.50/.test(t) && /as the ledger reported at/.test(t));
    check('lookup is now enabled, background check available but off', /Lookup: Enabled/.test(t) && /Background check: Available/.test(t));
    check('the balance is labelled Reported \u2014 Not Cryptographically Verified, in text', (await card('GOPH').locator('.ledger-verify').innerText()) === 'Reported \u2014 Not Cryptographically Verified');
    check('the label is explained: not final or spendable, nothing signed behind it', /not a final or spendable balance/.test(await card('GOPH').locator('[data-role=verification]').innerText()) && /Nothing signed/.test(await card('GOPH').locator('[data-role=verification]').innerText()));
    check('no wording on the card calls the figure available, final or spendable funds', !/\b(available balance|spendable balance|funds)\b/i.test(t.replace(/not a final or spendable balance/i, '')), t);
    check('a card with no balance has no verification label to mislead', (await card('MWC').locator('.ledger-verify').count()) === 0);
    check('the second account, never allowed, was not contacted', (await card('MWC').innerText()).includes('Balance not loaded') && !ledger.state.seenPayloads.some((p) => p.coin === 'MWC'));
    check('background checks are off by default', !(await card('GOPH').locator('input[type=checkbox]').isChecked()) && !(await card('GOPH').locator('input[type=checkbox]').isDisabled()));

    console.log('--- background checks are a separate choice ---');
    await card('GOPH').locator('input[type=checkbox]').check();
    await page.waitForFunction(() => /Background check: Enabled/.test(document.querySelector('#ledgerAccountsList .ledger-account').innerText));
    t = await card('GOPH').innerText();
    check('turning the switch on marks the background check enabled and says when it runs', /Background check: Enabled/.test(t) && /while the wallet is open/.test(t));
    check('the MWC card is unaffected by the GOPH switch', !(await card('MWC').locator('input[type=checkbox]').isChecked()));
    check('the switch is a labelled checkbox', await card('GOPH').locator('label.check-row').innerText().then((s) => /Keep this balance up to date/.test(s)));

    console.log('--- opening the tab looks up only what was allowed ---');
    ledger.open(w.pub, NET, 'GOPH', '2000', 2);
    await page.click('#documentsSubtabBtn');
    await sleep(31000); // the wallet skips a lookup made within the last 30 seconds
    const preOpen = calls();
    await page.click('#ledgerSubtabBtn');
    await page.waitForFunction(() => /Reported balance: 20\.00/.test(document.querySelector('#ledgerAccountsList .ledger-account').innerText), null, { timeout: 10000 });
    check('re-opening the tab refreshed the allowed account', /Reported balance: 20\.00/.test(await card('GOPH').innerText()) && calls() === preOpen + 1);
    check('and still did not contact the account that was never allowed', !ledger.state.seenPayloads.some((p) => p.coin === 'MWC'));
    await page.click('#documentsSubtabBtn'); await page.click('#ledgerSubtabBtn');
    await sleep(500);
    check('re-opening again within 30 seconds does not repeat the lookup', calls() === preOpen + 1);

    console.log('--- connecting is shown while a request is out ---');
    ledger.state.delayMs = 2500;
    await card('GOPH').locator('button', { hasText: 'Check now' }).click();
    await page.waitForFunction(() => /Lookup: Connecting/.test(document.querySelector('#ledgerAccountsList .ledger-account').innerText), null, { timeout: 5000 });
    t = await card('GOPH').innerText();
    check('a request in flight shows Lookup: Connecting and says whom it is talking to', /Lookup: Connecting/.test(t) && t.includes('Talking to ' + issuer.domain));
    check('Check now cannot be pressed again meanwhile', await card('GOPH').locator('button', { hasText: 'Check now' }).isDisabled());
    check('the other account is not shown as connecting', !/Connecting/.test(await card('MWC').innerText()));
    if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, 'ledger-connecting.png') }); }
    await page.waitForFunction(() => !/Lookup: Connecting/.test(document.querySelector('#ledgerAccountsList .ledger-account').innerText), null, { timeout: 10000 });
    ledger.state.delayMs = 0;
    check('when the answer arrives the indicator returns to Enabled', /Lookup: Enabled/.test(await card('GOPH').innerText()));

    console.log('--- stopping lookups ---');
    await card('GOPH').locator('button', { hasText: 'Stop lookups' }).click();
    await page.waitForFunction(() => /Lookup: Available/.test(document.querySelector('#ledgerAccountsList .ledger-account').innerText));
    t = await card('GOPH').innerText();
    check('stopping returns lookup to available and the background check to unavailable', /Lookup: Available/.test(t) && /Background check: Unavailable/.test(t));
    check('the background switch is cleared and disabled', !(await card('GOPH').locator('input[type=checkbox]').isChecked()) && await card('GOPH').locator('input[type=checkbox]').isDisabled());
    check('the last balance stays, as what the ledger last said', /Reported balance: 20\.00/.test(t));
    check('a status line says what stopped', /stopped for GOPH/.test(await text('#ledgerStatus')));
    if (shots) await page.screenshot({ path: path.join(shots, 'ledger-tab.png') });

    console.log('--- removing a reference ---');
    await card('GOPH').locator('button', { hasText: 'Allow lookups' }).click();
    await page.click('#ledgerConfirmOk');
    await page.waitForFunction(() => /Lookup: Enabled/.test(document.querySelector('#ledgerAccountsList .ledger-account').innerText));
    await card('GOPH').locator('input[type=checkbox]').check();
    await page.waitForFunction(() => /Background check: Enabled/.test(document.querySelector('#ledgerAccountsList .ledger-account').innerText));
    const atRemove = calls(), issuerAtRemove = issuer.state.requests.length;
    await card('GOPH').locator('button', { hasText: 'Remove from wallet' }).click();
    t = await text('#ledgerConfirmText');
    check('the question says only the local reference goes and the ledger account is not changed', /only forgets the reference on this device/.test(t) && /not changed/.test(t) && t.includes(issuer.domain));
    check('and that the account can be found again', /show it to this identity again/.test(t));
    await page.click('#ledgerConfirmCancel');
    check('cancelling keeps the account', (await card('GOPH').count()) === 1);
    await card('GOPH').locator('button', { hasText: 'Remove from wallet' }).click();
    await page.click('#ledgerConfirmOk');
    await page.waitForFunction(() => !/GOPH/.test(document.getElementById('ledgerAccountsList').innerText));
    check('the account is gone from the tab', (await card('GOPH').count()) === 0 && (await card('MWC').count()) === 1);
    check('the status line says the ledger account is unchanged', /ledger account is unchanged/.test(await text('#ledgerStatus')));
    check('removal sent nothing to the ledger or the issuer', calls() === atRemove && issuer.state.requests.length === issuerAtRemove);
    check('the ledger still holds the account and its balance', ledger.has(w.pub, NET, 'GOPH') && ledger.balanceOf(w.pub, NET, 'GOPH') === '2000');
    const quiet = calls();
    await page.evaluate(() => AtlasWallet.runLedgerBackgroundSync({ now: Date.now() + 3600000 }));
    await sleep(300);
    check('no background check follows for the removed account', calls() === quiet);

    console.log('--- coming back to the wallet ---');
    await page.reload();
    await page.waitForFunction(() => typeof routeWalletScreen === 'function' && typeof AtlasWallet !== 'undefined');
    await page.evaluate(() => routeWalletScreen());
    await page.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'));
    const reloadCalls = calls();
    await openLedger();
    await card('MWC').waitFor();
    check('the remaining reference survives a reload', (await card('MWC').count()) === 1 && (await card('GOPH').count()) === 0);
    check('a reload with no ledger interface installed leaves it unavailable and contacts nothing', /Lookup: Unavailable/.test(await card('MWC').innerText()) && calls() === reloadCalls);

    console.log('--- finding accounts again ---');
    await page.evaluate(T.installSimulatedAdapter, {});
    ledger.state.listing = (owner) => (owner === w.pub ? [gop, mwc] : []);
    await page.fill('#ledgerFindDomainInput', 'https://bad');
    await page.click('#ledgerFindBtn');
    check('a web address instead of a host name is rejected on the spot', /plain host name/.test(await text('#ledgerStatus')));
    await page.fill('#ledgerFindDomainInput', issuer.domain);
    const preFind = calls();
    await page.click('#ledgerFindBtn');
    t = await text('#ledgerConfirmText');
    check('the question says what is contacted and that the identity signs to prove ownership', t.includes(issuer.domain) && /ledger address it names/.test(t) && /signs a request with your identity/.test(t));
    await page.click('#ledgerConfirmCancel');
    check('cancelling sends nothing', calls() === preFind);
    await page.click('#ledgerFindBtn'); await page.click('#ledgerConfirmOk');
    await card('GOPH').waitFor({ timeout: 8000 });
    await page.waitForFunction(() => /added/.test(document.getElementById('ledgerStatus').textContent), null, { timeout: 8000 });
    check('the removed account is back, and the one already held is skipped', (await card('GOPH').count()) === 1 && (await card('MWC').count()) === 1 && /1 account added, 1 skipped/.test(await text('#ledgerStatus')), await text('#ledgerStatus'));
    t = await card('GOPH').innerText();
    check('it comes back with no permission, no balance and the background check off', /Balance not loaded/.test(t) && /Not allowed yet/.test(t) && !(await card('GOPH').locator('input[type=checkbox]').isChecked()));

    console.log('--- the experimental interface switch ---');
    await page.evaluate(() => AtlasWallet.clearLedgerAdapters());
    await page.evaluate(() => AtlasWallet.getLedgerExperimental());
    await page.click('#ledgerSubtabBtn');
    await page.waitForFunction(() => !!document.getElementById('exp-labs29'));
    check('the experimental section exists, closed, with its warning', (await page.$eval('#ledgerExperimental', (e) => !e.open)) && /not signed and are not final or spendable/.test(await page.$eval('#ledgerExperimental', (e) => e.textContent)));
    await page.click('#ledgerExperimental summary');
    check('the Labs 29 switch is off by default', !(await page.isChecked('#exp-labs29')) && !(await page.$eval('#exp-labs29', (e) => e.disabled)));
    check('no adapter is registered while it is off', (await page.evaluate(() => AtlasWallet.getLedgerAdapters())).length === 0);
    await page.click('#exp-labs29');
    t = await text('#ledgerConfirmText');
    check('turning it on asks first, and says the answers are not signed and not spendable', /Chainblock Labs 29/.test(t) && /not signed and are not final or spendable/.test(t) && /one by one/.test(t) && /Background checks stay off/.test(t), t);
    check('the switch itself did not move before the answer', !(await page.isChecked('#exp-labs29')));
    await page.click('#ledgerConfirmCancel');
    check('cancelling leaves it off', !(await page.isChecked('#exp-labs29')) && (await page.evaluate(() => AtlasWallet.getLedgerAdapters())).length === 0);
    await page.click('#exp-labs29');
    await page.click('#ledgerConfirmOk');
    await page.waitForFunction(() => document.getElementById('exp-labs29').checked);
    check('after agreeing it is on and the interface is registered', (await page.evaluate(() => AtlasWallet.getLedgerAdapters())).includes('chainblock-ledger29/experimental'));
    await page.waitForFunction(() => /no service for finding accounts again/.test(document.getElementById('ledgerFindNote').textContent));
    check('finding accounts stays disabled, saying this interface has no such service', await page.$eval('#ledgerFindBtn', (e) => e.disabled) && /no service for finding accounts again/.test(await text('#ledgerFindNote')));
    check('the accounts at a test host cannot use the built-in instance, and say so', /Lookup: Unavailable/.test(await card('GOPH').innerText()));
    await page.click('#exp-labs29');
    await page.waitForFunction(() => /is off/.test(document.getElementById('ledgerStatus').textContent));
    check('turning it off needs no question and unregisters it', (await page.evaluate(() => AtlasWallet.getLedgerAdapters())).length === 0 && /is off/.test(await text('#ledgerStatus')));

    console.log('--- the wallet around it ---');
    check('the asset lists are untouched by any of this', (await page.$$eval('#selfCollectiblesList .wallet-item, #selfDocumentsList .wallet-item', (e) => e.length)) === 0);
    check('no page errors in the wallet page', errors.length === 0, errors);
  } finally {
    await w.close();
    await issuer.close(); await ledger.close();
  }
  process.exit(L.finish('manual-ledger-tab'));
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
