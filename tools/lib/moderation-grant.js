// Reference verifier for moderation grants (docs/moderation-authorization.md).
// Zero dependencies. It is the executable form of the wire format: the issuer
// tests verify grants from both the Node and the PHP issuer with it, and a
// presence service must implement the same checks (the PHP presence bundle
// needs a port of this file before it can accept grants).
//
//   verifyGrant(grantEnvelope, {issuerKeys, audience, domain, now})
//       -> {ok:true, payload} | {ok:false, code, message}
//   verifyRequest(grantPayload, requestEnvelope, {world, operation, now})
//       -> {ok:true, request} | {ok:false, code, message}
//
// Replay of a request nonce is the caller's job (a per-grant set of spent
// nonces that lives as long as the grant); createNonceLedger() is a minimal one.
const { webcrypto, createHash } = require('crypto');
const { subtle } = webcrypto;

const GRANT_TYPE = 'atlas.moderation-grant';
const REQUEST_TYPE = 'atlas.moderation-request';
const GRANT_SIGN_CONTEXT = 'atlas-moderation-grant/v1\n';
const POP_SIGN_CONTEXT = 'atlas-moderation-pop/v1\n';
const STATUS_TYPE = 'atlas.moderation-status';
const STATUS_SIGN_CONTEXT = 'atlas-moderation-status/v1\n';
const STATUS_FIELDS = ['type', 'version', 'domain', 'audience', 'issuedAt', 'expiresAt', 'moderators'];
const STATUS_MAX_TTL_MS = 120 * 1000;
const REF_CONTEXT = 'atlas-moderator-ref/v1\n';
const OPERATIONS = ['roster.view', 'chat.mute', 'session.kick', 'session.timeout'];
const MAX_GRANT_LIFETIME_MS = 600 * 1000;
const MAX_WORLDS = 32;
const REQUEST_SKEW_MS = 60 * 1000;
const ISSUE_SKEW_MS = 30 * 1000;

const GRANT_FIELDS = ['type', 'version', 'grantId', 'domain', 'audience', 'moderatorRef', 'worlds', 'operations', 'issuedAt', 'expiresAt', 'cnf'];
const REQUEST_FIELDS = ['type', 'version', 'grantId', 'audience', 'domain', 'world', 'operation', 'target', 'issuedAt', 'nonce'];

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (code, message) => ({ ok: false, code, message });

// World ids: 1-120 code points, no control characters or line separators, no
// leading or trailing white space. Same rule as the issuers.
const FORBIDDEN = /[\u0000-\u001f\u007f\u2028\u2029]/u;
const EDGE_SPACE = /^[\s﻿]|[\s﻿]$/u;
function isValidWorldId(w) {
  if (typeof w !== 'string' || w.length === 0 || w.length > 480) return false;
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(w)) return false; // lone surrogate
  const n = Array.from(w).length;
  return n >= 1 && n <= 120 && !FORBIDDEN.test(w) && !EDGE_SPACE.test(w);
}

function strictIso(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)) return NaN;
  const t = Date.parse(s);
  return Number.isFinite(t) && new Date(t).toISOString() === s ? t : NaN;
}

async function importRaw(b64) {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(b64)) return null;
  const raw = Buffer.from(b64, 'base64url');
  if (raw.length !== 65 || raw[0] !== 0x04 || b64url(raw) !== b64) return null;
  try { return await subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']); } catch (_) { return null; }
}
async function verifySig(publicKeyB64, signatureB64, context, payload) {
  const key = await importRaw(publicKeyB64);
  if (!key || typeof signatureB64 !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signatureB64)) return false;
  const sig = Buffer.from(signatureB64, 'base64url');
  if (sig.length !== 64) return false;
  const data = Buffer.concat([Buffer.from(context, 'utf8'), Buffer.from(canonicalize(payload), 'utf8')]);
  try { return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data); } catch (_) { return false; }
}

function moderatorRef(domain, publicKey) {
  return createHash('sha256').update(REF_CONTEXT + domain + '\n' + publicKey).digest('base64url');
}

