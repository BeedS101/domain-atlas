// The one policy for this server's requests to other domains (relays, key and revocation discovery).
//
//   - A peer is a domain authority (host or host:port), never a URL: no scheme, userinfo, path, query or fragment.
//   - A public domain is reached over https on the default port, by DNS name. Loopback, private, link-local, shared,
//     multicast, reserved and cloud-metadata destinations are refused, judged on every address the name resolves to,
//     and the socket connects only to an address that passed that check (the check is the socket's own lookup).
//   - Local development is an explicit mode: this server's own configured domain (ATLAS_DOMAIN) being a local host
//     (localhost, 127.0.0.1, [::1]), or ATLAS_ALLOW_LOCAL_PEERS=1. Then, and only then, a loopback peer is reached over
//     plain http. A server configured with a public domain never reaches loopback (ATLAS_ALLOW_LOCAL_PEERS=0 also forces
//     it off).
//   - Redirects are not followed; a request has connect and total time limits and a response size limit.
//   - Requests are rate limited per remote domain and overall, counting every attempt, failures included, before any
//     connection is made, so a flood of made-up domains cannot turn this server into a lookup engine. The budgets are
//     split by kind of operation and by who caused the request, so one caller or one kind of operation cannot use up
//     what the others need (createRateLimiter).
//   - A failure's message is safe to send to a client (it names the peer the client supplied and a short category);
//     the underlying detail is logged and kept on `detail`.
'use strict';
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

class OutboundError extends Error {
  constructor(message, code, detail) {
    super(message);
    this.name = 'OutboundError';
    this.code = code;
    this.detail = detail || null;
  }
}

function ipv6Bytes(ip) {
  let text = ip.toLowerCase().replace(/%.*$/, '');
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const p = tail[1].split('.').map(Number);
    text = text.slice(0, -tail[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = head.concat(new Array(halves.length === 2 ? missing : 0).fill('0'), rest);
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    const n = parseInt(g || '0', 16);
    if (!(n >= 0 && n <= 0xffff)) return null;
    out.push(n >> 8, n & 255);
  }
  return out;
}

// True only for an address a public peer may have: not loopback, private, link-local, shared, documentation,
// benchmarking, multicast or reserved, and not an IPv6 form that wraps one of those.
function isPublicAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (v === 6) {
    const b = ipv6Bytes(ip);
    if (!b) return false;
    const zeroPrefix = b.slice(0, 10).every((x) => x === 0);
    if (zeroPrefix && b[10] === 0xff && b[11] === 0xff) return isPublicAddress(b[12] + '.' + b[13] + '.' + b[14] + '.' + b[15]);
    if (zeroPrefix) return false; // ::, ::1 and the IPv4-compatible forms
    if ((b[0] & 0xfe) === 0xfc) return false; // fc00::/7, which holds fd00:ec2::254
    if (b[0] === 0xfe) return false; // link-local fe80::/10 and the deprecated site-local range
    if (b[0] === 0xff) return false; // multicast
    if (b[0] === 0x20 && b[1] === 0x01 && ((b[2] === 0x0d && b[3] === 0xb8) || (b[2] === 0 && b[3] === 0))) return false; // documentation, Teredo
    if (b[0] === 0x20 && b[1] === 0x02) return false; // 6to4
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return false; // NAT64
    return true;
  }
  return false;
}

function isLoopbackAddress(ip) {
  if (net.isIP(ip) === 4) return ip.split('.')[0] === '127';
  const b = net.isIP(ip) === 6 ? ipv6Bytes(ip) : null;
  if (!b) return false;
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true;
  return b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff && b[12] === 127;
}

const LOCAL_NAME = /^(localhost|127\.0\.0\.1|\[::1\])$/;
const isLocalHostName = (host) => LOCAL_NAME.test(host) || host.endsWith('.localhost');
const DNS_NAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.intranet', '.lan', '.home.arpa', '.corp'];

// Splits a peer authority into its parts, or throws an OutboundError. `allowLocal` admits loopback names over http.
function parsePeer(text, allowLocal) {
  const bad = (why) => new OutboundError('not an acceptable domain', 'peer-invalid', why);
  if (typeof text !== 'string' || !text || text.length > 255) throw bad('not a string of a sensible length');
  const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(text);
  if (!m) throw bad('not a plain host or host:port');
  const hostname = m[1].toLowerCase();
  const port = m[2] !== undefined ? Number(m[2]) : null;
  if (port !== null && (port < 1 || port > 65535)) throw bad('port out of range');
  if (allowLocal && isLocalHostName(hostname)) {
    return { authority: hostname + (port !== null ? ':' + port : ''), hostname, port: port !== null ? port : 80, scheme: 'http', local: true };
  }
  if (hostname.startsWith('[') || net.isIP(hostname)) throw bad('an address, not a domain name');
  if (hostname.length > 253 || !DNS_NAME.test(hostname) || isLocalHostName(hostname) || BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) throw bad('not a public domain name');
  if (/^[0-9]+$/.test(hostname.slice(hostname.lastIndexOf('.') + 1))) throw bad('a numeric host');
  if (port !== null && port !== 443) throw bad('only the default https port is accepted');
  return { authority: hostname, hostname, port: 443, scheme: 'https', local: false };
}

