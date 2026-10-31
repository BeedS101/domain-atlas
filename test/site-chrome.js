// Terms footer coverage and link resolution for the demo websites, against real servers.
//   node test/site-chrome.js
// Stamped pages are static HTML, so this serves each domain the way the hosting does (the domain's demo folder
// with issuer-php laid over it) and checks every listed page, its /terms/ link, and the Node dev server too.
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'site-shared/pages.json'), 'utf8'));
const results = { pass: 0, fail: 0 };
const procs = [];
const dirs = [];
async function test(name, fn) {
  try { await fn(); results.pass++; console.log('ok   ' + name); } catch (e) { results.fail++; console.log('FAIL ' + name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 5).join('\n     ')); }
}
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
function get(port, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: Object.assign({ Host: 'a.test:' + port }, headers || {}) }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end();
  });
}
async function waitUp(port) { for (let i = 0; i < 100; i++) { try { await get(port, '/'); return; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } } throw new Error('server did not start'); }

async function phpDomain(site) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-chrome-'));
  dirs.push(root);
  fs.cpSync(path.join(REPO, site), root, { recursive: true });
  fs.cpSync(path.join(REPO, 'issuer-php'), root, { recursive: true });
  const port = await freePort();
  const p = spawn('php', ['-S', '127.0.0.1:' + port, '-t', root, path.join(root, 'test-router.php')], { cwd: root, stdio: 'ignore', detached: true });
  procs.push(p);
  await waitUp(port);
  return { site, port, root };
}
const urlOf = (site, file) => '/' + file.replace(site + '/', '').replace(/^issuer-php\//, '');
const FOOTER_LINES = ['© 2026 Bruno da Silva. All rights reserved.', 'Terms &amp; Conditions</a> | Experimental Platform — Use at Your Own Risk'];

(async () => {
  await test('every page is covered or deliberately excluded, and the stamped output is current', () => {
    const r = spawnSync('node', [path.join(REPO, 'tools/site-chrome.js'), '--check'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  const domains = [await phpDomain('demo-domain-a'), await phpDomain('demo-domain-b')];
  const pagesFor = (d) => cfg.notice.concat(cfg.footerOnly).filter((f) => f.startsWith(d.site + '/') || f.startsWith('issuer-php/'));
  const termsFragment = fs.readFileSync(path.join(REPO, 'site-shared/terms-content.html'), 'utf8');
  const marker = 'Do not give or accept money, or anything of real value';
  assert.ok(termsFragment.includes(marker));

  for (const d of domains) {
    await test(d.site + ': footer, notice and /terms/ link on every page; no duplicates; same-origin links only', async () => {
      for (const f of pagesFor(d)) {
        const r = await get(d.port, urlOf(d.site, f));
        assert.equal(r.status, 200, f + ' -> ' + r.status);
        const html = r.text;
        assert.equal((html.match(/class="atlas-site-footer"/g) || []).length, 1, f + ': exactly one footer');
        assert.equal((html.match(/<footer\b/gi) || []).length, 1, f + ': no other footer element');
        for (const line of FOOTER_LINES) assert.ok(html.includes(line), f + ': footer text ' + line);
        assert.ok(html.includes('<a href="/terms/">Terms &amp; Conditions</a>'), f + ': same-origin terms link');
        assert.equal((html.match(/class="atlas-risk-notice"/g) || []).length, cfg.notice.includes(f) ? 1 : 0, f + ': notice count');
        const stamped = (html.match(/<!-- atlas-site:[a-z]+:start -->[\s\S]*?<!-- atlas-site:[a-z]+:end -->/g) || []).join('\n');
        assert.ok(!/https?:\/\//i.test(stamped.replace(/<style>[\s\S]*?<\/style>/, '')), f + ': stamped markup has no absolute URL');
        assert.ok(!html.includes(marker), f + ': the terms text is not duplicated into the page');
      }
    });
    await test(d.site + ': /terms/ resolves, states every required point once, and /terms redirects', async () => {
      const r = await get(d.port, '/terms/');
      assert.equal(r.status, 200);
      const t = r.text.replace(/\s+/g, ' ');
      for (const phrase of ['experimental', '“as is”', 'at your own risk', 'no monetary value', 'no promise of redemption', 'availability, security, reliability', 'preservation of data',
        'maximum extent permitted by applicable law', 'cannot lawfully be excluded', 'protecting your wallet', 'discontinue', 'Republic of South Africa', 'Consumer Protection Act']) {
        assert.ok(t.includes(phrase), 'terms mention: ' + phrase);
      }
      assert.equal(r.text.split(marker).length - 1, 1, 'terms text appears once');
      assert.equal((r.text.match(/class="atlas-site-footer"/g) || []).length, 1, 'terms page has the footer too');
      assert.ok(!/<script/i.test(r.text), 'the terms page needs no JavaScript');
      const red = await get(d.port, '/terms');
      assert.ok(red.status === 301 || red.status === 302 || red.status === 200, '/terms answers: ' + red.status);
    });
  }

  await test('generated terms pages are identical on every domain (one source)', () => {
    const files = cfg.termsPages.map((f) => fs.readFileSync(path.join(REPO, f), 'utf8'));
    for (const f of files) assert.equal(f, files[0]);
    assert.ok(files[0].startsWith('<!-- Generated by tools/site-chrome.js'), 'marked as generated');
  });

  await test('the Node dev server serves /terms/ and redirects /terms', async () => {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'site-chrome-state-'));
    const doc = fs.mkdtempSync(path.join(os.tmpdir(), 'site-chrome-doc-'));
    dirs.push(state, doc);
    fs.cpSync(path.join(REPO, 'demo-domain-a'), doc, { recursive: true });
    const port = await freePort();
    const p = spawn('node', ['issuer-server/server.js'], { cwd: REPO, stdio: 'ignore', detached: true, env: Object.assign({}, process.env, { PORT: String(port), ATLAS_DOMAIN: 'localhost:' + port, ATLAS_STATE_DIR: state, ATLAS_DOCROOT: doc }) });
    procs.push(p);
    await waitUp(port);
    const r = await get(port, '/terms/');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('Terms &amp; Conditions'));
    const red = await get(port, '/terms');
    assert.equal(red.status, 301);
    assert.equal(red.headers.location, '/terms/');
    assert.equal((await get(port, '/')).status, 200, 'the root page still works');
    assert.equal((await get(port, '/no-such-folder/')).status, 404);
  });

  await test('the repository licence is untouched', () => {
    const r = spawnSync('git', ['diff', '--quiet', 'origin/main', '--', 'LICENSE'], { cwd: REPO });
    assert.equal(r.status, 0, 'LICENSE differs from main');
  });

  for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  console.log('\n' + results.pass + ' passed, ' + results.fail + ' failed');
  process.exit(results.fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
