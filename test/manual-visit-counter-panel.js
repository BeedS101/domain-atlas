// Manual check for the admin panel's "Visits" section
// (issuer-server/admin-panel/index.html, identical to
// issuer-php/atlas-admin/index.html): it renders POST /atlas/admin/visits
// as a per-world table (Today / Last 7 days / Last 30 days) plus a per-day
// list. Server side is covered by manual-visit-counter.js and
// manual-visit-counter-php.js; this loads the real panel in real Chrome
// against an isolated issuer-server with a seeded visits file.
//
// The seeded days are chosen to sit on the window edges, so an off-by-one
// in the 7-day or 30-day window shows up as a wrong number:
//   today        plaza 3, lobby 2, old-world 1 (not in the manifest)
//   today - 3    plaza 4
//   today - 6    arena 2        (last day inside "7 days")
//   today - 7    lobby 9        (first day outside "7 days", inside "30")
//   today - 10   market 5
//   today - 20   museum 6
//   today - 40   arena 7        (outside "30 days")
//
// Checks:
//   1. Without a session the panel shows the logged-out notice and the
//      Visits section isn't visible.
//   2. Logged in, every world row has the expected Today / 7 / 30 counts,
//      names come from the manifest, and the undeclared id is listed by id.
//   3. The "All worlds" row and the "Last 7 days" headline are the column
//      sums.
//   4. The per-day list shows today's total, today - 3 and today - 10.
//   5. A new visit followed by "Refresh now" bumps today's numbers.
//   6. A rejected session (expired/unknown token) shows an error in the
//      section instead of numbers.
//
// Not part of the permanent suite, same reasoning as the other manual-*.js
// scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { withAdminAuth } = require('./lib/admin-auth');
const { subtle } = webcrypto;

