// End-to-end check that the real wallet supplies the per-visit id that lets a
// moderator's anonymous session list pair a visitor's presence and chat
// connections, over both transports, through two real browser contexts:
//
//   node test/manual-presence-moderation-wallet.js
//
// The test starts its own issuer on 8001 (the port the extension's loopback
// defaults use for the demo domain; stop any demo server there first) with an
// isolated state directory, and its own presence server on 8004, once with
// WebSocket enabled and once with PRESENCE_DISABLE_WS=1 (polling only). In each
// run two visitors enter the Lobby; a moderator then obtains a signed grant and
// lists the lobby. Checks:
//
//   1. Both visitors appear, each as ONE linked entry (presence + chat), with the
//      avatar id the visitor's own wallet reports.
//   2. The two visitors have different entries and references.
//   3. Nothing in the list identifies a wallet (no key, credential id, address,
//      token) and the visit id the wallet generated never appears.
//   4. After a visitor leaves, the list shrinks.
//   5. A moderator's session.kick removes the visitor on both transports: the
//      wallet shows the removal message in the presence hint and the chat
//      status line, and does not rejoin on its own (the list stays empty well
//      past a polling interval).
//
// Not part of the permanent suite, same reasoning as the other manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const H = require('./lib/delivery-harness');
const { withAdminAuth } = require('./lib/admin-auth');
const M = require('../tools/lib/moderation-grant');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const ISSUER_PORT = 8001, PRESENCE_PORT = 8004;
const DOMAIN = 'localhost:' + ISSUER_PORT;
const AUDIENCE = 'http://localhost:' + PRESENCE_PORT;
const WORLD = 'lobby';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS: ' : 'FAIL: ') + name + (ok ? '' : ' => ' + detail));
}

async function projectPortals(frame) {
  return frame.evaluate(() => new Promise((resolve) => {
    const tick = () => {
      if (window.__atlasScene && window.__atlasScene.portalMarkers.length) {
        const canvas = document.getElementById('scene');
        const originX = canvas.width / 2, originY = canvas.height / 2 + 40;
        const SCALE = 26, COS30 = Math.cos(Math.PI / 6), SIN30 = Math.sin(Math.PI / 6);
        resolve(window.__atlasScene.portalMarkers.map((m) => {
          const [x, , z] = m.position;
          return { sx: originX + (x - z) * COS30 * SCALE, sy: originY + (x + z) * SIN30 * SCALE, to: m.portal && m.portal.to };
        }));
      } else { requestAnimationFrame(tick); }
    };
    tick();
  }));
}
async function enterLobby(context, label) {
  const page = await context.newPage();
  await page.goto('http://localhost:' + ISSUER_PORT, { waitUntil: 'load' });
  await page.locator('#domain-atlas-enter-btn').click();
  const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
  const frame = await frameHandle.contentFrame();
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });
  const portals = await projectPortals(frame);
  const toLobby = portals.find((p) => p.to === 'lobby');
  await frame.locator('#scene').click({ position: { x: toLobby.sx, y: toLobby.sy } });
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby'), null, { timeout: 10000 });
  await page.waitForTimeout(300);
  console.log('SETUP: ' + label + ' entered the Lobby');
  return { page, frame };
}
async function waitFor(fn, description, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for: ' + description);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function startPresence(env, cfgFile) {
  const proc = spawn(process.execPath, [path.resolve(__dirname, '..', 'presence-server', 'server.js')], {
    env: { ...process.env, PORT: String(PRESENCE_PORT), PRESENCE_MODERATION_CONFIG: cfgFile, POLL_TIMEOUT_MS: '600000', POLL_SWEEP_INTERVAL_MS: '1000', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('presence-server did not start in time')), 5000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    proc.on('exit', (code) => reject(new Error('presence-server exited early with code ' + code + ' (is port ' + PRESENCE_PORT + ' in use?)')));
  });
  return proc;
}

