// The public demo collection on both demo domains (demo-domain-a is evtec.co.za, demo-domain-b is domain-atlas.co.za), in a real
// browser against two throw-away PHP issuers laid out like the live sites (the domain's pages over issuer-php, no keys or state copied):
//   - each home page's directory lists every demo once, links the ones this domain runs, and labels a link to the other domain
//   - every page a domain runs answers, its local assets answer, and it loads with no script error or failed local request
//   - a page a domain does not run is not served there
//   - under the real host names, the federation and reserve bank pages default to the other domain, and a demo works end to end
//   - the home pages and demo pages fit a phone, and nothing in the directory points at an admin, token or API address
//
//   xvfb-run -a node test/manual-demo-collection-browser.js [screenshot-dir]
'use strict';
const fs = require('fs');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
let playwright;
try { playwright = require('playwright'); } catch (e) { playwright = require('/home/claude/.npm-global/lib/node_modules/playwright'); }
const { startPhp } = require('./lib/gen1-issuers');

const REPO = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || '';
const CFG = JSON.parse(fs.readFileSync(path.join(REPO, 'site-shared', 'demos.json'), 'utf8'));
const SITES = Object.keys(CFG.sites);
const runsOn = (d) => d.runsOn || SITES;
let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : '')); };
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

async function serve(site) {
  const port = await freePort();
  // The domain's pages over issuer-php; .well-known holds this domain's keys, so the fixtures in the repo are not laid over the issuer's own.
  const be = await startPhp(port, { prepare: (bundle) => fs.cpSync(path.join(REPO, site), bundle, { recursive: true, filter: (src) => !/[\\/]\.well-known([\\/]|$)/.test(src) }) });
  return { site, host: CFG.sites[site].host, port, base: 'http://127.0.0.1:' + port, be };
}

