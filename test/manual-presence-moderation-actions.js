// Security regression test for server-enforced moderation commands (chat.mute,
// chat.unmute, session.kick) against the Node presence server and the PHP
// presence bundle, paired with either issuer:
//
//   node test/manual-presence-moderation-actions.js node            presence Node, issuer Node
//   node test/manual-presence-moderation-actions.js php             presence PHP,  issuer PHP
//   node test/manual-presence-moderation-actions.js node php        presence Node, issuer PHP
//   node test/manual-presence-moderation-actions.js php node        presence PHP,  issuer Node
//   node test/manual-presence-moderation-actions.js matrix          all four pairings, then
//                                                                   compares every answer
//
// Each run starts two issuers (two domains) and a presence service with
// isolated scratch state; no live configuration is read or written. Timing is
// scaled down (issuer status lifetime 5 s, refresh 2 s; mutes and kicks of 3 s)
// so expiry and revocation can be measured.
//
// Covered: authorized mute / unmute / kick; muted chat refused over polling and
// (Node) WebSocket; timed mute expiry and explicit unmute; history retained;
// kick removes presence and chat sessions of the visit and nothing else;
// removed sessions are told so (403 "removed" / WebSocket notices) instead of
// "unknown, rejoin"; rejoin with the same visit refused until the kick expires
// and without touching the source's join budget; a fresh visit and a visit in
// another world or domain are unaffected; wrong domain / world / unknown
// reference; missing, limited, expired and revoked authority; replay; argument
// validation; the per-moderator command rate limit (and that a limited request
// stays retryable); two bystanders unaffected; nothing identifying in any
// response or in the PHP restriction file; identical answers across pairings.

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const H = require('./lib/delivery-harness');
const { withAdminAuth } = require('./lib/admin-auth');
const M = require('../tools/lib/moderation-grant');

const ROOT = path.resolve(__dirname, '..');
const PORTS = { issuer1: 9341, issuer2: 9342, presence: 9343 };
const AUD = 'https://presence.test.example';
const D1 = 'localhost:' + PORTS.issuer1;
const D2 = 'localhost:' + PORTS.issuer2;
const GRANT = '/atlas/admin/moderation/grant';
const ROSTER = '/presence/moderation/roster';
const COMMAND = '/presence/moderation/command';
const STATUS_TTL_S = 5, REFRESH_S = 2;
const ALL_OPS = ['roster.view', 'chat.mute', 'chat.unmute', 'session.kick'];

const ARGS = process.argv.slice(2);
const MATRIX = ARGS[0] === 'matrix';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS: ' : 'FAIL: ') + name + (ok ? '' : ' => ' + detail));
}

// ---------- processes ----------

const children = [];
function track(proc) { children.push(proc); return proc; }
async function killAll() {
  for (const c of children.splice(0)) { try { c.kill(); } catch (_) {} }
  await sleep(300);
}

async function startIssuer(kind, port) {
  const env = { ATLAS_ADMIN_FAIL_LIMIT: '1000', ATLAS_ADMIN_NONCE_PER_CLIENT_PER_MIN: '1000', ATLAS_ADMIN_NONCE_CAP: '1000', ATLAS_MODERATION_STATUS_TTL_S: String(STATUS_TTL_S), ATLAS_MODERATION_STATUS_PER_CLIENT_PER_MIN: '10000', ATLAS_MODERATION_MAX_LIVE_GRANTS: '500' };
  const domain = 'localhost:' + port;
  let issuer;
  if (kind === 'node') {
    const docroot = H.tmpDir('atlas-pa-docroot-');
    fs.cpSync(path.join(H.ROOT, 'demo-domain-a'), docroot, { recursive: true });
    const stateDir = H.tmpDir('atlas-pa-state-');
    issuer = await H.startNodeIssuer({ port, stateDir, docrootDir: docroot, env: { ...env, ATLAS_MODERATION_AUDIENCES: AUD } });
    issuer.files = (name) => path.join(stateDir, name);
  } else {
    const bundleDir = H.preparePhpBundle();
    fs.writeFileSync(path.join(bundleDir, 'lib', 'atlas-moderation-config.json'), JSON.stringify({ domain, audiences: [AUD] }));
    issuer = await H.startPhpIssuer({ port, bundleDir, env: { PHP_CLI_SERVER_WORKERS: '4', ...env } });
    issuer.files = (name) => path.join(bundleDir, 'lib', name);
  }
  track(issuer.proc);
  issuer.domain = domain;
  issuer.base = 'http://localhost:' + port;
  return issuer;
}
function setRoster(issuer, entries) {
  const keys = entries.map((e) => {
    const k = { publicKey: e.identity.publicKey, addedAt: new Date().toISOString() };
    if (e.role) k.role = e.role;
    if (e.worlds) k.worlds = e.worlds;
    if (e.operations) k.operations = e.operations;
    if (e.revoked) k.revoked = true;
    return k;
  });
  fs.writeFileSync(issuer.files('atlas-admin-keys-store.json'), JSON.stringify({ keys }));
}
async function issuerKeyOf(issuer) {
  await H.postJson(issuer.base, GRANT, {}); // the PHP bundle creates its key on the first request that needs one
  return (await (await fetch(issuer.base + '/.well-known/atlas-key.json')).json()).keys[0].publicKey;
}

