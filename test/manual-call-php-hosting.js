// What is particular to the PHP Call Service: settings and their checks, the HTTP layer, short
// polling hints, time limits applied without a background process, the state folder, the lock,
// revocations read from the issuer's file, TURN credentials, housekeeping, limits, and the
// shape of the upload bundle. Needs `php` with openssl and curl on PATH.
// Run: node test/manual-call-php-hosting.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const T = require('./call-test-lib');
const L = require('./call-php-lib');
const { driveCall, hangup } = require('./call-flow-lib');
const { P, check, sleep, iso, Wallet, sign, base, nonce, signalPayload, sendSignal } = T;

const ROOT = L.ROOT;
const GOOD_KEY = 'B'.repeat(87);
const jpost = async (b, route, body, headers, raw) => {
  const r = await fetch(b + route, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: raw !== undefined ? raw : JSON.stringify(body) });
  let json = null; try { json = await r.json(); } catch (e) { /* none */ }
  return { status: r.status, json, headers: r.headers };
};
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function checkConfig(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-call-cfg-'));
  const file = path.join(dir, 'config.php');
  L.writeSettings(file, cfg);
  const r = spawnSync('php', [path.join(ROOT, 'tools', 'check-config.php'), file], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: r.status === 0, text: (r.stdout + r.stderr).trim() };
}