// Verifies the issuer's signature and every claim a presence service relies on.
// opts.issuerKeys: the issuer public keys pinned for opts.domain (never
// fetched from the network). opts.audience: this presence service's own
// configured origin. opts.now: ms, defaults to the current time.
async function verifyGrant(grant, opts) {
  const now = opts.now === undefined ? Date.now() : opts.now;
  if (!isObject(grant) || !isObject(grant.payload) || !isObject(grant.proof)) return fail('malformed', 'grant must be {payload, proof}');
  const { payload, proof } = grant;
  if (proof.signerRole !== 'raw-ecdsa') return fail('malformed', 'proof.signerRole must be raw-ecdsa');
  if (!Array.isArray(opts.issuerKeys) || !opts.issuerKeys.includes(proof.publicKey)) return fail('untrusted-issuer', 'signing key is not pinned for this domain');
  if (!(await verifySig(proof.publicKey, proof.signature, GRANT_SIGN_CONTEXT, payload))) return fail('bad-signature', 'grant signature does not verify');
  const keys = Object.keys(payload);
  if (keys.length !== GRANT_FIELDS.length || !GRANT_FIELDS.every((k) => keys.includes(k))) return fail('malformed', 'grant payload has missing or unknown fields');
  if (payload.type !== GRANT_TYPE || payload.version !== 1) return fail('malformed', 'unsupported grant type or version');
  if (typeof payload.grantId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(payload.grantId)) return fail('malformed', 'grantId');
  if (typeof payload.moderatorRef !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(payload.moderatorRef)) return fail('malformed', 'moderatorRef');
  if (payload.domain !== opts.domain) return fail('wrong-domain', 'grant is for another domain');
  if (payload.audience !== opts.audience) return fail('wrong-audience', 'grant is for another presence service');
  const issuedAt = strictIso(payload.issuedAt), expiresAt = strictIso(payload.expiresAt);
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) return fail('malformed', 'issuedAt/expiresAt');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_GRANT_LIFETIME_MS) return fail('malformed', 'lifetime out of range');
  if (now >= expiresAt) return fail('expired', 'grant has expired');
  if (issuedAt > now + ISSUE_SKEW_MS) return fail('not-yet-valid', 'grant is issued in the future');
  if (payload.worlds !== '*') {
    if (!Array.isArray(payload.worlds) || payload.worlds.length < 1 || payload.worlds.length > MAX_WORLDS || !payload.worlds.every(isValidWorldId) || new Set(payload.worlds).size !== payload.worlds.length) return fail('malformed', 'worlds');
  }
  if (!Array.isArray(payload.operations) || payload.operations.length < 1 || payload.operations.length > OPERATIONS.length || !payload.operations.every((o) => OPERATIONS.includes(o)) || new Set(payload.operations).size !== payload.operations.length) return fail('malformed', 'operations');
  if (!isObject(payload.cnf) || Object.keys(payload.cnf).length !== 2 || payload.cnf.alg !== 'ES256' || !(await importRaw(payload.cnf.publicKey))) return fail('malformed', 'cnf');
  return { ok: true, payload };
}

// Verifies an issuer-signed status statement (the current allow-list of
// moderators). opts: {issuerKeys, audience, domain, now, maxTtlMs?}. Returns
// {ok, payload, moderators: Map(ref -> {worlds, operations})}. A presence
// service must additionally bound how long it relies on a statement; see
// docs/moderation-authorization.md.
async function verifyStatus(env, opts) {
  const now = opts.now === undefined ? Date.now() : opts.now;
  if (!isObject(env) || !isObject(env.payload) || !isObject(env.proof)) return fail('malformed', 'status must be {payload, proof}');
  const { payload, proof } = env;
  if (proof.signerRole !== 'raw-ecdsa') return fail('malformed', 'proof.signerRole must be raw-ecdsa');
  if (!Array.isArray(opts.issuerKeys) || !opts.issuerKeys.includes(proof.publicKey)) return fail('untrusted-issuer', 'signing key is not pinned for this domain');
  if (!(await verifySig(proof.publicKey, proof.signature, STATUS_SIGN_CONTEXT, payload))) return fail('bad-signature', 'status signature does not verify');
  const keys = Object.keys(payload);
  if (keys.length !== STATUS_FIELDS.length || !STATUS_FIELDS.every((k) => keys.includes(k))) return fail('malformed', 'status payload has missing or unknown fields');
  if (payload.type !== STATUS_TYPE || payload.version !== 1) return fail('malformed', 'unsupported status type or version');
  if (payload.domain !== opts.domain) return fail('wrong-domain', 'status is for another domain');
  if (payload.audience !== opts.audience) return fail('wrong-audience', 'status is for another presence service');
  const issuedAt = strictIso(payload.issuedAt), expiresAt = strictIso(payload.expiresAt);
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) return fail('malformed', 'issuedAt/expiresAt');
  if (expiresAt <= issuedAt || expiresAt - issuedAt > (opts.maxTtlMs || STATUS_MAX_TTL_MS)) return fail('malformed', 'lifetime out of range');
  if (now >= expiresAt) return fail('expired', 'status has expired');
  if (issuedAt > now + ISSUE_SKEW_MS) return fail('not-yet-valid', 'status is issued in the future');
  if (!Array.isArray(payload.moderators)) return fail('malformed', 'moderators');
  const moderators = new Map();
  for (const m of payload.moderators) {
    if (!isObject(m) || Object.keys(m).length !== 3 || typeof m.moderatorRef !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(m.moderatorRef) || moderators.has(m.moderatorRef)) return fail('malformed', 'moderator entry');
    if (m.worlds !== '*' && !(Array.isArray(m.worlds) && m.worlds.length >= 1 && m.worlds.length <= MAX_WORLDS && m.worlds.every(isValidWorldId))) return fail('malformed', 'moderator worlds');
    if (!Array.isArray(m.operations) || !m.operations.length || !m.operations.every((o) => OPERATIONS.includes(o))) return fail('malformed', 'moderator operations');
    moderators.set(m.moderatorRef, { worlds: m.worlds, operations: m.operations });
  }
  return { ok: true, payload, moderators };
}

