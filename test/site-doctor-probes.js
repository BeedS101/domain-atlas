// Site doctor in a real browser, against a site laid out like the hosting serves it (a folder name without its trailing
// slash is redirected, extensionless routes reach their .php file). It checks what the page asks and how it reads the
// answers:
//   - the world-drops and presence probes use the URLs the services actually answer, with valid parameters;
//   - a private path that answers HTTP 500 is "not confirmed as refused", not a pass; 403 and 404 are refusals;
//   - the summary counts WARNING and FAIL from the same list as the to-do checklist and the verdict.
//   node test/site-doctor-probes.js
'use strict';
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const REPO = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => console.log('ok   ' + name), (e) => { failures++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 6).join('\n     ')); });
const tracked = (dir) => execFileSync('git', ['ls-files', '-z', '--', dir], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean).map((f) => f.slice(dir.length + 1));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-probes-'));
let token, doctorPhp, n = 0;

// The hosting's behaviour that matters here: a folder requested without its slash is redirected to it, a folder with an
// index.php is served by it, and an extensionless route reaches its .php file. TEST_* variables stand in for a folder
// whose access rules answer with an error, or with a refusal.
const ROUTER = `<?php
$p = parse_url($_SERVER["REQUEST_URI"], PHP_URL_PATH);
$root = $_SERVER["DOCUMENT_ROOT"];
foreach (["TEST_META_STATUS" => "/atlas/call/lib/state/meta.json", "TEST_STORE_STATUS" => "/lib/store.php"] as $env => $path) {
  $code = getenv($env);
  if ($p === $path && $code) { http_response_code((int)$code); header("Content-Type: text/html"); echo "<h1>Status " . (int)$code . "</h1>"; return true; }
}
if ($p !== "/" && substr($p, -1) !== "/" && is_dir($root . $p)) { http_response_code(301); header("Location: " . $p . "/"); return true; }
$f = $root . rtrim($p, "/") . ".php";
if ($p !== "/" && !is_file($root . $p) && !is_dir($root . $p) && is_file($f)) { require $f; return true; }
return false;`;

function layout(mutate) {
  const root = path.join(tmp, 'site-' + (n++));
  for (const dir of ['demo-domain-a', 'issuer-php', 'call-php', 'presence-php']) for (const rel of tracked(dir)) {
    const dest = path.join(root, rel); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(REPO, dir, rel), dest);
  }
  fs.copyFileSync(doctorPhp, path.join(root, 'site-doctor.php'));
  fs.writeFileSync(path.join(root, 'router.php'), ROUTER);
  if (mutate) mutate(root);
  return root;
}

async function withSite(mutate, env, fn) {
  const root = layout(mutate);
  const port = await freePort();
  const spatialFile = path.join(root, '.well-known/spatial.json');
  const spatial = JSON.parse(fs.readFileSync(spatialFile, 'utf8'));
  spatial.domain = '127.0.0.1:' + port;
  if (mutate && mutate.spatial) mutate.spatial(spatial);
  fs.writeFileSync(spatialFile, JSON.stringify(spatial));
  const clean = {};
  for (const k of Object.keys(process.env)) if (!/^(ATLAS_|TEST_)/.test(k)) clean[k] = process.env[k];
  const php = spawn('php', ['-S', '127.0.0.1:' + port, '-t', root, path.join(root, 'router.php')], { stdio: 'ignore', env: Object.assign(clean, env || {}) });
  for (let i = 0; i < 100; i++) { if (await new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); })) break; await sleep(50); }
  try { return await fn({ base: 'http://127.0.0.1:' + port, port, root }); } finally { php.kill(); }
}

