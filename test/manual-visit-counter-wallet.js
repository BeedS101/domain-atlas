// Manual check for the wallet side of the anonymous visit counter: entering
// a world — 2D (procedural-v1) or 3D (gltf-mini-v1) — sends exactly one
// POST /atlas/visit to the world's own domain, carrying nothing but the
// world id. Server side is covered by manual-visit-counter.js (Node) and
// manual-visit-counter-php.js; this drives the real extension in real
// Chrome against an isolated issuer-server.
//
// Why 2D matters specifically: presence only ever joined for 3D worlds, so
// an operator's "who's here" view never saw a visitor in plaza/arena/
// market/museum. The visit ping is deliberately independent of presence so
// those worlds are counted too.
//
// Checks:
//   1. Entering the default world (plaza, 2D) records exactly one visit.
//   2. Travelling to the lobby (3D) records one visit for it.
//   3. Travelling to market (2D) records one visit for it — 2D counted.
//   4. Every ping is POST {"world":"<id>"} and nothing else: no identity,
//      no cookies, no extra fields.
//   5. A failing /atlas/visit (the endpoint erroring) doesn't stop the
//      visitor entering the world.
//
// Not part of the permanent suite, same reasoning as the other manual-*.js
// scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8210; // isolated — distinct from every other manual-*.js test's chosen port
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-visit-wallet-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-visit-wallet-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-visit-wallet-profile-'));
const VISITS_FILE = path.join(STATE_DIR, 'atlas-visits-store.json');

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
function todaysCounts() {
  if (!fs.existsSync(VISITS_FILE)) return {};
  const days = JSON.parse(fs.readFileSync(VISITS_FILE, 'utf8')).days;
  return days[new Date().toISOString().slice(0, 10)] || {};
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitForCount(world, expected) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if ((todaysCounts()[world] || 0) === expected) return;
    await sleep(100);
  }
  throw new Error('ASSERTION FAILED: expected ' + world + ' to reach ' + expected + ' visit(s), have ' + JSON.stringify(todaysCounts()));
}

(async () => {
  console.log('SETUP: isolated issuer-server (demo-domain-a copy) on port ' + PORT);
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
  // The wallet pings the domain the MANIFEST names (manifest.domain), not
  // whatever host it was loaded from — demo-domain-a names localhost:8001,
  // so point the isolated copy at this test's own port instead.
  const manifestPath = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');
  const manifestDoc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifestDoc.domain = DOMAIN;
  fs.writeFileSync(manifestPath, JSON.stringify(manifestDoc, null, 2));
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

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
  });

  const pings = [];
  context.on('request', (req) => {
    if (req.url().endsWith('/atlas/visit') && req.method() === 'POST') {
      pings.push({ body: req.postData(), headers: req.headers() });
    }
  });

  try {
    const page = await context.newPage();
    await page.goto('http://' + DOMAIN + '/', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => !document.getElementById('placeLabel').textContent.includes('Loading'), { timeout: 10000 });

    console.log('STEP 1: entering the default world (plaza, 2D) records exactly one visit');
    await waitForCount('plaza', 1);
    await sleep(500); // a duplicate ping would land well inside this
    assert(todaysCounts().plaza === 1, 'expected exactly one plaza visit after entering once, got ' + JSON.stringify(todaysCounts()));
    assert(!(await frame.evaluate(() => !!window.__atlasActive3D)), 'expected plaza to be a 2D world for this check to mean what it says');
    console.log('PASS: plaza (2D) -> 1');

    console.log('STEP 2: travelling to the lobby (3D) records one visit for it');
    await frame.evaluate(() => enterWorld('lobby'));
    await frame.waitForFunction(() => !!window.__atlasActive3D, { timeout: 15000 });
    await waitForCount('lobby', 1);
    console.log('PASS: lobby (3D) -> 1');

    console.log('STEP 3: travelling to market (2D) records one visit — 2D worlds are counted too');
    await frame.evaluate(() => enterWorld('market'));
    await frame.waitForFunction(() => currentWorld && currentWorld.id === 'market' && !window.__atlasActive3D, { timeout: 15000 });
    await waitForCount('market', 1);
    console.log('PASS: market (2D) -> 1; today =', JSON.stringify(todaysCounts()));

    console.log('STEP 4: every ping is POST {"world":"<id>"} and nothing else — no identity, no cookies');
    assert(pings.length === 3, 'expected exactly three pings for three world entries, got ' + pings.length);
    for (const ping of pings) {
      const body = JSON.parse(ping.body);
      assert(Object.keys(body).length === 1 && typeof body.world === 'string', 'unexpected ping body: ' + ping.body);
      assert(!ping.headers.cookie, 'expected no cookie header on a ping');
    }
    assert(JSON.stringify(pings.map((p) => JSON.parse(p.body).world)) === JSON.stringify(['plaza', 'lobby', 'market']), 'unexpected ping order/worlds: ' + pings.map((p) => p.body));
    console.log('PASS: three bodies, each only a world id, no cookies');

    console.log('STEP 5: an erroring /atlas/visit does not stop the visitor entering a world');
    await context.route('**/atlas/visit', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' }));
    await frame.evaluate(() => enterWorld('arena'));
    await frame.waitForFunction(() => currentWorld && currentWorld.id === 'arena' && !document.getElementById('placeLabel').textContent.includes('Loading'), { timeout: 15000 });
    assert((todaysCounts().arena || 0) === 0, 'the intercepted ping never reached the server, so arena must still be 0');
    console.log('PASS: arena entered normally while the ping endpoint was failing');

    console.log('\nALL VISIT COUNTER (WALLET) CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
    serverProc.kill();
    try { fs.rmSync(DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (err) {}
    process.exit(process.exitCode || 0);
  }
})();