async function getGrant(issuerBase, mod) {
  const pop = await M.generatePopKey();
  const payload = JSON.parse(JSON.stringify(withAdminAuth({ audience: AUDIENCE, worlds: [WORLD], operations: ['roster.view', 'session.kick'], popPublicKey: pop.publicKey }, issuerBase, '/atlas/admin/moderation/grant')));
  const g = await H.postJson(issuerBase, '/atlas/admin/moderation/grant', { payload, proof: await H.signWithSelf(mod, payload) });
  if (g.status !== 200) throw new Error('grant refused: ' + JSON.stringify(g.body));
  return { grant: g.body.grant, pop };
}
async function kick(g, target) {
  const req = await M.signRequest(g.pop.privateKey, { type: 'atlas.moderation-request', version: 1, grantId: g.grant.payload.grantId, audience: AUDIENCE, domain: DOMAIN, world: WORLD, operation: 'session.kick', target, issuedAt: new Date().toISOString(), nonce: Buffer.from(require('crypto').randomBytes(16)).toString('base64url'), params: { durationSeconds: 60, cause: 'disruption' } });
  const res = await fetch('http://localhost:' + PRESENCE_PORT + '/presence/moderation/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant: g.grant, request: req }) });
  return { status: res.status, body: await res.json() };
}
async function listLobby(g) {
  const req = await M.signRequest(g.pop.privateKey, { type: 'atlas.moderation-request', version: 1, grantId: g.grant.payload.grantId, audience: AUDIENCE, domain: DOMAIN, world: WORLD, operation: 'roster.view', target: '', issuedAt: new Date().toISOString(), nonce: Buffer.from(require('crypto').randomBytes(16)).toString('base64url') });
  const res = await fetch('http://localhost:' + PRESENCE_PORT + '/presence/moderation/roster', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant: g.grant, request: req }) });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}

async function run(label, presenceEnv, ctx) {
  console.log('\n===== ' + label + ' =====');
  const proc = await startPresence(presenceEnv, ctx.cfgFile);
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };
  const tag = label.replace(/\W+/g, '-');
  const dirA = path.resolve(__dirname, '.chrome-profile-modwallet-a-' + tag), dirB = path.resolve(__dirname, '.chrome-profile-modwallet-b-' + tag);
  const contextA = await chromium.launchPersistentContext(dirA, launchOpts);
  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);
  try {
    const a = await enterLobby(contextA, 'Visitor A');
    const b = await enterLobby(contextB, 'Visitor B');
    await waitFor(() => b.frame.evaluate(() => window.__atlasActive3D.getRemotePlayerCount() === 1), 'B sees A');
    const aId = await a.frame.evaluate(() => window.__atlasPresenceOwnId);
    const bId = await b.frame.evaluate(() => window.__atlasPresenceOwnId);

    const grant = await getGrant(ctx.issuerBase, ctx.mod);
    let list = null;
    await waitFor(async () => { list = await listLobby(grant); return list.status === 200 && list.body.count === 2 && list.body.participants.every((p) => p.linked); }, 'two linked entries (presence + chat for each visitor)', 20000).catch(() => {});
    check('moderator gets the lobby list', list && list.status === 200, list && list.text);
    const ps = list.body.participants || [];
    check('two entries, each one visitor with presence AND chat joined (paired by the wallet\'s visit id)', ps.length === 2 && ps.every((p) => p.linked && p.presence.joined && p.chat.joined), JSON.stringify(ps));
    check('the avatar ids are the ones the wallets report for themselves', ps.map((p) => p.presence.avatarId).sort().join() === [aId, bId].sort().join(), JSON.stringify([ps.map((p) => p.presence.avatarId), aId, bId]));
    check('different visitors have different references and chat sender ids', ps.length === 2 && ps[0].ref !== ps[1].ref && ps[0].chat.senderId !== ps[1].chat.senderId, JSON.stringify(ps));
    check('the world is named and the domain is the manifest\'s', list.body.world === WORLD && list.body.domain === DOMAIN, JSON.stringify([list.body.world, list.body.domain]));

    // What the wallet generated must not appear anywhere in the list.
    const visits = await Promise.all([a, b].map((x) => x.frame.evaluate(() => (typeof visitMemo !== 'undefined' && visitMemo && visitMemo.id) || null).catch(() => null)));
    check('the list contains no address, token, key, credential or visit field', !/127\.0\.0\.|::1|"src"|credential|publicKey|token|"visit"/i.test(list.text), list.text);
    for (const v of visits.filter(Boolean)) check('the wallet\'s raw visit id is not in the list', !list.text.includes(v), v);

    await contextB.close();
    const after = await waitFor(async () => { const l = await listLobby(grant); return l.status === 200 && l.body.count === 1 ? l : null; }, 'the list to shrink after B leaves', 20000).catch(() => null);
    const last = after || await listLobby(grant);
    check('after B closes its wallet the list shows one visitor', !!after && after.body.participants[0].presence.avatarId === aId, last.text);

    // A moderator removes the remaining visitor.
    const target = after && after.body.participants[0].ref;
    const k = await kick(grant, target);
    check('the kick is accepted and removes presence and chat', k.status === 200 && k.body.removed.presence === 1 && k.body.removed.chat === 1, JSON.stringify(k));
    const hint = await waitFor(() => a.frame.evaluate(() => { const el = document.getElementById('presenceTransientHint'); return el && /removed you from this world/.test(el.textContent) ? el.textContent : null; }), 'the removal message in the presence hint', 15000).catch(() => null);
    check('the wallet tells the visitor why (presence hint, templated text with the cause)', !!hint && /\(disruption\)/.test(hint), String(hint));
    const chatLine = await waitFor(() => a.frame.evaluate(() => { const el = document.getElementById('chatSendStatus'); return el && /removed you from this world/.test(el.textContent) ? el.textContent : null; }), 'the removal message in the chat status line', 15000).catch(() => null);
    check('...and in the chat status line', !!chatLine, String(chatLine));
    await a.page.waitForTimeout(6000); // several polling intervals, and past the WebSocket reconnect paths
    const stay = await listLobby(grant);
    check('the wallet does not rejoin on its own while the kick lasts', stay.status === 200 && stay.body.count === 0, stay.text);
    check('the wallet holds no live presence id after the removal', (await a.frame.evaluate(() => window.__atlasPresenceOwnId)) === null, 'still has an id');
  } finally {
    await contextA.close().catch(() => {});
    await contextB.close().catch(() => {});
    proc.kill();
    await new Promise((r) => setTimeout(r, 400));
  }
}

