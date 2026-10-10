// End-to-end check of the World moderation panel in the admin page, in a real
// browser with the real wallet extension, against isolated issuers and presence
// services of either implementation:
//
//   node test/manual-moderation-panel.js node            presence Node, issuer Node
//   node test/manual-moderation-panel.js php             presence PHP,  issuer PHP
//   node test/manual-moderation-panel.js node php        presence Node, issuer PHP
//   node test/manual-moderation-panel.js php node        presence PHP,  issuer Node
//   node test/manual-moderation-panel.js matrix          all four pairings
//
// (Run under xvfb-run: the extension needs a headed browser.) Everything is
// isolated: ports 9361 (issuer) and 9363 (presence), scratch state, a scratch
// docroot and manifest, a scratch browser profile; no live configuration is read
// or written.
//
// The wallet identity is created in the extension and then placed on the
// issuer's roster, first as an administrator, then as a scoped moderator, so the
// whole path is real: the wallet's own button ("Admin" / "Moderate"), the
// login handoff, the panel, the wallet's approval prompt for the grant request,
// the issuer's grant, the in-page ephemeral key and the presence service.
//
// Covered: the button follows the roster role; an administrator keeps every
// existing panel and gets the moderation section; a moderator-only key sees the
// moderation section alone, only its own worlds, and its session is refused by
// administration routes; the panel talks to nothing but the configured presence
// service; the wallet prompt shows the whole request (purpose, presence service,
// worlds, operations, lifetime, ephemeral key) and a denial starts no session;
// a page whose manifest does not allow the signing purpose gets no prompt and
// an explanation; visitor names that are HTML or script, bidirectional-control
// text and over-long names render as plain text and execute nothing; mute,
// unmute and kick through the panel with confirmation, fixed reasons and
// permitted durations, with the visitor really muted / removed and the expiry
// shown; a mute expires on its own; an expired grant is renewed only through the
// wallet again and for exactly the same scope; replaying a captured command is
// refused; a revoked moderator is refused; the audit viewer shows the actions
// and refusals of the selected world only; no private key, token, wallet key or
// address appears in anything the panel sends or shows.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const H = require('./lib/delivery-harness');

const ROOT = path.resolve(__dirname, '..');
const EXT_PATH = path.join(ROOT, 'extension');
const PORTS = { issuer: 9361, presence: 9363 };
const DOMAIN = 'localhost:' + PORTS.issuer;
const SITE = 'http://' + DOMAIN;
const AUD = 'http://localhost:' + PORTS.presence;
const ALL_OPS = ['roster.view', 'chat.mute', 'chat.unmute', 'session.kick', 'audit.view'];
const STATUS_TTL_S = 5, REFRESH_S = 2, GRANT_TTL_S = 24;

const ARGS = process.argv.slice(2);
const MATRIX = ARGS[0] === 'matrix';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS: ' : 'FAIL: ') + name + (ok ? '' : ' => ' + detail));
}
const b64 = (n) => Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString('base64url');

// ---------- processes ----------

const children = [];
function track(proc) { children.push(proc); return proc; }
async function killAll() {
  for (const c of children.splice(0)) { try { c.kill(); } catch (_) {} }
  await sleep(400);
}