function envNumber(env, name, fallback) {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Budgets over a sliding window. Every attempt that is let through is remembered with its operation class, the domain
// it was for and the caller that caused it (refused attempts cost nothing and are not remembered, so what is held is
// bounded by the overall budget). An attempt is refused when
//   - the overall budget is spent, or taking it would eat into another class's reserved floor (`classes`), or
//   - this domain's budget for this class is spent, or
//   - the caller has already used its fair share and only the reserved slice is left, in the overall budget or in this
//     domain's: a caller that has used `share` of a budget cannot take its last `reserve`, which stays for callers that
//     have not.
// `reserve` and `share` are fractions; reserve 0 turns the sharing rules off (budgets then behave as plain caps). A
// budget too small to have a whole reserved slice has none. An attempt with no caller (this server's own work, not a
// request from outside) is never held to the share rule.
function createRateLimiter(window, perAuthority, overall, options) {
  const o = options || {};
  const reserve = o.reserve > 0 ? o.reserve : 0;
  const share = o.share > 0 ? Math.min(1, o.share) : 0.25;
  const classes = o.classes && o.classes.length ? o.classes : ['default'];
  const slice = (budget) => Math.floor(budget * reserve);
  const fair = (budget) => Math.max(1, Math.ceil(budget * share));
  let held = [];
  return function take(authority, now, caller, klass) {
    const t = now === undefined ? Date.now() : now;
    held = held.filter((e) => t - e.at < window);
    const cls = klass && classes.includes(klass) ? klass : classes[0];
    const named = typeof caller === 'string' && caller !== '';
    if (held.length >= overall) return false;
    if (named && held.length >= overall - slice(overall) && held.reduce((n, e) => n + (e.caller === caller ? 1 : 0), 0) >= fair(overall)) return false;
    if (classes.length > 1) {
      const used = {};
      for (const e of held) used[e.cls] = (used[e.cls] || 0) + 1;
      let reservedForOthers = 0;
      for (const c of classes) if (c !== cls) reservedForOthers += Math.max(0, slice(overall) - (used[c] || 0));
      if (held.length + 1 + reservedForOthers > overall) return false;
    }
    let here = 0, mine = 0;
    for (const e of held) if (e.cls === cls && e.authority === authority) { here++; if (e.caller === caller) mine++; }
    if (here >= perAuthority) return false;
    if (named && here >= perAuthority - slice(perAuthority) && mine >= fair(perAuthority)) return false;
    held.push({ at: t, cls, authority, caller: named ? caller : null });
    return true;
  };
}

// A fraction from the environment within [min, max], or the fallback.
function envFraction(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

// options: ownDomain (this server's own domain), env, and, for tests only and never from the environment:
//   resolve(hostname) -> [{address, family}], dial(peer, address) -> {host, port, ca} to connect somewhere else.
function createOutbound(options) {
  const env = options.env || process.env;
  const own = (() => { try { return parsePeer(String(options.ownDomain || ''), true); } catch (e) { return null; } })();
  const flag = env.ATLAS_ALLOW_LOCAL_PEERS;
  const allowLocal = flag === '0' ? false : flag === '1' ? true : !!(own && own.local);
  const windowMs = envNumber(env, 'ATLAS_OUTBOUND_RATE_WINDOW_MS', 60000);
  // Two overall budgets (published-key discovery, and everything else), the second split into operation classes that
  // each keep a reserved floor: 'verify' (a credential's revocation and suspension lists), 'drop' (world-drop relays)
  // and 'relay' (trade, mail and other relays). Callers are the sockets that made the request that caused the lookup.
  const reserve = envFraction(env, 'ATLAS_OUTBOUND_RESERVE', 0.15, 0, 0.3);
  const share = envFraction(env, 'ATLAS_OUTBOUND_FAIR_SHARE', 0.25, 0.01, 1);
  const limiters = {
    key: createRateLimiter(windowMs, envNumber(env, 'ATLAS_OUTBOUND_KEY_RATE', 20), envNumber(env, 'ATLAS_OUTBOUND_KEY_RATE_ALL', 120), { reserve, share, classes: ['key'] }),
    other: createRateLimiter(windowMs, envNumber(env, 'ATLAS_OUTBOUND_RATE', 120), envNumber(env, 'ATLAS_OUTBOUND_RATE_ALL', 600), { reserve, share, classes: ['verify', 'drop', 'relay'] })
  };
  const maxBytesDefault = envNumber(env, 'ATLAS_OUTBOUND_MAX_BYTES', 4 * 1024 * 1024);
  const timeoutDefault = envNumber(env, 'ATLAS_OUTBOUND_TIMEOUT_MS', 10000);

  // Resolves the peer's name once and returns the addresses the socket may use: every one has passed the check, so a
  // name that answers with a mix of public and internal addresses is refused outright.
  async function resolveChecked(peer) {
    const refuse = (detail) => new OutboundError('not an acceptable domain', 'peer-invalid', detail);
    let addresses;
    if (net.isIP(peer.hostname.replace(/^\[|\]$/g, ''))) {
      const literal = peer.hostname.replace(/^\[|\]$/g, '');
      addresses = [{ address: literal, family: net.isIP(literal) }];
    } else {
      try {
        addresses = options.resolve ? await options.resolve(peer.hostname) : await dns.promises.lookup(peer.hostname, { all: true });
      } catch (err) {
        throw new OutboundError('could not reach ' + peer.authority, 'unreachable', 'lookup failed: ' + (err && err.code));
      }
    }
    if (!addresses || !addresses.length) throw new OutboundError('could not reach ' + peer.authority, 'unreachable', 'no addresses');
    const ok = peer.local ? addresses.every((a) => isLoopbackAddress(a.address)) : addresses.every((a) => isPublicAddress(a.address));
    if (!ok) throw refuse('resolves to a non-public address');
    return addresses;
  }

  // kind: 'key' for published-key discovery (the cheapest thing a stranger can make this server do), 'verify' for a
  // credential's revocation and suspension lists, 'drop' for a world-drop relay, anything else (trade, mail and other
  // relays) 'relay'. options.caller() names who caused the request, or returns null for this server's own work.
  async function request(domain, pathAndQuery, opts) {
    const o = opts || {};
    const peer = parsePeer(domain, allowLocal);
    if (typeof pathAndQuery !== 'string' || !pathAndQuery.startsWith('/') || /[\x00-\x20\x7f\\]/.test(pathAndQuery)) {
      throw new OutboundError('not an acceptable request', 'path-invalid');
    }
    const caller = options.caller ? options.caller() : null;
    const allowed = o.kind === 'key' ? limiters.key(peer.authority, undefined, caller, 'key')
      : limiters.other(peer.authority, undefined, caller, o.kind === 'verify' || o.kind === 'drop' ? o.kind : 'relay');
    if (!allowed) {
      throw new OutboundError('too many requests to other domains just now; try again shortly', 'rate-limited');
    }
    const maxBytes = o.maxBytes || maxBytesDefault;
    let pinned;
    try {
      pinned = (await resolveChecked(peer)).sort((a, b) => a.family - b.family)[0]; // an IPv4 address first, like the PHP side
    } catch (err) {
      if (err.detail) console.warn('outbound to', peer.authority, 'refused:', err.detail);
      throw err;
    }
    const target = options.dial ? options.dial(peer, pinned) : { host: pinned.address, port: peer.port };
    const transport = peer.scheme === 'https' ? https : http;
    const body = o.body === undefined ? null : Buffer.from(typeof o.body === 'string' ? o.body : JSON.stringify(o.body));
    const headers = Object.assign({ Accept: 'application/json', 'User-Agent': 'DomainAtlas-Relay/1.0' }, o.headers || {});
    if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length; }
    return new Promise((resolve, reject) => {
      const fail = (err) => {
        if (err instanceof OutboundError) { if (err.detail) console.warn('outbound to', peer.authority, 'refused:', err.detail); return reject(err); }
        const detail = (err && err.cause && err.cause.code) || (err && err.code) || (err && err.message) || 'error';
        console.warn('outbound to', peer.authority, 'failed:', detail);
        reject(new OutboundError('could not reach ' + peer.authority, /timeout|timed out|ETIMEDOUT/i.test(String(detail)) ? 'timeout' : 'unreachable', String(detail)));
      };
      const req = transport.request({
        method: o.method || 'GET', hostname: target.host, port: target.port, path: pathAndQuery,
        headers, agent: false, timeout: o.timeoutMs || timeoutDefault,
        servername: peer.local ? undefined : peer.hostname, ca: target.ca, setHost: false
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); return fail(new OutboundError('could not reach ' + peer.authority, 'redirect-refused', 'redirects are not followed')); }
        const declared = Number(res.headers['content-length']);
        if (declared > maxBytes) { res.destroy(); return fail(new OutboundError('the response from ' + peer.authority + ' was too large', 'too-large', 'declared ' + declared)); }
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) { res.destroy(); return fail(new OutboundError('the response from ' + peer.authority + ' was too large', 'too-large', 'streamed past ' + maxBytes)); }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text, json() { return JSON.parse(text); } });
        });
        res.on('error', fail);
      });
      req.setHeader('Host', peer.authority === peer.hostname && peer.port === 443 ? peer.hostname : peer.hostname + ':' + peer.port);
      req.on('timeout', () => req.destroy(new OutboundError('could not reach ' + peer.authority, 'timeout', 'timed out')));
      req.on('error', fail);
      if (body) req.write(body);
      req.end();
    });
  }

  return { request, parsePeer: (d) => parsePeer(d, allowLocal), allowLocal, isPublicAddress };
}

module.exports = { createOutbound, OutboundError, isPublicAddress, isLoopbackAddress, parsePeer, createRateLimiter };
