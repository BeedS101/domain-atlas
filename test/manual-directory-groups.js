// The directory page (directory-server/index.html, the same file as directory-php/atlas/directory/index.html) in a real
// browser: sites are grouped, collapsed by default, expandable with the mouse and the keyboard, filters and paging keep the
// counts right, key-anchored sites are named by their verified key, the Visit site link is safe, last-seen times are shown in
// the visitor's time zone, and it fits a phone screen. Everything is served from throw-away local servers; the page is driven
// in headless Chromium.
//
//   node test/manual-directory-groups.js                       (Node directory)
//   DIRECTORY_IMPL=php node test/manual-directory-groups.js    (PHP directory)
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
const caps = (combat) => ({ building: 'none', vehicles: false, combat, landOwnership: false });
const world = (id, over = {}) => ({
  id, name: id, entry: { scene: '/s/' + id + '.json', renderer: ['procedural-v1'] },
  policy: { guestAccess: 'open', discoverable: true, itemDropsAllowed: false, trustedIssuers: 'any' },
  profile: { genre: 'plain', scale: 'room', capabilities: caps('none') }, portals: [], ...over
});
function serve(build) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(build('127.0.0.1:' + server.address().port))); });
    server.listen(0, '127.0.0.1', () => resolve({ server, host: '127.0.0.1:' + server.address().port, url: 'http://127.0.0.1:' + server.address().port + '/.well-known/spatial.json' }));
  });
}

