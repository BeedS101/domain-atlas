// Domain Atlas Call Service: signalling for authenticated wallet-to-wallet voice calls.
//
// It relays small signed messages between two wallets and decides nothing about who
// is who: every identity claim is a signature the wallets verify themselves
// (protocol.js, shared byte for byte with the wallet). It never sees audio, never
// parses SDP, never fetches a name supplied by a requester, and keeps tags only as
// hashes. See docs/voice-calls-endpoints-and-state.md for the wire design and
// call-server/README.md for configuration. With no configuration it answers
// 503 calls-not-configured on every route except GET /atlas/call/info and creates
// nothing on disk.
//
// Zero dependencies (Node built-ins only). Transport is plain HTTP request/response
// with long polls; TLS is the reverse proxy's job. Every handler works on one
// self-contained JSON request and one JSON response, so the same protocol can be
// served later by a PHP polling implementation.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const nodeCrypto = require('crypto');
const dns = require('dns').promises;
const P = require('./protocol');

const KEY_RE = /^[A-Za-z0-9_-]{87}$/;
const ID128_RE = /^[A-Za-z0-9_-]{22}$/;

const DEFAULT_TIMERS = {
  listenHoldMs: 25000,
  acceptToOfferMs: 20000,
  offerToAnswerMs: 20000,
  confirmMs: 40000,
  endedRetainMs: 60000,
  seenCallIdMs: 10 * 60000,
  sweepMs: 1000,
  silentActiveMs: 90000,
  maxCallMs: 4 * 3600000,
  listenerFreshMs: 40000,
  revocationCacheMs: 60000,
  fetchTimeoutMs: 5000,
  bodyReadMs: 10000
};

const DEFAULT_LIMITS = {
  maxLiveCalls: 200,
  maxTurnCredentialsPerRole: 3,
  maxConnections: 3000,
  maxConnectionsPerSource: 100,
  maxInflightPerSource: 60,
  maxWaiters: 2000,
  maxWaitersPerSource: 20,
  maxStrangerWaiters: 500,
  maxListeners: 5000,
  maxNonces: 100000,
  maxTagsTotal: 20000,
  maxSignalsPerCall: 300,
  perSourcePerMin: 600,
  invitesPerSourcePerMin: 20,
  invitesPerCallerPerMin: 6,
  invitesPerCalleePerMin: 6,
  tagCreatePerOwnerPerMin: 30,
  maxEventsPerMailbox: 100
};

// ---------- configuration ----------

// Environment variables (all optional; with none the service is "not configured"):
//   CALL_CONFIG_FILE  JSON file whose keys are the same names without the CALL_ prefix, camel-cased
//   CALL_ORIGIN, CALL_DOMAIN, CALL_ISSUER_KEYS (comma separated), CALL_REVOCATIONS_URL,
//   CALL_STATE_FILE, CALL_STUN_URLS (comma separated), CALL_BIND, CALL_PORT,
//   CALL_TURN_URLS (comma separated), CALL_TURN_SECRET or CALL_TURN_SECRET_FILE, CALL_TURN_TTL_SECONDS,
//   CALL_TRUST_PROXY=1, CALL_PROXY_ADDRS (comma separated, default loopback),
//   CALL_INVITE_CORS_ORIGINS (comma separated exact origins, default none),
//   CALL_LIMIT_<NAME> for each name in TUNABLE_LIMITS (for example CALL_LIMIT_MAX_WAITERS_PER_SOURCE),
//   CALL_DEV_ALLOW_HTTP=1, CALL_DEV_ALLOW_PRIVATE_FETCH=1

// Limits an operator may change, with the range each must stay inside.
const TUNABLE_LIMITS = {
  maxTurnCredentialsPerRole: [1, 20],
  maxConnections: [10, 100000],
  maxConnectionsPerSource: [1, 10000],
  maxInflightPerSource: [1, 10000],
  maxWaiters: [1, 100000],
  maxWaitersPerSource: [1, 10000],
  maxStrangerWaiters: [0, 100000],
  maxListeners: [1, 1000000],
  perSourcePerMin: [10, 100000],
  invitesPerSourcePerMin: [1, 10000]
};
const snakeName = (k) => k.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase();

// Public STUN and TURN services this project does not use. The check catches an accidental copy
// of a well-known address into the settings; it is not a list of everything that exists.
const THIRD_PARTY_ICE_SUFFIXES = [
  'l.google.com', 'stun.services.mozilla.com', 'twilio.com', 'cloudflare.com', 'stunprotocol.org',
  'metered.ca', 'ekiga.net', 'sipgate.net', 'voipbuster.com', 'voiparound.com', 'stunserver.org',
  'xten.com', 'schlund.de', 'ideasip.com', 'freeswitch.org', 'nextcloud.com', 'jitsi.org', 'jit.si',
  'xirsys.com', 'viagenie.ca', 'bistri.com', 'backups.cz', 'vonage.com', 'telnyx.com', 'agora.io', 'daily.co', 'livekit.io'
];

// Returns null when `u` is an acceptable operator ICE server URL, otherwise a short reason.
// kind is 'stun' or 'turn'; private addresses and unusual TURN ports need allowPrivate.
function iceUrlProblem(u, kind, allowPrivate) {
  if (typeof u !== 'string') return 'is not a string';
  const why = P.iceUrlProblem(u, { kind, allowPrivate });
  if (why) return why;
  const host = P.parseIceUrl(u).host.toLowerCase();
  if (THIRD_PARTY_ICE_SUFFIXES.some((x) => host === x || host.endsWith('.' + x))) return 'is a public third-party service; use a server you operate';
  return null;
}
const stunProblem = (u, allowPrivate) => iceUrlProblem(u, 'stun', allowPrivate);

