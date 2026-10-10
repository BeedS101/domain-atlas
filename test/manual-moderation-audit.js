// Security regression test for the private moderation audit trail, the audit
// read operation (audit.view), browser access (CORS) to the moderation routes
// and the issuer's moderation-panel configuration, against the Node presence
// server and the PHP presence bundle, paired with either issuer:
//
//   node test/manual-moderation-audit.js node            presence Node, issuer Node
//   node test/manual-moderation-audit.js php             presence PHP,  issuer PHP
//   node test/manual-moderation-audit.js node php        presence Node, issuer PHP
//   node test/manual-moderation-audit.js php node        presence PHP,  issuer Node
//   node test/manual-moderation-audit.js matrix          all four pairings, then
//                                                        compares every answer
//
// Each run starts two issuers (two domains) and a presence service with
// isolated scratch state, config and audit file; no live configuration is read
// or written. Timing is scaled down (issuer status lifetime 5 s, refresh 2 s).
//
// Covered: every command (mute, unmute, kick) and every refusal that reaches a
// verified grant lands in the audit log with the right moderator reference,
// role, domain, world, operation, target reference, duration, cause, outcome and
// code; refusals before a grant is trusted are not recorded; the audit read is
// limited to the viewer's domain and worlds (a moderator never sees another
// world, another domain, or entries no world could be attributed to) and needs
// the audit.view operation; revoked moderators are refused and recorded; the
// log holds no key, token, visit id, address, name, chat text or nonce, is
// created private (0600) and lives next to the other private state; the size
// and age bounds hold with the hash chain still verifying; concurrent writers
// keep every entry and the chain intact; editing the file is reported as a
// broken chain; a command is not carried out when it cannot be recorded; CORS is
// answered for the configured domains' origins on the moderation routes only;
// presence and chat keep working when moderation is not configured; the issuer's
// panel configuration (config route, is-admin, role in the status statement).

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
const PORTS = { issuer1: 9351, issuer2: 9352, presence: 9353 };
const AUD = 'https://presence.test.example';
const D1 = 'localhost:' + PORTS.issuer1;
const D2 = 'localhost:' + PORTS.issuer2;
const GRANT = '/atlas/admin/moderation/grant';
const ROSTER = '/presence/moderation/roster';
const COMMAND = '/presence/moderation/command';
const AUDIT = '/presence/moderation/audit';
const STATUS_TTL_S = 5, REFRESH_S = 2;
const ALL_OPS = ['roster.view', 'chat.mute', 'chat.unmute', 'session.kick', 'audit.view'];

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
    const docroot = H.tmpDir('atlas-au-docroot-');
    fs.cpSync(path.join(H.ROOT, 'demo-domain-a'), docroot, { recursive: true });
    const stateDir = H.tmpDir('atlas-au-state-');
    issuer = await H.startNodeIssuer({ port, stateDir, docrootDir: docroot, env: { ...env, ATLAS_MODERATION_AUDIENCES: AUD } });
    issuer.files = (name) => path.join(stateDir, name);
    issuer.docroot = docroot;
  } else {
    const bundleDir = H.preparePhpBundle();
    fs.writeFileSync(path.join(bundleDir, 'lib', 'atlas-moderation-config.json'), JSON.stringify({ domain, audiences: [AUD] }));
    issuer = await H.startPhpIssuer({ port, bundleDir, env: { PHP_CLI_SERVER_WORKERS: '4', ...env } });
    issuer.files = (name) => path.join(bundleDir, 'lib', name);
    issuer.docroot = bundleDir;
    fs.mkdirSync(path.join(bundleDir, '.well-known'), { recursive: true });
    fs.copyFileSync(path.join(H.ROOT, 'demo-domain-a', '.well-known', 'spatial.json'), path.join(bundleDir, '.well-known', 'spatial.json'));
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
let auditFile = null;
async function startPresence(kind, extraEnv) {
  const env = { ...process.env, PRESENCE_MODERATION_CONFIG: cfgFile, PRESENCE_MODERATION_AUDIT_FILE: auditFile, POLL_TIMEOUT_MS: '600000', POLL_SWEEP_INTERVAL_MS: '1000', MODERATION_STATUS_REFRESH_S: String(REFRESH_S), MODERATION_FETCH_TIMEOUT_MS: '1000', MODERATION_COMMANDS_PER_MIN: '500', ...(extraEnv || {}) };
  let proc, dir = null;
  if (kind === 'php') {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-au-presence-'));
    fs.cpSync(path.join(ROOT, 'presence-php'), dir, { recursive: true });
    for (const f of fs.readdirSync(path.join(dir, 'presence/lib'))) if (/^atlas-.*\.json/.test(f)) fs.unlinkSync(path.join(dir, 'presence/lib', f));
    proc = spawn('php', ['-S', '127.0.0.1:' + PORTS.presence, 'test-router.php'], { cwd: dir, env: { ...env, PHP_CLI_SERVER_WORKERS: '6' }, stdio: 'ignore' });
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
const seen = []; // every audit-read response body, scanned for leaks
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
        if (p === AUDIT) seen.push(text);
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
const shapeOf = (x) => Array.isArray(x) ? x.map(shapeOf) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, shapeOf(x[k])])) : x === null ? 'null' : typeof x;