(async () => {
  const docroot = H.tmpDir('atlas-mw-docroot-');
  fs.cpSync(path.join(H.ROOT, 'demo-domain-a'), docroot, { recursive: true });
  const stateDir = H.tmpDir('atlas-mw-state-');
  const mod = await H.genIdentity();
  fs.writeFileSync(path.join(stateDir, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: mod.publicKey, addedAt: new Date().toISOString(), role: 'moderator', worlds: [WORLD], operations: ['roster.view', 'session.kick'] }] }));
  const issuer = await H.startNodeIssuer({ port: ISSUER_PORT, stateDir, docrootDir: docroot, env: { ATLAS_MODERATION_AUDIENCES: AUDIENCE, ATLAS_ADMIN_FAIL_LIMIT: '1000', ATLAS_ADMIN_NONCE_PER_CLIENT_PER_MIN: '1000', ATLAS_ADMIN_NONCE_CAP: '1000' } });
  try {
    const issuerBase = 'http://localhost:' + ISSUER_PORT;
    await H.postJson(issuerBase, '/atlas/admin/moderation/grant', {});
    const issuerKey = (await (await fetch(issuerBase + '/.well-known/atlas-key.json')).json()).keys[0].publicKey;
    const cfgFile = path.join(H.tmpDir('atlas-mw-cfg-'), 'moderation-config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ enabled: true, audience: AUDIENCE, domains: { [DOMAIN]: { issuerKeys: [issuerKey], statusUrl: issuerBase + '/atlas/moderation/status' } }, revokedModerators: [], revokedGrants: [] }));
    const ctx = { issuerBase, mod, cfgFile };
    await run('WebSocket transport', {}, ctx);
    await run('polling transport (WebSocket disabled)', { PRESENCE_DISABLE_WS: '1', POLL_TIMEOUT_MS: '4000', POLL_SWEEP_INTERVAL_MS: '500' }, ctx);
  } catch (err) {
    console.error('FAILURE:', err);
    failures++;
  } finally {
    await H.stopIssuer(issuer);
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL WALLET MODERATION-LISTING CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