(async () => {
  const servers = [];
  let browser;
  try {
    for (const s of SITES) servers.push(await serve(s));
    browser = await playwright.chromium.launch();
    if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

    for (const s of servers) {
      const other = servers.find((x) => x !== s);
      console.log('\n== ' + s.site + ' (' + s.host + ')');
      const mine = CFG.demos.filter((d) => runsOn(d).includes(s.site));
      const away = CFG.demos.filter((d) => !runsOn(d).includes(s.site));

      // directory
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      await page.goto(s.base + '/', { waitUntil: 'load' });
      const dir = page.locator('section.labs-dir');
      line((await dir.count()) === 1 && (await dir.locator('h2').innerText()) === 'Demo directory', 'the home page has one "Demo directory" section');
      const links = await dir.locator('a.labs-card').evaluateAll((as) => as.map((a) => ({ name: a.querySelector('.labs-name').textContent, href: a.getAttribute('href'), badges: [...a.querySelectorAll('.labs-badge')].map((b) => b.textContent), where: (a.querySelector('.labs-where') || {}).textContent || '' })));
      line(links.length === CFG.demos.length && new Set(links.map((l) => l.href)).size === CFG.demos.length, 'it lists all ' + CFG.demos.length + ' demos, each once', links.length);
      line(mine.every((d) => links.some((l) => l.href === '/' + d.file && l.name === d.title)), 'every demo this domain runs is a local link');
      line(away.every((d) => links.some((l) => l.href === 'https://' + other.host + '/' + d.file && l.badges.includes('On ' + other.host) && l.where.includes('Opens on ' + other.host))), 'each demo it does not run links to ' + other.host + ' and says so (' + away.map((d) => d.file).join(', ') + ')');
      line(links.every((l) => l.badges.includes('Experimental')), 'every card is labelled Experimental');
      line(links.every((l) => !/admin|token|private|api\.php|\.php|\/atlas\/(?!studio)/i.test(l.href)), 'no administrative, token, API or private address is linked');
      const text = await dir.innerText();
      line(/no monetary value/.test(text) && /no promise of redemption/.test(text), 'it states the assets have no monetary value');
      line((await page.locator('section.labs').count()) === 1 && (await page.locator('.atlas-risk-notice').count()) === 1 && (await page.locator('footer.atlas-site-footer').count()) === 1, 'the Labs section, the experimental notice and the footer are still there');
      await ctx.close();

      // pages a domain runs answer; pages it does not run are not served here
      for (const d of mine) {
        const res = await fetch(s.base + '/' + d.file);
        const body = await res.text();
        const refs = [...body.matchAll(/(?:src|href)="(\/[^"#?]*)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('//') && u !== '/' && !/\/$/.test(u));
        const bad = [];
        for (const u of new Set(refs)) { const r = await fetch(s.base + u); if (r.status !== 200) bad.push(u + ' ' + r.status); }
        line(res.status === 200 && /<title>/.test(body) && bad.length === 0, d.file + ' answers and its ' + new Set(refs).size + ' local files answer', bad.length ? bad : res.status);
      }
      for (const d of away) line((await fetch(s.base + '/' + d.file)).status === 404, d.file + ' is not served on this domain (it runs on ' + other.host + ')');

      // each page loads cleanly, on a desktop and on a phone
      for (const [label, vp] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 375, height: 667 }]]) {
        const c = await browser.newContext({ viewport: vp });
        const bad = [], errors = [];
        for (const d of [{ file: 'index.html' }, ...mine]) {
          const p = await c.newPage();
          const failed = [];
          p.on('pageerror', (e) => errors.push(d.file + ': ' + e.message));
          p.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(s.base)) failed.push(r.status() + ' ' + r.url().slice(s.base.length)); });
          await p.goto(s.base + '/' + d.file, { waitUntil: 'load' });
          await p.waitForTimeout(250);
          if (failed.length) bad.push(d.file + ': ' + failed.join(', '));
          if (d.file === 'index.html') {
            const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
            line(overflow <= 0, 'the home page has no horizontal scrolling on a ' + label, overflow);
            if (SHOTS) await p.screenshot({ path: path.join(SHOTS, s.site + '-directory-' + label + '.png'), fullPage: label === 'phone' });
          }
          await p.close();
        }
        line(errors.length === 0, 'no demo page raised a script error on a ' + label, errors);
        line(bad.length === 0, 'no demo page made a failed request to this domain on a ' + label, bad);
        await c.close();
      }

      // under the real host name: the second domain defaults to the other one, and a demo works end to end
      // The live sites are https, where Web Crypto is available. A request to the real host name is answered by this domain's throw-away issuer,
      // with the Host header the live site would see.
      const real = await browser.newContext({ ignoreHTTPSErrors: true });
      await real.route('https://' + s.host + '/**', (route) => {
        const req = route.request(), u = new URL(req.url());
        return route.fetch({ url: s.base + u.pathname + u.search, headers: { ...req.headers(), host: s.host } }).then((r) => route.fulfill({ response: r }));
      });
      const p = await real.newPage();
      const base = 'https://' + s.host;
      await p.goto(base + '/federation-demo.html', { waitUntil: 'load' });
      line((await p.inputValue('#domainBInput')) === other.host && (await p.textContent('#domainBDefault')) === other.host, 'federation demo: Domain B defaults to ' + other.host);
      await p.goto(base + '/reserve-bank-demo.html', { waitUntil: 'load' });
      line((await p.inputValue('#siblingDomainInput')) === other.host, 'reserve bank demo: the sibling domain defaults to ' + other.host);
      await p.goto(base + '/email-ticket-demo.html', { waitUntil: 'load' });
      await p.click('#issueBtn');
      await p.waitForSelector('#voucherCard .card', { timeout: 15000 }).catch(() => {});
      line((await p.locator('#voucherCard .card').count()) === 1 && /Done/.test(await p.textContent('#issueStatus')), 'email ticket demo: a voucher is issued by this domain', await p.textContent('#issueStatus'));
      const issuer = await p.evaluate(() => (document.querySelector('#voucherCard pre') || {}).textContent || '');
      line(issuer.includes('"issuer": "' + s.host + '"'), 'email ticket demo: the credential names this domain as issuer', issuer.slice(0, 200));
      await real.close();


      // the read-only deployment check passes on a complete domain and names a missing route
      // Asynchronous on purpose: the issuer's request log goes to a pipe this process reads, and a blocked event loop would stall it.
      const check = (base) => new Promise((res) => { const c = spawn('node', [path.join(REPO, 'tools', 'check-demo-deployment.js'), base, '--site', s.site]); let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', (status) => res({ status, stdout: out })); });
      let chk = await check(s.base);
      line(chk.status === 0 && /ALL CHECKS PASSED/.test(chk.stdout), 'tools/check-demo-deployment.js passes on this domain', chk.stdout.split('\n').filter((l) => /^FAIL/.test(l)).join(' | '));
      const gone = path.join(s.be.bundle, 'atlas', 'demo', 'oracle', 'attest.php');
      const kept = fs.readFileSync(gone);
      fs.rmSync(gone);
      chk = await check(s.base);
      line(chk.status === 1 && /FAIL route \/atlas\/demo\/oracle\/attest /.test(chk.stdout), 'it names a backend route that is not deployed', chk.stdout.split('\n').filter((l) => /^FAIL/.test(l)).join(' | '));
      fs.writeFileSync(gone, kept);

      // a local copy keeps the markup default
      const local = await browser.newContext();
      const lp = await local.newPage();
      await lp.goto(s.base + '/federation-demo.html', { waitUntil: 'load' });
      line((await lp.inputValue('#domainBInput')) === 'domain-atlas.co.za', 'a local copy keeps its markup default for Domain B');
      await local.close();
    }
  } finally {
    if (browser) await browser.close();
    for (const s of servers) try { s.be.stop(); } catch (e) { /* already gone */ }
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' DEMO COLLECTION CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); process.exit(1); });
