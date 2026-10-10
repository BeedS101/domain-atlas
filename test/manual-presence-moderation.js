// Security regression test for presence-side moderation authorization and the
// read-only anonymous session list (roster.view), against the Node presence
// server and the PHP presence bundle, paired with either issuer:
//
//   node test/manual-presence-moderation.js node            presence Node, issuer Node
//   node test/manual-presence-moderation.js php             presence PHP,  issuer PHP
//   node test/manual-presence-moderation.js node php        presence Node, issuer PHP
//   node test/manual-presence-moderation.js php node        presence PHP,  issuer Node
//   node test/manual-presence-moderation.js matrix          all four pairings, then
//                                                           compares every answer
//
// Each run starts two issuers (two domains), a presence service, and a small
// proxy in front of the first issuer's status endpoint so the failure modes of
// the status fetch can be provoked. Timing is scaled down (status lifetime 5 s,
// refresh 2 s) so the revocation windows can be measured; the defaults are 60 s
// and 15 s and the bounds scale the same way.
//
// Covered: valid scoped listing; visitors without a grant; forged issuer
// signature and unpinned issuer; missing/foreign proof of possession; wrong
// domain, world, audience, operation; expired grant; replay; revoked moderator
// (measured window); removed and rotated issuer keys; local emergency
// revocation; fail-closed behaviour for every kind of bad or missing status
// statement; another domain's sessions; moderation references used as
// connection credentials; the privacy contents of every response; the visit-id
// association and its untrusted-client behaviour; per-source failure throttle.

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
const PORTS = { issuer1: 9331, issuer2: 9332, presence: 9333, proxy: 9334 };
const AUD = 'https://presence.test.example';
const AUD2 = 'https://other-presence.test.example';
const D1 = 'localhost:' + PORTS.issuer1;
const D2 = 'localhost:' + PORTS.issuer2;
const GRANT = '/atlas/admin/moderation/grant';
const ROSTER = '/presence/moderation/roster';
const STATUS_TTL_S = 5, REFRESH_S = 2;

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

async function startIssuer(kind, port, audiences) {
  const env = { ATLAS_ADMIN_FAIL_LIMIT: '1000', ATLAS_ADMIN_NONCE_PER_CLIENT_PER_MIN: '1000', ATLAS_ADMIN_NONCE_CAP: '1000', ATLAS_MODERATION_STATUS_TTL_S: String(STATUS_TTL_S), ATLAS_MODERATION_STATUS_PER_CLIENT_PER_MIN: '10000', ATLAS_MODERATION_MAX_LIVE_GRANTS: '500' };
  const domain = 'localhost:' + port;
  let issuer;
  if (kind === 'node') {
    const docroot = H.tmpDir('atlas-pm-docroot-');
    fs.cpSync(path.join(H.ROOT, 'demo-domain-a'), docroot, { recursive: true });
    const stateDir = H.tmpDir('atlas-pm-state-');
    issuer = await H.startNodeIssuer({ port, stateDir, docrootDir: docroot, env: { ...env, ATLAS_MODERATION_AUDIENCES: audiences.join(',') } });
    issuer.files = (name) => path.join(stateDir, name);
    issuer.restart = async () => {
      const again = await H.startNodeIssuer({ port, stateDir, docrootDir: docroot, env: { ...env, ATLAS_MODERATION_AUDIENCES: audiences.join(',') } });
      issuer.proc = again.proc; issuer.exited = again.exited; track(again.proc);
    };
  } else {
    const bundleDir = H.preparePhpBundle();
    fs.writeFileSync(path.join(bundleDir, 'lib', 'atlas-moderation-config.json'), JSON.stringify({ domain, audiences }));
    const phpEnv = { PHP_CLI_SERVER_WORKERS: '4', ...env };
    issuer = await H.startPhpIssuer({ port, bundleDir, env: phpEnv });
    issuer.files = (name) => path.join(bundleDir, 'lib', name);
    issuer.restart = async () => {
      const again = await H.startPhpIssuer({ port, bundleDir, env: phpEnv });
      issuer.proc = again.proc; issuer.exited = again.exited; track(again.proc);
    };
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

let presence = null; // { kind, port, dir?, proc }
let cfgFile = null;
async function startPresence(kind, extraEnv) {
  const env = { ...process.env, PRESENCE_MODERATION_CONFIG: cfgFile, POLL_TIMEOUT_MS: '600000', POLL_SWEEP_INTERVAL_MS: '1000', MODERATION_STATUS_REFRESH_S: String(REFRESH_S), MODERATION_FETCH_TIMEOUT_MS: '1000', ...(extraEnv || {}) };
  let proc, dir = null;
  if (kind === 'php') {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pm-presence-'));
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

// ---------- HTTP ----------

let srcCounter = 20;
const nextSrc = () => '127.0.0.' + (20 + (srcCounter++ % 200));
const seen = []; // every roster response body, scanned for leaks at the end
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
        if (p === ROSTER) seen.push(text);
        resolve({ status: res.statusCode, body: json, text, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const show = (r) => JSON.stringify({ status: r.status, body: r.body && (r.body.code ? { code: r.body.code } : r.body) });
const results = {}; // name -> "status code", compared between pairings
function expect(name, r, status, code) {
  const ok = r.status === status && (code === undefined || (r.body && r.body.code === code));
  results[name] = r.status + ' ' + (r.body && r.body.code ? r.body.code : '');
  check(name + ': ' + status + (code ? ' ' + code : ''), ok, show(r));
  return r;
}

// ---------- grants and requests ----------

const b64 = (n) => Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString('base64url');
async function getGrant(issuer, who, o) {
  o = o || {};
  const pop = o.pop || (await M.generatePopKey());
  const payload = { audience: o.audience || AUD, worlds: o.worlds || ['alpha'], operations: o.operations || ['roster.view'], popPublicKey: pop.publicKey };
  if (o.ttlSeconds) payload.ttlSeconds = o.ttlSeconds;
  const p = JSON.parse(JSON.stringify(withAdminAuth(payload, issuer.base, GRANT)));
  const r = await H.postJson(issuer.base, GRANT, { payload: p, proof: await H.signWithSelf(who, p) });
  if (r.status !== 200) throw new Error('grant refused: ' + JSON.stringify(r.body));
  return { grant: r.body.grant, pop, issuer };
}
async function requestBody(g, o) {
  o = o || {};
  const req = { type: 'atlas.moderation-request', version: 1, grantId: g.grant.payload.grantId, audience: g.grant.payload.audience, domain: g.grant.payload.domain, world: 'alpha', operation: 'roster.view', target: '', issuedAt: new Date().toISOString(), nonce: b64(16), ...(o.req || {}) };
  const env = await M.signRequest((o.signWith || g.pop).privateKey, req);
  if (o.noSignature) delete env.signature;
  return { grant: o.grant || g.grant, request: env };
}
async function roster(g, o) {
  o = o || {};
  return rq('POST', ROSTER, o.body || await requestBody(g, o), { src: o.src || nextSrc() });
}

// ---------- participants ----------

const identities = [];
async function ident() { const i = await H.genIdentity(); identities.push(i); return i; }
const joinedTokens = [];
const visitIds = [];
let nextIp = 100;
async function pjoin(domain, world, name, visit, src) {
  const body = { domain, world, name };
  if (visit !== undefined) body.visit = visit;
  const r = await rq('POST', '/presence/poll/join', body, { src: src || '127.0.0.' + (nextIp++) });
  if (r.status !== 200) throw new Error('join failed ' + r.text);
  joinedTokens.push(r.body.id);
  return r.body;
}
async function cjoin(domain, world, name, visit, src) {
  const body = { domain, world, name };
  if (visit !== undefined) body.visit = visit;
  const r = await rq('POST', '/presence/poll/chat-join', body, { src: src || '127.0.0.' + (nextIp++) });
  if (r.status !== 200) throw new Error('chat-join failed ' + r.text);
  joinedTokens.push(r.body.id);
  return r.body;
}
function wsConnect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORTS.presence + '/presence');
    const queue = []; let waiter = null;
    ws.addEventListener('message', (ev) => { queue.push(JSON.parse(ev.data)); if (waiter) { const w = waiter; waiter = null; w(); } });
    ws.addEventListener('open', () => resolve({ ws, next: (types) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('ws timeout')), 5000);
      const take = () => { while (queue.length) { const m = queue.shift(); if (!types || types.includes(m.type)) { clearTimeout(t); return res(m); } } waiter = () => take(); };
      take();
    }) }));
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
}
const newVisit = () => { const v = b64(16); visitIds.push(v); return v; }; // what the wallet generates
const sockets = [];

