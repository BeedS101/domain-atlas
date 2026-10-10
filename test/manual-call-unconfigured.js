// The Call Service as shipped (a real child process): inert without configuration, creates
// nothing on disk, refuses a misconfiguration, and logs no identities when configured.
// Run: node test/manual-call-unconfigured.js
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const T = require('./call-test-lib');
const { P, check, sleep, Wallet, newIdentity } = T;

const SERVER = path.join(__dirname, '..', 'call-server', 'server.js');
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function run(env, cwd) {
  const child = spawn(process.execPath, [SERVER], { cwd, env: Object.assign({ PATH: process.env.PATH }, env), stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { text: '' };
  child.stdout.on('data', (d) => { out.text += d; });
  child.stderr.on('data', (d) => { out.text += d; });
  return { child, out };
}
async function waitUp(port) {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/atlas/call/info'); if (r.ok) return r.json(); } catch (e) { /* not yet */ }
    await sleep(100);
  }
  throw new Error('service did not start');
}
const ls = (d) => fs.readdirSync(d).sort().join(',');

(async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-call-cwd-'));
  const serverDir = path.dirname(SERVER);
  const before = ls(serverDir);

  // ---- no configuration ----
  let port = await freePort();
  let s = run({ CALL_PORT: String(port) }, cwd);
  let info = await waitUp(port);
  check('without configuration the service reports configured:false', info.configured === false);
  check('without configuration the info route carries no origin or domain', info.audience === undefined && info.domain === undefined);
  const routes = ['tag/create', 'tag/revoke', 'tag/list', 'listen', 'invite', 'poll', 'signal', 'ice'];
  let all503 = true;
  for (const rt of routes) {
    const r = await T.post('http://127.0.0.1:' + port, '/atlas/call/' + rt, {});
    if (r.status !== 503 || r.json.code !== 'calls-not-configured') all503 = false;
  }
  check('without configuration every call route answers 503 calls-not-configured', all503);
  check('the unconfigured service says so on its console', /not configured/.test(s.out.text), s.out.text);
  check('the unconfigured service listens on loopback only by default', /listening on 127\.0\.0\.1/.test(s.out.text), s.out.text);
  check('the unconfigured service created no files', ls(cwd) === '' && ls(serverDir) === before, { cwd: ls(cwd), dir: ls(serverDir) });
  s.child.kill('SIGTERM');
  await sleep(200);

  // ---- misconfiguration fails closed ----
  const issuer = await T.newIssuer('example.com');
  const mis = [
    ['plain http without the development flag', { CALL_ORIGIN: 'http://127.0.0.1:1', CALL_DOMAIN: 'example.com', CALL_ISSUER_KEYS: issuer.ident.pub }],
    ['an issuer key that is not a raw P-256 key', { CALL_ORIGIN: 'https://calls.example.com', CALL_DOMAIN: 'example.com', CALL_ISSUER_KEYS: 'not-a-key' }],
    ['a missing domain', { CALL_ORIGIN: 'https://calls.example.com', CALL_ISSUER_KEYS: issuer.ident.pub }],
    ['an origin with a path', { CALL_ORIGIN: 'https://calls.example.com/x', CALL_DOMAIN: 'example.com', CALL_ISSUER_KEYS: issuer.ident.pub }]
  ];
  for (const [name, env] of mis) {
    port = await freePort();
    s = run(Object.assign({ CALL_PORT: String(port) }, env), cwd);
    info = await waitUp(port);
    const r = await T.post('http://127.0.0.1:' + port, '/atlas/call/invite', {});
    check('misconfiguration (' + name + ') leaves the service unconfigured', info.configured === false && r.status === 503);
    s.child.kill('SIGTERM');
    await sleep(150);
  }

  // ---- configured: no identities in the log ----
  port = await freePort();
  const stateFile = path.join(cwd, 'atlas-call-tags.json');
  s = run({ CALL_PORT: String(port), CALL_ORIGIN: 'http://127.0.0.1:' + port, CALL_DOMAIN: 'example.com', CALL_ISSUER_KEYS: issuer.ident.pub, CALL_DEV_ALLOW_HTTP: '1', CALL_STATE_FILE: stateFile, CALL_STUN_URLS: 'stun:192.0.2.1:3478' }, cwd);
  info = await waitUp(port);
  check('with configuration the service reports configured:true and its audience', info.configured === true && info.audience === 'http://127.0.0.1:' + port);
  check('the advertised STUN URL is returned', info.ice.stun[0] === 'stun:192.0.2.1:3478');
  const ctx = { base: 'http://127.0.0.1:' + port, origin: 'http://127.0.0.1:' + port, issuer };
  const alice = await Wallet.create(ctx), bob = await Wallet.create(ctx);
  const tag = (await bob.createTag(alice.pub)).json;
  await bob.listen([]);
  const built = await alice.buildInvite(tag.tag, bob.pub);
  const inv = await alice.invite(built);
  const secrets = [tag.tag, alice.pub, bob.pub, built.ck.pub, built.callId, built.payload.nonce, P.canonicalize(built.payload.media)];
  // provoke refusals too
  await alice.invite(await alice.buildInvite(P.randomId(16), bob.pub));
  await T.post(ctx.base, '/atlas/call/invite', null, '{broken');
  await sleep(300);
  check('an invite went through the real process', inv.status === 202, inv);
  check('the log contains no tag, key, call id or nonce', secrets.every((x) => !s.out.text.includes(x)), s.out.text.slice(0, 600));
  const file = fs.readFileSync(stateFile, 'utf8');
  check('the state file holds no raw tag', !file.includes(tag.tag));
  s.child.kill('SIGTERM');
  await sleep(200);
  fs.rmSync(cwd, { recursive: true, force: true });
  process.exit(T.finish('manual-call-unconfigured'));
})().catch((e) => { console.error(e); process.exit(2); });