(async () => {
  const servers = [];
  const dir = await startDirectory({ port: 8310, env: { DIRECTORY_ALLOW_LOCAL: '1', DIRECTORY_SUBMITS_PER_HOUR: '1000', DIRECTORY_CRAWL_INTERVAL_MS: '3600000' } });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
  try {
    // ---- fixtures: five sites by domain and one by key ----
    const alpha = await serve((host) => ({ spec: 'domain-atlas/1.0', domain: host, owner: { name: 'Alpha Studio' }, acceptedItemClasses: ['atlas.wearable'], worlds: [
      world('market', { name: 'Grand Market', description: 'A busy trading hall.', profile: { genre: 'marketplace', scale: 'district', capabilities: caps('none') }, policy: { guestAccess: 'open', discoverable: true, identityRequired: true, trustedIssuers: 'any' }, portals: [{ kind: 'domain', to: servers[1] ? servers[1].host : 'beta.example' }, { kind: 'internal', to: 'arena' }] }),
      world('arena', { name: 'Duel Arena', description: 'Fight for glory.', profile: { genre: 'arena', scale: 'building', capabilities: caps('pvp') } }),
      world('garden', { name: 'Quiet Garden', profile: { genre: 'marketplace', scale: 'room', capabilities: caps('none') } })] }));
    servers.push(alpha);
    const beta = await serve((host) => ({ spec: 'domain-atlas/1.0', domain: host, worlds: [world('hall', { name: 'Beta Hall', profile: { genre: 'museum', scale: 'building', capabilities: caps('none') } })] }));
    servers.push(beta);
    const charlie = await serve((host) => ({ spec: 'domain-atlas/1.0', domain: host, worlds: [world('c1', { name: 'Charlie One' }), world('c2', { name: 'Charlie Two' })] }));
    const delta = await serve((host) => ({ spec: 'domain-atlas/1.0', domain: host, worlds: [world('d1', { name: 'Delta One' }), world('d2', { name: 'Delta Two' })] }));
    const echo = await serve((host) => ({ spec: 'domain-atlas/1.0', domain: host, owner: { name: '<b>Echo</b>' }, worlds: [world('e1', { name: '<img src=x onerror="window.__pwned=1">', description: '"quoted" & \'single\' <script>window.__pwned=2</script>' })] }));
    servers.push(charlie, delta, echo);
    const keyPair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const identityKey = b64url(await webcrypto.subtle.exportKey('raw', keyPair.publicKey));
    const unsigned = { spec: 'domain-atlas/1.0', identityKey, owner: { name: 'Key Keeper' }, worlds: [world('vault', { name: 'The Vault', profile: { genre: 'marketplace', scale: 'room', capabilities: caps('none') } })], updated: new Date().toISOString() };
    const signature = b64url(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keyPair.privateKey, new TextEncoder().encode(canonicalize(unsigned))));
    const keyed = await serve(() => ({ ...unsigned, signature }));
    servers.push(keyed);
    for (const s of [alpha, beta, charlie, delta, echo, keyed]) {
      const r = await fetch(dir.base + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest: s.url }) });
      if (!r.ok) throw new Error('could not submit a fixture: ' + r.status + ' ' + (await r.text()));
    }
    // alpha links to beta only if beta existed when alpha was served; crawl alpha again now that its host is known.
    await fetch(dir.base + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manifest: alpha.url }) });

    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const url = dir.base + '/';
    const text = (sel) => page.locator(sel).first().innerText();
    const rows = () => page.locator('.group').count();
    const open = (name) => (name.startsWith('127.') ? page.locator('.group[data-key="domain:' + name + '"]') : page.locator('.group', { hasText: name }));
    const shot = async (name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); } };

    console.log('--- one compact row per site, collapsed ---');
    await page.goto(url);
    await page.waitForSelector('.group');
    check('the status counts sites and worlds', (await text('#status')) === '6 sites · 10 worlds found', await text('#status'));
    check('there is one row per site, not one per world', (await rows()) === 6, await rows());
    check('every site starts collapsed', (await page.locator('.toggle[aria-expanded="false"]').count()) === 6 && (await page.locator('.worlds:visible').count()) === 0);
    const alphaRow = open(alpha.host);
    check('a row shows the domain, its number of worlds and a summary', /3 worlds/.test(await alphaRow.innerText()) && (await alphaRow.innerText()).includes(alpha.host) && /marketplace/.test(await alphaRow.innerText()) && /Alpha Studio/.test(await alphaRow.innerText()), await alphaRow.innerText());
    check('the site linked from elsewhere says so', /linked from 1 site/.test(await open(beta.host).innerText()), await open(beta.host).innerText());
    const keyRow = open('verified key');
    const keyText = await keyRow.innerText();
    check('a key-anchored site is named by its verified key, with no domain invented', keyText.includes('verified key') && keyText.includes(identityKey.slice(0, 12)) && !keyText.includes('127.0.0.1') && /1 world/.test(keyText), keyText);
    check('the full key is available on hover', (await keyRow.locator('.key').last().getAttribute('title')) === identityKey);
    check('every row says when the site was last seen, as the directory reports it', (await page.locator('.group .seen').count()) === 6 && /Last seen/.test(await alphaRow.innerText()), await alphaRow.innerText());
    check('a host that is not a real domain name gets no website link', (await page.locator('.group a').count()) === 0);
    await shot('1-collapsed-desktop');

    console.log('--- expanding ---');
    await alphaRow.locator('.toggle').click();
    check('clicking the button opens the worlds', (await alphaRow.locator('.toggle').getAttribute('aria-expanded')) === 'true' && (await alphaRow.locator('.world:visible').count()) === 3);
    const opened = await alphaRow.locator('.worlds').innerText();
    check('a world shows its name, description, genre and scale', /Grand Market/.test(opened) && /A busy trading hall\./.test(opened) && /marketplace/.test(opened) && /district/.test(opened), opened);
    check('...its access rules', /guests: open/.test(opened) && /identity required/.test(opened) && /atlas\.wearable/.test(opened) && /pvp/.test(opened), opened);
    check('...and its portals', new RegExp('2 portals: → ' + beta.host.replace('.', '\\.') + ', 1 other portal').test(opened) && /none/.test(opened), opened);
    check('other sites stay collapsed', (await page.locator('.worlds:visible').count()) === 1);
    await shot('2-expanded-desktop');
    await alphaRow.locator('.toggle').click();
    check('clicking again closes it', (await alphaRow.locator('.toggle').getAttribute('aria-expanded')) === 'false' && (await page.locator('.worlds:visible').count()) === 0);
    await alphaRow.locator('.group-name').click();
    check('the whole row can be clicked too', (await alphaRow.locator('.world:visible').count()) === 3);
    await alphaRow.locator('.group-name').click();

    console.log('--- keyboard ---');
    await open(beta.host).locator('.toggle').focus();
    await page.keyboard.press('Enter');
    check('Enter on the focused button opens a site', (await open(beta.host).locator('.toggle').getAttribute('aria-expanded')) === 'true');
    await page.keyboard.press('Space');
    check('Space closes it again', (await open(beta.host).locator('.toggle').getAttribute('aria-expanded')) === 'false');
    check('the button says what it does', /^Show 1 world of /.test(await open(beta.host).locator('.toggle').getAttribute('aria-label')));
    await page.click('#toggleAll');
    check('Expand all opens every site', (await page.locator('.toggle[aria-expanded="true"]').count()) === 6 && (await page.locator('.world:visible').count()) === 10 && (await text('#toggleAll')) === 'Collapse all');
    await page.click('#toggleAll');
    check('Collapse all closes them', (await page.locator('.worlds:visible').count()) === 0 && (await text('#toggleAll')) === 'Expand all');

    console.log('--- text from a manifest is shown as text ---');
    await open(echo.host).locator('.toggle').click();
    const echoText = await open(echo.host).innerText();
    check('markup in names and descriptions is not run', (await page.evaluate(() => window.__pwned)) === undefined && (await open(echo.host).locator('img, script, b').count()) === 0 && echoText.includes('<img src=x') && echoText.includes('<b>Echo</b>'), echoText);
    await open(echo.host).locator('.toggle').click();

    console.log('--- search and filters keep working ---');
    check('the scale and combat filters are not beside the search box, and are hidden until Worlds is chosen', (await page.locator('.search-row select').count()) === 0 && (await page.locator('#worldFilters').isHidden()) && (await page.locator('#scale').isHidden()));
    await page.locator('.cat', { hasText: /^Worlds$/ }).click();
    await page.waitForFunction(() => document.querySelector('.cat[aria-pressed="true"]').textContent === 'Worlds' && document.getElementById('status').textContent.includes('found'));
    check('choosing Worlds shows them', (await page.locator('#scale').isVisible()) && (await page.locator('#combat').isVisible()) && (await text('#status')) === '6 sites · 10 worlds found', await text('#status'));
    await page.selectOption('#combat', 'pvp');
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('1 site'));
    check('a filter narrows the sites and counts only the matching worlds', (await text('#status')) === '1 site · 1 world found' && /1 world/.test(await open(alpha.host).innerText()) && (await rows()) === 1, await text('#status'));
    await page.selectOption('#combat', '');
    await page.fill('#q', 'marketplace');
    await page.press('#q', 'Enter');
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('2 sites'));
    check('free-text search groups the matches', (await text('#status')) === '2 sites · 3 worlds found' && /2 worlds/.test(await open(alpha.host).innerText()), await text('#status'));
    await page.fill('#q', 'zzzz-nothing');
    await page.press('#q', 'Enter');
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('0 sites'));
    check('no matches says so', /No sites found/.test(await text('#groups')) && (await text('#status')) === '0 sites found');
    await page.fill('#q', '');
    await page.selectOption('#scale', 'building');
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('found'));
    check('the scale filter works', (await text('#status')) === '2 sites · 2 worlds found', await text('#status'));
    await page.selectOption('#scale', '');
    await page.locator('.cat', { hasText: /^All$/ }).click();
    await page.waitForFunction(() => document.querySelector('.cat[aria-pressed="true"]').textContent === 'All');
    check('going back to All hides them again', await page.locator('#worldFilters').isHidden());

    console.log('--- more sites than one page ---');
    await page.goto(url + '?groups=2');
    await page.waitForSelector('.group');
    check('the totals cover every page, not just the one shown', (await text('#status')) === '6 sites · 10 worlds found (showing 2 sites)' && (await rows()) === 2, await text('#status'));
    check('a button offers the rest', (await text('#more')) === 'Show more sites (4 left)');
    await page.locator('.group').first().locator('.toggle').click();
    await page.click('#more');
    await page.waitForFunction(() => document.querySelectorAll('.group').length === 4);
    check('more sites are added after the ones shown', (await rows()) === 4 && (await text('#more')) === 'Show more sites (2 left)' && (await text('#status')).startsWith('6 sites · 10 worlds found'));
    check('what was open stays open', (await page.locator('.toggle[aria-expanded="true"]').count()) === 1);
    await page.click('#more');
    await page.waitForFunction(() => document.querySelectorAll('.group').length === 6);
    check('the last page removes the button, and no site appears twice', (await page.locator('#more').isHidden()) && new Set(await page.locator('.group').evaluateAll((l) => l.map((x) => x.dataset.key))).size === 6 && (await text('#status')) === '6 sites · 10 worlds found');

    console.log('--- visit link and last seen ---');
    // The fixtures live on 127.0.0.1, which never gets a link (a site address must be a real host name), so the search answers
    // are rewritten here: valid names to check the link, hostile ones to check nothing unsafe becomes a link. Nothing outside
    // 127.0.0.1 is ever requested: the context aborts it.
    const domains = ['alpha.example', 'beta.example:8443', 'javascript:alert(1)', 'evil.example/x?y=1', 'user@evil.example'];
    const withRewrites = async (contextOptions) => {
      const context = await browser.newContext(contextOptions);
      await context.route((u) => u.hostname !== '127.0.0.1', (r) => r.abort());
      const p = await context.newPage();
      p.on('pageerror', (e) => errors.push(String(e)));
      await p.route((u) => /\/search(\.php)?$/.test(u.pathname), async (route) => {
        const res = await route.fetch();
        const body = await res.json();
        if (body.groups) {
          let n = 0;
          body.groups.forEach((g, i) => { if (g.anchorType === 'domain') g.domain = domains[n++]; g.lastSeenAt = i === 1 ? null : '2026-03-05T21:30:00Z'; });
        }
        await route.fulfill({ response: res, json: body });
      });
      await p.goto(url);
      await p.waitForSelector('.group');
      return { context, p };
    };
    const za = await withRewrites({ viewport: { width: 1100, height: 900 }, timezoneId: 'Africa/Johannesburg', locale: 'en-GB' });
    const links = await za.p.locator('.group a').evaluateAll((as) => as.map((a) => ({ href: a.href, target: a.target, rel: a.rel, text: a.textContent })));
    check('a valid host name gets a Visit site link to its https homepage, and only those do', links.length === 2 && links.map((l) => l.href).sort().join() === 'https://alpha.example/,https://beta.example:8443/', links);
    check('...which opens in a new tab without handing over the opener', links.every((l) => l.target === '_blank' && /noopener/.test(l.rel) && /noreferrer/.test(l.rel) && /Visit site/.test(l.text)), links);
    check('javascript:, paths, credentials and addresses are not turned into links', (await za.p.locator('.group a[href^="javascript"], .group a[href*="evil.example"]').count()) === 0);
    check('a key-anchored site gets no website link', (await za.p.locator('.group', { hasText: 'verified key' }).locator('a').count()) === 0);
    const link = za.p.locator('.group a', { hasText: 'Visit site' }).first();
    const popupPromise = za.context.waitForEvent('page');
    await link.click();
    const popup = await popupPromise;
    await popup.close();
    check('following the link does not also open the row', (await za.p.locator('.toggle[aria-expanded="true"]').count()) === 0);
    const first = za.p.locator('.group').filter({ has: za.p.locator('a[href="https://alpha.example/"]') });
    const seenText = (await first.locator('.seen').innerText()).replace(/\s/g, ' ');
    check('last seen is shown in the visitor\'s own time zone', /5 Mar 2026/.test(seenText) && /23:30/.test(seenText), seenText);
    check('...with the UTC time on hover and in the markup', (await first.locator('.seen').getAttribute('title')) === '2026-03-05T21:30:00Z (UTC)' && (await first.locator('time').getAttribute('datetime')) === '2026-03-05T21:30:00.000Z');
    check('a site with no known time shows no last seen', (await za.p.locator('.seen').count()) === 5, await za.p.locator('.seen').count());
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await za.p.screenshot({ path: path.join(SHOTS, '5-visit-and-seen-desktop.png'), fullPage: true }); }
    await za.context.close();
    const ny = await withRewrites({ viewport: { width: 1100, height: 900 }, timezoneId: 'America/New_York', locale: 'en-US' });
    const nyText = (await ny.p.locator('.seen').first().innerText()).replace(/\s/g, ' ');
    check('another time zone shows its own local time for the same moment', /Mar 5, 2026/.test(nyText) && /4:30 PM/.test(nyText), nyText);
    await ny.context.close();

    console.log('--- a phone screen ---');
    const phone = await browser.newPage({ viewport: { width: 375, height: 740 }, deviceScaleFactor: 2 });
    phone.on('pageerror', (e) => errors.push(String(e)));
    await phone.goto(url);
    await phone.waitForSelector('.group');
    const fits = () => phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    check('nothing scrolls sideways', await fits());
    const firstToggle = phone.locator('.group').first().locator('.toggle');
    const box = await firstToggle.boundingBox();
    check('the expand button stays on screen and is easy to tap', box && box.x + box.width <= 375 && box.width >= 36 && box.height >= 36, box);
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await phone.screenshot({ path: path.join(SHOTS, '3-collapsed-phone.png'), fullPage: true }); }
    await phone.locator('.group[data-key="domain:' + alpha.host + '"]').locator('.toggle').click();
    check('an expanded site fits as well', (await phone.locator('.group[data-key="domain:' + alpha.host + '"]').locator('.world:visible').count()) === 3 && await fits());
    if (SHOTS) await phone.screenshot({ path: path.join(SHOTS, '4-expanded-phone.png'), fullPage: true });
    check('the page raised no script errors', errors.length === 0, errors);
  } finally {
    await browser.close();
    servers.forEach((s) => s.server.close());
    dir.stop();
  }
  console.log(failures === 0 ? '\nALL DIRECTORY PAGE CHECKS PASSED (' + IMPL + ')' : '\n' + failures + ' DIRECTORY PAGE CHECK(S) FAILED (' + IMPL + ')');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FAILURE:', e); process.exit(1); });
