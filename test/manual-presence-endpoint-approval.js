// Manual check of the presence client's privacy rules, in real Chrome with
// the real extension, against an isolated issuer-server (a copy of
// demo-domain-a) and two isolated presence servers.
//
// Checks:
//   1. A manifest naming a presence server on ANOTHER origin triggers an
//      approval prompt, and nothing is sent to that server before the
//      visitor answers. Deny is final: no join, no request, remembered.
//   2. A remembered Deny survives re-entering the world (no prompt again).
//   3. Settings -> Presence servers lists the decision; Forget makes the
//      next visit ask again; Allow then joins, and the wallet identity
//      (full key or any fragment) appears nowhere in what the client sends
//      to the presence server — WebSocket frames and HTTP bodies alike.
//   4. Approval is bound to the pair (manifest origin, endpoint origin): a
//      manifest edit pointing at a different server asks again, and the
//      earlier Allow does not carry over.
//   5. A presence endpoint on the manifest's own origin needs no prompt.
//   6. The endpoint parser rejects non-http(s) schemes and embedded
//      credentials, and a manifest with no `presence` field only gets the
//      built-in local server when it is itself served from a loopback host.
//   8. Favorites never contacts a presence server that was not approved
//      for that world's origin; it shows the count as unavailable instead.
//   7. Remote-controlled names are escaped: a world named with markup shows
//      as text in the world label and the Favorites list, and no script
//      runs.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXT_PATH = path.join(ROOT, 'extension');
const ISSUER_PORT = 8221; // isolated — distinct from every other manual-*.js test's chosen port
const PRESENCE_Y = 8222;
const PRESENCE_Z = 8223;
const DOMAIN = 'localhost:' + ISSUER_PORT;
const BASE = 'http://' + DOMAIN;
const EVIL_WORLD_NAME = '"><img src=x onerror="window.__xss=1">Plaza <b>bold</b>';

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
async function count(port, world) {
  const res = await fetch('http://localhost:' + port + '/presence/status?domain=' + encodeURIComponent(DOMAIN) + '&world=' + encodeURIComponent(world));
  return (await res.json()).count;
}
async function waitForCount(port, world, expected, label) {
  let last;
  for (let i = 0; i < 40; i++) {
    last = await count(port, world);
    if (last === expected) return;
    await sleep(250);
  }
  throw new Error('ASSERTION FAILED: ' + label + ': expected count ' + expected + ', last saw ' + last);
}