function loadConfig(env, readFile) {
  const read = readFile || ((p) => fs.readFileSync(p, 'utf8'));
  let file = {};
  if (env.CALL_CONFIG_FILE) {
    try { file = JSON.parse(read(env.CALL_CONFIG_FILE)); } catch (e) { return { configured: false, problem: 'config file unreadable', bind: '127.0.0.1', port: 8787 }; }
    if (!file || typeof file !== 'object' || Array.isArray(file)) file = {};
  }
  const pick = (envName, fileName) => (env[envName] !== undefined && env[envName] !== '' ? env[envName] : file[fileName]);
  const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const truthy = (v) => v === true || v === '1' || v === 'true';

  const cfg = {
    origin: pick('CALL_ORIGIN', 'origin'),
    domain: pick('CALL_DOMAIN', 'domain'),
    issuerKeys: list(pick('CALL_ISSUER_KEYS', 'issuerKeys')),
    revocationsUrl: pick('CALL_REVOCATIONS_URL', 'revocationsUrl') || null,
    stateFile: pick('CALL_STATE_FILE', 'stateFile') || null,
    stunUrls: list(pick('CALL_STUN_URLS', 'stunUrls')),
    turnUrls: list(pick('CALL_TURN_URLS', 'turnUrls')),
    turnSecret: pick('CALL_TURN_SECRET', 'turnSecret') || null,
    turnSecretFile: pick('CALL_TURN_SECRET_FILE', 'turnSecretFile') || null,
    turnTtlSeconds: Number(pick('CALL_TURN_TTL_SECONDS', 'turnTtlSeconds') || 3600),
    bind: pick('CALL_BIND', 'bind') || '127.0.0.1',
    port: Number(pick('CALL_PORT', 'port') || 8787),
    trustProxy: truthy(pick('CALL_TRUST_PROXY', 'trustProxy')),
    proxyAddrs: list(pick('CALL_PROXY_ADDRS', 'proxyAddrs')),
    corsOrigins: list(pick('CALL_INVITE_CORS_ORIGINS', 'inviteCorsOrigins')),
    limits: {},
    devAllowHttp: truthy(pick('CALL_DEV_ALLOW_HTTP', 'devAllowHttp')),
    devAllowPrivateFetch: truthy(pick('CALL_DEV_ALLOW_PRIVATE_FETCH', 'devAllowPrivateFetch'))
  };
  cfg.configured = false;
  if (!cfg.proxyAddrs.length) cfg.proxyAddrs = ['127.0.0.1', '::1'];
  const fileLimits = file.limits && typeof file.limits === 'object' && !Array.isArray(file.limits) ? file.limits : {};
  for (const k of Object.keys(fileLimits)) if (!TUNABLE_LIMITS[k]) { cfg.problem = 'limits.' + k + ' is not a setting'; return cfg; }
  for (const [k, [lo, hi]] of Object.entries(TUNABLE_LIMITS)) {
    const raw = env['CALL_LIMIT_' + snakeName(k)] !== undefined && env['CALL_LIMIT_' + snakeName(k)] !== '' ? env['CALL_LIMIT_' + snakeName(k)] : fileLimits[k];
    if (raw === undefined) continue;
    const n = typeof raw === 'number' ? raw : (/^\d{1,9}$/.test(String(raw)) ? Number(raw) : NaN);
    if (!Number.isInteger(n) || n < lo || n > hi) { cfg.problem = 'limit ' + k + ' must be a whole number from ' + lo + ' to ' + hi; return cfg; }
    cfg.limits[k] = n;
  }
  if (!cfg.origin && !cfg.domain && !cfg.issuerKeys.length) { cfg.problem = 'no configuration present'; return cfg; }
  let url;
  try { url = new URL(String(cfg.origin)); } catch (e) { cfg.problem = 'CALL_ORIGIN is not a URL'; return cfg; }
  if (url.origin !== cfg.origin) { cfg.problem = 'CALL_ORIGIN must be a bare origin such as https://calls.example.com'; return cfg; }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && cfg.devAllowHttp)) { cfg.problem = 'CALL_ORIGIN must be https (plain http only with CALL_DEV_ALLOW_HTTP=1, for a private test network)'; return cfg; }
  if (typeof cfg.domain !== 'string' || !/^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(cfg.domain)) { cfg.problem = 'CALL_DOMAIN is missing or malformed'; return cfg; }
  if (!cfg.issuerKeys.length || cfg.issuerKeys.length > 8 || !cfg.issuerKeys.every((k) => KEY_RE.test(k))) { cfg.problem = 'CALL_ISSUER_KEYS must list 1 to 8 raw P-256 public keys'; return cfg; }
  if (cfg.revocationsUrl) {
    let r;
    try { r = new URL(cfg.revocationsUrl); } catch (e) { cfg.problem = 'CALL_REVOCATIONS_URL is not a URL'; return cfg; }
    if (r.protocol !== 'https:' && !(r.protocol === 'http:' && cfg.devAllowHttp)) { cfg.problem = 'CALL_REVOCATIONS_URL must be https'; return cfg; }
  }
  if (cfg.stunUrls.length > P.ICE_LIMITS.stunUrls) { cfg.problem = 'CALL_STUN_URLS may list at most ' + P.ICE_LIMITS.stunUrls + ' servers'; return cfg; }
  for (const u of cfg.stunUrls) {
    const why = stunProblem(u, cfg.devAllowHttp);
    if (why) { cfg.problem = 'CALL_STUN_URLS: ' + String(u).slice(0, 80) + ' ' + why; return cfg; }
  }
  // TURN: a secret shared with the TURN server, and the URLs wallets are told to use. The secret
  // is read from a file when one is named (it must not be readable by others) and never appears in
  // any message, log line or answer.
  if (cfg.turnSecretFile) {
    if (cfg.turnSecret) { cfg.problem = 'CALL_TURN_SECRET and CALL_TURN_SECRET_FILE are both set; use one'; return cfg; }
    try {
      if (!readFile && (fs.statSync(cfg.turnSecretFile).mode & 0o077)) { cfg.problem = 'CALL_TURN_SECRET_FILE must not be readable by group or others (chmod 600)'; return cfg; }
      cfg.turnSecret = String(read(cfg.turnSecretFile)).trim();
    } catch (e) { cfg.problem = 'CALL_TURN_SECRET_FILE cannot be read'; return cfg; }
  }
  if (cfg.turnUrls.length || cfg.turnSecret) {
    if (!cfg.turnUrls.length || !cfg.turnSecret) { cfg.problem = 'TURN needs both CALL_TURN_URLS and a secret (CALL_TURN_SECRET or CALL_TURN_SECRET_FILE)'; return cfg; }
    if (cfg.turnUrls.length > P.ICE_LIMITS.turnUrls) { cfg.problem = 'CALL_TURN_URLS may list at most ' + P.ICE_LIMITS.turnUrls + ' URLs'; return cfg; }
    for (const u of cfg.turnUrls) {
      const why = iceUrlProblem(u, 'turn', cfg.devAllowHttp);
      if (why) { cfg.problem = 'CALL_TURN_URLS: ' + String(u).slice(0, 80) + ' ' + why; return cfg; }
    }
    if (typeof cfg.turnSecret !== 'string' || cfg.turnSecret.length < 32 || cfg.turnSecret.length > 256 || !/^[\x21-\x7e]+$/.test(cfg.turnSecret) || new Set(cfg.turnSecret).size < 10) {
      cfg.problem = 'the TURN secret must be 32 to 256 printable characters and not repetitive (for example the output of: openssl rand -hex 32)';
      return cfg;
    }
    if (!Number.isInteger(cfg.turnTtlSeconds) || cfg.turnTtlSeconds < 60 || cfg.turnTtlSeconds > 86400) { cfg.problem = 'CALL_TURN_TTL_SECONDS must be a whole number from 60 to 86400'; return cfg; }
  }
  if (cfg.proxyAddrs.some((a) => !net.isIP(a))) { cfg.problem = 'CALL_PROXY_ADDRS must list IP addresses'; return cfg; }
  for (const o of cfg.corsOrigins) {
    let ou;
    try { ou = new URL(o); } catch (e) { cfg.problem = 'CALL_INVITE_CORS_ORIGINS has a malformed origin'; return cfg; }
    if (ou.origin !== o || !/^[A-Za-z0-9.:\[\]-]+$/.test(ou.host) || (ou.protocol !== 'https:' && !(ou.protocol === 'http:' && cfg.devAllowHttp))) { cfg.problem = 'CALL_INVITE_CORS_ORIGINS must list exact https origins, no wildcard, no path'; return cfg; }
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) { cfg.problem = 'CALL_PORT is not a port number'; return cfg; }
  cfg.configured = true;
  return cfg;
}

// ---------- small helpers ----------

function isPrivateAddress(addr) {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(addr)) {
    const l = addr.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb')) return true;
    if (l.startsWith('fc') || l.startsWith('fd') || l.startsWith('ff')) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    return m ? isPrivateAddress(m[1]) : false;
  }
  return true;
}

