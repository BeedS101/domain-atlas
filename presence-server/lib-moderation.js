// Domain Atlas presence server: moderation authorization.
//
// Verifies the signed moderation grants described in
// docs/moderation-authorization.md and decides whether a request may use one.
// Zero dependencies, like server.js. This file only decides WHETHER a request
// may proceed; server.js carries out the operations it names once authorize()
// succeeds: roster.view (read-only list), chat.mute, chat.unmute and
// session.kick (temporary, in-memory restrictions: lib-restrictions.js).
// presence-php/presence/lib/moderation.php implements the same rules, step
// for step.
//
// Trust comes from explicit configuration only (moderation-config.json, or the
// file named by PRESENCE_MODERATION_CONFIG): for each domain, the issuer
// public keys to trust and the URL its status statement is fetched from. No key
// or URL is ever taken from a request, a manifest or a grant. A request is
// accepted only when ALL of these hold, checked in this order:
//
//   1. moderation is configured and enabled (otherwise 503, fail closed);
//   2. the grant names a configured domain;
//   3. the grant is signed by a key pinned for that domain, names this
//      service as its audience, is unexpired and well formed;
//   4. the operator has not revoked the grant or its moderator locally;
//   5. the request is signed by the grant's ephemeral key (proof of
//      possession), names the same grant, audience and domain, an operation
//      and world the grant allows, and is fresh;
//   6. a current issuer-signed status statement lists the moderator with the
//      operation and world in force NOW (otherwise 503, fail closed);
//   7. the request nonce has not been used with this grant.
//
// Only then does the caller get a result. Keep every rule here in step with
// moderation.php.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { subtle } = crypto.webcrypto;

function envNumber(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const CONFIG_FILE = process.env.PRESENCE_MODERATION_CONFIG || path.join(__dirname, 'moderation-config.json');
// How old a statement may get before the next request fetches a new one.
const STATUS_REFRESH_MS = envNumber('MODERATION_STATUS_REFRESH_S', 15) * 1000;
// The longest statement lifetime this service accepts, whatever the issuer signs.
const STATUS_MAX_TTL_MS = envNumber('MODERATION_STATUS_MAX_TTL_S', 120) * 1000;
// How far a statement's or grant's issue time may differ from this clock.
const CLOCK_SKEW_MS = envNumber('MODERATION_CLOCK_SKEW_S', 30) * 1000;
// How far a request's timestamp may differ from this clock.
const REQUEST_WINDOW_MS = envNumber('MODERATION_REQUEST_WINDOW_S', 60) * 1000;
const FETCH_TIMEOUT_MS = envNumber('MODERATION_FETCH_TIMEOUT_MS', 3000);
const STATUS_MAX_BYTES = 256 * 1024;
const MAX_TRACKED_GRANTS = envNumber('MODERATION_MAX_TRACKED_GRANTS', 5000);
const MAX_NONCES_PER_GRANT = envNumber('MODERATION_MAX_NONCES_PER_GRANT', 1000);
const FAIL_MAX = envNumber('MODERATION_FAIL_MAX', 20);
// Commands per moderator per minute, and how long a mute or a kick may last.
const COMMANDS_PER_MIN = envNumber('MODERATION_COMMANDS_PER_MIN', 30);
const COMMAND_WINDOW_MS = envNumber('MODERATION_COMMAND_WINDOW_MS', 60 * 1000);
const MUTE_DEFAULT_S = envNumber('MODERATION_MUTE_DEFAULT_S', 600);
const MUTE_MAX_S = envNumber('MODERATION_MUTE_MAX_S', 24 * 60 * 60);
const KICK_DEFAULT_S = envNumber('MODERATION_KICK_DEFAULT_S', 300);
const KICK_MAX_S = envNumber('MODERATION_KICK_MAX_S', 60 * 60);
const FAIL_WINDOW_MS = envNumber('MODERATION_FAIL_WINDOW_MS', 60 * 1000);
const MAX_FAIL_SOURCES = 5000;

const GRANT_TYPE = 'atlas.moderation-grant';
const REQUEST_TYPE = 'atlas.moderation-request';
const STATUS_TYPE = 'atlas.moderation-status';
const GRANT_SIGN_CONTEXT = 'atlas-moderation-grant/v1\n';
const POP_SIGN_CONTEXT = 'atlas-moderation-pop/v1\n';
const STATUS_SIGN_CONTEXT = 'atlas-moderation-status/v1\n';
const OPERATIONS = ['roster.view', 'chat.mute', 'chat.unmute', 'session.kick', 'session.timeout'];
const MAX_GRANT_LIFETIME_MS = 600 * 1000;
const MAX_WORLDS = 32;
const GRANT_FIELDS = ['type', 'version', 'grantId', 'domain', 'audience', 'moderatorRef', 'worlds', 'operations', 'issuedAt', 'expiresAt', 'cnf'];
const REQUEST_FIELDS = ['type', 'version', 'grantId', 'audience', 'domain', 'world', 'operation', 'target', 'issuedAt', 'nonce'];
// Optional members. `params` carries a command's arguments (duration and cause
// code); a request that has none must omit the member entirely.
const REQUEST_OPTIONAL_FIELDS = ['params'];
const STATUS_FIELDS = ['type', 'version', 'domain', 'audience', 'issuedAt', 'expiresAt', 'moderators'];

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasKeys = (o, keys, optional) => {
  const k = Object.keys(o);
  const allowed = keys.concat(optional || []);
  return keys.every((x) => Object.prototype.hasOwnProperty.call(o, x)) && k.every((x) => allowed.includes(x));
};
const fail = (status, code, message) => ({ ok: false, status, code, message });

// Same world-id rule as the issuers: 1 to 120 code points, valid Unicode, no
// control characters or line separators, no leading or trailing white space.
const FORBIDDEN = /[\u0000-\u001f\u007f\u2028\u2029]/u;
const EDGE_SPACE = /^[\s﻿]|[\s﻿]$/u;
function isValidWorldId(w) {
  if (typeof w !== 'string' || w.length === 0 || w.length > 480 || !w.isWellFormed()) return false;
  const n = Array.from(w).length;
  return n >= 1 && n <= 120 && !FORBIDDEN.test(w) && !EDGE_SPACE.test(w);
}

function strictIso(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)) return NaN;
  const t = Date.parse(s);
  return Number.isFinite(t) && new Date(t).toISOString() === s ? t : NaN;
}