let browser;
// Opens the doctor, signs in, waits for the whole check and reads what it shows.
async function runDoctor(site) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const requests = [];
  page.on('request', (r) => { const u = new URL(r.url()); requests.push(u.pathname + u.search); });
  try {
    await page.goto(site.base + '/site-doctor.php');
    await page.fill('#token', token);
    await page.click('#go');
    await page.waitForFunction(() => /problem|Everything checked|look at/.test(document.getElementById('verdict').textContent), null, { timeout: 60000 });
    const todo = await page.evaluate(() => {
      const card = document.querySelector('#sections details');
      return { head: card.querySelector('summary').textContent, items: Array.from(card.querySelectorAll('.item')).map((i) => ({ cls: i.className, text: i.textContent })), lead: Array.from(card.querySelectorAll('p.muted')).map((p) => p.textContent).join(' | ') };
    });
    const sectionText = async (title) => page.evaluate((t) => { const d = Array.from(document.querySelectorAll('#sections details')).find((x) => x.querySelector('h2') && x.querySelector('h2').textContent.startsWith(t)); return d ? { text: d.textContent, items: Array.from(d.querySelectorAll('.item')).map((i) => ({ cls: i.className, text: i.textContent })) } : null; }, title);
    await page.click('#copy');
    const report = await page.evaluate(() => navigator.clipboard.readText());
    const sections = {};
    for (const t of ['What the web can read', 'Services']) sections[t] = await sectionText(t);
    return {
      requests, todo, report, sections,
      verdict: await page.textContent('#verdict'),
      tally: await page.textContent('#tally'),
      web: sections['What the web can read']
    };
  } finally { await ctx.close(); }
}
const num = (re, text) => { const m = text.match(re); return m ? Number(m[1]) : 0; };
// The summary, the verdict and the checklist must be one count.
function assertOneCount(r, label) {
  const warn = num(/(\d+) WARNING/, r.tally), fail = num(/(\d+) FAIL/, r.tally);
  const listed = r.todo.items.length;
  assert.strictEqual(warn + fail, listed, label + ': summary says ' + r.tally + ' but the checklist has ' + listed);
  assert.strictEqual(r.todo.items.filter((i) => /\bfail\b/.test(i.cls)).length, fail, label + ': FAIL count');
  assert.strictEqual(r.todo.items.filter((i) => /\bwarn\b/.test(i.cls)).length, warn, label + ': WARNING count');
  assert.strictEqual(num(/(\d+) problem/, r.verdict), fail, label + ': verdict problems');
  assert.strictEqual(num(/(\d+) (?:to look at|thing)/, r.verdict), warn, label + ': verdict warnings');
}

