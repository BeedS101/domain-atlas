// EXPERIMENTAL issuer-signed ledger-account references (domain-atlas-ledger-account/1.0).
// Off unless <state folder>/atlas-ledger-issuance-config.json says {"enabled": true}. Mirrors
// issuer-php/lib/ledger-issuance.php; both answer POST /atlas/ledger/account-credential with the
// same status codes and bodies.
//
// The endpoint signs one thing: a reference saying "this owner key has an account in this coin on
// this domain's Labs 29 ledger". It signs it only after
//   1. the owner signed a fresh issuance request (raw P-256, audience = this exact URL), and
//   2. the ledger itself, asked with the owner's own signed Labs 31 listing request, returned that
//      account with the account ID this file derives independently.
// Nothing in the request is trusted as proof that the account exists, and the credential carries
// no balance. The signing key is the issuer's established key, handed in as `sign`; this file
// never creates or reads a key.
'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');
const { webcrypto, createHash } = require('crypto');
const { subtle } = webcrypto;

const HOSTS = ['evtec.co.za', 'domain-atlas.co.za'];
const NETWORK_PREFIX = 'chainblock-labs29-';
const CREDENTIAL = 'domain-atlas-ledger-account/1.0';
const ISSUE_TYPE = 'atlas.ledger.account.issue';
const ACCOUNTS_TYPE = 'atlas.ledger.accounts';
const MAX_BODY_BYTES = 8192;
const WINDOW_S = 120;
const NONCE_RETAIN_S = 600;
const NONCE_CAP = 20000;
const LOG_CAP = 500;
const CORE_MAX_BYTES = 65536;
const CORE_TIMEOUT_MS = 8000;

const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const ISO_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;