const KEY_RE = /^[A-Za-z0-9_-]{87}$/;
const importedKeys = new Map(); // b64 -> CryptoKey | null (bounded by the keys seen in configuration and grants)
async function importRaw(b64) {
  if (typeof b64 !== 'string' || !KEY_RE.test(b64)) return null;
  if (importedKeys.has(b64)) return importedKeys.get(b64);
  let key = null;
  const raw = Buffer.from(b64, 'base64url');
  if (raw.length === 65 && raw[0] === 0x04 && b64url(raw) === b64) {
    try { key = await subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']); } catch (_) { key = null; }
  }
  if (importedKeys.size > 2000) importedKeys.clear();
  importedKeys.set(b64, key);
  return key;
}
async function verifySig(publicKeyB64, signatureB64, context, payload) {
  const key = await importRaw(publicKeyB64);
  if (!key || typeof signatureB64 !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signatureB64)) return false;
  const sig = Buffer.from(signatureB64, 'base64url');
  if (sig.length !== 64) return false;
  const data = Buffer.concat([Buffer.from(context, 'utf8'), Buffer.from(canonicalize(payload), 'utf8')]);
  try { return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data); } catch (_) { return false; }
}

// ---------- configuration ----------
//
//   { "enabled": true,
//     "audience": "https://presence.example.com",
//     "domains": { "example.com": { "issuerKeys": ["<raw P-256 key>", ...],
//                                   "statusUrl": "https://example.com/atlas/moderation/status" } },
//     "revokedModerators": ["<moderatorRef>"], "revokedGrants": ["<grantId>"] }
//
// The file is read on every request and parsed again whenever its text
// changes, so an edit (a key removed, a moderator revoked) applies to the next
// request. A file that cannot be parsed disables moderation entirely.

