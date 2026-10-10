// Release check: with moderation left UNCONFIGURED, nothing else may change.
//
//   node test/manual-moderation-unconfigured.js node       Node issuer + Node presence
//   node test/manual-moderation-unconfigured.js php        PHP issuer + PHP presence
//   node test/manual-moderation-unconfigured.js matrix     both
//
// (Run under xvfb-run: the extension needs a headed browser.) Isolated ports
// 9371 (issuer) and 9373 (presence), scratch state and docroot; no live
// configuration is read or written.
//
// Case A, nothing configured anywhere (the state of a site that has deployed the
// code and not set moderation up): the issuer and presence refuse every
// privileged moderation call with a plain 503 and write nothing; presence and
// chat joins, sync and send work; an administrator's existing admin workflows
// work and the admin page shows a plain explanation in the moderation section;
// a moderator-only key sees only that explanation; the page raises no script
// error.
//
// Case B, the issuer configured but the presence service not: the panel's
// session can be started (the issuer signs) but every presence call is refused
// with the not-configured message, the panel stays usable, chat is unaffected.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('./lib/delivery-harness');

const ROOT = path.resolve(__dirname, '..');
const EXT_PATH = path.join(ROOT, 'extension');
const PORTS = { issuer: 9371, presence: 9373 };
const DOMAIN = 'localhost:' + PORTS.issuer;
const SITE = 'http://' + DOMAIN;
const AUD = 'http://localhost:' + PORTS.presence;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS: ' : 'FAIL: ') + name + (ok ? '' : ' => ' + detail));
}

const children = [];
async function killAll() {
  for (const c of children.splice(0)) { try { c.kill(); } catch (_) {} }
  await sleep(400);
}

const WORLDS = [['lobby', 'Test Lobby'], ['plaza', 'Test Plaza']];
function writeSite(dir) {
  fs.mkdirSync(path.join(dir, '.well-known'), { recursive: true });
  const manifest = {
    spec: 'domain-atlas/1.0', domain: DOMAIN, owner: { name: 'Unconfigured Test Domain', contact: 'demo@localhost' },
    walletBridge: { read: true, sign: ['moderation-grant'] },
    defaultWorld: 'lobby',
    worlds: WORLDS.map(([id, name]) => ({ id, name, entry: { scene: '/spatial/' + id + '/scene.json', renderer: ['procedural-v1'] }, policy: { guestAccess: 'open', discoverable: true, identityRequired: false, itemDropsAllowed: false } })),
    updated: '2026-10-02T00:00:00Z'
  };
  fs.writeFileSync(path.join(dir, '.well-known', 'spatial.json'), JSON.stringify(manifest, null, 2));
  for (const [id] of WORLDS) {
    fs.mkdirSync(path.join(dir, 'spatial', id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'spatial', id, 'scene.json'), JSON.stringify({ format: 'procedural-v1', floor: { size: [10, 10], color: '#1b2830' }, objects: [], portalMarkers: [], anchors: [] }));
  }
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Unconfigured Test</title><link rel="spatial" href="/.well-known/spatial.json"></head><body><h1>Unconfigured Test</h1></body></html>');
}

