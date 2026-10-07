// Manual check that 2D (procedural-v1) worlds join presence, so every scene
// of a domain — not just the 3D lobby — shows who is there. Drives the real
// extension in real Chrome against an isolated issuer-server (demo-domain-a
// copy: plaza/arena/market/museum are 2D, lobby is 3D) and, in turn, both
// presence backends:
//   - presence-server (Node): the wallet's WebSocket transport.
//   - presence-php (php -S): WebSocket fails fast, so the wallet falls back
//     to HTTP polling — where a member that stops syncing is swept after
//     PRESENCE_POLL_TIMEOUT_MS, so a 2D visitor (who sends no position)
//     must still be kept alive by the sync tick alone.
//
// Checks, per backend:
//   1. Entering plaza (2D) puts exactly one anonymous visitor in plaza's
//      presence room.
//   2. Another visitor joining that room shows up in the wallet's own
//      roster (the data behind the Friends screen's "here now" list) even
//      though a 2D world draws no avatars.
//   3. Travelling plaza -> lobby (3D) -> market (2D) moves the visitor
//      between rooms: each world's count follows them, never two at once.
//   4. (PHP only) Sitting in a 2D world past the poll staleness timeout
//      doesn't get the visitor swept.
//   5. Leaving a 2D world (market -> arena) removes the visitor from its
//      room.
//   6. The admin panel's "Online now" lists the visitor under their 2D
//      world.
//   7. (Node only) A presence server that is down doesn't stop a 2D world
//      from loading.
//
// Not part of the permanent suite, same reasoning as the other manual-*.js
// scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const ROOT = path.resolve(__dirname, '..');
const EXT_PATH = path.join(ROOT, 'extension');
const ISSUER_PORT = 8212; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_PRESENCE_PORT = 8213;
const PHP_PRESENCE_PORT = 8214;
const DOMAIN = 'localhost:' + ISSUER_PORT;
const BASE = 'http://' + DOMAIN;

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
async function postJson(base, urlPath, body) {
  const res = await fetch(base + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
function waitForLine(proc, text, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' did not start in time')), 10000);
    const onData = (d) => { if (d.toString().includes(text)) { clearTimeout(timer); resolve(); } };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => reject(new Error(label + ' exited early with code ' + code)));
  });
}

async function status(presenceBase, world) {
  const res = await fetch(presenceBase + '/presence/status?domain=' + encodeURIComponent(DOMAIN) + '&world=' + encodeURIComponent(world));
  return res.json();
}
async function waitForCount(presenceBase, world, expected, label) {
  const deadline = Date.now() + 10000;
  let last;
  while (Date.now() < deadline) {
    last = await status(presenceBase, world);
    if (last.count === expected) return last;
    await sleep(200);
  }
  throw new Error('ASSERTION FAILED: ' + label + ': expected ' + world + ' count ' + expected + ', last saw ' + JSON.stringify(last));
}