// Address handling for rate-limit keys: an IPv4-mapped IPv6 address is its IPv4 address, and an
// IPv6 address is keyed on its /64 so a client cannot dodge a limit by changing the low bits.
function normalizeIp(addr) {
  let a = String(addr || '').trim().toLowerCase();
  const z = a.indexOf('%');
  if (z >= 0) a = a.slice(0, z);
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  return m ? m[1] : a;
}
function expandIpv6(a) {
  let [head, tail] = a.split('::');
  const toGroups = (part) => {
    if (!part) return [];
    const g = part.split(':');
    const last = g[g.length - 1];
    if (last.includes('.')) {
      const o = last.split('.').map(Number);
      g.splice(g.length - 1, 1, ((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16));
    }
    return g;
  };
  const h = toGroups(head);
  const t = tail === undefined ? [] : toGroups(tail);
  const fill = tail === undefined ? [] : new Array(8 - h.length - t.length).fill('0');
  return h.concat(fill, t).map((x) => x.padStart(4, '0'));
}
function sourceKey(addr) {
  if (net.isIPv4(addr)) return addr;
  if (net.isIPv6(addr)) return 'v6:' + expandIpv6(addr.toLowerCase()).slice(0, 4).join(':');
  return '';
}

function createCallService(cfg, opts) {
  opts = opts || {};
  const T = Object.assign({}, DEFAULT_TIMERS, opts.timers || {});
  const L = Object.assign({}, DEFAULT_LIMITS, cfg.limits || {}, opts.limits || {});
  const now = opts.now || (() => Date.now());
  const quiet = !!opts.quiet;
  const log = (m) => { if (!quiet) console.log('[call-service] ' + m); };

  const counters = { invites: 0, refusedInvites: 0, accepted: 0, ended: 0, rateLimited: 0, authFailures: 0, tagsCreated: 0, turnCredentialsIssued: 0, connectionRefused: 0, inflightRefused: 0, waiterRefused: 0, originRefused: 0, badContentType: 0, httpsRequired: 0, slowBodies: 0 };

  // ----- state -----
  const tags = new Map();          // tagHash -> { owner, bind, calleeKey, createdAt, expiresAt, maxCalls, used }
  const calls = new Map();         // callId -> call
  const seenCallIds = new Map();   // callId -> forget-at
  const tagRinging = new Map();    // tagHash -> callId
  const listeners = new Map();     // owner key -> mailbox (with lastSeen)
  const nonces = new Map();        // signer + '\n' + nonce -> forget-at
  const buckets = new Map();       // rate buckets: key -> [timestamps]
  let waiters = 0;
  let strangerWaiters = 0;           // held requests from owners that hold no tag
  const sourceWaiters = new Map();   // source -> held requests
  const inflight = new Map();        // source -> requests being served
  const connBySource = new Map();    // source -> open sockets (direct exposure only)
  let tagOwners = new Set();         // owners that hold at least one tag
  const trustedProxies = new Set((cfg.proxyAddrs || ['127.0.0.1', '::1']).map((a) => normalizeIp(a)));
  let revocations = { at: 0, ids: new Set(), ok: false };

  // ----- tag persistence (hashes only; atomic, 0600) -----
  function loadTags() {
    if (!cfg.stateFile || !fs.existsSync(cfg.stateFile)) return;
    try {
      const doc = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
      if (doc && doc.v === 1 && doc.tags && typeof doc.tags === 'object') {
        for (const [h, t] of Object.entries(doc.tags)) {
          const sane = /^[A-Za-z0-9_-]{43}$/.test(h) && t && typeof t.owner === 'string' && t.bind && typeof t.bind.publicKey === 'string' &&
            typeof t.calleeKey === 'string' && typeof t.expiresAt === 'string' && Number.isInteger(t.maxCalls) && Number.isInteger(t.used);
          if (sane) { tags.set(h, t); tagOwners.add(t.owner); }
        }
      }
    } catch (e) { log('tag store unreadable; starting empty'); }
  }
  function saveTags() {
    if (!cfg.stateFile) return;
    const tmp = cfg.stateFile + '.tmp';
    const doc = { v: 1, tags: Object.fromEntries(tags) };
    fs.writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
    fs.renameSync(tmp, cfg.stateFile);
  }

  // ----- rate limiting -----
  function hit(key, limit, windowMs) {
    const t = now();
    let arr = buckets.get(key);
    if (!arr) { arr = []; buckets.set(key, arr); }
    while (arr.length && arr[0] <= t - windowMs) arr.shift();
    if (arr.length >= limit) return false;
    arr.push(t);
    return true;
  }
  function limited(key, limit) { return !hit(key, limit, 60000); }

  // ----- nonce record: kept only after a signature has verified -----
  function spendNonce(signer, nonce) {
    const k = signer + '\n' + nonce;
    const t = now();
    if (nonces.has(k)) return 'replayed';
    if (nonces.size >= L.maxNonces) return 'full';
    nonces.set(k, t + P.LIMITS.nonceRetainMs);
    return 'ok';
  }

  // ----- mailboxes and long poll -----
  function mailbox() { return { events: [], nextId: 1, waiter: null, lastSeen: 0 }; }
  function push(mb, ev, expiresAt) {
    if (mb.events.length >= L.maxEventsPerMailbox) mb.events.shift();
    ev.id = mb.nextId++;
    if (expiresAt) ev.expiresAt = expiresAt;
    mb.events.push(ev);
    wake(mb);
    return ev.id;
  }
  function wake(mb) { if (mb.waiter) { const w = mb.waiter; mb.waiter = null; w(); } }
  function prune(mb) {
    const t = now();
    mb.events = mb.events.filter((e) => !e.expiresAt || e.expiresAt > t);
  }
  // Holds the request until the mailbox changes, the hold time passes, the client
  // goes away, or another request for the same mailbox replaces this one. Resolves null
  // when the hold ran its course and 'source' or 'busy' when it was refused outright:
  // a source may hold only so many requests, and owners that hold no tag share a smaller
  // pool than owners that do, so anonymous holds cannot crowd out members.
  function hold(mb, ms, o) {
    return new Promise((resolve) => {
      if (mb.waiter) mb.waiter();
      const src = o.source;
      if ((sourceWaiters.get(src) || 0) >= L.maxWaitersPerSource) { counters.waiterRefused++; return resolve('source'); }
      if (waiters >= L.maxWaiters || (o.stranger && strangerWaiters >= L.maxStrangerWaiters)) { counters.waiterRefused++; return resolve('busy'); }
      waiters++;
      if (o.stranger) strangerWaiters++;
      sourceWaiters.set(src, (sourceWaiters.get(src) || 0) + 1);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        waiters--;
        if (o.stranger) strangerWaiters--;
        const left = (sourceWaiters.get(src) || 1) - 1;
        if (left > 0) sourceWaiters.set(src, left); else sourceWaiters.delete(src);
        clearTimeout(timer);
        o.res.removeListener('close', finish);
        if (mb.waiter === finish) mb.waiter = null;
        resolve(null);
      };
      const timer = setTimeout(finish, ms);
      // The response closes when the client goes away, which frees the slot at once.
      o.res.once('close', finish);
      mb.waiter = finish;
    });
  }
  const holdRefusal = (why) => (why === 'source'
    ? { status: 429, body: { error: 'too many requests', code: 'too-many-connections' }, headers: { 'Retry-After': '5' } }
    : { status: 503, body: { error: 'busy', code: 'busy' }, headers: { 'Retry-After': '10' } });

  // ----- responses -----
  function send(res, status, body, extraHeaders) {
    const text = JSON.stringify(body);
    res.writeHead(status, Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'Content-Length': Buffer.byteLength(text)
    }, extraHeaders || {}));
    res.end(text);
  }
  const fail = (status, code, message, extra) => ({ status, body: Object.assign({ error: message || code, code }, extra || {}) });
  const UNAVAILABLE = () => fail(404, 'unavailable', 'unavailable');

  // The whole body must arrive within bodyReadMs, so a client that trickles bytes cannot hold a slot.
  function readBody(req, max) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      let over = false;
      const timer = setTimeout(() => { counters.slowBodies++; reject(Object.assign(new Error('too slow'), { status: 408 })); }, T.bodyReadMs);
      req.on('data', (c) => {
        size += c.length;
        if (size > max) { over = true; chunks.length = 0; return; }
        chunks.push(c);
      });
      req.on('end', () => { clearTimeout(timer); if (over) reject(Object.assign(new Error('too large'), { status: 413 })); else resolve(Buffer.concat(chunks).toString('utf8')); });
      req.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  }

  // ----- authentication -----
  // Checks, in order: shape, route type, audience, freshness, signature(s), then spends the
  // nonce. Returns { payload, signer, owner, mode } or { error }.
  async function authenticate(body, type, o) {
    o = o || {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: fail(400, 'bad-request', 'malformed request') };
    const allowed = new Set(['payload', 'proof'].concat(o.extra || []));
    if (o.session) allowed.add('session');
    if (Object.keys(body).some((k) => !allowed.has(k))) return { error: fail(400, 'bad-request', 'unknown field') };
    const shape = P.validatePayload(body.payload);
    if (!shape.ok || body.payload.type !== type || !P.validateEnvelope(body.proof)) return { error: fail(400, 'bad-request', 'malformed request') };
    const payload = body.payload;
    if (payload.audience !== cfg.origin) return { error: fail(401, 'wrong-audience', 'this message is addressed to a different service') };
    if (!P.freshForService(payload, now())) return { error: fail(401, 'stale-request', 'check this device\'s clock', { serverTime: new Date(now()).toISOString() }) };

    let signer, owner, mode;
    if (body.session !== undefined) {
      if (!o.session) return { error: fail(400, 'bad-request', 'unknown field') };
      const s = body.session;
      const sShape = s && P.validatePayload(s.payload);
      if (!sShape || !sShape.ok || s.payload.type !== 'atlas.call.listen-session' || !P.validateEnvelope(s.proof)) return { error: fail(400, 'bad-request', 'malformed request') };
      if (s.payload.audience !== cfg.origin) return { error: fail(401, 'wrong-audience', 'this message is addressed to a different service') };
      const t = now();
      if (Date.parse(s.payload.issuedAt) > t + P.LIMITS.walletSkewMs || Date.parse(s.payload.expiresAt) < t) return { error: fail(401, 'session-expired', 'the listening session has expired') };
      if (body.proof.signerRole !== 'raw-ecdsa' || body.proof.publicKey !== s.payload.sessionKey) return { error: fail(401, 'bad-signature', 'signature check failed') };
      const okSession = await P.verifyEnvelope(s.payload, s.proof);
      const okReq = okSession && await P.verifyEnvelope(payload, body.proof);
      if (!okReq) { counters.authFailures++; return { error: fail(401, 'bad-signature', 'signature check failed') }; }
      signer = body.proof.publicKey; owner = s.proof.publicKey; mode = 'C';
    } else {
      if (o.modes === 'C') return { error: fail(401, 'session-required', 'a listening session is required') };
      if (o.modes === 'B' && body.proof.signerRole !== 'raw-ecdsa') return { error: fail(401, 'bad-signature', 'signature check failed') };
      if (!(await P.verifyEnvelope(payload, body.proof))) { counters.authFailures++; return { error: fail(401, 'bad-signature', 'signature check failed') }; }
      signer = body.proof.publicKey; owner = signer; mode = o.modes === 'B' ? 'B' : 'A';
    }
    if (payload.nonce !== undefined) {
      const r = spendNonce(signer, payload.nonce);
      if (r === 'replayed') return { error: fail(401, 'replayed-request', 'this request was already used') };
      if (r === 'full') return { error: fail(503, 'busy', 'busy') };
    }
    return { payload, signer, owner, mode };
  }

  // ----- membership (tag creation only) -----
  async function fetchRevocations() {
    if (!cfg.revocationsUrl) return true;
    const t = now();
    if (revocations.ok && t - revocations.at < T.revocationCacheMs) return true;
    try {
      const u = new URL(cfg.revocationsUrl);
      if (!cfg.devAllowPrivateFetch) {
        const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true });
        if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('private address');
      }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), T.fetchTimeoutMs);
      const r = await fetch(cfg.revocationsUrl, { redirect: 'error', signal: ctl.signal, headers: { Accept: 'application/json' } });
      clearTimeout(timer);
      if (!r.ok) throw new Error('status');
      const text = await r.text();
      if (text.length > 1048576) throw new Error('too large');
      const doc = JSON.parse(text);
      const ids = new Set((Array.isArray(doc.revoked) ? doc.revoked : []).map((x) => x && x.id).filter((x) => typeof x === 'string'));
      revocations = { at: now(), ids, ok: true };
      return true;
    } catch (e) {
      revocations.ok = false;
      return false;
    }
  }
  async function checkMembership(cred, signer) {
    if (!cred || typeof cred !== 'object' || cred.credential !== 'domain-atlas-asset/1.0') return 'membership-required';
    if (typeof cred.id !== 'string' || !cred.asset || cred.asset.class !== 'atlas.postoffice.membership') return 'membership-required';
    if (!cred.owner || cred.owner.publicKey !== signer) return 'membership-required';
    if (!cred.issuer || cred.issuer.domain !== cfg.domain) return 'membership-required';
    if (typeof cred.signature !== 'string') return 'membership-required';
    const exp = cred.asset.expiresAt;
    if (typeof exp === 'string' && now() > Date.parse(exp)) return 'membership-required';
    const data = new TextEncoder().encode(P.canonicalize({ id: cred.id, asset: cred.asset, owner: cred.owner, quantity: cred.quantity, supersedes: cred.supersedes, issuedAt: cred.issuedAt }));
    let sig;
    try { sig = P.b64urlDecode(cred.signature); } catch (e) { return 'membership-required'; }
    let good = false;
    for (const k of cfg.issuerKeys) {
      try {
        const pub = await crypto.subtle.importKey('raw', P.b64urlDecode(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        if (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, data)) { good = true; break; }
      } catch (e) { /* try the next key */ }
    }
    if (!good) return 'membership-required';
    if (cfg.revocationsUrl) {
      if (!(await fetchRevocations())) return 'revocations-unavailable';
      if (revocations.ids.has(cred.id)) return 'membership-required';
    }
    return null;
  }

  // ----- call lifecycle -----
  function calleeBox(call) { return call.accepted ? call.boxB : listeners.get(call.owner); }

  function removeListenerEvents(call) {
    const mb = listeners.get(call.owner);
    if (!mb) return;
    mb.events = mb.events.filter((e) => e.callId !== call.callId || e.type === 'cancel' || e.type === 'ended');
  }

  // Service-originated end (timeout, decline, busy, revoked, idle): tells both sides once.
  function endCall(call, reason, who) {
    if (call.state === 'ENDED') return;
    call.state = 'ENDED';
    call.endedAt = now();
    call.endReason = reason;
    counters.ended++;
    if (tagRinging.get(call.tagHash) === call.callId) tagRinging.delete(call.tagHash);
    removeListenerEvents(call);
    if (who !== 'caller') push(call.boxA, { type: 'ended', reason });
    if (who !== 'callee') {
      if (call.accepted) push(call.boxB, { type: 'ended', reason });
      else {
        const mb = listeners.get(call.owner);
        if (mb) push(mb, { type: 'ended', callId: call.callId, reason }, now() + T.endedRetainMs);
      }
    }
  }

  function sweep() {
    const t = now();
    for (const [k, exp] of nonces) if (exp <= t) nonces.delete(k);
    for (const [k, exp] of seenCallIds) if (exp <= t) seenCallIds.delete(k);
    for (const [k, arr] of buckets) {
      while (arr.length && arr[0] <= t - 60000) arr.shift();
      if (!arr.length) buckets.delete(k);
    }
    for (const [h, tag] of tags) if (Date.parse(tag.expiresAt) <= t) { tags.delete(h); }
    tagOwners = new Set();
    for (const tag of tags.values()) tagOwners.add(tag.owner);
    for (const [id, c] of calls) {
      if (c.state === 'ENDED') {
        if (t - c.endedAt >= T.endedRetainMs) { calls.delete(id); }
        continue;
      }
      if (c.state === 'RINGING' && t >= c.inviteExpiresAt) endCall(c, 'timeout');
      else if (c.deadline && t >= c.deadline) endCall(c, 'timeout');
      else if (c.state === 'ACTIVE' && (t - Math.max(c.lastSeenA, c.lastSeenB) > T.silentActiveMs)) endCall(c, 'network-lost');
      else if (t - c.createdAt > T.maxCallMs) endCall(c, 'timeout');
    }
    for (const [k, mb] of listeners) {
      prune(mb);
      if (!mb.events.length && !mb.waiter && t - mb.lastSeen > T.listenerFreshMs * 2) listeners.delete(k);
    }
  }
  const sweepTimer = setInterval(sweep, T.sweepMs);
  if (sweepTimer.unref) sweepTimer.unref();

  // The address rate limits are keyed on. Behind a proxy the service trusts the last
  // X-Forwarded-For entry (the one the proxy itself appended) and only when the connection
  // really comes from a configured proxy address; otherwise the connecting address is used,
  // so a client that reaches the service directly cannot choose its own identity.
  const peerOf = (req) => normalizeIp(req.socket.remoteAddress || '');
  const fromTrustedProxy = (req) => cfg.trustProxy && trustedProxies.has(peerOf(req));
  const sourceOf = (req) => {
    if (fromTrustedProxy(req)) {
      const parts = String(req.headers['x-forwarded-for'] || '').split(',');
      const last = normalizeIp(parts[parts.length - 1].trim());
      if (last && net.isIP(last)) return sourceKey(last);
    }
    return sourceKey(peerOf(req)) || 'unknown';
  };
  // With an https origin behind a proxy, a request must arrive from that proxy and say it was https.
  const proxyHttpsProblem = (req) => {
    if (!cfg.trustProxy || !String(cfg.origin).startsWith('https:')) return false;
    if (!fromTrustedProxy(req)) return true;
    const parts = String(req.headers['x-forwarded-proto'] || '').split(',');
    return parts[parts.length - 1].trim().toLowerCase() !== 'https';
  };

  // ----- routes -----

  const turnEnabled = !!(cfg.configured && cfg.turnUrls && cfg.turnUrls.length && cfg.turnSecret);

  function info() {
    return {
      service: 'atlas-call', v: 1, configured: !!cfg.configured, serverTime: new Date(now()).toISOString(),
      audience: cfg.configured ? cfg.origin : undefined,
      domain: cfg.configured ? cfg.domain : undefined,
      limits: { inviteTtlMs: P.LIMITS.inviteTtlMs, maxCallsPerTag: P.LIMITS.maxCallsPerTag, maxTagsPerWallet: P.LIMITS.maxTagsPerWallet, listenHoldMs: T.listenHoldMs },
      ice: Object.assign({ stun: cfg.configured ? cfg.stunUrls : [], turn: turnEnabled }, turnEnabled ? { turnUrls: cfg.turnUrls.slice() } : {})
    };
  }

  async function routeTagCreate(body) {
    const a = await authenticate(body, 'atlas.call.tag', { modes: 'A', extra: ['membership'] });
    if (a.error) return a.error;
    const p = a.payload;
    if (p.calleeKey !== a.signer) return fail(400, 'bad-request', 'calleeKey must be the signer');
    if (Date.parse(p.expiresAt) <= now()) return fail(400, 'bad-request', 'tag already expired');
    if (limited('tagc:' + a.owner, L.tagCreatePerOwnerPerMin)) { counters.rateLimited++; return fail(429, 'rate-limited', 'too many requests'); }
    const m = await checkMembership(body.membership, a.signer);
    if (m === 'revocations-unavailable') return fail(503, 'revocations-unavailable', 'cannot confirm membership right now');
    if (m) return fail(403, 'membership-required', 'a Post Office membership from this domain is required');
    let mine = 0;
    for (const t of tags.values()) if (t.owner === a.owner) mine++;
    if (mine >= P.LIMITS.maxTagsPerWallet || tags.size >= L.maxTagsTotal) return fail(429, 'tag-quota', 'too many tags');
    const tag = P.randomId(16);
    const h = await P.tagHash(tag);
    tags.set(h, { owner: a.owner, bind: p.bind, calleeKey: p.calleeKey, createdAt: new Date(now()).toISOString(), expiresAt: p.expiresAt, maxCalls: p.maxCalls, used: 0 });
    try { saveTags(); } catch (e) { tags.delete(h); return fail(503, 'busy', 'cannot store tag'); }
    tagOwners.add(a.owner);
    counters.tagsCreated++;
    return { status: 200, body: { tag, expiresAt: p.expiresAt } };
  }

  async function routeTagList(body) {
    const a = await authenticate(body, 'atlas.call.tag-list', { session: true });
    if (a.error) return a.error;
    const out = [];
    for (const [h, t] of tags) if (t.owner === a.owner) out.push({ id: h.slice(0, 12), bind: { publicKey: t.bind.publicKey }, createdAt: t.createdAt, expiresAt: t.expiresAt, maxCalls: t.maxCalls, used: t.used });
    return { status: 200, body: { tags: out, serverTime: new Date(now()).toISOString() } };
  }

  async function routeTagRevoke(body) {
    const a = await authenticate(body, 'atlas.call.tag-revoke', { session: true });
    if (a.error) return a.error;
    const p = a.payload;
    if (a.mode === 'C' && !('tag' in p)) return fail(400, 'bad-request', 'a listening session may revoke one tag only');
    const doomed = [];
    if ('tag' in p) {
      const h = await P.tagHash(p.tag);
      const t = tags.get(h);
      if (t && t.owner === a.owner) doomed.push(h);
    } else {
      for (const [h, t] of tags) if (t.owner === a.owner) doomed.push(h);
    }
    for (const h of doomed) {
      tags.delete(h);
      const ringing = tagRinging.get(h);
      if (ringing && calls.has(ringing)) endCall(calls.get(ringing), 'unavailable');
    }
    if (doomed.length) { try { saveTags(); } catch (e) { return fail(503, 'busy', 'cannot store tag changes'); } }
    return { status: 200, body: { ok: true, revoked: doomed.length } };
  }

  async function routeListen(body, req, res) {
    const a = await authenticate(body, 'atlas.call.listen', { modes: 'C', session: true });
    if (a.error) return a.error;
    if (a.payload.stop === true) {
      const gone = listeners.get(a.owner);
      if (gone) { gone.events = []; gone.lastSeen = 0; wake(gone); listeners.delete(a.owner); }
      return { status: 200, body: { events: [], serverTime: new Date(now()).toISOString() } };
    }
    const stranger = !tagOwners.has(a.owner);
    let mb = listeners.get(a.owner);
    const fresh = !mb;
    if (fresh) {
      if (stranger && listeners.size >= L.maxListeners) { counters.waiterRefused++; return holdRefusal('busy'); }
      mb = mailbox();
      listeners.set(a.owner, mb);
    }
    mb.lastSeen = now();
    const ack = new Set(a.payload.ack);
    mb.events = mb.events.filter((e) => !ack.has(e.id));
    prune(mb);
    if (!mb.events.length) {
      const refused = await hold(mb, T.listenHoldMs, { source: sourceOf(req), stranger, res });
      if (refused) {
        if (fresh && !mb.events.length && !mb.waiter && listeners.get(a.owner) === mb) listeners.delete(a.owner);
        return holdRefusal(refused);
      }
      mb.lastSeen = now();
      prune(mb);
    }
    return { status: 200, body: { events: mb.events.slice(0, 10), serverTime: new Date(now()).toISOString() } };
  }

  async function routeInvite(body, req) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => k !== 'tag' && k !== 'invite') || typeof body.tag !== 'string' || !ID128_RE.test(body.tag) || !body.invite || typeof body.invite !== 'object') return fail(400, 'bad-request', 'malformed request');
    const a = await authenticate(body.invite, 'atlas.call.invite', { modes: 'A' });
    if (a.error) return a.error;
    const p = a.payload;
    counters.invites++;
    if (limited('inv-src:' + sourceOf(req), L.invitesPerSourcePerMin) || limited('inv-key:' + a.signer, L.invitesPerCallerPerMin)) { counters.rateLimited++; return fail(429, 'rate-limited', 'too many requests'); }

    // Everything below that depends on stored state ends in the same refusal.
    const h = await P.tagHash(body.tag);
    const tag = tags.get(h);
    const t = now();
    const mb = tag ? listeners.get(tag.owner) : null;
    const good = !!tag && p.tag === body.tag && tag.bind.publicKey === a.signer && p.caller.publicKey === a.signer &&
      p.callee.publicKey === tag.calleeKey && Date.parse(tag.expiresAt) > t && tag.used < tag.maxCalls &&
      Date.parse(p.expiresAt) > t && Date.parse(p.issuedAt) <= t + P.LIMITS.walletSkewMs &&
      !calls.has(p.callId) && !seenCallIds.has(p.callId) && !tagRinging.has(h) &&
      !!mb && (!!mb.waiter || t - mb.lastSeen <= T.listenerFreshMs) && calls.size < L.maxLiveCalls &&
      !limited('inv-callee:' + (tag && tag.owner), L.invitesPerCalleePerMin);
    if (!good) { counters.refusedInvites++; return UNAVAILABLE(); }

    const call = {
      callId: p.callId, tagHash: h, owner: tag.owner, callerKey: a.signer, calleeKey: tag.calleeKey,
      keyA: p.callKey, keyB: null, invite: { payload: p, proof: body.invite.proof }, accept: null, th: null,
      state: 'RINGING', accepted: false, createdAt: t, inviteExpiresAt: Date.parse(p.expiresAt), deadline: 0,
      boxA: mailbox(), boxB: mailbox(), seqA: 0, seqB: 0, sentSdpA: false, sentSdpB: false,
      candA: 0, candB: 0, confirmA: false, confirmB: false, iceIssued: { A: 0, B: 0 }, messages: 0, lastSeenA: t, lastSeenB: t, endedAt: 0, endReason: null
    };
    calls.set(p.callId, call);
    seenCallIds.set(p.callId, t + T.seenCallIdMs);
    tagRinging.set(h, p.callId);
    tag.used++;
    try { saveTags(); } catch (e) { /* the count is advisory; the call proceeds */ }
    push(mb, { type: 'invite', callId: p.callId, invite: call.invite }, call.inviteExpiresAt);
    return { status: 202, body: { ok: true } };
  }

  // The poll and ice routes: authenticated by whichever call key the signer holds.
  async function callForKeyRoute(body, type) {
    const a = await authenticate(body, type, { modes: 'B' });
    if (a.error) return { error: a.error };
    const call = calls.get(a.payload.callId);
    if (!call) return { error: UNAVAILABLE() };
    let role = null;
    if (a.signer === call.keyA) role = 'A';
    else if (call.keyB && a.signer === call.keyB) role = 'B';
    if (!role) return { error: UNAVAILABLE() };
    return { a, call, role };
  }

  async function routePoll(body, req, res) {
    const r = await callForKeyRoute(body, 'atlas.call.poll');
    if (r.error) return r.error;
    const { call, role, a } = r;
    const mb = role === 'A' ? call.boxA : call.boxB;
    if (role === 'A') call.lastSeenA = now(); else call.lastSeenB = now();
    const after = a.payload.after;
    mb.events = mb.events.filter((e) => e.id > after);
    if (!mb.events.length && call.state !== 'ENDED') {
      const refused = await hold(mb, T.listenHoldMs, { source: sourceOf(req), stranger: false, res });
      if (refused) return holdRefusal(refused);
      mb.events = mb.events.filter((e) => e.id > after);
    }
    if (role === 'A') call.lastSeenA = now(); else call.lastSeenB = now();
    return { status: 200, body: { events: mb.events.slice(0, 20).map((e) => (e.type === 'signal' ? { n: e.id, type: 'signal', message: e.message } : { n: e.id, type: e.type, reason: e.reason })), serverTime: new Date(now()).toISOString() } };
  }

  // TURN credentials follow coturn's REST scheme: the username carries the expiry time, the credential
  // is the base64 HMAC-SHA1 of the username under the secret shared with the TURN server. The username
  // holds no identity, call id or key. The lifetime never outlasts the call's own maximum.
  function mintTurnCredential(call) {
    const t = now();
    const ttl = Math.min(Number.isInteger(cfg.turnTtlSeconds) ? cfg.turnTtlSeconds : 3600, Math.floor((call.createdAt + T.maxCallMs - t) / 1000));
    if (!(ttl >= 30)) return null;
    const expires = Math.floor(t / 1000) + ttl;
    const username = expires + ':' + P.randomId(8);
    const credential = nodeCrypto.createHmac('sha1', cfg.turnSecret).update(username).digest('base64');
    return { username, credential, ttl, expiresAt: new Date(expires * 1000).toISOString() };
  }

  // Answered only to a holder of one of the call's two keys, and only once the callee has accepted
  // (identity-signed), so ringing a wallet never yields a credential. Each side may fetch a few.
  async function routeIce(body) {
    const r = await callForKeyRoute(body, 'atlas.call.ice');
    if (r.error) return r.error;
    const { call, role } = r;
    if (call.state === 'RINGING' || call.state === 'ENDED') return UNAVAILABLE();
    const iceServers = cfg.stunUrls.length ? [{ urls: cfg.stunUrls.slice() }] : [];
    const out = { iceServers, ttl: 600, serverTime: new Date(now()).toISOString() };
    if (turnEnabled) {
      if (call.iceIssued[role] >= L.maxTurnCredentialsPerRole) return fail(429, 'rate-limited', 'too many requests');
      const c = mintTurnCredential(call);
      if (c) {
        call.iceIssued[role]++;
        counters.turnCredentialsIssued++;
        iceServers.push({ urls: cfg.turnUrls.slice(), username: c.username, credential: c.credential });
        out.ttl = c.ttl;
        out.credentialExpiresAt = c.expiresAt;
      }
    }
    return { status: 200, body: out };
  }

  async function routeSignal(body, req) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'bad-request', 'malformed request');
    if (Object.keys(body).some((k) => k !== 'payload' && k !== 'proof' && k !== 'session') || !P.validateEnvelope(body.proof)) return fail(400, 'bad-request', 'malformed request');
    const shape = P.validatePayload(body.payload);
    if (!shape.ok || body.payload.type !== 'atlas.call.signal') return fail(400, 'bad-request', 'malformed request');
    const p = body.payload;
    if (p.audience !== cfg.origin) return fail(401, 'wrong-audience', 'this message is addressed to a different service');
    if (limited('sig-src:' + sourceOf(req), L.perSourcePerMin)) { counters.rateLimited++; return fail(429, 'rate-limited', 'too many requests'); }

    // Verify whatever signature the kind calls for, whether or not the call exists, so a
    // missing call and a forged message cost the same.
    let sigOk = false, sessionOwner = null;
    if (p.kind === 'decline' || p.kind === 'busy') {
      const s = body.session;
      const sShape = s && typeof s === 'object' ? P.validatePayload(s.payload) : null;
      if (sShape && sShape.ok && s.payload.type === 'atlas.call.listen-session' && P.validateEnvelope(s.proof) && body.proof.signerRole === 'raw-ecdsa' && body.proof.publicKey === s.payload.sessionKey && s.payload.audience === cfg.origin &&
          Date.parse(s.payload.issuedAt) <= now() + P.LIMITS.walletSkewMs && Date.parse(s.payload.expiresAt) >= now()) {
        sigOk = (await P.verifyEnvelope(s.payload, s.proof)) && (await P.verifyEnvelope(p, body.proof));
        if (sigOk) sessionOwner = s.proof.publicKey;
      }
    } else if (body.session === undefined) {
      if (p.kind === 'accept') sigOk = await P.verifyEnvelope(p, body.proof);
      else sigOk = body.proof.signerRole === 'raw-ecdsa' && (await P.verifyEnvelope(p, body.proof));
    }
    if (!sigOk) { counters.authFailures++; return UNAVAILABLE(); }

    const call = calls.get(p.callId);
    if (!call || call.state === 'ENDED') return UNAVAILABLE();
    if (++call.messages > L.maxSignalsPerCall) { endCall(call, 'error'); return UNAVAILABLE(); }
    const signer = body.proof.publicKey;
    const t = now();
    const message = { payload: p, proof: body.proof };

    // ----- identity-signed accept (callee) -----
    if (p.kind === 'accept') {
      if (call.state !== 'RINGING' || t >= call.inviteExpiresAt || signer !== call.calleeKey) return UNAVAILABLE();
      if (p.body.inviteHash !== (await P.payloadHash(call.invite.payload))) return UNAVAILABLE();
      if (p.body.callKey === call.keyA) return UNAVAILABLE();
      call.keyB = p.body.callKey;
      call.accept = message;
      call.th = await P.transcriptHash(call.invite.payload, p);
      call.accepted = true;
      call.state = 'ACCEPTED';
      call.deadline = t + T.acceptToOfferMs;
      counters.accepted++;
      if (tagRinging.get(call.tagHash) === call.callId) tagRinging.delete(call.tagHash);
      removeListenerEvents(call);
      push(call.boxA, { type: 'signal', message });
      return { status: 202, body: { ok: true } };
    }

    // ----- session-signed decline / busy (callee, before accept) -----
    if (p.kind === 'decline' || p.kind === 'busy') {
      if (call.state !== 'RINGING' || sessionOwner !== call.owner) return UNAVAILABLE();
      endCall(call, p.kind === 'busy' ? 'busy' : 'declined', 'callee');
      return { status: 202, body: { ok: true } };
    }

    // ----- call-key-signed messages -----
    const role = signer === call.keyA ? 'A' : (call.keyB && signer === call.keyB ? 'B' : null);
    if (!role) return UNAVAILABLE();
    const seqName = role === 'A' ? 'seqA' : 'seqB';
    if (p.seq !== call[seqName] + 1) return UNAVAILABLE();
    if ('th' in p && p.th !== call.th && call.th) return UNAVAILABLE();
    if ('th' in p && !call.th) return UNAVAILABLE();
    const other = role === 'A' ? call.boxB : call.boxA;
    const st = call.state;
    let next = null;

    if (p.kind === 'cancel') {
      if (role !== 'A' || st !== 'RINGING') return UNAVAILABLE();
      call[seqName]++;
      const mb = listeners.get(call.owner);
      call.state = 'ENDED'; call.endedAt = t; call.endReason = 'cancelled'; counters.ended++;
      if (tagRinging.get(call.tagHash) === call.callId) tagRinging.delete(call.tagHash);
      removeListenerEvents(call);
      if (mb) push(mb, { type: 'cancel', callId: call.callId, message }, t + T.endedRetainMs);
      return { status: 202, body: { ok: true } };
    }
    if (p.kind === 'end') {
      if (st === 'RINGING') {
        if (role !== 'A') return UNAVAILABLE();
        call[seqName]++;
        const mb = listeners.get(call.owner);
        call.state = 'ENDED'; call.endedAt = t; call.endReason = 'cancelled'; counters.ended++;
        if (tagRinging.get(call.tagHash) === call.callId) tagRinging.delete(call.tagHash);
        removeListenerEvents(call);
        if (mb) push(mb, { type: 'cancel', callId: call.callId, message }, t + T.endedRetainMs);
        return { status: 202, body: { ok: true } };
      }
      call[seqName]++;
      call.state = 'ENDED'; call.endedAt = t; call.endReason = 'hangup'; counters.ended++;
      push(other, { type: 'signal', message });
      return { status: 202, body: { ok: true } };
    }
    if (p.kind === 'offer') {
      if (role !== 'A' || st !== 'ACCEPTED') return UNAVAILABLE();
      call.sentSdpA = true; next = 'NEGOTIATING'; call.deadline = t + T.offerToAnswerMs;
    } else if (p.kind === 'answer') {
      if (role !== 'B' || st !== 'NEGOTIATING') return UNAVAILABLE();
      call.sentSdpB = true; next = 'ESTABLISHING'; call.deadline = t + T.confirmMs;
    } else if (p.kind === 'candidates') {
      if (!(st === 'NEGOTIATING' || st === 'ESTABLISHING' || st === 'ACTIVE')) return UNAVAILABLE();
      if (!(role === 'A' ? call.sentSdpA : call.sentSdpB)) return UNAVAILABLE();
      const n = p.body.candidates.length + (role === 'A' ? call.candA : call.candB);
      if (n > P.LIMITS.candidatesPerCall) return UNAVAILABLE();
      if (role === 'A') call.candA = n; else call.candB = n;
    } else if (p.kind === 'confirm') {
      if (st !== 'ESTABLISHING') return UNAVAILABLE();
      if (role === 'A') { if (call.confirmA) return UNAVAILABLE(); call.confirmA = true; } else { if (call.confirmB) return UNAVAILABLE(); call.confirmB = true; }
      if (call.confirmA && call.confirmB) { next = 'ACTIVE'; call.deadline = 0; }
    } else {
      return UNAVAILABLE();
    }
    call[seqName]++;
    if (next) call.state = next;
    push(other, { type: 'signal', message });
    return { status: 202, body: { ok: true } };
  }

  // ----- HTTP server -----
  const ROUTES = {
    '/atlas/call/tag/create': { fn: routeTagCreate, max: P.LIMITS.bodyMax['tag/create'] },
    '/atlas/call/tag/revoke': { fn: routeTagRevoke, max: P.LIMITS.bodyMax['tag/revoke'] },
    '/atlas/call/tag/list': { fn: routeTagList, max: P.LIMITS.bodyMax['tag/list'] },
    '/atlas/call/listen': { fn: routeListen, max: P.LIMITS.bodyMax.listen },
    '/atlas/call/invite': { fn: routeInvite, max: P.LIMITS.bodyMax.invite, cors: true },
    '/atlas/call/poll': { fn: routePoll, max: P.LIMITS.bodyMax.poll },
    '/atlas/call/signal': { fn: routeSignal, max: P.LIMITS.bodyMax.signal },
    '/atlas/call/ice': { fn: routeIce, max: P.LIMITS.bodyMax.ice }
  };
  // No cross-origin access by default. Only the invite route can be opened to origins the
  // operator names exactly; the answer then names that one origin, never a wildcard.
  const corsAllowed = new Set(cfg.corsOrigins || []);
  const corsHeaders = (origin) => ({ 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin' });
  const JSON_TYPE_RE = /^application\/json\s*(;.*)?$/i;

  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    let release = null;
    try {
      const pathname = (req.url || '').split('?')[0];
      if (req.method === 'GET' && pathname === '/atlas/call/info') return send(res, 200, info());
      const route = ROUTES[pathname];
      if (!route) return send(res, 404, { error: 'not found', code: 'not-found' });
      const origin = req.headers.origin;
      const originAllowed = origin !== undefined && route.cors && corsAllowed.has(origin);
      const hdr = originAllowed ? corsHeaders(origin) : {};
      if (route.cors && req.method === 'OPTIONS' && originAllowed) { res.writeHead(204, Object.assign({ 'Cache-Control': 'no-store' }, hdr)); return res.end(); }
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed', code: 'method-not-allowed' }, hdr);
      if (!cfg.configured) return send(res, 503, { error: 'calls are not configured on this service', code: 'calls-not-configured' }, hdr);
      if (proxyHttpsProblem(req)) { counters.httpsRequired++; return send(res, 400, { error: 'https is required', code: 'https-required' }); }
      // A web page's origin is not an input to authentication; a request from one that the
      // operator did not name is refused. The wallet's own requests carry no web origin.
      if (origin !== undefined && !originAllowed && /^(https?:|null$)/i.test(origin)) { counters.originRefused++; return send(res, 403, { error: 'origin not allowed', code: 'origin-not-allowed' }); }
      if (!JSON_TYPE_RE.test(String(req.headers['content-type'] || ''))) { counters.badContentType++; return send(res, 415, { error: 'content type must be application/json', code: 'unsupported-media-type' }, hdr); }
      const src = sourceOf(req);
      const open = (inflight.get(src) || 0) + 1;
      inflight.set(src, open);
      release = () => {
        const left = (inflight.get(src) || 1) - 1;
        if (left > 0) inflight.set(src, left); else inflight.delete(src);
      };
      res.once('close', release);
      if (open > L.maxInflightPerSource) { counters.inflightRefused++; return send(res, 429, { error: 'too many requests', code: 'too-many-connections' }, Object.assign({ 'Retry-After': '5' }, hdr)); }
      if (limited('src:' + src, L.perSourcePerMin)) { counters.rateLimited++; return send(res, 429, { error: 'too many requests', code: 'rate-limited' }, hdr); }
      let text;
      try { text = await readBody(req, route.max); } catch (e) {
        const st = e.status || 400;
        const out = send(res, st, { error: st === 413 ? 'request too large' : st === 408 ? 'request timed out' : 'bad request', code: st === 413 ? 'too-large' : st === 408 ? 'timeout' : 'bad-request' }, Object.assign({ Connection: 'close' }, hdr));
        if (st === 408) res.once('finish', () => req.destroy());
        return out;
      }
      let body;
      try { body = JSON.parse(text); } catch (e) { return send(res, 400, { error: 'malformed request', code: 'bad-request' }, hdr); }
      const out = await route.fn(body, req, res);
      return send(res, out.status, out.body, Object.assign({}, out.headers || {}, hdr));
    } catch (e) {
      if (!res.headersSent) send(res, 500, { error: 'internal error', code: 'internal' });
      else res.end();
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = L.maxConnections;
  // Direct exposure only: behind a proxy every socket comes from the proxy, which limits clients itself.
  server.on('connection', (socket) => {
    if (cfg.trustProxy) return;
    const k = sourceKey(normalizeIp(socket.remoteAddress || '')) || 'unknown';
    const n = (connBySource.get(k) || 0) + 1;
    connBySource.set(k, n);
    socket.once('close', () => {
      const left = (connBySource.get(k) || 1) - 1;
      if (left > 0) connBySource.set(k, left); else connBySource.delete(k);
    });
    if (n > L.maxConnectionsPerSource) { counters.connectionRefused++; socket.destroy(); }
  });

  loadTags();

  return {
    server,
    listen() { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, cfg.bind, () => resolve(server.address())); }); },
    close() {
      clearInterval(sweepTimer);
      for (const mb of listeners.values()) wake(mb);
      for (const c of calls.values()) { wake(c.boxA); wake(c.boxB); }
      return new Promise((resolve) => { server.close(() => resolve()); if (server.closeAllConnections) server.closeAllConnections(); });
    },
    sweep,
    counters,
    stats() {
      return { tags: tags.size, calls: calls.size, liveCalls: [...calls.values()].filter((c) => c.state !== 'ENDED').length, seenCallIds: seenCallIds.size, nonces: nonces.size, listeners: listeners.size, waiters, strangerWaiters, sources: sourceWaiters.size, inflightSources: inflight.size, buckets: buckets.size, tagRinging: tagRinging.size };
    },
    callState(id) { const c = calls.get(id); return c ? c.state : null; }
  };
}

