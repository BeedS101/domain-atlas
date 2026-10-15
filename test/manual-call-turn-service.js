// The Call Service side of self-hosted TURN: settings, who may obtain a TURN credential and when,
// the shape and lifetime of the credential, and that the shared secret never leaves the service.
// No TURN server is involved; the credential is checked against an independent HMAC computed here.
// Run: node test/manual-call-turn-service.js
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const T = require('./call-test-lib.js');
const { P, check, newIdentity, Wallet, fp, signalPayload, sendSignal, post, sign, base, nonce, iso } = T;
const { loadConfig } = require('../call-server/server.js');

const SECRET = 'e1c2b3a49f8d7c6b5a4938271605f4e3d2c1b0a99887766554433221100ffeed';
const TURN = 'turn:turn.example.net:3478';
const TURNS = 'turns:turn.example.net:5349?transport=tcp';
const baseEnv = { CALL_ORIGIN: 'https://calls.example.net', CALL_DOMAIN: 'example.net', CALL_ISSUER_KEYS: 'BAAA'.padEnd(87, 'A') };

const hmac = (secret, username) => crypto.createHmac('sha1', secret).update(username).digest('base64');

async function handshake(ctx, caller, callee, tagInfo) {
  await callee.listen([]);
  const built = await caller.buildInvite(tagInfo.tag, callee.pub);
  const inv = await caller.invite(built);
  return { built, inv };
}
async function acceptCall(ctx, callee, built) {
  const ckB = await newIdentity();
  const acceptPayload = signalPayload(ctx, built.callId, 'accept', {
    inviteHash: await P.payloadHash(built.payload), calleeNonce: P.randomId(16), callKey: ckB.pub, fingerprints: [fp('B')]
  });
  const res = await sendSignal(ctx, acceptPayload, callee.ident);
  return { res, ckB };
}