function strictB64url(s) {
  if (typeof s !== 'string' || !B64URL_RE.test(s)) return null;
  const bin = Buffer.from(s, 'base64url');
  return bin.toString('base64url') === s ? bin : null;
}
function point(s) {
  if (typeof s !== 'string' || s.length !== 87) return null;
  const bin = strictB64url(s);
  return bin && bin.length === 65 && bin[0] === 4 ? bin : null;
}
function isoSeconds(s) {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}
function exactKeys(o, keys) {
  return !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
}
const isoNow = (s) => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// `opts`: configFile, storeFile, keyDocFile, revocationsFile (paths), canonicalize(value),
// sign(payload) -> base64url signature, publicKey (the key sign() uses, base64url), now() -> ms.
function createLedgerIssuance(opts) {
  const now = opts.now || (() => Date.now());
  const canonicalize = opts.canonicalize;

  function readJsonFile(path) {
    try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch (e) { return null; }
  }

  function config() {
    const cfg = { enabled: false, problem: null, domain: null, coreBase: null, perClientPerMinute: 20, perOwnerPerHour: 10, globalPerHour: 300 };
    const f = readJsonFile(opts.configFile);
    if (!f || typeof f !== 'object' || f.enabled !== true) return cfg;
    cfg.enabled = true;
    if (typeof f.domain !== 'string' || !HOSTS.includes(f.domain)) { cfg.problem = 'domain must be one of the Labs 29 hosts'; return cfg; }
    cfg.domain = f.domain;
    if (f.coreBase !== undefined && f.coreBase !== null) {
      if (typeof f.coreBase !== 'string' || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(f.coreBase)) { cfg.problem = 'coreBase must be a loopback http address'; return cfg; }
      cfg.coreBase = f.coreBase;
    }
    for (const k of ['perClientPerMinute', 'perOwnerPerHour', 'globalPerHour']) {
      if (Number.isInteger(f[k]) && f[k] > 0) cfg[k] = f[k];
    }
    return cfg;
  }

  // A per-client sliding minute, in memory (a restart only relaxes it).
  const clientHits = new Map();
  function takeClientSlot(client, limit) {
    const t = now();
    const hits = (clientHits.get(client) || []).filter((h) => t - h < 60000);
    if (hits.length >= limit) { clientHits.set(client, hits); return Math.max(1, Math.ceil((hits[0] + 60000 - t) / 1000)); }
    hits.push(t);
    clientHits.delete(client);
    clientHits.set(client, hits);
    while (clientHits.size > 5000) clientHits.delete(clientHits.keys().next().value);
    return 0;
  }

  function readStore() {
    const d = readJsonFile(opts.storeFile);
    return { nonces: Array.isArray(d && d.nonces) ? d.nonces : [], issued: Array.isArray(d && d.issued) ? d.issued : [], log: Array.isArray(d && d.log) ? d.log : [] };
  }
  const writeStore = (doc) => fs.writeFileSync(opts.storeFile, JSON.stringify(doc));

  // The nonce is spent and the limits applied in one synchronous step, so two requests carrying the
  // same nonce cannot both pass.
  function admit(owner, nonce, nowS, cfg) {
    const doc = readStore();
    doc.nonces = doc.nonces.filter((n) => Array.isArray(n) && n.length === 2 && n[1] > nowS);
    doc.issued = doc.issued.filter((i) => Array.isArray(i) && i.length === 2 && nowS - i[1] < 3600);
    const key = createHash('sha256').update(owner + '|' + nonce).digest('hex');
    if (doc.nonces.some((n) => n[0] === key)) return 'replayed';
    if (doc.nonces.length >= NONCE_CAP) return 'full';
    const ownerHash = createHash('sha256').update(owner).digest('hex');
    if (doc.issued.filter((i) => i[0] === ownerHash).length >= cfg.perOwnerPerHour) return 'owner-limit';
    if (doc.issued.length >= cfg.globalPerHour) return 'global-limit';
    doc.nonces.push([key, nowS + NONCE_RETAIN_S]);
    doc.issued.push([ownerHash, nowS]);
    writeStore(doc);
    return 'ok';
  }
  function record(id, coin, nowS) {
    const doc = readStore();
    doc.log.push({ at: isoNow(nowS), id, coin });
    doc.log = doc.log.slice(-LOG_CAP);
    writeStore(doc);
  }

  function accountId(network, coin, owner) {
    return 'urn:atlas:ledger-account:' + createHash('sha256').update(canonicalize({ coin, network, owner, purpose: 'atlas.ledger.account-id', v: 1 })).digest('hex');
  }

  async function verifyRaw(payload, ownerKey, signature) {
    const pt = point(ownerKey);
    const sig = strictB64url(signature);
    if (!pt || !sig || sig.length !== 64) return false;
    try {
      const pub = await subtle.importKey('raw', pt, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, new TextEncoder().encode(canonicalize(payload)));
    } catch (e) { return false; }
  }

  // The established key only: the published key document must list the key sign() uses as valid now.
  function signingKeyUsable(nowS) {
    const doc = readJsonFile(opts.keyDocFile);
    return !!doc && Array.isArray(doc.keys) && doc.keys.some((k) => {
      if (!k || k.publicKey !== opts.publicKey) return false;
      const from = isoSeconds(k.validFrom);
      const until = k.validUntil ? isoSeconds(k.validUntil) : Infinity;
      return from !== null && until !== null && nowS >= from && nowS <= until;
    });
  }
  function isRevoked(id) {
    const doc = readJsonFile(opts.revocationsFile);
    return !!doc && Array.isArray(doc.revoked) && doc.revoked.some((r) => r && r.id === id);
  }

  // Asks the ledger. The address is built from the configured domain; the request carries only the
  // owner's own signed listing request, unchanged. No redirects, bounded time and size, and the
  // certificate is checked as Node does by default.
  function askCore(cfg, body) {
    const loopback = !!cfg.coreBase;
    const url = new URL((cfg.coreBase || ('https://' + cfg.domain)) + '/chain-labs/accounts31.php?action=accounts');
    const payload = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'DomainAtlas-Relay/1.0' };
    if (loopback) headers.Host = cfg.domain;
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const req = (loopback ? http : https).request({ protocol: url.protocol, hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, method: 'POST', headers, timeout: CORE_TIMEOUT_MS }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > CORE_MAX_BYTES) { req.destroy(); done(null); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          let json = null;
          try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); json = v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (e) { json = null; }
          done({ status: res.statusCode, json });
        });
        res.on('error', () => done(null));
      });
      req.on('timeout', () => { req.destroy(); done(null); });
      req.on('error', () => done(null));
      req.end(payload);
    });
  }

  const fail = (status, code, error, extra) => ({ status, body: Object.assign({ ok: false, code, error }, extra || {}) });

  // `req`: { method, host, secure, client, rawBody } -> { status, body, headers? }
  async function handle(req) {
    const cfg = config();
    if (!cfg.enabled) return fail(404, 'disabled', 'Ledger-account issuance is not enabled');
    if (cfg.problem) return fail(503, 'misconfigured', 'Ledger-account issuance is misconfigured');
    if (req.method !== 'POST') return fail(405, 'unknown-operation', 'POST only');
    if (!req.secure) return fail(403, 'https-required', 'HTTPS required');
    const domain = cfg.domain;
    if (String(req.host || '').toLowerCase() !== domain) return fail(400, 'unknown-host', 'This host does not issue for that domain');
    const network = NETWORK_PREFIX + domain;
    const operation = 'https://' + domain + '/atlas/ledger/account-credential';
    const accountsUrl = 'https://' + domain + '/chain-labs/accounts31.php?action=accounts';

    const retry = takeClientSlot(req.client || 'unknown', cfg.perClientPerMinute);
    if (retry) return Object.assign(fail(429, 'rate-limited', 'Too many requests'), { headers: { 'Retry-After': String(retry) } });

    if (Buffer.byteLength(req.rawBody || '') > MAX_BODY_BYTES) return fail(413, 'too-large', 'request body too large');
    let body;
    try { body = JSON.parse(req.rawBody); } catch (e) { body = null; }
    if (!exactKeys(body, ['payload', 'proof', 'existence'])) return fail(400, 'malformed-request', 'Expected payload, proof and existence');
    const p = body.payload, proof = body.proof, ex = body.existence;
    const intentFields = ['type', 'v', 'audience', 'network', 'coin', 'nonce', 'issuedAt', 'existenceNonce'];
    if (!exactKeys(p, intentFields) || !exactKeys(ex, ['payload', 'proof']) || !ex.proof || typeof ex.proof !== 'object') return fail(400, 'malformed-request', 'Unexpected fields');
    if (intentFields.some((f) => f !== 'v' && typeof p[f] !== 'string')) return fail(400, 'malformed-request', 'Unexpected field type');
    if (p.type !== ISSUE_TYPE || p.v !== 1) return fail(400, 'malformed-request', 'Wrong request type');
    if (p.audience !== operation) return fail(401, 'wrong-audience', 'Audience must be the exact issuance URL');
    if (p.network !== network) return fail(400, 'unknown-network', 'Wrong network');
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(p.coin)) return fail(400, 'malformed-request', 'Invalid coin');
    if (!/^[a-f0-9]{32,64}$/.test(p.nonce) || !/^[a-f0-9]{32,64}$/.test(p.existenceNonce)) return fail(400, 'malformed-request', 'Invalid nonce');
    const nowS = Math.floor(now() / 1000);
    const ts = isoSeconds(p.issuedAt);
    if (ts === null) return fail(400, 'malformed-request', 'Invalid timestamp');
    if (Math.abs(nowS - ts) > WINDOW_S) return fail(401, 'stale-request', 'Clock outside the two-minute window', { serverTime: isoNow(nowS) });

    // Only a raw P-256 owner proof is accepted: the ledger's own check cannot take a passkey assertion.
    if (!exactKeys(proof, ['signerRole', 'publicKey', 'signature']) || proof.signerRole !== 'raw-ecdsa' || !point(proof.publicKey) || !strictB64url(proof.signature)) {
      return fail(401, 'unsupported-proof', 'Only raw P-256 wallet proofs are supported');
    }
    const owner = proof.publicKey;
    if (!(await verifyRaw(p, owner, proof.signature))) return fail(401, 'bad-signature', 'Owner signature invalid');

    // The pair travels together: the listing request is the owner's, for this network, and named in the signed intent.
    const lp = ex.payload, lproof = ex.proof;
    const listFields = ['type', 'v', 'audience', 'network', 'nonce', 'issuedAt'];
    if (!exactKeys(lp, listFields) || !exactKeys(lproof, ['publicKey', 'signature'])) return fail(400, 'malformed-request', 'Unexpected listing request fields');
    if (listFields.some((f) => f !== 'v' && typeof lp[f] !== 'string')) return fail(400, 'malformed-request', 'Unexpected listing field type');
    if (lp.type !== ACCOUNTS_TYPE || lp.v !== 1 || lp.network !== network) return fail(400, 'malformed-request', 'Listing request is not for this network');
    if (lp.audience !== accountsUrl) return fail(401, 'wrong-audience', 'Listing audience must be the exact ledger URL');
    if (lp.nonce !== p.existenceNonce || lproof.publicKey !== owner) return fail(401, 'existence-proof-rejected', 'Listing request is not the one this request names');
    const lts = isoSeconds(lp.issuedAt);
    if (lts === null || Math.abs(nowS - lts) > WINDOW_S) return fail(401, 'stale-request', 'Listing request outside the two-minute window', { serverTime: isoNow(nowS) });
    if (!(await verifyRaw(lp, owner, lproof.signature))) return fail(401, 'bad-signature', 'Listing request signature invalid');

    if (!signingKeyUsable(nowS)) return fail(503, 'issuer-key-unavailable', 'The established issuer key is not available or not valid now');

    const coin = p.coin;
    const id = accountId(network, coin, owner);
    if (isRevoked(id)) return fail(409, 'account-revoked', 'This account reference has been revoked');

    const admitted = admit(owner, p.nonce, nowS, cfg);
    if (admitted === 'replayed') return fail(409, 'replayed-request', 'Signed request has already been used');
    if (admitted !== 'ok') return Object.assign(fail(admitted === 'full' ? 503 : 429, admitted === 'full' ? 'busy' : 'rate-limited', 'Issuance is limited right now'), { headers: { 'Retry-After': '60' } });

    const core = await askCore(cfg, { payload: lp, proof: lproof });
    if (!core || core.status >= 500 || core.status === 429 || !core.json) return fail(502, 'ledger-unavailable', 'The ledger could not be asked');
    const answer = core.json;
    if (core.status !== 200) {
      const code = typeof answer.code === 'string' ? answer.code : 'unknown';
      if (core.status === 401) return fail(401, 'existence-proof-rejected', 'The ledger refused the listing proof', { ledgerCode: code });
      return fail(502, 'ledger-refused', 'The ledger refused the listing request', { ledgerCode: code });
    }
    if (answer.ok !== true || answer.code !== 'accounts-found' || answer.network !== network || answer.ownerKey !== owner || !Array.isArray(answer.accounts)) {
      return fail(502, 'ledger-mismatch', 'The ledger answered for a different network or owner');
    }
    const matches = answer.accounts.filter((a) => a && typeof a === 'object' && a.coin === coin);
    if (matches.length > 1) return fail(502, 'ledger-mismatch', 'The ledger listed one coin twice');
    if (matches.length === 0) return fail(404, 'account-not-found', 'The ledger has no account for this owner and coin');
    const found = matches[0];
    if (found.ownerKey !== owner || found.network !== network || found.accountId !== id) {
      return fail(502, 'ledger-mismatch', 'The ledger\'s account does not match the derived account ID');
    }

    const issuedAt = isoNow(nowS);
    const credential = {
      credential: CREDENTIAL,
      id,
      issuer: { domain, publicKey: opts.publicKey },
      ledger: { network, coin },
      owner: { publicKey: owner },
      issuedAt
    };
    credential.signature = await opts.sign({ id, ledger: credential.ledger, owner: credential.owner, issuedAt });
    record(id, coin, nowS);
    return { status: 200, body: { ok: true, code: 'credential-issued', credential } };
  }

  return { handle, config, accountId };
}

module.exports = { createLedgerIssuance, HOSTS, NETWORK_PREFIX };