let presence = null; // { kind, dir, proc }
let cfgFile = null;
async function startPresence(kind, extraEnv) {
  const env = { ...process.env, PRESENCE_MODERATION_CONFIG: cfgFile, POLL_TIMEOUT_MS: '600000', POLL_SWEEP_INTERVAL_MS: '1000', MODERATION_STATUS_REFRESH_S: String(REFRESH_S), MODERATION_FETCH_TIMEOUT_MS: '1000', ...(extraEnv || {}) };
  let proc, dir = null;
  if (kind === 'php') {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pa-presence-'));
    fs.cpSync(path.join(ROOT, 'presence-php'), dir, { recursive: true });
    for (const f of fs.readdirSync(path.join(dir, 'presence/lib'))) if (/^atlas-.*\.json/.test(f)) fs.unlinkSync(path.join(dir, 'presence/lib', f));
    proc = spawn('php', ['-S', '127.0.0.1:' + PORTS.presence, 'test-router.php'], { cwd: dir, env: { ...env, PHP_CLI_SERVER_WORKERS: '4' }, stdio: 'ignore' });
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
async function restartPresence(kind, env) {
  try { presence.proc.kill(); } catch (_) {}
  await sleep(500);
  await startPresence(kind, env);
}

// ---------- HTTP ----------

let srcCounter = 20;
const nextSrc = () => '127.0.0.' + (20 + (srcCounter++ % 80));
const seen = []; // every moderation response body, scanned for leaks at the end
function rq(method, p, body, o) {
  o = o || {};
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, o.headers || {});
    const r = http.request({ host: '127.0.0.1', port: PORTS.presence, path: p, method, localAddress: o.src, headers, agent: false }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        if (p === ROSTER || p === COMMAND) seen.push(text);
        resolve({ status: res.statusCode, body: json, text, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const show = (r) => JSON.stringify({ status: r.status, body: r.body });
const results = {}; // name -> value, compared between pairings
function expect(name, r, status, code) {
  const ok = r.status === status && (code === undefined || (r.body && r.body.code === code));
  results[name] = r.status + ' ' + (r.body && r.body.code ? r.body.code : '');
  check(name + ': ' + status + (code ? ' ' + code : ''), ok, show(r));
  return r;
}
// Time-dependent wording ('Time remaining: 3 seconds') is compared without the number.
const norm = (t) => String(t).replace(/(Time remaining: |rejoin in )[^.]*\./, '$1X.');
const shapeOf = (x) => Array.isArray(x) ? x.map(shapeOf) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, shapeOf(x[k])])) : x === null ? 'null' : typeof x;
const scan = (text, needles) => needles.filter((n) => n && text.includes(n));

// ---------- grants and requests ----------

const b64 = (n) => Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString('base64url');
async function getGrant(issuer, who, o) {
  o = o || {};
  const pop = o.pop || (await M.generatePopKey());
  const payload = { audience: AUD, worlds: o.worlds || ['alpha'], operations: o.operations || ALL_OPS, popPublicKey: pop.publicKey, ttlSeconds: o.ttlSeconds || 300 };
  const p = JSON.parse(JSON.stringify(withAdminAuth(payload, issuer.base, GRANT)));
  const r = await H.postJson(issuer.base, GRANT, { payload: p, proof: await H.signWithSelf(who, p) });
  if (r.status !== 200) throw new Error('grant refused: ' + JSON.stringify(r.body));
  return { grant: r.body.grant, pop, issuer };
}
async function requestBody(g, operation, target, params, o) {
  o = o || {};
  const req = { type: 'atlas.moderation-request', version: 1, grantId: g.grant.payload.grantId, audience: g.grant.payload.audience, domain: g.grant.payload.domain, world: o.world || 'alpha', operation, target, issuedAt: new Date().toISOString(), nonce: b64(16), ...(params === undefined ? {} : { params }), ...(o.req || {}) };
  return { grant: o.grant || g.grant, request: await M.signRequest((o.signWith || g.pop).privateKey, req) };
}
async function cmd(g, operation, target, params, o) {
  o = o || {};
  return rq('POST', COMMAND, o.body || await requestBody(g, operation, target, params, o), { src: o.src || nextSrc() });
}
async function list(g, world) {
  return rq('POST', ROSTER, await requestBody(g, 'roster.view', '', undefined, { world: world || 'alpha' }), { src: nextSrc() });
}

// ---------- participants ----------

const identities = [];
async function ident() { const i = await H.genIdentity(); identities.push(i); return i; }
const joinedTokens = [];
const visitIds = [];
let nextIp = 100;
const newVisit = () => { const v = b64(16); visitIds.push(v); return v; }; // what the wallet generates
const fresh = () => '127.0.0.' + (100 + (nextIp++ % 100));
async function pjoin(domain, world, name, visit, src) {
  const body = { domain, world, name };
  if (visit !== undefined) body.visit = visit;
  const r = await rq('POST', '/presence/poll/join', body, { src: src || fresh() });
  if (r.status === 200) joinedTokens.push(r.body.id);
  return r;
}
async function cjoin(domain, world, name, visit, src) {
  const body = { domain, world, name };
  if (visit !== undefined) body.visit = visit;
  const r = await rq('POST', '/presence/poll/chat-join', body, { src: src || fresh() });
  if (r.status === 200) joinedTokens.push(r.body.id);
  return r;
}
async function must(p) { const r = await p; if (r.status !== 200) throw new Error('setup failed ' + r.text); return r.body; }
const psync = (id) => rq('POST', '/presence/poll/sync', { id }, { src: nextSrc() });
const csync = (id) => rq('POST', '/presence/poll/chat-sync', { id }, { src: nextSrc() });
const csend = (id, text) => rq('POST', '/presence/poll/chat-send', { id, text }, { src: nextSrc() });
const cleave = (id) => rq('POST', '/presence/poll/chat-leave', { id }, { src: nextSrc() });

function wsConnect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORTS.presence + '/presence');
    const queue = []; let waiter = null;
    ws.addEventListener('message', (ev) => { queue.push(JSON.parse(ev.data)); if (waiter) { const w = waiter; waiter = null; w(); } });
    ws.addEventListener('open', () => resolve({ ws, queue, next: (types, ms) => new Promise((res, rej) => {
      const t = setTimeout(() => { waiter = null; rej(new Error('ws timeout waiting for ' + types)); }, ms || 5000);
      const take = () => { while (queue.length) { const m = queue.shift(); if (typeof types === 'function' ? types(m) : (!types || types.includes(m.type))) { clearTimeout(t); return res(m); } } waiter = () => take(); };
      take();
    }) }));
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
}
const sockets = [];
// Checks that only one presence kind can run are not part of the cross-pairing comparison.
function wsOnly(r) { Object.keys(results).filter((k) => /\(WebSocket\)/.test(k)).forEach((k) => delete results[k]); return r; }

// ---------- config ----------