(async () => {
  // ---------- settings ----------
  const cfgOf = (extra, files) => loadConfig(Object.assign({}, baseEnv, extra), files ? (p) => { if (!(p in files)) throw new Error('no such file'); return files[p]; } : undefined);
  let c = cfgOf({});
  check('with no TURN settings the service is configured and offers none', c.configured && c.turnUrls.length === 0 && !c.turnSecret, c.problem);
  c = cfgOf({ CALL_TURN_URLS: TURN + ',' + TURNS, CALL_TURN_SECRET: SECRET });
  check('TURN URLs and a secret are accepted', c.configured && c.turnUrls.length === 2 && c.turnTtlSeconds === 3600, c.problem);
  check('URLs without a secret are refused', !cfgOf({ CALL_TURN_URLS: TURN }).configured && /both/.test(cfgOf({ CALL_TURN_URLS: TURN }).problem));
  check('a secret without URLs is refused', !cfgOf({ CALL_TURN_SECRET: SECRET }).configured);
  for (const [why, secret] of [['too short', 'abc123'], ['31 characters', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d'], ['all one character', 'a'.repeat(40)], ['two characters repeated', 'ab'.repeat(30)], ['containing a space', 'a1b2c3d4e5f6 a7b8c9d0e1f2a3b4c5d6e7f8'], ['300 characters', 'a1b2c3d4e5'.repeat(30)]]) {
    const x = cfgOf({ CALL_TURN_URLS: TURN, CALL_TURN_SECRET: secret });
    check('a secret that is ' + why + ' is refused', !x.configured && /secret/i.test(x.problem), x.problem);
  }
  check('a problem message never repeats the secret', !cfgOf({ CALL_TURN_URLS: TURN, CALL_TURN_SECRET: 'weakweakweakweakweakweakweakweak' }).problem.includes('weakweak'));
  check('a TURN URL naming a private address is refused in production mode', !cfgOf({ CALL_TURN_URLS: 'turn:10.0.0.5:3478', CALL_TURN_SECRET: SECRET }).configured);
  check('a TURN URL on an unusual port is refused in production mode', !cfgOf({ CALL_TURN_URLS: 'turn:turn.example.net:6379', CALL_TURN_SECRET: SECRET }).configured);
  check('a private TURN address is accepted on the private test network', cfgOf({ CALL_TURN_URLS: 'turn:10.0.0.5:3478', CALL_TURN_SECRET: SECRET, CALL_DEV_ALLOW_HTTP: '1', CALL_ORIGIN: 'http://127.0.0.1:8787' }).configured);
  check('a STUN URL in the TURN list is refused', !cfgOf({ CALL_TURN_URLS: 'stun:turn.example.net', CALL_TURN_SECRET: SECRET }).configured);
  check('a public third-party TURN service is refused', !cfgOf({ CALL_TURN_URLS: 'turn:global.turn.twilio.com:3478', CALL_TURN_SECRET: SECRET }).configured);
  check('more than four TURN URLs are refused', !cfgOf({ CALL_TURN_URLS: ['a', 'b', 'c', 'd', 'e'].map((h) => 'turn:' + h + '.example.net:3478').join(','), CALL_TURN_SECRET: SECRET }).configured);
  check('a lifetime under a minute is refused', !cfgOf({ CALL_TURN_URLS: TURN, CALL_TURN_SECRET: SECRET, CALL_TURN_TTL_SECONDS: '30' }).configured);
  check('a lifetime over a day is refused', !cfgOf({ CALL_TURN_URLS: TURN, CALL_TURN_SECRET: SECRET, CALL_TURN_TTL_SECONDS: '90000' }).configured);
  check('a lifetime that is not a number is refused', !cfgOf({ CALL_TURN_URLS: TURN, CALL_TURN_SECRET: SECRET, CALL_TURN_TTL_SECONDS: 'soon' }).configured);
  c = cfgOf({ CALL_TURN_URLS: TURN, CALL_TURN_SECRET_FILE: '/run/secrets/turn' }, { '/run/secrets/turn': SECRET + '\n' });
  check('the secret can come from a file (trailing newline removed)', c.configured && c.turnSecret === SECRET, c.problem);
  check('a secret both inline and in a file is refused', !cfgOf({ CALL_TURN_URLS: TURN, CALL_TURN_SECRET: SECRET, CALL_TURN_SECRET_FILE: '/run/secrets/turn' }, { '/run/secrets/turn': SECRET }).configured);
  check('an unreadable secret file is refused', !cfgOf({ CALL_TURN_URLS: TURN, CALL_TURN_SECRET_FILE: '/nope' }, {}).configured);
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-secret-'));
    const f = path.join(dir, 'secret');
    fs.writeFileSync(f, SECRET, { mode: 0o644 }); fs.chmodSync(f, 0o644);
    const open = cfgOf({ CALL_TURN_URLS: TURN, CALL_TURN_SECRET_FILE: f });
    check('a secret file readable by others is refused', !open.configured && /chmod 600/.test(open.problem), open.problem);
    fs.chmodSync(f, 0o600);
    check('the same file with mode 600 is accepted', cfgOf({ CALL_TURN_URLS: TURN, CALL_TURN_SECRET_FILE: f }).configured);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- a service with TURN ----------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-state-'));
  const stateFile = path.join(tmp, 'state.json');
  const ctx = await T.startService({ turnUrls: [TURN, TURNS], turnSecret: SECRET, turnTtlSeconds: 600, stunUrls: ['stun:stun.example.net:3478'], stateFile }, {
    limits: { invitesPerSourcePerMin: 1000, invitesPerCallerPerMin: 1000, invitesPerCalleePerMin: 1000, perSourcePerMin: 5000 },
    timers: { listenHoldMs: 300, acceptToOfferMs: 60000, offerToAnswerMs: 60000, confirmMs: 60000, maxCallMs: 120000 }
  });
  const alice = await Wallet.create(ctx, 'alice'), bob = await Wallet.create(ctx, 'bob'), mallory = await Wallet.create(ctx, 'mallory');
  const tagInfo = (await bob.createTag(alice.pub)).json;

  const info = await fetch(ctx.base + '/atlas/call/info').then((r) => r.json());
  check('info says TURN is available and names its URLs', info.ice.turn === true && JSON.stringify(info.ice.turnUrls) === JSON.stringify([TURN, TURNS]), info.ice);
  check('info says nothing of the secret or any credential', !JSON.stringify(info).includes(SECRET) && !/credential|username|secret/i.test(JSON.stringify(info)));

  // before the callee accepts
  const hs = await handshake(ctx, alice, bob, tagInfo);
  check('the invite is accepted by the service', hs.inv.status === 202 || hs.inv.status === 200, hs.inv);
  let r = await alice.ice(hs.built.callId, hs.built.ck);
  check('a ringing call yields no ICE answer, so ringing a wallet never yields a credential', r.status === 404 && !JSON.stringify(r.json).includes('credential'), r);
  const acc = await acceptCall(ctx, bob, hs.built);
  check('the callee accepts', acc.res.status === 202, acc.res);

  // authorization
  const forgedBy = async (ident) => {
    const payload = base('atlas.call.ice', ctx.origin, { nonce: nonce(), callId: hs.built.callId });
    return post(ctx.base, '/atlas/call/ice', { payload, proof: await sign(payload, ident) });
  };
  r = await forgedBy(await newIdentity());
  check('a stranger\'s key gets no credential', r.status === 404 && !JSON.stringify(r.json).includes('credential'), r);
  r = await forgedBy(mallory.ident);
  check('another wallet\'s identity key gets no credential', r.status === 404, r);
  r = await forgedBy(alice.ident);
  check('the caller\'s identity key (not its call key) gets no credential', r.status === 404, r);
  r = await forgedBy(bob.ident);
  check('the callee\'s identity key (not its call key) gets no credential', r.status === 404, r);
  {
    const payload = base('atlas.call.ice', ctx.origin, { nonce: nonce(), callId: hs.built.callId });
    const proof = await sign(payload, hs.built.ck);
    r = await post(ctx.base, '/atlas/call/ice', { payload: Object.assign({}, payload, { nonce: nonce() }), proof });
    check('a signed request with a changed field is refused', r.status === 401 && !JSON.stringify(r.json).includes('credential'), r);
    r = await post(ctx.base, '/atlas/call/ice', { payload: Object.assign({}, payload, { audience: 'https://other.example.net' }), proof: await sign(Object.assign({}, payload, { audience: 'https://other.example.net' }), hs.built.ck) });
    check('a request addressed to another service is refused', r.status === 401, r);
    const stale = base('atlas.call.ice', ctx.origin, { nonce: nonce(), callId: hs.built.callId, issuedAt: iso(Date.now() - 3600000) });
    r = await post(ctx.base, '/atlas/call/ice', { payload: stale, proof: await sign(stale, hs.built.ck) });
    check('a stale request is refused', r.status === 401 && !JSON.stringify(r.json).includes('credential'), r);
    const other = Object.assign({}, payload, { callId: P.randomId(16), nonce: nonce() });
    r = await post(ctx.base, '/atlas/call/ice', { payload: other, proof: await sign(other, hs.built.ck) });
    check('an unknown call id is refused', r.status === 404, r);
    r = await post(ctx.base, '/atlas/call/ice', { payload, proof });
    check('the genuine request is answered', r.status === 200, r);
    const again = await post(ctx.base, '/atlas/call/ice', { payload, proof });
    check('replaying the same signed request is refused', again.status === 401 && again.json.code === 'replayed-request' && !JSON.stringify(again.json).includes('credential'), again);
  }
  check('garbage bodies on the ice route are refused without a credential', (await Promise.all([post(ctx.base, '/atlas/call/ice', null, '{}'), post(ctx.base, '/atlas/call/ice', null, '[]'), post(ctx.base, '/atlas/call/ice', null, 'null'), post(ctx.base, '/atlas/call/ice', null, '{"payload":1,"proof":2}')])).every((x) => x.status >= 400 && !JSON.stringify(x.json).includes('credential')));

  // the credential
  r = await alice.ice(hs.built.callId, hs.built.ck);
  check('the caller gets an answer after the callee accepted', r.status === 200 && Array.isArray(r.json.iceServers), r);
  const stunEntry = r.json.iceServers.find((s) => s.urls.some((u) => u.startsWith('stun:')));
  const turnEntry = r.json.iceServers.find((s) => s.urls.some((u) => u.startsWith('turn')));
  check('the answer holds the operator STUN URL without a credential', stunEntry && !('username' in stunEntry) && !('credential' in stunEntry), stunEntry);
  check('and the TURN URLs with a username and a credential', turnEntry && JSON.stringify(turnEntry.urls) === JSON.stringify([TURN, TURNS]) && typeof turnEntry.username === 'string' && typeof turnEntry.credential === 'string', turnEntry);
  const [stamp, label] = turnEntry.username.split(':');
  check('the username is an expiry time and an opaque label', /^\d{10}$/.test(stamp) && /^[A-Za-z0-9_-]{8,}$/.test(label), turnEntry.username);
  check('the credential is the HMAC-SHA1 of the username under the shared secret (computed independently)', turnEntry.credential === hmac(SECRET, turnEntry.username));
  check('the credential is not valid under any other secret', turnEntry.credential !== hmac(SECRET + 'x', turnEntry.username));
  check('the username holds no identity key, call id, tag or domain', ![alice.pub, bob.pub, hs.built.callId, hs.built.ck.pub, acc.ckB.pub, tagInfo.tag, 'example.com'].some((s) => turnEntry.username.includes(s) || turnEntry.username.includes(s.slice(0, 12))));
  const serverNow = Date.parse(r.json.serverTime);
  check('the lifetime is the configured 600 s, capped by the call\'s remaining life (120 s maximum call here)', r.json.ttl <= 120 && r.json.ttl > 100 && Number(stamp) * 1000 - serverNow <= 120000, { ttl: r.json.ttl, stamp, serverNow });
  check('the answer states when the credential expires and it matches the username', Date.parse(r.json.credentialExpiresAt) === Number(stamp) * 1000, r.json);
  check('the shared secret does not appear in the answer', !JSON.stringify(r.json).includes(SECRET));
  const wallet = P.iceServersFromAnswer(r.json, {});
  check('the wallet-side validator accepts this answer and keeps the TURN entry', wallet.turn && wallet.iceServers.length === 2, wallet);

  const rb = await bob.ice(hs.built.callId, acc.ckB);
  check('the callee, with its own call key, gets its own credential', rb.status === 200 && rb.json.iceServers.some((s) => s.credential), rb);
  const tb = rb.json.iceServers.find((s) => s.credential);
  check('the two sides get different credentials', tb.username !== turnEntry.username && tb.credential !== turnEntry.credential);
  check('the callee\'s credential is also a correct HMAC', tb.credential === hmac(SECRET, tb.username));

  // per-side cap
  // The genuine request above and the answer just checked are the caller's first two.
  const got = [];
  for (let i = 0; i < 3; i++) got.push((await alice.ice(hs.built.callId, hs.built.ck)).status);
  check('each side may fetch only a few credentials per call (3 by default), then is told to slow down', JSON.stringify(got) === JSON.stringify([200, 429, 429]), got);
  check('the caller reaching its cap does not use up the callee\'s', (await bob.ice(hs.built.callId, acc.ckB)).status === 200);

  // calls that never reach a conversation
  const hs2 = await handshake(ctx, alice, bob, tagInfo);
  const sess = bob.sess || (bob.sess = await bob.session());
  const declined = await sendSignal(ctx, signalPayload(ctx, hs2.built.callId, 'decline', { reason: 'declined' }), sess.sk, sess.delegation);
  r = await alice.ice(hs2.built.callId, hs2.built.ck);
  check('a declined call yields no credential', declined.status === 202 && r.status === 404 && !JSON.stringify(r.json).includes('credential'), { declined: declined.status, r });
  const hs3 = await handshake(ctx, alice, bob, tagInfo);
  const cancelled = await sendSignal(ctx, signalPayload(ctx, hs3.built.callId, 'cancel', {}, 1), hs3.built.ck);
  r = await alice.ice(hs3.built.callId, hs3.built.ck);
  check('a cancelled call yields no credential', cancelled.status === 202 && r.status === 404 && !JSON.stringify(r.json).includes('credential'), { cancelled: cancelled.status, r });

  // counters and persisted state
  const st = ctx.svc.stats();
  check('the service counts the credentials it issued (3 for the caller, 2 for the callee)', ctx.svc.counters.turnCredentialsIssued === 5, ctx.svc.counters);
  check('the persisted state holds no secret and no credential', (() => {
    if (!fs.existsSync(stateFile)) return true;
    const text = fs.readFileSync(stateFile, 'utf8');
    return !text.includes(SECRET) && !text.includes(turnEntry.credential) && !text.includes(turnEntry.username) && !text.includes(tb.credential);
  })());
  check('the stats hold no secret and no credential', !JSON.stringify(st).includes(SECRET) && !JSON.stringify(st).includes(turnEntry.credential));

  // a call whose remaining life is too short for a useful credential
  const short = await T.startService({ turnUrls: [TURN], turnSecret: SECRET }, { limits: { invitesPerSourcePerMin: 1000 }, timers: { listenHoldMs: 300, maxCallMs: 20000, acceptToOfferMs: 20000 } });
  {
    const a2 = await Wallet.create(short, 'a2'), b2 = await Wallet.create(short, 'b2');
    const tg = (await b2.createTag(a2.pub)).json;
    const h = await handshake(short, a2, b2, tg);
    const ac = await acceptCall(short, b2, h.built);
    const x = await a2.ice(h.built.callId, h.built.ck);
    check('with under 30 s of call life left no credential is issued, and the answer is still well-formed', ac.res.status === 202 && x.status === 200 && !x.json.iceServers.some((s) => s.credential) && !('credentialExpiresAt' in x.json), x);
  }
  await short.svc.close();

  // a service with no TURN
  const plain = await T.startService({ stunUrls: [] }, { limits: { invitesPerSourcePerMin: 1000 }, timers: { listenHoldMs: 300 } });
  {
    const a2 = await Wallet.create(plain, 'a2'), b2 = await Wallet.create(plain, 'b2');
    const tg = (await b2.createTag(a2.pub)).json;
    const h = await handshake(plain, a2, b2, tg);
    await acceptCall(plain, b2, h.built);
    const x = await a2.ice(h.built.callId, h.built.ck);
    const inf = await fetch(plain.base + '/atlas/call/info').then((q) => q.json());
    check('a service without TURN settings hands out no credential and says so', x.status === 200 && x.json.iceServers.length === 0 && inf.ice.turn === false && !('turnUrls' in inf.ice), { x, inf: inf.ice });
  }
  await plain.svc.close();
  await ctx.svc.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  // ---------- the real process: the secret is not printed or stored ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-proc-'));
  const secretFile = path.join(dir, 'turn-secret'), state = path.join(dir, 'state.json');
  fs.writeFileSync(secretFile, SECRET, { mode: 0o600 });
  const port = await new Promise((res) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const issuer = await T.newIssuer('example.com');
  for (const mode of ['env', 'file']) {
    const env = Object.assign({}, process.env, {
      CALL_ORIGIN: 'http://127.0.0.1:' + port, CALL_DOMAIN: 'example.com', CALL_ISSUER_KEYS: issuer.ident.pub, CALL_DEV_ALLOW_HTTP: '1',
      CALL_BIND: '127.0.0.1', CALL_PORT: String(port), CALL_STATE_FILE: state, CALL_TURN_URLS: TURN
    });
    if (mode === 'env') env.CALL_TURN_SECRET = SECRET; else env.CALL_TURN_SECRET_FILE = secretFile;
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'call-server', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    let up = false;
    for (let i = 0; i < 50 && !up; i++) { await T.sleep(100); try { up = (await fetch('http://127.0.0.1:' + port + '/atlas/call/info')).ok; } catch (e) { /* not yet */ } }
    check('the real process starts with the secret from ' + (mode === 'env' ? 'the environment' : 'a file'), up, out);
    const inf = up ? await fetch('http://127.0.0.1:' + port + '/atlas/call/info').then((q) => q.json()) : {};
    check('and reports TURN as available (' + mode + ')', inf.ice && inf.ice.turn === true, inf);
    child.kill('SIGTERM');
    await new Promise((res) => { child.on('exit', res); setTimeout(res, 3000); });
    check('its output names the TURN URLs but never the secret (' + mode + ')', out.includes('turn.example.net') && !out.includes(SECRET), out.replace(SECRET, '<<SECRET>>'));
    check('nothing it wrote to disk contains the secret (' + mode + ')', fs.readdirSync(dir).filter((f) => f !== 'turn-secret').every((f) => !fs.readFileSync(path.join(dir, f), 'utf8').includes(SECRET)));
  }
  {
    const env = Object.assign({}, process.env, { CALL_ORIGIN: 'http://127.0.0.1:' + port, CALL_DOMAIN: 'example.com', CALL_ISSUER_KEYS: issuer.ident.pub, CALL_DEV_ALLOW_HTTP: '1', CALL_PORT: String(port), CALL_TURN_URLS: TURN, CALL_TURN_SECRET: 'short' });
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'call-server', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
    await T.sleep(800);
    const answered = await fetch('http://127.0.0.1:' + port + '/atlas/call/info').then((q) => q.json()).catch(() => null);
    child.kill('SIGTERM');
    await new Promise((res) => { child.on('exit', res); setTimeout(res, 3000); });
    check('a weak secret leaves the service unconfigured and the output says why without printing it', /not configured/.test(out) && !out.includes('short\'') && answered && answered.configured === false, out);
  }
  fs.rmSync(dir, { recursive: true, force: true });

  process.exit(T.finish('manual-call-turn-service'));
})().catch((e) => { console.error(e); process.exit(2); });