async function runBackend(kind) {
  const isPhp = kind === 'php';
  const presencePort = isPhp ? PHP_PRESENCE_PORT : NODE_PRESENCE_PORT;
  const presenceBase = 'http://localhost:' + presencePort;
  const tag = '[' + (isPhp ? 'PHP polling' : 'Node WebSocket') + '] ';

  const docroot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-presence2d-docroot-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-presence2d-state-'));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-presence2d-profile-'));
  const phpBundle = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-presence2d-php-'));
  const procs = [];
  let context;
  let browser;
  try {
    console.log('SETUP ' + tag + 'issuer-server on ' + ISSUER_PORT + ', presence on ' + presencePort);
    fs.cpSync(path.join(ROOT, 'demo-domain-a'), docroot, { recursive: true });
    const manifestPath = path.join(docroot, '.well-known', 'spatial.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.domain = DOMAIN;
    manifest.presence = presenceBase;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const adminKey = b64url(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)));
    fs.writeFileSync(path.join(stateDir, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: adminKey, addedAt: new Date().toISOString() }] }));

    const issuer = spawn('node', ['issuer-server/server.js'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(ISSUER_PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: stateDir, ATLAS_DOCROOT: docroot }
    });
    procs.push(issuer);
    await waitForLine(issuer, 'listening', 'issuer-server');

    let presenceProc;
    if (isPhp) {
      fs.cpSync(path.join(ROOT, 'presence-php'), phpBundle, { recursive: true });
      presenceProc = spawn('php', ['-S', 'localhost:' + presencePort, 'test-router.php'], {
        cwd: phpBundle, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4' }
      });
      await waitForLine(presenceProc, 'Development Server', 'php -S');
    } else {
      presenceProc = spawn(process.execPath, [path.join(ROOT, 'presence-server', 'server.js')], {
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(presencePort) }
      });
      await waitForLine(presenceProc, 'listening', 'presence-server');
    }
    procs.push(presenceProc);

    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      executablePath: '/opt/pw-browsers/chromium',
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
    });
    const page = await context.newPage();
    await page.goto(BASE + '/', { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => !document.getElementById('placeLabel').textContent.includes('Loading'), { timeout: 10000 });

    console.log('STEP 1 ' + tag + 'entering plaza (2D) puts one anonymous visitor in its presence room');
    assert(!(await frame.evaluate(() => !!window.__atlasActive3D)), 'plaza must be a 2D world for this check to mean what it says');
    const plaza = await waitForCount(presenceBase, 'plaza', 1, 'after entering plaza');
    assert(plaza.roster[0].name === 'Visitor' && !plaza.roster[0].publicKey, 'expected an anonymous "Visitor", got ' + JSON.stringify(plaza.roster));
    console.log('PASS: plaza ->', JSON.stringify(plaza.roster));

    console.log('STEP 2 ' + tag + 'another visitor appears in the wallet\'s roster although a 2D world draws no avatars');
    const observer = await postJson(presenceBase, '/presence/poll/join', { domain: DOMAIN, world: 'plaza', name: 'Observer', publicKey: 'observer-key' });
    assert(observer.status === 200 && observer.body.id, 'observer could not join: ' + JSON.stringify(observer));
    await frame.waitForFunction(() => presenceRosterMeta.size === 1 && [...presenceRosterMeta.values()][0].name === 'Observer', null, { timeout: 10000 });
    assert(await frame.evaluate(() => presenceIsConnected()), 'expected the wallet to report presence connected in a 2D world');
    console.log('PASS: roster holds Observer, presence connected');
    await postJson(presenceBase, '/presence/poll/leave', { id: observer.body.id });

    console.log('STEP 3 ' + tag + 'plaza -> lobby (3D) -> market (2D): the visitor is in exactly one room at a time');
    await frame.evaluate(() => enterWorld('lobby'));
    await frame.waitForFunction(() => !!window.__atlasActive3D, { timeout: 15000 });
    await waitForCount(presenceBase, 'lobby', 1, 'in lobby');
    await waitForCount(presenceBase, 'plaza', 0, 'plaza after leaving it');
    await frame.evaluate(() => enterWorld('market'));
    await frame.waitForFunction(() => currentWorld && currentWorld.id === 'market' && !window.__atlasActive3D, { timeout: 15000 });
    await waitForCount(presenceBase, 'market', 1, 'in market');
    await waitForCount(presenceBase, 'lobby', 0, 'lobby after leaving it');
    console.log('PASS: lobby 1 -> market 1, previous rooms emptied');

    if (isPhp) {
      console.log('STEP 4 ' + tag + 'a 2D visitor sitting past the poll staleness timeout is not swept');
      await sleep(18000); // PRESENCE_POLL_TIMEOUT_MS is 15s; only the sync tick keeps a position-less member alive
      const still = await status(presenceBase, 'market');
      assert(still.count === 1, 'expected the 2D visitor to still be present after 18s, got ' + JSON.stringify(still));
      console.log('PASS: still present after 18s');
    }

    console.log('STEP 5 ' + tag + 'leaving a 2D world removes the visitor from its room');
    await frame.evaluate(() => enterWorld('arena'));
    await frame.waitForFunction(() => currentWorld && currentWorld.id === 'arena', { timeout: 15000 });
    await waitForCount(presenceBase, 'arena', 1, 'in arena');
    await waitForCount(presenceBase, 'market', 0, 'market after leaving it');
    console.log('PASS: arena 1, market 0');

    console.log('STEP 6 ' + tag + 'the admin panel\'s Online now lists the visitor under their 2D world');
    const nonce = (await (await fetch(BASE + '/atlas/admin/session/nonce')).json()).nonce;
    const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(canonicalize({ nonce }))));
    const login = await postJson(BASE, '/atlas/admin/session/start', { payload: { nonce }, proof: { signerRole: 'raw-ecdsa', publicKey: adminKey, signature: b64url(sig) } });
    assert(login.status === 200 && login.body.token, 'could not start an admin session: ' + JSON.stringify(login));
    const adminPage = await context.newPage();
    await adminPage.addInitScript((t) => {
      try { sessionStorage.setItem('atlasAdminSession', JSON.stringify({ token: t, expiresAt: Date.now() + 3600000 })); } catch (err) {}
    }, login.body.token);
    await adminPage.goto(BASE + '/atlas-admin/', { waitUntil: 'load' });
    await adminPage.waitForFunction(() => /Example Arena \(1\)/.test(document.getElementById('onlineWorlds').textContent), null, { timeout: 15000 });
    assert((await adminPage.textContent('#onlineTotal')).trim() === '1', 'expected a total of 1 online, got ' + (await adminPage.textContent('#onlineTotal')));
    console.log('PASS: Online now shows Example Arena (1), total 1');
    await adminPage.close();

    if (!isPhp) {
      console.log('STEP 7 ' + tag + 'a presence server that is down does not stop a 2D world loading');
      presenceProc.kill();
      await sleep(500);
      await frame.evaluate(() => enterWorld('museum'));
      await frame.waitForFunction(() => currentWorld && currentWorld.id === 'museum' && !document.getElementById('placeLabel').textContent.includes('Loading'), { timeout: 15000 });
      const label = await frame.textContent('#status').catch(() => '');
      assert(!/Could not load world/.test(label || ''), 'museum must still load with presence down, status: ' + label);
      console.log('PASS: museum loaded with presence down');
    }
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    procs.forEach((p) => { try { p.kill(); } catch (err) {} });
    for (const dir of [docroot, stateDir, profileDir, phpBundle]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) {}
    }
  }
}

(async () => {
  try {
    await runBackend('node');
    await runBackend('php');
    console.log('\nALL 2D PRESENCE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode || 0);
  }
})();