const PORT = 8211; // isolated — distinct from every other manual-*.js test's chosen port
const DOMAIN = 'localhost:' + PORT;
const BASE = 'http://' + DOMAIN;
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-visits-panel-state-'));
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-visits-panel-docroot-'));

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
function utcDay(offsetDays) {
  return new Date(Date.now() + (offsetDays || 0) * 86400000).toISOString().slice(0, 10);
}
async function postJson(urlPath, body) {
  const res = await fetch(BASE + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

(async () => {
  console.log('SETUP: isolated issuer-server on port ' + PORT + ' with a seeded visits file');
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = b64url(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)));
  fs.writeFileSync(path.join(STATE_DIR, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey, addedAt: new Date().toISOString() }] }));
  fs.writeFileSync(path.join(STATE_DIR, 'atlas-visits-store.json'), JSON.stringify({
    days: {
      [utcDay(0)]: { plaza: 3, lobby: 2, 'old-world': 1 },
      [utcDay(-3)]: { plaza: 4 },
      [utcDay(-6)]: { arena: 2 },
      [utcDay(-7)]: { lobby: 9 },
      [utcDay(-10)]: { market: 5 },
      [utcDay(-20)]: { museum: 6 },
      [utcDay(-40)]: { arena: 7 }
    }
  }));
  const serverProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: DOCROOT_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    serverProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });

  // A real admin session, obtained the way the wallet does (nonce -> signed
  // login), so the panel's own whoami check passes.
  const nonce = (await (await fetch(BASE + '/atlas/admin/session/nonce')).json()).nonce;
  const loginPayload = withAdminAuth({ nonce }, BASE, '/atlas/admin/session/start');
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(canonicalize(loginPayload))));
  const login = await postJson('/atlas/admin/session/start', { payload: loginPayload, proof: { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) } });
  assert(login.status === 200 && login.body.token, 'could not start an admin session: ' + JSON.stringify(login));
  const token = login.body.token;

  const browser = await chromium.launch({ headless: false, executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });

  async function rowCells(page, world) {
    return page.$$eval('#visitsBody tr[data-world="' + world + '"] td', (tds) => tds.map((td) => td.textContent));
  }

  try {
    console.log('STEP 1: without a session the Visits section is not shown');
    const anon = await (await browser.newContext()).newPage();
    await anon.goto(BASE + '/atlas-admin/', { waitUntil: 'load' });
    await anon.waitForSelector('#loggedOutNotice', { state: 'visible', timeout: 5000 });
    assert(!(await anon.isVisible('#visitsPanel')), 'the Visits section must stay hidden while logged out');
    console.log('PASS: logged-out notice only');

    const adminCtx = await browser.newContext();
    await adminCtx.addInitScript((t) => {
      try { sessionStorage.setItem('atlasAdminSession', JSON.stringify({ token: t, expiresAt: Date.now() + 3600000 })); } catch (err) {}
    }, token);
    const page = await adminCtx.newPage();
    await page.goto(BASE + '/atlas-admin/', { waitUntil: 'load' });
    await page.waitForSelector('#visitsBody tr.total', { timeout: 10000 });

    console.log('STEP 2: per-world Today / 7 / 30 counts, manifest names, undeclared id listed');
    const expected = {
      plaza: ['Example Plaza', '3', '7', '7'],
      arena: ['Example Arena', '0', '2', '2'],
      market: ['Example Trading Post', '0', '0', '5'],
      museum: ['Example Museum', '0', '0', '6'],
      lobby: ['Example Lobby', '2', '2', '11'],
      'old-world': ['old-world (no longer declared)', '1', '1', '1']
    };
    for (const [world, cells] of Object.entries(expected)) {
      const got = await rowCells(page, world);
      assert(JSON.stringify(got) === JSON.stringify(cells), world + ': expected ' + JSON.stringify(cells) + ', got ' + JSON.stringify(got));
    }
    console.log('PASS: six rows match, window edges (today-6 in, today-7 out of 7 days; today-40 out of 30) correct');

    console.log('STEP 3: "All worlds" row and the headline are the column sums');
    const total = await rowCells(page, '*');
    assert(JSON.stringify(total) === JSON.stringify(['All worlds', '6', '12', '32']), 'unexpected totals row: ' + JSON.stringify(total));
    assert((await page.textContent('#visitsWeekTotal')) === '12', 'unexpected 7-day headline');
    console.log('PASS: totals 6 / 12 / 32');

    console.log('STEP 4: per-day list');
    const daily = await page.$$eval('#visitsDailyBody tr', (trs) => trs.map((tr) => [tr.dataset.day, tr.children[1].textContent]));
    assert(daily.length === 14, 'expected 14 days listed, got ' + daily.length);
    const byDay = Object.fromEntries(daily);
    assert(byDay[utcDay(0)] === '6' && byDay[utcDay(-3)] === '4' && byDay[utcDay(-10)] === '5' && byDay[utcDay(-1)] === '0', 'unexpected per-day numbers: ' + JSON.stringify(daily));
    assert(!(utcDay(-20) in byDay), 'a 20-day-old bucket must not be in the 14-day list');
    console.log('PASS: today 6, -3 -> 4, -10 -> 5, empty days 0');

    console.log('STEP 5: a new visit shows up after "Refresh now"');
    const ping = await postJson('/atlas/visit', { world: 'plaza' });
    assert(ping.status === 200, 'visit ping failed');
    await page.click('#visitsRefreshBtn');
    await page.waitForFunction(() => document.querySelector('#visitsBody tr[data-world="plaza"] td:nth-child(2)').textContent === '4', null, { timeout: 5000 });
    const total2 = await rowCells(page, '*');
    assert(JSON.stringify(total2) === JSON.stringify(['All worlds', '7', '13', '33']), 'unexpected totals after refresh: ' + JSON.stringify(total2));
    console.log('PASS: plaza today 3 -> 4, totals 7 / 13 / 33');

    console.log('STEP 6: a rejected session shows an error instead of numbers');
    await postJson('/atlas/admin/session/logout', { token });
    await page.click('#visitsRefreshBtn');
    await page.waitForFunction(() => /Could not load visits/.test(document.getElementById('visitsError').textContent), null, { timeout: 5000 });
    console.log('PASS: error shown ->', await page.textContent('#visitsError'));

    console.log('\nALL VISIT COUNTER (PANEL) CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    serverProc.kill();
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
    process.exit(process.exitCode || 0);
  }
})();