function isPresenceOrigin(s) {
  return typeof s === 'string' && s.length <= 255 && /^https?:\/\/(\[[0-9a-f:]+\]|[a-z0-9]([a-z0-9.-]*[a-z0-9])?)(:\d{1,5})?$/.test(s);
}
function isAcceptableStatusUrl(u) {
  if (typeof u !== 'string' || u.length > 500) return false;
  let url;
  try { url = new URL(u); } catch (_) { return false; }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}
function parseConfig(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (_) { return { state: 'invalid' }; }
  if (!isObject(raw)) return { state: 'invalid' };
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return { state: 'invalid' };
  if (raw.enabled === false) return { state: 'disabled' };
  if (!isPresenceOrigin(raw.audience) || !isObject(raw.domains)) return { state: 'invalid' };
  const list = (v) => (v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length <= 200) ? v : null);
  const revokedModerators = list(raw.revokedModerators), revokedGrants = list(raw.revokedGrants);
  if (!revokedModerators || !revokedGrants) return { state: 'invalid' };
  const domains = new Map();
  for (const name of Object.keys(raw.domains)) {
    const d = raw.domains[name];
    if (!isObject(d) || !Array.isArray(d.issuerKeys) || !d.issuerKeys.length || d.issuerKeys.length > 8) continue;
    if (!d.issuerKeys.every((k) => typeof k === 'string' && KEY_RE.test(k))) continue;
    if (!isAcceptableStatusUrl(d.statusUrl)) continue;
    domains.set(name, { issuerKeys: d.issuerKeys.slice(), statusUrl: d.statusUrl });
  }
  return { state: 'ok', audience: raw.audience, domains, revokedModerators: new Set(revokedModerators), revokedGrants: new Set(revokedGrants) };
}
let configText = null;
let configValue = { state: 'missing' };
function loadConfig() {
  let text;
  try { text = fs.readFileSync(CONFIG_FILE, 'utf8'); } catch (_) { configText = null; configValue = { state: 'missing' }; return configValue; }
  if (text !== configText) { configText = text; configValue = parseConfig(text); }
  return configValue;
}

// ---------- grant and request verification ----------

async function verifyGrant(grant, opts) {
  const { payload, proof } = grant;
  if (!isObject(payload) || !isObject(proof)) return fail(400, 'bad-request', 'grant must be {payload, proof}');
  if (proof.signerRole !== 'raw-ecdsa') return fail(400, 'bad-request', 'proof.signerRole must be raw-ecdsa');
  if (!opts.issuerKeys.includes(proof.publicKey)) return fail(401, 'untrusted-issuer', 'the grant is not signed by a key trusted for this domain');
  if (!(await verifySig(proof.publicKey, proof.signature, GRANT_SIGN_CONTEXT, payload))) return fail(401, 'bad-signature', 'the grant signature does not verify');
  if (!hasKeys(payload, GRANT_FIELDS)) return fail(400, 'bad-request', 'the grant has missing or unknown fields');
  if (payload.type !== GRANT_TYPE || payload.version !== 1) return fail(400, 'bad-request', 'unsupported grant type or version');
  if (typeof payload.grantId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(payload.grantId)) return fail(400, 'bad-request', 'grantId');
  if (typeof payload.moderatorRef !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(payload.moderatorRef)) return fail(400, 'bad-request', 'moderatorRef');
  if (payload.domain !== opts.domain) return fail(403, 'wrong-domain', 'the grant is for another domain');
  if (payload.audience !== opts.audience) return fail(403, 'wrong-audience', 'the grant is for another presence service');
  const issuedAt = strictIso(payload.issuedAt), expiresAt = strictIso(payload.expiresAt);
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) return fail(400, 'bad-request', 'issuedAt/expiresAt');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_GRANT_LIFETIME_MS) return fail(400, 'bad-request', 'the grant lifetime is out of range');
  if (opts.now >= expiresAt) return fail(401, 'expired', 'the grant has expired');
  if (issuedAt > opts.now + CLOCK_SKEW_MS) return fail(401, 'not-yet-valid', 'the grant is issued in the future');
  if (payload.worlds !== '*') {
    if (!Array.isArray(payload.worlds) || payload.worlds.length < 1 || payload.worlds.length > MAX_WORLDS || !payload.worlds.every(isValidWorldId) || new Set(payload.worlds).size !== payload.worlds.length) return fail(400, 'bad-request', 'worlds');
  }
  if (!Array.isArray(payload.operations) || payload.operations.length < 1 || payload.operations.length > OPERATIONS.length || !payload.operations.every((o) => OPERATIONS.includes(o)) || new Set(payload.operations).size !== payload.operations.length) return fail(400, 'bad-request', 'operations');
  if (!isObject(payload.cnf) || !hasKeys(payload.cnf, ['alg', 'publicKey']) || payload.cnf.alg !== 'ES256' || !(await importRaw(payload.cnf.publicKey))) return fail(400, 'bad-request', 'cnf');
  return { ok: true, payload, expiresAt };
}