// ---------- grants and requests ----------

const b64 = (n) => Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString('base64url');
const pops = []; // every ephemeral public key issued, scanned for at the end
async function getGrant(issuer, who, o) {
  o = o || {};
  const pop = o.pop || (await M.generatePopKey());
  pops.push(pop.publicKey);
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
async function audit(g, world, o) {
  return rq('POST', AUDIT, await requestBody(g, 'audit.view', '', undefined, Object.assign({ world: world || 'alpha' }, o || {})), { src: nextSrc() });
}

// ---------- participants ----------

const identities = [];
async function ident() { const i = await H.genIdentity(); identities.push(i); return i; }
const joinedTokens = [];
const visitIds = [];
let nextIp = 100;
const newVisit = () => { const v = b64(16); visitIds.push(v); return v; };
const fresh = () => '127.0.0.' + (100 + (nextIp++ % 100));
async function pjoin(domain, world, name, visit) {
  const body = { domain, world, name };
  if (visit !== undefined) body.visit = visit;
  const r = await rq('POST', '/presence/poll/join', body, { src: fresh() });
  if (r.status === 200) joinedTokens.push(r.body.id);
  return r;
}
async function cjoin(domain, world, name, visit) {
  const body = { domain, world, name };
  if (visit !== undefined) body.visit = visit;
  const r = await rq('POST', '/presence/poll/chat-join', body, { src: fresh() });
  if (r.status === 200) joinedTokens.push(r.body.id);
  return r;
}
async function must(p) { const r = await p; if (r.status !== 200) throw new Error('setup failed ' + r.text); return r.body; }
const csend = (id, text) => rq('POST', '/presence/poll/chat-send', { id, text }, { src: nextSrc() });

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
    await sleep(stepMs || 300);
  }
}
const auditLines = () => (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const auditText = () => (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8') : '');
const brief = (e) => [e.operation, e.outcome, e.code].join('/');

// ---------- the scenario ----------

async function scenario(presenceKind, issuerKind) {
  const label = presenceKind + ' presence / ' + issuerKind + ' issuer';
  console.log('\n===== ' + label + ' =====');
  results.__label = label;
  cfgFile = path.join(H.tmpDir('atlas-au-cfg-'), 'moderation-config.json');
  auditFile = path.join(H.tmpDir('atlas-au-audit-'), 'audit.jsonl');
  const iss1 = await startIssuer(issuerKind, PORTS.issuer1);
  const iss2 = await startIssuer(issuerKind, PORTS.issuer2);

  const admin = await ident(), modA = await ident(), modB = await ident(), modNoAudit = await ident(), modRev = await ident(), mod2 = await ident(), outsider = await ident();
  setRoster(iss1, [
    { identity: admin, role: 'admin' },
    { identity: modA, role: 'moderator', worlds: ['alpha'], operations: ALL_OPS },
    { identity: modB, role: 'moderator', worlds: ['beta'], operations: ALL_OPS },
    { identity: modNoAudit, role: 'moderator', worlds: ['alpha'], operations: ['roster.view', 'chat.mute', 'chat.unmute', 'session.kick'] },
    { identity: modRev, role: 'moderator', worlds: ['alpha'], operations: ALL_OPS }
  ]);
  setRoster(iss2, [{ identity: mod2, role: 'moderator', worlds: ['alpha'], operations: ALL_OPS }]);
  key1 = await issuerKeyOf(iss1); key2 = await issuerKeyOf(iss2);
  setConfig(baseConfig());
  await startPresence(presenceKind);

  console.log('STEP 1: the issuer tells the panel what it needs (and only to those who may moderate)');
  const sessionOf = async (issuer, who) => { const nonce = (await H.getJson(issuer.base, '/atlas/admin/session/nonce')).body.nonce; const payload = withAdminAuth({ nonce }, issuer.base, '/atlas/admin/session/start'); return (await H.postJson(issuer.base, '/atlas/admin/session/start', { payload, proof: await H.signWithSelf(who, payload) })).body; };
  const tokA = (await sessionOf(iss1, modA)).token, tokAdmin = (await sessionOf(iss1, admin)).token, tokNoAudit = (await sessionOf(iss1, modNoAudit)).token;
  let r = expect('moderator reads the panel configuration', await H.postJson(iss1.base, '/atlas/admin/moderation/config', { token: tokA }), 200);
  check('...the audiences, worlds, operations, role and signing purpose, and no key or secret', r.body.role === 'moderator' && r.body.configured === true && r.body.audiences.join() === AUD && r.body.worlds.join() === 'alpha' && r.body.operations.join() === ALL_OPS.join() && r.body.purpose === 'moderation-grant' && r.body.problems.length === 0 && r.body.domain === D1 && !/publicKey|token|signature/i.test(JSON.stringify(r.body)), show(r));
  results['config shape'] = JSON.stringify(shapeOf(r.body));
  r = await H.postJson(iss1.base, '/atlas/admin/moderation/config', { token: tokNoAudit });
  check('a moderator without audit.view is not offered it', r.status === 200 && !r.body.operations.includes('audit.view') && r.body.operations.includes('session.kick'), show(r));
  r = expect('an administrator reads it too', await H.postJson(iss1.base, '/atlas/admin/moderation/config', { token: tokAdmin }), 200);
  check('...with every world the manifest declares, flagged as all worlds', r.body.role === 'admin' && r.body.allWorlds === true && r.body.worlds.length >= 1 && r.body.worlds.every((w) => typeof w === 'string'), show(r));
  expect('no token: 401', await H.postJson(iss1.base, '/atlas/admin/moderation/config', {}), 401, 'session-invalid');
  expect('a made-up token: 401', await H.postJson(iss1.base, '/atlas/admin/moderation/config', { token: 'nope' }), 401, 'session-invalid');
  r = await H.getJson(iss1.base, '/atlas/admin/is-admin?publicKey=' + encodeURIComponent(modA.publicKey));
  check('is-admin: a moderator is not an administrator but is a moderator', r.body.isAdmin === false && r.body.isModerator === true, show(r));
  r = await H.getJson(iss1.base, '/atlas/admin/is-admin?publicKey=' + encodeURIComponent(admin.publicKey));
  check('is-admin: an administrator is an administrator and not "a moderator"', r.body.isAdmin === true && r.body.isModerator === false, show(r));
  r = await H.getJson(iss1.base, '/atlas/admin/is-admin?publicKey=' + encodeURIComponent(outsider.publicKey));
  check('is-admin: a stranger is neither', r.body.isAdmin === false && r.body.isModerator === false, show(r));
  r = await H.getJson(iss1.base, '/atlas/moderation/status?audience=' + encodeURIComponent(AUD));
  const entries = r.body.payload.moderators;
  check('the signed status statement states each entry\'s role', entries.length === 5 && entries.filter((e) => e.role === 'admin').length === 1 && entries.filter((e) => e.role === 'moderator').length === 4 && entries.every((e) => Object.keys(e).sort().join() === 'moderatorRef,operations,role,worlds'), JSON.stringify(entries));
  r = await H.postJson(iss1.base, '/atlas/admin/directory', { token: tokA });
  check('a moderator session is still refused by every administration route (directory)', r.status === 403, show(r));

  console.log('STEP 2: sessions to moderate');
  const VA = newVisit(), VB = newVisit(), VE = newVisit();
  const alice = { p: await must(pjoin(D1, 'alpha', 'Alice', VA)), c: await must(cjoin(D1, 'alpha', 'Alice', VA)) };
  const bob = { c: await must(cjoin(D1, 'alpha', 'Bob', VB)) };
  const eve = { p: await must(pjoin(D1, 'beta', 'Eve', VE)), c: await must(cjoin(D1, 'beta', 'Eve', VE)) };
  const gA = await getGrant(iss1, modA);
  const gB = await getGrant(iss1, modB, { worlds: ['beta'] });
  const gNo = await getGrant(iss1, modNoAudit, { operations: ['roster.view', 'chat.mute', 'chat.unmute', 'session.kick'] });
  const gAdmin = await getGrant(iss1, admin, { worlds: ['alpha', 'beta'] });
  const g2 = await getGrant(iss2, mod2);
  r = await list(gA);
  const ref = {};
  for (const p of r.body.participants) ref[p.name] = p.ref;
  check('the moderator lists alpha (Alice, Bob)', r.status === 200 && r.body.count === 2 && ref.Alice && ref.Bob, show(r));
  const refB = {};
  for (const p of (await list(gB, 'beta')).body.participants) refB[p.name] = p.ref;
  check('the beta moderator lists beta (Eve)', !!refB.Eve, JSON.stringify(refB));
  check('listing is not recorded (it is a read, refreshed often)', auditLines().length === 0, auditText());

  console.log('STEP 3: actions and refusals');
  expect('mute Alice (spam, 60 s)', await cmd(gA, 'chat.mute', ref.Alice, { durationSeconds: 60, cause: 'spam' }), 200);
  expect('unmute Alice', await cmd(gA, 'chat.unmute', ref.Alice), 200);
  expect('mute Bob (harassment, 120 s)', await cmd(gA, 'chat.mute', ref.Bob, { durationSeconds: 120, cause: 'harassment' }), 200);
  expect('a reference that no longer exists: 404', await cmd(gA, 'chat.mute', 'AAAAAAAAAAAAAAAAAAAAAA', { durationSeconds: 60, cause: 'spam' }), 404, 'unknown-participant');
  const replayBody = await requestBody(gA, 'chat.unmute', ref.Bob);
  expect('unmute Bob', await cmd(gA, 'chat.unmute', ref.Bob, undefined, { body: replayBody }), 200);
  expect('the same signed request again (replay): 401', await cmd(gA, 'chat.unmute', ref.Bob, undefined, { body: replayBody }), 401, 'replay');
  const wrongPop = await M.generatePopKey();
  expect('a request signed by another key: 401', await cmd(gA, 'chat.mute', ref.Alice, { durationSeconds: 60, cause: 'spam' }, { signWith: wrongPop }), 401, 'bad-pop');
  expect('beta with an alpha-only grant: 403', await cmd(gA, 'chat.mute', refB.Eve, { durationSeconds: 60, cause: 'spam' }, { world: 'beta' }), 403, 'world-denied');
  expect('a moderator whose grant has no audit.view: 403', await audit(gNo), 403, 'operation-denied');
  expect('kick Alice (harassment, 30 s)', await cmd(gA, 'session.kick', ref.Alice, { durationSeconds: 30, cause: 'harassment' }), 200);
  expect('the beta moderator mutes Eve (inappropriate, 45 s)', await cmd(gB, 'chat.mute', refB.Eve, { durationSeconds: 45, cause: 'inappropriate' }, { world: 'beta' }), 200);
  expect('...and cannot touch alpha', await cmd(gB, 'session.kick', ref.Bob, { durationSeconds: 30, cause: 'spam' }, { world: 'alpha' }), 403, 'world-denied');
  expect('the other domain\'s moderator mutes nobody in domain 1 (no such reference there): 404', await cmd(g2, 'chat.mute', ref.Bob, { durationSeconds: 60, cause: 'spam' }), 404, 'unknown-participant');
  expect('nonsense is refused before a grant is trusted: 400', await rq('POST', COMMAND, { grant: { payload: {}, proof: {} }, request: {} }, { src: nextSrc() }), 400);
  check('...and is not recorded (no moderator can be named)', !auditLines().some((e) => e.moderatorRef === null), auditText());

  console.log('STEP 4: what the log holds');
  let lines = auditLines();
  const ours = lines.filter((e) => e.domain === D1);
  const row = (op, outcome, code, who) => ours.find((e) => e.operation === op && e.outcome === outcome && e.code === code && (!who || e.moderatorRef === who));
  const refA = gA.grant.payload.moderatorRef, refBm = gB.grant.payload.moderatorRef;
  let e = row('chat.mute', 'success', 'ok', refA);
  check('a successful mute: moderator, role, domain, world, grant, target, duration and cause', !!e && e.role === 'moderator' && e.domain === D1 && e.world === 'alpha' && e.grantId === gA.grant.payload.grantId && /^[A-Za-z0-9_-]{22}$/.test(e.target) && e.durationSeconds === 60 && e.cause === 'spam' && typeof e.t === 'string' && Number.isInteger(e.seq), JSON.stringify(e));
  e = row('chat.unmute', 'success', 'ok', refA);
  check('a successful unmute records no duration or cause', !!e && e.durationSeconds === null && e.cause === null, JSON.stringify(e));
  e = row('session.kick', 'success', 'ok', refA);
  check('a successful kick: 30 s, harassment', !!e && e.durationSeconds === 30 && e.cause === 'harassment', JSON.stringify(e));
  e = row('chat.mute', 'failed', 'unknown-participant', refA);
  check('a failed command (no such participant) is recorded as failed', !!e && e.world === 'alpha', JSON.stringify(ours.map(brief)));
  e = row('chat.unmute', 'refused', 'replay', refA);
  check('a replayed request is recorded as refused', !!e && e.world === 'alpha', JSON.stringify(ours.map(brief)));
  e = row('chat.mute', 'refused', 'bad-pop', refA);
  check('a request not signed by the grant\'s key is recorded as refused', !!e, JSON.stringify(ours.map(brief)));
  e = ours.find((x) => x.operation === 'chat.mute' && x.code === 'world-denied' && x.moderatorRef === refA);
  check('a request outside the grant\'s worlds is recorded without naming that world', !!e && e.world === null, JSON.stringify(e));
  e = ours.find((x) => x.operation === 'audit.view' && x.code === 'operation-denied' && x.moderatorRef === noAuditRef(gNo));
  check('an audit read without the operation is recorded as refused (alpha, the grant\'s world)', !!e && e.world === 'alpha', JSON.stringify(ours.map(brief)));
  check('the beta moderator\'s entries carry the beta world', ours.filter((x) => x.moderatorRef === refBm && x.outcome === 'success').every((x) => x.world === 'beta'), JSON.stringify(ours));
  check('the other domain\'s moderator\'s refusal is recorded under the other domain, not this one', ours.every((x) => x.moderatorRef !== g2.grant.payload.moderatorRef) && lines.some((x) => x.domain === D2), JSON.stringify(lines.map((x) => [x.domain, brief(x)])));
  check('every entry carries a sequence number, a chain hash and nothing outside the expected fields', lines.every((x, i) => x.seq === i + 1 && /^[A-Za-z0-9_-]{43}$/.test(x.h) && Object.keys(x).sort().join() === 'cause,code,domain,durationSeconds,grantId,h,moderatorRef,operation,outcome,role,seq,t,target,world'), JSON.stringify(lines[0]));
  check('the role is what the issuer\'s status states ("moderator"; unknown only when refused before the statement was read)', lines.every((x) => x.role === 'moderator' || x.role === null), JSON.stringify(lines.map((x) => x.role)));

  console.log('STEP 5: reading the log');
  r = expect('the alpha moderator reads the alpha log', await audit(gA), 200);
  const view = r.body;
  check('...entries come newest first, with the same data and no chain hash', Array.isArray(view.entries) && view.entries.length >= 9 && view.entries.every((x, i, a) => i === 0 || a[i - 1].seq > x.seq) && view.entries.every((x) => !('h' in x)), show(r));
  check('...only alpha entries (no beta, no other domain, nothing unattributed)', view.entries.every((x) => x.domain === D1 && x.world === 'alpha'), JSON.stringify(view.entries.map((x) => [x.domain, x.world])));
  check('...including the beta moderator\'s nothing and the world-denied probe not at all', !view.entries.some((x) => x.moderatorRef === refBm) && !view.entries.some((x) => x.code === 'world-denied'), JSON.stringify(view.entries.map(brief)));
  check('...the integrity block says the chain is intact and gives the head to anchor', view.integrity.chain === 'ok' && view.integrity.entries === lines.length && /^[A-Za-z0-9_-]{43}$/.test(view.integrity.head) && view.integrity.lastSeq === lines[lines.length - 1].seq, JSON.stringify(view.integrity));
  check('...and the retention it works under', view.retention && view.retention.maxBytes > 0 && view.retention.maxAgeDays > 0, JSON.stringify(view.retention));
  results['audit view shape'] = JSON.stringify(shapeOf(Object.assign({}, view, { entries: view.entries.slice(0, 1) })));
  check('reading the log is itself recorded (success)', auditLines().some((x) => x.operation === 'audit.view' && x.outcome === 'success' && x.moderatorRef === refA), auditText());
  r = expect('the beta moderator reads the beta log', await audit(gB, 'beta'), 200);
  check('...only the beta moderator\'s own beta entries', r.body.entries.length >= 1 && r.body.entries.every((x) => x.world === 'beta' && x.domain === D1), JSON.stringify(r.body.entries.map(brief)));
  expect('...and cannot read alpha\'s', await audit(gB, 'alpha'), 403, 'world-denied');
  r = expect('the other domain\'s moderator reads only its own domain\'s log', await audit(g2, 'alpha'), 200);
  check('...which holds nothing of domain 1', r.body.entries.every((x) => x.domain === D2), JSON.stringify(r.body.entries));
  r = expect('an administrator reads alpha', await audit(gAdmin, 'alpha'), 200);
  check('...and sees the probes no world could be attributed to, under their own domain only', r.body.entries.some((x) => x.code === 'world-denied' && x.world === null) && r.body.entries.every((x) => x.domain === D1), JSON.stringify(r.body.entries.map(brief)));
  check('...with role admin on the admin\'s own entry after this read', auditLines().some((x) => x.operation === 'audit.view' && x.role === 'admin'), auditText());
  expect('a world the grant does not name: 403', await audit(gAdmin, 'gamma'), 403, 'world-denied');
  expect('a request to read with a made-up target is refused', await rq('POST', AUDIT, await requestBody(gA, 'audit.view', 'x', undefined, {}), { src: nextSrc() }), 400);
  expect('the roster endpoint does not serve audit.view', await rq('POST', ROSTER, await requestBody(gA, 'audit.view', ''), { src: nextSrc() }), 403, 'operation-denied');
  expect('the audit endpoint does not serve commands', await rq('POST', AUDIT, await requestBody(gA, 'chat.mute', ref.Bob, { durationSeconds: 60, cause: 'spam' }), { src: nextSrc() }), 403, 'operation-denied');
  expect('the command endpoint does not serve audit.view', await rq('POST', COMMAND, await requestBody(gA, 'audit.view', ''), { src: nextSrc() }), 403, 'operation-denied');

  console.log('STEP 6: a revoked moderator');
  const gRev = await getGrant(iss1, modRev);
  r = await cmd(gRev, 'chat.mute', ref.Bob, { durationSeconds: 5, cause: 'spam' });
  check('before revocation the command works', r.status === 200, show(r));
  setRoster(iss1, [
    { identity: admin, role: 'admin' },
    { identity: modA, role: 'moderator', worlds: ['alpha'], operations: ALL_OPS },
    { identity: modB, role: 'moderator', worlds: ['beta'], operations: ALL_OPS },
    { identity: modNoAudit, role: 'moderator', worlds: ['alpha'], operations: ['roster.view', 'chat.mute', 'chat.unmute', 'session.kick'] },
    { identity: modRev, role: 'moderator', worlds: ['alpha'], operations: ALL_OPS, revoked: true }
  ]);
  const refused = await until(async () => { const x = await cmd(gRev, 'chat.unmute', ref.Bob); return x.status === 403 ? x : null; }, (STATUS_TTL_S + REFRESH_S + 3) * 1000, 400);
  check('after revocation the command is refused (moderator-inactive) within the status lifetime', !!refused && refused.body.code === 'moderator-inactive', refused ? show(refused) : 'never refused');
  results['revoked moderator'] = refused ? refused.status + ' ' + refused.body.code : 'none';
  e = auditLines().find((x) => x.moderatorRef === gRev.grant.payload.moderatorRef && x.code === 'moderator-inactive');
  check('...and the refusal is in the log under that moderator, with no role (the issuer no longer lists it)', !!e && e.outcome === 'refused' && e.role === null && e.world === 'alpha', JSON.stringify(e));
  r = await audit(gA);
  check('the alpha moderator can read that refusal', r.body.entries.some((x) => x.code === 'moderator-inactive'), show(r));
  r = await audit(gRev);
  check('the revoked moderator cannot read the log', r.status === 403 && r.body.code === 'moderator-inactive', show(r));

  console.log('STEP 7: nothing sensitive is stored or shown');
  const text = auditText();
  const needles = [...identities.map((i) => i.publicKey), ...pops, ...visitIds, ...joinedTokens, 'Alice', 'Bob', 'Eve', '127.0.0.', 'localhost:' + PORTS.presence, 'signature', 'nonce', 'token', 'privateKey', 'password', 'hello', 'chat-text'];
  const allText = text + '\n' + seen.join('\n');
  const found = needles.filter((n) => n && allText.includes(n));
  check('the log and every moderation answer contain no wallet key, ephemeral key, visit id, session token, address, name or nonce', found.length === 0, JSON.stringify(found));
  const mode = fs.statSync(auditFile).mode & 0o777;
  check('the log file is private to its owner (0600)', (mode & 0o077) === 0, mode.toString(8));
  if (presenceKind === 'php') {
    const htaccess = fs.readFileSync(path.join(presence.dir, 'presence/lib/.htaccess'), 'utf8');
    check('the PHP log lives in lib/, which .htaccess denies to the web', /Require all denied/.test(htaccess) && /Deny from all/.test(htaccess) && /atlas-presence-moderation-audit\.jsonl/.test(fs.readFileSync(path.join(ROOT, 'presence-php/presence/lib/audit.php'), 'utf8')), htaccess);
  } else {
    const rr = await rq('GET', '/moderation-audit.jsonl');
    const rr2 = await rq('GET', '/presence-server/moderation-audit.jsonl');
    check('the Node server serves no file from disk (the log is not reachable by URL)', rr.status === 200 && /presence server/i.test(rr.text) && !/"seq"/.test(rr.text + rr2.text), rr.text);
  }

  console.log('STEP 8: editing the file is noticed');
  const original = auditText();
  const tampered = original.split('\n');
  const idx = tampered.findIndex((l) => l.includes('"chat.unmute"'));
  tampered[idx] = tampered[idx].replace('"success"', '"refused"');
  fs.writeFileSync(auditFile, tampered.join('\n'));
  r = await audit(gA);
  check('a changed line is reported as a broken chain, at its entry', r.status === 200 && r.body.integrity.chain === 'broken' && Number.isInteger(r.body.integrity.firstBadSeq), JSON.stringify(r.body.integrity));
  const removed = original.split('\n'); removed.splice(idx, 1);
  fs.writeFileSync(auditFile, removed.join('\n'));
  r = await audit(gA);
  check('a deleted line is reported too', r.body.integrity.chain === 'broken', JSON.stringify(r.body.integrity));
  fs.writeFileSync(auditFile, original);
  r = await audit(gA);
  check('...and put back, the chain verifies again', r.body.integrity.chain === 'ok', JSON.stringify(r.body.integrity));

  console.log('STEP 9: concurrent writers');
  const before = (await audit(gAdmin)).body.integrity.lastSeq;
  const burst = await Promise.all(Array.from({ length: 30 }, async () => audit(gAdmin, 'alpha')));
  check('30 reads at once all succeed', burst.every((x) => x.status === 200), JSON.stringify(burst.map((x) => x.status)));
  r = await audit(gAdmin, 'alpha');
  check('every one of them was recorded and the chain is intact (no lost or doubled entries)', r.body.integrity.chain === 'ok' && r.body.integrity.lastSeq === before + 1 + 30, JSON.stringify([before, r.body.integrity]));
  const seqs = auditLines().map((x) => x.seq);
  check('the sequence numbers are contiguous', seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1), JSON.stringify(seqs.slice(-40)));

  console.log('STEP 10: bounds');
  await restartPresence(presenceKind, { MODERATION_AUDIT_MAX_BYTES: '6000', MODERATION_AUDIT_RETENTION_DAYS: '0.00006' });
  const gAdmin2 = await getGrant(iss1, admin, { worlds: ['alpha'] });
  for (let i = 0; i < 40; i++) await audit(gAdmin2, 'alpha');
  const sizeNow = fs.statSync(auditFile).size;
  r = await audit(gAdmin2, 'alpha');
  check('the file stays within its size bound (plus one entry) and the chain still verifies after trimming', sizeNow <= 6000 + 700 && r.body.integrity.chain === 'ok' && r.body.integrity.entries < 40, JSON.stringify([sizeNow, r.body.integrity]));
  check('...the oldest entries were dropped and a base line carries the chain', auditLines()[0].base !== undefined && Number.isInteger(auditLines()[0].base.seq), auditText().slice(0, 200));
  await sleep(6500); // past the age bound
  await audit(gAdmin2, 'alpha');
  r = await audit(gAdmin2, 'alpha');
  const aged = r.body.integrity.entries;
  check('entries older than the age bound are dropped (only the newest remain) and the chain verifies', r.body.integrity.chain === 'ok' && aged <= 3, JSON.stringify(r.body.integrity));
  results['bounds'] = 'size ok, age ok';

  console.log('STEP 11: no recording, no action');
  await restartPresence(presenceKind, { PRESENCE_MODERATION_AUDIT_FILE: path.join(os.tmpdir(), 'atlas-au-missing-dir-' + b64(6), 'nested', 'audit.jsonl') });
  const gC = await getGrant(iss1, modA);
  const rl = await list(gC);
  check('with the log unwritable, reading the roster still works', rl.status === 200, show(rl));
  // After the restart the sessions are gone (in-memory server) or kept (PHP); join again to have a target.
  const VX = newVisit();
  await pjoin(D1, 'alpha', 'Xavier', VX); const xc = await cjoin(D1, 'alpha', 'Xavier', VX);
  const rl2 = await list(gC);
  const xref = rl2.body.participants.find((p) => p.name === 'Xavier').ref;
  r = expect('a command is refused when it cannot be recorded: 503', await cmd(gC, 'chat.mute', xref, { durationSeconds: 60, cause: 'spam' }), 503, 'audit-unavailable');
  await sleep(450);
  const sent = await csend(xc.body.id, 'still free to talk');
  check('...and nothing was done (the visitor can still chat)', sent.status === 200 && sent.body.ok === true, show(sent));
  r = expect('reading the log with no log yields an empty, honest answer', await audit(gC, 'alpha'), 200);
  check('...no entries and no invented integrity claim of damage', r.body.entries.length === 0 && r.body.integrity.chain === 'ok', show(r));

  console.log('STEP 12: moderation unconfigured keeps chat and presence working');
  fs.rmSync(cfgFile);
  await restartPresence(presenceKind, {});
  const VY = newVisit();
  const yp = await must(pjoin(D1, 'alpha', 'Yolanda', VY)), yc = await must(cjoin(D1, 'alpha', 'Yolanda', VY));
  await sleep(450);
  const said = await csend(yc.id, 'hello world');
  check('presence and chat work with no moderation configuration', !!yp.id && !!yc.id && said.status === 200 && said.body.ok === true, show(said));
  expect('a moderation command says so plainly: 503', await cmd(gC, 'chat.mute', xref, { durationSeconds: 60, cause: 'spam' }), 503, 'moderation-not-configured');
  expect('so does the audit read: 503', await audit(gC, 'alpha'), 503, 'moderation-not-configured');
  const preUn = await rq('OPTIONS', COMMAND, undefined, { headers: { Origin: 'http://' + D1, 'Access-Control-Request-Method': 'POST' } });
  check('and no origin is allowed to call it from a browser', !preUn.headers['access-control-allow-origin'], JSON.stringify(preUn.headers));
  setConfig(baseConfig());

  console.log('STEP 13: browser access (CORS)');
  const origin = 'http://' + D1;
  let pre = await rq('OPTIONS', COMMAND, undefined, { headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  check('a configured domain\'s origin is allowed to POST, with only Content-Type', pre.status === 204 && pre.headers['access-control-allow-origin'] === origin && /POST/.test(pre.headers['access-control-allow-methods']) && /content-type/i.test(pre.headers['access-control-allow-headers']) && /Origin/i.test(pre.headers['vary'] || ''), JSON.stringify(pre.headers));
  check('...never with wildcard or credentials', pre.headers['access-control-allow-origin'] !== '*' && !pre.headers['access-control-allow-credentials'], JSON.stringify(pre.headers));
  for (const [name, o] of [['an unrelated site', 'https://evil.example'], ['a lookalike of a configured domain', 'http://localhost:93510'], ['no origin', undefined]]) {
    pre = await rq('OPTIONS', COMMAND, undefined, o ? { headers: { Origin: o, 'Access-Control-Request-Method': 'POST' } } : {});
    check(name + ' gets no CORS permission', !pre.headers['access-control-allow-origin'], JSON.stringify(pre.headers));
  }
  for (const route of [ROSTER, AUDIT]) {
    pre = await rq('OPTIONS', route, undefined, { headers: { Origin: 'http://' + D2, 'Access-Control-Request-Method': 'POST' } });
    check('the second configured domain\'s origin is allowed on ' + route, pre.headers['access-control-allow-origin'] === 'http://' + D2, JSON.stringify(pre.headers));
  }
  const gD = await getGrant(iss1, modA);
  const post = await rq('POST', ROSTER, await requestBody(gD, 'roster.view', ''), { src: nextSrc(), headers: { Origin: origin } });
  check('a real answer carries the allowing header for that origin only (and Vary: Origin)', post.status === 200 && post.headers['access-control-allow-origin'] === origin && /Origin/i.test(post.headers['vary'] || ''), JSON.stringify(post.headers));
  const post2 = await rq('POST', ROSTER, await requestBody(gD, 'roster.view', ''), { src: nextSrc(), headers: { Origin: 'https://evil.example' } });
  check('...and none for another site (it still works for non-browser callers, which is how grants are meant to be used)', post2.status === 200 && !post2.headers['access-control-allow-origin'], JSON.stringify(post2.headers));
  const other = await rq('OPTIONS', '/presence/poll/join', undefined, { headers: { Origin: 'https://evil.example' } });
  check('other routes keep their previous behaviour', other.status === 204 || other.status === 200 || other.status === 404 || other.status === 405 || other.status === 400, JSON.stringify([other.status, other.headers]));

  console.log('STEP 14: a last look at everything stored');
  const finalText = auditText() + '\n' + seen.join('\n');
  const leaked = [...identities.map((i) => i.publicKey), ...pops, ...visitIds, ...joinedTokens, 'Alice', 'Bob', 'Eve', 'Xavier', 'Yolanda', '127.0.0.', 'still free to talk', 'hello world'].filter((n) => n && finalText.includes(n));
  check('still nothing identifying in the log or in any answer to an audit read', leaked.length === 0, JSON.stringify(leaked));

  return Object.assign({}, results);
}
function noAuditRef(g) { return g.grant.payload.moderatorRef; }

(async () => {
  let all = [];
  try {
    const combos = MATRIX ? [['node', 'node'], ['node', 'php'], ['php', 'node'], ['php', 'php']] : [[ARGS[0] === 'php' ? 'php' : 'node', ARGS[1] || (ARGS[0] === 'php' ? 'php' : 'node')]];
    for (const [p, i] of combos) {
      for (const k of Object.keys(results)) delete results[k];
      seen.length = 0; joinedTokens.length = 0; visitIds.length = 0; identities.length = 0; pops.length = 0;
      all.push(await scenario(p, i));
      await killAll();
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
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL MODERATION AUDIT CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