(async () => {
  const out = path.join(tmp, 'build');
  execFileSync('node', [path.join(REPO, 'tools/site-doctor-build.js'), out, '--allow-dirty'], { encoding: 'utf8' });
  token = fs.readFileSync(path.join(out, 'ACCESS.txt'), 'utf8').match(/Token:\s+([0-9a-f-]{39})/)[1];
  doctorPhp = path.join(out, 'site-doctor.php');
  browser = await chromium.launch();

  await check('the services answer the URLs the doctor now asks (and not the ones it used to)', async () => {
    await withSite(null, null, async (site) => {
      const bare = await fetch(site.base + '/atlas/world/drops', { redirect: 'manual' });
      assert.strictEqual(bare.status, 301, 'the bare folder name is redirected by the web server, which the page does not follow');
      const noParams = await fetch(site.base + '/presence/status.php');
      assert.strictEqual(noParams.status, 400, 'presence needs a domain and a world');
      const drops = await fetch(site.base + '/atlas/world/drops/?world=site-doctor-probe', { redirect: 'manual' });
      assert.strictEqual(drops.status, 200);
      const dj = await drops.json();
      assert.deepStrictEqual(dj.drops, []);
      assert.strictEqual(dj.world, 'site-doctor-probe');
      const pr = await fetch(site.base + '/presence/status.php?domain=' + encodeURIComponent('127.0.0.1:' + site.port) + '&world=site-doctor-probe');
      assert.deepStrictEqual(await pr.json(), { count: 0 });
    });
  });

  await check('the world-drops and presence probes ask the real URLs, pass, and raise no warning', async () => {
    await withSite(null, null, async (site) => {
      const r = await runDoctor(site);
      assert.ok(r.requests.includes('/atlas/world/drops/?world=site-doctor-probe'), 'asks the folder with its slash and a world');
      assert.ok(!r.requests.includes('/atlas/world/drops'), 'never asks the bare folder name');
      assert.ok(r.requests.includes('/presence/status.php?domain=' + encodeURIComponent('127.0.0.1:' + site.port) + '&world=site-doctor-probe'), 'asks presence with this host as the domain and a world');
      assert.ok(!r.requests.includes('/presence/status.php'), 'never asks presence with no parameters');
      const svc = r.sections['Services'];
      const drops = svc.items.find((i) => i.text.includes('/atlas/world/drops/?world=site-doctor-probe'));
      const pres = svc.items.find((i) => i.text.includes('/presence/status.php?domain='));
      assert.ok(drops && /\bok\b/.test(drops.cls) && /answers \(HTTP 200\)/.test(drops.text), 'drops: ' + (drops && drops.text));
      assert.ok(pres && /\bok\b/.test(pres.cls) && /answers \(HTTP 200\)/.test(pres.text), 'presence: ' + (pres && pres.text));
      assert.ok(!r.todo.items.some((i) => /world\/drops|presence\/status/.test(i.text)), 'no to-do for either: ' + r.todo.items.map((i) => i.text.slice(0, 80)).join(' | '));
      assertOneCount(r, 'healthy site');
    });
  });

  await check('a world-drops listing that is not JSON, or lacks "drops", is still reported', async () => {
    await withSite((root) => { fs.writeFileSync(path.join(root, 'atlas/world/drops/index.php'), '<?php header("Content-Type: application/json"); echo "{\\"domain\\":\\"x\\"}";'); }, null, async (site) => {
      const r = await runDoctor(site);
      const item = r.todo.items.find((i) => /world\/drops/.test(i.text));
      assert.ok(item && /\bwarn\b/.test(item.cls) && /not the expected JSON \(no "drops"\)/.test(item.text), item && item.text);
    });
  });

  for (const [code, expected] of [[403, 'denied'], [404, 'denied'], [500, 'unclear']]) {
    await check('a private data folder answering HTTP ' + code + (expected === 'unclear' ? ' is "not confirmed as refused", counted and explained' : ' is a refusal and counts as a pass'), async () => {
      await withSite(null, { TEST_META_STATUS: String(code) }, async (site) => {
        const r = await runDoctor(site);
        const path1 = '/atlas/call/lib/state/meta.json';
        const row = r.web.items.find((i) => i.text.includes(path1));
        assert.ok(row, 'the probe is listed');
        const inTodo = r.todo.items.find((i) => i.text.includes(path1));
        if (expected === 'denied') {
          assert.ok(/\bok\b/.test(row.cls), row.text);
          assert.ok(!inTodo, 'no to-do');
        } else {
          assert.ok(/\bwarn\b/.test(row.cls), row.cls);
          assert.match(row.text, /Not confirmed as refused: the server answered HTTP 500/);
          assert.match(row.text, /not the same as a refusal|an error is not the same as a refusal/);
          assert.match(row.text, /error log/);
          assert.ok(inTodo && /\bwarn\b/.test(inTodo.cls), 'in the checklist as a warning');
          assert.match(inTodo.text, /Not confirmed as refused: \/atlas\/call\/lib\/state\/meta\.json \(HTTP 500\)/);
          assert.doesNotMatch(inTodo.text, /tried to run this file/, 'a data file gets the folder advice');
          assert.match(r.report, /UNCLEAR \/atlas\/call\/lib\/state\/meta\.json \(HTTP 500\)/);
          assert.match(r.report, /WARNING by section: .*Web exposure 1/);
        }
        assertOneCount(r, 'HTTP ' + code);
      });
    });
  }

  await check('a PHP helper that answers HTTP 500 gets the "it tried to run it" explanation', async () => {
    await withSite(null, { TEST_STORE_STATUS: '500' }, async (site) => {
      const r = await runDoctor(site);
      const inTodo = r.todo.items.find((i) => i.text.includes('Not confirmed as refused: /lib/store.php'));
      assert.ok(inTodo, 'in the checklist');
      const row = r.web.items.find((i) => i.text.includes('/lib/store.php'));
      assert.match(row.text, /tried to run this file and it failed/);
    });
  });

  await check('code that comes back over the web is still a failure, in the checklist and the summary', async () => {
    // the dev server cannot enforce .htaccess, so the planted key is served: the exposure path itself is unchanged
    await withSite((root) => { fs.writeFileSync(path.join(root, 'lib/issuer-private-key.pem'), '-----BEGIN PRIVATE KEY-----\nPEM-SECRET-MARKER\n-----END PRIVATE KEY-----\n'); }, null, async (site) => {
      const r = await runDoctor(site);
      const bad = r.todo.items.find((i) => /Readable over the web: \/lib\/issuer-private-key\.pem/.test(i.text));
      assert.ok(bad && /\bfail\b/.test(bad.cls));
      assert.ok(!r.report.includes('PEM-SECRET-MARKER'));
      assertOneCount(r, 'exposed key');
    });
  });

  await check('the summary and the checklist agree when the warnings come from different sections', async () => {
    // a large revocation list (housekeeping) and an advertised email intake address with no configuration (manifest)
    const mutate = (root) => {
      const revoked = [];
      for (let i = 0; i < 7304; i++) revoked.push({ id: 'urn:atlas:asset:' + String(i).padStart(8, '0') + '-xxxxxxxx-xxxx-xxxx-xxxxxxxxxxxx', revokedAt: '2026-01-01T00:00:00Z', reason: 'test entry with some padding so the file is about the size of a long-lived issuer list ........................' });
      fs.writeFileSync(path.join(root, '.well-known/atlas-revocations.json'), JSON.stringify({ revoked }));
    };
    mutate.spatial = (m) => { m.emailTickets = Object.assign({}, m.emailTickets || {}, { intakeAddress: 'tickets@example.invalid' }); };
    await withSite(mutate, { TEST_META_STATUS: '500' }, async (site) => {
      const r = await runDoctor(site);
      const texts = r.todo.items.map((i) => i.text);
      assert.ok(texts.some((t) => /revocation list is (very )?large/i.test(t)), 'large revocation list: ' + texts.join(' | ').slice(0, 400));
      assert.ok(texts.some((t) => /Manifest: .*email intake address/.test(t)), 'email intake mismatch is in the checklist');
      assert.ok(texts.some((t) => /Not confirmed as refused: \/atlas\/call\/lib\/state\/meta\.json/.test(t)));
      assertOneCount(r, 'mixed sections');
      // each section keeps its own line: the lead names where the warnings come from
      assert.match(r.todo.lead, /to look at \(.*Housekeeping 1.*\)/);
      assert.match(r.todo.lead, /Manifest 1/);
      assert.match(r.todo.lead, /Web exposure 1/);
      assert.match(r.report, /WARNING by section: .*Manifest 1/);
      assert.match(r.report, new RegExp('SUMMARY  .*' + num(/(\d+) WARNING/, r.tally) + ' WARNING'));
    });
  });

  await check('a site with a missing file reports the same count in the summary, verdict and checklist', async () => {
    await withSite((root) => { fs.unlinkSync(path.join(root, 'atlas/studio/inc/studio-mint.php')); fs.appendFileSync(path.join(root, 'lib/store.php'), '\n// edited\n'); fs.writeFileSync(path.join(root, 'lib/atlas-ledger-issuance-config.json'), JSON.stringify({ enabled: true, domain: 'not-this-host.example' })); }, null, async (site) => {
      const r = await runDoctor(site);
      assert.ok(r.todo.items.some((i) => /missing code file/.test(i.text)));
      assertOneCount(r, 'missing and edited files');
    });
  });

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? '\n' + failures + ' FAILED' : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