// The request is {payload, signature}: the moderator's command, signed by the
// grant's ephemeral key. `operation` is the one this request names, already
// checked against what the endpoint implements.
async function verifyRequest(grantPayload, grantExpiresAt, envelope, operation, now) {
  if (!isObject(envelope) || !isObject(envelope.payload)) return fail(400, 'bad-request', 'request must be {payload, signature}');
  const r = envelope.payload;
  if (!hasKeys(r, REQUEST_FIELDS, REQUEST_OPTIONAL_FIELDS)) return fail(400, 'bad-request', 'the request has missing or unknown fields');
  if (r.type !== REQUEST_TYPE || r.version !== 1) return fail(400, 'bad-request', 'unsupported request type or version');
  if (r.grantId !== grantPayload.grantId) return fail(401, 'wrong-grant', 'the request names another grant');
  if (r.audience !== grantPayload.audience || r.domain !== grantPayload.domain) return fail(403, 'wrong-audience', 'the request is bound to another audience or domain');
  if (r.operation !== operation || !grantPayload.operations.includes(operation)) return fail(403, 'operation-denied', 'the operation is not granted');
  if (!isValidWorldId(r.world)) return fail(400, 'bad-request', 'world');
  if (grantPayload.worlds !== '*' && !grantPayload.worlds.includes(r.world)) return fail(403, 'world-denied', 'the world is not granted');
  if (typeof r.target !== 'string' || r.target.length > 256) return fail(400, 'bad-request', 'target');
  const at = strictIso(r.issuedAt);
  if (Number.isNaN(at) || Math.abs(now - at) > REQUEST_WINDOW_MS) return fail(401, 'stale-request', 'the request timestamp is outside the allowed window');
  if (typeof r.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(r.nonce)) return fail(400, 'bad-request', 'nonce');
  if (!(await verifySig(grantPayload.cnf.publicKey, envelope.signature, POP_SIGN_CONTEXT, r))) return fail(401, 'bad-pop', 'proof of possession does not verify');
  return { ok: true, request: r };
}

// ---------- issuer status statements ----------

async function verifyStatus(env, opts) {
  if (!isObject(env) || !isObject(env.payload) || !isObject(env.proof)) return null;
  const { payload, proof } = env;
  if (proof.signerRole !== 'raw-ecdsa' || !opts.issuerKeys.includes(proof.publicKey)) return null;
  if (!(await verifySig(proof.publicKey, proof.signature, STATUS_SIGN_CONTEXT, payload))) return null;
  if (!hasKeys(payload, STATUS_FIELDS) || payload.type !== STATUS_TYPE || payload.version !== 1) return null;
  if (payload.domain !== opts.domain || payload.audience !== opts.audience) return null;
  const issuedAt = strictIso(payload.issuedAt), expiresAt = strictIso(payload.expiresAt);
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) return null;
  const ttl = expiresAt - issuedAt;
  if (ttl <= 0 || ttl > STATUS_MAX_TTL_MS) return null;
  // A statement older than the allowance when it arrives is a replay.
  if (issuedAt < opts.sentAt - CLOCK_SKEW_MS || issuedAt > opts.receivedAt + CLOCK_SKEW_MS) return null;
  if (!Array.isArray(payload.moderators) || payload.moderators.length > 2000) return null;
  const moderators = new Map();
  for (const m of payload.moderators) {
    if (!isObject(m) || !hasKeys(m, ['moderatorRef', 'worlds', 'operations'])) return null;
    if (typeof m.moderatorRef !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(m.moderatorRef) || moderators.has(m.moderatorRef)) return null;
    if (m.worlds !== '*' && (!Array.isArray(m.worlds) || m.worlds.length > 256 || !m.worlds.every(isValidWorldId))) return null;
    if (!Array.isArray(m.operations) || m.operations.length > OPERATIONS.length || !m.operations.every((o) => OPERATIONS.includes(o))) return null;
    moderators.set(m.moderatorRef, { worlds: m.worlds, operations: m.operations });
  }
  // Usable for its signed lifetime, counted from when this service ASKED, so
  // the issuer's clock cannot stretch it.
  const usableUntil = Math.min(expiresAt, opts.sentAt + ttl);
  if (opts.receivedAt >= usableUntil) return null;
  return { signerKey: proof.publicKey, issuedAt, sentAt: opts.sentAt, usableUntil, moderators };
}