// --- proof of possession ---

async function generatePopKey() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { privateKey: kp.privateKey, publicKey: b64url(new Uint8Array(await subtle.exportKey('raw', kp.publicKey))) };
}
async function signRequest(popPrivateKey, request) {
  const data = Buffer.concat([Buffer.from(POP_SIGN_CONTEXT, 'utf8'), Buffer.from(canonicalize(request), 'utf8')]);
  return { payload: request, signature: b64url(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, popPrivateKey, data))) };
}

// grantPayload must already have passed verifyGrant. opts: {world, operation,
// now, ledger?}. ledger (createNonceLedger) makes the nonce single-use.
async function verifyRequest(grantPayload, envelope, opts) {
  const now = opts.now === undefined ? Date.now() : opts.now;
  if (!isObject(envelope) || !isObject(envelope.payload)) return fail('malformed', 'request must be {payload, signature}');
  const r = envelope.payload;
  const keys = Object.keys(r);
  if (keys.length !== REQUEST_FIELDS.length || !REQUEST_FIELDS.every((k) => keys.includes(k))) return fail('malformed', 'request has missing or unknown fields');
  if (r.type !== REQUEST_TYPE || r.version !== 1) return fail('malformed', 'unsupported request type or version');
  if (now >= strictIso(grantPayload.expiresAt)) return fail('expired', 'grant has expired');
  if (r.grantId !== grantPayload.grantId) return fail('wrong-grant', 'request names another grant');
  if (r.audience !== grantPayload.audience || r.domain !== grantPayload.domain) return fail('wrong-audience', 'request is bound to another audience or domain');
  if (!grantPayload.operations.includes(r.operation) || r.operation !== opts.operation) return fail('operation-denied', 'operation is not granted');
  if (!isValidWorldId(r.world) || r.world !== opts.world || (grantPayload.worlds !== '*' && !grantPayload.worlds.includes(r.world))) return fail('world-denied', 'world is not granted');
  if (typeof r.target !== 'string' || r.target.length > 256) return fail('malformed', 'target');
  const at = strictIso(r.issuedAt);
  if (Number.isNaN(at) || Math.abs(now - at) > REQUEST_SKEW_MS) return fail('stale-request', 'request timestamp outside the allowed window');
  if (typeof r.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(r.nonce)) return fail('malformed', 'nonce');
  if (!(await verifySig(grantPayload.cnf.publicKey, envelope.signature, POP_SIGN_CONTEXT, r))) return fail('bad-pop', 'proof of possession does not verify');
  if (opts.ledger && !opts.ledger.spend(r.grantId, r.nonce, strictIso(grantPayload.expiresAt))) return fail('replay', 'request nonce already used');
  return { ok: true, request: r };
}

function createNonceLedger() {
  const spent = new Map();
  return {
    spend(grantId, nonce, expiresAt) {
      const k = grantId + '\n' + nonce;
      for (const [key, exp] of spent) if (exp < Date.now()) spent.delete(key);
      if (spent.has(k)) return false;
      spent.set(k, expiresAt + REQUEST_SKEW_MS);
      return true;
    }
  };
}

module.exports = {
  GRANT_TYPE, REQUEST_TYPE, STATUS_TYPE, GRANT_SIGN_CONTEXT, POP_SIGN_CONTEXT, STATUS_SIGN_CONTEXT, REF_CONTEXT, OPERATIONS, MAX_GRANT_LIFETIME_MS,
  canonicalize, isValidWorldId, moderatorRef, verifyGrant, verifyStatus, verifyRequest, generatePopKey, signRequest, createNonceLedger
};
