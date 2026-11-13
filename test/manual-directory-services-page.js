// The directory page (directory-server/index.html, the same file as directory-php/atlas/directory/index.html) when sites
// advertise services: a row says "N worlds · M services", a service-only site shows 0 worlds, an expanded site lists its Worlds
// and its Services, the functionality buttons browse by kind of service, Open links are safe, and it still fits a phone.
// Everything is served from throw-away local servers and driven in headless Chromium; nothing outside 127.0.0.1 is requested.
//
//   node test/manual-directory-services-page.js                       (Node directory)
//   DIRECTORY_IMPL=php node test/manual-directory-services-page.js    (PHP directory)
// Screenshots go to $DIRECTORY_SHOTS when it is set.
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const { webcrypto } = require('crypto');
const { chromium } = require('playwright');
const { startDirectory } = require('./support/directory-harness');
const { canonicalize } = require('../directory-server/server.js');

const IMPL = process.env.DIRECTORY_IMPL || 'node';
const SHOTS = process.env.DIRECTORY_SHOTS;
let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log('PASS ' + label);
  else { failures++; console.log('FAIL ' + label + (detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 300) : '')); }
}
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const world = (id, name, genre, scale) => ({
  id, name, entry: { scene: '/s/' + id + '.json', renderer: ['procedural-v1'] },
  policy: { guestAccess: 'open', discoverable: true, itemDropsAllowed: false, trustedIssuers: 'any' },
  profile: { genre, scale, capabilities: { building: 'none', vehicles: false, combat: 'none', landOwnership: false } }, portals: []
});
function serve(build) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(build('127.0.0.1:' + server.address().port))); });
    server.listen(0, '127.0.0.1', () => resolve({ server, host: '127.0.0.1:' + server.address().port, url: 'http://127.0.0.1:' + server.address().port + '/.well-known/spatial.json' }));
  });
}

