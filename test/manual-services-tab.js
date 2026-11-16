// The wallet's Services tab, driven the way a person would, in the real extension against a throw-away demo issuer that
// advertises a Post Office, site chat and a calendar: add a domain, see that only the service that needs a membership card is
// listed, open Global Mail, join, see the membership card on the service's page, read what switching it off stops, check mail, set
// the handle and mail mode, switch the service off and on, move the check rate and back to the default, and remove the domain.
// It also covers what must not happen: adding switches nothing on, nothing is sent while a service is off, the other identity
// has its own list, removing keeps the card, and a backup brings the choices back.
//
// Needs the local demo domain on 8002:
//   PORT=8002 ATLAS_DOMAIN=localhost:8002 ATLAS_DOCROOT=demo-domain-b \
//     ATLAS_STATE_DIR=$(mktemp -d) node issuer-server/server.js
// Run: xvfb-run -a node test/manual-services-tab.js
'use strict';
const L = require('./call-e2e-lib');
const { check, until } = L;
const D = L.MAIL_DOMAIN;
const SEED_FIELD = 'atlasServices';
const HANDLE = 'svc' + Date.now().toString(36);

(async () => {
  const w = await L.launchWallet('services-tab');
  let exit = 0;
  try {
    const created = await w.wallet((pw) => AtlasWallet.createIdentity(pw), 'services-tab-password');
    w.pub = created.publicKey;
    const seed = created.seedPhrase;

    // Every request the background worker makes, so "nothing was sent" can be checked.
    await w.sw.evaluate(() => {
      self.__sent = [];
      const f = self.fetch.bind(self);
      self.fetch = (u, i) => { self.__sent.push(String(u && u.url ? u.url : u) + ' ' + ((i && i.method) || 'GET')); return f(u, i); };
    });
    const sent = () => w.sw.evaluate(() => self.__sent.slice());
    const mailChecks = async () => (await sent()).filter((s) => /\/atlas\/mail\/check POST/.test(s)).length;

    const page = await w.context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('chrome-extension://' + w.extId + '/viewer.html');
    await page.waitForFunction(() => typeof routeWalletScreen === 'function' && typeof AtlasWallet !== 'undefined' && !!window.AtlasServicesTab, null, { timeout: 15000 });
    await page.evaluate(() => routeWalletScreen());
    await page.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 10000 });
    const text = (sel) => page.locator(sel).innerText();
    const section = () => text('#servicesSection');
    const waitText = (re) => page.waitForFunction((s) => new RegExp(s).test(document.getElementById('servicesSection').innerText), re.source, { timeout: 15000 });
    const state = () => w.wallet(() => AtlasWallet.getServices().load());
    const held = () => w.wallet((k) => AtlasWallet.getWallet(k), w.pub);
    const badge = () => page.$$eval('#svcStatusBlock .svc-status', (e) => (e[0] ? { state: e[0].dataset.state, code: e[0].dataset.code, text: e[0].innerText } : null));
    const openSettings = async (key) => { await page.click('.svc-domain[data-domain="' + D + '"] .svc-service[data-service="' + key + '"] .svc-open'); await page.waitForSelector('#svcSettings'); };

    console.log('--- the tab ---');
    await page.click('#servicesSubtabBtn');
    await page.waitForSelector('#servicesSubscreen.active');
    await waitText(/No domains added yet/);
    check('the Inventory sub-tabs are in the order Collectibles, Ledger, Services', (await page.$$eval('#inventorySubtabBar button', (b) => b.map((x) => x.innerText.trim()))).join(',') === 'Collectibles,Ledger,Services');
    for (const [btn, screen] of [['#ledgerSubtabBtn', '#ledgerSubscreen'], ['#collectiblesSubtabBtn', '#collectiblesSubscreen'], ['#servicesSubtabBtn', '#servicesSubscreen']]) {
      await page.click(btn);
      await page.waitForSelector(screen + '.active');
      const active = await page.$$eval('#inventorySubtabBar button.active-subtab', (b) => b.map((x) => x.id));
      const shown = await page.$$eval('#walletPanelContent .subscreen.active, .subscreen.active', (e) => e.map((x) => x.id).filter((id) => /^(collectibles|ledger|services)Subscreen$/.test(id)));
      check('each sub-tab opens its own screen and only that one: ' + btn, active.length === 1 && active[0] === btn.slice(1) && shown.length === 1 && shown[0] === screen.slice(1), { active, shown });
    }
    check('the Documents sub-tab is replaced by Services', (await page.$('#documentsSubtabBtn')) === null && /Services/.test(await text('#servicesSubtabBtn')));
    check('documents that belong to no service stay under "Other documents"', /Other documents/i.test(await text('#servicesSubscreen')) && (await page.$('#selfDocumentsList')) !== null);

    console.log('--- adding a domain ---');
    await page.fill('#servicesAddInput', 'not a domain');
    await page.click('#servicesAddBtn');
    await until(async () => /not a domain|valid domain|domain name/i.test(await section()), 5000);
    check('something that is not a domain is refused', /domain/i.test(await text('#servicesStatus')) && (await state()).domains.length === 0, await text('#servicesStatus'));
    await page.fill('#servicesAddInput', D);
    await page.click('#servicesAddBtn');
    await waitText(/Add localhost:8002 to Services\?/);
    const preview = await section();
    check('adding asks first, lists what the domain advertises, and says nothing is switched on', /Global Mail/.test(preview) && /Nothing is switched on/.test(preview) && /nothing about your identity or credentials is sent/.test(preview), preview);
    check('only the service that needs a membership card is listed; the others are only counted', !/Site chat|Calendar/.test(preview) && /2 more services that do not need a card/.test(preview), preview);
    check('nothing is added until the person confirms', (await state()).domains.length === 0);
    await page.click('#servicesSection button:has-text("Cancel")');
    await waitText(/No domains added yet/);
    check('cancelling adds nothing', (await state()).domains.length === 0);
    const before = (await sent()).length;
    await page.fill('#servicesAddInput', D);
    await page.click('#servicesAddBtn');
    await page.click('#svcAddConfirm');
    await page.waitForSelector('.svc-domain[data-domain="' + D + '"]');
    const st = await state();
    check('the domain is added, with nothing switched on', st.domains.length === 1 && st.domains[0].domain === D && Object.keys(st.enabled).length === 0, st);
    check('adding sent no mail request and presented no identity', (await sent()).slice(before).every((s) => /\.well-known\/spatial\.json GET/.test(s)), (await sent()).slice(before));
    const card = await text('.svc-domain[data-domain="' + D + '"]');
    check('the card lists Global Mail with a status that is not green', /Global Mail/.test(card) && (await page.$eval('.svc-service[data-service="postOffice"] .svc-status', (e) => e.dataset.state)) !== 'active', card);
    check('services that need no card are not listed at all', !/Site chat|Calendar|Scanner|Directory|Asset Studio|Chain Labs/.test(card) && (await page.$$('.svc-domain[data-domain="' + D + '"] .svc-service')).length === 2, card);
    check('Domain Membership is offered although this domain never announced it, marked as not announced', /Domain Membership/.test(card) && /not announced by the domain/.test(card), card);

    console.log('--- Global Mail settings: joining ---');
    await openSettings('postOffice');
    check('the page names the service and the domain', /Global Mail — localhost:8002/.test(await text('#svcTitle')));
    let b = await badge();
    check('before joining it is grey and says it is not set up', b && b.state === 'unknown' && /not set up|Not set up|joined/i.test(await text('#svcStatusBlock')), b);
    check('the page shows the identity it is for', /Main identity/.test(await text('#svcSettings')));
    const enabledText = await text('#svcSettings');
    check('what switching it off stops is written out, not hidden', /private mail, friend requests, chat, call invitations/.test(enabledText) && /When off, the card is not presented/.test(enabledText) && /nothing else you hold is affected/.test(enabledText), enabledText);
    check('no invented controls: nothing to load or configure until joined', (await page.$('#svcLoadSettings')) === null && (await page.$('#svcHandleInput')) === null);
    await page.click('#svcJoin');
    await page.waitForSelector('#svcJoinConfirm');
    const joinAsk = await text('#svcSettings');
    check('joining asks first and names the identity', /Join Global Mail at localhost:8002\?/.test(joinAsk) && /issue a membership card to this identity: Main identity/.test(joinAsk), joinAsk);
    check('nothing is issued before the person confirms', (await held()).length === 0);
    await page.click('#svcJoinConfirm');
    await page.waitForSelector('#svcCredentials .wallet-item', { timeout: 20000 });
    const credCount = (await held()).filter((e) => e.credential.asset.class === 'atlas.postoffice.membership').length;
    check('joining issued one membership card and it is shown on the service page', credCount === 1 && (await page.$$('#svcCredentials .wallet-item')).length === 1);
    check('the verification status is shown with the card', /Verification: Verified/.test(await text('#svcSettings')), await text('#svcSettings'));
    check('joining switched the service on', (await state()).enabled[D + '|postOffice'] === true);
    check('the card is not repeated in Other documents', (await page.$$('#selfDocumentsList .wallet-item')).length === 0);
    check('the card is still in the wallet, unchanged in count', (await held()).length === 1);

    console.log('--- status: green only after a real check ---');
    b = await badge();
    check('enabled with a card but never checked is not green', b && b.state === 'unknown' && /has not confirmed that the service answers/.test(await text('#svcStatusBlock')), b);
    await page.click('#svcCheckNow');
    await until(async () => (await badge() || {}).state === 'active', 20000, 300);
    b = await badge();
    check('after a successful check it is green with an icon and words', b && b.state === 'active' && /Active/i.test(b.text), b);
    check('the status says how fresh it is', /ago|moment/.test(await text('#svcStatusBlock')), await text('#svcStatusBlock'));
    if (process.env.SERVICES_SHOT) await page.screenshot({ path: process.env.SERVICES_SHOT + '-settings.png' });

    console.log('--- how often it checks ---');
    check('the page says the usual rate is every minute and that it is a target', /every minute \(the usual rate\)/.test(await text('#svcInterval')) && /target, not a promise/.test(await text('#svcInterval')), await text('#svcInterval'));
    check('at the usual rate there is nothing to reset', (await page.$('#svcResetInterval')) === null);
    await w.wallet(() => AtlasWallet.setMailCheckInterval(5));
    await page.evaluate(() => AtlasServicesTab.render());
    await page.waitForSelector('#svcResetInterval');
    check('a rate the person set is kept and shown as theirs', /every 5 minutes \(a rate you set\)/.test(await text('#svcInterval')), await text('#svcInterval'));
    await page.click('#svcResetInterval');
    await page.waitForFunction(() => !document.getElementById('svcResetInterval'), null, { timeout: 10000 });
    check('one click returns to the 1-minute default', (await w.wallet(() => AtlasWallet.getMailSettings())).intervalMinutes === 1 && /every minute \(the usual rate\)/.test(await text('#svcInterval')));

    console.log('--- Global Mail settings: handle and mail mode ---');
    await page.click('#svcLoadSettings');
    await page.waitForSelector('#svcHandleInput');
    await page.fill('#svcHandleInput', HANDLE);
    await page.click('#svcHandleSave');
    await page.waitForFunction((h) => (document.getElementById('svcHandleShown') || {}).innerText === 'People can reach you as ' + h + '#localhost:8002.', HANDLE, { timeout: 15000 }).catch(async () => console.log('  handle step said: ' + await text('#servicesStatus')));
    check('the handle is saved through the existing Post Office call and shown', new RegExp(HANDLE + '#localhost:8002').test(await text('#svcSettings')));
    await page.selectOption('#svcModeSelect', 'friendsOnly');
    await page.click('#svcModeSave');
    await until(async () => (await w.wallet((d) => AtlasWallet.getPostOfficeSettings(d), D)).mailMode === 'friendsOnly', 15000, 300);
    check('the mail mode is applied', (await w.wallet((d) => AtlasWallet.getPostOfficeSettings(d), D)).mailMode === 'friendsOnly');
    await page.selectOption('#svcModeSelect', 'open');
    await page.click('#svcModeSave');
    await until(async () => (await w.wallet((d) => AtlasWallet.getPostOfficeSettings(d), D)).mailMode !== 'friendsOnly', 15000, 300);

    console.log('--- switching it off ---');
    const checksBefore = await mailChecks();
    await page.uncheck('#svcEnabled');
    await until(async () => (await badge() || {}).state === 'disabled', 10000, 200);
    b = await badge();
    check('off is amber with an icon and says it is switched off on purpose', b && b.state === 'disabled' && /Disabled/.test(b.text) && /You turned this off/.test(await text('#svcStatusBlock')), b);
    await w.wallet(() => AtlasWallet.checkAllMail());
    check('while it is off the background mail check does not contact the domain', (await mailChecks()) === checksBefore, (await sent()).slice(-3));
    check('switching off deleted nothing: the card and the registration are untouched', (await held()).length === 1);
    await page.click('#svcBack');
    await waitText(/Disabled/);
    check('the list shows it as disabled', /Disabled/.test(await text('.svc-service[data-service="postOffice"]')));
    await openSettings('postOffice');
    await page.check('#svcEnabled');
    await until(async () => (await badge() || {}).state !== 'disabled', 10000, 200);
    await w.wallet(() => AtlasWallet.checkAllMail());
    check('switched back on, the background check asks the domain again', (await mailChecks()) > checksBefore);

    console.log('--- a problem is explained, not just coloured ---');
    await w.wallet(async (d) => { await AtlasWallet.getServices().recordOutcome(d, 'mail', false, 'the domain refused the membership card'); }, D);
    await page.click('#svcBack');
    await waitText(/See what needs attention/);
    const row = await text('.svc-service[data-service="postOffice"]');
    check('the list row turns red, names the problem and offers a way to the settings', /Problem/i.test(row) && /refused the membership card/.test(row) && /See what needs attention/.test(row), row);
    if (process.env.SERVICES_SHOT) await page.screenshot({ path: process.env.SERVICES_SHOT + '-problem.png' });
    check('the red status has its own icon, not only a colour', await page.$eval('.svc-service[data-service="postOffice"] .svc-status', (e) => e.dataset.state === 'problem' && e.querySelector('.svc-icon').textContent.length > 0));
    await page.click('.svc-service[data-service="postOffice"] .svc-open');
    await page.waitForSelector('#svcSettings');
    check('opening it explains the problem', /refused the membership card/.test(await text('#svcStatusText')));

    await page.click('#svcBack');

    console.log('--- another identity has its own list ---');
    const sub = await w.wallet(() => AtlasWallet.createSubIdentity('second'));
    await w.wallet((id) => AtlasWallet.switchIdentity(id), sub.id);
    await until(async () => /No domains added yet/.test(await section()), 10000, 200);
    check('the other identity starts with an empty list', /No domains added yet/.test(await section()) && (await state()).domains.length === 0);
    check('and does not see the first identity\'s card', (await page.$$('#svcCredentials .wallet-item')).length === 0);
    console.log('--- someone who already holds a card keeps their mail checks ---');
    await w.wallet((d) => AtlasWallet.mintAsset('self', d, 'atlas.postoffice.membership'), D);
    let n = await mailChecks();
    await w.wallet(() => AtlasWallet.checkAllMail());
    check('with no Services choice at all, the mail check asks the domain as it always did', (await mailChecks()) > n);
    await w.wallet((d) => AtlasWallet.getServices().addDomain(d), D);
    n = await mailChecks();
    await w.wallet(() => AtlasWallet.checkAllMail());
    check('adding the domain changes nothing: a held card keeps the service on', (await mailChecks()) > n && Object.keys((await state()).enabled).length === 0);
    await w.wallet((d) => AtlasWallet.getServices().setEnabled(d, 'postOffice', false), D);
    n = await mailChecks();
    await w.wallet(() => AtlasWallet.checkAllMail());
    check('switched off for this identity, it is not asked', (await mailChecks()) === n);
    await w.wallet((d) => AtlasWallet.getServices().removeDomain(d), D);
    await w.wallet(() => AtlasWallet.checkAllMail());
    check('removing the domain from the list resumes the checks the person had before', (await mailChecks()) > n);
    check('the first identity\'s switch was never touched by any of it', await w.wallet(async (id) => { await AtlasWallet.switchIdentity(null); return (await AtlasWallet.getServices().load()).enabled; }, sub.id).then((e) => e[D + '|postOffice'] === true));
    await w.wallet(() => AtlasWallet.switchIdentity(null));
    await until(async () => new RegExp(D).test(await section()), 10000, 200);
    check('switching back brings the first identity\'s domain back', (await state()).domains.length === 1);

    console.log('--- backup ---');
    const raw = await w.sw.evaluate((k) => chrome.storage.local.get(k).then((r) => JSON.stringify(r[k] || {})), SEED_FIELD);
    check('what is stored is encrypted: no domain name in it', !raw.includes('localhost') && !raw.includes('postOffice'), raw.slice(0, 120));
    const file = await w.wallet(([pw, seed]) => AtlasWallet.exportFullBackup(pw, seed), ['services-tab-password', seed]);
    await w.wallet((d) => AtlasWallet.getServices().removeDomain(d), D);
    check('removed from the list', (await state()).domains.length === 0);
    await page.reload();
    await page.waitForFunction(() => typeof routeWalletScreen === 'function' && !!window.AtlasServicesTab, null, { timeout: 15000 });
    await page.evaluate(() => routeWalletScreen());
    await page.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 10000 });
    await page.click('#servicesSubtabBtn');
    await waitText(/No domains added yet/);
    check('removing keeps the membership card: it is back under Other documents', (await held()).length === 1 && (await page.$$('#selfDocumentsList .wallet-item')).length === 1);
    await w.wallet(([f, pw, seed]) => AtlasWallet.importFullBackup(f, pw, seed), [file, 'services-tab-password', seed]);
    const restored = await state();
    check('a backup restores the domain and the choices', restored.domains.length === 1 && restored.domains[0].domain === D, restored);

    console.log('--- Domain Membership: a new member who holds no card yet ---');
    await page.reload();
    await page.waitForFunction(() => typeof routeWalletScreen === 'function' && !!window.AtlasServicesTab, null, { timeout: 15000 });
    await page.evaluate(() => routeWalletScreen());
    await page.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 10000 });
    await page.click('#servicesSubtabBtn');
    await page.waitForSelector('.svc-domain[data-domain="' + D + '"]');
    check('before joining, the wallet holds no Domain Membership card', (await held()).filter((e) => e.credential.asset.class === 'atlas.membership').length === 0);
    await openSettings('membership');
    check('the page offers to join and shows it is not set up', (await page.$('#svcJoin')) !== null && (await badge()).state === 'unknown');
    await page.click('#svcJoin');
    await page.waitForSelector('#svcJoinConfirm');
    check('joining asks first and says the domain has not announced it', /has not announced Domain Membership/.test(await text('#svcSettings')));
    check('nothing is issued before the person confirms', (await held()).filter((e) => e.credential.asset.class === 'atlas.membership').length === 0);
    await page.click('#svcJoinConfirm');
    await page.waitForSelector('#svcCredentials .wallet-item', { timeout: 20000 });
    check('the card was issued by the domain and is shown on the Domain Membership page', (await held()).filter((e) => e.credential.asset.class === 'atlas.membership' && e.credential.issuer.domain === D).length === 1 && /Verification: Verified/.test(await text('#svcSettings')), await text('#svcSettings'));
    check('joining switched the service on', (await state()).enabled[D + '|membership'] === true);
    await page.click('#svcBack');
    const otherDocs = await page.$$eval('#selfDocumentsList .wallet-item', (n) => n.map((x) => x.innerText));
    check('the Global Mail card and the Domain Membership card are both on their service pages, not in the list of other documents', otherDocs.length === 0, otherDocs);

    check('no page errors', errors.length === 0, errors);
  } catch (err) {
    console.log('FAIL unexpected error :: ' + (err && err.stack ? err.stack : err));
    exit = 1;
  } finally {
    await w.close();
  }
  exit = exit || L.finish('services tab');
  process.exit(exit);
})();