const WORLDS = [['lobby', 'Test Lobby'], ['plaza', 'Test Plaza'], ['garden', 'Test Garden']];
function spatialJson() {
  return {
    spec: 'domain-atlas/1.0', domain: DOMAIN, owner: { name: 'Moderation Panel Test Domain', contact: 'demo@localhost' },
    walletBridge: { read: true, sign: ['moderation-grant'] },
    defaultWorld: 'lobby',
    worlds: WORLDS.map(([id, name]) => ({ id, name, entry: { scene: '/spatial/' + id + '/scene.json', renderer: ['procedural-v1'] }, policy: { guestAccess: 'open', discoverable: true, identityRequired: false, itemDropsAllowed: false, acceptedItemClasses: [], trustedIssuers: 'any' } })),
    updated: '2026-10-02T00:00:00Z'
  };
}
function writeSite(dir) {
  fs.mkdirSync(path.join(dir, '.well-known'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.well-known', 'spatial.json'), JSON.stringify(spatialJson(), null, 2));
  for (const [id] of WORLDS) {
    fs.mkdirSync(path.join(dir, 'spatial', id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'spatial', id, 'scene.json'), JSON.stringify({ format: 'procedural-v1', floor: { size: [10, 10], color: '#1b2830' }, objects: [], portalMarkers: [], anchors: [] }));
  }
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Moderation Panel Test</title><link rel="spatial" href="/.well-known/spatial.json"></head><body><h1>Moderation Panel Test</h1></body></html>');
}

let issuer = null, presence = null, cfgFile = null, auditFile = null;
async function startIssuer(kind) {
  const env = { ATLAS_ADMIN_FAIL_LIMIT: '1000', ATLAS_ADMIN_NONCE_PER_CLIENT_PER_MIN: '1000', ATLAS_ADMIN_NONCE_CAP: '1000', ATLAS_MODERATION_STATUS_TTL_S: String(STATUS_TTL_S), ATLAS_MODERATION_STATUS_PER_CLIENT_PER_MIN: '10000', ATLAS_MODERATION_MAX_LIVE_GRANTS: '500', ATLAS_MODERATION_PANEL_GRANT_TTL_S: String(GRANT_TTL_S), ATLAS_ADMIN_SESSION_TTL_MS: '3600000' };
  if (kind === 'node') {
    const docroot = H.tmpDir('atlas-mp-docroot-');
    writeSite(docroot);
    const stateDir = H.tmpDir('atlas-mp-state-');
    issuer = await H.startNodeIssuer({ port: PORTS.issuer, stateDir, docrootDir: docroot, env: { ...env, ATLAS_MODERATION_AUDIENCES: AUD } });
    issuer.files = (name) => path.join(stateDir, name);
    issuer.docroot = docroot;
  } else {
    const bundleDir = H.preparePhpBundle();
    writeSite(bundleDir);
    fs.writeFileSync(path.join(bundleDir, 'lib', 'atlas-moderation-config.json'), JSON.stringify({ domain: DOMAIN, audiences: [AUD] }));
    issuer = await H.startPhpIssuer({ port: PORTS.issuer, bundleDir, env: { PHP_CLI_SERVER_WORKERS: '4', ...env } });
    issuer.files = (name) => path.join(bundleDir, 'lib', name);
    issuer.docroot = bundleDir;
  }
  track(issuer.proc);
  issuer.base = SITE;
}
function setRoster(entries) {
  const keys = entries.map((e) => {
    const k = { publicKey: e.publicKey, addedAt: new Date().toISOString() };
    if (e.role) k.role = e.role;
    if (e.worlds) k.worlds = e.worlds;
    if (e.operations) k.operations = e.operations;
    if (e.revoked) k.revoked = true;
    return k;
  });
  fs.writeFileSync(issuer.files('atlas-admin-keys-store.json'), JSON.stringify({ keys }));
}
async function startPresence(kind) {
  const env = { ...process.env, PRESENCE_MODERATION_CONFIG: cfgFile, PRESENCE_MODERATION_AUDIT_FILE: auditFile, POLL_TIMEOUT_MS: '600000', POLL_SWEEP_INTERVAL_MS: '1000', MODERATION_STATUS_REFRESH_S: String(REFRESH_S), MODERATION_FETCH_TIMEOUT_MS: '1000', MODERATION_COMMANDS_PER_MIN: '500' };
  let proc, dir = null;
  if (kind === 'php') {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mp-presence-'));
    fs.cpSync(path.join(ROOT, 'presence-php'), dir, { recursive: true });
    for (const f of fs.readdirSync(path.join(dir, 'presence/lib'))) if (/^atlas-.*\.json/.test(f)) fs.unlinkSync(path.join(dir, 'presence/lib', f));
    proc = spawn('php', ['-S', 'localhost:' + PORTS.presence, 'test-router.php'], { cwd: dir, env: { ...env, PHP_CLI_SERVER_WORKERS: '6' }, stdio: 'ignore' });
  } else {
    proc = spawn('node', [path.join(ROOT, 'presence-server', 'server.js')], { env: { ...env, PORT: String(PORTS.presence) }, stdio: 'ignore' });
  }
  track(proc);
  presence = { kind, dir, proc };
  for (let i = 0; i < 60; i++) {
    try { await rq('GET', '/presence/status?domain=ready&world=ready'); return; } catch (_) { await sleep(100); }
  }
  throw new Error('presence did not start');
}

// ---------- plain HTTP to presence (the visitors, and independent checks) ----------

let ipCounter = 100;
const fresh = () => '127.0.0.' + (100 + (ipCounter++ % 100));
function rq(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
    const r = http.request({ host: '127.0.0.1', port: PORTS.presence, path: p, method, localAddress: fresh(), headers, agent: false }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch (_) {} resolve({ status: res.statusCode, body: json, text }); });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const visits = [];
const tokens = [];
async function visitor(world, name, o) {
  o = o || {};
  const visit = b64(16);
  visits.push(visit);
  const out = { name, world, visit };
  if (o.presence !== false) { const r = await rq('POST', '/presence/poll/join', { domain: DOMAIN, world, name, visit }); if (r.status !== 200) throw new Error('join failed ' + r.text); out.p = r.body.id; tokens.push(r.body.id); }
  if (o.chat !== false) { const r = await rq('POST', '/presence/poll/chat-join', { domain: DOMAIN, world, name, visit }); if (r.status !== 200) throw new Error('chat join failed ' + r.text); out.c = r.body.id; tokens.push(r.body.id); }
  return out;
}
const say = async (v, text) => { await sleep(450); return (await rq('POST', '/presence/poll/chat-send', { id: v.c, text })).body; };
const psync = async (v) => rq('POST', '/presence/poll/sync', { id: v.p });

// ---------- browser helpers ----------

async function createWalletIdentity(context, extensionId) {
  const walletPage = await context.newPage();
  await walletPage.goto('chrome-extension://' + extensionId + '/viewer.html', { waitUntil: 'load' });
  await walletPage.waitForFunction(() => document.getElementById('walletPanel').classList.contains('open'), null, { timeout: 10000 });
  await walletPage.locator('#chooseNewBtn').click();
  await walletPage.locator('#newPasswordInput').fill('mod-panel-test-pw');
  await walletPage.locator('#newPasswordConfirmInput').fill('mod-panel-test-pw');
  await walletPage.locator('#confirmCreateBtn').click();
  await walletPage.waitForFunction(() => document.getElementById('seedRevealBox').classList.contains('show'), null, { timeout: 5000 });
  await walletPage.locator('#seedConfirmCheck').check();
  await walletPage.locator('#seedConfirmBtn').click();
  await walletPage.waitForFunction(() => document.getElementById('mainWalletScreen').classList.contains('active'), null, { timeout: 5000 });
  const publicKey = await walletPage.evaluate(async () => (await AtlasWallet.getIdentity()).publicKey);
  await walletPage.close();
  return publicKey;
}

// Opens the site, enters the world and returns the wallet's overlay frame once
// its admin / moderate button has settled.
async function openOverlay(context) {
  const page = await context.newPage();
  await page.goto(SITE, { waitUntil: 'load' });
  await page.locator('#domain-atlas-enter-btn').click();
  const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 15000 });
  const frame = await frameHandle.contentFrame();
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Test Lobby'), null, { timeout: 15000 });
  await frame.evaluate(() => refreshAdminButtonVisibility());
  return { page, frame };
}
async function openPanel(context) {
  const { page, frame } = await openOverlay(context);
  await frame.waitForFunction(() => document.getElementById('adminBtn').style.display !== 'none', null, { timeout: 10000 });
  const label = (await frame.locator('#adminBtn').textContent()).trim();
  await frame.locator('#adminBtn').click();
  await page.waitForURL('**/atlas-admin/**', { timeout: 15000 });
  await page.waitForFunction(() => document.getElementById('loggedOutNotice').style.display === 'none', null, { timeout: 15000 });
  return { page, label };
}
async function loadPanelWithSession(context) {
  // A second page in the same browser session: sessionStorage is per tab, so go through the button again.
  return openPanel(context);
}

