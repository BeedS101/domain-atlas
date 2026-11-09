// Admin panel backend (issuer-php): the suspended-credentials list, the Site status report and the emergency
// pause switches. Runs against an isolated copy of issuer-php on PHP's built-in server, with real signed admin
// logins. Covers authentication (anonymous, garbage token, moderator, signed proof and its replay), that the list
// matches what is enforced, that no planted secret ever appears in a response, and that a pause only switches a
// feature off, keeps every other setting, never touches a file it cannot parse, and refuses what it must not touch.
//   node test/admin-site-status-php.js
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { webcrypto } = crypto;
const { withAdminAuth } = require('./lib/admin-auth');
const { subtle } = webcrypto;

const BUNDLE_DIR = path.resolve(__dirname, '..', 'issuer-php');
let failures = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => console.log('ok   ' + name), (e) => { failures++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 6).join('\n     ')); });

const b64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}
async function genIdentity() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { kp, publicKey: b64url(new Uint8Array(await subtle.exportKey('raw', kp.publicKey))) };
}
async function signWithSelf(id, payload) {
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, id.kp.privateKey, new TextEncoder().encode(canonicalize(payload))));
  return { signerRole: 'raw-ecdsa', publicKey: id.publicKey, signature: b64url(sig) };
}
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-site-status-'));
  const bundle = path.join(tmpRoot, 'domain');
  fs.cpSync(BUNDLE_DIR, bundle, { recursive: true });
  const port = await freePort();
  const BASE = 'http://localhost:' + port;
  const proc = spawn('php', ['-S', 'localhost:' + port, 'test-router.php'], { cwd: bundle, env: { ...process.env, ATLAS_PRIVATE_MINT: 'off' }, stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr = [];
  proc.stderr.on('data', (d) => stderr.push(d.toString()));
  for (let i = 0; i < 100 && !stderr.join('').includes('started'); i++) await new Promise((r) => setTimeout(r, 50));
  const everything = []; // every response body, searched for planted secrets at the end

  const post = async (urlPath, body) => {
    const r = await fetch(BASE + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const text = await r.text(); everything.push(text);
    let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: r.status, body: json, text };
  };
  const get = async (urlPath) => { const r = await fetch(BASE + urlPath); const text = await r.text(); everything.push(text); return { status: r.status, body: JSON.parse(text) }; };
  const lib = (f) => path.join(bundle, 'lib', f);
  const wk = (f) => path.join(bundle, '.well-known', f);

  const admin = await genIdentity(), moderator = await genIdentity();
  fs.writeFileSync(lib('atlas-admin-keys-store.json'), JSON.stringify({ keys: [
    { publicKey: admin.publicKey, addedAt: new Date().toISOString() },
    { publicKey: moderator.publicKey, addedAt: new Date().toISOString(), role: 'moderator', worlds: ['plaza'], operations: ['mute'] }
  ] }));
  async function login(id) {
    const nonce = (await get('/atlas/admin/session/nonce')).body.nonce;
    const payload = withAdminAuth({ nonce }, BASE, '/atlas/admin/session/start');
    const res = await post('/atlas/admin/session/start', { payload, proof: await signWithSelf(id, payload) });
    assert.strictEqual(res.status, 200, res.text);
    return res.body.token;
  }
  const adminToken = await login(admin), modToken = await login(moderator);
  const asAdmin = (p, payload) => post(p, { payload: payload || {}, token: adminToken });
  const issue = async () => { const r = await post('/atlas/asset/issue', { ownerPublicKey: 'owner-' + crypto.randomBytes(6).toString('hex'), assetClass: 'atlas.trophy.chess', quantity: 1 }); assert.strictEqual(r.status, 200, r.text); return r.body.id; };
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

  // ---- suspended credentials list ---------------------------------------------------------------------------
  await check('suspensions: anonymous, garbage-token and moderator requests are refused', async () => {
    assert.strictEqual((await post('/atlas/admin/suspensions', {})).status, 401);
    assert.strictEqual((await post('/atlas/admin/suspensions', { payload: {}, token: 'not-a-token' })).status, 401);
    const m = await post('/atlas/admin/suspensions', { payload: {}, token: modToken });
    assert.strictEqual(m.status, 403); assert.strictEqual(m.body.code, 'insufficient-role');
  });

  await check('suspensions: starts empty, lists newest first with every field, and unsuspend removes the row', async () => {
    let r = await asAdmin('/atlas/admin/suspensions');
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.total, 0); assert.deepStrictEqual(r.body.suspended, []);
    assert.ok(/^\d{4}-\d\d-\d\dT/.test(r.body.now));
    const a = await issue(), b = await issue();
    const later = new Date(Date.now() + 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
    assert.strictEqual((await asAdmin('/atlas/suspend', { id: a, reason: 'fraud-report', expiresAt: later })).status, 200);
    await new Promise((res) => setTimeout(res, 1100));
    assert.strictEqual((await asAdmin('/atlas/suspend', { id: b })).status, 200);
    r = await asAdmin('/atlas/admin/suspensions');
    assert.strictEqual(r.body.total, 2);
    assert.deepStrictEqual(r.body.suspended.map((s) => s.id), [b, a], 'newest first');
    assert.strictEqual(r.body.suspended[1].reason, 'fraud-report');
    assert.strictEqual(r.body.suspended[1].expiresAt, later);
    assert.strictEqual(r.body.suspended[0].expiresAt, null);
    assert.strictEqual(r.body.suspended[0].reason, 'issuer-request');
    assert.deepStrictEqual(Object.keys(r.body.suspended[0]).sort(), ['expiresAt', 'id', 'onExpire', 'reason', 'suspendedAt']);
    const un = await asAdmin('/atlas/unsuspend', { id: a });
    assert.strictEqual(un.body.wasSuspended, true);
    r = await asAdmin('/atlas/admin/suspensions');
    assert.deepStrictEqual(r.body.suspended.map((s) => s.id), [b]);
    await asAdmin('/atlas/unsuspend', { id: b });
  });

  await check('suspensions: an expired entry is resolved first (lifted, or revoked for "finalize"), never listed as active', async () => {
    const lift = await issue(), fin = await issue(), live = await issue();
    const past = '2020-01-01T00:00:00Z', future = new Date(Date.now() + 3600e3).toISOString();
    fs.writeFileSync(wk('atlas-suspensions.json'), JSON.stringify({ suspended: [
      { id: lift, suspendedAt: past, reason: 'old', expiresAt: past, onExpire: 'lift' },
      { id: fin, suspendedAt: past, reason: 'door-scan', expiresAt: past, onExpire: 'finalize' },
      { id: live, suspendedAt: past, reason: 'still on', expiresAt: future, onExpire: 'lift' }
    ] }));
    const r = await asAdmin('/atlas/admin/suspensions');
    assert.deepStrictEqual(r.body.suspended.map((s) => s.id), [live]);
    const revoked = fs.readFileSync(wk('atlas-revocations.json'), 'utf8');
    assert.ok(revoked.includes(fin) && !revoked.includes(lift), 'the finalize entry is revoked on expiry, the lift entry is not');
    await asAdmin('/atlas/unsuspend', { id: live });
  });

  await check('suspensions: odd entries are skipped, long text is clipped, hostile text is returned as data', async () => {
    fs.writeFileSync(wk('atlas-suspensions.json'), JSON.stringify({ suspended: [
      { id: '<img src=x onerror=alert(1)>' + 'I'.repeat(500), suspendedAt: '2026-01-01T00:00:00Z', reason: 'R'.repeat(900), expiresAt: null },
      { id: 12345 }, 'nope', { reason: 'no id' }
    ] }));
    const r = await asAdmin('/atlas/admin/suspensions');
    assert.strictEqual(r.body.total, 1);
    assert.ok(r.body.suspended[0].id.startsWith('<img src=x') && r.body.suspended[0].id.length === 300 && r.body.suspended[0].reason.length === 200);
    fs.writeFileSync(wk('atlas-suspensions.json'), JSON.stringify({ suspended: [] }));
  });

  await check('suspensions: a signed proof works, is bound to this route, and cannot be replayed', async () => {
    const payload = withAdminAuth({}, BASE, '/atlas/admin/suspensions');
    const proof = await signWithSelf(admin, payload);
    const ok = await post('/atlas/admin/suspensions', { payload, proof });
    assert.strictEqual(ok.status, 200);
    const replay = await post('/atlas/admin/suspensions', { payload, proof });
    assert.strictEqual(replay.status, 401); assert.strictEqual(replay.body.code, 'replayed-request');
    const wrongRoute = withAdminAuth({}, BASE, '/atlas/admin/visits');
    const wr = await post('/atlas/admin/suspensions', { payload: wrongRoute, proof: await signWithSelf(admin, wrongRoute) });
    assert.strictEqual(wr.status, 400);
  });

  // ---- site status ------------------------------------------------------------------------------------------
  const SECRETS = ['PLANTED-SMTP-PASS', 'PLANTED-IMAP-PASS', 'PLANTED-ADMIN-HASH', 'PLANTED-STUDIO-KEY', 'planted-from@secret.example', 'PLANTED-TURN-SECRET', 'PLANTED-LEDGER-SECRET'];
  const status = async () => { const r = await asAdmin('/atlas/admin/site-status'); assert.strictEqual(r.status, 200, r.text); return Object.fromEntries(r.body.features.map((f) => [f.id, f])); };
  const registry = JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR, 'lib/site-features.json'), 'utf8')).features;

  await check('site status: anonymous, garbage-token and moderator requests are refused; admins see every feature and which can be paused', async () => {
    assert.strictEqual((await post('/atlas/admin/site-status', {})).status, 401);
    assert.strictEqual((await post('/atlas/admin/site-status', { payload: {}, token: 'x' })).status, 401);
    assert.strictEqual((await post('/atlas/admin/site-status', { payload: {}, token: modToken })).status, 403);
    const f = await status();
    assert.deepStrictEqual(Object.keys(f).sort(), registry.map((x) => x.id).sort());
    assert.deepStrictEqual(Object.values(f).filter((x) => x.pausable).map((x) => x.id).sort(), ['ledger-issuance', 'ledger-receipts', 'multi-issuer', 'studio-mint', 'txlab']);
    for (const x of Object.values(f)) assert.ok(['on', 'off', 'problem', 'absent'].includes(x.state) && x.enable && x.disable, x.id);
    assert.strictEqual(f['studio-mint'].state, 'off');
    assert.strictEqual(f['call-service'].state, 'absent', 'Call is not part of issuer-php');
  });

  const priv = fs.mkdtempSync(path.join(tmpRoot, 'studio-private-'));
  const studioCfg = path.join(priv, 'studio-config.json');
  const ledgerCfg = lib('atlas-ledger-issuance-config.json');
  await check('site status: reports what is on, and never a password, token, key or mail address from any config', async () => {
    fs.writeFileSync(path.join(bundle, 'atlas/studio/inc/storage-root.php'), '<?php return ' + JSON.stringify(priv) + ';');
    fs.writeFileSync(studioCfg, JSON.stringify({ mintEnabled: true, domain: 'localhost:' + port, origins: ['http://localhost:' + port], apiKey: 'PLANTED-STUDIO-KEY', meta: {} }, null, 2));
    fs.writeFileSync(ledgerCfg, JSON.stringify({ enabled: true, domain: 'localhost:' + port, perClientPerMinute: 7, secret: 'PLANTED-LEDGER-SECRET', extra: {} }));
    fs.writeFileSync(lib('atlas-email-tickets-config.json'), JSON.stringify({ smtpHost: 'smtp.example.net', smtpUser: 'u', smtpPass: 'PLANTED-SMTP-PASS', fromAddress: 'planted-from@secret.example', imapHost: 'imap.example.net', imapPass: 'PLANTED-IMAP-PASS' }));
    const f = await status();
    assert.strictEqual(f['studio-mint'].state, 'on', JSON.stringify(f['studio-mint']));
    assert.strictEqual(f['ledger-issuance'].state, 'on');
    assert.ok(f['ledger-issuance'].facts.includes('perClientPerMinute: 7'));
    assert.strictEqual(f['email-tickets'].state, 'on');
    for (const s of SECRETS) assert.ok(!JSON.stringify(f).includes(s), s);
  });

  await check('site status: a missing registry degrades to an empty list, not an error', async () => {
    const reg = lib('site-features.json'); const keep = fs.readFileSync(reg); fs.unlinkSync(reg);
    const r = await asAdmin('/atlas/admin/site-status');
    fs.writeFileSync(reg, keep);
    assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.body.features, []);
  });

  // ---- pause switches ---------------------------------------------------------------------------------------
  const pause = (feature, token) => post('/atlas/admin/site-pause', { payload: { feature }, token: token === undefined ? adminToken : token });
  const leftovers = (dir) => fs.readdirSync(dir).filter((n) => /\.tmp$/.test(n));

  await check('pause: needs a valid administrator, a well-formed feature id, and changes nothing otherwise', async () => {
    const before = sha(ledgerCfg);
    assert.strictEqual((await pause('ledger-issuance', null)).status, 401);
    assert.strictEqual((await pause('ledger-issuance', 'bad')).status, 401);
    assert.strictEqual((await pause('ledger-issuance', modToken)).status, 403);
    assert.strictEqual((await post('/atlas/admin/site-pause', { payload: {}, token: adminToken })).status, 400);
    assert.strictEqual((await pause('../../etc/passwd')).status, 400);
    assert.strictEqual((await pause('no-such-feature')).status, 404);
    assert.strictEqual(sha(ledgerCfg), before, 'the config is untouched');
  });

  await check('pause: only switchable features, and never credentials, renames or mail settings', async () => {
    const emailCfg = lib('atlas-email-tickets-config.json');
    const before = sha(emailCfg);
    for (const id of ['email-tickets', 'moderation-issuer', 'file-transfer', 'call-service', 'presence-moderation', 'private-state-dir']) {
      const r = await pause(id);
      assert.strictEqual(r.status, 409, id + ' ' + r.text); assert.strictEqual(r.body.code, 'not-pausable');
    }
    assert.strictEqual(sha(emailCfg), before);
  });

  await check('pause: a JSON switch is set to false, every other setting is kept, repeating it changes nothing', async () => {
    fs.chmodSync(ledgerCfg, 0o640);
    const r = await pause('ledger-issuance');
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.body.changed, true); assert.strictEqual(r.body.state, 'off');
    const after = JSON.parse(fs.readFileSync(ledgerCfg, 'utf8'));
    assert.deepStrictEqual(after, { enabled: false, domain: 'localhost:' + port, perClientPerMinute: 7, secret: 'PLANTED-LEDGER-SECRET', extra: {} });
    assert.ok(/"extra": \{\}/.test(fs.readFileSync(ledgerCfg, 'utf8')), 'an empty object stays an object');
    assert.strictEqual(fs.statSync(ledgerCfg).mode & 0o777, 0o640, 'permissions are kept');
    assert.deepStrictEqual(leftovers(path.join(bundle, 'lib')), []);
    const again = await pause('ledger-issuance');
    assert.strictEqual(again.body.changed, false); assert.strictEqual(again.body.state, 'off');
    assert.strictEqual((await status())['ledger-issuance'].state, 'off');
  });

  await check('pause: a paused feature with no config file is already off; an unparsable config is never rewritten', async () => {
    const receipts = lib('atlas-ledger-receipts-config.json');
    const r1 = await pause('ledger-receipts');
    assert.ok(r1.status === 200 && r1.body.changed === false && r1.body.state === 'off');
    assert.ok(!fs.existsSync(receipts), 'pausing does not create a config');
    fs.writeFileSync(receipts, '{ "enabled": true, ');
    const before = sha(receipts);
    const r2 = await pause('ledger-receipts');
    assert.strictEqual(r2.status, 409); assert.strictEqual(r2.body.code, 'unreadable-config');
    assert.strictEqual(sha(receipts), before);
    fs.writeFileSync(receipts, '[1,2,3]');
    assert.strictEqual((await pause('ledger-receipts')).body.code, 'unreadable-config');
    fs.unlinkSync(receipts);
  });

  await check('pause: Studio minting is switched off in the Studio private folder', async () => {
    const r = await pause('studio-mint');
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.body.changed, true);
    const after = JSON.parse(fs.readFileSync(studioCfg, 'utf8'));
    assert.strictEqual(after.mintEnabled, false);
    assert.strictEqual(after.apiKey, 'PLANTED-STUDIO-KEY'); assert.deepStrictEqual(after.meta, {}); assert.strictEqual(after.domain, 'localhost:' + port);
    assert.strictEqual((await status())['studio-mint'].state, 'off');
    assert.deepStrictEqual(leftovers(priv), []);
    assert.strictEqual((await pause('studio-mint')).body.changed, false);
  });

  await check('pause: a lab is switched off with a DISABLED file in its private folder; unsafe folders are refused', async () => {
    const labPriv = fs.mkdtempSync(path.join(tmpRoot, 'lab-private-'));
    const pointer = path.join(bundle, 'atlas/demo/txlab/inc/private-dir.php');
    fs.writeFileSync(pointer, '<?php return ' + JSON.stringify(labPriv) + ';');
    fs.writeFileSync(path.join(labPriv, 'config.php'), "<?php\nreturn array (\n  'enabled' => true,\n  'domain' => 'localhost:" + port + "',\n  'adminTokenHash' => 'PLANTED-ADMIN-HASH',\n);\n");
    assert.strictEqual((await status()).txlab.state, 'on');
    const cfgBefore = sha(path.join(labPriv, 'config.php'));
    const r = await pause('txlab');
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual(r.body.changed, true); assert.strictEqual(r.body.state, 'off');
    assert.ok(fs.existsSync(path.join(labPriv, 'DISABLED')) && /paused from the admin panel/.test(fs.readFileSync(path.join(labPriv, 'DISABLED'), 'utf8')));
    assert.strictEqual(sha(path.join(labPriv, 'config.php')), cfgBefore, 'config.php is not touched');
    assert.strictEqual((await pause('txlab')).body.changed, false);
    assert.ok(/DISABLED/.test((await status()).txlab.reasons.join(' ')));
    // inside the web root, or missing: nothing is created
    const inside = path.join(bundle, 'lab-inside'); fs.mkdirSync(inside);
    fs.writeFileSync(pointer, '<?php return ' + JSON.stringify(inside) + ';');
    const unsafe = await pause('txlab');
    assert.strictEqual(unsafe.status, 409); assert.strictEqual(unsafe.body.code, 'unsafe-folder');
    assert.ok(!fs.existsSync(path.join(inside, 'DISABLED')));
    fs.writeFileSync(pointer, '<?php return "/nonexistent/lab-folder";');
    assert.strictEqual((await pause('txlab')).body.code, 'unsafe-folder');
    fs.unlinkSync(pointer);
    assert.strictEqual((await pause('txlab')).body.changed, false, 'no pointer means it is already off');
    assert.strictEqual((await pause('multi-issuer')).body.state, 'off');
  });

  await check('pause: a signed proof can pause, and the proof cannot be replayed', async () => {
    fs.writeFileSync(ledgerCfg, JSON.stringify({ enabled: true, domain: 'localhost:' + port }));
    const payload = withAdminAuth({ feature: 'ledger-issuance' }, BASE, '/atlas/admin/site-pause');
    const proof = await signWithSelf(admin, payload);
    assert.strictEqual((await post('/atlas/admin/site-pause', { payload, proof })).body.changed, true);
    fs.writeFileSync(ledgerCfg, JSON.stringify({ enabled: true, domain: 'localhost:' + port }));
    const replay = await post('/atlas/admin/site-pause', { payload, proof });
    assert.strictEqual(replay.status, 401);
    assert.strictEqual(JSON.parse(fs.readFileSync(ledgerCfg, 'utf8')).enabled, true, 'a replayed request changed nothing');
  });

  await check('no response in this run contained a planted secret', () => {
    const joined = everything.join('\n');
    for (const s of SECRETS) assert.ok(!joined.includes(s), s);
  });

  proc.kill();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log(failures ? '\n' + failures + ' check(s) failed.' : '\nAll admin site status checks passed (PHP).');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