let issuer = null, presenceDir = null;
async function startIssuer(kind, configured) {
  const env = { ATLAS_ADMIN_FAIL_LIMIT: '1000', ATLAS_ADMIN_NONCE_PER_CLIENT_PER_MIN: '1000', ATLAS_ADMIN_NONCE_CAP: '1000' };
  if (kind === 'node') {
    const docroot = H.tmpDir('atlas-mu-docroot-');
    writeSite(docroot);
    const stateDir = H.tmpDir('atlas-mu-state-');
    issuer = await H.startNodeIssuer({ port: PORTS.issuer, stateDir, docrootDir: docroot, env: configured ? { ...env, ATLAS_MODERATION_AUDIENCES: AUD } : env });
    issuer.files = (name) => path.join(stateDir, name);
  } else {
    const bundleDir = H.preparePhpBundle();
    writeSite(bundleDir);
    for (const f of fs.readdirSync(path.join(bundleDir, 'lib'))) if (f === 'atlas-moderation-config.json') fs.unlinkSync(path.join(bundleDir, 'lib', f));
    if (configured) fs.writeFileSync(path.join(bundleDir, 'lib', 'atlas-moderation-config.json'), JSON.stringify({ domain: DOMAIN, audiences: [AUD] }));
    issuer = await H.startPhpIssuer({ port: PORTS.issuer, bundleDir, env: { PHP_CLI_SERVER_WORKERS: '4', ...env } });
    issuer.files = (name) => path.join(bundleDir, 'lib', name);
  }
  children.push(issuer.proc);
  issuer.base = SITE;
  issuer.kind = kind;
}
function setRoster(entries) {
  const keys = entries.map((e) => {
    const k = { publicKey: e.publicKey, addedAt: new Date().toISOString() };
    if (e.role) k.role = e.role;
    if (e.worlds) k.worlds = e.worlds;
    if (e.operations) k.operations = e.operations;
    return k;
  });
  fs.writeFileSync(issuer.files('atlas-admin-keys-store.json'), JSON.stringify({ keys }));
}
// The presence service is started with no moderation config file at all and
// the audit file pointed at a scratch path, so we can see whether it is touched.
let auditFile = null, missingCfg = null;
async function startPresence(kind) {
  auditFile = path.join(H.tmpDir('atlas-mu-audit-'), 'audit.jsonl');
  missingCfg = path.join(H.tmpDir('atlas-mu-cfg-'), 'moderation-config.json'); // never created
  const env = { ...process.env, PRESENCE_MODERATION_CONFIG: missingCfg, PRESENCE_MODERATION_AUDIT_FILE: auditFile, POLL_TIMEOUT_MS: '600000' };
  let proc;
  presenceDir = null;
  if (kind === 'php') {
    presenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mu-presence-'));
    fs.cpSync(path.join(ROOT, 'presence-php'), presenceDir, { recursive: true });
    for (const f of fs.readdirSync(path.join(presenceDir, 'presence/lib'))) if (/^atlas-.*\.(json|jsonl)/.test(f)) fs.unlinkSync(path.join(presenceDir, 'presence/lib', f));
    proc = spawn('php', ['-S', 'localhost:' + PORTS.presence, 'test-router.php'], { cwd: presenceDir, env: { ...env, PHP_CLI_SERVER_WORKERS: '6' }, stdio: 'ignore' });
  } else {
    proc = spawn('node', [path.join(ROOT, 'presence-server', 'server.js')], { env: { ...env, PORT: String(PORTS.presence) }, stdio: 'ignore' });
  }
  children.push(proc);
  for (let i = 0; i < 60; i++) {
    try { await rq('GET', '/presence/status?domain=ready&world=ready'); return; } catch (_) { await sleep(100); }
  }
  throw new Error('presence did not start');
}

let ipCounter = 0;
const fresh = () => '127.0.0.' + (150 + (ipCounter++ % 90));
function rq(method, p, body, port) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
    const r = http.request({ host: '127.0.0.1', port: port || PORTS.presence, path: p, method, localAddress: fresh(), headers, agent: false }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode, body: json, text }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function createWalletIdentity(context, extensionId) {
  const walletPage = await context.newPage();
  await walletPage.goto('chrome-extension://' + extensionId + '/viewer.html', { waitUntil: 'load' });
  await walletPage.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 10000 });
  await walletPage.locator('#chooseNewBtn').click();
  await walletPage.locator('#newPasswordInput').fill('mod-unconf-test-pw');
  await walletPage.locator('#newPasswordConfirmInput').fill('mod-unconf-test-pw');
  await walletPage.locator('#confirmCreateBtn').click();
  await walletPage.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
  await walletPage.locator('#seedConfirmCheck').check();
  await walletPage.locator('#seedConfirmBtn').click();
  await walletPage.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
  const publicKey = await walletPage.evaluate(async () => (await AtlasWallet.getIdentity()).publicKey);
  await walletPage.close();
  return publicKey;
}
async function openPanel(context, errors) {
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource|WebSocket connection to|blocked by CORS policy/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(SITE, { waitUntil: 'load' });
  await page.locator('#domain-atlas-enter-btn').click();
  const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 15000 });
  const frame = await frameHandle.contentFrame();
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Test Lobby'), null, { timeout: 15000 });
  await frame.evaluate(() => refreshAdminButtonVisibility());
  await frame.waitForFunction(() => document.getElementById('adminBtn').style.display !== 'none', null, { timeout: 10000 });
  const label = (await frame.locator('#adminBtn').textContent()).trim();
  await frame.locator('#adminBtn').click();
  await page.waitForURL('**/atlas-admin/**', { timeout: 15000 });
  await page.waitForFunction(() => document.getElementById('loggedOutNotice').style.display === 'none', null, { timeout: 15000 });
  return { page, label };
}
const visiblePanels = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#hidden-while-logged-out section.panel')).filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.id || s.querySelector('h2').textContent));

