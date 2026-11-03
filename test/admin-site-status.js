// Admin panel backend, run against either issuer with the same assertions:
//
//   node test/admin-site-status.js node
//   node test/admin-site-status.js php
//
// The suspended-credentials list, the Site status report and the emergency pause switches: authentication
// (anonymous, garbage token, moderator, signed proof and replay), the list matching what is enforced, no planted
// secret in any response, and a pause that only switches a feature off, keeps every other setting, and refuses
// what it must not touch. issuer-php has more features and more cases; see test/admin-site-status-php.js.
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const H = require('./lib/delivery-harness');
const { withAdminAuth } = require('./lib/admin-auth');

const KIND = process.argv[2] === 'php' ? 'php' : 'node';
let failures = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => console.log('ok   ' + name), (e) => { failures++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 6).join('\n     ')); });
const LEDGER_HOST = require('../issuer-server/lib-ledger-issuance').HOSTS[0];
const SECRETS = ['PLANTED-SMTP-PASS', 'PLANTED-IMAP-PASS', 'planted-from@secret.example', 'PLANTED-LEDGER-SECRET'];

(async () => {
  const port = KIND === 'node' ? 9411 : 9412;
  const BASE = 'http://localhost:' + port;
  const env = { ATLAS_ADMIN_FAIL_LIMIT: '1000' };
  let stateOf, wellKnown;
  if (KIND === 'node') {
    // email settings come from the environment on Node; the passwords must never be reported
    Object.assign(env, { ATLAS_EMAIL_SMTP_HOST: '127.0.0.1', ATLAS_EMAIL_SMTP_PORT: '2525', ATLAS_EMAIL_SMTP_USER: 'u', ATLAS_EMAIL_SMTP_PASS: 'PLANTED-SMTP-PASS', ATLAS_EMAIL_FROM_ADDRESS: 'planted-from@secret.example' });
  }
  let issuer, stateDir, docroot, bundleDir;
  if (KIND === 'node') {
    docroot = H.tmpDir('atlas-sitestatus-docroot-');
    fs.cpSync(path.join(H.ROOT, 'demo-domain-a'), docroot, { recursive: true });
    stateDir = H.tmpDir('atlas-sitestatus-state-');
    issuer = await H.startNodeIssuer({ port, stateDir, docrootDir: docroot, env });
    stateOf = (n) => path.join(stateDir, n); wellKnown = (n) => path.join(docroot, '.well-known', n);
  } else {
    bundleDir = H.preparePhpBundle();
    issuer = await H.startPhpIssuer({ port, bundleDir, env });
    stateOf = (n) => path.join(bundleDir, 'lib', n); wellKnown = (n) => path.join(bundleDir, '.well-known', n);
    fs.writeFileSync(wellKnown('atlas-revocations.json'), JSON.stringify({ revoked: [] }));
    fs.writeFileSync(stateOf('atlas-email-tickets-config.json'), JSON.stringify({ smtpHost: '127.0.0.1', smtpPass: 'PLANTED-SMTP-PASS', fromAddress: 'planted-from@secret.example', imapHost: 'imap.example.net', imapPass: 'PLANTED-IMAP-PASS', smtpUser: 'u', imapUser: 'i' }));
  }
  const everything = [];
  const post = async (p, body) => { const r = await H.postJson(BASE, p, body); everything.push(JSON.stringify(r.body)); return r; };
  const admin = await H.genIdentity(), moderator = await H.genIdentity();
  fs.writeFileSync(stateOf('atlas-admin-keys-store.json'), JSON.stringify({ keys: [
    { publicKey: admin.publicKey, addedAt: new Date().toISOString() },
    { publicKey: moderator.publicKey, addedAt: new Date().toISOString(), role: 'moderator', worlds: ['plaza'], operations: ['mute'] }
  ] }));
  async function login(id) {
    const nonce = (await H.getJson(BASE, '/atlas/admin/session/nonce')).body.nonce;
    const payload = withAdminAuth({ nonce }, BASE, '/atlas/admin/session/start');
    const r = await post('/atlas/admin/session/start', { payload, proof: await H.signWithSelf(id, payload) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.token;
  }
  const adminToken = await login(admin), modToken = await login(moderator);
  const asAdmin = (p, payload) => post(p, { payload: payload || {}, token: adminToken });
  const issue = async () => (await H.issueAsset(BASE, 'owner-' + crypto.randomBytes(6).toString('hex'), 'atlas.trophy.chess', 1)).id;
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const ledgerCfg = stateOf('atlas-ledger-issuance-config.json');
  // the PHP reader requires the config domain to be the request host; the Node server pins its own
  const LEDGER_DOMAIN = KIND === 'php' ? 'localhost:' + port : LEDGER_HOST;

  try {
    await check('suspensions: anonymous, garbage-token and moderator requests are refused', async () => {
      assert.strictEqual((await post('/atlas/admin/suspensions', {})).status, 401);
      assert.strictEqual((await post('/atlas/admin/suspensions', { payload: {}, token: 'not-a-token' })).status, 401);
      const m = await post('/atlas/admin/suspensions', { payload: {}, token: modToken });
      assert.strictEqual(m.status, 403); assert.strictEqual(m.body.code, 'insufficient-role');
    });

    await check('suspensions: lists newest first with every field, and unsuspend removes the row', async () => {
      fs.writeFileSync(wellKnown('atlas-suspensions.json'), JSON.stringify({ suspended: [] }));
      let r = await asAdmin('/atlas/admin/suspensions');
      assert.strictEqual(r.status, 200); assert.strictEqual(r.body.total, 0); assert.deepStrictEqual(r.body.suspended, []);
      const a = await issue(), b = await issue();
      const later = new Date(Date.now() + 3600e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
      assert.strictEqual((await asAdmin('/atlas/suspend', { id: a, reason: 'fraud-report', expiresAt: later })).status, 200);
      await new Promise((res) => setTimeout(res, 1100));
      assert.strictEqual((await asAdmin('/atlas/suspend', { id: b })).status, 200);
      r = await asAdmin('/atlas/admin/suspensions');
      assert.deepStrictEqual(r.body.suspended.map((s) => s.id), [b, a], 'newest first');
      assert.strictEqual(r.body.suspended[1].reason, 'fraud-report'); assert.strictEqual(r.body.suspended[1].expiresAt, later);
      assert.strictEqual(r.body.suspended[0].expiresAt, null); assert.strictEqual(r.body.suspended[0].reason, 'issuer-request');
      assert.deepStrictEqual(Object.keys(r.body.suspended[0]).sort(), ['expiresAt', 'id', 'onExpire', 'reason', 'suspendedAt']);
      assert.strictEqual((await asAdmin('/atlas/unsuspend', { id: a })).body.wasSuspended, true);
      assert.deepStrictEqual((await asAdmin('/atlas/admin/suspensions')).body.suspended.map((s) => s.id), [b]);
      await asAdmin('/atlas/unsuspend', { id: b });
    });

    await check('suspensions: an expired entry is resolved first (lifted, or revoked for "finalize"), never listed as active', async () => {
      const lift = await issue(), fin = await issue(), live = await issue();
      const past = '2020-01-01T00:00:00Z', future = new Date(Date.now() + 3600e3).toISOString();
      fs.writeFileSync(wellKnown('atlas-suspensions.json'), JSON.stringify({ suspended: [
        { id: lift, suspendedAt: past, reason: 'old', expiresAt: past, onExpire: 'lift' },
        { id: fin, suspendedAt: past, reason: 'door-scan', expiresAt: past, onExpire: 'finalize' },
        { id: live, suspendedAt: past, reason: 'still on', expiresAt: future, onExpire: 'lift' }
      ] }));
      assert.deepStrictEqual((await asAdmin('/atlas/admin/suspensions')).body.suspended.map((s) => s.id), [live]);
      const revoked = fs.readFileSync(wellKnown('atlas-revocations.json'), 'utf8');
      assert.ok(revoked.includes(fin) && !revoked.includes(lift));
      await asAdmin('/atlas/unsuspend', { id: live });
    });

    await check('suspensions: odd entries are skipped, long text is clipped, hostile text is returned as data', async () => {
      fs.writeFileSync(wellKnown('atlas-suspensions.json'), JSON.stringify({ suspended: [
        { id: '<img src=x onerror=alert(1)>' + 'I'.repeat(500), suspendedAt: '2026-01-01T00:00:00Z', reason: 'R'.repeat(900), expiresAt: null },
        { id: 12345 }, { reason: 'no id' }
      ] }));
      const r = await asAdmin('/atlas/admin/suspensions');
      assert.strictEqual(r.body.total, 1);
      assert.ok(r.body.suspended[0].id.startsWith('<img src=x') && r.body.suspended[0].id.length === 300 && r.body.suspended[0].reason.length === 200);
      fs.writeFileSync(wellKnown('atlas-suspensions.json'), JSON.stringify({ suspended: [] }));
    });

    await check('suspensions: a signed proof works, is bound to this route, and cannot be replayed', async () => {
      const payload = withAdminAuth({}, BASE, '/atlas/admin/suspensions');
      const proof = await H.signWithSelf(admin, payload);
      assert.strictEqual((await post('/atlas/admin/suspensions', { payload, proof })).status, 200);
      assert.strictEqual((await post('/atlas/admin/suspensions', { payload, proof })).body.code, 'replayed-request');
      const wrong = withAdminAuth({}, BASE, '/atlas/admin/visits');
      assert.strictEqual((await post('/atlas/admin/suspensions', { payload: wrong, proof: await H.signWithSelf(admin, wrong) })).status, 400);
    });

    const status = async () => { const r = await asAdmin('/atlas/admin/site-status'); assert.strictEqual(r.status, 200, JSON.stringify(r.body)); return Object.fromEntries(r.body.features.map((f) => [f.id, f])); };

    await check('site status: anonymous, garbage-token and moderator requests are refused; admins see the features this server has', async () => {
      assert.strictEqual((await post('/atlas/admin/site-status', {})).status, 401);
      assert.strictEqual((await post('/atlas/admin/site-status', { payload: {}, token: 'x' })).status, 401);
      assert.strictEqual((await post('/atlas/admin/site-status', { payload: {}, token: modToken })).status, 403);
      const f = await status();
      if (KIND === 'node') assert.deepStrictEqual(Object.keys(f).sort(), ['email-tickets', 'ledger-issuance', 'moderation-issuer']);
      else assert.ok(Object.keys(f).length >= 11);
      assert.deepStrictEqual(Object.values(f).filter((x) => x.pausable).map((x) => x.id).filter((id) => id === 'ledger-issuance'), ['ledger-issuance']);
      assert.ok(!f['email-tickets'].pausable);
      for (const x of Object.values(f)) assert.ok(['on', 'off', 'problem', 'absent'].includes(x.state) && x.enable && x.disable && Array.isArray(x.reasons) && Array.isArray(x.facts), x.id);
      assert.strictEqual(f['ledger-issuance'].state, 'off');
    });

    await check('site status: reports what is on and never a password, mail address or other secret', async () => {
      fs.writeFileSync(ledgerCfg, JSON.stringify({ enabled: true, domain: LEDGER_DOMAIN, perClientPerMinute: 7, secret: 'PLANTED-LEDGER-SECRET', extra: {} }));
      const f = await status();
      assert.strictEqual(f['ledger-issuance'].state, 'on', JSON.stringify(f['ledger-issuance']));
      assert.ok(f['ledger-issuance'].facts.includes('perClientPerMinute: 7'));
      assert.strictEqual(f['email-tickets'].state, 'on', JSON.stringify(f['email-tickets']));
      assert.ok(f['email-tickets'].facts.some((x) => /outgoing login: set/.test(x)));
      for (const s of SECRETS) assert.ok(!JSON.stringify(f).includes(s), s);
    });

    await check('pause: needs a valid administrator and a well-formed feature id; unknown and non-pausable features are refused', async () => {
      const before = sha(ledgerCfg);
      const pause = (feature, token) => post('/atlas/admin/site-pause', { payload: { feature }, token });
      assert.strictEqual((await pause('ledger-issuance', undefined)).status, 401);
      assert.strictEqual((await pause('ledger-issuance', 'bad')).status, 401);
      assert.strictEqual((await pause('ledger-issuance', modToken)).status, 403);
      assert.strictEqual((await post('/atlas/admin/site-pause', { payload: {}, token: adminToken })).status, 400);
      assert.strictEqual((await pause('../../etc/passwd', adminToken)).status, 400);
      assert.strictEqual((await pause('no-such-feature', adminToken)).status, 404);
      for (const id of ['email-tickets', 'moderation-issuer']) { const r = await pause(id, adminToken); assert.ok(r.status === 409 && r.body.code === 'not-pausable', id + JSON.stringify(r)); }
      assert.strictEqual(sha(ledgerCfg), before);
    });

    await check('pause: a JSON switch is set to false, every other setting is kept, repeating it changes nothing', async () => {
      fs.chmodSync(ledgerCfg, 0o640);
      const r = await asAdmin('/atlas/admin/site-pause', { feature: 'ledger-issuance' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.changed, true); assert.strictEqual(r.body.state, 'off');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(ledgerCfg, 'utf8')), { enabled: false, domain: LEDGER_DOMAIN, perClientPerMinute: 7, secret: 'PLANTED-LEDGER-SECRET', extra: {} });
      assert.ok(/"extra": \{\}/.test(fs.readFileSync(ledgerCfg, 'utf8')), 'an empty object stays an object');
      assert.strictEqual(fs.statSync(ledgerCfg).mode & 0o777, 0o640, 'permissions are kept');
      assert.deepStrictEqual(fs.readdirSync(path.dirname(ledgerCfg)).filter((n) => /\.tmp$/.test(n)), []);
      assert.strictEqual((await asAdmin('/atlas/admin/site-pause', { feature: 'ledger-issuance' })).body.changed, false);
      assert.strictEqual((await status())['ledger-issuance'].state, 'off');
    });

    await check('pause: no config means already off and creates nothing; an unparsable config is never rewritten', async () => {
      fs.unlinkSync(ledgerCfg);
      const r1 = await asAdmin('/atlas/admin/site-pause', { feature: 'ledger-issuance' });
      assert.ok(r1.status === 200 && r1.body.changed === false && r1.body.state === 'off');
      assert.ok(!fs.existsSync(ledgerCfg));
      fs.writeFileSync(ledgerCfg, '{ "enabled": true, ');
      const before = sha(ledgerCfg);
      const r2 = await asAdmin('/atlas/admin/site-pause', { feature: 'ledger-issuance' });
      assert.strictEqual(r2.status, 409); assert.strictEqual(r2.body.code, 'unreadable-config');
      assert.strictEqual(sha(ledgerCfg), before);
      fs.writeFileSync(ledgerCfg, '[1,2,3]');
      assert.strictEqual((await asAdmin('/atlas/admin/site-pause', { feature: 'ledger-issuance' })).body.code, 'unreadable-config');
      fs.unlinkSync(ledgerCfg);
    });

    await check('pause: a signed proof can pause, and the proof cannot be replayed', async () => {
      fs.writeFileSync(ledgerCfg, JSON.stringify({ enabled: true, domain: LEDGER_DOMAIN }));
      const payload = withAdminAuth({ feature: 'ledger-issuance' }, BASE, '/atlas/admin/site-pause');
      const proof = await H.signWithSelf(admin, payload);
      assert.strictEqual((await post('/atlas/admin/site-pause', { payload, proof })).body.changed, true);
      fs.writeFileSync(ledgerCfg, JSON.stringify({ enabled: true, domain: LEDGER_DOMAIN }));
      assert.strictEqual((await post('/atlas/admin/site-pause', { payload, proof })).status, 401);
      assert.strictEqual(JSON.parse(fs.readFileSync(ledgerCfg, 'utf8')).enabled, true, 'a replayed request changed nothing');
    });

    await check('no response in this run contained a planted secret', () => {
      const joined = everything.join('\n');
      for (const s of SECRETS) assert.ok(!joined.includes(s), s);
    });
  } finally {
    await H.stopIssuer(issuer);
  }
  console.log(failures ? '\n' + failures + ' check(s) failed.' : '\nAll admin site status checks passed (' + KIND + ').');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
