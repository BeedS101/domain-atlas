// Real-browser check of the terms footer and risk notice: mobile and desktop layout, no horizontal overflow added,
// footer not covered by other elements, everything present with JavaScript disabled, and the link works.
//   node test/manual-site-chrome-browser.js [screenshot-dir]
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const REPO = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'site-shared/pages.json'), 'utf8'));
const SHOTS = process.argv[2] || '';
const procs = [], dirs = [];
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const stripChrome = (html) => html.replace(/[ \t]*<!-- atlas-site:[a-z]+:start -->[\s\S]*?<!-- atlas-site:[a-z]+:end -->\n?/g, '');
const FOOTER_TEXT = '© 2026 Bruno da Silva. All rights reserved.\nTerms & Conditions | Experimental Platform — Use at Your Own Risk';

async function serve(site) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-chrome-b-'));
  dirs.push(root);
  fs.cpSync(path.join(REPO, site), root, { recursive: true });
  fs.cpSync(path.join(REPO, 'issuer-php'), root, { recursive: true });
  const port = await freePort();
  procs.push(spawn('php', ['-S', '127.0.0.1:' + port, '-t', root, path.join(root, 'test-router.php')], { cwd: root, stdio: 'ignore', detached: true }));
  for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:' + port + '/terms/')).ok) break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }
  return { site, port };
}
const urlOf = (site, f) => '/' + f.replace(site + '/', '').replace(/^issuer-php\//, '');

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  let checked = 0;
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  for (const d of [await serve('demo-domain-a'), await serve('demo-domain-b')]) {
    const pages = cfg.notice.concat(cfg.footerOnly).filter((f) => f.startsWith(d.site + '/') || f === 'issuer-php/atlas/studio/index.html' || f === 'issuer-php/atlas-admin/index.html');
    pages.push(d.site + '/terms/index.html');
    for (const f of pages) {
      const url = f.endsWith('/terms/index.html') ? '/terms/' : urlOf(d.site, f);
      const full = 'http://127.0.0.1:' + d.port + url;
      for (const [label, vp] of [['mobile', { width: 375, height: 667 }], ['desktop', { width: 1280, height: 800 }]]) {
        for (const js of [true, false]) {
          if (!js && label === 'desktop') continue;
          const ctx = await browser.newContext({ viewport: vp, javaScriptEnabled: js });
          const page = await ctx.newPage();
          const tag = d.site + url + ' [' + label + (js ? '' : ', no JS') + ']';
          try {
            await page.goto(full, { waitUntil: 'load', timeout: 20000 });
            await page.waitForTimeout(js ? 400 : 50);
            const m = await page.evaluate(() => {
              const f = document.querySelector('.atlas-site-footer');
              const n = document.querySelector('.atlas-risk-notice');
              window.scrollTo(0, document.documentElement.scrollHeight);
              const r = f ? f.getBoundingClientRect() : null;
              const top = r ? document.elementFromPoint(Math.min(r.left + 5, innerWidth - 1), Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 1)) : null;
              const nr = n ? n.getBoundingClientRect() : null;
              return {
                footerCount: document.querySelectorAll('.atlas-site-footer').length, footerText: f ? f.innerText.trim() : null,
                footerBox: r && { l: r.left, r: r.right, h: r.height, vis: getComputedStyle(f).display !== 'none' && getComputedStyle(f).visibility !== 'hidden' },
                covered: top ? !f.contains(top) : null,
                noticeBox: nr && { l: nr.left, r: nr.right, h: nr.height }, scrollW: document.documentElement.scrollWidth, innerW: innerWidth,
                href: f && f.querySelector('a') && f.querySelector('a').getAttribute('href'),
              };
            });
            if (m.footerCount !== 1) problems.push(tag + ': footer count ' + m.footerCount);
            if ((m.footerText || '').replace(/\n+/g, '\n') !== FOOTER_TEXT) problems.push(tag + ': footer text ' + JSON.stringify(m.footerText));
            if (!m.footerBox || !m.footerBox.vis || m.footerBox.h < 20) problems.push(tag + ': footer not visible');
            if (m.footerBox && (m.footerBox.l < -1 || m.footerBox.r > m.innerW + 1)) problems.push(tag + ': footer outside viewport width');
            if (m.covered) problems.push(tag + ': footer is covered by another element');
            if (m.href !== '/terms/') problems.push(tag + ': terms link ' + m.href);
            const wantNotice = cfg.notice.includes(f);
            if (wantNotice !== !!m.noticeBox) problems.push(tag + ': notice presence ' + !!m.noticeBox);
            if (m.noticeBox && (m.noticeBox.l < -1 || m.noticeBox.r > m.innerW + 1)) problems.push(tag + ': notice outside viewport width');
            if (js && label === 'mobile' && !f.endsWith('/terms/index.html')) {
              // The chrome must not add horizontal scrolling the page did not already have.
              const base = await ctx.newPage();
              await base.route(full, async (route) => { const resp = await route.fetch(); await route.fulfill({ response: resp, body: stripChrome(await resp.text()) }); });
              await base.goto(full, { waitUntil: 'load', timeout: 20000 });
              await base.waitForTimeout(400);
              const baseW = await base.evaluate(() => document.documentElement.scrollWidth);
              if (m.scrollW > baseW) problems.push(tag + ': page scroll width grew from ' + baseW + ' to ' + m.scrollW);
              await base.close();
            }
            if (f.endsWith('/terms/index.html') && m.scrollW > m.innerW) problems.push(tag + ': terms page overflows horizontally');
            if (!js && label === 'mobile' && f === d.site + '/index.html') {
              await page.click('.atlas-site-footer a');
              await page.waitForURL('**/terms/', { timeout: 10000 });
              const h1 = await page.textContent('h1');
              if (!/Terms/.test(h1)) problems.push(tag + ': link did not reach the terms page');
            }
            if (SHOTS && js) await page.screenshot({ path: path.join(SHOTS, (d.site.replace('demo-domain-', 'd') + url).replace(/[\/.]/g, '_') + '_' + label + '.png'), fullPage: true });
            checked++;
          } catch (e) { problems.push(tag + ': ' + e.message); }
          await ctx.close();
        }
      }
    }
  }
  await browser.close();
  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  if (problems.length) { console.log(problems.join('\n')); console.log('\nFAILED: ' + problems.length + ' problem(s) in ' + checked + ' page views'); process.exit(1); }
  console.log('All site-chrome browser checks passed (' + checked + ' page views).');
})().catch((e) => { console.error(e); process.exit(2); });