async function readCapped(res, max) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { try { await reader.cancel(); } catch (_) {} throw new Error('too large'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchStatus(domain, dom, audience) {
  const url = new URL(dom.statusUrl);
  url.searchParams.set('audience', audience);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  const sentAt = Date.now();
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'manual', headers: { accept: 'application/json' } });
    if (res.status !== 200) { try { await res.body.cancel(); } catch (_) {} return null; }
    const text = await readCapped(res, STATUS_MAX_BYTES);
    const receivedAt = Date.now();
    const verified = await verifyStatus(JSON.parse(text), { issuerKeys: dom.issuerKeys, audience, domain, sentAt, receivedAt });
    return verified ? Object.assign(verified, { statusUrl: dom.statusUrl, audience }) : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const statusCache = new Map(); // domain -> verified statement
const statusInflight = new Map(); // domain + url -> Promise
function statementUsable(e, dom, audience, now) {
  return !!e && now < e.usableUntil && dom.issuerKeys.includes(e.signerKey) && e.statusUrl === dom.statusUrl && e.audience === audience;
}
// The statement to use for this request, or null when no current one exists
// (the caller must then refuse). A new statement is fetched whenever the cached
// one is older than STATUS_REFRESH_MS. If the fetch fails, the cached one is
// used only until its own expiry, never beyond.
async function currentStatus(domain, dom, audience) {
  const cached = statusCache.get(domain);
  if (statementUsable(cached, dom, audience, Date.now()) && Date.now() - cached.sentAt < STATUS_REFRESH_MS) return cached;
  const key = domain + '\n' + dom.statusUrl;
  let p = statusInflight.get(key);
  if (!p) {
    p = fetchStatus(domain, dom, audience).finally(() => statusInflight.delete(key));
    statusInflight.set(key, p);
  }
  const fresh = await p;
  if (fresh) { statusCache.set(domain, fresh); return fresh; }
  return statementUsable(cached, dom, audience, Date.now()) ? cached : null;
}

// ---------- replay protection ----------

const spentNonces = new Map(); // grantId -> {until, nonces:Set}
// Records (grantId, nonce) as used. Returns 'ok', 'replay' or 'busy'. Entries
// live until the grant has expired and every request it could still verify has
// fallen out of the request window.
function spendNonce(grantId, nonce, grantExpiresAt, now) {
  if (spentNonces.size >= MAX_TRACKED_GRANTS / 2) {
    spentNonces.forEach((e, id) => { if (e.until <= now) spentNonces.delete(id); });
  }
  let e = spentNonces.get(grantId);
  if (!e) {
    if (spentNonces.size >= MAX_TRACKED_GRANTS) return 'busy';
    e = { until: grantExpiresAt + REQUEST_WINDOW_MS, nonces: new Set() };
    spentNonces.set(grantId, e);
  }
  if (e.nonces.has(nonce)) return 'replay';
  if (e.nonces.size >= MAX_NONCES_PER_GRANT) return 'busy';
  e.nonces.add(nonce);
  return 'ok';
}

// ---------- failed-request throttle, per network source ----------

const failures = new Map(); // src -> ms timestamps
function failureRetryAfter(src, now) {
  const kept = (failures.get(src) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  if (kept.length) failures.set(src, kept); else failures.delete(src);
  if (kept.length < FAIL_MAX) return 0;
  return Math.max(1, Math.ceil((kept[0] + FAIL_WINDOW_MS - now) / 1000));
}
function noteFailure(src, now) {
  const hits = failures.get(src) || [];
  hits.push(now);
  failures.delete(src);
  failures.set(src, hits);
  while (failures.size > MAX_FAIL_SOURCES) failures.delete(failures.keys().next().value);
}

// ---------- command arguments ----------

// Fixed vocabulary of reasons a moderator may give. The visitor sees only the
// templated text for the code (lib-restrictions.js); nothing free-form from a
// moderator ever reaches a visitor, and no reason is stored beyond the
// restriction itself.
const CAUSES = ['spam', 'abuse', 'harassment', 'inappropriate', 'disruption', 'other'];
const TARGET_RE = /^[A-Za-z0-9_-]{22}$/;
const COMMANDS = {
  'chat.mute': { defaultS: MUTE_DEFAULT_S, maxS: MUTE_MAX_S, params: true },
  'chat.unmute': { params: false },
  'session.kick': { defaultS: KICK_DEFAULT_S, maxS: KICK_MAX_S, params: true }
};

// Checks the target and params of a request for `operation`. Returns
// {ok:true, command:{target, durationSeconds, cause}} for a command,
// {ok:true} for roster.view, or a failure (a 400, before anything is spent).
function checkArguments(operation, r) {
  if (operation === 'roster.view') {
    if (r.target !== '') return fail(400, 'bad-request', 'target must be empty for ' + operation);
    if ('params' in r) return fail(400, 'bad-request', 'params are not accepted for ' + operation);
    return { ok: true };
  }
  const rule = COMMANDS[operation];
  if (!rule) return fail(403, 'operation-denied', 'the operation is not implemented here');
  if (typeof r.target !== 'string' || !TARGET_RE.test(r.target)) return fail(400, 'bad-request', 'target must be a participant reference');
  let durationSeconds = rule.defaultS || null, cause = 'other';
  if ('params' in r) {
    const p = r.params;
    if (!rule.params || !isObject(p) || Object.keys(p).length < 1) return fail(400, 'bad-request', 'params are not accepted for ' + operation);
    if (Object.keys(p).some((k) => k !== 'durationSeconds' && k !== 'cause')) return fail(400, 'bad-request', 'unknown params member');
    if ('durationSeconds' in p) {
      if (!Number.isInteger(p.durationSeconds) || p.durationSeconds < 1 || p.durationSeconds > rule.maxS) return fail(400, 'bad-request', 'durationSeconds must be an integer from 1 to ' + rule.maxS);
      durationSeconds = p.durationSeconds;
    }
    if ('cause' in p) {
      if (typeof p.cause !== 'string' || !CAUSES.includes(p.cause)) return fail(400, 'bad-request', 'cause must be one of: ' + CAUSES.join(', '));
      cause = p.cause;
    }
  }
  return { ok: true, command: { target: r.target, durationSeconds, cause } };
}

// ---------- command rate limit, per moderator ----------

const commandHits = new Map(); // moderatorRef -> ms timestamps
const MAX_COMMAND_MODERATORS = 5000;
function commandRetryAfter(moderatorRef, now) {
  const kept = (commandHits.get(moderatorRef) || []).filter((t) => now - t < COMMAND_WINDOW_MS);
  if (kept.length) commandHits.set(moderatorRef, kept); else commandHits.delete(moderatorRef);
  if (kept.length < COMMANDS_PER_MIN) return 0;
  return Math.max(1, Math.ceil((kept[0] + COMMAND_WINDOW_MS - now) / 1000));
}
function noteCommand(moderatorRef, now) {
  const hits = commandHits.get(moderatorRef) || [];
  hits.push(now);
  commandHits.delete(moderatorRef);
  commandHits.set(moderatorRef, hits);
  while (commandHits.size > MAX_COMMAND_MODERATORS) commandHits.delete(commandHits.keys().next().value);
}

// ---------- the entry point ----------

// body: {grant, request}. opts: {operations}, the operations the calling
// endpoint implements. Returns {ok:true, domain, world, operation, command?,
// grantId, moderatorRef} or {ok:false, status, code, message}.
async function authorize(body, opts) {
  const now = Date.now();
  const cfg = loadConfig();
  if (cfg.state !== 'ok') return fail(503, 'moderation-not-configured', 'moderation is not enabled on this presence service');
  if (!isObject(body) || !hasKeys(body, ['grant', 'request']) || !isObject(body.grant) || !isObject(body.request)) return fail(400, 'bad-request', 'body must be {grant, request}');
  const claimed = body.grant.payload;
  if (!isObject(claimed) || typeof claimed.domain !== 'string') return fail(400, 'bad-request', 'the grant has no domain');
  const dom = cfg.domains.get(claimed.domain);
  if (!dom) return fail(403, 'domain-not-configured', 'this presence service does not accept moderation for that domain');

  const g = await verifyGrant(body.grant, { issuerKeys: dom.issuerKeys, audience: cfg.audience, domain: claimed.domain, now });
  if (!g.ok) return g;
  if (cfg.revokedGrants.has(g.payload.grantId) || cfg.revokedModerators.has(g.payload.moderatorRef)) return fail(403, 'revoked', 'this grant or moderator has been revoked here');

  // The operation is the one the (signed) request names, provided this
  // endpoint implements it; verifyRequest then requires the grant to hold it.
  const named = isObject(body.request.payload) ? body.request.payload.operation : undefined;
  const operation = typeof named === 'string' && opts.operations.includes(named) ? named : opts.operations[0];
  const r = await verifyRequest(g.payload, g.expiresAt, body.request, operation, now);
  if (!r.ok) return r;
  const args = checkArguments(operation, r.request);
  if (!args.ok) return args;

  const status = await currentStatus(claimed.domain, dom, cfg.audience);
  if (!status) return fail(503, 'authorization-unavailable', 'the issuer\'s current authorization status could not be established');
  const entry = status.moderators.get(g.payload.moderatorRef);
  if (!entry) return fail(403, 'moderator-inactive', 'the issuer does not list this moderator as active');
  if (!entry.operations.includes(operation)) return fail(403, 'operation-denied', 'the operation is not currently permitted');
  if (entry.worlds !== '*' && !entry.worlds.includes(r.request.world)) return fail(403, 'world-denied', 'the world is not currently permitted');

  // A command over the moderator's rate is refused before its nonce is spent,
  // so it can be sent again unchanged once the window has passed.
  if (args.command) {
    const wait = commandRetryAfter(g.payload.moderatorRef, now);
    if (wait) return Object.assign(fail(429, 'rate-limited', 'too many moderation commands; try again shortly'), { retryAfter: wait });
  }
  const spent = spendNonce(g.payload.grantId, r.request.nonce, g.expiresAt, now);
  if (spent === 'replay') return fail(401, 'replay', 'this request has already been used');
  if (spent === 'busy') return fail(429, 'rate-limited', 'too many requests for this grant');
  if (args.command) noteCommand(g.payload.moderatorRef, now);
  return { ok: true, domain: claimed.domain, world: r.request.world, operation, command: args.command || null, grantId: g.payload.grantId, moderatorRef: g.payload.moderatorRef };
}

// ---------- per-visit association and temporary references ----------
//
// A wallet sends one random visit id per world visit, privately, to both the
// presence join and the chat join. The server keeps only a keyed hash of it,
// scoped to the domain and world, so a roster can show the two sessions as one
// visitor without any stored identifier that could be matched to a wallet, a
// network address or another visit. Both keys live in memory and change at
// restart.

const VISIT_KEY = crypto.randomBytes(32);
const REF_KEY = crypto.randomBytes(32);
function visitHash(domain, world, raw) {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(raw)) return null;
  return crypto.createHmac('sha256', VISIT_KEY).update('visit/v1\n' + domain + '\n' + world + '\n' + raw).digest('hex').slice(0, 32);
}
// A temporary locator for one roster entry. It is derived from a secret that
// only this process holds, authorizes nothing, and means nothing outside
// this domain and world.
function participantRef(domain, world, groupKey) {
  return crypto.createHmac('sha256', REF_KEY).update('ref/v1\n' + domain + '\n' + world + '\n' + groupKey).digest('base64url').slice(0, 22);
}

module.exports = {
  authorize, visitHash, participantRef, failureRetryAfter, noteFailure,
  isValidWorldId, canonicalize, OPERATIONS, CAUSES, loadConfig
};
