// Call Service safeguards for internet exposure: configuration checks, operator STUN, proxy
// handling, cross-origin rules, connection and long-poll limits, slow clients. No browser needed.
// Runs the service in this process on loopback with short timers.
// Run: node test/manual-call-internet-security.js
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const T = require('./call-test-lib');
const S = require('../call-server/server');
const { P, check, sleep, newIdentity, sign, base, nonce, Wallet, fp, signalPayload, sendSignal } = T;

// A raw HTTP request, so headers such as Origin and X-Forwarded-For are sent exactly as written.
function rq(ctx, method, route, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const body = opts.body === undefined ? undefined : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    const headers = Object.assign({}, opts.headers || {});
    if (body !== undefined && !('Content-Type' in headers) && opts.noType !== true) headers['Content-Type'] = 'application/json';
    if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body);
    const started = Date.now();
    const r = http.request({ host: '127.0.0.1', port: Number(new URL(ctx.base).port), method, path: route, headers, signal: opts.signal }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* none */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text, ms: Date.now() - started });
      });
    });
    r.on('error', (e) => resolve({ error: e.code || e.message, ms: Date.now() - started }));
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const post = (ctx, route, body, headers) => rq(ctx, 'POST', route, { body, headers });

async function listenAs(w, xff, signal) {
  w.sess = w.sess || await w.session();
  const payload = base('atlas.call.listen', w.ctx.origin, { nonce: nonce(), ack: [] });
  const body = { payload, proof: await sign(payload, w.sess.sk), session: w.sess.delegation };
  return rq(w.ctx, 'POST', '/atlas/call/listen', { body, headers: xff ? { 'X-Forwarded-For': xff } : {}, signal });
}
// Starts a request and lets the test look at whether it has answered yet.
function track(promise) {
  const t = { done: false, res: null };
  t.promise = promise.then((r) => { t.done = true; t.res = r; return r; });
  return t;
}

const VALID_KEY = async () => (await T.newIssuer('example.com')).ident.pub;
const envFor = (key, over) => Object.assign({ CALL_ORIGIN: 'https://calls.example.com', CALL_DOMAIN: 'example.com', CALL_ISSUER_KEYS: key }, over || {});

