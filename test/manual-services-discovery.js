// Discovering and adding domains in the wallet's Services tab, with no issuer running: the site the person is visiting is offered,
// never added by itself; a manifest that names another domain, or whose service addresses point elsewhere, is not trusted; a
// service the wallet does not operate says so; the Ledger service points at the Ledger tab; two domains are kept and one can be
// removed. Every request the wallet makes is recorded, and only the public manifest of a domain may be read.
//
// The domains are reached through the browser's request routing. Needs no demo domain.
// Run: xvfb-run -a node test/manual-services-discovery.js
'use strict';
const L = require('./call-e2e-lib');
const { check, until } = L;

const FULL = 'full.example';
const LEAN = 'lean.example';
const EVIL = 'evil.example';

// A manifest as served, with a repeated key and a relative service address, as a live one may have.
const fullManifest = '{"spec":"domain-atlas/1.0","domain":"' + FULL + '","postOffice":{"enabled":true,"url":"/mail/"},'
  + '"tradingStation":{"enabled":true,"url":"https://' + EVIL + '/trade/"},"chainLabs":true,"calendar":true,'
  + '"walletBridge":{"read":true},"walletBridge":{"read":true,"sign":["x"]}}';
const leanManifest = JSON.stringify({ spec: 'domain-atlas/1.0', domain: LEAN, postOffice: true, trading: { enabled: true, url: 'https://' + LEAN + '/trade/' }, directory: true });
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
      const manifests = { [FULL]: fullManifest, [LEAN]: leanManifest, [EVIL]: evilManifest };
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
    check('the visited site is offered with what it advertises', /Currently visiting: full\.example/.test(found) && /Global Mail/.test(found) && /Chain Labs/.test(found) && /Calendar/.test(found), found);
    check('the page text naming another domain is not trusted: only the browser\'s own address was used', !/lean\.example/.test(found));
    check('it says nothing has been added, switched on or sent', /Nothing has been added, switched on or sent/.test(found));
    check('discovery added nothing and enabled nothing', (await state()).domains.length === 0 && Object.keys((await state()).enabled).length === 0);
    check('only the public manifest was read', requests.filter((r) => !/^GET full\.example\/(\.well-known\/spatial\.json)?$/.test(r)).length === 0, requests);
    check('adding needs its own step: the button asks for confirmation', /Add domain to Services/.test(found));
    await viewer.click('#svcDiscoverAdd');
    await waitText(/Add full\.example to Services\?/);
    const ask = await section();
    check('the confirmation warns about the repeated key and the address that is not on the domain', /"walletBridge" more than once/.test(ask) && /Trading Station is not on this domain/.test(ask), ask);
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
    check('the card lists the advertised services, none of them green', /Global Mail/.test(card) && /Chain Labs/.test(card) && /Calendar/.test(card) && (await viewer.$$eval('.svc-domain .svc-status', (e) => e.every((x) => x.dataset.state !== 'active'))), card);
    check('Trading Station is listed even though its address was refused, and the address is not offered', /Trading Station/.test(card) && !(await viewer.$eval('body', (b) => b.innerHTML.includes('https://evil.example/trade'))));
    await viewer.click('.svc-service[data-service="postOffice"] .svc-open');
    await viewer.waitForSelector('#svcSettings');
    const link = await viewer.$eval('#svcServiceLink', (a) => ({ href: a.href, rel: a.rel, target: a.target }));
    check('the relative address resolves on the domain and opens safely', link.href === 'https://full.example/mail/' && /noopener/.test(link.rel) && link.target === '_blank', link);
    check('the page says what is needed before anything can be done', /have not joined/.test(await text('#svcSettings')));
    await viewer.click('#svcBack');
    await viewer.click('.svc-service[data-service="calendar"] .svc-open');
    await viewer.waitForSelector('#svcSettings');
    const cal = await text('#svcSettings');
    check('a service the wallet does not operate says so, with no toggle and no invented settings', /does not use Calendar from here yet/.test(cal) && /has nothing to set up for it/.test(cal) && (await viewer.$('#svcEnabled')) === null && (await viewer.$('#svcLoadSettings')) === null, cal);
    await viewer.click('#svcBack');
    await viewer.click('.svc-service[data-service="chainLabs"] .svc-open');
    await viewer.waitForSelector('#svcOpenLedger');
    await viewer.click('#svcOpenLedger');
    await viewer.waitForSelector('#ledgerSubscreen.active');
    check('Chain Labs points at the Ledger tab', true);
    await viewer.click('#servicesSubtabBtn');
    await viewer.click('#svcBack');

    console.log('--- a second domain, typed in ---');
    await viewer.fill('#servicesAddInput', LEAN);
    await viewer.click('#servicesAddBtn');
    await waitText(/Add lean\.example to Services\?/);
    check('the preview names what it advertises, including the alias spelling', /Trading Station/.test(await section()) && /Global Mail/.test(await section()) && /Directory/.test(await section()));
    await viewer.click('#svcAddConfirm');
    await viewer.waitForSelector('.svc-domain[data-domain="' + LEAN + '"]');
    check('both domains are kept', (await state()).domains.map((d) => d.domain).sort().join() === [LEAN, FULL].sort().join());

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