// ---------- the status proxy ----------

let proxyMode = 'pass';
let frozen = null;
let proxyServer = null;
function startProxy(upstreamBase) {
  proxyServer = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const aud = u.searchParams.get('audience');
    const upstream = (a) => fetch(upstreamBase + '/atlas/moderation/status?audience=' + encodeURIComponent(a)).then(async (r) => ({ status: r.status, text: await r.text() }));
    try {
      if (proxyMode === 'redirect') { res.writeHead(302, { Location: upstreamBase + '/atlas/moderation/status?audience=' + encodeURIComponent(aud) }); return res.end(); }
      if (proxyMode === 'garbage') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"payload":1}'); }
      if (proxyMode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>maintenance</html>'); }
      if (proxyMode === 'big') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"pad":"' + 'a'.repeat(300 * 1024) + '"}'); }
      if (proxyMode === 'error') { res.writeHead(500); return res.end('boom'); }
      if (proxyMode === 'down') { req.socket.destroy(); return; }
      if (proxyMode === 'slow') { await sleep(4000); res.writeHead(200); return res.end('{}'); }
      if (proxyMode === 'wrongAudience') { const r = await upstream(AUD2); res.writeHead(r.status, { 'Content-Type': 'application/json' }); return res.end(r.text); }
      if (proxyMode === 'frozen') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(frozen); }
      const r = await upstream(aud);
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      return res.end(r.text);
    } catch (_) { try { res.writeHead(502); res.end(); } catch (__) {} }
  });
  return new Promise((r) => proxyServer.listen(PORTS.proxy, '127.0.0.1', r));
}

// ---------- config ----------

let key1 = null, key2 = null;
const PROXY_URL = 'http://127.0.0.1:' + PORTS.proxy + '/atlas/moderation/status';
const baseConfig = () => ({
  enabled: true, audience: AUD,
  domains: {
    [D1]: { issuerKeys: [key1], statusUrl: PROXY_URL },
    [D2]: { issuerKeys: [key2], statusUrl: 'http://localhost:' + PORTS.issuer2 + '/atlas/moderation/status' }
  },
  revokedModerators: [], revokedGrants: []
});
function setConfig(cfg) { fs.writeFileSync(cfgFile, typeof cfg === 'string' ? cfg : JSON.stringify(cfg)); }
const scan = (text, needles) => needles.filter((n) => n && text.includes(n));
const shapeOf = (x) => Array.isArray(x) ? x.map(shapeOf) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, shapeOf(x[k])])) : x === null ? 'null' : typeof x;
const pause = async (s) => { await sleep(s * 1000); };

// ---------- the scenario ----------