(async () => {
  const servers = [];
  const dir = await startDirectory({ port: 8311, env: { DIRECTORY_ALLOW_LOCAL: '1', DIRECTORY_SUBMITS_PER_HOUR: '1000', DIRECTORY_CRAWL_INTERVAL_MS: '3600000' } });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    // ---- fixtures: worlds only; worlds and services; services only (two); and a key-anchored site with services ----
    const plain = await serve((h) => ({ spec: 'domain-atlas/1.0', domain: h, owner: { name: 'World Makers' }, worlds: [world('p1', 'Example Plaza', 'marketplace', 'room'), world('p2', 'Example Lobby', 'lobby', 'building')] }));
    const mixed = await serve((h) => ({ spec: 'domain-atlas/1.0', domain: h, owner: { name: '<b>Everything</b>' }, postOffice: true, mailRelay: true, assetStudio: { enabled: true, url: `https://${h}/atlas/studio/` }, chainlabs: { enabled: true }, scanner: true,
      worlds: [world('m1', 'Example Museum', 'museum', 'building'), world('m2', 'Mining Burrow', 'mining', 'room')] }));
    const mail = await serve((h) => ({ spec: 'domain-atlas/1.0', domain: h, postOffice: true, mailRelay: true, worlds: [] }));
    const market = await serve((h) => ({ spec: 'domain-atlas/1.0', domain: h, trading: { enabled: true }, directory: true, calendar: true, worlds: [] }));
    const keyPair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const identityKey = b64url(await webcrypto.subtle.exportKey('raw', keyPair.publicKey));
    const unsigned = { spec: 'domain-atlas/1.0', identityKey, owner: { name: 'Key Keeper' }, postOffice: true, worlds: [], updated: new Date().toISOString() };
    const signature = b64url(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, new TextEncoder().encode(canonicalize(unsigned))));
    const keyed = await serve(() => ({ ...unsigned, signature }));
    servers.push(plain, mixed, mail, market, keyed);
    for (const s of servers) {
      const r = await fetch(dir.base + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest: s.url }) });
      if (!r.ok) throw new Error('could not submit a fixture: ' + r.status + ' ' + (await r.text()));
    }

    const errors = [];
    const searchPath = (u) => /\/search(\.php)?$/.test(u.pathname);
    const newPage = async (viewport, rewrite) => {
      const context = await browser.newContext({ viewport });
      await context.route((u) => u.hostname !== '127.0.0.1', (r) => r.abort());
      const p = await context.newPage();
      p.on('pageerror', (e) => errors.push(String(e)));
      if (rewrite) {
        await p.route((u) => searchPath(u), async (route) => {
          const res = await route.fetch();
          const body = await res.json();
          rewrite(body);
          await route.fulfill({ response: res, json: body });
        });
      }
      return { context, p };
    };
    const { context, p: page } = await newPage({ width: 1100, height: 900 });
    await page.goto(dir.base + '/');
    await page.waitForSelector('.group');
    const text = (sel) => page.locator(sel).first().innerText();
    const rows = () => page.locator('.group').count();
    const site = (s) => page.locator('.group[data-key="domain:' + s.host + '"]');
    const keyRow = page.locator('.group', { hasText: 'verified key' });
    const waitStatus = (re) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('status').textContent), re.source);

    console.log('--- worlds and services in one compact row ---');
    check('the title says it is a network directory', (await page.title()) === 'Domain Atlas Network Directory');
    check('the status counts sites, worlds and services', (await text('#status')) === '5 sites · 4 worlds · 11 services found', await text('#status'));
    check('one row per site', (await rows()) === 5);
    const mixedText = await site(mixed).innerText();
    check('a mixed site shows its worlds and its services', /2 worlds/.test(mixedText) && /5 services/.test(mixedText) && /Last seen/.test(mixedText), mixedText);
    const mailText = await site(mail).innerText();
    check('a service-only site shows 0 worlds and its services', /0 worlds/.test(mailText) && /2 services/.test(mailText), mailText);
    check('a world-only site shows no services', /2 worlds/.test(await site(plain).innerText()) && !/service/.test(await site(plain).innerText()));
    check('a key-anchored site is named by its key and shows its service', /verified key/.test(await keyRow.innerText()) && /1 service/.test(await keyRow.innerText()) && !(await keyRow.innerText()).includes('127.0.0.1'));
    check('every site starts collapsed', (await page.locator('.toggle[aria-expanded="false"]').count()) === 5 && (await page.locator('.panel:visible').count()) === 0);
    check('the button says what it holds', /^Show 2 worlds and 5 services of /.test(await site(mixed).locator('.toggle').getAttribute('aria-label')) && /^Show 0 worlds and 2 services of /.test(await site(mail).locator('.toggle').getAttribute('aria-label')), await site(mail).locator('.toggle').getAttribute('aria-label'));
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, '6-services-collapsed.png'), fullPage: true }); }

    console.log('--- expanding ---');
    await site(mixed).locator('.toggle').click();
    const open1 = await site(mixed).locator('.panel').innerText();
    const headings = (s) => s.locator('.panel h3').allTextContents();
    check('an expanded site lists its Worlds and its Services', JSON.stringify(await headings(site(mixed))) === JSON.stringify(['Worlds', 'Services']) && /Example Museum/.test(open1) && /Mining Burrow/.test(open1), open1);
    check('services have human-friendly names, in a steady order', JSON.stringify(await site(mixed).locator('.service .svc-name').allInnerTexts()) === JSON.stringify(['Post Office', 'Mail Relay', 'Asset Studio', 'Chain Labs', 'Scanner']));
    check('no raw manifest field names are shown', !/postOffice|mailRelay|assetStudio|chainlabs/.test(open1));
    check('markup in an owner name stays text', (await site(mixed).locator('b').count()) === 0 && (await site(mixed).innerText()).includes('<b>Everything</b>'));
    await site(mail).locator('.toggle').click();
    const open2 = await site(mail).locator('.panel').innerText();
    check('a service-only site shows just Services', JSON.stringify(await headings(site(mail))) === JSON.stringify(['Services']) && /Post Office/.test(open2) && /Mail Relay/.test(open2), open2);
    await site(plain).locator('.toggle').click();
    check('a world-only site shows just Worlds', JSON.stringify(await headings(site(plain))) === JSON.stringify(['Worlds']));
    check('a service on an IP-address site has no link, and others are left as they are', (await page.locator('.service a').count()) === 0);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '7-services-expanded.png'), fullPage: true });
    await page.click('#toggleAll');
    await page.click('#toggleAll');
    check('Collapse all closes every site', (await page.locator('.panel:visible').count()) === 0 && (await text('#toggleAll')) === 'Expand all');
    await page.click('#toggleAll');
    check('Expand all opens them again', (await page.locator('.panel:visible').count()) === 5);
    await page.click('#toggleAll');

    console.log('--- browsing by functionality ---');
    check('the functionality buttons are there, with All selected', JSON.stringify(await page.locator('.cat').allInnerTexts()) === JSON.stringify(['All', 'Worlds', 'Communication', 'Assets', 'Ledger / Chain Labs', 'Trading', 'Directories', 'Other services']) && (await page.locator('.cat[aria-pressed="true"]').innerText()) === 'All');
    const pick = async (label, re) => { await page.locator('.cat', { hasText: new RegExp('^' + label + '$') }).click(); await waitStatus(re); };
    await pick('Communication', /^3 sites · 5 services found$/);
    check('Communication: the sites that advertise it and only their communication services', (await rows()) === 3 && (await page.locator('.cat[aria-pressed="true"]').innerText()) === 'Communication' && /^3 sites · 5 services found$/.test(await text('#status')), await text('#status'));
    check('...with no worlds counted or shown', !/world/.test(await text('#groups')) && (await site(mixed).innerText()).includes('2 services'), await site(mixed).innerText());
    check('...and the world filters are not offered while browsing services', (await page.locator('#scale').isHidden()) && (await page.locator('#combat').isHidden()) && (await page.locator('.search-row select').count()) === 0);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '8-communication.png'), fullPage: true });
    await pick('Assets', /^1 site · 1 service found$/);
    check('Assets', (await rows()) === 1 && /1 service/.test(await site(mixed).innerText()) && JSON.stringify(await site(mixed).locator('.service .svc-name').allInnerTexts()) === JSON.stringify(['Asset Studio']));
    await pick('Ledger / Chain Labs', /^1 site · 2 services found$/);
    check('Ledger / Chain Labs', (await rows()) === 1 && /2 services/.test(await site(mixed).innerText()));
    await pick('Trading', /^1 site · 1 service found$/);
    check('Trading', (await rows()) === 1 && (await site(market).count()) === 1);
    await pick('Directories', /^1 site · 1 service found$/);
    check('Directories', (await rows()) === 1 && (await site(market).count()) === 1);
    await pick('Other services', /^1 site · 1 service found$/);
    check('Other services', (await rows()) === 1 && (await site(market).count()) === 1);
    await pick('Worlds', /^2 sites · 4 worlds found$/);
    check('Worlds: the sites with worlds, no services, and the scale and combat filters appear here', !/service/.test(await text('#groups')) && (await page.locator('#scale').isVisible()) && (await page.locator('#combat').isVisible()) && (await page.locator('#toggleAll').isVisible()));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, '8b-worlds-filters.png'), fullPage: true });
    await page.selectOption('#scale', 'room');
    await waitStatus(/^2 sites · 2 worlds found$/);
    check('a world filter narrows worlds', (await rows()) === 2, await text('#status'));
    await pick('All', /^5 sites · 4 worlds · 11 services found$/);
    check('All shows everything again, and the world filters are hidden and not applied', (await page.locator('#worldFilters').isHidden()) && (await rows()) === 5);
    await pick('Worlds', /^2 sites · 2 worlds found$/);
    check('coming back to Worlds keeps the filter that was chosen', (await page.locator('#scale').inputValue()) === 'room' && (await rows()) === 2);
    await page.selectOption('#scale', '');
    await waitStatus(/^2 sites · 4 worlds found$/);
    await pick('All', /^5 sites · 4 worlds · 11 services found$/);
    await page.fill('#q', 'relay');
    await page.press('#q', 'Enter');
    await waitStatus(/^2 sites · 0 worlds · 2 services found$/);
    check('a search for a service name finds the sites that advertise it', (await rows()) === 2 && (await site(mail).count()) === 1 && (await site(mixed).count()) === 1 && /1 service/.test(await site(mixed).innerText()), await text('#status'));
    await page.fill('#q', '');
    await page.press('#q', 'Enter');
    await waitStatus(/^5 sites/);

    console.log('--- more sites than one page ---');
    await page.goto(dir.base + '/?groups=2');
    await page.waitForSelector('.group');
    check('the totals cover every page', (await text('#status')) === '5 sites · 4 worlds · 11 services found (showing 2 sites)' && (await rows()) === 2, await text('#status'));
    await page.click('#more');
    await page.waitForFunction(() => document.querySelectorAll('.group').length === 4);
    await page.click('#more');
    await page.waitForFunction(() => document.querySelectorAll('.group').length === 5);
    check('every site appears once, and the totals are the same on the last page', new Set(await page.locator('.group').evaluateAll((l) => l.map((x) => x.dataset.key))).size === 5 && (await text('#status')) === '5 sites · 4 worlds · 11 services found' && (await page.locator('#more').isHidden()));
    await context.close();

    console.log('--- links to a service ---');
    // The fixtures are on IP addresses, which never get a link, so the answers are rewritten: valid host names to check the
    // link, and addresses the directory itself would never send, to check the page does not trust them.
    const rewritten = (body) => {
      if (!body.groups) return;
      // Told apart by how many services they advertise: 5 (mixed), 3 (market), 2 (mail), 0 (plain).
      const names = { 5: 'alpha.example', 3: 'beta.example', 2: 'gamma.example', 0: 'delta.example' };
      const urls = {
        5: ['https://alpha.example/atlas/studio/', 'https://studio.alpha.example/x?y=1', 'javascript:alert(1)', 'https://evil.example/x', 'http://alpha.example/'],
        3: ['https://beta.example/"onmouseover="alert(1)', 'https://user@beta.example/', 'https://beta.example/#x'],
        2: ['https://gamma.example\\@evil.example/', 'data:text/html,x'],
      };
      for (const g of body.groups) {
        if (g.anchorType === 'domain') {
          g.domain = names[g.services.length];
          g.services.forEach((s, i) => { s.url = (urls[g.services.length] || [])[i] || null; });
        } else g.services.forEach((s) => { s.url = 'https://studio.example.com/'; });
      }
    };
    const rw = await newPage({ width: 1100, height: 900 }, rewritten);
    await rw.p.goto(dir.base + '/');
    await rw.p.waitForSelector('.group');
    await rw.p.click('#toggleAll');
    const links = await rw.p.locator('.service a').evaluateAll((as) => as.map((a) => ({ href: a.href, target: a.target, rel: a.rel, text: a.textContent })));
    check('only safe addresses on the site\'s own domain become Open links', JSON.stringify(links.map((l) => l.href).sort()) === JSON.stringify(['https://alpha.example/atlas/studio/', 'https://studio.alpha.example/x?y=1']), links);
    check('...opening in a new tab without handing over the opener', links.every((l) => l.target === '_blank' && /noopener/.test(l.rel) && /noreferrer/.test(l.rel) && /Open/.test(l.text)), links);
    check('a service with no safe address is listed without a link', (await rw.p.locator('.service', { hasText: 'Scanner' }).first().locator('a').count()) === 0 && (await rw.p.locator('.service').count()) === 11);
    check('a key-anchored site never gets a link, even if one is sent', (await rw.p.locator('.group', { hasText: 'verified key' }).locator('a').count()) === 0);
    check('nothing in an address can run script or add attributes', (await rw.p.locator('.service a[onmouseover], .service a[href^="javascript"]').count()) === 0 && (await rw.p.evaluate(() => window.__pwned)) === undefined);
    const popupPromise = rw.context.waitForEvent('page');
    await rw.p.locator('.service a').first().click();
    await (await popupPromise).close();
    check('following an Open link does not change the page', (await rw.p.locator('.toggle[aria-expanded="true"]').count()) === 5);
    if (SHOTS) await rw.p.screenshot({ path: path.join(SHOTS, '9-open-links.png'), fullPage: true });
    await rw.context.close();

    console.log('--- a directory that does not know about services yet ---');
    const old = await newPage({ width: 1100, height: 900 }, (body) => {
      if (!body.groups) return;
      delete body.serviceCount;
      body.groups = body.groups.filter((g) => g.worldCount > 0);
      body.count = body.groups.length;
      body.groups.forEach((g) => { delete g.services; delete g.serviceCount; });
    });
    await old.p.goto(dir.base + '/');
    await old.p.waitForSelector('.group');
    check('the page still shows worlds exactly as before', (await old.p.locator('#status').innerText()) === '2 sites · 4 worlds found' && (await old.p.locator('.group').count()) === 2 && !/service/.test(await old.p.locator('#groups').innerText()));
    await old.p.locator('.toggle').first().click();
    check('...and expands them', (await old.p.locator('.world:visible').count()) >= 2);
    await old.context.close();

    console.log('--- a phone screen ---');
    const phone = await browser.newContext({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2 });
    await phone.route((u) => u.hostname !== '127.0.0.1', (r) => r.abort());
    const pp = await phone.newPage();
    pp.on('pageerror', (e) => errors.push(String(e)));
    await pp.goto(dir.base + '/');
    await pp.waitForSelector('.group');
    const fits = () => pp.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    check('nothing scrolls sideways', await fits());
    const buttons = await pp.locator('.cat').evaluateAll((l) => l.map((b) => { const r = b.getBoundingClientRect(); return r.right <= 375 && r.left >= 0; }));
    check('every functionality button is on screen', buttons.length === 8 && buttons.every(Boolean), buttons);
    await pp.locator('.group[data-key="domain:' + mixed.host + '"] .toggle').click();
    check('an expanded site with worlds and services fits', (await pp.locator('.service:visible').count()) === 5 && (await pp.locator('.world:visible').count()) === 2 && await fits());
    if (SHOTS) await pp.screenshot({ path: path.join(SHOTS, '10-services-phone.png'), fullPage: true });
    await pp.locator('.cat', { hasText: /^Communication$/ }).click();
    await pp.waitForFunction(() => document.getElementById('status').textContent.startsWith('3 sites'));
    check('browsing a kind of service fits too', await fits());
    await phone.close();
    check('the page raised no script errors', errors.length === 0, errors);
  } finally {
    await browser.close();
    servers.forEach((s) => s.server.close());
    dir.stop();
  }
  console.log(failures === 0 ? '\nALL DIRECTORY SERVICES PAGE CHECKS PASSED (' + IMPL + ')' : '\n' + failures + ' DIRECTORY SERVICES PAGE CHECK(S) FAILED (' + IMPL + ')');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FAILURE:', e); process.exit(1); });
