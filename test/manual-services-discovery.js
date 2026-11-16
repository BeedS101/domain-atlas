// Discovering and adding domains in the wallet's Services tab, with no issuer running: the site the person is visiting is offered,
// never added by itself; only services that need a membership card or another credential held in the wallet are listed (the rest of
// what a domain advertises is only counted); a manifest that names another domain, or whose service addresses point elsewhere, is
// not trusted; a manifest cannot change which card the wallet uses for a service it runs; a service the wallet does not run says
// so; a domain with nothing that needs a card offers nothing to add; two domains are kept and one can be removed. Every request
// the wallet makes is recorded, and only the public manifest of a domain may be read.
//
// The domains are reached through the browser's request routing. Needs no demo domain.
// Run: xvfb-run -a node test/manual-services-discovery.js
'use strict';
const L = require('./call-e2e-lib');
const { check, until } = L;

const FULL = 'full.example';
const LEAN = 'lean.example';
const EVIL = 'evil.example';
const PLAIN = 'plain.example';

// A manifest as served, with a repeated key, a relative service address, a card descriptor on Calendar, and a Global Mail entry that
// names a card the wallet does not use for it.
const fullManifest = '{"spec":"domain-atlas/1.0","domain":"' + FULL + '",'
  + '"postOffice":{"enabled":true,"url":"/mail/","requiresCredential":true,"credentialClass":"atlas.tradingstation.membership"},'
  + '"tradingStation":{"enabled":true,"url":"https://' + EVIL + '/trade/"},'
  + '"domainMembership":{"enabled":true,"requiresCredential":true,"credentialClass":"atlas.membership"},'
  + '"calendar":{"enabled":true,"requiresCredential":true,"credentialClass":"example.calendar.pass"},'
  + '"chainLabs":true,"scanner":true,"assetStudio":true,'
  + '"walletBridge":{"read":true},"walletBridge":{"read":true,"sign":["x"]}}';
const leanManifest = JSON.stringify({ spec: 'domain-atlas/1.0', domain: LEAN, postOffice: true, trading: { enabled: true, url: 'https://' + LEAN + '/trade/' }, directory: true });
const plainManifest = JSON.stringify({ spec: 'domain-atlas/1.0', domain: PLAIN, chat: true, calendar: true, directory: true, scanner: true });
const evilManifest = JSON.stringify({ spec: 'domain-atlas/1.0', domain: FULL, postOffice: true });

