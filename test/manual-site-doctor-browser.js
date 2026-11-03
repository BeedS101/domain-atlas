// Site doctor in a real browser: login, the full check against a site with a missing and an edited file,
// the sections and buttons, no console errors or CSP violations, a phone-width layout, and self-delete.
//   node test/manual-site-doctor-browser.js [screenshot dir]
'use strict';
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const REPO = path.resolve(__dirname, '..');
const shotDir = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (shotDir) fs.mkdirSync(shotDir, { recursive: true });
let failures = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => console.log('ok   ' + name), (e) => { failures++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 5).join('\n     ')); });
const tracked = (dir) => execFileSync('git', ['ls-files', '-z', '--', dir], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean).map((f) => f.slice(dir.length + 1));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-browser-'));
  const root = path.join(tmp, 'public_html');
  for (const [dir] of [['demo-domain-a'], ['issuer-php']]) for (const rel of tracked(dir)) {
    const dest = path.join(root, rel); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(REPO, dir, rel), dest);
  }
  const out = path.join(tmp, 'build');
  execFileSync('node', [path.join(REPO, 'tools/site-doctor-build.js'), out, '--allow-dirty'], { encoding: 'utf8' });
  const token = fs.readFileSync(path.join(out, 'ACCESS.txt'), 'utf8').match(/Token:\s+([0-9a-f-]{39})/)[1];
  fs.copyFileSync(path.join(out, 'site-doctor.php'), path.join(root, 'site-doctor.php'));
  // The situation the doctor exists for, plus some everyday noise.
  fs.unlinkSync(path.join(root, 'atlas/studio/inc/studio-mint.php'));
  fs.appendFileSync(path.join(root, 'lib/store.php'), '\n// edited\n');
  fs.writeFileSync(path.join(root, 'assets/badge.glb'), 'site own model');
  fs.writeFileSync(path.join(root, 'lib/issuer-private-key.pem'), 'PEM-SECRET-MARKER');
  // Feature switches: one on (email, with a password that must never be shown), one misconfigured (wrong host).
  fs.writeFileSync(path.join(root, 'lib/atlas-email-tickets-config.json'), JSON.stringify({ smtpHost: 'smtp.example.net', smtpUser: 'u', smtpPass: 'MAIL-PASS-MARKER', fromAddress: 'from-marker@example.net' }));
  fs.writeFileSync(path.join(root, 'lib/atlas-ledger-issuance-config.json'), JSON.stringify({ enabled: true, domain: 'not-this-host.example' }));

  const port = await freePort();
  const php = spawn('php', ['-S', '127.0.0.1:' + port, '-t', root], { stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { if (await new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); })) break; await new Promise((r) => setTimeout(r, 50)); }
  const url = 'http://127.0.0.1:' + port + '/site-doctor.php';

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await ctx.newPage();
  const problems = [];
  // The exposure probes request private files on purpose; the browser logs each 404/403 as a resource error.
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type()) && !/Failed to load resource: the server responded with a status of (403|404)/.test(m.text())) problems.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  let dialogText = null;
  page.on('dialog', async (d) => { dialogText = d.message(); await d.accept(); });

  await page.goto(url);
  await check('login page shows the commit and expiry and hides the app', async () => {
    assert.ok(/commit [0-9a-f]{12}/.test(await page.textContent('#sub')));
    assert.ok(/Valid until/.test(await page.textContent('#sub')));
    assert.ok(await page.locator('#app').evaluate((n) => n.classList.contains('hidden')));
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'doctor-login.png') });
  });

  await check('a wrong token is rejected and the app stays hidden', async () => {
    await page.fill('#token', 'aaaa-bbbb-cccc-dddd-eeee-ffff-0000-1111');
    await page.click('#go');
    await page.waitForFunction(() => /not accepted/i.test(document.getElementById('loginMsg').textContent), null, { timeout: 15000 });
    assert.ok(await page.locator('#app').evaluate((n) => n.classList.contains('hidden')));
  });
  problems.length = 0; // the expected 403 logs a console error

  await check('the real token runs the whole check and reports the missing and edited files', async () => {
    await page.fill('#token', token);
    await page.click('#go');
    await page.waitForFunction(() => /problem|Everything checked|look at/.test(document.getElementById('verdict').textContent), null, { timeout: 60000 });
    const verdict = await page.textContent('#verdict');
    assert.ok(/problem\(s\) to fix/.test(verdict), verdict);
    const text = await page.textContent('#sections');
    assert.ok(text.includes('atlas/studio/inc/studio-mint.php'), 'names the missing file');
    assert.ok(text.includes('lib/store.php'), 'names the edited file');
    assert.ok(text.includes('assets/badge.glb'), 'lists the site own model as unknown');
    assert.ok(text.includes('lib/issuer-private-key.pem') && /listed by name only/.test(text));
    assert.ok(!text.includes('PEM-SECRET-MARKER'));
    assert.ok(await page.locator('#login').evaluate((n) => n.classList.contains('hidden')));
    if (shotDir) { await page.locator('details.card').first().scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(shotDir, 'doctor-report-desktop.png'), fullPage: true }); }
  });

  await check('the exposure probes ran (the PHP built-in server cannot enforce .htaccess, helper includes still answer 404)', async () => {
    await page.locator('summary', { hasText: 'What the web can read' }).click();
    const text = await page.locator('details', { hasText: 'What the web can read' }).textContent();
    assert.ok(/\/lib\/store\.php/.test(text) && /Not readable/.test(text));
    assert.ok(!/can be read over the web/.test(text.replace('private helper files must not be served', '')), 'nothing flagged as exposed except the planted key, which the dev server serves');
  });

  await check('the Features section shows what is on, off and misconfigured, how to switch, and no secrets', async () => {
    const feat = page.locator('details', { hasText: 'Features (what is switched on)' });
    assert.ok(await feat.getAttribute('open') !== null, 'opens by itself when a feature needs attention');
    const text = await feat.textContent();
    assert.ok(/Email-delivered tickets/.test(text) && /outgoing server: smtp\.example\.net/.test(text) && /outgoing login: set/.test(text));
    assert.ok(/Ledger account credentials/.test(text) && /not this host/.test(text));
    assert.ok(/Transfer to file/.test(text) && /Asset Studio minting/.test(text) && /Call service/.test(text));
    assert.ok(/How to switch/.test(text) && /Turn on:/.test(text) && /Turn off:/.test(text));
    assert.ok(!text.includes('MAIL-PASS-MARKER') && !text.includes('from-marker@example.net'));
    const pills = await feat.locator('.feat .pill').allTextContents();
    assert.ok(pills.includes('ON') && pills.includes('off') && pills.includes('!') && pills.includes('n/a'), pills.join(','));
    const todo = await page.locator('details', { hasText: 'To do' }).first().textContent();
    assert.ok(/Feature needs attention: Ledger account credentials/.test(todo));
    if (shotDir) { await feat.scrollIntoViewIfNeeded(); await feat.locator('details').first().evaluate((d) => d.setAttribute('open', '')); await page.screenshot({ path: path.join(shotDir, 'doctor-features.png'), fullPage: true }); }
  });

  await check('Check again keeps a single set of sections', async () => {
    const before = await page.locator('#sections > details').count();
    await page.click('#rerun');
    await page.waitForFunction(() => !document.getElementById('rerun').disabled, null, { timeout: 60000 });
    assert.strictEqual(await page.locator('#sections > details').count(), before);
  });

  await check('copy buttons: report is redacted, file list names what to upload', async () => {
    await page.click('#copyMissing');
    const list = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(list.split('\n').includes('atlas/studio/inc/studio-mint.php') && list.split('\n').includes('lib/store.php'), list.slice(0, 200));
    await page.click('#copy');
    const rep = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(/Site Doctor report/.test(rep) && /MISSING/.test(rep));
    assert.ok(!rep.includes(root) && !rep.includes(tmp), 'folder paths are redacted');
    assert.ok(!rep.includes('PEM-SECRET-MARKER') && !rep.includes('MAIL-PASS-MARKER') && !rep.includes('from-marker@example.net'));
    assert.ok(/FEATURES/.test(rep) && /\[on\] Transfer to file/.test(rep) && /\[problem\] Ledger account credentials/.test(rep), rep.slice(0, 400));
  });

  await check('the phone-width layout has no horizontal scroll', async () => {
    await page.setViewportSize({ width: 390, height: 800 });
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(over <= 1, 'overflow ' + over);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, 'doctor-report-phone.png'), fullPage: false });
  });

  await check('no console errors, page errors or CSP violations', () => assert.deepStrictEqual(problems, []));

  await check('Delete this file asks first, removes only the doctor, and reports it', async () => {
    await page.click('#del');
    await page.waitForFunction(() => /deleted/i.test(document.getElementById('doneMsg').textContent), null, { timeout: 15000 });
    assert.ok(/Delete site-doctor\.php/.test(dialogText));
    assert.ok(!fs.existsSync(path.join(root, 'site-doctor.php')));
    assert.ok(fs.existsSync(path.join(root, 'lib/store.php')));
  });

  await browser.close();
  php.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? '\n' + failures + ' check(s) failed.' : '\nAll site doctor browser checks passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