(async () => {
  const key = await VALID_KEY();

  // ---------- configuration ----------
  {
    const none = S.loadConfig({});
    check('with no settings the service is not configured and binds to loopback', none.configured === false && none.bind === '127.0.0.1');
    check('the defaults offer no STUN, no proxy trust, no cross-origin access and no plain http', none.stunUrls.length === 0 && !none.trustProxy && none.corsOrigins.length === 0 && !none.devAllowHttp);
    check('the default trusted proxy addresses are loopback only', JSON.stringify(none.proxyAddrs) === JSON.stringify(['127.0.0.1', '::1']));

    const good = S.loadConfig(envFor(key, { CALL_STUN_URLS: 'stun:stun.example.com:3478, stun:203.0.113.5, stun:[2001:db8::1]:3478' }));
    check('own STUN servers (name, IPv4, IPv6) are accepted', good.configured === true && good.stunUrls.length === 3, good.problem);
    const bads = [
      ['a malformed URL', 'stun:'], ['an https URL', 'https://stun.example.com'], ['a path', 'stun:host.example.com/x'], ['a query', 'stun:host.example.com?transport=udp'],
      ['a user part', 'stun:user@host.example.com'], ['port 0', 'stun:host.example.com:0'], ['port 70000', 'stun:host.example.com:70000'],
      ['a turn URL', 'turn:host.example.com'], ['an underscore host', 'stun:bad_host.example.com'], ['numbers that are not an address', 'stun:300.300.300.300'],
      ['a public Google STUN server', 'stun:stun.l.google.com:19302'], ['a public Google STUN server (other number)', 'stun:stun3.l.google.com:3478'],
      ['a public Cloudflare STUN server', 'stun:stun.cloudflare.com:3478'], ['a public Twilio STUN server', 'stun:global.stun.twilio.com:3478'],
      ['a public Mozilla STUN server', 'stun:stun.services.mozilla.com'], ['a public third-party server spelled in capitals', 'stun:STUN.L.GOOGLE.COM:19302']
    ];
    for (const [name, url] of bads) {
      const c = S.loadConfig(envFor(key, { CALL_STUN_URLS: url }));
      check('STUN setting is refused for ' + name, c.configured === false && /CALL_STUN_URLS/.test(c.problem || ''), c.problem);
    }
    check('more than three STUN servers are refused', S.loadConfig(envFor(key, { CALL_STUN_URLS: 'stun:a.example.com,stun:b.example.com,stun:c.example.com,stun:d.example.com' })).configured === false);
    check('a host that merely ends in a third-party name is judged by whole labels', S.loadConfig(envFor(key, { CALL_STUN_URLS: 'stun:myl.google.com.example.org' })).configured === true);

    check('proxy addresses must be IP addresses', S.loadConfig(envFor(key, { CALL_PROXY_ADDRS: 'proxy.example.com' })).configured === false);
    check('proxy addresses are accepted', S.loadConfig(envFor(key, { CALL_PROXY_ADDRS: '10.1.2.3, ::1', CALL_TRUST_PROXY: '1' })).configured === true);
    for (const o of ['*', 'https://*.example.com', 'https://app.example.com/path', 'app.example.com', 'http://app.example.com']) {
      check('cross-origin allow-list refuses ' + o, S.loadConfig(envFor(key, { CALL_INVITE_CORS_ORIGINS: o })).configured === false);
    }
    check('cross-origin allow-list accepts an exact https origin', S.loadConfig(envFor(key, { CALL_INVITE_CORS_ORIGINS: 'https://app.example.com' })).configured === true);

    const lim = S.loadConfig(envFor(key, { CALL_LIMIT_MAX_WAITERS_PER_SOURCE: '7', CALL_LIMIT_MAX_CONNECTIONS: '500' }));
    check('limits can be set by environment within their range', lim.configured === true && lim.limits.maxWaitersPerSource === 7 && lim.limits.maxConnections === 500, lim.problem);
    check('a limit outside its range leaves the service unconfigured', S.loadConfig(envFor(key, { CALL_LIMIT_MAX_WAITERS: '0' })).configured === false);
    check('a limit that is not a number leaves the service unconfigured', S.loadConfig(envFor(key, { CALL_LIMIT_MAX_WAITERS: 'lots' })).configured === false);
    const viaFile = S.loadConfig(envFor(key, { CALL_CONFIG_FILE: '/x.json' }), () => JSON.stringify({ limits: { maxWaitersPerSource: 9 } }));
    check('limits can be set in the configuration file', viaFile.configured === true && viaFile.limits.maxWaitersPerSource === 9, viaFile.problem);
    const unknown = S.loadConfig(envFor(key, { CALL_CONFIG_FILE: '/x.json' }), () => JSON.stringify({ limits: { maxEverything: 9 } }));
    check('an unknown limit name leaves the service unconfigured', unknown.configured === false && /maxEverything/.test(unknown.problem));
  }

  // ---------- the local two-computer demo configuration still loads unchanged ----------
  {
    const demo = S.loadConfig({ CALL_ORIGIN: 'http://192.168.1.20:8787', CALL_DOMAIN: 'localhost:8002', CALL_ISSUER_KEYS: key, CALL_BIND: '0.0.0.0', CALL_DEV_ALLOW_HTTP: '1', CALL_REVOCATIONS_URL: 'http://localhost:8002/.well-known/atlas-revocations.json', CALL_DEV_ALLOW_PRIVATE_FETCH: '1' });
    check('the settings from docs/voice-calls-two-pc-setup.md still give a configured service with no proxy trust, no STUN and no cross-origin access', demo.configured === true && demo.trustProxy === false && demo.stunUrls.length === 0 && demo.corsOrigins.length === 0 && demo.bind === '0.0.0.0', demo.problem);
    const demoStun = S.loadConfig({ CALL_ORIGIN: 'http://192.168.1.20:8787', CALL_DOMAIN: 'localhost:8002', CALL_ISSUER_KEYS: key, CALL_DEV_ALLOW_HTTP: '1', CALL_STUN_URLS: 'stun:192.168.1.20:3478' });
    check('a STUN server on the local network, named by its address, is accepted', demoStun.configured === true, demoStun.problem);
  }

  // ---------- address handling ----------
  check('an IPv4-mapped address is its IPv4 address', S.normalizeIp('::ffff:203.0.113.9') === '203.0.113.9' && S.sourceKey(S.normalizeIp('::ffff:203.0.113.9')) === '203.0.113.9');
  check('an IPv6 address is keyed on its /64', S.sourceKey('2001:db8:1:2:aaaa::1') === S.sourceKey('2001:DB8:1:2:bbbb:cccc:dddd:eeee') && S.sourceKey('2001:db8:1:2::1') !== S.sourceKey('2001:db8:1:3::1'));
  check('compressed and full IPv6 forms of the same prefix agree', S.sourceKey('2001:db8::1') === S.sourceKey('2001:0db8:0000:0000:0000:0000:0000:0001'));
  check('a zone suffix is ignored', S.normalizeIp('fe80::1%eth0') === 'fe80::1');
  check('something that is not an address has no key', S.sourceKey('not-an-ip') === '');

  // ---------- proxy handling: which address a request is counted against ----------
  {
    const probe = async (ctx, xff) => {
      const out = [];
      for (let i = 0; i < 4; i++) out.push((await post(ctx, '/atlas/call/listen', '{}', xff ? { 'X-Forwarded-For': xff } : {})).status);
      return out;
    };
    const mk = async (cfg) => T.startService(cfg, { limits: { perSourcePerMin: 3 } });
    // trusted proxy: the last entry decides, earlier (client-supplied) entries are ignored
    let c = await mk({ trustProxy: true });
    const a1 = await probe(c, '9.9.9.9, 198.51.100.1');
    const a2 = await probe(c, '9.9.9.9, 198.51.100.2');
    check('behind a trusted proxy each real client has its own limit', a1[3] === 429 && a2[0] === 400 && a2[2] === 400 && a2[3] === 429, { a1, a2 });
    const sp = await probe(c, '1.1.1.1, 2.2.2.2, 198.51.100.3');
    const sp2 = await probe(c, '3.3.3.3, 4.4.4.4, 198.51.100.3');
    check('a client cannot change its identity by writing earlier X-Forwarded-For entries', sp[3] === 429 && sp2[0] === 429, { sp, sp2 });
    const v6a = await probe(c, '2001:db8:5:6:1::1');
    const v6b = await probe(c, '2001:db8:5:6:2::2');
    check('addresses in one IPv6 /64 share one limit', v6a[3] === 429 && v6b[0] === 429, { v6a, v6b });
    const junk = await probe(c, 'garbage, not-an-ip');
    check('a malformed X-Forwarded-For falls back to the connecting address', junk[0] === 400 && junk[3] === 429, junk);
    const noh = await probe(c, null);
    check('without X-Forwarded-For the connecting address is used', noh[0] === 429 || noh[3] === 429, noh);
    await c.svc.close();

    // proxy trust off: the header is ignored
    c = await mk({ trustProxy: false });
    const o1 = await probe(c, '198.51.100.10');
    const o2 = await probe(c, '198.51.100.11');
    check('without CALL_TRUST_PROXY the X-Forwarded-For header is ignored', o1[3] === 429 && o2[0] === 429, { o1, o2 });
    await c.svc.close();

    // proxy trust on, but the connection is not from a listed proxy: the header is ignored
    c = await mk({ trustProxy: true, proxyAddrs: ['10.99.99.99'] });
    const u1 = await probe(c, '198.51.100.20');
    const u2 = await probe(c, '198.51.100.21');
    check('a connection that is not from a configured proxy cannot choose its own address', u1[3] === 429 && u2[0] === 429, { u1, u2 });
    await c.svc.close();
  }

  // ---------- https behind a proxy ----------
  {
    const mkHttps = async (extra) => T.startService(Object.assign({ origin: 'https://calls.example.test', devAllowHttp: false, trustProxy: true }, extra || {}));
    let c = await mkHttps();
    let r = await post(c, '/atlas/call/invite', '{}', { 'X-Forwarded-Proto': 'https' });
    check('behind a trusted proxy an https request is handled', r.status === 400 && r.json.code === 'bad-request', r);
    r = await post(c, '/atlas/call/invite', '{}');
    check('a request that does not say it was https is refused', r.status === 400 && r.json.code === 'https-required', r);
    r = await post(c, '/atlas/call/invite', '{}', { 'X-Forwarded-Proto': 'http' });
    check('a request the proxy says was plain http is refused', r.status === 400 && r.json.code === 'https-required', r);
    r = await post(c, '/atlas/call/invite', '{}', { 'X-Forwarded-Proto': 'http, https' });
    check('the last X-Forwarded-Proto entry decides', r.status === 400 && r.json.code === 'bad-request', r);
    r = await post(c, '/atlas/call/invite', '{}', { 'X-Forwarded-Proto': 'https, http' });
    check('a client-supplied https earlier in the header does not help', r.json.code === 'https-required', r);
    r = await rq(c, 'GET', '/atlas/call/info');
    check('the info route still answers without the header (health checks)', r.status === 200 && r.json.configured === true, r);
    check('the refusal is counted', c.svc.counters.httpsRequired === 3, c.svc.counters);
    await c.svc.close();
    c = await mkHttps({ proxyAddrs: ['10.99.99.99'] });
    r = await post(c, '/atlas/call/invite', '{}', { 'X-Forwarded-Proto': 'https' });
    check('a connection from an address that is not a configured proxy is refused even if it claims https', r.json.code === 'https-required', r);
    await c.svc.close();
    c = await mkHttps({ trustProxy: false });
    r = await post(c, '/atlas/call/invite', '{}');
    check('without CALL_TRUST_PROXY the service does not look for X-Forwarded-Proto', r.json.code === 'bad-request', r);
    await c.svc.close();
  }

  // ---------- cross-origin rules, content type, headers ----------
  {
    let c = await T.startService();
    const origins = ['http://evil.example', 'https://evil.example', 'null'];
    let allRefused = true;
    for (const o of origins) {
      for (const route of ['/atlas/call/invite', '/atlas/call/listen', '/atlas/call/signal']) {
        const r = await post(c, route, '{}', { Origin: o });
        if (r.status !== 403 || r.json.code !== 'origin-not-allowed' || r.headers['access-control-allow-origin']) allRefused = false;
      }
    }
    check('requests from web page origins are refused on every route and carry no cross-origin headers', allRefused);
    let r = await post(c, '/atlas/call/invite', '{}', { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' });
    check('a request from the wallet extension origin is handled normally', r.status === 400 && r.json.code === 'bad-request', r);
    r = await post(c, '/atlas/call/invite', '{}');
    check('a request with no Origin header is handled normally', r.status === 400, r);
    r = await rq(c, 'OPTIONS', '/atlas/call/invite', { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    check('a preflight is not approved: no cross-origin headers at all', r.status === 405 && !Object.keys(r.headers).some((h) => h.startsWith('access-control-')), r);
    r = await rq(c, 'GET', '/atlas/call/info', { headers: { Origin: 'https://evil.example' } });
    check('info carries no cross-origin headers', !Object.keys(r.headers).some((h) => h.startsWith('access-control-')), r.headers);
    r = await post(c, '/atlas/call/invite', '{}', { 'Content-Type': 'text/plain' });
    check('text/plain (a cross-site form post) is refused with 415', r.status === 415 && r.json.code === 'unsupported-media-type', r);
    r = await rq(c, 'POST', '/atlas/call/invite', { body: '{}', noType: true });
    check('a body with no content type is refused with 415', r.status === 415, r);
    r = await post(c, '/atlas/call/invite', '{}', { 'Content-Type': 'application/x-www-form-urlencoded' });
    check('form encoding is refused with 415', r.status === 415, r);
    r = await post(c, '/atlas/call/invite', '{}', { 'Content-Type': 'Application/JSON; charset=utf-8' });
    check('application/json with a charset is accepted', r.status === 400 && r.json.code === 'bad-request', r);
    r = await post(c, '/atlas/call/invite', '{}');
    check('responses carry no-store, nosniff, a locked-down content policy and no referrer', r.headers['cache-control'] === 'no-store' && r.headers['x-content-type-options'] === 'nosniff' && /default-src 'none'/.test(r.headers['content-security-policy']) && r.headers['referrer-policy'] === 'no-referrer', r.headers);
    check('the refusals are counted', c.svc.counters.originRefused === 9 && c.svc.counters.badContentType === 3, c.svc.counters);
    await c.svc.close();

    // an operator-named origin may reach the invite route only
    c = await T.startService({ corsOrigins: ['https://app.example.com'] });
    r = await rq(c, 'OPTIONS', '/atlas/call/invite', { headers: { Origin: 'https://app.example.com', 'Access-Control-Request-Method': 'POST' } });
    check('a named origin gets its preflight approved, naming that origin only', r.status === 204 && r.headers['access-control-allow-origin'] === 'https://app.example.com' && r.headers.vary === 'Origin', r);
    r = await post(c, '/atlas/call/invite', '{}', { Origin: 'https://app.example.com' });
    check('a named origin may post to the invite route', r.status === 400 && r.headers['access-control-allow-origin'] === 'https://app.example.com', r);
    r = await post(c, '/atlas/call/listen', '{}', { Origin: 'https://app.example.com' });
    check('a named origin may not use any other route', r.status === 403 && !r.headers['access-control-allow-origin'], r);
    r = await post(c, '/atlas/call/invite', '{}', { Origin: 'https://other.example.com' });
    check('an origin that is not named is still refused', r.status === 403 && !r.headers['access-control-allow-origin'], r);
    r = await rq(c, 'OPTIONS', '/atlas/call/invite', { headers: { Origin: 'https://other.example.com', 'Access-Control-Request-Method': 'POST' } });
    check('and its preflight is not approved', r.status === 405 && !r.headers['access-control-allow-origin'], r);
    await c.svc.close();
  }

  // ---------- long polls: per-source, per-pool and global limits ----------
  {
    const timers = { listenHoldMs: 2500, sweepMs: 100 };
    const noRate = { perSourcePerMin: 100000, invitesPerSourcePerMin: 1000, invitesPerCallerPerMin: 1000, invitesPerCalleePerMin: 1000 };
    const sources = (n) => '198.51.100.' + n;

    // per-source cap
    let c = await T.startService({ trustProxy: true }, { timers, limits: Object.assign({}, noRate, { maxWaitersPerSource: 2 }) });
    const [w1, w2, w3] = [await Wallet.create(c), await Wallet.create(c), await Wallet.create(c)];
    const h1 = track(listenAs(w1, sources(1))), h2 = track(listenAs(w2, sources(1)));
    await sleep(300);
    check('two listens from one source are held', !h1.done && !h2.done && c.svc.stats().waiters === 2, c.svc.stats());
    let t0 = Date.now();
    let r = await listenAs(w3, sources(1));
    check('a third listen from that source is refused at once with 429 too-many-connections and Retry-After', r.status === 429 && r.json.code === 'too-many-connections' && r.headers['retry-after'] === '5' && Date.now() - t0 < 1000, r);
    const other = track(listenAs(await Wallet.create(c), sources(2)));
    await sleep(200);
    check('another source is held normally while the first is at its cap', !other.done);
    const h1b = track(listenAs(w1, sources(1)));
    await sleep(300);
    check('a wallet that listens again replaces its own held request instead of counting twice', h1.done && h1.res.status === 200 && !h1b.done && c.svc.stats().waiters >= 2, { first: h1.res && h1.res.status, stats: c.svc.stats() });
    await Promise.all([h1.promise, h2.promise, h1b.promise, other.promise]);
    check('the held requests end with an empty 200 when nothing arrives', h2.res.status === 200 && h2.res.json.events.length === 0, h2.res);
    check('no waiter or source slot is left behind', c.svc.stats().waiters === 0 && c.svc.stats().sources === 0, c.svc.stats());
    check('refusals were counted', c.svc.counters.waiterRefused >= 1);

    // a client that goes away frees its slot at once
    const ctl = new AbortController();
    const ab = track(listenAs(w1, sources(3), ctl.signal));
    await sleep(200);
    const during = c.svc.stats().waiters;
    ctl.abort();
    await ab.promise;
    await sleep(150);
    check('a client that disconnects frees its held slot immediately', during === 1 && c.svc.stats().waiters === 0 && c.svc.stats().sources === 0, { during, after: c.svc.stats() });
    await c.svc.close();

    // pools: owners without a tag share a small pool; members and the global total
    c = await T.startService({ trustProxy: true }, { timers, limits: Object.assign({}, noRate, { maxWaiters: 5, maxStrangerWaiters: 2, maxWaitersPerSource: 50 }) });
    const strangers = [await Wallet.create(c), await Wallet.create(c), await Wallet.create(c)];
    const members = [];
    for (let i = 0; i < 4; i++) { const m = await Wallet.create(c); const tr = await m.createTag((await newIdentity()).pub); if (tr.status !== 200) throw new Error('tag setup ' + JSON.stringify(tr)); members.push(m); }
    const hs = [track(listenAs(strangers[0], sources(10))), track(listenAs(strangers[1], sources(11)))];
    await sleep(250);
    t0 = Date.now();
    r = await listenAs(strangers[2], sources(12));
    check('owners with no tag cannot hold more than their pool: refused 503 busy with Retry-After', r.status === 503 && r.json.code === 'busy' && r.headers['retry-after'] === '10' && Date.now() - t0 < 1000, r);
    const hm = [track(listenAs(members[0], sources(13))), track(listenAs(members[1], sources(14))), track(listenAs(members[2], sources(15)))];
    await sleep(300);
    check('owners that hold a tag are still admitted while that pool is full', hm.every((h) => !h.done) && c.svc.stats().waiters === 5 && c.svc.stats().strangerWaiters === 2, c.svc.stats());
    r = await listenAs(members[3], sources(16));
    check('the global limit refuses with 503 busy instead of answering as though nothing happened', r.status === 503 && r.json.code === 'busy', r);
    await Promise.all(hs.concat(hm).map((h) => h.promise));
    check('every slot is released afterwards', c.svc.stats().waiters === 0 && c.svc.stats().strangerWaiters === 0 && c.svc.stats().sources === 0, c.svc.stats());
    await c.svc.close();

    // listener table
    c = await T.startService({ trustProxy: true }, { timers, limits: Object.assign({}, noRate, { maxListeners: 2, maxStrangerWaiters: 10 }) });
    const ss = [await Wallet.create(c), await Wallet.create(c), await Wallet.create(c)];
    const mem = await Wallet.create(c);
    await mem.createTag((await newIdentity()).pub);
    const l1 = track(listenAs(ss[0], sources(20))), l2 = track(listenAs(ss[1], sources(21)));
    await sleep(250);
    r = await listenAs(ss[2], sources(22));
    check('an owner with no tag cannot add a mailbox past the table limit', r.status === 503 && r.json.code === 'busy' && c.svc.stats().listeners === 2, { r, stats: c.svc.stats() });
    const lm = track(listenAs(mem, sources(23)));
    await sleep(250);
    check('an owner that holds a tag always can', !lm.done && c.svc.stats().listeners === 3, c.svc.stats());
    await Promise.all([l1.promise, l2.promise, lm.promise]);
    await c.svc.close();

    // requests in flight per source, whatever they are doing
    c = await T.startService({ trustProxy: true }, { timers, limits: Object.assign({}, noRate, { maxInflightPerSource: 2, maxWaitersPerSource: 50 }) });
    const f = [await Wallet.create(c), await Wallet.create(c)];
    const fh = [track(listenAs(f[0], sources(30))), track(listenAs(f[1], sources(30)))];
    await sleep(250);
    r = await post(c, '/atlas/call/invite', '{}', { 'X-Forwarded-For': sources(30) });
    check('a source with its limit of requests in flight is refused a further one at once', r.status === 429 && r.json.code === 'too-many-connections', r);
    r = await post(c, '/atlas/call/invite', '{}', { 'X-Forwarded-For': sources(31) });
    check('another source is unaffected', r.status === 400, r);
    await Promise.all(fh.map((h) => h.promise));
    r = await post(c, '/atlas/call/invite', '{}', { 'X-Forwarded-For': sources(30) });
    check('the source is served again once its requests have finished', r.status === 400, r);
    check('in-flight accounting is empty afterwards', c.svc.stats().inflightSources === 0 && c.svc.counters.inflightRefused === 1, { s: c.svc.stats(), c: c.svc.counters });
    await c.svc.close();
  }

  // ---------- the poll route obeys the same limits ----------
  {
    const timers = { listenHoldMs: 2000, sweepMs: 100, acceptToOfferMs: 6000, listenerFreshMs: 5000 };
    const c = await T.startService({ trustProxy: true }, { timers, limits: { maxWaitersPerSource: 1, perSourcePerMin: 100000, invitesPerSourcePerMin: 1000, invitesPerCallerPerMin: 1000, invitesPerCalleePerMin: 1000 } });
    const alice = await Wallet.create(c), bob = await Wallet.create(c);
    const tag = (await bob.createTag(alice.pub)).json;
    await bob.listen([]); // registers the listener (held until its hold ends)
    const built = await alice.buildInvite(tag.tag, bob.pub);
    await alice.invite(built);
    const ckB = await newIdentity();
    const acceptPayload = signalPayload(c, built.callId, 'accept', { inviteHash: await P.payloadHash(built.payload), calleeNonce: P.randomId(16), callKey: ckB.pub, fingerprints: [fp('B')] });
    const acc = await sendSignal(c, acceptPayload, bob.ident);
    check('setup: the call is accepted', acc.status === 202, acc);
    const pollAs = async (ck, after, xff) => {
      const payload = base('atlas.call.poll', c.origin, { nonce: nonce(), callId: built.callId, after });
      return rq(c, 'POST', '/atlas/call/poll', { body: { payload, proof: await sign(payload, ck) }, headers: { 'X-Forwarded-For': xff } });
    };
    const first = await pollAs(built.ck, 0, '198.51.100.40');
    const afterId = first.json.events.length ? first.json.events[first.json.events.length - 1].n : 0;
    const pa = track(pollAs(built.ck, afterId, '198.51.100.40'));
    await sleep(250);
    const rb = await pollAs(ckB, 0, '198.51.100.40');
    check('a second held poll from the same source is refused with 429', pa.done === false && rb.status === 429 && rb.json.code === 'too-many-connections', rb);
    const rc = await pollAs(ckB, 0, '198.51.100.41');
    check('a poll from another source is served', rc.status === 200, rc);
    await pa.promise;
    check('the poll slot is released afterwards', c.svc.stats().waiters === 0 && c.svc.stats().sources === 0, c.svc.stats());
    await c.svc.close();
  }

  // ---------- slow and oversized clients ----------
  {
    const c = await T.startService({ trustProxy: true }, { timers: { bodyReadMs: 400, sweepMs: 100 } });
    const port = Number(new URL(c.base).port);
    const sock = net.connect(port, '127.0.0.1');
    let got = '';
    sock.on('data', (d) => { got += d; });
    await new Promise((r) => sock.on('connect', r));
    const t0 = Date.now();
    sock.write('POST /atlas/call/listen HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{"payl');
    await new Promise((r) => { sock.on('close', r); setTimeout(r, 4000); });
    check('a client that sends part of a body and stops is answered 408 and cut off quickly', /^HTTP\/1\.1 408/.test(got) && /"timeout"/.test(got) && Date.now() - t0 < 3000, { got: got.slice(0, 80), ms: Date.now() - t0 });
    check('and its in-flight slot is released', c.svc.stats().inflightSources === 0 && c.svc.counters.slowBodies === 1, { s: c.svc.stats(), c: c.svc.counters });
    sock.destroy();
    const big = await post(c, '/atlas/call/listen', 'x'.repeat(5000));
    check('a body over the route limit is refused with 413', big.status === 413, big);
    const sock2 = net.connect(port, '127.0.0.1');
    let got2 = '';
    sock2.on('data', (d) => { got2 += d; });
    await new Promise((r) => sock2.on('connect', r));
    sock2.write('GET /atlas/call/info HTTP/1.1\r\nHost: x\r\nX-Pad: ' + 'a'.repeat(20000) + '\r\n\r\n');
    await sleep(500);
    check('an oversized header block is refused', /^HTTP\/1\.1 431/.test(got2) || got2 === '', got2.slice(0, 60));
    sock2.destroy();
    const info = await rq(c, 'GET', '/atlas/call/info');
    check('the service is still answering after those', info.status === 200);
    await c.svc.close();
  }

  // ---------- sockets per source (direct exposure only) ----------
  {
    const open = async (c, n) => {
      const port = Number(new URL(c.base).port);
      const socks = [];
      let closed = 0;
      for (let i = 0; i < n; i++) {
        const s = net.connect(port, '127.0.0.1');
        s.on('error', () => {});
        s.on('close', () => { closed++; });
        await new Promise((r) => s.on('connect', r));
        await sleep(30);
        socks.push(s);
      }
      await sleep(200);
      const state = { closed, counter: c.svc.counters.connectionRefused };
      socks.forEach((s) => s.destroy());
      await sleep(100);
      return state;
    };
    let c = await T.startService({ trustProxy: false }, { limits: { maxConnectionsPerSource: 3 } });
    let st = await open(c, 5);
    check('a directly exposed service cuts off sockets beyond the per-source limit', st.closed === 2 && st.counter === 2, st);
    await c.svc.close();
    c = await T.startService({ trustProxy: true }, { limits: { maxConnectionsPerSource: 3 } });
    st = await open(c, 5);
    check('behind a proxy the socket count is left to the proxy (every socket is the proxy\'s)', st.closed === 0 && st.counter === 0, st);
    check('the global connection limit is applied to the server', c.svc.server.maxConnections === S.DEFAULT_LIMITS.maxConnections);
    await c.svc.close();
    c = await T.startService(null, { limits: { maxConnections: 77 } });
    check('a configured connection limit reaches the server', c.svc.server.maxConnections === 77);
    await c.svc.close();
  }

  // ---------- operator STUN reaches wallets, nothing else does ----------
  {
    const stunUrls = ['stun:203.0.113.5:3478'];
    let c = await T.startService({ stunUrls }, { timers: { listenHoldMs: 500, sweepMs: 100, acceptToOfferMs: 5000 } });
    const alice = await Wallet.create(c), bob = await Wallet.create(c);
    const tag = (await bob.createTag(alice.pub)).json;
    await bob.listen([]);
    const built = await alice.buildInvite(tag.tag, bob.pub);
    await alice.invite(built);
    let r = await alice.ice(built.callId, built.ck);
    check('ice is refused while the call is only ringing', r.status === 404, r);
    const ckB = await newIdentity();
    await sendSignal(c, signalPayload(c, built.callId, 'accept', { inviteHash: await P.payloadHash(built.payload), calleeNonce: P.randomId(16), callKey: ckB.pub, fingerprints: [fp('B')] }), bob.ident);
    r = await alice.ice(built.callId, built.ck);
    check('after accept the ice answer is exactly the operator\'s STUN list, no credentials, no TURN', r.status === 200 && JSON.stringify(r.json.iceServers) === JSON.stringify([{ urls: stunUrls }]) && !('username' in r.json.iceServers[0]) && !('credential' in r.json.iceServers[0]), r);
    const info = await rq(c, 'GET', '/atlas/call/info');
    check('info lists the same STUN servers and says TURN is not offered', JSON.stringify(info.json.ice) === JSON.stringify({ stun: stunUrls, turn: false }), info.json);
    await c.svc.close();
    c = await T.startService();
    const a2 = await Wallet.create(c), b2 = await Wallet.create(c);
    const t2 = (await b2.createTag(a2.pub)).json;
    await b2.listen([]);
    const bi = await a2.buildInvite(t2.tag, b2.pub);
    await a2.invite(bi);
    const ck2 = await newIdentity();
    await sendSignal(c, signalPayload(c, bi.callId, 'accept', { inviteHash: await P.payloadHash(bi.payload), calleeNonce: P.randomId(16), callKey: ck2.pub, fingerprints: [fp('B')] }), b2.ident);
    r = await a2.ice(bi.callId, bi.ck);
    check('with no STUN configured the ice answer lists no server at all', r.status === 200 && r.json.iceServers.length === 0, r);
    await c.svc.close();
  }

  // ---------- the shipped deployment examples ----------
  {
    const dir = path.join(__dirname, '..', 'call-server', 'deploy');
    const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
    const cfgText = read('atlas-call.config.json.example');
    const placeholder = S.loadConfig({ CALL_CONFIG_FILE: '/x' }, () => cfgText);
    check('the example settings file is inert until the placeholder key is replaced', placeholder.configured === false && /CALL_ISSUER_KEYS/.test(placeholder.problem), placeholder.problem);
    const filled = S.loadConfig({ CALL_CONFIG_FILE: '/x' }, () => cfgText.replace(/"PASTE_[^"]*"/, JSON.stringify(key)));
    check('with a real key the example settings file is a valid configuration for an https service behind a proxy', filled.configured === true && filled.trustProxy === true && filled.bind === '127.0.0.1' && filled.origin === 'https://calls.example.org' && filled.stunUrls.length === 0 && filled.corsOrigins.length === 0, filled.problem);
    check('the example settings file lists only limits the service accepts and keeps the shipped values', Object.keys(JSON.parse(cfgText).limits).every((k) => S.TUNABLE_LIMITS[k] && JSON.parse(cfgText).limits[k] === S.DEFAULT_LIMITS[k]));
    const ng = read('nginx-atlas-call.conf.example');
    check('the nginx example sets the forwarded headers by overwriting them', /proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/.test(ng) && /proxy_set_header\s+X-Forwarded-Proto\s+\$scheme;/.test(ng) && !/proxy_add_x_forwarded_for/.test(ng.replace(/#.*$/gm, '')));
    check('the nginx example has a read timeout above the 25 s hold, no buffering, a body cap and a TLS floor', /proxy_read_timeout\s+70s;/.test(ng) && /proxy_buffering\s+off;/.test(ng) && /client_max_body_size\s+20k;/.test(ng) && /ssl_protocols\s+TLSv1\.2 TLSv1\.3;/.test(ng) && /Strict-Transport-Security/.test(ng));
    check('the nginx example serves nothing but the call routes and no call route on port 80', /location \/ \{ return 404; \}/.test(ng) && (ng.match(/location \/ \{ return 404; \}/g) || []).length === 2);
    const cd = read('Caddyfile.example');
    check('the Caddy example overwrites the forwarded headers, caps the body and allows a long read', /header_up X-Forwarded-For \{remote_host\}/.test(cd) && /header_up X-Forwarded-Proto \{scheme\}/.test(cd) && /max_size 20KB/.test(cd) && /read_timeout 70s/.test(cd));
    const unit = read('atlas-call.service.example');
    check('the systemd example runs unprivileged, confined, with a private state directory', /DynamicUser=yes/.test(unit) && /NoNewPrivileges=yes/.test(unit) && /ProtectSystem=strict/.test(unit) && /StateDirectoryMode=0700/.test(unit) && /RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX/.test(unit) && /LimitNOFILE=\d+/.test(unit));
    const turn = read('coturn-stun-only.conf.example');
    check('the coturn example is STUN only, with no TURN credentials or database', /^stun-only$/m.test(turn) && /^no-cli$/m.test(turn) && !/^(use-auth-secret|static-auth-secret|lt-cred-mech|user=|userdb)/m.test(turn));
    const all = [cfgText, ng, cd, unit, turn].join('\n');
    check('the examples name no real service or host, only example names', !/(google|cloudflare|twilio|mozilla|\.co\.za)/i.test(all));
  }

  // ---------- shipped defaults and the real process ----------
  {
    check('the shipped limits are the documented ones', JSON.stringify([S.DEFAULT_LIMITS.maxConnections, S.DEFAULT_LIMITS.maxConnectionsPerSource, S.DEFAULT_LIMITS.maxInflightPerSource, S.DEFAULT_LIMITS.maxWaiters, S.DEFAULT_LIMITS.maxWaitersPerSource, S.DEFAULT_LIMITS.maxStrangerWaiters, S.DEFAULT_LIMITS.maxListeners]) === JSON.stringify([3000, 100, 60, 2000, 20, 500, 5000]));
    const c = await T.startService({ configured: false });
    let r = await post(c, '/atlas/call/invite', '{}', { 'Content-Type': 'text/plain', Origin: 'https://evil.example' });
    check('an unconfigured service still answers 503 calls-not-configured whatever the request looks like', r.status === 503 && r.json.code === 'calls-not-configured', r);
    await c.svc.close();

    const SERVER = path.join(__dirname, '..', 'call-server', 'server.js');
    const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const run = async (env) => {
      const port = await freePort();
      const child = spawn(process.execPath, [SERVER], { cwd: os.tmpdir(), env: Object.assign({ PATH: process.env.PATH, CALL_PORT: String(port) }, env), stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      child.stdout.on('data', (d) => { text += d; });
      child.stderr.on('data', (d) => { text += d; });
      let info = null;
      for (let i = 0; i < 50 && !info; i++) {
        try { const x = await fetch('http://127.0.0.1:' + port + '/atlas/call/info'); if (x.ok) info = await x.json(); } catch (e) { await sleep(100); }
      }
      child.kill('SIGTERM');
      await sleep(150);
      return { info, text };
    };
    let p = await run(envFor(key, { CALL_STUN_URLS: 'stun:stun.l.google.com:19302' }));
    check('the real process refuses a third-party STUN server and says which setting', p.info && p.info.configured === false && /CALL_STUN_URLS/.test(p.text) && /third-party/.test(p.text), p.text.slice(0, 300));
    p = await run(envFor(key, { CALL_LIMIT_MAX_WAITERS: '999999999' }));
    check('the real process refuses a limit outside its range', p.info && p.info.configured === false && /maxWaiters/.test(p.text), p.text.slice(0, 300));
    p = await run(envFor(key, { CALL_STUN_URLS: 'stun:stun.example.com:3478', CALL_TRUST_PROXY: '1' }));
    check('the real process starts with an own STUN server and a trusted proxy', p.info && p.info.configured === true && p.info.ice.stun[0] === 'stun:stun.example.com:3478', p.text.slice(0, 300));
    check('and its console notes the proxy and STUN settings without any identity', /proxy/i.test(p.text) && /stun/i.test(p.text), p.text.slice(0, 500));
  }

  process.exit(T.finish('manual-call-internet-security'));
})().catch((e) => { console.error(e); process.exit(2); });