module.exports = { createCallService, loadConfig, isPrivateAddress, normalizeIp, sourceKey, stunProblem, iceUrlProblem, DEFAULT_TIMERS, DEFAULT_LIMITS, TUNABLE_LIMITS };

if (require.main === module) {
  const cfg = loadConfig(process.env);
  const svc = createCallService(cfg, {});
  if (!cfg.configured) {
    console.log('[call-service] not configured (' + cfg.problem + '): answering 503 calls-not-configured; nothing is created on disk. See call-server/README.md.');
  } else {
    console.log('[call-service] configured for ' + cfg.origin + ' (domain ' + cfg.domain + ')' + (cfg.stateFile ? '' : '; tags are held in memory only (no CALL_STATE_FILE)'));
    if (cfg.origin.startsWith('http:')) console.log('[call-service] WARNING: plain http is allowed for a private test network only; use https for anything else.');
    if (cfg.trustProxy) console.log('[call-service] proxy mode: client addresses come from X-Forwarded-For sent by ' + cfg.proxyAddrs.join(', ') + (cfg.origin.startsWith('https:') ? '; requests must carry X-Forwarded-Proto: https' : ''));
    if (cfg.trustProxy && !['127.0.0.1', '::1', 'localhost'].includes(cfg.bind)) console.log('[call-service] WARNING: proxy mode with a non-loopback bind: make sure only the proxy can reach this port.');
    if (!cfg.trustProxy && cfg.origin.startsWith('https:')) console.log('[call-service] note: an https origin without CALL_TRUST_PROXY=1 means TLS is terminated elsewhere and every client looks like the proxy; set it when a reverse proxy is in front.');
    console.log('[call-service] TURN: ' + (cfg.turnUrls.length ? cfg.turnUrls.join(', ') + ' (credentials valid ' + cfg.turnTtlSeconds + ' s)' : 'none'));
    console.log('[call-service] STUN: ' + (cfg.stunUrls.length ? cfg.stunUrls.join(', ') : 'none (direct connections only)') + '; cross-origin access: ' + (cfg.corsOrigins.length ? 'invite route for ' + cfg.corsOrigins.join(', ') : 'none'));
  }
  svc.listen().then((addr) => {
    console.log('[call-service] listening on ' + addr.address + ':' + addr.port);
    if (addr.address !== '127.0.0.1' && addr.address !== '::1') console.log('[call-service] bound beyond loopback: only expose this on a network you control; this process does not open any firewall port.');
  }).catch((e) => { console.error('[call-service] cannot listen: ' + e.message); process.exit(1); });
  const stop = () => { svc.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