(async () => {
  // ---------- not configured ----------
  {
    const ctx = await L.startPhpService(null, { noSettingsFile: true });
    const info = await fetch(ctx.base + '/atlas/call/info').then((r) => r.json());
    check('without settings, info says the service is not configured and names no audience', info.configured === false && info.audience === undefined && info.domain === undefined, info);
    const r = await jpost(ctx.base, '/atlas/call/listen', {});
    check('without settings every other route answers 503 calls-not-configured', r.status === 503 && r.json.code === 'calls-not-configured', r);
    const t = await jpost(ctx.base, '/atlas/call/tag/create', {});
    check('without settings tag/create also answers calls-not-configured', t.status === 503 && t.json.code === 'calls-not-configured', t);
    check('without settings nothing is written under the bundle', !fs.existsSync(path.join(ROOT, 'atlas', 'call', 'lib', 'state')) && !fs.existsSync(path.join(ROOT, 'atlas', 'call', 'lib', 'config.php')));
    await ctx.svc.close();
    const bad = await L.startPhpService(null, { rawSettings: '<?php return ["origin" => "http://x", "bogus" => 1];' });
    const info2 = await fetch(bad.base + '/atlas/call/info').then((r) => r.json());
    const r2 = await jpost(bad.base, '/atlas/call/listen', {});
    check('settings with a mistake leave the service not configured', info2.configured === false && r2.status === 503, { info2, r2 });
    check('the mistake is written to the server log and not shown to the client', /bogus is not a setting/.test(bad.svc.log()) && !JSON.stringify(r2).includes('bogus'), bad.svc.log().slice(-300));
    await bad.svc.close();
    const broken = await L.startPhpService(null, { rawSettings: '<?php this is not php' });
    const r3 = await jpost(broken.base, '/atlas/call/listen', {});
    check('a settings file that does not parse leaves the service not configured, with no error text sent', r3.status === 503 && r3.json.code === 'calls-not-configured' && !/parse|syntax|\.php/i.test(JSON.stringify(r3)), r3);
    await broken.svc.close();
  }

  // ---------- settings checks ----------
  {
    const issuer = await T.newIssuer('example.com');
    const good = { origin: 'https://calls.example.com', domain: 'example.com', issuerKeys: [issuer.ident.pub], stateDir: '/tmp/atlas-call-cfg-state' };
    const ok = checkConfig(good);
    check('a complete settings file passes the checker', ok.ok && /^OK: configured for https:\/\/calls.example.com/.test(ok.text), ok);
    const withTurn = checkConfig(Object.assign({}, good, { turnUrls: ['turn:turn.example.com:3478'], turnSecret: crypto.randomBytes(32).toString('hex'), stunUrls: ['stun:turn.example.com:3478'] }));
    check('public STUN and TURN names with a strong secret pass', withTurn.ok, withTurn);
    const secretFile = path.join(os.tmpdir(), 'atlas-call-secret-' + process.pid);
    fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'), { mode: 0o644 });
    fs.chmodSync(secretFile, 0o644);
    const cases = [
      ['an unknown setting', Object.assign({}, good, { oops: 1 }), 'oops is not a setting'],
      ['an origin with a path', Object.assign({}, good, { origin: 'https://calls.example.com/x' }), 'bare origin'],
      ['an origin with a trailing slash', Object.assign({}, good, { origin: 'https://calls.example.com/' }), 'bare origin'],
      ['a default port written out', Object.assign({}, good, { origin: 'https://calls.example.com:443' }), 'default port'],
      ['an http origin', Object.assign({}, good, { origin: 'http://calls.example.com' }), 'must be https'],
      ['a missing domain', Object.assign({}, good, { domain: undefined }), 'domain'],
      ['an upper-case domain', Object.assign({}, good, { domain: 'Example.com' }), 'domain'],
      ['no issuer key', Object.assign({}, good, { issuerKeys: [] }), 'issuerKeys'],
      ['an issuer key of the wrong length', Object.assign({}, good, { issuerKeys: ['abc'] }), 'issuerKeys'],
      ['nine issuer keys', Object.assign({}, good, { issuerKeys: Array(9).fill(GOOD_KEY) }), 'issuerKeys'],
      ['issuer keys that are not a list', Object.assign({}, good, { issuerKeys: 'x' }), 'issuerKeys'],
      ['an unknown limit', Object.assign({}, good, { limits: { nope: 5 } }), 'limits.nope'],
      ['a limit out of range', Object.assign({}, good, { limits: { perSourcePerMin: 5 } }), 'perSourcePerMin'],
      ['a limit that is not a whole number', Object.assign({}, good, { limits: { perSourcePerMin: 50.5 } }), 'perSourcePerMin'],
      ['an unknown timer', Object.assign({}, good, { timers: { nope: 5000 } }), 'timers.nope'],
      ['a timer that is too short', Object.assign({}, good, { timers: { confirmMs: 50 } }), 'confirmMs'],
      ['a poll hint out of range', Object.assign({}, good, { poll: { listenIdleMs: 60000 } }), 'poll.listenIdleMs'],
      ['a listener freshness shorter than two idle polls', Object.assign({}, good, { timers: { listenerFreshMs: 5000 }, poll: { listenIdleMs: 3000 } }), 'listenerFreshMs'],
      ['a Google STUN server', Object.assign({}, good, { stunUrls: ['stun:stun.l.google.com:19302'] }), 'third-party'],
      ['a private STUN address', Object.assign({}, good, { stunUrls: ['stun:10.0.0.5:3478'] }), 'private'],
      ['a STUN URL that is a TURN URL', Object.assign({}, good, { stunUrls: ['turn:turn.example.com:3478'] }), 'TURN URL'],
      ['four STUN servers', Object.assign({}, good, { stunUrls: ['stun:a.example.com', 'stun:b.example.com', 'stun:c.example.com', 'stun:d.example.com'] }), 'at most'],
      ['TURN URLs without a secret', Object.assign({}, good, { turnUrls: ['turn:turn.example.com:3478'] }), 'both'],
      ['a TURN secret without URLs', Object.assign({}, good, { turnSecret: crypto.randomBytes(32).toString('hex') }), 'both'],
      ['a short TURN secret', Object.assign({}, good, { turnUrls: ['turn:turn.example.com:3478'], turnSecret: 'abc123' }), 'secret'],
      ['a repetitive TURN secret', Object.assign({}, good, { turnUrls: ['turn:turn.example.com:3478'], turnSecret: 'ab'.repeat(20) }), 'secret'],
      ['a TURN port outside the usual ones', Object.assign({}, good, { turnUrls: ['turn:turn.example.com:9999'], turnSecret: crypto.randomBytes(32).toString('hex') }), 'port'],
      ['a TURN secret file others can read', Object.assign({}, good, { turnUrls: ['turn:turn.example.com:3478'], turnSecretFile: secretFile }), 'chmod 600'],
      ['a missing TURN secret file', Object.assign({}, good, { turnUrls: ['turn:turn.example.com:3478'], turnSecretFile: '/nonexistent/secret' }), 'turnSecretFile'],
      ['a TURN lifetime out of range', Object.assign({}, good, { turnUrls: ['turn:turn.example.com:3478'], turnSecret: crypto.randomBytes(32).toString('hex'), turnTtlSeconds: 5 }), 'turnTtlSeconds'],
      ['both a revocations file and URL', Object.assign({}, good, { revocationsFile: '/x', revocationsUrl: 'https://example.com/r.json' }), 'use one'],
      ['an http revocations URL', Object.assign({}, good, { revocationsUrl: 'http://example.com/r.json' }), 'https'],
      ['a proxy address that is not an IP', Object.assign({}, good, { proxyAddrs: ['proxy.example.com'] }), 'proxyAddrs'],
      ['a wildcard cross-origin entry', Object.assign({}, good, { inviteCorsOrigins: ['*'] }), 'inviteCorsOrigins'],
      ['an http cross-origin entry', Object.assign({}, good, { inviteCorsOrigins: ['http://app.example.com'] }), 'inviteCorsOrigins'],
      ['a cross-origin entry with a path', Object.assign({}, good, { inviteCorsOrigins: ['https://app.example.com/x'] }), 'inviteCorsOrigins']
    ];
    for (const [name, cfg, want] of cases) {
      const r = checkConfig(cfg);
      check('settings with ' + name + ' are refused and the problem is named', !r.ok && r.text.includes(want), r);
    }
    fs.rmSync(secretFile, { force: true });
    const secure = path.join(os.tmpdir(), 'atlas-call-secret-ok-' + process.pid);
    fs.writeFileSync(secure, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    const sf = checkConfig(Object.assign({}, good, { turnUrls: ['turn:turn.example.com:3478'], turnSecretFile: secure }));
    check('a TURN secret file readable only by its owner is accepted', sf.ok, sf);
    fs.rmSync(secure, { force: true });
  }

  // ---------- the HTTP layer ----------
  {
    const ctx = await L.startPhpService(null, { limits: { invitesPerSourcePerMin: 1000, invitesPerCallerPerMin: 1000, invitesPerCalleePerMin: 1000 } });
    const alice = await Wallet.create(ctx), bob = await Wallet.create(ctx);
    let r = await jpost(ctx.base, '/atlas/call/listen', {});
    check('responses carry no-store, nosniff, a deny-all CSP and no referrer', r.headers.get('cache-control') === 'no-store' && r.headers.get('x-content-type-options') === 'nosniff' && /default-src 'none'/.test(r.headers.get('content-security-policy')) && r.headers.get('referrer-policy') === 'no-referrer', [...r.headers.entries()]);
    check('responses are JSON', /^application\/json/.test(r.headers.get('content-type')), r.headers.get('content-type'));
    r = await fetch(ctx.base + '/atlas/call/listen');
    check('a GET to a POST route is refused with 405', r.status === 405, r.status);
    r = await fetch(ctx.base + '/atlas/call/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('a POST to info is not found', r.status === 404, r.status);
    r = await jpost(ctx.base, '/atlas/call/listen', null, { 'Content-Type': 'text/plain' }, '{}');
    check('a body that is not declared as JSON is refused with 415', r.status === 415, r);
    r = await jpost(ctx.base, '/atlas/call/listen', null, { 'Content-Type': 'application/json; charset=utf-8' }, '{}');
    check('JSON with a charset is accepted as JSON', r.status === 400 && r.json.code === 'bad-request', r);
    r = await jpost(ctx.base, '/atlas/call/listen', null, { Origin: 'https://evil.example' }, '{}');
    check('a request from a web page origin that was not named is refused', r.status === 403 && r.json.code === 'origin-not-allowed', r);
    r = await jpost(ctx.base, '/atlas/call/listen', null, { Origin: 'null' }, '{}');
    check('a request with a null origin is refused', r.status === 403, r);
    r = await jpost(ctx.base, '/atlas/call/invite', null, { Origin: 'https://evil.example' }, '{}');
    check('the invite route does not accept web page origins unless they are named', r.status === 403, r);
    r = await jpost(ctx.base, '/atlas/call/tag/create', null, null, 'x'.repeat(9000));
    check('an oversize body is refused with 413 before it is parsed', r.status === 413, r);
    r = await jpost(ctx.base, '/atlas/call/signal', null, null, '[]');
    check('a JSON array body is refused as malformed', r.status === 400, r);
    r = await jpost(ctx.base, '/atlas/call/signal', null, null, '[' .repeat(200) + ']'.repeat(200));
    check('a deeply nested body is refused as malformed', r.status === 400, r);
    r = await jpost(ctx.base, '/atlas/call/signal', null, null, '');
    check('an empty body is refused as malformed', r.status === 400, r);
    r = await jpost(ctx.base, '/atlas/call/tag/create', null, null, '{"payload":{"type":"atlas.call.tag"},"proof":{}}');
    check('a payload that fails the schema is refused as malformed', r.status === 400, r);
    // the error text never carries file names or PHP messages
    check('no response carries a file path', !/\/home|\.php|Stack trace/.test(JSON.stringify(r)));

    // cross-origin invitations from a named page
    const cors = await L.startPhpService({ inviteCorsOrigins: ['https://app.example.com'] }, {});
    const o = await fetch(cors.base + '/atlas/call/invite', { method: 'OPTIONS', headers: { Origin: 'https://app.example.com', 'Access-Control-Request-Method': 'POST' } });
    check('a named origin gets a preflight answer for the invite route only', o.status === 204 && o.headers.get('access-control-allow-origin') === 'https://app.example.com' && o.headers.get('vary') === 'Origin', [o.status, [...o.headers.entries()]]);
    const o2 = await fetch(cors.base + '/atlas/call/invite', { method: 'OPTIONS', headers: { Origin: 'https://other.example.com' } });
    check('an unnamed origin gets no preflight answer', o2.status === 405 && !o2.headers.get('access-control-allow-origin'), o2.status);
    const o3 = await fetch(cors.base + '/atlas/call/listen', { method: 'OPTIONS', headers: { Origin: 'https://app.example.com' } });
    check('a named origin gets no preflight answer for other routes', o3.status === 405 && !o3.headers.get('access-control-allow-origin'), o3.status);
    const o4 = await jpost(cors.base, '/atlas/call/invite', null, { Origin: 'https://app.example.com' }, '{}');
    check('an invite from a named origin is processed and answered with its origin only', o4.status === 400 && o4.headers.get('access-control-allow-origin') === 'https://app.example.com', [o4.status, o4.headers.get('access-control-allow-origin')]);
    const o5 = await jpost(cors.base, '/atlas/call/listen', null, { Origin: 'https://app.example.com' }, '{}');
    check('a named origin may not use the other routes', o5.status === 403, o5);
    await cors.svc.close();

    // per-source limit, and where the source address comes from
    const lim = await L.startPhpService({ trustProxy: true, proxyAddrs: ['127.0.0.1'] }, { limits: { perSourcePerMin: 30 } });
    let n429 = 0;
    for (let i = 0; i < 40; i++) { const x = await jpost(lim.base, '/atlas/call/listen', null, { 'X-Forwarded-For': '198.51.100.7' }, '{}'); if (x.status === 429) n429++; }
    check('requests from one source beyond the per-minute limit are refused with 429', n429 >= 8 && n429 <= 12, n429);
    const other = await jpost(lim.base, '/atlas/call/listen', null, { 'X-Forwarded-For': '198.51.100.8' }, '{}');
    check('another source is counted separately when the proxy names it', other.status === 400, other);
    const chain = await jpost(lim.base, '/atlas/call/listen', null, { 'X-Forwarded-For': '198.51.100.7, 198.51.100.9' }, '{}');
    check('only the last address the proxy appended is believed', chain.status === 400, chain);
    const v6 = [];
    for (let i = 0; i < 35; i++) v6.push((await jpost(lim.base, '/atlas/call/listen', null, { 'X-Forwarded-For': '2001:db8:1:2:' + i.toString(16) + '::1' }, '{}')).status);
    check('an IPv6 client is limited by its /64, not its low bits', v6.filter((s) => s === 429).length >= 3, v6);
    await lim.svc.close();
    const notProxy = await L.startPhpService({ trustProxy: true, proxyAddrs: ['10.9.9.9'] }, { limits: { perSourcePerMin: 30 } });
    let spoof429 = 0;
    for (let i = 0; i < 40; i++) { const x = await jpost(notProxy.base, '/atlas/call/listen', null, { 'X-Forwarded-For': '198.51.100.' + (i + 1) }, '{}'); if (x.status === 429) spoof429++; }
    check('X-Forwarded-For from a connection that is not a configured proxy is ignored', spoof429 >= 8, spoof429);
    await notProxy.svc.close();

    // https
    const hp = await L.startPhpService({ origin: 'https://calls.example.test', trustProxy: true, proxyAddrs: ['127.0.0.1'] }, {});
    let x = await jpost(hp.base, '/atlas/call/listen', null, null, '{}');
    check('behind a proxy, a request without X-Forwarded-Proto is refused as not https', x.status === 400 && x.json.code === 'https-required', x);
    x = await jpost(hp.base, '/atlas/call/listen', null, { 'X-Forwarded-Proto': 'http' }, '{}');
    check('behind a proxy, a request marked http is refused', x.status === 400 && x.json.code === 'https-required', x);
    x = await jpost(hp.base, '/atlas/call/listen', null, { 'X-Forwarded-Proto': 'https' }, '{}');
    check('behind a proxy, a request marked https is processed', x.status === 400 && x.json.code === 'bad-request', x);
    x = await jpost(hp.base, '/atlas/call/listen', null, { 'X-Forwarded-Proto': 'http, https' }, '{}');
    check('only the last X-Forwarded-Proto value counts', x.status === 400 && x.json.code === 'bad-request', x);
    await hp.svc.close();
    const hd = await L.startPhpService({ origin: 'https://calls.example.test' }, {});
    x = await jpost(hd.base, '/atlas/call/listen', null, { 'X-Forwarded-Proto': 'https' }, '{}');
    check('with an https origin and no proxy configured, a plain connection is refused whatever headers it sends', x.status === 400 && x.json.code === 'https-required', x);
    await hd.svc.close();
    const ht = await L.startPhpService({ origin: 'https://calls.example.test', httpsCheck: false }, {});
    x = await jpost(ht.base, '/atlas/call/listen', null, null, '{}');
    check('httpsCheck false leaves the transport check to the operator', x.status === 400 && x.json.code === 'bad-request', x);
    await ht.svc.close();
    await ctx.svc.close();
  }

  // ---------- short polling hints ----------
  {
    const ctx = await L.startPhpService(null, {
      timers: { listenerFreshMs: 6000, sweepMs: 200 }, poll: { listenIdleMs: 1500, ringingMs: 700, setupMs: 400, activeMs: 900 },
      limits: { invitesPerSourcePerMin: 1000, invitesPerCallerPerMin: 1000, invitesPerCalleePerMin: 1000 }
    });
    const alice = await Wallet.create(ctx), bob = await Wallet.create(ctx);
    const info = await fetch(ctx.base + '/atlas/call/info').then((r) => r.json());
    check('info says no request is held and gives the polling intervals', info.limits.listenHoldMs === 0 && info.polling.listenIdleMs === 1500 && info.polling.activeMs === 900 && info.ready === true, info);
    const tag = (await bob.createTag(alice.pub)).json;
    let r = await bob.listen([]);
    check('an idle listen answers at once with the idle interval', r.status === 200 && r.json.events.length === 0 && r.json.nextPollMs === 1500, r);
    const call = await driveCall(ctx, alice, bob, tag, 'ringing');
    r = await bob.listen([]);
    check('a listen with an invitation waiting asks to be repeated sooner', r.json.events.length === 1 && r.json.nextPollMs <= 1000, r);
    r = await alice.poll(call.callId, call.ckA, 0);
    check('a ringing call polls at the ringing interval', r.status === 200 && r.json.nextPollMs === 700, r);
    const c2 = await driveCall(ctx, alice, bob, (await bob.createTag(alice.pub)).json, 'accepted');
    r = await alice.poll(c2.callId, c2.ckA, 0);
    check('an accepted call polls at the setup interval, sooner while an event is waiting', r.json.events.length === 1 && r.json.nextPollMs <= 300, r);
    r = await alice.poll(c2.callId, c2.ckA, r.json.events[0].n);
    check('an accepted call with nothing waiting polls at the setup interval', r.json.events.length === 0 && r.json.nextPollMs === 400, r);
    const c3 = await driveCall(ctx, alice, bob, (await bob.createTag(alice.pub)).json, 'active');
    r = await alice.poll(c3.callId, c3.ckA, 99);
    check('an active call polls at the active interval', r.json.nextPollMs === 900, r);
    await hangup(ctx, c3, 'A');
    r = await bob.poll(c3.callId, c3.ckB, 99);
    check('an ended call asks for no further polling', r.json.nextPollMs === 0, r);
    await ctx.svc.close();
  }

  // ---------- time limits without a background process ----------
  {
    const ctx = await L.startPhpService(null, {
      timers: { sweepMs: 600000, acceptToOfferMs: 800, silentActiveMs: 900, listenerFreshMs: 6000 },
      limits: { invitesPerSourcePerMin: 1000, invitesPerCallerPerMin: 1000, invitesPerCalleePerMin: 1000 }
    });
    const alice = await Wallet.create(ctx), bob = await Wallet.create(ctx);
    const tag = (await bob.createTag(alice.pub, { maxCalls: 50 })).json;
    // ring timeout seen by the caller and the callee, with no sweep having run since the invite
    const built0 = await (async () => { await bob.listen([]); return alice.buildInvite(tag.tag, bob.pub, { expiresAt: iso(Date.now() + 900) }); })();
    const inv = await alice.invite(built0);
    await sleep(1100);
    let r = await alice.poll(built0.callId, built0.ck, 0);
    check('a ring that ran out is reported to the caller the next time it asks, with no sweep needed', inv.status === 202 && r.json.events.some((e) => e.type === 'ended' && e.reason === 'timeout'), r);
    r = await bob.listen([]);
    check('the callee\'s listener is told the invitation ended', r.json.events.some((e) => e.type === 'ended' && e.callId === built0.callId && e.reason === 'timeout') && !r.json.events.some((e) => e.type === 'invite' && e.callId === built0.callId), r);
    // an accepted call that gets no offer
    const c = await driveCall(ctx, alice, bob, tag, 'accepted');
    await sleep(1000);
    r = await bob.poll(c.callId, c.ckB, 0);
    check('an accepted call without an offer ends as timeout when next polled', r.json.events.some((e) => e.type === 'ended' && e.reason === 'timeout'), r);
    // an active call that goes silent
    const c2 = await driveCall(ctx, alice, bob, tag, 'active');
    check('a call reaches ACTIVE through the PHP service', c2.stage === 'active' && c2.confirmB.status === 202, c2.confirmB);
    await sleep(1100);
    r = await bob.poll(c2.callId, c2.ckB, 0);
    check('a silent active call ends as network-lost when someone next asks', r.json.events.some((e) => e.type === 'ended' && e.reason === 'network-lost'), r);
    const sig = await hangup(ctx, c2, 'A');
    check('a signal for a call that has ended is refused', sig.status === 404, sig);
    await ctx.svc.close();
  }

  // ---------- the lock ----------
  {
    const ctx = await L.startPhpService(null, { timers: { lockWaitMs: 600 } });
    const alice = await Wallet.create(ctx), bob = await Wallet.create(ctx);
    await bob.createTag(alice.pub);
    const holder = spawn('php', ['-r', '$h = fopen($argv[1], "c"); flock($h, LOCK_EX); echo "held\\n"; sleep(3);', path.join(ctx.cfg.stateDir, 'lock')], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise((r) => holder.stdout.once('data', r));
    const t0 = Date.now();
    const blocked = await bob.createTag(alice.pub);
    const waited = Date.now() - t0;
    check('while another process holds the lock a request waits, then is told to retry with 503', blocked.status === 503 && blocked.json.code === 'busy' && waited >= 500 && waited < 2500, { blocked, waited });
    const stateBefore = fs.readdirSync(path.join(ctx.cfg.stateDir, 'tags')).length;
    holder.kill();
    await sleep(300);
    const after = await bob.createTag(alice.pub);
    check('the same request succeeds once the lock is released', after.status === 200, after);
    check('the refused request changed nothing', fs.readdirSync(path.join(ctx.cfg.stateDir, 'tags')).length >= stateBefore);
    await ctx.svc.close();
  }

  // ---------- revocations read from the issuer's file ----------
  {
    const issuer = await T.newIssuer('example.com');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-rev-'));
    const revFile = path.join(dir, 'atlas-revocations.json');
    fs.writeFileSync(revFile, JSON.stringify({ revoked: [] }));
    const ctx = await L.startPhpService({ revocationsFile: revFile }, { issuer });
    const e1 = await Wallet.create(ctx), e2 = await Wallet.create(ctx);
    const cred = await issuer.membership(e1.pub);
    let r = await e1.createTag(e2.pub, {}, cred);
    check('with the issuer\'s revocation file readable, a current membership works', r.status === 200, r);
    fs.writeFileSync(revFile, JSON.stringify({ revoked: [{ id: cred.id, at: iso(Date.now()) }] }));
    r = await e1.createTag(e2.pub, {}, cred);
    check('a revocation written to the file takes effect on the next request', r.status === 403 && r.json.code === 'membership-required', r);
    const cred2 = await issuer.membership(e1.pub);
    r = await e1.createTag(e2.pub, {}, cred2);
    check('other memberships are unaffected by that revocation', r.status === 200, r);
    fs.writeFileSync(revFile, '{not json');
    r = await e1.createTag(e2.pub, {}, await issuer.membership(e1.pub));
    check('a revocation file that is not valid JSON makes tag creation fail closed', r.status === 503 && r.json.code === 'revocations-unavailable', r);
    fs.writeFileSync(revFile, JSON.stringify({ revoked: 'no' }));
    r = await e1.createTag(e2.pub, {}, await issuer.membership(e1.pub));
    check('a revocation file whose list is not a list is treated as empty, as the issuer writes it', r.status === 200, r);
    fs.rmSync(revFile);
    r = await e1.createTag(e2.pub, {}, await issuer.membership(e1.pub));
    check('a missing revocation file makes tag creation fail closed', r.status === 503, r);
    const tags = await e1.listTags();
    check('tags made before the revocation file went missing still work for their owner', tags.status === 200 && tags.json.tags.length >= 2, tags);
    await ctx.svc.close();
    const noRev = await L.startPhpService({}, { issuer });
    const f1 = await Wallet.create(noRev), f2 = await Wallet.create(noRev);
    const cr = await issuer.membership(f1.pub);
    check('without a revocation source memberships are checked for signature, owner, domain and expiry only', (await f1.createTag(f2.pub, {}, cr)).status === 200);
    await noRev.svc.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---------- TURN credentials ----------
  {
    const secret = crypto.randomBytes(32).toString('hex');
    const ctx = await L.startPhpService({ turnUrls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349?transport=tcp'], turnSecret: secret, turnTtlSeconds: 600, stunUrls: ['stun:turn.example.com:3478'] }, { limits: { invitesPerSourcePerMin: 1000, invitesPerCallerPerMin: 1000, invitesPerCalleePerMin: 1000 } });
    const alice = await Wallet.create(ctx), bob = await Wallet.create(ctx);
    const info = await fetch(ctx.base + '/atlas/call/info').then((r) => r.json());
    check('info lists the TURN URLs and never the secret', info.ice.turn === true && info.ice.turnUrls.length === 2 && !JSON.stringify(info).includes(secret), info);
    const tag = (await bob.createTag(alice.pub)).json;
    const ringing = await driveCall(ctx, alice, bob, tag, 'ringing');
    let r = await alice.ice(ringing.callId, ringing.ckA);
    check('no TURN credential is issued while a call only rings', r.status === 404, r);
    const c = await driveCall(ctx, alice, bob, (await bob.createTag(alice.pub)).json, 'accepted');
    r = await alice.ice(c.callId, c.ckA);
    const turn = r.json.iceServers.find((s) => s.username);
    const stun = r.json.iceServers.find((s) => !s.username);
    check('an accepted call gets STUN and one TURN credential', r.status === 200 && stun.urls[0] === 'stun:turn.example.com:3478' && turn.urls.length === 2, r);
    const want = crypto.createHmac('sha1', secret).update(turn.username).digest('base64');
    check('the credential is the base64 HMAC-SHA1 of the user name under the shared secret', turn.credential === want, turn);
    check('the user name is an expiry time and a random label, with no call id or key', /^\d{10}:[A-Za-z0-9_-]{11}$/.test(turn.username) && !turn.username.includes(c.callId) && !turn.username.includes(alice.pub), turn.username);
    const ttlLeft = Number(turn.username.split(':')[0]) - Math.floor(Date.now() / 1000);
    check('the credential lives for the configured time and says when it expires', ttlLeft > 560 && ttlLeft <= 600 && r.json.ttl === 600 && Date.parse(r.json.credentialExpiresAt) === Number(turn.username.split(':')[0]) * 1000, { ttlLeft, body: r.json });
    const second = await alice.ice(c.callId, c.ckA), third = await alice.ice(c.callId, c.ckA), fourth = await alice.ice(c.callId, c.ckA);
    check('a side may fetch three credentials per call and no more', second.status === 200 && third.status === 200 && fourth.status === 429, [second.status, third.status, fourth.status]);
    check('each credential is different', new Set([r, second, third].map((x) => x.json.iceServers.find((s) => s.username).username)).size === 3);
    const bobIce = await bob.ice(c.callId, c.ckB);
    check('the other side has its own allowance', bobIce.status === 200 && bobIce.json.iceServers.some((s) => s.username));
    const outsider = await alice.ice(c.callId, (await T.newIdentity()));
    check('a key that is not part of the call gets no credential', outsider.status === 404, outsider);
    await hangup(ctx, { callId: c.callId, ckA: c.ckA, ckB: c.ckB, th: c.th, seqA: 0, seqB: 0 }, 'A');
    const plainCtx = await L.startPhpService({ stunUrls: ['stun:turn.example.com:3478'] }, {});
    const pa = await Wallet.create(plainCtx), pb = await Wallet.create(plainCtx);
    const pc = await driveCall(plainCtx, pa, pb, (await pb.createTag(pa.pub)).json, 'accepted');
    const pr = await pa.ice(pc.callId, pc.ckA);
    check('without TURN settings only STUN is returned', pr.status === 200 && pr.json.iceServers.length === 1 && !pr.json.iceServers[0].username && pr.json.credentialExpiresAt === undefined, pr);
    await plainCtx.svc.close();
    await ctx.svc.close();
  }

  // ---------- housekeeping ----------
  {
    const ctx = await L.startPhpService(null, { timers: { sweepMs: 200, listenerFreshMs: 1200 }, poll: { listenIdleMs: 400 }, limits: { invitesPerSourcePerMin: 1000 } });
    const alice = await Wallet.create(ctx), bob = await Wallet.create(ctx), stranger = await Wallet.create(ctx);
    const state = ctx.cfg.stateDir;
    const short = (await bob.createTag(alice.pub, { expiresAt: iso(Date.now() + 1500) })).json;
    await stranger.listen([]);
    check('a listening wallet has a mailbox file', fs.readdirSync(path.join(state, 'listeners')).length === 1);
    const metaPath = path.join(state, 'meta.json');
    await sleep(2600);
    const old = path.join(state, 'nonces', String(Math.floor(Date.now() / 60000) - 20));
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'aa.dat'), 'x'.repeat(31));
    const oldRate = path.join(state, 'rate', 'zz.json');
    fs.writeFileSync(oldRate, '{}');
    fs.utimesSync(oldRate, new Date(Date.now() - 300000), new Date(Date.now() - 300000));
    const meta = readJson(metaPath); meta.slowAt = 0; fs.writeFileSync(metaPath, JSON.stringify(meta));
    await ctx.svc.sweep();
    check('an old nonce bucket is removed by the sweep', !fs.existsSync(old));
    check('a rate counter file with nothing current is removed by the sweep', !fs.existsSync(oldRate));
    check('a listener mailbox that stopped asking is removed and the count follows', fs.readdirSync(path.join(state, 'listeners')).length === 0 && readJson(metaPath).listeners === 0, readJson(metaPath));
    const ownerFiles = fs.readdirSync(path.join(state, 'owners'));
    const before = readJson(metaPath).tags;
    // the tag's shard is visited within sixteen slow sweeps
    for (let i = 0; i < 16; i++) { const m = readJson(metaPath); m.slowAt = 0; fs.writeFileSync(metaPath, JSON.stringify(m)); await ctx.svc.sweep(); }
    const tagFiles = []; const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else tagFiles.push(p); } };
    walk(path.join(state, 'tags'));
    check('an expired tag is removed from disk by the sweep', before === 1 && tagFiles.length === 0 && readJson(metaPath).tags === 0 && fs.readdirSync(path.join(state, 'owners')).length === 0, { before, tagFiles, ownerFiles, meta: readJson(metaPath) });
    const listed = await bob.listTags();
    check('an expired tag is not listed', listed.json.tags.length === 0, listed);
    await ctx.svc.close();
  }

  // ---------- limits ----------
  {
    const ctx = await L.startPhpService(null, { limits: { maxListeners: 2, maxLiveCalls: 2, maxSignalsPerCall: 10, invitesPerSourcePerMin: 1000, invitesPerCallerPerMin: 1000, invitesPerCalleePerMin: 1000 }, timers: { listenerFreshMs: 6000 } });
    const members = [await Wallet.create(ctx), await Wallet.create(ctx), await Wallet.create(ctx)];
    const callers = [await Wallet.create(ctx), await Wallet.create(ctx), await Wallet.create(ctx)];
    const s1 = await Wallet.create(ctx), s2 = await Wallet.create(ctx), s3 = await Wallet.create(ctx);
    check('strangers may listen up to maxListeners', (await s1.listen([])).status === 200 && (await s2.listen([])).status === 200);
    const full = await s3.listen([]);
    check('a stranger beyond maxListeners is told the service is busy', full.status === 503 && full.json.code === 'busy', full);
    check('a stranger already listening is still served when the limit is reached', (await s1.listen([])).status === 200);
    const tags = [];
    for (let i = 0; i < 3; i++) tags.push((await members[i].createTag(callers[i].pub)).json);
    check('a wallet that holds a tag may listen even when strangers have filled the limit', (await members[0].listen([])).status === 200);
    await members[1].listen([]); await members[2].listen([]);
    const i1 = await callers[0].invite(await callers[0].buildInvite(tags[0].tag, members[0].pub));
    const i2 = await callers[1].invite(await callers[1].buildInvite(tags[1].tag, members[1].pub));
    const i3 = await callers[2].invite(await callers[2].buildInvite(tags[2].tag, members[2].pub));
    check('invitations beyond maxLiveCalls are refused as unavailable', i1.status === 202 && i2.status === 202 && i3.status === 404, [i1.status, i2.status, i3.status]);
    // maxSignalsPerCall: ten signals of any kind end the call
    const c = await driveCall(ctx, callers[0], members[0], (await members[0].createTag(callers[0].pub)).json, 'accepted').catch((e) => ({ err: e }));
    await ctx.svc.close();
    const sig = await L.startPhpService(null, { limits: { maxSignalsPerCall: 10, invitesPerSourcePerMin: 1000, invitesPerCallerPerMin: 1000, invitesPerCalleePerMin: 1000 } });
    const a = await Wallet.create(sig), b = await Wallet.create(sig);
    const call = await driveCall(sig, a, b, (await b.createTag(a.pub)).json, 'accepted');
    for (let i = 0; i < 12; i++) await sendSignal(sig, signalPayload(sig, call.callId, 'answer', { sdp: 'v=0\r\n' + 'a'.repeat(30), offerHash: P.randomId(32) }, 1, call.th), call.ckB);
    const polled = await a.poll(call.callId, call.ckA, 0);
    check('a call that receives more than maxSignalsPerCall messages is ended with an error', polled.status === 200 && polled.json.events.some((e) => e.type === 'ended' && e.reason === 'error'), polled);
    await sig.svc.close();
  }

  // ---------- refusal reasons for the operator ----------
  {
    const run = async (logRefusals) => {
      const ctx = await L.startPhpService(logRefusals ? { logRefusals: true } : {}, {});
      const alice = await Wallet.create(ctx), bob = await Wallet.create(ctx), mallory = await Wallet.create(ctx);
      const tag = (await bob.createTag(alice.pub)).json;
      const replies = [];
      replies.push(await alice.invite(await alice.buildInvite(tag.tag, bob.pub)));
      await bob.listen([]);
      replies.push(await mallory.invite(await mallory.buildInvite(tag.tag, bob.pub)));
      replies.push(await alice.invite(await alice.buildInvite(P.randomId(16), bob.pub)));
      replies.push(await alice.invite(await alice.buildInvite(tag.tag, mallory.pub)));
      const ok = await alice.invite(await alice.buildInvite(tag.tag, bob.pub));
      replies.push(await alice.invite(await alice.buildInvite(tag.tag, bob.pub)));
      const log = ctx.svc.log();
      const dump = JSON.stringify([tag.tag, alice.pub, bob.pub, mallory.pub]);
      await ctx.svc.close();
      return { replies, ok, log, ids: JSON.parse(dump) };
    };
    const on = await run(true), off = await run(false);
    const reasons = (on.log.match(/invite refused: [a-z,-]+/g) || []).map((x) => x.replace('invite refused: ', ''));
    check('with logRefusals on, each refused invitation logs its reason', JSON.stringify(reasons) === JSON.stringify(['callee-not-listening', 'tag-not-bound-to-this-caller', 'no-such-tag', 'callee-key-differs-from-tag', 'another-call-is-ringing-on-this-tag']), reasons);
    {
      const ctx = await L.startPhpService({ logRefusals: true }, { timers: { listenerFreshMs: 600 } });
      const alice = await Wallet.create(ctx), bob = await Wallet.create(ctx);
      const tag = (await bob.createTag(alice.pub)).json;
      await bob.listen([]);
      await sleep(1300);
      await alice.invite(await alice.buildInvite(tag.tag, bob.pub));
      const m = ctx.svc.log().match(/callee-not-listening \(listener last seen (\d+) ms ago, allowed 600\)/);
      check('a listener that has gone quiet is reported with how long ago it was last seen', !!m && Number(m[1]) >= 1000 && Number(m[1]) < 5000, ctx.svc.log().slice(-200));
      await ctx.svc.close();
    }
    check('the log holds no tag, no key and no caller address', on.ids.every((x) => !on.log.includes(x)));
    check('the reply to a refused invitation is the same whatever the reason', new Set(on.replies.filter((r) => r.status === 404).map((r) => JSON.stringify(r))).size === 1 && on.replies.filter((r) => r.status === 404).length === 5, on.replies.map((r) => r.status));
    check('the accepted invitation is unaffected', on.ok.status === 202 && off.ok.status === 202);
    check('with logRefusals off nothing about refusals is logged and the replies are the same', !/invite refused/.test(off.log) && off.replies.map((r) => r.status).join() === on.replies.map((r) => r.status).join());
    check('logRefusals is documented in the settings example', /logRefusals/.test(fs.readFileSync(path.join(ROOT, 'atlas', 'call', 'lib', 'config.example.php'), 'utf8')));
  }

  // ---------- the wallet's re-ask delay ----------
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'call.js'), 'utf8');
    const m = src.match(/function repollDelay\([^)]*\) \{[\s\S]*?\n  \}/);
    const repoll = m ? new Function(m[0] + '; return repollDelay;')() : null;
    check('the wallet has a re-ask delay function', typeof repoll === 'function');
    if (repoll) {
      check('a service hint is followed', repoll({ nextPollMs: 1500 }, 10, 0, 15000) === 1500);
      check('a hint below 100 ms is raised to 100 ms', repoll({ nextPollMs: 0 }, 10, 0, 15000) === 100 && repoll({ nextPollMs: 5 }, 10, 0, 15000) === 100);
      check('a hint above the wallet\'s ceiling is cut to it', repoll({ nextPollMs: 600000 }, 10, 0, 15000) === 15000 && repoll({ nextPollMs: 9000 }, 10, 0, 5000) === 5000);
      check('a hint that is not a whole number is ignored', repoll({ nextPollMs: '1500' }, 3000, 0, 15000) === 0 && repoll({ nextPollMs: 1.5 }, 3000, 1, 15000) === 0 && repoll(null, 3000, 1, 15000) === 0);
      check('a held request that came back after a long wait needs no pause (Node service)', repoll({}, 25000, 0, 15000) === 0);
      check('an empty reply that came back at once with no hint gets a pause, so the wallet never spins', repoll({}, 20, 0, 15000) === 500);
      check('a reply that carries events is acted on without a pause', repoll({}, 20, 2, 15000) === 0);
    }
  }

  // ---------- the deployment checker ----------
  {
    const http = require('http');
    const checker = path.join(__dirname, '..', 'call-server', 'check-deployment.js');
    const ctx = await L.startPhpService(null, {});
    const good = spawnSync('node', [checker, ctx.origin, '--allow-http'], { encoding: 'utf8' });
    check('the deployment checker passes a correctly installed PHP service', good.status === 0 && /PASS a listen is answered at once/.test(good.stdout) && /PASS settings, state and source files are not served/.test(good.stdout), good.stdout.split('\n').filter((l) => /^FAIL/.test(l)));
    check('the checker does not ask a short-polling service to hold a request', !/waiting up to/.test(good.stdout));
    await ctx.svc.close();

    // A front that forwards every request but answers the library folder itself, the way a
    // host that ignores the .htaccess rules would serve those files.
    const leakWith = async (body, status) => {
      let backend = null;
      const front = http.createServer(async (req, res) => {
        if (/^\/atlas\/call\/lib\//.test(req.url)) { res.writeHead(status, { 'Content-Type': 'text/plain' }); res.end(body); return; }
        const chunks = []; for await (const c of req) chunks.push(c);
        const headers = { 'content-type': req.headers['content-type'] || 'application/json' };
        if (req.headers.origin) headers.origin = req.headers.origin;
        const r = await fetch(backend.base + req.url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
        res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !/^(content-encoding|content-length|transfer-encoding|connection)$/i.test(k))));
        res.end(Buffer.from(await r.arrayBuffer()));
      });
      await new Promise((r) => front.listen(0, '127.0.0.1', r));
      const origin = 'http://127.0.0.1:' + front.address().port;
      backend = await L.startPhpService({ origin }, {});
      const run = await new Promise((resolve) => {
        const c = spawn('node', [checker, origin, '--allow-http']);
        let out = '';
        c.stdout.on('data', (d) => { out += d; });
        c.on('close', (status) => resolve({ status, stdout: out }));
      });
      await backend.svc.close();
      front.close();
      return run;
    };
    const leaky = await leakWith("<?php return ['issuerKeys' => []];", 200);
    check('the checker fails a host that serves the source or settings of the service', leaky.status === 1 && /FAIL settings, state and source files are not served/.test(leaky.stdout), leaky.stdout);
    const stateLeak = await leakWith('{"tags":3}', 200);
    check('the checker fails a host that serves files from the state folder', stateLeak.status === 1 && /FAIL settings, state and source files are not served/.test(stateLeak.stdout));
    const refused = await leakWith('forbidden', 403);
    check('the checker accepts a host that refuses every file in the library folder', refused.status === 0 && /PASS settings, state and source files are not served/.test(refused.stdout), refused.stdout);
  }

  // ---------- the upload bundle ----------
  {
    const walk = (d, rel) => fs.readdirSync(d, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? walk(path.join(d, f.name), rel + f.name + '/') : [rel + f.name]));
    const files = walk(path.join(ROOT, 'atlas', 'call'), '').sort();
    const expected = ['.htaccess', 'info.php', 'invite.php', 'ice.php', 'listen.php', 'poll.php', 'signal.php', 'tag/create.php', 'tag/list.php', 'tag/revoke.php',
      'lib/.htaccess', 'lib/bootstrap.php', 'lib/config.example.php', 'lib/protocol.php', 'lib/service.php', 'lib/store.php'].sort();
    check('the folder to upload holds exactly the documented files', JSON.stringify(files) === JSON.stringify(expected), { extra: files.filter((f) => !expected.includes(f)), missing: expected.filter((f) => !files.includes(f)) });
    let lintOk = true; const lintFailures = [];
    for (const f of files.filter((x) => x.endsWith('.php'))) {
      const r = spawnSync('php', ['-l', path.join(ROOT, 'atlas', 'call', f)], { encoding: 'utf8' });
      if (r.status !== 0) { lintOk = false; lintFailures.push(f); }
    }
    check('every PHP file passes the PHP syntax check', lintOk, lintFailures);
    const code = files.filter((x) => x.endsWith('.php')).map((f) => [f, fs.readFileSync(path.join(ROOT, 'atlas', 'call', f), 'utf8')]);
    const newer = /\b(match\s*\(|str_contains\(|str_starts_with\(|str_ends_with\(|array_is_list\(|enum\s+\w+|readonly\s|never\b\s*\{)|\?->|#\[|(^|[^$\w>:])fn\s*\(/m;
    check('no PHP file uses syntax or functions newer than PHP 7.4', code.every(([f, c]) => !newer.test(c.replace(/\/\/.*$/gm, ''))), code.filter(([f, c]) => newer.test(c.replace(/\/\/.*$/gm, ''))).map(([f]) => f));
    check('the entry files are stubs that only load the bootstrap and serve their route', code.filter(([f]) => !f.startsWith('lib/')).every(([f, c]) => c.split('\n').filter((l) => l.trim()).length <= 3), null);
    check('the settings example is the only settings file in the bundle and fetching it directly prints nothing', !files.includes('lib/config.php') && spawnSync('php', [path.join(ROOT, 'atlas', 'call', 'lib', 'config.example.php')], { encoding: 'utf8' }).stdout === '');
    const htaccess = fs.readFileSync(path.join(ROOT, 'atlas', 'call', 'lib', '.htaccess'), 'utf8');
    check('lib/.htaccess denies web access in both Apache 2.4 and 2.2 syntax', /Require all denied/.test(htaccess) && /Deny from all/.test(htaccess));
    const ctx = await L.startPhpService(null, {});
    const sec = await Promise.all(['/atlas/call/lib/config.php', '/atlas/call/lib/protocol.php', '/atlas/call/lib/state/lock', '/atlas/call/lib/config.example.php'].map((p) => fetch(ctx.base + p).then((r) => r.status)));
    check('nothing under lib/ is served by the test router that reproduces the .htaccess rule', sec.every((s) => s === 403), sec);
    const tagDirectly = await fetch(ctx.base + '/atlas/call/tag/create.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('a route can be reached with or without .php', tagDirectly.status === 400);
    await ctx.svc.close();
    const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
    check('state and settings of a deployed service are ignored by git', /call-php\/atlas\/call\/lib\/config\.php/.test(gi) && /call-php\/atlas\/call\/lib\/state/.test(gi), gi.split('\n').filter((l) => /call-php/.test(l)));
  }

  process.exit(T.finish('manual-call-php-hosting'));
})().catch((e) => { console.error(e); process.exit(2); });