async function scenario(presenceKind, issuerKind) {
  const label = presenceKind + ' presence / ' + issuerKind + ' issuer';
  console.log('\n===== ' + label + ' =====');
  results.__label = label;
  cfgFile = path.join(H.tmpDir('atlas-pm-cfg-'), 'moderation-config.json');
  const iss1 = await startIssuer(issuerKind, PORTS.issuer1, [AUD, AUD2]);
  const iss2 = await startIssuer(issuerKind, PORTS.issuer2, [AUD]);
  await startProxy(iss1.base);

  const admin = await ident(), modA = await ident(), modOps = await ident(), modRev = await ident(), modB = await ident(), mod2 = await ident(), visitor = await ident();
  const modLate = await ident();
  setRoster(iss1, [
    { identity: admin, role: 'admin' },
    { identity: modA, role: 'moderator', worlds: ['alpha', 'β δ'], operations: ['roster.view', 'chat.mute'] },
    { identity: modOps, role: 'moderator', operations: ['chat.mute'] },
    { identity: modRev, role: 'moderator', worlds: ['alpha'], operations: ['roster.view'] },
    { identity: modB, role: 'moderator', worlds: ['alpha', 'beta'], operations: ['roster.view'] }
  ]);
  setRoster(iss2, [{ identity: mod2, role: 'moderator' }]);
  key1 = await issuerKeyOf(iss1); key2 = await issuerKeyOf(iss2);
  const ref = (domain, who) => M.moderatorRef(domain, who.publicKey);

  console.log('STEP 1: fail closed while moderation is not configured');
  await startPresence(presenceKind);
  const pre = await getGrant(iss1, modA); // issuer-side grant exists; presence has no config yet
  expect('no config file', await roster(pre), 503, 'moderation-not-configured');
  setConfig('{ not json');
  expect('unparseable config', await roster(pre), 503, 'moderation-not-configured');
  setConfig({ ...baseConfig(), enabled: false });
  expect('config with enabled:false', await roster(pre), 503, 'moderation-not-configured');
  setConfig({ ...baseConfig(), domains: { [D1]: { issuerKeys: [key1.slice(0, 80)], statusUrl: PROXY_URL } } });
  expect('config whose only domain entry has a malformed pinned key (entry dropped)', await roster(pre), 403, 'domain-not-configured');
  setConfig({ ...baseConfig(), domains: { [D1]: { issuerKeys: [key1], statusUrl: 'http://evil.example/status' } } });
  expect('config whose only domain entry has a plain-http non-loopback status URL (entry dropped)', await roster(pre), 403, 'domain-not-configured');
  setConfig({ ...baseConfig(), audience: 'presence.test.example' });
  expect('config with an audience that is not an origin', await roster(pre), 503, 'moderation-not-configured');
  setConfig(baseConfig());

  console.log('STEP 2: sessions to list');
  const VA = newVisit(), VB = newVisit(), VE = newVisit(), VG = newVisit(), VZ = newVisit(), VM = newVisit(), VF = newVisit();
  const alice = { p: await pjoin(D1, 'alpha', 'Alice', VA), c: await cjoin(D1, 'alpha', 'Alice', VA) };
  let bob;
  if (presenceKind === 'node') { // Bob joins over WebSocket, the others over polling
    const a = await wsConnect(), c = await wsConnect(); sockets.push(a.ws, c.ws);
    a.ws.send(JSON.stringify({ type: 'join', domain: D1, world: 'alpha', name: 'Bob', visit: VB }));
    const w = await a.next(['welcome', 'join-denied']);
    c.ws.send(JSON.stringify({ type: 'chat-join', domain: D1, world: 'alpha', name: 'Bobby', visit: VB }));
    const h = await c.next(['chat-history', 'chat-error']);
    bob = { avatarId: w.id, senderId: h.senderId };
  } else {
    const p = await pjoin(D1, 'alpha', 'Bob', VB), c = await cjoin(D1, 'alpha', 'Bobby', VB);
    bob = { avatarId: p.publicId, senderId: c.senderId };
  }
  const carol = { p: await pjoin(D1, 'alpha', 'Carol') }; // an old client: no visit id
  const dave = { p: await pjoin(D1, 'alpha', 'Dave', 'short'), c: await cjoin(D1, 'alpha', 'Dave', 'bad id!') }; // invalid ids are ignored
  const gina = { p1: await pjoin(D1, 'alpha', 'Gina', VG), p2: await pjoin(D1, 'alpha', 'Gina', VG), c: await cjoin(D1, 'alpha', 'Gina', VG) }; // one id reused
  const erin = { p: await pjoin(D1, 'beta', 'Erin', VE), c: await cjoin(D1, 'beta', 'Erin', VE) };
  const frank = { p: await pjoin(D1, 'beta', 'Frank', VA), c: await cjoin(D1, 'beta', 'Frank', VA) }; // Alice's visit id, other world
  const zed = { p: await pjoin(D1, 'β δ', 'Zoë 日本', VZ), c: await cjoin(D1, 'β δ', 'Zoë 日本', VZ) };
  const mallory = { p: await pjoin(D2, 'alpha', 'Mallory', VM), c: await cjoin(D2, 'alpha', 'Mallory', VM) };

  console.log('STEP 3: a scoped moderator lists exactly their domain and world');
  const gA = await getGrant(iss1, modA, { worlds: ['alpha', 'β δ'], operations: ['roster.view', 'chat.mute'], ttlSeconds: 300 });
  let r = expect('valid scoped listing', await roster(gA), 200);
  const doc = r.body;
  check('response fields are exactly the documented set', Object.keys(doc).sort().join() === 'count,domain,generatedAt,participants,world', Object.keys(doc).join());
  check('domain and world echo the authorized scope', doc.domain === D1 && doc.world === 'alpha', JSON.stringify([doc.domain, doc.world]));
  check('seven alpha entries: Alice, Bob, Carol, Dave x2, Gina x2', doc.count === 7 && doc.participants.length === 7, 'count ' + doc.count);
  const byName = (n) => doc.participants.filter((p) => p.name === n);
  const one = (n) => byName(n)[0];
  check('Alice: presence and chat associated into one entry', byName('Alice').length === 1 && one('Alice').linked && one('Alice').presence.avatarId === alice.p.publicId && one('Alice').chat.senderId === alice.c.senderId, JSON.stringify(byName('Alice')));
  check('Bob: associated (Node: over WebSocket) and the differing chat name is shown', byName('Bob').length === 1 && one('Bob').linked && one('Bob').presence.avatarId === bob.avatarId && one('Bob').chat.senderId === bob.senderId && one('Bob').chatName === 'Bobby', JSON.stringify(byName('Bob')));
  check('Alice has no chatName when it is the same', !('chatName' in one('Alice')), JSON.stringify(one('Alice')));
  check('Carol (no visit id, an old client): listed as presence only', byName('Carol').length === 1 && !one('Carol').linked && one('Carol').presence.joined && !one('Carol').chat.joined && one('Carol').chat.senderId === null, JSON.stringify(byName('Carol')));
  check('Dave (invalid visit ids ignored): two unlinked entries', byName('Dave').length === 2 && byName('Dave').every((p) => !p.linked) && byName('Dave').some((p) => p.presence.joined) && byName('Dave').some((p) => p.chat.joined), JSON.stringify(byName('Dave')));
  check('Gina (one visit id reused for two presence sessions): one linked, one presence-only', byName('Gina').length === 2 && byName('Gina').filter((p) => p.linked).length === 1, JSON.stringify(byName('Gina')));
  check('other worlds and the other domain are absent', !doc.participants.some((p) => ['Erin', 'Frank', 'Zoë 日本', 'Mallory'].includes(p.name)), JSON.stringify(doc.participants.map((p) => p.name)));
  check('every entry names its world, join time and age', doc.participants.every((p) => p.world === 'alpha' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(p.joinedAt) && Number.isInteger(p.ageSeconds) && p.ageSeconds >= 0), JSON.stringify(doc.participants[0]));
  check('entry fields are exactly the documented set', doc.participants.every((p) => Object.keys(p).every((k) => ['ref', 'name', 'chatName', 'world', 'joinedAt', 'ageSeconds', 'presence', 'chat', 'linked'].includes(k))), JSON.stringify(Object.keys(doc.participants[0])));
  check('references are 22-character opaque strings, unique', doc.participants.every((p) => /^[A-Za-z0-9_-]{22}$/.test(p.ref)) && new Set(doc.participants.map((p) => p.ref)).size === 7, JSON.stringify(doc.participants.map((p) => p.ref)));
  const refs1 = doc.participants.map((p) => p.ref).sort().join();
  r = await roster(gA);
  check('references are stable between listings', r.body.participants.map((p) => p.ref).sort().join() === refs1, 'changed');
  check('...and the listing carries no-store caching', /no-store/.test(r.headers['cache-control'] || ''), String(r.headers['cache-control']));
  results.__shape = JSON.stringify(shapeOf(doc));
  const sharedVisit = (await roster(gA, { req: { world: 'alpha' } })).body.participants.find((p) => p.name === 'Alice');
  const rBeta = await roster(await getGrant(iss1, modB, { worlds: ['alpha', 'beta'] }), { req: { world: 'beta' } });
  expect('moderator scoped to alpha+beta lists beta', rBeta, 200);
  const frankBeta = rBeta.body.participants.find((p) => p.name === 'Frank');
  check('the same visit id in another world is not associated with alpha (Frank is separate from Alice)', frankBeta && frankBeta.ref !== sharedVisit.ref && rBeta.body.participants.length === 2 && rBeta.body.participants.every((p) => p.linked), JSON.stringify(rBeta.body.participants));
  r = await roster(gA, { req: { world: 'β δ' } });
  check('a free-form Unicode world id lists its sessions', r.status === 200 && r.body.count === 1 && r.body.participants[0].name === 'Zoë 日本' && r.body.world === 'β δ', show(r));
  r = await roster(gA, { req: { world: 'alpha' } });
  results['listing, second call'] = r.status + '';

  console.log('STEP 4: callers without a valid grant');
  expect('empty body', await rq('POST', ROSTER, '{}', { src: nextSrc() }), 400, 'bad-request');
  expect('not JSON', await rq('POST', ROSTER, 'hello', { src: nextSrc() }), 400, 'bad-request');
  expect('wrong shape', await rq('POST', ROSTER, { grant: 1, request: 2 }, { src: nextSrc() }), 400, 'bad-request');
  expect('request without grant', await rq('POST', ROSTER, { request: (await requestBody(gA)).request }, { src: nextSrc() }), 400, 'bad-request');
  expect('grant without request', await rq('POST', ROSTER, { grant: gA.grant }, { src: nextSrc() }), 400, 'bad-request');
  r = await rq('GET', ROSTER, undefined, { src: nextSrc() });
  check('GET returns no roster (405, or the server\'s plain banner)', r.status === 405 || (r.status === 200 && !r.body && !/participants/.test(r.text)), r.status + ' ' + r.text.slice(0, 60));
  const attackerKey = await M.generatePopKey();
  const selfGrant = JSON.parse(JSON.stringify(gA.grant));
  selfGrant.payload.worlds = '*';
  expect('a visitor edits the worlds of a real grant', await roster(gA, { grant: selfGrant, body: { grant: selfGrant, request: (await requestBody(gA)).request } }), 401, 'bad-signature');
  const visitorPop = await M.generatePopKey();
  const selfIssued = { payload: { ...gA.grant.payload, cnf: { alg: 'ES256', publicKey: visitorPop.publicKey }, worlds: '*', operations: M.OPERATIONS, moderatorRef: M.moderatorRef(D1, visitor.publicKey) }, proof: { signerRole: 'raw-ecdsa', publicKey: visitor.publicKey, signature: 'A'.repeat(86) } };
  expect('a visitor presents a grant "signed" by their own key', await roster(gA, { body: { grant: selfIssued, request: (await requestBody({ ...gA, grant: selfIssued, pop: visitorPop })).request } }), 401, 'untrusted-issuer');
  const claimed = { payload: gA.grant.payload, proof: { ...gA.grant.proof, publicKey: attackerKey.publicKey } };
  expect('a real grant re-labelled with an unpinned key', await roster(gA, { body: { grant: claimed, request: (await requestBody(gA)).request } }), 401, 'untrusted-issuer');
  let body = await requestBody(gA); body.issuerKeys = [attackerKey.publicKey]; body.grant = selfIssued;
  expect('a body carrying extra members (client-supplied key list) is refused', await rq('POST', ROSTER, body, { src: nextSrc() }), 400, 'bad-request');
  body = await requestBody(gA); body.grant = selfIssued;
  expect('and a grant signed by the visitor\'s own key is untrusted', await rq('POST', ROSTER, body, { src: nextSrc() }), 401, 'untrusted-issuer');
  body = await requestBody(gA); body.grant = { payload: { ...gA.grant.payload, statusUrl: 'http://127.0.0.1:1/' }, proof: gA.grant.proof };
  expect('a grant carrying extra fields (statusUrl) does not verify', await rq('POST', ROSTER, body, { src: nextSrc() }), 401, 'bad-signature');
  r = await rq('GET', '/lib-moderation.js', undefined, { src: nextSrc() });
  const r2 = await rq('GET', '/moderation-config.json', undefined, { src: nextSrc() });
  check('configuration and library files are not served (banner only)', presenceKind === 'php' ? true : (!/issuerKeys|statusUrl|require\(|crypto/.test(r.text + r2.text)), r.text.slice(0, 60));

  console.log('STEP 5: forged signature, missing proof of possession');
  const forged = JSON.parse(JSON.stringify(gA.grant));
  forged.proof.signature = (forged.proof.signature[0] === 'A' ? 'B' : 'A') + forged.proof.signature.slice(1);
  expect('flipped issuer signature', await roster(gA, { body: { grant: forged, request: (await requestBody(gA)).request } }), 401, 'bad-signature');
  const shortSig = JSON.parse(JSON.stringify(gA.grant)); shortSig.proof.signature = shortSig.proof.signature.slice(0, 40);
  expect('truncated issuer signature', await roster(gA, { body: { grant: shortSig, request: (await requestBody(gA)).request } }), 401, 'bad-signature');
  expect('request signature missing', await roster(gA, { noSignature: true }), 401, 'bad-pop');
  expect('request signed by another key', await roster(gA, { signWith: attackerKey }), 401, 'bad-pop');
  expect('request signed by the visitor\'s wallet key', await roster(gA, { signWith: { privateKey: (await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])).privateKey } }), 401, 'bad-pop');
  body = await requestBody(gA); body.request.payload.world = 'β δ';
  expect('request edited after signing', await rq('POST', ROSTER, body, { src: nextSrc() }), 401, 'bad-pop');
  body = await requestBody(gA); body.request.payload.role = 'admin';
  expect('request with an extra (client-supplied role) field', await rq('POST', ROSTER, body, { src: nextSrc() }), 400, 'bad-request');
  expect('request naming another grant', await roster(gA, { req: { grantId: 'A'.repeat(22) } }), 401, 'wrong-grant');
  expect('request with a stale timestamp', await roster(gA, { req: { issuedAt: new Date(Date.now() - 5 * 60e3).toISOString() } }), 401, 'stale-request');
  expect('request dated in the future', await roster(gA, { req: { issuedAt: new Date(Date.now() + 5 * 60e3).toISOString() } }), 401, 'stale-request');
  expect('request with a short nonce', await roster(gA, { req: { nonce: 'abc' } }), 400, 'bad-request');

  console.log('STEP 6: wrong domain, world, audience, operation');
  expect('request bound to another domain', await roster(gA, { req: { domain: D2 } }), 403, 'wrong-audience');
  expect('request bound to another audience', await roster(gA, { req: { audience: AUD2 } }), 403, 'wrong-audience');
  expect('world outside the grant', await roster(gA, { req: { world: 'beta' } }), 403, 'world-denied');
  expect('world that does not exist in the grant, with different case', await roster(gA, { req: { world: 'Alpha' } }), 403, 'world-denied');
  expect('world with edge whitespace', await roster(gA, { req: { world: ' alpha' } }), 400, 'bad-request');
  expect('operation outside the grant', await roster(gA, { req: { operation: 'chat.mute' } }), 403, 'operation-denied');
  expect('an operation presence does not implement', await roster(gA, { req: { operation: 'session.kick' } }), 403, 'operation-denied');
  expect('non-empty target', await roster(gA, { req: { target: 'x' } }), 400, 'bad-request');
  const wrongAud = await getGrant(iss1, modA, { audience: AUD2 });
  expect('grant issued for another presence service', await roster(wrongAud), 403, 'wrong-audience');
  const g2 = await getGrant(iss2, mod2, { worlds: '*', operations: ['roster.view'] });
  r = expect('another domain\'s moderator lists their own domain', await roster(g2), 200);
  check('...and sees only that domain\'s sessions', r.body.domain === D2 && r.body.count === 1 && r.body.participants[0].name === 'Mallory' && r.body.participants[0].linked, JSON.stringify(r.body));
  r = await roster(g2, { req: { world: 'β δ' } });
  check('...and nothing of the first domain even in a world that only it uses', r.status === 200 && r.body.count === 0, show(r));
  const cross = JSON.parse(JSON.stringify(g2.grant)); cross.payload.domain = D1;
  expect('another domain\'s grant re-labelled with the first domain (its key is not pinned for that domain)', await roster(g2, { body: { grant: cross, request: (await requestBody(g2)).request } }), 401, 'untrusted-issuer');
  setConfig({ ...baseConfig(), domains: { [D1]: baseConfig().domains[D1] } });
  expect('a domain this presence service is not configured for', await roster(g2), 403, 'domain-not-configured');
  setConfig({ ...baseConfig(), domains: { ...baseConfig().domains, [D2]: { issuerKeys: [key1], statusUrl: baseConfig().domains[D2].statusUrl } } });
  expect('second domain pinned to the wrong issuer key', await roster(g2), 401, 'untrusted-issuer');
  setConfig(baseConfig());

  console.log('STEP 7: operations the moderator does not hold');
  const gOps = await getGrant(iss1, modOps, { worlds: '*', operations: ['chat.mute'] });
  expect('grant without roster.view', await roster(gOps), 403, 'operation-denied');
  const gOps2 = await getGrant(iss1, modOps, { worlds: '*', operations: ['chat.mute'] });
  expect('moderator without roster.view in the issuer roster cannot widen the grant', await roster(gOps2, { req: { operation: 'roster.view' } }), 403, 'operation-denied');
  let widenErr = null;
  try { await getGrant(iss1, modOps, { worlds: '*', operations: ['roster.view'] }); } catch (e) { widenErr = e; }
  check('...and the issuer refuses to issue it', !!widenErr, 'issued');
  const gBn = await getGrant(iss1, modB, { worlds: ['alpha', 'beta'] });
  setRoster(iss1, [{ identity: admin, role: 'admin' }, { identity: modA, role: 'moderator', worlds: ['alpha', 'β δ'], operations: ['roster.view', 'chat.mute'] }, { identity: modOps, role: 'moderator', operations: ['chat.mute'] }, { identity: modRev, role: 'moderator', worlds: ['alpha'], operations: ['roster.view'] }, { identity: modB, role: 'moderator', worlds: ['alpha'], operations: ['roster.view'] }]);
  await pause(REFRESH_S + 0.5);
  expect('scope narrowed at the issuer after the grant was issued: still-allowed world', await roster(gBn, { req: { world: 'alpha' } }), 200);
  expect('...the narrowed-away world is refused', await roster(gBn, { req: { world: 'beta' } }), 403, 'world-denied');
  setRoster(iss1, [{ identity: admin, role: 'admin' }, { identity: modA, role: 'moderator', worlds: ['alpha', 'β δ'], operations: ['roster.view', 'chat.mute'] }, { identity: modOps, role: 'moderator', operations: ['chat.mute'] }, { identity: modRev, role: 'moderator', worlds: ['alpha'], operations: ['roster.view'] }, { identity: modB, role: 'moderator', worlds: ['alpha', 'beta'], operations: ['chat.mute'] }]);
  await pause(REFRESH_S + 0.5);
  expect('operation narrowed at the issuer after the grant was issued', await roster(gBn, { req: { world: 'alpha' } }), 403, 'operation-denied');

  console.log('STEP 8: expiry and replay');
  const gShort = await getGrant(iss1, modA, { ttlSeconds: 1 });
  expect('fresh one-second grant works', await roster(gShort), 200);
  await pause(2.2);
  expect('the same grant after it expired', await roster(gShort), 401, 'expired');
  body = await requestBody(gA);
  expect('first use of a request', await rq('POST', ROSTER, body, { src: nextSrc() }), 200);
  expect('replay of the identical request', await rq('POST', ROSTER, body, { src: nextSrc() }), 401, 'replay');
  const nonceFixed = b64(16);
  expect('request with a chosen nonce', await roster(gA, { req: { nonce: nonceFixed } }), 200);
  expect('a new request reusing that nonce (new timestamp)', await roster(gA, { req: { nonce: nonceFixed } }), 401, 'replay');

  console.log('STEP 9: moderation references are locators, not credentials');
  const target = doc.participants.find((p) => p.name === 'Alice');
  const countBefore = (await rq('GET', '/presence/status?domain=' + encodeURIComponent(D1) + '&world=alpha')).body.count;
  const probes = [target.ref, target.presence.avatarId, target.chat.senderId, ref(D1, modA), gA.grant.payload.grantId];
  let accepted = [];
  for (const id of probes) {
    for (const [p, b] of [['/presence/poll/sync', { id, x: 1, y: 1, z: 1, yaw: 0 }], ['/presence/poll/chat-sync', { id }], ['/presence/poll/chat-send', { id, text: 'hi' }]]) {
      const x = await rq('POST', p, b, { src: nextSrc() });
      if (x.status === 200) accepted.push(p + ' with ' + id);
    }
  }
  check('no reference, avatar id, sender id or grant id works as a connection token', accepted.length === 0, accepted.join('; '));
  await rq('POST', '/presence/poll/leave', { id: target.ref }, { src: nextSrc() });
  await rq('POST', '/presence/poll/chat-leave', { id: target.ref }, { src: nextSrc() });
  const countAfter = (await rq('GET', '/presence/status?domain=' + encodeURIComponent(D1) + '&world=alpha')).body.count;
  check('"leaving" with a reference removes nobody', countBefore === countAfter, countBefore + ' vs ' + countAfter);
  check('the real connection token still works', (await rq('POST', '/presence/poll/sync', { id: alice.p.id }, { src: nextSrc() })).status === 200, 'sync failed');
  expect('a reference as the request target', await roster(gA, { req: { target: target.ref } }), 400, 'bad-request');
  expect('a reference as the grant id', await roster(gA, { req: { grantId: target.ref } }), 401, 'wrong-grant');

  console.log('STEP 10: nothing identifying in any response');
  const syncBody = JSON.stringify((await rq('POST', '/presence/poll/sync', { id: alice.p.id }, { src: nextSrc() })).body);
  const wallet = identities.map((i) => i.publicKey);
  const allRoster = seen.join('\n');
  check('no wallet public key, in any roster response', scan(allRoster, wallet).length === 0, scan(allRoster, wallet).join());
  check('no raw visit id, in any roster response or ordinary roster', scan(allRoster + syncBody, visitIds).length === 0, scan(allRoster + syncBody, visitIds).join());
  check('no connection token, in any roster response', scan(allRoster, joinedTokens).length === 0, scan(allRoster, joinedTokens).join());
  check('no network address, source hash or credential field', !/127\.0\.0\.|::1|"src"|"source"|credential|publicKey|"ip"|token|"visit"/i.test(allRoster), (allRoster.match(/127\.0\.0\.|::1|"src"|"source"|credential|publicKey|"ip"|token|"visit"/i) || [''])[0]);
  check('no raw 64-hex source hash', !/[0-9a-f]{40,}/.test(allRoster), 'long hex string');
  check('ordinary presence rosters gained no field', !/visit|joinedAt|moderat/.test(syncBody), syncBody);
  if (presence.dir) {
    const files = fs.readdirSync(path.join(presence.dir, 'presence/lib')).filter((f) => /^atlas-.*\.json$/.test(f)).map((f) => fs.readFileSync(path.join(presence.dir, 'presence/lib', f), 'utf8')).join('\n');
    check('PHP: raw visit ids are not stored anywhere', scan(files, visitIds).length === 0, scan(files, visitIds).join());
    check('PHP: no wallet key or grant in any state file', scan(files, wallet).length === 0 && !files.includes(gA.grant.proof.signature), 'found');
    check('PHP: the config and state files live in lib/, which .htaccess denies', fs.existsSync(path.join(presence.dir, 'presence/lib/.htaccess')) && /Require all denied/.test(fs.readFileSync(path.join(presence.dir, 'presence/lib/.htaccess'), 'utf8')) && fs.existsSync(path.join(presence.dir, 'presence/lib/atlas-presence-moderation-state.json')), 'missing');
  }

  console.log('STEP 11: revocation at the issuer - measured window');
  const gRev = await getGrant(iss1, modRev, { ttlSeconds: 300 });
  expect('before revocation', await roster(gRev), 200);
  const keep = [{ identity: admin, role: 'admin' }, { identity: modA, role: 'moderator', worlds: ['alpha', 'β δ'], operations: ['roster.view', 'chat.mute'] }, { identity: modOps, role: 'moderator', operations: ['chat.mute'] }, { identity: modB, role: 'moderator', worlds: ['alpha', 'beta'], operations: ['roster.view'] }];
  const tRevoke = Date.now();
  setRoster(iss1, keep); // removed from the roster
  let window1 = null, last = null;
  while (Date.now() - tRevoke < 20000) {
    last = await roster(gRev);
    if (last.status !== 200) { window1 = (Date.now() - tRevoke) / 1000; break; }
    await sleep(100);
  }
  check('revoked moderator: refused 403 moderator-inactive', last && last.status === 403 && last.body.code === 'moderator-inactive', show(last));
  check('revocation window with the issuer reachable <= refresh interval (' + REFRESH_S + ' s) + slack: measured ' + (window1 && window1.toFixed(2)) + ' s', window1 !== null && window1 <= REFRESH_S + 1, String(window1));
  console.log('MEASURED: issuer reachable, continued access after roster removal = ' + (window1 && window1.toFixed(2)) + ' s (configured refresh ' + REFRESH_S + ' s, statement lifetime ' + STATUS_TTL_S + ' s; defaults 15 s / 60 s)');
  results['revoked moderator'] = last.status + ' ' + last.body.code;
  expect('a grant requested again by the revoked moderator', await roster(gRev), 403, 'moderator-inactive');
  let reissued = null;
  try { await getGrant(iss1, modRev); } catch (e) { reissued = e; }
  check('...and the issuer issues no new grant to the revoked key', !!reissued, 'issued');
  // restore for later steps
  setRoster(iss1, [...keep, { identity: modRev, role: 'moderator', worlds: ['alpha'], operations: ['roster.view'] }]);
  await pause(REFRESH_S + 0.3);

  console.log('STEP 12: issuer isolated - fail closed after the statement lifetime');
  const gIso = await getGrant(iss1, modRev, { ttlSeconds: 300 });
  expect('moderator active, issuer reachable', await roster(gIso), 200);
  await pause(0.3);
  setRoster(iss1, keep); // revoke, and cut the issuer off before presence can refresh
  proxyMode = 'down';
  const tCut = Date.now();
  let window2 = null; last = null;
  while (Date.now() - tCut < 20000) {
    last = await roster(gIso);
    if (last.status !== 200) { window2 = (Date.now() - tCut) / 1000; break; }
    await sleep(100);
  }
  check('isolated: refused 503 authorization-unavailable', last && last.status === 503 && last.body.code === 'authorization-unavailable', show(last));
  check('isolated: continued access <= statement lifetime (' + STATUS_TTL_S + ' s) + slack: measured ' + (window2 && window2.toFixed(2)) + ' s', window2 !== null && window2 <= STATUS_TTL_S + 1, String(window2));
  console.log('MEASURED: issuer isolated at the moment of removal, continued access = ' + (window2 && window2.toFixed(2)) + ' s (statement lifetime ' + STATUS_TTL_S + ' s; default 60 s)');
  results['issuer isolated'] = last.status + ' ' + last.body.code;
  expect('isolated: even a valid moderator is refused (no stale authorization)', await roster(gA), 503, 'authorization-unavailable');
  proxyMode = 'pass';
  expect('issuer back: a valid moderator works again', await roster(gA), 200);
  expect('issuer back: the revoked moderator stays refused', await roster(gIso), 403, 'moderator-inactive');
  setRoster(iss1, [...keep, { identity: modRev, role: 'moderator', worlds: ['alpha'], operations: ['roster.view'] }]);

  console.log('STEP 13: every bad status statement fails closed');
  await pause(REFRESH_S + 0.3);
  expect('(precondition) healthy again', await roster(gA), 200);
  proxyMode = 'redirect';
  await pause(STATUS_TTL_S + 0.5); // the last good statement has expired
  for (const mode of ['redirect', 'garbage', 'html', 'big', 'error', 'wrongAudience', 'slow', 'down']) {
    proxyMode = mode;
    const t0 = Date.now();
    r = await roster(gA);
    check('status "' + mode + '": 503 authorization-unavailable', r.status === 503 && r.body.code === 'authorization-unavailable', show(r));
    results['status ' + mode] = r.status + ' ' + (r.body && r.body.code);
    if (mode === 'slow') check('a slow issuer is cut off by the fetch timeout', Date.now() - t0 < 3500, (Date.now() - t0) + ' ms');
  }
  proxyMode = 'pass';
  expect('(recovery) a healthy statement is accepted again', await roster(gA), 200);

  console.log('STEP 14: replayed (frozen) status statement');
  const captured = await (await fetch(iss1.base + '/atlas/moderation/status?audience=' + encodeURIComponent(AUD))).text();
  frozen = captured;
  const gFz = await getGrant(iss1, modRev, { ttlSeconds: 300 });
  await pause(REFRESH_S + 0.3);
  expect('moderator active under the live statement', await roster(gFz), 200);
  setRoster(iss1, keep);
  proxyMode = 'frozen'; // an attacker replays the old statement that still lists the moderator
  const tFz = Date.now() - (Date.now() - Date.parse(JSON.parse(captured).payload.issuedAt));
  const tRevoke2 = Date.now();
  let window3 = null; last = null;
  while (Date.now() - tRevoke2 < 20000) {
    last = await roster(gFz);
    if (last.status !== 200) { window3 = (Date.now() - tRevoke2) / 1000; break; }
    await sleep(100);
  }
  const lateBound = (Date.parse(JSON.parse(captured).payload.expiresAt) - tRevoke2) / 1000;
  check('replayed statement: refused once it expires (503)', last && last.status === 503 && last.body.code === 'authorization-unavailable', show(last));
  check('replayed statement: continued access ended by the captured statement\'s own expiry (' + lateBound.toFixed(2) + ' s after removal): measured ' + (window3 && window3.toFixed(2)) + ' s', window3 !== null && window3 <= lateBound + 1, String(window3));
  console.log('MEASURED: replayed statement, continued access = ' + (window3 && window3.toFixed(2)) + ' s (never longer than the statement lifetime ' + STATUS_TTL_S + ' s)');
  results['replayed status'] = last.status + ' ' + last.body.code;
  proxyMode = 'pass';
  void tFz;

  console.log('STEP 15: trusted keys - removal, rotation, emergency revocation');
  const gK = await getGrant(iss1, modA, { ttlSeconds: 300 });
  await pause(REFRESH_S + 0.3);
  expect('(precondition) grant works', await roster(gK), 200);
  const otherKey = (await M.generatePopKey()).publicKey;
  setConfig({ ...baseConfig(), domains: { ...baseConfig().domains, [D1]: { issuerKeys: [otherKey], statusUrl: PROXY_URL } } });
  expect('issuer key removed from the trusted set (effective on the next request)', await roster(gK), 401, 'untrusted-issuer');
  setConfig({ ...baseConfig(), domains: { ...baseConfig().domains, [D1]: { issuerKeys: [otherKey, key1], statusUrl: PROXY_URL } } });
  expect('rotation: old and new key both trusted during the overlap', await roster(gK), 200);
  setConfig({ ...baseConfig(), domains: { ...baseConfig().domains, [D1]: { issuerKeys: [otherKey], statusUrl: PROXY_URL } } });
  expect('rotation finished: old key removed again', await roster(gK), 401, 'untrusted-issuer');
  setConfig(baseConfig());
  expect('key restored', await roster(gK), 200);
  setConfig({ ...baseConfig(), revokedModerators: [gK.grant.payload.moderatorRef] });
  expect('emergency: moderator revoked in presence config (next request)', await roster(gK), 403, 'revoked');
  setConfig({ ...baseConfig(), revokedGrants: [gK.grant.payload.grantId] });
  expect('emergency: single grant revoked in presence config', await roster(gK), 403, 'revoked');
  expect('...other grants of the same moderator still work', await roster(gA), 200);
  setConfig({ ...baseConfig(), enabled: false });
  expect('emergency: moderation switched off', await roster(gA), 503, 'moderation-not-configured');
  setConfig(baseConfig());
  expect('...and back on', await roster(gA), 200);
  setConfig({ ...baseConfig(), audience: AUD2 });
  expect('presence audience changed: every grant for the old audience is refused', await roster(gA), 403, 'wrong-audience');
  setConfig(baseConfig());

  check('ordinary presence still works after all of the above: sync, status', (await rq('POST', '/presence/poll/sync', { id: carol.p.id }, { src: nextSrc() })).status === 200 && (await rq('GET', '/presence/status?domain=' + encodeURIComponent(D1) + '&world=alpha')).status === 200, 'broken');

  console.log('STEP 16: per-source throttle on failed requests');
  await killAndRestartPresence(presenceKind, { MODERATION_FAIL_MAX: '5', MODERATION_FAIL_WINDOW_MS: '4000' });
  const gT = await getGrant(iss1, modA, { ttlSeconds: 300 });
  const bad = '127.0.0.' + 240;
  let throttledAt = 0;
  for (let i = 1; i <= 9 && !throttledAt; i++) {
    const x = await rq('POST', ROSTER, { grant: forged, request: (await requestBody(gA)).request }, { src: bad });
    if (x.status === 429) { throttledAt = i; check('429 carries Retry-After', Number(x.headers['retry-after']) >= 1 && x.body.code === 'rate-limited', show(x)); }
  }
  check('after 5 failures from one source the sixth request is throttled', throttledAt === 6, String(throttledAt));
  results['throttle after 5 failures'] = String(throttledAt);
  expect('...even a valid request from that source is throttled', await rq('POST', ROSTER, await requestBody(gT), { src: bad }), 429, 'rate-limited');
  expect('another source is unaffected', await roster(gT, { src: '127.0.0.241' }), 200);
  await pause(4.5);
  expect('the throttle expires', await rq('POST', ROSTER, await requestBody(gT), { src: bad }), 200);
  let okRuns = 0;
  for (let i = 0; i < 12; i++) if ((await rq('POST', ROSTER, await requestBody(gT), { src: '127.0.0.242' })).status === 200) okRuns++;
  check('successful requests are not throttled', okRuns === 12, String(okRuns));
  const huge = await rq('POST', ROSTER, JSON.stringify({ grant: gT.grant, pad: 'x'.repeat(64 * 1024), request: (await requestBody(gT)).request }), { src: nextSrc() });
  check('an oversized body is refused', huge.status === 413 || huge.status === 400, show(huge));

  // privacy re-scan including everything seen since step 10
  const allRoster2 = seen.join('\n');
  check('(final scan) no wallet key, token, raw visit id or address in any roster response', scan(allRoster2, [...wallet, ...joinedTokens, ...visitIds]).length === 0 && !/127\.0\.0\.|::1/.test(allRoster2), 'leak');

  for (const s of sockets.splice(0)) { try { s.close(); } catch (_) {} }
  await killAll();
  proxyServer.close();
  return { ...results };
}

async function killAndRestartPresence(kind, env) {
  try { presence.proc.kill(); } catch (_) {}
  await sleep(500);
  await startPresence(kind, env);
}

(async () => {
  let all = [];
  try {
    const combos = MATRIX ? [['node', 'node'], ['node', 'php'], ['php', 'node'], ['php', 'php']] : [[ARGS[0] === 'php' ? 'php' : 'node', ARGS[1] || (ARGS[0] === 'php' ? 'php' : 'node')]];
    for (const [p, i] of combos) {
      for (const k of Object.keys(results)) delete results[k];
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
    try { proxyServer && proxyServer.close(); } catch (_) {}
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL PRESENCE MODERATION CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
