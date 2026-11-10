// The "Explore the Labs" section on the two home pages (demo-domain-a is evtec.co.za, demo-domain-b is domain-atlas.co.za), in a real
// browser against a throw-away PHP server laid out like the live sites:
//   - the section links the Asset Studio, the market, the scanner and the Coin Creation Studio, and every link resolves
//   - the experimental / no monetary value wording is there, and no administrative or private address is linked
//   - the page's other content and navigation are still there
//   - desktop and mobile layout: no horizontal overflow, readable tap targets, one column on a phone, JavaScript not needed
//
//   xvfb-run -a node test/manual-site-labs-links.js [screenshot-dir]
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
let playwright;
try { playwright = require('playwright'); } catch (e) { playwright = require('/home/claude/.npm-global/lib/node_modules/playwright'); }

const REPO = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || '';
const EXPECTED = [
  ['Asset Studio', '/atlas/studio/'],
  ['Chainblock Labs market', '/chain-labs/index.html'],
  ['Ledger Scanner', '/chain-labs/scan35.html'],
  ['Coin Creation Studio', '/chain-labs/coin26.html']
];
const procs = [], dirs = [];
let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

async function serve(site) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-labs-'));
  dirs.push(root);
  fs.cpSync(path.join(REPO, 'issuer-php'), root, { recursive: true });
  fs.cpSync(path.join(REPO, site), root, { recursive: true });
  fs.cpSync(path.join(REPO, 'chain-labs'), path.join(root, 'chain-labs'), { recursive: true });
  const port = await freePort();
  procs.push(spawn('php', ['-S', '127.0.0.1:' + port, '-t', root], { cwd: root, stdio: 'ignore', detached: true }));
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:' + port + '/')).ok) break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }
  return { site, port, root };
}

(async () => {
  const browser = await playwright.chromium.launch();
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  try {
    for (const d of [await serve('demo-domain-a'), await serve('demo-domain-b')]) {
      const base = 'http://127.0.0.1:' + d.port;
      const html = fs.readFileSync(path.join(REPO, d.site, 'index.html'), 'utf8');
      console.log('\n== ' + d.site + (d.site === 'demo-domain-a' ? ' (evtec.co.za)' : ' (domain-atlas.co.za)'));

      const before = execFileSync('git', ['show', 'HEAD:' + d.site + '/index.html'], { cwd: REPO }).toString();
      const outside = (t) => t.replace(/[ \t]*<section class="labs"[\s\S]*?<\/section>\n\n/, '').replace(/[ \t]*<!-- atlas-demos:start -->[\s\S]*?<!-- atlas-demos:end -->\n\n?/, '').replace(/^ {2}\.labs[^\n]*\n/gm, '');
      line(outside(html) === outside(before), 'nothing else on the page changed: removing the new section and its styles gives back the previous page');

      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base + '/', { waitUntil: 'load' });
      const section = page.locator('section.labs');
      line((await section.count()) === 1 && (await section.locator('h2').innerText()) === 'Explore the Labs', 'one "Explore the Labs" section with a heading');
      const links = await section.locator('a').evaluateAll((as) => as.map((a) => [a.querySelector('.labs-name').textContent, a.getAttribute('href')]));
      line(JSON.stringify(links) === JSON.stringify(EXPECTED), 'it links the Asset Studio, market, scanner and Coin Creation Studio, in that order', links);
      line(links.every(([, href]) => href.startsWith('/') && !href.startsWith('//')), 'each link is on this domain, so it works on either site and on a test server', links);
      line(links.every(([, href]) => !/admin|token|private|api\.php|\.php/i.test(href)), 'no administrative, token, API or private address is linked', links);
      const text = await section.innerText();
      line(/Experimental demos/.test(text) && /no monetary value/.test(text) && /no promise of redemption/.test(text), 'it says the demos are experimental and the assets have no monetary value', text);
      line((await section.locator('.labs-badge').allInnerTexts()).every((t) => t === 'Experimental') && (await section.locator('.labs-badge').count()) === 4, 'each card is labelled Experimental');
      for (const [name, href] of EXPECTED) {
        const res = await fetch(base + href);
        const body = await res.text();
        line(res.status === 200 && /<title>/.test(body), name + ' resolves: ' + href + ' answers 200 with a page', res.status);
      }
      const callouts = (html.match(/class="callout"/g) || []).length;
      line(callouts === (before.match(/class="callout"/g) || []).length && (await page.locator('.callout').count()) === callouts && callouts >= 3, 'the existing callouts and the wallet extension steps are all still there (' + callouts + ')');
      line((await page.locator('.atlas-risk-notice').count()) === 1 && (await page.locator('footer.atlas-site-footer a[href="/terms/"]').count()) === 1, 'the experimental-platform notice and the terms footer are untouched');

      for (const [label, vp] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 375, height: 667 }]]) {
        for (const js of [true, false]) {
          if (!js && label === 'desktop') continue;
          const c = await browser.newContext({ viewport: vp, javaScriptEnabled: js });
          const p = await c.newPage();
          await p.goto(base + '/', { waitUntil: 'load' });
          const m = await p.evaluate(() => {
            const cards = [...document.querySelectorAll('.labs-card')].map((a) => a.getBoundingClientRect());
            const section = document.querySelector('section.labs').getBoundingClientRect();
            return {
              overflow: document.documentElement.scrollWidth - window.innerWidth,
              columns: new Set(cards.map((r) => Math.round(r.left))).size,
              minHeight: Math.min(...cards.map((r) => r.height)), minWidth: Math.min(...cards.map((r) => r.width)),
              inside: cards.every((r) => r.left >= section.left - 1 && r.right <= section.right + 1)
            };
          });
          const tag = label + (js ? '' : ', JavaScript off');
          line(m.overflow <= 0, tag + ': no horizontal scrolling', m);
          line(m.inside && m.minHeight >= 44 && m.minWidth >= 200, tag + ': cards sit inside the section and are comfortable to tap', m);
          line(label === 'mobile' ? m.columns === 1 : m.columns === 2, tag + ': ' + (label === 'mobile' ? 'one column' : 'two columns'), m);
          if (SHOTS) await p.screenshot({ path: path.join(SHOTS, d.site + '-' + label + (js ? '' : '-nojs') + '.png'), fullPage: false });
          await c.close();
        }
      }
      line(/\.labs-card:focus-visible\{ outline/.test(html), 'the stylesheet has a visible focus style for the cards');
      line(errors.length === 0, 'the page logged no errors', errors);
      await ctx.close();
    }
  } finally {
    await browser.close();
    for (const p of procs) { try { process.kill(-p.pid); } catch (e) { /* already gone */ } }
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' LABS LINK CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); for (const p of procs) { try { process.kill(-p.pid); } catch (x) { /* gone */ } } process.exit(1); });