// Answers the wallet's approval prompt on `page`. Returns the text of the
// payload the wallet displayed.
// The wallet prompt lists the request one "key: value" line per field (values are JSON).
function parsePromptFields(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^([A-Za-z]+): (.*)$/.exec(line);
    if (!m) continue;
    try { out[m[1]] = JSON.parse(m[2]); } catch (_) { out[m[1]] = m[2]; }
  }
  return out;
}

async function answerPrompt(page, approve) {
  await page.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 20000 });
  const frame = page.frameLocator('#domain-atlas-bridge-confirm');
  await frame.locator('#readyState').waitFor({ state: 'visible', timeout: 15000 });
  const shown = { origin: await frame.locator('#origin').innerText(), payload: await frame.locator('#payloadBox').innerText() };
  await frame.locator(approve ? '#approveBtn' : '#denyBtn').click();
  await page.waitForSelector('#domain-atlas-bridge-confirm', { state: 'detached', timeout: 15000 });
  return shown;
}
function autoApprove(page) {
  let on = true; let n = 0;
  (async () => {
    while (on) {
      try { if (await page.locator('#domain-atlas-bridge-confirm').count()) { await answerPrompt(page, true); n++; } } catch (_) { /* page closing */ }
      await sleep(250);
    }
  })();
  return { stop() { on = false; }, count: () => n };
}
async function startSession(page) {
  await page.locator('#modStartBtn').click();
  const shown = await answerPrompt(page, true);
  await page.waitForFunction(() => !document.getElementById('modWork').hidden, null, { timeout: 20000 });
  return shown;
}
async function waitRoster(page, minRows) {
  await page.waitForFunction((n) => document.querySelectorAll('#modRosterBody tr').length >= n, minRows, { timeout: 20000 });
}
async function selectWorld(page, id) {
  await page.locator('#modWorld').selectOption(id);
  await page.locator('#modRefreshBtn').click();
  await sleep(300);
}
const rowOf = (page, name) => page.locator('#modRosterBody tr', { has: page.locator('bdi.pname', { hasText: name }) }).first();
async function act(page, name, button, reasonLabel, durationLabel) {
  await rowOf(page, name).getByRole('button', { name: button, exact: true }).click();
  await page.locator('#modConfirm').waitFor({ state: 'visible', timeout: 5000 });
  const confirmText = await page.locator('#modConfirmText').innerText();
  if (reasonLabel) await page.locator('#modReason').selectOption({ label: reasonLabel });
  if (durationLabel) await page.locator('#modDuration').selectOption({ label: durationLabel });
  await page.locator('#modConfirmBtn').click();
  await page.waitForFunction(() => document.getElementById('modConfirm').hidden, null, { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('modResult').textContent.length > 0, null, { timeout: 20000 });
  return { confirmText, result: await page.locator('#modResult').innerText(), ok: await page.locator('#modResult').evaluate((e) => e.classList.contains('ok')) };
}
const visibleAdminPanels = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#hidden-while-logged-out section.panel')).filter((s) => getComputedStyle(s).display !== 'none').map((s) => s.id || s.querySelector('h2').textContent));

// ---------- the scenario ----------

async function scenario(presenceKind, issuerKind) {
  const label = presenceKind + ' presence / ' + issuerKind + ' issuer';
  console.log('\n===== ' + label + ' =====');
  cfgFile = path.join(H.tmpDir('atlas-mp-cfg-'), 'moderation-config.json');
  auditFile = path.join(H.tmpDir('atlas-mp-audit-'), 'audit.jsonl');
  visits.length = 0; tokens.length = 0;
  await startIssuer(issuerKind);
  await H.postJson(issuer.base, '/atlas/admin/moderation/grant', {});
  const issuerKey = (await (await fetch(issuer.base + '/.well-known/atlas-key.json')).json()).keys[0].publicKey;
  fs.writeFileSync(cfgFile, JSON.stringify({ enabled: true, audience: AUD, domains: { [DOMAIN]: { issuerKeys: [issuerKey], statusUrl: SITE + '/atlas/moderation/status' } }, revokedModerators: [], revokedGrants: [] }));
  await startPresence(presenceKind);

  const profile = H.tmpDir('atlas-mp-profile-');
  const context = await chromium.launchPersistentContext(profile, { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] });
  const sentToPresence = []; // every request body the pages send to the presence service
  const allRequests = [];
  context.on('request', (req) => {
    allRequests.push(req.url());
    if (req.url().startsWith(AUD)) sentToPresence.push({ url: req.url(), method: req.method(), body: req.postData() || '', headers: req.headers() });
  });
  let ok = true;
  try {
    let background = context.serviceWorkers()[0];
    if (!background) background = await context.waitForEvent('serviceworker');
    const extensionId = new URL(background.url()).host;
    const publicKey = await createWalletIdentity(context, extensionId);
    console.log('SETUP: wallet identity created in the extension');

    // Visitors: ordinary ones and hostile display names.
    const hostile = {
      img: '<img src=x onerror="window.__pwned=1">',
      script: '"><script>window.__pwned=2</script>',
      svg: "'><svg/onload=window.__pwned=3>",
      rtl: '‮gnp.exe‬ ' + 'W'.repeat(80)
    };
    const alice = await visitor('lobby', 'Alice');
    const vImg = await visitor('lobby', hostile.img);
    const vScript = await visitor('lobby', hostile.script);
    const vSvg = await visitor('lobby', hostile.svg, { chat: false });
    const vRtl = await visitor('lobby', hostile.rtl, { chat: false });
    const bob = await visitor('lobby', 'Bob', { presence: false });
    const pat = await visitor('plaza', 'Plaza Pat');
    const gus = await visitor('garden', 'Garden Gus');

    // ===== Phase 0: not on the roster =====
    console.log('PHASE 0: a key that is not on the roster gets no button');
    setRoster([]);
    {
      const { page, frame } = await openOverlay(context);
      await sleep(800);
      check('the wallet shows neither "Admin" nor "Moderate" for a stranger', await frame.locator('#adminBtn').isHidden(), 'button visible');
      await page.close();
    }

    // ===== Phase 1: administrator =====
    console.log('PHASE 1: an administrator');
    setRoster([{ publicKey, role: 'admin' }]);
    let mutedAt = 0;
    {
      const { page, label: btn } = await openPanel(context);
      check('an administrator\'s button reads "Admin"', /Admin/.test(btn) && !/Moderate/.test(btn), btn);
      const panels = await visibleAdminPanels(page);
      check('the existing administration panels are all still there, plus the moderation section', panels.includes('onlinePanel') && panels.includes('moderationPanel') && panels.includes('Revoke a credential') && panels.includes('Mint an asset') && panels.length >= 12, JSON.stringify(panels));
      await page.waitForFunction(() => !document.getElementById('modSetup').hidden, null, { timeout: 15000 });
      const worldOptions = await page.locator('#modWorld option').evaluateAll((o) => o.map((x) => x.value));
      check('the world list is every world the domain declares', worldOptions.sort().join() === 'garden,lobby,plaza', JSON.stringify(worldOptions));
      check('the consent text says what the wallet will be asked', /approve a 0-minute|approve a \d+-minute/.test(await page.locator('#modConsent').innerText()) && /roster\.view/.test(await page.locator('#modConsent').innerText()), await page.locator('#modConsent').innerText());

      console.log('  the wallet prompt');
      await page.locator('#modWorld').selectOption('lobby');
      await page.locator('#modStartBtn').click();
      const shown = await answerPrompt(page, false);
      check('the prompt names the requesting site and shows the whole request', shown.origin === SITE && /moderation-grant/.test(shown.payload) && shown.payload.includes(AUD) && /^worlds: /m.test(shown.payload) && /roster\.view/.test(shown.payload) && /audit\.view/.test(shown.payload) && /popPublicKey/.test(shown.payload) && /ttlSeconds/.test(shown.payload) && /adminAuth/.test(shown.payload), shown.payload);
      await sleep(500);
      check('declining the prompt starts no session', (await page.locator('#modWork').isHidden()) && /declined|closed|timed out/i.test(await page.locator('#modStatus').innerText()), await page.locator('#modStatus').innerText());
      check('...and the start button is available again', await page.locator('#modStartBtn').isEnabled() && !(await page.locator('#modStartBtn').isHidden()), 'button state');

      console.log('  a session');
      const shown2 = await startSession(page);
      const consent1 = parsePromptFields(shown2.payload);
      check('the grant request names exactly the worlds and actions the panel offered, nothing wider', consent1.worlds.slice().sort().join() === 'garden,lobby,plaza' && consent1.operations.join() === ALL_OPS.join() && consent1.audience === AUD && consent1.ttlSeconds === GRANT_TTL_S && consent1.purpose === 'moderation-grant', JSON.stringify(consent1));
      await selectWorld(page, 'lobby');
      await waitRoster(page, 6);
      const names = await page.locator('#modRosterBody bdi.pname').allInnerTexts();
      const nameSet = new Set(names);
      console.log('  hostile names');
      check('all six lobby visitors are listed (and no one from other worlds)', (await page.locator('#modRosterBody tr').count()) === 6 && !names.includes('Plaza Pat') && !names.includes('Garden Gus'), JSON.stringify(names));
      check('an HTML image tag in a name is shown as text', nameSet.has(hostile.img), JSON.stringify(names));
      check('a script tag in a name is shown as text', nameSet.has(hostile.script), JSON.stringify(names));
      check('an svg handler in a name is shown as text', nameSet.has(hostile.svg), JSON.stringify(names));
      check('a bidirectional override and over-long name are shown as plain (isolated) text, capped to 60 characters', names.some((n) => n.startsWith('‮gnp.exe')) && names.every((n) => Array.from(n).length <= 60), JSON.stringify(names.map((n) => Array.from(n).length)));
      const injected = await page.evaluate(() => ({ pwned: window.__pwned, nodes: document.querySelectorAll('#moderationPanel img, #moderationPanel script, #moderationPanel svg, #moderationPanel iframe, #moderationPanel [onerror], #moderationPanel [onload]').length }));
      check('no script ran and no element was created from a name', injected.pwned === undefined && injected.nodes === 0, JSON.stringify(injected));
      const tableText = await page.locator('#moderationPanel').innerText();
      check('the list shows no address, key, visit id or token', !/127\.0\.0|::1/.test(tableText) && !visits.some((v) => tableText.includes(v)) && !tokens.some((t) => tableText.includes(t)) && !/[A-Za-z0-9_-]{60,}/.test(tableText), tableText.slice(0, 400));
      await rowOf(page, 'Alice').getByRole('button', { name: 'Mute', exact: true }).click();
      const confirmShown = await page.locator('#modConfirmText').innerText();
      check('before any action the panel asks, naming the visitor and the world', /Mute Alice/.test(confirmShown) && /Test|lobby/.test(confirmShown), confirmShown);
      check('...with the fixed reasons and permitted durations', JSON.stringify(await page.locator('#modReason option').allInnerTexts()) === JSON.stringify(['Spam', 'Abusive behaviour', 'Harassment', 'Inappropriate content', 'Disruption', 'Other breach of the world rules']) && JSON.stringify(await page.locator('#modDuration option').allInnerTexts()) === JSON.stringify(['1 minute', '5 minutes', '10 minutes', '1 hour', '6 hours', '24 hours']), 'options');
      await page.locator('#modCancelBtn').click();
      check('cancelling changes nothing', (await say(alice, 'free to speak')).ok === true, 'was muted');

      console.log('  mute, unmute, kick through the panel');
      let a = await act(page, 'Alice', 'Mute', 'Spam', '1 minute');
      mutedAt = Date.now();
      check('mute: the panel reports the visitor and the expiry', a.ok && /Muted Alice until/.test(a.result) && /Spam/.test(a.result), a.result);
      const muted = await say(alice, 'trying to talk');
      check('...and the server really refuses her chat (muted, with the reason category)', muted.ok === false && muted.reason === 'muted' && /\(spam\)/.test(muted.message), JSON.stringify(muted));
      await page.waitForFunction(() => /Muted until/.test(document.getElementById('modRosterBody').innerText), null, { timeout: 10000 });
      check('the list now shows the mute and its expiry', /Muted until \d/.test(await rowOf(page, 'Alice').innerText()), await rowOf(page, 'Alice').innerText());
      a = await act(page, 'Alice', 'Unmute');
      check('unmute: reported', a.ok && /Unmuted Alice/.test(a.result), a.result);
      check('...and she can speak at once', (await say(alice, 'back again')).ok === true, 'still muted');
      a = await act(page, 'Alice', 'Mute', 'Spam', '1 minute');
      mutedAt = Date.now();
      check('muted again for 1 minute (expiry tested below)', a.ok, a.result);
      a = await act(page, hostile.rtl.slice(0, 8), 'Kick', 'Disruption', '1 minute');
      check('kick: reported with when they may return', a.ok && /Removed/.test(a.result) && /rejoin after/.test(a.result), a.result);
      const gone = await psync(vRtl);
      check('...and the visitor is really removed (their next request is told so)', gone.status === 403 && gone.body.reason === 'removed', JSON.stringify(gone));
      await page.waitForFunction(() => document.querySelectorAll('#modRosterBody tr').length === 5, null, { timeout: 15000 });
      check('the list no longer shows them', !(await page.locator('#modRosterBody bdi.pname').allInnerTexts()).some((n) => n.startsWith('‮')), 'still listed');
      const bobRow = await rowOf(page, 'Bob').locator('button').evaluateAll((bs) => bs.map((b) => [b.textContent, b.disabled]));
      check('a visitor not in presence/chat gets only the actions that apply (Bob is chat-only: mute yes)', bobRow.find((b) => b[0] === 'Mute')[1] === false && bobRow.find((b) => b[0] === 'Unmute')[1] === true, JSON.stringify(bobRow));

      console.log('  replay and secrets');
      const cmds = sentToPresence.filter((r) => r.url.endsWith('/presence/moderation/command') && r.method === 'POST');
      check('the panel only ever contacted the configured presence service for moderation', sentToPresence.every((r) => /\/presence\/moderation\/(roster|command|audit)$/.test(r.url) || r.method === 'OPTIONS'), JSON.stringify(sentToPresence.map((r) => r.method + ' ' + r.url)));
      check('...and no other host', allRequests.filter((u) => !u.startsWith(SITE) && !u.startsWith(AUD) && !u.startsWith('http://localhost:8004/') && !u.startsWith('chrome-extension') && !u.startsWith('data:') && !u.startsWith('blob:')).length === 0, JSON.stringify(allRequests.filter((u) => !u.startsWith(SITE) && !u.startsWith(AUD) && !u.startsWith('http://localhost:8004/') && !u.startsWith('chrome-extension'))));
      const bodies = sentToPresence.map((r) => r.body).join('\n');
      check('requests carry a grant and a signed request and nothing else: no private key, wallet key, session token or password', !bodies.includes(publicKey) && !/"d"|privateKey|token|password|jwk/i.test(bodies) && sentToPresence.every((r) => !r.headers.authorization && !r.headers.cookie), bodies.slice(0, 300));
      const replay = cmds[0];
      const replayed = await new Promise((resolve) => {
        const r = http.request({ host: '127.0.0.1', port: PORTS.presence, path: '/presence/moderation/command', method: 'POST', localAddress: fresh(), headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(replay.body) }, agent: false }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t })); });
        r.write(replay.body); r.end();
      });
      check('replaying a command the panel really sent is refused', replayed.status === 401 && /replay/.test(replayed.text), JSON.stringify(replayed));
      const tampered = JSON.parse(replay.body);
      tampered.request.payload.world = 'plaza';
      const tamperedRes = await rq('POST', '/presence/moderation/command', tampered);
      check('...and so is the same command moved to another world', tamperedRes.status === 401 || tamperedRes.status === 403, JSON.stringify(tamperedRes));

      console.log('  the audit log');
      await page.locator('#modAuditBtn').click();
      await page.waitForFunction(() => !document.getElementById('modAuditTable').hidden, null, { timeout: 15000 });
      const auditText = await page.locator('#modAuditWrap').innerText();
      check('the audit viewer lists the actions of this world with their outcomes', /chat\.mute/.test(auditText) && /chat\.unmute/.test(auditText) && /session\.kick/.test(auditText) && /success/.test(auditText) && /refused · replay|refused/.test(auditText) + '' !== 'false', auditText.slice(0, 500));
      check('...says whether the chain is intact and does not claim more than it can', /Integrity: chain intact/.test(auditText) && /not independently anchored/.test(auditText) && !/tamper-proof|tamper proof|immutable/i.test(auditText), auditText.slice(0, 600));
      check('...and holds no visitor name, address, key or token', !/Alice|Bob|127\.0\.0|<img|<script/.test(auditText) && !visits.some((v) => auditText.includes(v)) && !tokens.some((t) => auditText.includes(t)) && !auditText.includes(publicKey), auditText.slice(0, 500));
      const lines = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      check('the server-side log has the panel\'s actions under role admin and the right world', lines.filter((e) => e.operation === 'chat.mute' && e.outcome === 'success').length === 2 && lines.every((e) => e.role === 'admin' || e.role === null) && lines.filter((e) => e.world === 'lobby').length >= 5, JSON.stringify(lines.map((e) => [e.operation, e.outcome, e.code, e.role, e.world])));
      await page.close();
    }

    // ===== Phase 2: a moderator-only key =====
    console.log('PHASE 2: a moderator-only key');
    const phase2Mark = sentToPresence.length;
    setRoster([{ publicKey, role: 'moderator', worlds: ['lobby', 'plaza'], operations: ALL_OPS }]);
    let modPage;
    {
      const { page, label: btn } = await openPanel(context);
      modPage = page;
      check('a moderator\'s button reads "Moderate"', /Moderate/.test(btn) && !/Admin/.test(btn), btn);
      check('the page is titled as moderation, not administration', /Moderation/.test(await page.title()) && /Moderation/.test(await page.locator('#pageTitle').innerText()) && /^Moderator:/.test(await page.locator('#whoDisplay').innerText()), await page.title());
      const panels = await visibleAdminPanels(page);
      check('only the moderation section is visible: no revoke, mint, claw back, mail, calendar, directory or visit panel', panels.length === 1 && panels[0] === 'moderationPanel', JSON.stringify(panels));
      await page.waitForFunction(() => !document.getElementById('modSetup').hidden, null, { timeout: 15000 });
      const worldOptions = await page.locator('#modWorld option').evaluateAll((o) => o.map((x) => x.value));
      check('it lists only the worlds the moderator may moderate', worldOptions.sort().join() === 'lobby,plaza', JSON.stringify(worldOptions));
      const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem('atlasAdminSession')));
      const dir = await H.postJson(issuer.base, '/atlas/admin/directory', { token: session.token });
      const rev = await H.postJson(issuer.base, '/atlas/revoke', { payload: { id: 'urn:atlas:asset:x', reason: 'x' }, token: session.token });
      const mint = await H.postJson(issuer.base, '/atlas/asset/mint', { payload: { ownerPublicKey: 'x', assetClass: 'atlas.trophy.chess', quantity: 1 }, token: session.token });
      check('the moderator\'s session is refused by administration routes (directory, revoke, mint)', dir.status === 403 && rev.status === 403 && mint.status === 403, JSON.stringify([dir.status, rev.status, mint.status]));

      console.log('  a manifest that does not allow the signing purpose');
      const manifestPath = path.join(issuer.docroot, '.well-known', 'spatial.json');
      const good = fs.readFileSync(manifestPath, 'utf8');
      const stripped = JSON.parse(good); stripped.walletBridge = { read: true, sign: [] };
      fs.writeFileSync(manifestPath, JSON.stringify(stripped));
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => !document.getElementById('modSetup').hidden, null, { timeout: 15000 });
      await page.locator('#modStartBtn').click();
      await page.waitForFunction(() => /will not sign for this page/.test(document.getElementById('modStatus').textContent), null, { timeout: 20000 });
      check('the wallet never prompts, and the panel explains what the operator must allow', (await page.locator('#domain-atlas-bridge-confirm').count()) === 0 && /moderation-grant/.test(await page.locator('#modStatus').innerText()) && /moderation-setup/.test(await page.locator('#modStatus').innerText()), await page.locator('#modStatus').innerText());
      fs.writeFileSync(manifestPath, good);
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => !document.getElementById('modSetup').hidden, null, { timeout: 15000 });

      console.log('  a session, scope and unauthorized worlds');
      const shown = await startSession(page);
      const consent = parsePromptFields(shown.payload);
      check('the request names only the moderator\'s worlds and actions', consent.worlds.slice().sort().join() === 'lobby,plaza' && consent.operations.join() === ALL_OPS.join(), JSON.stringify(consent));
      const grantStart = Date.now();
      await selectWorld(page, 'plaza');
      await waitRoster(page, 1);
      check('another world of the moderator\'s own can be listed', (await page.locator('#modRosterBody bdi.pname').allInnerTexts()).join() === 'Plaza Pat', 'plaza list');
      const gardenGrant = sentToPresence.slice(phase2Mark).filter((r) => /garden/.test(r.body));
      check('garden is not in anything the panel sent', gardenGrant.length === 0, JSON.stringify(gardenGrant.map((r) => r.url)));
      // Ask the presence service directly for a world the grant does not cover, with the panel's own grant.
      const lastRoster = sentToPresence.filter((r) => r.url.endsWith('/roster')).pop();
      const forged = JSON.parse(lastRoster.body); forged.request.payload.world = 'garden';
      const denied = await rq('POST', '/presence/moderation/roster', forged);
      check('and the server refuses garden even if asked (the scope is enforced there, not in the page)', denied.status === 401 || denied.status === 403, JSON.stringify(denied));

      console.log('  renewing the grant: through the wallet, same scope');
      await sleep(Math.max(0, GRANT_TTL_S * 1000 - (Date.now() - grantStart)) + 500);
      await page.locator('#modRefreshBtn').click();
      const shownAgain = await answerPrompt(page, true);
      const again = parsePromptFields(shownAgain.payload);
      check('once the grant has lapsed the next action asks the wallet again', again.purpose === 'moderation-grant', shownAgain.payload);
      check('...for exactly the same worlds, actions and service, with a new ephemeral key', again.worlds.join() === consent.worlds.join() && again.operations.join() === consent.operations.join() && again.audience === consent.audience && again.popPublicKey !== consent.popPublicKey && again.adminAuth.nonce !== consent.adminAuth.nonce, JSON.stringify([consent, again]));
      await waitRoster(page, 1);
      const watcher = autoApprove(page); // later grant lapses (24 s lifetime) re-ask the wallet; this stands in for the operator approving

      console.log('  expiry of the mute from Phase 1, observed');
      const left = mutedAt + 62000 - Date.now();
      if (left > 0) await sleep(left);
      const talk = await say(alice, 'after the mute');
      check('the one-minute mute has expired on its own', talk.ok === true, JSON.stringify(talk));
      await selectWorld(page, 'lobby');
      await waitRoster(page, 4);
      check('...and the list no longer shows it', !/Muted until/.test(await page.locator('#modRosterBody').innerText()), await page.locator('#modRosterBody').innerText());

      console.log('  a moderator acts');
      const a = await act(page, 'Bob', 'Mute', 'Harassment', '5 minutes');
      check('a scoped moderator can mute', a.ok && /Muted Bob until/.test(a.result), a.result);
      check('...and the server refuses Bob\'s chat', (await say(bob, 'hi')).reason === 'muted', 'not muted');
      await act(page, 'Bob', 'Unmute');

      console.log('  audit view for the moderator');
      await selectWorld(page, 'plaza');
      await page.locator('#modAuditBtn').click();
      await page.waitForFunction(() => /Nothing recorded|entries/.test(document.getElementById('modAuditInfo').textContent), null, { timeout: 15000 });
      const plazaAudit = await page.locator('#modAuditWrap').innerText();
      check('the audit log of plaza does not show the lobby\'s actions (only a refused attempt that named plaza)', !/success/.test(await page.locator('#modAuditBody').innerText()) && !/unmute|session\.kick/.test(await page.locator('#modAuditBody').innerText()), plazaAudit);
      await selectWorld(page, 'lobby');
      await page.locator('#modAuditBtn').click();
      await page.waitForFunction(() => document.getElementById('modAuditTable').hidden === false, null, { timeout: 15000 });
      const lobbyRows = await page.locator('#modAuditBody tr').allInnerTexts();
      check('the lobby log shows the earlier administrator\'s actions and this moderator\'s, with roles', lobbyRows.some((r) => /admin/.test(r)) && lobbyRows.some((r) => /moderator/.test(r)), JSON.stringify(lobbyRows.slice(0, 6)));
      check('...and nothing from garden', !lobbyRows.some((r) => /garden/.test(r)), 'garden entry');
      watcher.stop();
    }

    // ===== Phase 3: revoked while moderating =====
    console.log('PHASE 3: revoked while moderating');
    {
      const page = modPage;
      setRoster([{ publicKey, role: 'moderator', worlds: ['lobby', 'plaza'], operations: ALL_OPS, revoked: true }]);
      // The panel's grant is still unexpired; the presence service must stop it within the status lifetime.
      const refused = await (async () => {
        const start = Date.now();
        for (;;) {
          await page.locator('#modRefreshBtn').click();
          // a grant may have lapsed meanwhile: the wallet prompt then appears and is approved (the issuer will refuse it)
          const prompt = await page.waitForSelector('#domain-atlas-bridge-confirm', { timeout: 1500 }).catch(() => null);
          if (prompt) await answerPrompt(page, true);
          await sleep(900);
          const text = await page.locator('#modRosterState').innerText().catch(() => '');
          const status = await page.locator('#modStatus').innerText().catch(() => '');
          if (/no longer lists you|not a registered|no longer lists your key/.test(text + status)) return text + ' | ' + status;
          if (Date.now() - start > (STATUS_TTL_S + REFRESH_S + 20) * 1000) return null;
        }
      })();
      check('a revoked moderator is refused, in plain words', !!refused, 'never refused');
      const modsAfter = await rq('POST', '/presence/moderation/roster', JSON.parse(sentToPresence.filter((r) => r.url.endsWith('/roster')).pop().body));
      check('...and the old grant no longer works at the presence service either', modsAfter.status === 403 || modsAfter.status === 401, JSON.stringify(modsAfter));
      const lines = fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      check('the refusal is in the server-side log under the moderator\'s reference', lines.some((e) => e.outcome === 'refused' && e.code === 'moderator-inactive'), JSON.stringify(lines.slice(-4)));
      await page.close();
    }

    // ===== Phase 4: whole-run checks =====
    console.log('PHASE 4: everything the run left behind');
    const log = fs.readFileSync(auditFile, 'utf8');
    const leaked = [publicKey, ...visits, ...tokens, '127.0.0.', 'Alice', 'Bob', 'Plaza Pat', 'onerror', '<script', 'free to speak', 'trying to talk'].filter((n) => log.includes(n));
    check('the audit log holds none of the wallet key, visit ids, tokens, addresses, names or chat text', leaked.length === 0, JSON.stringify(leaked));
    check('the admin panel pages are identical in the Node and PHP issuers', fs.readFileSync(path.join(ROOT, 'issuer-server/admin-panel/index.html'), 'utf8') === fs.readFileSync(path.join(ROOT, 'issuer-php/atlas-admin/index.html'), 'utf8'), 'copies differ');
    const src = fs.readFileSync(path.join(ROOT, 'issuer-server/admin-panel/index.html'), 'utf8');
    const modSrc = src.slice(src.indexOf('// ---------- world moderation ----------'), src.lastIndexOf('verifySessionOrShowLoggedOut();')).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    check('the moderation code never builds HTML from data (no innerHTML, outerHTML, insertAdjacentHTML, document.write, eval, Function)', !/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(modSrc), 'unsafe API present');
    check('...never touches the wallet\'s keys or storage (no wallet.js, no chrome.*, no sessionStorage reads beyond the existing login)', !/chrome\.|AtlasWallet|privateKey|exportKey\('jwk'|localStorage|sessionStorage/.test(modSrc.replace(/popKey\.privateKey/g, '').replace(/exportKey\('raw'/g, '')), 'unexpected API');
  } catch (err) {
    console.error('FAILURE:', err);
    failures++;
    ok = false;
  } finally {
    await context.close().catch(() => {});
    await killAll();
    for (const d of [profile]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  }
  return ok;
}

(async () => {
  try {
    const combos = MATRIX ? [['node', 'node'], ['php', 'php'], ['node', 'php'], ['php', 'node']] : [[ARGS[0] === 'php' ? 'php' : 'node', ARGS[1] || (ARGS[0] === 'php' ? 'php' : 'node')]];
    for (const [p, i] of combos) await scenario(p, i);
  } catch (err) {
    console.error('FAILURE:', err);
    failures++;
  } finally {
    await killAll();
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL MODERATION PANEL END-TO-END CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