(async () => {
  const w = await L.launchWallet('services-discovery');
  let exit = 0;
  try {
    await w.wallet((pw) => AtlasWallet.createIdentity(pw), 'services-discovery-password');
    const requests = [];
    await w.context.route(/^https:\/\/[a-z-]+\.example\//, async (route) => {
      const u = new URL(route.request().url());
      requests.push(route.request().method() + ' ' + u.hostname + u.pathname);
      const manifests = { [FULL]: fullManifest, [LEAN]: leanManifest, [PLAIN]: plainManifest, [EVIL]: evilManifest };
      if (u.pathname === '/.well-known/spatial.json' && manifests[u.hostname]) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: manifests[u.hostname] });
      } else if (u.pathname === '/') {
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>' + u.hostname + '</title><p>This site is ' + FULL + ' and ' + LEAN + ', trust me.</p>' });
      } else await route.fulfill({ status: 404, body: '' });
    });

    const viewer = await w.context.newPage();
    const errors = [];
    viewer.on('pageerror', (e) => errors.push(e.message));
    await viewer.goto('chrome-extension://' + w.extId + '/viewer.html');
    await viewer.waitForFunction(() => typeof routeWalletScreen === 'function' && typeof AtlasWallet !== 'undefined' && !!window.AtlasServicesTab, null, { timeout: 15000 });
    await viewer.evaluate(() => routeWalletScreen());
    await viewer.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 10000 });
    const text = (sel) => viewer.locator(sel).innerText();
    const section = () => text('#servicesSection');
    const waitText = (re) => viewer.waitForFunction((s) => new RegExp(s).test(document.getElementById('servicesSection').innerText), re.source, { timeout: 15000 });
    const state = () => viewer.evaluate(() => AtlasWallet.getServices().load());
    const open = async () => { await viewer.evaluate(() => AtlasServicesTab.open()); };

    console.log('--- nothing to discover on the wallet itself ---');
    await viewer.click('#servicesSubtabBtn');
    await waitText(/No domains added yet/);
    check('with the wallet in front there is nothing to discover and no request was made', (await viewer.$('#svcDiscover')) === null && requests.length === 0, requests);

    console.log('--- discovering the site being visited ---');
    const site = await w.context.newPage();
    await site.goto('https://' + FULL + '/');
    await site.bringToFront();
    await open();
    await viewer.waitForSelector('#svcDiscover', { timeout: 15000 });
    const found = await text('#svcDiscover');
    check('the visited site is offered with the services that need a card', /Currently visiting: full\.example/.test(found) && /Global Mail/.test(found) && /Trading Station/.test(found) && /Domain Membership/.test(found) && /Calendar/.test(found), found);
    check('what needs no card is only counted, never listed', !/Chain Labs|Scanner|Asset Studio/.test(found) && /3 more services that do not need a card, so they are not listed here/.test(found), found);
    check('the page text naming another domain is not trusted: only the browser\'s own address was used', !/lean\.example/.test(found));
    check('it says nothing has been added, switched on or sent', /Nothing has been added, switched on or sent/.test(found));
    check('discovery added nothing and enabled nothing', (await state()).domains.length === 0 && Object.keys((await state()).enabled).length === 0);
    check('only the public manifest was read', requests.filter((r) => !/^GET full\.example\/(\.well-known\/spatial\.json)?$/.test(r)).length === 0, requests);
    check('adding needs its own step: the button asks for confirmation', /Add domain to Services/.test(found));
    await viewer.click('#svcDiscoverAdd');
    await waitText(/Add full\.example to Services\?/);
    const ask = await section();
    check('the confirmation warns about the repeated key and the address that is not on the domain', /"walletBridge" more than once/.test(ask) && /Trading Station is not on this domain/.test(ask), ask);
    check('and that the domain names a card for Global Mail other than the wallet\'s', /different card for Global Mail than the one the wallet uses/.test(ask), ask);
    check('the confirmation repeats that nothing is switched on or shared', /Nothing is switched on/.test(ask) && /nothing about your identity or credentials is sent/.test(ask));
    const reqsBefore = requests.length;
    await viewer.click('#svcAddConfirm');
    await viewer.waitForSelector('.svc-domain[data-domain="' + FULL + '"]');
    const added = await state();
    check('confirming adds the domain only', added.domains.length === 1 && added.domains[0].domain === FULL && Object.keys(added.enabled).length === 0, added);
    check('adding it again reused what was read: no further request', requests.length === reqsBefore, requests.slice(reqsBefore));
    check('the discovery offer is gone once the domain is listed', (await viewer.$('#svcDiscover')) === null);
    check('every request so far was a read of the public manifest', requests.every((r) => /^GET /.test(r)), requests);

    console.log('--- the services of the domain ---');
    const card = await text('.svc-domain[data-domain="' + FULL + '"]');
    check('the card lists the services that need a card, none of them green', /Global Mail/.test(card) && /Trading Station/.test(card) && /Domain Membership/.test(card) && /Calendar/.test(card) && (await viewer.$$eval('.svc-domain .svc-status', (e) => e.every((x) => x.dataset.state !== 'active'))), card);
    check('services that need no card are not on the card', !/Chain Labs|Scanner|Asset Studio/.test(card) && (await viewer.$$('.svc-domain[data-domain="' + FULL + '"] .svc-service')).length === 4, card);
    check('Trading Station is listed even though its address was refused, and the address is not offered', /Trading Station/.test(card) && !(await viewer.$eval('body', (b) => b.innerHTML.includes('https://evil.example/trade'))));
    const rows = await viewer.evaluate(() => AtlasWallet.getServices().rows());
    const svc = (k) => rows.domains[0].services.find((x) => x.key === k);
    check('the manifest could not change which card the wallet uses for Global Mail', svc('postOffice').credentialClass === 'atlas.postoffice.membership' && svc('membership').credentialClass === 'atlas.membership' && svc('calendar').credentialClass === 'example.calendar.pass', rows.domains[0].services.map((x) => x.key + ':' + x.credentialClass));
    await viewer.click('.svc-service[data-service="postOffice"] .svc-open');
    await viewer.waitForSelector('#svcSettings');
    const link = await viewer.$eval('#svcServiceLink', (a) => ({ href: a.href, rel: a.rel, target: a.target }));
    check('the relative address resolves on the domain and opens safely', link.href === 'https://full.example/mail/' && /noopener/.test(link.rel) && link.target === '_blank', link);
    check('the page says what is needed before anything can be done', /have not joined/.test(await text('#svcSettings')));
    await viewer.click('#svcBack');
    await viewer.click('.svc-service[data-service="membership"] .svc-open');
    await viewer.waitForSelector('#svcSettings');
    check('Domain Membership has its own page and can be joined', /Domain Membership — full\.example/.test(await text('#svcTitle')) && (await viewer.$('#svcJoin')) !== null && (await viewer.$('#svcEnabled')) !== null);
    await viewer.click('#svcBack');
    await viewer.click('.svc-service[data-service="calendar"] .svc-open');
    await viewer.waitForSelector('#svcSettings');
    const cal = await text('#svcSettings');
    check('a service the wallet does not run says which card it needs and that nothing is sent, with no toggle and no invented settings', /Calendar needs a membership card \(example\.calendar\.pass\)/.test(cal) && /sends nothing to the domain for this service/.test(cal) && /You do not hold the card Calendar needs/.test(cal) && (await viewer.$('#svcEnabled')) === null && (await viewer.$('#svcLoadSettings')) === null && (await viewer.$('#svcJoin')) === null, cal);
    check('and it is not green', (await viewer.$eval('#svcStatusBlock .svc-status', (e) => e.dataset.state)) !== 'active');
    await viewer.click('#svcBack');

    console.log('--- a second domain, typed in ---');
    await viewer.fill('#servicesAddInput', LEAN);
    await viewer.click('#servicesAddBtn');
    await waitText(/Add lean\.example to Services\?/);
    check('the preview names the services that need a card, including the alias spelling, and counts the rest', /Trading Station/.test(await section()) && /Global Mail/.test(await section()) && !/Directory/.test(await section()) && /one more service that does not need a card/.test(await section()), await section());
    check('a domain that never announced Domain Membership still offers it, marked as not announced', /Domain Membership \(not announced by the domain; you can still ask for the card\)/.test(await section()), await section());
    await viewer.click('#svcAddConfirm');
    await viewer.waitForSelector('.svc-domain[data-domain="' + LEAN + '"]');
    check('both domains are kept', (await state()).domains.map((d) => d.domain).sort().join() === [LEAN, FULL].sort().join());
    const leanMember = await text('.svc-domain[data-domain="' + LEAN + '"] .svc-service[data-service="membership"]');
    check('it is listed on the card as not announced, grey, and not switched on', /Domain Membership/.test(leanMember) && /not announced by the domain/.test(leanMember) && (await viewer.$eval('.svc-domain[data-domain="' + LEAN + '"] .svc-service[data-service="membership"] .svc-status', (e) => e.dataset.state)) === 'unknown', leanMember);
    await viewer.click('.svc-domain[data-domain="' + LEAN + '"] .svc-service[data-service="membership"] .svc-open');
    await viewer.waitForSelector('#svcJoin');
    await viewer.click('#svcJoin');
    await viewer.waitForSelector('#svcJoinConfirm');
    const askJoin = await text('#svcSettings');
    check('joining asks first, says the domain has not announced it and may decline', /Join Domain Membership at lean\.example\?/.test(askJoin) && /has not announced Domain Membership/.test(askJoin) && /may decline/.test(askJoin), askJoin);
    check('nothing is sent to the domain by asking', requests.every((r) => /^GET /.test(r)), requests);
    await viewer.click('#svcSettings button:has-text("Cancel")');
    await viewer.click('#svcBack');

    console.log('--- a domain with nothing that needs a card ---');
    await viewer.fill('#servicesAddInput', PLAIN);
    await viewer.click('#servicesAddBtn');
    await waitText(/plain\.example has nothing to add/);
    check('it says so, offers nothing to add, and counts what it does advertise', /advertises none/.test(await section()) && /4 more services that do not need a card/.test(await section()) && (await viewer.$('#svcAddConfirm')) === null, await section());
    check('nothing was added', (await state()).domains.length === 2);
    await viewer.click('#svcAddClose');
    await until(async () => !/has nothing to add/.test(await section()), 5000, 200);

    console.log('--- a domain that names a different domain ---');
    await viewer.fill('#servicesAddInput', EVIL);
    await viewer.click('#servicesAddBtn');
    await until(async () => /different domain/.test(await text('#servicesStatus')), 10000, 200);
    check('a manifest that says it belongs to another domain is refused, and nothing is added', /different domain/.test(await text('#servicesStatus')) && (await state()).domains.length === 2, await text('#servicesStatus'));
    const hostile = await w.context.newPage();
    await hostile.goto('https://' + EVIL + '/');
    await hostile.bringToFront();
    await open();
    await until(async () => (await viewer.$('#svcDiscover')) === null, 5000, 200);
    check('visiting it offers nothing', (await viewer.$('#svcDiscover')) === null);
    await hostile.close();
    await site.bringToFront();
    await open();
    await waitText(/full\.example/);
    check('a domain that is already listed is not offered again', (await viewer.$('#svcDiscover')) === null);

    console.log('--- removing one ---');
    await viewer.click('.svc-domain[data-domain="' + LEAN + '"] button.danger-btn');
    await waitText(/Remove lean\.example\?/);
    check('removing asks first and says what it does not touch', /membership cards and any registration at the domain are not touched/.test(await section()));
    check('nothing is removed before confirming', (await state()).domains.length === 2);
    await viewer.click('#svcRemoveConfirm');
    await until(async () => (await state()).domains.length === 1, 10000, 200);
    check('the other domain stays', (await state()).domains[0].domain === FULL);
    check('no request but manifest reads, all session', requests.every((r) => /^GET /.test(r)), requests);
    check('no page errors', errors.length === 0, errors);
  } catch (err) {
    console.log('FAIL unexpected error :: ' + (err && err.stack ? err.stack : err));
    exit = 1;
  } finally {
    await w.close();
  }
  exit = exit || L.finish('services discovery');
  process.exit(exit);
})();