async function chatWorks(tag) {
  const visit = Buffer.from(require('crypto').randomBytes(16)).toString('base64url');
  const j = await rq('POST', '/presence/poll/join', { domain: DOMAIN, world: 'lobby', name: 'Plain ' + tag, visit });
  const c = await rq('POST', '/presence/poll/chat-join', { domain: DOMAIN, world: 'lobby', name: 'Plain ' + tag, visit });
  await sleep(450);
  const s = c.body && c.body.id ? await rq('POST', '/presence/poll/chat-send', { id: c.body.id, text: 'hello ' + tag }) : null;
  const sync = j.body && j.body.id ? await rq('POST', '/presence/poll/sync', { id: j.body.id }) : null;
  return j.status === 200 && c.status === 200 && s && s.status === 200 && s.body && s.body.ok !== false && sync && sync.status === 200;
}

async function scenario(kind) {
  console.log('\n===== ' + kind + ' issuer, ' + kind + ' presence =====');

  // ---------- Case A: nothing configured ----------
  console.log('CASE A: moderation configured nowhere');
  await startIssuer(kind, false);
  await startPresence(kind);
  const cfgStat = await H.getJson(issuer.base, '/atlas/moderation/status?audience=' + encodeURIComponent(AUD));
  check('A: the issuer\'s status statement answers 503 moderation-not-configured', cfgStat.status === 503 && cfgStat.body && cfgStat.body.code === 'moderation-not-configured', JSON.stringify(cfgStat));
  const grantTry = await H.postJson(issuer.base, '/atlas/admin/moderation/grant', {});
  check('A: the issuer grant route refuses (no grant is signed)', grantTry.status >= 400 && !(grantTry.body && grantTry.body.grant), JSON.stringify(grantTry));
  for (const route of ['roster', 'command', 'audit']) {
    const r = await rq('POST', '/presence/moderation/' + route, { grant: { payload: { domain: DOMAIN } }, request: {} });
    check('A: presence /moderation/' + route + ' answers 503 moderation-not-configured', r.status === 503 && r.body && r.body.code === 'moderation-not-configured', r.status + ' ' + r.text);
  }
  const r404 = await rq('POST', '/presence/moderation/roster', 'garbage');
  check('A: garbage input is refused (400 or 503), never accepted', r404.status === 400 || r404.status === 503, r404.status + ' ' + r404.text);
  check('A: the audit file was not created by refused calls', !fs.existsSync(auditFile) && !(presenceDir && fs.existsSync(path.join(presenceDir, 'presence/lib/atlas-presence-moderation-audit.jsonl'))), 'audit file exists');
  check('A: presence join, sync and chat send/receive work', await chatWorks('A'), 'ordinary presence or chat broken');
  check('A: the audit file still does not exist after ordinary traffic', !fs.existsSync(auditFile) && !(presenceDir && fs.existsSync(path.join(presenceDir, 'presence/lib/atlas-presence-moderation-audit.jsonl'))), 'audit file exists');

  // A fresh browser profile and wallet per case: the wallet caches admin sessions per domain.
  async function inBrowser(fn) {
    const profile = H.tmpDir('atlas-mu-profile-');
    const context = await chromium.launchPersistentContext(profile, { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] });
    try {
      let background = context.serviceWorkers()[0];
      if (!background) background = await context.waitForEvent('serviceworker');
      const extensionId = new URL(background.url()).host;
      const publicKey = await createWalletIdentity(context, extensionId);
      await fn(context, publicKey);
    } finally {
      await context.close().catch(() => {});
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
    }
  }
  try {
  await inBrowser(async (context, publicKey) => {
    console.log('CASE A: an administrator');
    setRoster([{ publicKey, role: 'admin' }]);
    let errors = [];
    let { page, label } = await openPanel(context, errors);
    check('A: the wallet button reads "Admin"', /Admin/.test(label), label);
    const panels = await visiblePanels(page);
    check('A: every administration panel is still there next to the moderation section', panels.includes('moderationPanel') && panels.includes('onlinePanel') && panels.includes('Revoke a credential') && panels.includes('Mint an asset') && panels.length >= 12, JSON.stringify(panels));
    await page.waitForFunction(() => document.getElementById('modStatus').textContent.length > 0, null, { timeout: 15000 });
    const modText = await page.locator('#moderationPanel').innerText();
    check('A: the moderation section explains in plain words that it is not switched on', /not (been )?(configured|available|switched on)|no presence service/i.test(modText) && /docs\/moderation-setup\.md/.test(modText), modText.slice(0, 500));
    check('A: ...and offers no way to start a session', await page.locator('#modStartBtn').isHidden() || await page.locator('#modSetup').isHidden(), 'start offered');
    const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem('atlasAdminSession')));
    const dir = await H.postJson(issuer.base, '/atlas/admin/directory', { token: session.token });
    check('A: an administrator workflow (directory) still works', dir.status === 200, JSON.stringify(dir).slice(0, 200));
    const cfg = await H.postJson(issuer.base, '/atlas/admin/moderation/config', { token: session.token });
    check('A: the config route says "not configured" with a plain problem and no addresses', cfg.status === 200 && cfg.body.configured === false && cfg.body.audiences.length === 0 && cfg.body.problems.length >= 1, JSON.stringify(cfg));
    await sleep(500);
    check('A: no script error on the admin page', errors.length === 0, JSON.stringify(errors));
    await page.close();

    console.log('CASE A: a moderator-only key');
    setRoster([{ publicKey, role: 'moderator', worlds: ['lobby'], operations: ['roster.view', 'chat.mute'] }]);
    errors = [];
    ({ page, label } = await openPanel(context, errors));
    check('A: the wallet button reads "Moderate"', /Moderate/.test(label), label);
    const mp = await visiblePanels(page);
    check('A: only the moderation section is shown', mp.length === 1 && mp[0] === 'moderationPanel', JSON.stringify(mp));
    await page.waitForFunction(() => document.getElementById('modStatus').textContent.length > 0, null, { timeout: 15000 });
    check('A: it says moderation is not available, in plain words', /not available|not switched on|not configured/i.test(await page.locator('#moderationPanel').innerText()), await page.locator('#moderationPanel').innerText());
    check('A: no script error', errors.length === 0, JSON.stringify(errors));
    await page.close();

  });

  // ---------- Case B: issuer configured, presence not ----------
  console.log('CASE B: issuer configured, presence service not');
  await killAll();
  await startIssuer(kind, true);
  await startPresence(kind);
  await inBrowser(async (context, publicKey) => {
    setRoster([{ publicKey, role: 'admin' }]);
    let errors = [];
    let { page, label } = await openPanel(context, errors);
    await page.waitForFunction(() => !document.getElementById('modSetup').hidden, null, { timeout: 15000 });
    await page.locator('#modStartBtn').click();
    await page.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 20000 });
    const frame = page.frameLocator('#domain-atlas-bridge-confirm');
    await frame.locator('#readyState').waitFor({ state: 'visible', timeout: 15000 });
    await frame.locator('#approveBtn').click();
    await page.waitForSelector('#domain-atlas-bridge-confirm', { state: 'detached', timeout: 15000 });
    await page.waitForFunction(() => !document.getElementById('modWork').hidden, null, { timeout: 20000 });
    await page.locator('#modRefreshBtn').click();
    await page.waitForFunction(() => /not switched on|Could not reach/i.test(document.getElementById('modStatus').textContent + document.getElementById('modRosterState').textContent), null, { timeout: 15000 });
    const text = (await page.locator('#modStatus').innerText()) + ' ' + (await page.locator('#modRosterState').innerText());
    // An unconfigured service sends no CORS allowance, so the browser reports it as unreachable.
    check('B: the panel tells the operator the service is not reachable or not switched on, and what to check', /Moderation is not switched on|Could not reach the presence service[^]*set up for this domain/.test(text), text);
    check('B: the other administrator panels are untouched', (await visiblePanels(page)).length >= 12, 'panels hidden');
    check('B: no script error', errors.length === 0, JSON.stringify(errors));
    check('B: presence and chat still work', await chatWorks('B'), 'ordinary presence or chat broken');
    check('B: the audit file was not created', !fs.existsSync(auditFile) && !(presenceDir && fs.existsSync(path.join(presenceDir, 'presence/lib/atlas-presence-moderation-audit.jsonl'))), 'audit file exists');
    await page.close();
  });
  } finally {
    await killAll();
  }
}

(async () => {
  const arg = process.argv[2] || 'node';
  const kinds = arg === 'matrix' ? ['node', 'php'] : [arg === 'php' ? 'php' : 'node'];
  try {
    for (const k of kinds) await scenario(k);
  } catch (err) {
    console.error('FAILURE:', err);
    failures++;
  }
  await killAll();
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL UNCONFIGURED-MODERATION CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