let key1 = null, key2 = null;
const baseConfig = () => ({
  enabled: true, audience: AUD,
  domains: {
    [D1]: { issuerKeys: [key1], statusUrl: 'http://localhost:' + PORTS.issuer1 + '/atlas/moderation/status' },
    [D2]: { issuerKeys: [key2], statusUrl: 'http://localhost:' + PORTS.issuer2 + '/atlas/moderation/status' }
  },
  revokedModerators: [], revokedGrants: []
});
function setConfig(cfg) { fs.writeFileSync(cfgFile, JSON.stringify(cfg)); }

async function until(fn, timeoutMs, stepMs) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) return null;
    await sleep(stepMs || 400);
  }
}

// ---------- the scenario ----------

async function scenario(presenceKind, issuerKind) {
  const label = presenceKind + ' presence / ' + issuerKind + ' issuer';
  console.log('\n===== ' + label + ' =====');
  results.__label = label;
  cfgFile = path.join(H.tmpDir('atlas-pa-cfg-'), 'moderation-config.json');
  const iss1 = await startIssuer(issuerKind, PORTS.issuer1);
  const iss2 = await startIssuer(issuerKind, PORTS.issuer2);

  const admin = await ident(), modA = await ident(), modMute = await ident(), modBeta = await ident(), modRev = await ident(), modShrink = await ident(), mod2 = await ident(), modRate = await ident();
  setRoster(iss1, [
    { identity: admin, role: 'admin' },
    { identity: modA, role: 'moderator', worlds: ['alpha'], operations: ALL_OPS },
    { identity: modMute, role: 'moderator', worlds: ['alpha'], operations: ['roster.view', 'chat.mute', 'chat.unmute'] },
    { identity: modBeta, role: 'moderator', worlds: ['beta'], operations: ALL_OPS },
    { identity: modRev, role: 'moderator', worlds: ['alpha'], operations: ALL_OPS },
    { identity: modShrink, role: 'moderator', worlds: ['alpha'], operations: ALL_OPS },
    { identity: modRate, role: 'moderator', worlds: ['alpha'], operations: ALL_OPS }
  ]);
  setRoster(iss2, [{ identity: mod2, role: 'moderator', worlds: ['alpha'], operations: ALL_OPS }]);
  key1 = await issuerKeyOf(iss1); key2 = await issuerKeyOf(iss2);
  setConfig(baseConfig());
  await startPresence(presenceKind, { MODERATION_COMMANDS_PER_MIN: '200' });

  console.log('STEP 1: sessions to moderate');
  const VA = newVisit(), VB = newVisit(), VC = newVisit(), VE = newVisit(), VH = newVisit(), VM = newVisit(), VK = newVisit();
  const alice = { p: await must(pjoin(D1, 'alpha', 'Alice', VA)), c: await must(cjoin(D1, 'alpha', 'Alice', VA)) };
  const carol = { p: await must(pjoin(D1, 'alpha', 'Carol', VC)), c: await must(cjoin(D1, 'alpha', 'Carol', VC)) };
  const dan = { c: await must(cjoin(D1, 'alpha', 'Dan')) }; // an old client (no visit id), chat only
  const hank = { p: await must(pjoin(D1, 'alpha', 'Hank', VH)) }; // presence only, so far
  const ivan = { p: await must(pjoin(D1, 'alpha', 'Ivan')) }; // presence only, no visit id
  const eve = { p: await must(pjoin(D1, 'beta', 'Eve', VE)), c: await must(cjoin(D1, 'beta', 'Eve', VE)) };
  const frank = { p: await must(pjoin(D1, 'beta', 'Frank', VA)), c: await must(cjoin(D1, 'beta', 'Frank', VA)) }; // Alice's visit id, other world
  const mallory = { p: await must(pjoin(D2, 'alpha', 'Mallory', VM)), c: await must(cjoin(D2, 'alpha', 'Mallory', VM)) };
  let bob;
  if (presenceKind === 'node') { // Bob uses WebSocket for both connections
    const a = await wsConnect(), c = await wsConnect(); sockets.push(a.ws, c.ws);
    a.ws.send(JSON.stringify({ type: 'join', domain: D1, world: 'alpha', name: 'Bob', visit: VB }));
    const w = await a.next(['welcome', 'join-denied']);
    c.ws.send(JSON.stringify({ type: 'chat-join', domain: D1, world: 'alpha', name: 'Bob', visit: VB }));
    const h = await c.next(['chat-history', 'chat-error']);
    bob = { ws: true, pws: a, cws: c, avatarId: w.id, senderId: h.senderId };
  } else {
    bob = { ws: false, p: await must(pjoin(D1, 'alpha', 'Bob', VB)), c: await must(cjoin(D1, 'alpha', 'Bob', VB)) };
  }

  const gA = await getGrant(iss1, modA);
  let r = await list(gA);
  check('the moderator lists alpha', r.status === 200 && r.body.count === 6, show(r));
  const ref = {};
  for (const p of r.body.participants) ref[p.name] = p.ref;
  check('every participant has a reference and none is muted yet', Object.keys(ref).length === 6 && r.body.participants.every((p) => !('mutedUntil' in p)), JSON.stringify(r.body.participants));
  const sendOk = async (who, text) => { await sleep(450); return csend(who.c.id, text); };
  check('before any mute Alice can chat', (await sendOk(alice, 'hello-alice')).body.ok === true, 'send failed');

  console.log('STEP 2: mute');
  r = expect('mute Alice for 3 seconds (spam)', await cmd(gA, 'chat.mute', ref.Alice, { durationSeconds: 3, cause: 'spam' }), 200);
  results['mute response shape'] = JSON.stringify(shapeOf(r.body));
  check('the answer names the operation, an opaque reference, the world, duration, cause and expiry only', r.body.ok === true && r.body.operation === 'chat.mute' && r.body.ref === ref.Alice && r.body.world === 'alpha' && r.body.durationSeconds === 3 && r.body.cause === 'spam' && /^\d{4}-\d\d-\d\dT/.test(r.body.mutedUntil) && Object.keys(r.body).length === 7, JSON.stringify(r.body));
  r = await list(gA);
  check('the roster shows who is muted (Alice only)', r.body.participants.filter((p) => 'mutedUntil' in p).map((p) => p.name).join() === 'Alice', JSON.stringify(r.body.participants.map((p) => [p.name, p.mutedUntil])));
  await sleep(450);
  r = await csend(alice.c.id, 'muted but trying');
  check('a muted visitor\'s chat is refused by the server (polling)', r.status === 200 && r.body.ok === false && r.body.reason === 'muted', show(r));
  results['muted send answer'] = JSON.stringify(shapeOf(r.body));
  results['muted message'] = norm(r.body.message);
  check('...with a templated message, a fixed cause code and a retry hint, and no markup', /muted you in this world \(spam\)/.test(r.body.message) && r.body.cause === 'spam' && r.body.retryAfter >= 1 && !/[<>]/.test(r.body.message), show(r));
  check('...and nothing was added to the chat', !(await csync(carol.c.id)).text.includes('muted but trying'), 'the muted message arrived');
  check('a muted visitor can still look around (presence sync works)', (await psync(alice.p.id)).status === 200, 'sync failed');
  check('...and read chat (chat-sync works)', (await csync(alice.c.id)).status === 200, 'chat-sync failed');
  check('another visitor\'s chat is unaffected', (await sendOk(carol, 'carol-speaks')).body.ok === true, 'carol blocked');
  check('so are visitors in another world of the same domain', (await sendOk(eve, 'eve-speaks')).body.ok === true && (await sendOk(frank, 'frank-speaks')).body.ok === true, 'beta blocked');
  await cleave(alice.c.id);
  const aliceChat2 = await must(cjoin(D1, 'alpha', 'Alice', VA));
  check('a muted visitor reconnecting with the same visit stays muted but can read (history kept)', JSON.stringify(aliceChat2.messages).includes('hello-alice') && (await sendOk({ c: aliceChat2 }, 'again')).body.reason === 'muted', 'reconnect escaped the mute');
  alice.c = aliceChat2;
  r = await rq('POST', '/presence/poll/chat-join', { domain: D1, world: 'alpha', name: 'Newcomer', visit: newVisit() }, { src: fresh() });
  check('a brand-new visit is not muted (accepted: no fingerprinting)', r.status === 200 && (await sendOk({ c: r.body }, 'new-visit')).body.ok === true, show(r));
  await sleep(3000);
  check('the mute expires on its own', (await sendOk(alice, 'back')).body.ok === true, 'still muted');
  check('...and the roster no longer shows it', !(await list(gA)).body.participants.some((p) => 'mutedUntil' in p), 'still listed');

  console.log('STEP 3: unmute');
  expect('mute Alice for ten minutes (default cause)', await cmd(gA, 'chat.mute', ref.Alice), 200);
  check('muted', (await sendOk(alice, 'x')).body.reason === 'muted', 'not muted');
  r = expect('unmute Alice', await cmd(gA, 'chat.unmute', ref.Alice), 200);
  results['unmute response shape'] = JSON.stringify(shapeOf(r.body));
  check('the answer says she was muted', r.body.operation === 'chat.unmute' && r.body.wasMuted === true && r.body.ref === ref.Alice, JSON.stringify(r.body));
  check('after an explicit unmute she can chat again', (await sendOk(alice, 'free')).body.ok === true, 'still muted');
  check('unmuting someone who is not muted is harmless and says so', (await cmd(gA, 'chat.unmute', ref.Alice)).body.wasMuted === false, 'wasMuted');
  expect('muting a presence-only visit that has a visit id works', await cmd(gA, 'chat.mute', ref.Hank, { durationSeconds: 600 }), 200);
  const hankChat = await must(cjoin(D1, 'alpha', 'Hank', VH));
  check('...and applies when that visit later joins chat', (await sendOk({ c: hankChat }, 'hi')).body.reason === 'muted', 'escaped');
  expect('muting a presence-only visit without a visit id: not in chat', await cmd(gA, 'chat.mute', ref.Ivan), 409, 'not-in-chat');
  expect('mute Dan (no visit id: his chat connection)', await cmd(gA, 'chat.mute', ref.Dan, { durationSeconds: 600, cause: 'other' }), 200);
  check('Dan\'s connection is muted', (await sendOk(dan, 'x')).body.reason === 'muted', 'not muted');
  if (presence.dir) {
    // A mute on a session with no visit id is keyed by its chat token; the file must hold a hash of it, never the token.
    const restrictionsFile = path.join(presence.dir, 'presence/lib/atlas-presence-restrictions.json');
    const stored = fs.existsSync(restrictionsFile) ? fs.readFileSync(restrictionsFile, 'utf8') : '';
    check('the PHP restriction file holds Dan\'s mute but not his chat connection token', /"mutes"\s*:\s*\{\s*"/.test(stored) && !stored.includes(dan.c.id), stored.slice(0, 300));
  }
  await cleave(dan.c.id);
  dan.c = await must(cjoin(D1, 'alpha', 'Dan'));
  check('a visitor with no visit id can only be muted for the life of the connection (accepted)', (await sendOk(dan, 'x')).body.ok === true, 'still muted');

  console.log('STEP 4: kick');
  check('before the kick Alice\'s presence token works', (await psync(alice.p.id)).status === 200, 'sync');
  r = expect('kick Alice for 3 seconds (harassment)', await cmd(gA, 'session.kick', ref.Alice, { durationSeconds: 3, cause: 'harassment' }), 200);
  results['kick response shape'] = JSON.stringify(shapeOf(r.body));
  check('the answer reports what was removed and when she may return', r.body.operation === 'session.kick' && r.body.removed.presence === 1 && r.body.removed.chat === 1 && r.body.cause === 'harassment' && r.body.durationSeconds === 3 && /^\d{4}-\d\d-\d\dT/.test(r.body.rejoinAfter), JSON.stringify(r.body));
  r = await list(gA);
  check('Alice is gone from the roster; the others remain', !r.body.participants.some((p) => p.name === 'Alice') && ['Bob', 'Carol', 'Dan', 'Hank', 'Ivan'].every((n) => r.body.participants.some((p) => p.name === n)), JSON.stringify(r.body.participants.map((p) => p.name)));
  r = await psync(alice.p.id);
  check('her presence token now answers 403 "removed" (not 404/rejoin) with the templated message', r.status === 403 && r.body.reason === 'removed' && r.body.cause === 'harassment' && /removed you from this world \(harassment\)/.test(r.body.message) && r.body.retryAfter >= 1 && Number(r.headers['retry-after']) >= 1, show(r));
  results['removed sync answer'] = JSON.stringify(shapeOf(r.body));
  results['removed message'] = norm(r.body.message);
  r = await csync(alice.c.id);
  check('her chat token: 403 removed on sync', r.status === 403 && r.body.reason === 'removed', show(r));
  await sleep(450);
  r = await csend(alice.c.id, 'still here?');
  check('...and on send (no message is accepted)', r.status === 403 && r.body.reason === 'removed' && !(await csync(carol.c.id)).text.includes('still here?'), show(r));
  r = await pjoin(D1, 'alpha', 'Alice', VA);
  check('rejoining presence with the same visit is refused (403 removed, templated message, Retry-After)', r.status === 403 && r.body.reason === 'removed' && /removed you from this world/.test(r.body.message) && Number(r.headers['retry-after']) >= 1, show(r));
  results['rejoin refusal shape'] = JSON.stringify(shapeOf(r.body));
  r = await cjoin(D1, 'alpha', 'Alice', VA);
  check('rejoining chat with the same visit is refused too', r.status === 403 && r.body.reason === 'removed', show(r));
  const hammer = '127.0.0.250';
  let refused = 0;
  for (let i = 0; i < 70; i++) if ((await pjoin(D1, 'alpha', 'Alice', VA, hammer)).status === 403) refused++;
  r = await pjoin(D1, 'alpha', 'Zed', newVisit(), hammer);
  check('70 refused rejoins do not consume the source\'s join budget (an ordinary join from it still works)', refused === 70 && r.status === 200, refused + ' ' + show(r));
  check('Carol and Bob are untouched by the kick', (await psync(carol.p.id)).status === 200 && (await sendOk(carol, 'still-here')).body.ok === true, 'bystander affected');
  check('Eve and Frank (another world, Frank with the same raw visit id) are untouched', (await psync(frank.p.id)).status === 200 && (await sendOk(frank, 'f2')).body.ok === true && (await psync(eve.p.id)).status === 200, 'other world affected');
  r = await pjoin(D1, 'beta', 'Alice', VA);
  check('the same visit id in another world is not blocked (restrictions are per world visit)', r.status === 200, show(r));
  r = await pjoin(D2, 'alpha', 'Alice', VA);
  check('...nor in another domain', r.status === 200, show(r));
  r = await pjoin(D1, 'alpha', 'Newcomer2', newVisit());
  check('a brand-new visit is not blocked (accepted: no fingerprinting)', r.status === 200, show(r));
  check('presence references are not credentials: a roster reference is not a session token', (await psync(ref.Carol)).status === 404 && (await csend(ref.Carol, 'x')).status === 404, 'ref accepted');
  await sleep(3200);
  r = await pjoin(D1, 'alpha', 'Alice', VA);
  check('after the kick expires the same visit can rejoin', r.status === 200, show(r));
  const aliceP2 = r.body;
  r = await cjoin(D1, 'alpha', 'Alice', VA);
  check('...in chat as well, and is not muted (mute was cleared with the unmute)', r.status === 200 && (await sendOk({ c: r.body }, 'rejoined')).body.ok === true, show(r));
  check('history survived the kick', JSON.stringify((await must(cjoin(D1, 'alpha', 'Watcher', newVisit()))).messages).includes('hello-alice'), 'history lost');
  r = await list(gA);
  check('the rejoined visitor is listed again, one entry linking presence and chat', r.body.participants.filter((p) => p.name === 'Alice').length === 1 && r.body.participants.find((p) => p.name === 'Alice').linked, JSON.stringify(r.body.participants));
  await rq('POST', '/presence/poll/leave', { id: aliceP2.id }, { src: nextSrc() });
  check('...leave then rejoin works', (await pjoin(D1, 'alpha', 'Alice', VA)).status === 200, 'rejoin refused');

  console.log('STEP 5: kick without a visit id; kick a visit that is in chat and presence');
  for (const p of (await list(gA)).body.participants) ref[p.name] = p.ref; // Dan reconnected: his reference changed
  r = expect('kick Dan (chat only, no visit id)', await cmd(gA, 'session.kick', ref.Dan, { durationSeconds: 600 }), 200);
  check('his chat session was removed', r.body.removed.presence === 0 && r.body.removed.chat === 1, JSON.stringify(r.body));
  check('his old chat token answers 403 removed', (await csync(dan.c.id)).status === 403, 'not removed');
  check('a visit with no id can rejoin at once (accepted: nothing identifies it)', (await cjoin(D1, 'alpha', 'Dan')).status === 200, 'refused');
  r = expect('kick Ivan (presence only, default duration)', await cmd(gA, 'session.kick', ref.Ivan), 200);
  results['kick default response'] = JSON.stringify(shapeOf(r.body));
  check('...which is five minutes unless the command says otherwise', r.body.durationSeconds === 300 && r.body.removed.presence === 1 && r.body.removed.chat === 0, JSON.stringify(r.body));
  check('Ivan\'s token answers 403 removed', (await psync(ivan.p.id)).status === 403, 'not removed');
  expect('kick Hank (presence and chat, same visit)', await cmd(gA, 'session.kick', ref.Hank, { durationSeconds: 600 }), 200);
  check('Hank cannot rejoin presence or chat', (await pjoin(D1, 'alpha', 'Hank', VH)).status === 403 && (await cjoin(D1, 'alpha', 'Hank', VH)).status === 403, 'rejoined');

  if (bob.ws) {
    console.log('STEP 6 (Node): WebSocket mute and kick');
    const { pws, cws } = bob;
    r = wsOnly(expect('mute Bob (WebSocket) for 3 seconds', await cmd(gA, 'chat.mute', ref.Bob, { durationSeconds: 3, cause: 'abuse' }), 200));
    cws.ws.send(JSON.stringify({ type: 'chat-send', text: 'ws muted' }));
    const err = await cws.next(['chat-error']);
    check('a muted WebSocket sender gets chat-error muted with the templated message', err.type === 'chat-error' && err.reason === 'muted' && /muted you in this world \(abusive behaviour\)/.test(err.message) && err.retryAfter >= 1, JSON.stringify(err));
    await sleep(3200);
    cws.ws.send(JSON.stringify({ type: 'chat-send', text: 'ws unmuted' }));
    const ok = await cws.next((m) => m.type === 'chat-error' || (m.type === 'chat-message' && m.message.text === 'ws unmuted'));
    check('after expiry the WebSocket sender can chat again', ok.type === 'chat-message', JSON.stringify(ok));
    r = wsOnly(expect('kick Bob (WebSocket) for 3 seconds', await cmd(gA, 'session.kick', ref.Bob, { durationSeconds: 3, cause: 'disruption' }), 200));
    check('both of his sessions were removed', r.body.removed.presence === 1 && r.body.removed.chat === 1, JSON.stringify(r.body));
    const rm = await pws.next(['removed'], 3000);
    const crm = await cws.next(['chat-removed'], 3000);
    check('the presence socket is told it was removed, with the templated message', rm.type === 'removed' && rm.cause === 'disruption' && /removed you from this world \(disruption\)/.test(rm.message), JSON.stringify(rm));
    check('the chat socket is told too', crm.type === 'chat-removed' && crm.retryAfter >= 1, JSON.stringify(crm));
    cws.ws.send(JSON.stringify({ type: 'chat-send', text: 'ws after kick' }));
    await sleep(500);
    check('a removed connection cannot send: nothing reaches the chat', !(await csync(carol.c.id)).text.includes('ws after kick'), 'message accepted');
    pws.ws.send(JSON.stringify({ type: 'join', domain: D1, world: 'alpha', name: 'Bob', visit: VB }));
    const den = await pws.next(['join-denied', 'welcome']);
    check('joining again on the same connection is refused (removed)', den.type === 'join-denied' && den.reason === 'removed' && /removed you/.test(den.message), JSON.stringify(den));
    cws.ws.send(JSON.stringify({ type: 'chat-join', domain: D1, world: 'alpha', name: 'Bob', visit: VB }));
    const cden = await cws.next(['chat-error', 'chat-history']);
    check('...and so is chat', cden.type === 'chat-error' && cden.reason === 'removed', JSON.stringify(cden));
    const w2 = await wsConnect(); sockets.push(w2.ws);
    w2.ws.send(JSON.stringify({ type: 'join', domain: D1, world: 'alpha', name: 'Bob', visit: VB }));
    const den2 = await w2.next(['join-denied', 'welcome']);
    check('a new WebSocket with the same visit is refused', den2.type === 'join-denied' && den2.reason === 'removed', JSON.stringify(den2));
    const pj = await pjoin(D1, 'alpha', 'Bob', VB);
    check('...and so is the polling fallback with the same visit (no transport switch escapes it)', pj.status === 403 && pj.body.reason === 'removed', show(pj));
    check('Carol\'s session is untouched', (await psync(carol.p.id)).status === 200, 'carol');
    await sleep(3200);
    const w3 = await wsConnect(); sockets.push(w3.ws);
    w3.ws.send(JSON.stringify({ type: 'join', domain: D1, world: 'alpha', name: 'Bob', visit: VB }));
    const wel = await w3.next(['join-denied', 'welcome']);
    check('after the kick expires the same visit can rejoin over WebSocket', wel.type === 'welcome', JSON.stringify(wel));
  } else {
    console.log('STEP 6: (PHP presence has no WebSocket; Bob used polling above)');
  }

  console.log('STEP 7: who may do what');
  const gBeta = await getGrant(iss1, modBeta, { worlds: ['beta'] });
  expect('a moderator of another world cannot act in alpha', await cmd(gBeta, 'chat.mute', ref.Carol, undefined, { world: 'alpha' }), 403, 'world-denied');
  expect('...and a beta command cannot name an alpha participant (reference unknown in beta)', await cmd(gBeta, 'chat.mute', ref.Carol, undefined, { world: 'beta' }), 404, 'unknown-participant');
  check('Carol is still not muted', (await sendOk(carol, 'c3')).body.ok === true, 'muted');
  const g2 = await getGrant(iss2, mod2);
  expect('another domain\'s moderator cannot name a participant of this domain', await cmd(g2, 'chat.mute', ref.Carol), 404, 'unknown-participant');
  expect('a grant from the other domain\'s issuer is not trusted for this domain\'s grant claim', await cmd(g2, 'chat.mute', ref.Carol, undefined, { req: { domain: D1 } }), 403, 'wrong-audience');
  const mallRef = (await list(g2)).body.participants.find((p) => p.name === 'Mallory').ref;
  expect('this domain\'s moderator cannot reach the other domain\'s participant', await cmd(gA, 'chat.mute', mallRef), 404, 'unknown-participant');
  check('Mallory in the other domain is unaffected', (await sendOk(mallory, 'm')).body.ok === true, 'muted');
  const gMute = await getGrant(iss1, modMute, { operations: ['roster.view', 'chat.mute', 'chat.unmute'] });
  expect('a mute-only moderator can mute', await cmd(gMute, 'chat.mute', ref.Carol, { durationSeconds: 1 }), 200);
  expect('...but a grant without session.kick cannot kick', await cmd(gMute, 'session.kick', ref.Carol), 403, 'operation-denied');
  check('Carol was not kicked', (await psync(carol.p.id)).status === 200, 'kicked');
  const gRO = await getGrant(iss1, modA, { operations: ['roster.view'] });
  expect('a read-only grant cannot mute', await cmd(gRO, 'chat.mute', ref.Carol), 403, 'operation-denied');
  expect('a read-only grant cannot unmute', await cmd(gRO, 'chat.unmute', ref.Carol), 403, 'operation-denied');
  expect('session.timeout is not implemented here', await cmd(await getGrant(iss1, admin, { operations: ['session.timeout'] }), 'session.timeout', ref.Carol), 403, 'operation-denied');
  expect('roster.view with a target is refused', await rq('POST', ROSTER, await requestBody(gA, 'roster.view', ref.Carol), { src: nextSrc() }), 400, 'bad-request');
  expect('roster.view through the command endpoint is refused', await cmd(gA, 'roster.view', ''), 403, 'operation-denied');
  expect('a command through the roster endpoint is refused', await rq('POST', ROSTER, await requestBody(gA, 'chat.mute', ref.Carol), { src: nextSrc() }), 403, 'operation-denied');
  expect('a visitor with no grant', await rq('POST', COMMAND, { request: (await requestBody(gA, 'chat.mute', ref.Carol)).request }, { src: nextSrc() }), 400, 'bad-request');
  const forged = JSON.parse(JSON.stringify(gA.grant)); forged.payload.worlds = '*';
  expect('a grant edited to cover every world', await cmd(gA, 'chat.mute', ref.Carol, undefined, { grant: forged }), 401, 'bad-signature');
  expect('a request signed by another key', await cmd(gA, 'chat.mute', ref.Carol, undefined, { signWith: await M.generatePopKey() }), 401, 'bad-pop');
  const edited = await requestBody(gA, 'chat.mute', ref.Carol, { durationSeconds: 5 }); edited.request.payload.params.durationSeconds = 86400;
  expect('params changed after signing', await cmd(gA, null, null, null, { body: edited }), 401, 'bad-pop');
  const noParamsSigned = await requestBody(gA, 'chat.mute', ref.Carol); noParamsSigned.request.payload.params = { durationSeconds: 86400 };
  expect('params added after signing', await cmd(gA, null, null, null, { body: noParamsSigned }), 401, 'bad-pop');
  expect('a command for a stale timestamp', await cmd(gA, 'chat.mute', ref.Carol, undefined, { req: { issuedAt: new Date(Date.now() - 5 * 60e3).toISOString() } }), 401, 'stale-request');
  const gShort = await getGrant(iss1, modA, { ttlSeconds: 1 });
  await sleep(1500);
  expect('an expired grant', await cmd(gShort, 'chat.mute', ref.Carol), 401, 'expired');

  console.log('STEP 8: replay and argument validation');
  const body = await requestBody(gA, 'chat.mute', ref.Carol, { durationSeconds: 1 });
  expect('first use of a request', await cmd(gA, null, null, null, { body }), 200);
  expect('the identical request again', await cmd(gA, null, null, null, { body }), 401, 'replay');
  const nonce = b64(16);
  expect('a new request reusing that nonce', await cmd(gA, 'chat.mute', ref.Carol, { durationSeconds: 1 }, { req: { nonce } }), 200);
  expect('...is a replay the second time', await cmd(gA, 'chat.mute', ref.Carol, { durationSeconds: 1 }, { req: { nonce } }), 401, 'replay');
  const bad = [
    ['unknown cause', 'chat.mute', { cause: 'because i said so' }],
    ['markup as a cause', 'chat.mute', { cause: '<b>x</b>' }],
    ['duration of zero', 'chat.mute', { durationSeconds: 0 }],
    ['negative duration', 'session.kick', { durationSeconds: -5 }],
    ['fractional duration', 'chat.mute', { durationSeconds: 1.5 }],
    ['duration as a string', 'chat.mute', { durationSeconds: '5' }],
    ['mute longer than the maximum', 'chat.mute', { durationSeconds: 86401 }],
    ['kick longer than the maximum', 'session.kick', { durationSeconds: 3601 }],
    ['unknown params member', 'chat.mute', { reason: 'free text' }],
    ['params on an unmute', 'chat.unmute', { durationSeconds: 5 }],
    ['params that are not an object', 'chat.mute', 5]
  ];
  r = await cmd(gA, 'chat.mute', ref.Carol, {});
  check('invalid argument: empty params object is refused (400; a PHP service reads {} as [] and refuses the signature, 401)', r.status === 400 || r.status === 401, show(r));
  for (const [name, op, params] of bad) expect('invalid argument: ' + name, await cmd(gA, op, ref.Carol, params), 400, 'bad-request');
  expect('target that is not a reference (a connection token)', await cmd(gA, 'chat.mute', carol.p.id), 400, 'bad-request');
  expect('target that is empty', await cmd(gA, 'chat.mute', ''), 400, 'bad-request');
  expect('well-formed but unknown reference', await cmd(gA, 'chat.mute', 'A'.repeat(22)), 404, 'unknown-participant');
  expect('a request with an unknown top-level member', await cmd(gA, 'chat.mute', ref.Carol, undefined, { req: { reason: 'x' } }), 400, 'bad-request');
  await sleep(1200); // the short mutes issued above (one second) have expired
  check('none of the refused commands changed anything', (await sendOk(carol, 'c4')).body.ok === true && (await psync(carol.p.id)).status === 200, 'state changed');

  console.log('STEP 9: authority is checked at command time');
  const gRev = await getGrant(iss1, modRev);
  const gShrink = await getGrant(iss1, modShrink);
  expect('a moderator\'s grant works while they are listed', await cmd(gRev, 'chat.unmute', ref.Carol), 200);
  setRoster(iss1, [{ identity: admin, role: 'admin' }, { identity: modA, role: 'moderator', worlds: ['alpha'], operations: ALL_OPS }, { identity: modRev, role: 'moderator', worlds: ['alpha'], operations: ALL_OPS, revoked: true }, { identity: modShrink, role: 'moderator', worlds: ['alpha'], operations: ['roster.view'] }, { identity: modRate, role: 'moderator', worlds: ['alpha'], operations: ALL_OPS }]);
  let t0 = Date.now();
  const revoked = await until(async () => { const x = await cmd(gRev, 'chat.unmute', ref.Carol); return x.status === 403 && x.body.code === 'moderator-inactive' ? x : null; }, (STATUS_TTL_S + REFRESH_S + 3) * 1000);
  check('a revoked moderator is refused within the status window (moderator-inactive)', !!revoked, 'still accepted after ' + (Date.now() - t0) + ' ms');
  results['revoked moderator'] = revoked ? '403 moderator-inactive' : 'accepted';
  check('...and the grant is useless for kick as well', (await cmd(gRev, 'session.kick', ref.Carol)).status === 403, 'kick accepted');
  const shrunk = await until(async () => { const x = await cmd(gShrink, 'chat.unmute', ref.Carol); return x.status === 403 && x.body.code === 'operation-denied' ? x : null; }, (STATUS_TTL_S + REFRESH_S + 3) * 1000);
  check('a grant whose moderator lost the operation is refused within the status window (operation-denied)', !!shrunk, 'still accepted');
  results['shrunk moderator'] = shrunk ? '403 operation-denied' : 'accepted';
  check('Carol was not kicked', (await psync(carol.p.id)).status === 200, 'kicked');
  setConfig({ ...baseConfig(), revokedGrants: [gA.grant.payload.grantId] });
  expect('emergency: a single grant revoked in the presence configuration (next request)', await cmd(gA, 'chat.mute', ref.Carol), 403, 'revoked');
  setConfig({ ...baseConfig(), revokedModerators: [gA.grant.payload.moderatorRef] });
  expect('emergency: the moderator revoked in the presence configuration', await cmd(gA, 'session.kick', ref.Carol), 403, 'revoked');
  setConfig({ ...baseConfig(), enabled: false });
  expect('emergency: moderation switched off', await cmd(gA, 'chat.mute', ref.Carol), 503, 'moderation-not-configured');
  setConfig(baseConfig());
  check('after all of that Carol is still unrestricted', (await sendOk(carol, 'c5')).body.ok === true && (await psync(carol.p.id)).status === 200, 'carol affected');

  console.log('STEP 10: command rate limit');
  await restartPresence(presenceKind, { MODERATION_COMMANDS_PER_MIN: '3', MODERATION_COMMAND_WINDOW_MS: '4000' });
  await must(cjoin(D1, 'alpha', 'RateTarget', newVisit()));
  const gR = await getGrant(iss1, modRate);
  const ref2 = (await list(gR)).body.participants.find((p) => p.name === 'RateTarget');
  const ok3 = [];
  for (let i = 0; i < 3; i++) ok3.push((await cmd(gR, 'chat.unmute', ref2.ref)).status);
  check('three commands within the window are accepted', ok3.join() === '200,200,200', ok3.join());
  const limitedBody = await requestBody(gR, 'chat.unmute', ref2.ref);
  r = await cmd(gR, null, null, null, { body: limitedBody });
  check('the fourth is refused with 429 rate-limited, Retry-After and no side effects', r.status === 429 && r.body.code === 'rate-limited' && r.body.retryAfter >= 1 && Number(r.headers['retry-after']) >= 1, show(r));
  results['command rate limit'] = r.status + ' ' + (r.body && r.body.code);
  check('a roster listing is not counted as a command', (await list(gR)).status === 200, 'list limited');
  await sleep(4300);
  expect('the identical request succeeds after the window (a limited request is not a spent nonce)', await cmd(gR, null, null, null, { body: limitedBody }), 200);
  check('another moderator is not limited by this one', (await cmd(await getGrant(iss1, modA), 'chat.unmute', ref2.ref)).status === 200, 'shared limit');

  console.log('STEP 11: restriction storage is bounded and private');
  await restartPresence(presenceKind, { MODERATION_COMMANDS_PER_MIN: '200', MODERATION_MAX_RESTRICTIONS: '3', MODERATION_MAX_RESTRICTIONS_PER_WORLD: '3' });
  if (presence.dir) { try { fs.unlinkSync(path.join(presence.dir, 'presence/lib/atlas-presence-restrictions.json')); } catch (_) {} } // a fresh store, as after a restart
  const gB = await getGrant(iss1, modA);
  const batch = [];
  for (let i = 0; i < 5; i++) { const v = newVisit(); const name = 'Bulk' + i; await must(cjoin(D1, 'alpha', name, v)); batch.push(name); }
  const lst = (await list(gB)).body.participants.filter((p) => /^Bulk/.test(p.name));
  const codes = [];
  for (const p of lst) codes.push((await cmd(gB, 'chat.mute', p.ref, { durationSeconds: 600 })).status);
  check('at most three restrictions are stored; the rest are refused with 503 restrictions-full', codes.filter((c) => c === 200).length === 3 && codes.filter((c) => c === 503).length === 2, codes.join());
  const again = await cmd(gB, 'chat.mute', lst[0].ref, { durationSeconds: 900 });
  check('re-muting someone already muted replaces their entry even when the store is full', again.status === 200, show(again));
  const full = (await cmd(gB, 'chat.mute', lst[4].ref)).body;
  results['restrictions full'] = full && full.code;

  if (presence.dir) {
    const file = path.join(presence.dir, 'presence/lib/atlas-presence-restrictions.json');
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    check('the PHP restriction file exists and holds only hashes, causes and times', text.length > 0 && !scan(text, [...visitIds, ...joinedTokens, ...identities.map((i) => i.publicKey)]).length && !/127\.0\.0\.|::1/.test(text), text.slice(0, 200));
    check('...and it is not under a web-reachable path', fs.existsSync(path.join(presence.dir, 'presence/lib/.htaccess')), 'no deny rule');
  }

  const everything = seen.join('\n');
  check('no moderation response contains a wallet key, connection token, raw visit id or address', scan(everything, [...visitIds, ...joinedTokens, ...identities.map((i) => i.publicKey)]).length === 0 && !/127\.0\.0\.|::1/.test(everything), scan(everything, [...visitIds, ...joinedTokens]).join());

  for (const s of sockets.splice(0)) { try { s.close(); } catch (_) {} }
  await killAll();
  return { ...results };
}

(async () => {
  let all = [];
  try {
    const combos = MATRIX ? [['node', 'node'], ['node', 'php'], ['php', 'node'], ['php', 'php']] : [[ARGS[0] === 'php' ? 'php' : 'node', ARGS[1] || (ARGS[0] === 'php' ? 'php' : 'node')]];
    for (const [p, i] of combos) {
      for (const k of Object.keys(results)) delete results[k];
      seen.length = 0; joinedTokens.length = 0; visitIds.length = 0; identities.length = 0;
      all.push(await scenario(p, i));
      await sleep(500);
    }
    if (all.length > 1) {
      console.log('\n===== compatibility across pairings =====');
      const ref0 = all[0];
      for (const other of all.slice(1)) {
        const diffs = Object.keys(ref0).filter((k) => k !== '__label' && ref0[k] !== other[k]).map((k) => k + ': "' + ref0[k] + '" vs "' + other[k] + '"');
        check('identical answers and response shape: ' + ref0.__label + ' vs ' + other.__label, diffs.length === 0, diffs.join(' | '));
      }
    }
  } catch (err) {
    console.error('FAILURE:', err);
    failures++;
  } finally {
    await killAll();
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL PRESENCE MODERATION ACTION CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