(async () => {
  const procs = [];
  let context;
  const docroot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-approval-docroot-'));
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-approval-state-'));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-approval-profile-'));
  const manifestPath = path.join(docroot, '.well-known', 'spatial.json');
  function setManifest(mutate) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo-domain-a', '.well-known', 'spatial.json'), 'utf8'));
    manifest.domain = DOMAIN;
    mutate(manifest);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  try {
    fs.cpSync(path.join(ROOT, 'demo-domain-a'), docroot, { recursive: true });
    setManifest((m) => { m.presence = 'http://localhost:' + PRESENCE_Y; });

    const issuer = spawn('node', ['issuer-server/server.js'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(ISSUER_PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: stateDir, ATLAS_DOCROOT: docroot }
    });
    procs.push(issuer);
    await waitForLine(issuer, 'listening', 'issuer-server');
    for (const port of [PRESENCE_Y, PRESENCE_Z]) {
      const p = spawn(process.execPath, [path.join(ROOT, 'presence-server', 'server.js')], {
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port) }
      });
      procs.push(p);
      await waitForLine(p, 'listening', 'presence-server ' + port);
    }

    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      executablePath: '/opt/pw-browsers/chromium',
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox']
    });

    // Everything the client sends toward a presence server, by port.
    const sent = { [PRESENCE_Y]: [], [PRESENCE_Z]: [], [ISSUER_PORT]: [] };
    context.on('request', (req) => {
      const u = new URL(req.url());
      if (sent[u.port] && /^\/presence/.test(u.pathname)) sent[u.port].push(req.method() + ' ' + u.pathname + ' ' + (req.postData() || ''));
    });
    function watchSockets(page) {
      page.on('websocket', (ws) => {
        const u = new URL(ws.url());
        if (!sent[u.port]) return;
        sent[u.port].push('WS ' + u.pathname);
        ws.on('framesent', (f) => sent[u.port].push('WSFRAME ' + f.payload));
      });
    }

    async function enter() {
      const page = await context.newPage();
      watchSockets(page);
      await page.goto(BASE + '/', { waitUntil: 'load' });
      await page.locator('#domain-atlas-enter-btn').click();
      const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
      const frame = await frameHandle.contentFrame();
      await frame.waitForFunction(() => !document.getElementById('placeLabel').textContent.includes('Loading'), null, { timeout: 15000 });
      return { page, frame };
    }
    async function createIdentity(frame, password) {
      await frame.locator('#walletBtn').click();
      await frame.locator('#chooseNewBtn').click();
      await frame.locator('#newPasswordInput').fill(password);
      await frame.locator('#newPasswordConfirmInput').fill(password);
      await frame.locator('#confirmCreateBtn').click();
      await frame.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
      await frame.locator('#seedConfirmCheck').check();
      await frame.locator('#seedConfirmBtn').click();
      await frame.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
      const publicKey = await frame.evaluate(() => AtlasWallet.getIdentity().then((i) => i.publicKey));
      await frame.locator('#walletBtn').click();
      return publicKey;
    }
    const clearSent = () => Object.keys(sent).forEach((k) => { sent[k].length = 0; });

    // A wallet identity must exist so there is a key that could leak.
    let session = await enter();
    const pk = await createIdentity(session.frame, 'approval-test-password');
    await session.page.close();

    console.log('STEP 1: a third-party presence endpoint asks first; Deny means nothing is ever sent to it');
    clearSent();
    session = await enter();
    await session.frame.waitForSelector('#presenceApprovalModal.active', { timeout: 10000 });
    const promptText = await session.frame.textContent('#presenceApprovalDetails');
    assert(promptText.includes(DOMAIN) && promptText.includes('localhost:' + PRESENCE_Y), 'the prompt must name both origins, got: ' + promptText);
    await sleep(2500);
    assert(sent[PRESENCE_Y].length === 0, 'nothing may reach the presence server before the visitor answers, saw: ' + JSON.stringify(sent[PRESENCE_Y]));
    await session.frame.locator('#presenceApprovalDenyBtn').click();
    await sleep(3000);
    assert(sent[PRESENCE_Y].length === 0, 'nothing may reach a denied presence server, saw: ' + JSON.stringify(sent[PRESENCE_Y]));
    assert((await count(PRESENCE_Y, 'plaza')) === 0, 'a denied endpoint must hold no member');
    assert(!(await session.frame.textContent('#placeLabel')).includes('Loading'), 'the world must still load when presence is denied');
    const stored = await session.frame.evaluate(() => chrome.storage.local.get('atlasPresenceEndpointApprovals').then((o) => o.atlasPresenceEndpointApprovals));
    const records = Object.values(stored || {});
    assert(records.length === 1 && records[0].decision === 'deny' && records[0].manifestOrigin === BASE && records[0].endpointOrigin === 'http://localhost:' + PRESENCE_Y, 'expected one stored deny bound to the origin pair, got: ' + JSON.stringify(stored));
    console.log('PASS: prompt shown with both origins, nothing sent before or after Deny, decision stored against the origin pair');
    await session.page.close();

    console.log('STEP 2: the remembered Deny holds on the next visit without asking again');
    clearSent();
    session = await enter();
    await sleep(3000);
    assert(!(await session.frame.evaluate(() => document.getElementById('presenceApprovalModal').classList.contains('active'))), 'a remembered decision must not prompt again');
    assert(sent[PRESENCE_Y].length === 0, 'still nothing may reach the denied server, saw: ' + JSON.stringify(sent[PRESENCE_Y]));
    console.log('PASS: no prompt, no traffic');

    console.log('STEP 3: Forget in Settings re-asks; Allow joins, with no wallet identity on the wire');
    await session.frame.locator('#walletBtn').click();
    await session.frame.locator('#settingsTabBtn').click();
    await session.frame.locator('.settings-category[data-category="presence-servers"] .settings-category-toggle').click();
    await session.frame.waitForFunction(() => document.getElementById('presenceApprovalsList').textContent.includes('localhost:' + 8222), null, { timeout: 5000 });
    await session.frame.locator('#presenceApprovalsList button[data-action="forget-presence-approval"]').click();
    await session.frame.waitForFunction(() => document.getElementById('presenceApprovalsList').textContent.includes('No decisions recorded'), null, { timeout: 5000 });
    await session.page.close();
    clearSent();
    session = await enter();
    await session.frame.waitForSelector('#presenceApprovalModal.active', { timeout: 10000 });
    await session.frame.locator('#presenceApprovalAllowBtn').click();
    await waitForCount(PRESENCE_Y, 'plaza', 1, 'after Allow');
    await sleep(1500);
    const wire = sent[PRESENCE_Y].join('\n');
    assert(wire.length > 0, 'expected presence traffic after Allow');
    assert(!wire.includes(pk) && !wire.includes(pk.slice(0, 8)) && !/publicKey/i.test(wire), 'the wallet identity must not appear in presence traffic, saw: ' + wire.slice(0, 600));
    assert(/"type":"join"/.test(wire) || /poll\/join/.test(wire), 'expected a join message in the traffic');
    console.log('PASS: joined after Allow; the join and later messages carry no key, fragment or publicKey field');
    await session.page.close();

    console.log('STEP 4: pointing the manifest at a different server asks again — the earlier Allow does not carry over');
    setManifest((m) => { m.presence = 'http://localhost:' + PRESENCE_Z; });
    clearSent();
    session = await enter();
    await session.frame.waitForSelector('#presenceApprovalModal.active', { timeout: 10000 });
    await sleep(2000);
    assert(sent[PRESENCE_Z].length === 0, 'the new endpoint must receive nothing before approval, saw: ' + JSON.stringify(sent[PRESENCE_Z]));
    await session.frame.locator('#presenceApprovalDenyBtn').click();
    await sleep(2000);
    assert(sent[PRESENCE_Z].length === 0 && (await count(PRESENCE_Z, 'plaza')) === 0, 'the denied new endpoint must stay untouched');
    await session.page.close();

    console.log('STEP 5: a presence endpoint on the manifest\'s own origin needs no prompt');
    setManifest((m) => { m.presence = BASE; });
    clearSent();
    session = await enter();
    await sleep(3000);
    assert(!(await session.frame.evaluate(() => document.getElementById('presenceApprovalModal').classList.contains('active'))), 'same-origin presence must not prompt');
    assert(sent[ISSUER_PORT].length > 0, 'expected the client to try the same-origin presence endpoint');
    console.log('PASS: same-origin endpoint used directly');

    console.log('STEP 6: the endpoint parser rejects unsafe values and only defaults to the local server for loopback manifests');
    const parsed = await session.frame.evaluate(() => ({
      js: parsePresenceEndpoint('https://example.com', 'javascript:alert(1)'),
      ftp: parsePresenceEndpoint('https://example.com', 'ftp://example.com/x'),
      creds: parsePresenceEndpoint('https://example.com', 'https://user:pw@example.com'),
      notString: parsePresenceEndpoint('https://example.com', { a: 1 }),
      remoteDefault: parsePresenceEndpoint('https://example.com', undefined),
      loopbackDefault: parsePresenceEndpoint('http://localhost:8001', undefined),
      ok: parsePresenceEndpoint('https://example.com', 'https://presence.example.com/base/')
    }));
    assert(parsed.js === null && parsed.ftp === null && parsed.creds === null && parsed.notString === null, 'unsafe endpoints must be rejected, got: ' + JSON.stringify(parsed));
    assert(parsed.remoteDefault === null, 'a remote manifest with no presence field must not get the local default');
    assert(parsed.loopbackDefault && parsed.loopbackDefault.builtin === true, 'a loopback manifest keeps the built-in local server');
    assert(parsed.ok && parsed.ok.base === 'https://presence.example.com/base' && parsed.ok.origin === 'https://presence.example.com', 'a plain https endpoint parses to its origin and base, got: ' + JSON.stringify(parsed.ok));
    console.log('PASS: javascript:, ftp:, credentials, non-strings rejected; defaults gated on loopback');
    await session.page.close();

    console.log('STEP 7: remote-controlled names are escaped in the world label and Favorites');
    setManifest((m) => { m.presence = BASE; m.worlds.forEach((w) => { if (w.id === 'plaza') w.name = EVIL_WORLD_NAME; }); });
    session = await enter();
    const label = await session.frame.evaluate(() => ({ text: document.getElementById('placeLabel').textContent, imgs: document.querySelectorAll('#placeLabel img, #placeLabel b').length, xss: window.__xss }));
    assert(label.text.includes('<img src=x') && label.imgs === 0 && !label.xss, 'the hostile world name must render as inert text, got: ' + JSON.stringify(label));
    await session.frame.locator('#walletBtn').click();
    await session.frame.locator('#socialTabBtn').click();
    await session.frame.locator('#favoritesSubtabBtn').click();
    await session.frame.locator('#addCurrentFavoriteBtn').click();
    await session.frame.waitForFunction(() => document.querySelectorAll('#favoritesList .info-card').length === 1, null, { timeout: 8000 });
    const favorites = await session.frame.evaluate(() => ({
      text: document.getElementById('favoritesList').textContent,
      injected: document.querySelectorAll('#favoritesList img, #favoritesList b').length,
      xss: window.__xss
    }));
    assert(favorites.text.includes('<img src=x') && favorites.injected === 0 && !favorites.xss, 'the hostile world name must render as inert text in Favorites, got: ' + JSON.stringify(favorites));
    console.log('PASS: markup in a world name stays text, nothing executed');

    console.log('STEP 8: Favorites does not query a denied presence server');
    await session.frame.locator('#favoritesList button[data-action="remove-favorite"]').click();
    await session.frame.waitForFunction(() => document.querySelectorAll('#favoritesList .info-card').length === 0, null, { timeout: 8000 });
    await session.page.close();
    setManifest((m) => { m.presence = 'http://localhost:' + PRESENCE_Z; });
    clearSent();
    session = await enter();
    await session.frame.locator('#walletBtn').click();
    await session.frame.locator('#socialTabBtn').click();
    await session.frame.locator('#favoritesSubtabBtn').click();
    await session.frame.locator('#addCurrentFavoriteBtn').click();
    await session.frame.waitForFunction(() => /Visitor count unavailable/.test(document.getElementById('favoritesList').textContent), null, { timeout: 8000 });
    await sleep(1000);
    assert(sent[PRESENCE_Z].length === 0, 'Favorites must not contact a denied presence server, saw: ' + JSON.stringify(sent[PRESENCE_Z]));
    console.log('PASS: count shown as unavailable, no request to the denied server');

    console.log('\nALL PRESENCE ENDPOINT / CLIENT PRIVACY CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    procs.forEach((p) => { try { p.kill(); } catch (err) {} });
    for (const dir of [docroot, stateDir, profileDir]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) {}
    }
  }
})();
