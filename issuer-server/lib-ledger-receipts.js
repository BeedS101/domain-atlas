// EXPERIMENTAL signed ledger balance receipts (chainblock-ledger38/signed-receipt-experimental).
// A TEST MIRROR of issuer-php/lib/ledger-receipts.php: same status codes, same bodies, same
// signed bytes. It is not wired into server.js, so the Node issuer serves no receipt route; the
// tests drive it directly and over a small test-only HTTP front.
//
// The balance comes from `readBalance(domain, coin, ownerKey)`, which the caller injects. It must
// only read and return
//   { status: 'ok', coinId, decimals, amount }   amount: decimal string of minor units
//   { status: 'no-coin' } | { status: 'no-account' } | { status: 'unavailable' }
// `sqliteReader(privateDir)` is a read-only reader over the two Labs 29 databases.
'use strict';
const fs = require('fs');
const path = require('path');
const { webcrypto, createHash } = require('crypto');
const { subtle } = webcrypto;

const HOSTS = ['evtec.co.za', 'domain-atlas.co.za'];
const NETWORK_PREFIX = 'chainblock-labs29-';
const CONTRACT = 'chainblock-ledger38/signed-receipt-experimental';
const REQUEST_TYPE = 'atlas.ledger.balance-receipt.request';
const RECEIPT_TYPE = 'atlas.ledger.balance-receipt';
const MAX_BODY_BYTES = 4096;
const WINDOW_S = 120;
const NONCE_RETAIN_S = 600;
const NONCE_CAP = 20000;
const LOG_CAP = 500;
const MAX_DECIMALS = 18;

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
// sign(payload) -> base64url signature, publicKey (the key sign() uses, base64url),
// readBalance(domain, coin, ownerKey), now() -> ms.
function createLedgerReceipts(opts) {
  const now = opts.now || (() => Date.now());
  const canonicalize = opts.canonicalize;

  function readJsonFile(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  }

  function config() {
    const cfg = { enabled: false, problem: null, domain: null, perClientPerMinute: 30, perOwnerPerHour: 60, globalPerHour: 600 };
    const f = readJsonFile(opts.configFile);
    if (!f || typeof f !== 'object' || f.enabled !== true) return cfg;
    cfg.enabled = true;
    if (typeof f.domain !== 'string' || !HOSTS.includes(f.domain)) { cfg.problem = 'domain must be one of the Labs 29 hosts'; return cfg; }
    cfg.domain = f.domain;
    for (const k of ['perClientPerMinute', 'perOwnerPerHour', 'globalPerHour']) {
      if (Number.isInteger(f[k]) && f[k] > 0) cfg[k] = f[k];
    }
    return cfg;
  }

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
    return {
      nonces: Array.isArray(d && d.nonces) ? d.nonces : [],
      served: Array.isArray(d && d.served) ? d.served : [],
      coins: d && d.coins && typeof d.coins === 'object' && !Array.isArray(d.coins) ? d.coins : {},
      log: Array.isArray(d && d.log) ? d.log : []
    };
  }
  const writeStore = (doc) => fs.writeFileSync(opts.storeFile, JSON.stringify(doc));

  function admit(owner, nonce, nowS, cfg) {
    const doc = readStore();
    doc.nonces = doc.nonces.filter((n) => Array.isArray(n) && n.length === 2 && n[1] > nowS);
    doc.served = doc.served.filter((i) => Array.isArray(i) && i.length === 2 && nowS - i[1] < 3600);
    const key = createHash('sha256').update(owner + '|' + nonce).digest('hex');
    if (doc.nonces.some((n) => n[0] === key)) return 'replayed';
    if (doc.nonces.length >= NONCE_CAP) return 'full';
    const ownerHash = createHash('sha256').update(owner).digest('hex');
    if (doc.served.filter((i) => i[0] === ownerHash).length >= cfg.perOwnerPerHour) return 'owner-limit';
    if (doc.served.length >= cfg.globalPerHour) return 'global-limit';
    doc.nonces.push([key, nowS + NONCE_RETAIN_S]);
    doc.served.push([ownerHash, nowS]);
    writeStore(doc);
    return 'ok';
  }
  function pinDecimals(coinId, decimals) {
    const doc = readStore();
    if (Object.prototype.hasOwnProperty.call(doc.coins, coinId)) return doc.coins[coinId] === decimals;
    doc.coins[coinId] = decimals;
    writeStore(doc);
    return true;
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

  function signingKeyUsable(nowS) {
    const doc = readJsonFile(opts.keyDocFile);
    return !!doc && Array.isArray(doc.keys) && doc.keys.some((k) => {
      if (!k || k.publicKey !== opts.publicKey) return false;
      const from = isoSeconds(k.validFrom);
      const until = k.validUntil ? isoSeconds(k.validUntil) : Infinity;
      return from !== null && until !== null && nowS >= from && nowS < until;
    });
  }
  function isRevoked(id) {
    const doc = readJsonFile(opts.revocationsFile);
    return !!doc && Array.isArray(doc.revoked) && doc.revoked.some((r) => r && r.id === id);
  }

  // The only constructor of a signed receipt payload.
  function receiptPayload(request, owner, network, coin, account, amount, decimals, observedS) {
    return {
      type: RECEIPT_TYPE,
      v: 1,
      request: { nonce: request.nonce, hash: createHash('sha256').update(canonicalize(request)).digest('hex') },
      network,
      coin,
      account,
      owner,
      amount,
      decimals,
      observedAt: isoNow(observedS),
      state: { status: 'no-state-version' }
    };
  }

  const fail = (status, code, error, extra) => ({ status, body: Object.assign({ ok: false, code, error }, extra || {}) });

  async function status() {
    const cfg = config();
    if (!cfg.enabled) return fail(404, 'disabled', 'Signed balance receipts are not enabled');
    if (cfg.problem) return fail(503, 'misconfigured', 'Signed balance receipts are misconfigured');
    return {
      status: 200,
      body: {
        ok: true,
        contract: CONTRACT,
        operation: 'https://' + cfg.domain + '/atlas/ledger/balance-receipt',
        network: NETWORK_PREFIX + cfg.domain,
        requestType: REQUEST_TYPE,
        receiptType: RECEIPT_TYPE,
        state: 'no-state-version',
        signedDiscovery: false,
        ledgerStorage: typeof opts.storageProbe === 'function' && opts.storageProbe() ? 'readable' : 'unavailable',
        warning: 'Experimental; a receipt authenticates an observation, not a final or spendable balance'
      }
    };
  }

  // `req`: { method, host, secure, client, rawBody } -> { status, body, headers? }
  async function handle(req) {
    const cfg = config();
    if (!cfg.enabled) return fail(404, 'disabled', 'Signed balance receipts are not enabled');
    if (cfg.problem) return fail(503, 'misconfigured', 'Signed balance receipts are misconfigured');
    if (!req.secure) return fail(403, 'https-required', 'HTTPS required');
    const domain = cfg.domain;
    if (String(req.host || '').toLowerCase() !== domain) return fail(400, 'unknown-host', 'This host does not sign for that domain');
    if (req.method === 'GET') return status();
    if (req.method !== 'POST') return fail(405, 'unknown-operation', 'GET or POST only');
    const network = NETWORK_PREFIX + domain;
    const operation = 'https://' + domain + '/atlas/ledger/balance-receipt';

    const retry = takeClientSlot(req.client || 'unknown', cfg.perClientPerMinute);
    if (retry) return Object.assign(fail(429, 'rate-limited', 'Too many requests'), { headers: { 'Retry-After': String(retry) } });

    if (Buffer.byteLength(req.rawBody || '') > MAX_BODY_BYTES) return fail(413, 'too-large', 'request body too large');
    let body;
    try { body = JSON.parse(req.rawBody); } catch (e) { body = null; }
    if (!exactKeys(body, ['payload', 'proof'])) return fail(400, 'malformed-request', 'Expected payload and proof');
    const p = body.payload, proof = body.proof;
    const fields = ['type', 'v', 'audience', 'network', 'coin', 'nonce', 'issuedAt'];
    if (!exactKeys(p, fields)) return fail(400, 'malformed-request', 'Unexpected request fields');
    if (fields.some((f) => f !== 'v' && typeof p[f] !== 'string')) return fail(400, 'malformed-request', 'Unexpected field type');
    if (p.type !== REQUEST_TYPE || p.v !== 1) return fail(400, 'malformed-request', 'Wrong request type');
    if (p.audience !== operation) return fail(401, 'wrong-audience', 'Audience must be the exact receipt URL');
    if (p.network !== network) return fail(400, 'unknown-network', 'Wrong network');
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(p.coin)) return fail(400, 'malformed-request', 'Invalid coin');
    if (!/^[a-f0-9]{32,64}$/.test(p.nonce)) return fail(400, 'malformed-request', 'Invalid nonce');
    const nowS = Math.floor(now() / 1000);
    const ts = isoSeconds(p.issuedAt);
    if (ts === null) return fail(400, 'malformed-request', 'Invalid timestamp');
    if (Math.abs(nowS - ts) > WINDOW_S) return fail(401, 'stale-request', 'Clock outside the two-minute window', { serverTime: isoNow(nowS) });

    if (!exactKeys(proof, ['publicKey', 'signature']) || !point(proof.publicKey) || !strictB64url(proof.signature)) {
      return fail(401, 'unsupported-proof', 'Only raw P-256 wallet proofs are supported');
    }
    const owner = proof.publicKey;
    if (!(await verifyRaw(p, owner, proof.signature))) return fail(401, 'bad-signature', 'Owner signature invalid');

    if (!signingKeyUsable(nowS)) return fail(503, 'issuer-key-unavailable', 'The established issuer key is not available or not valid now');

    const coin = p.coin;
    const account = accountId(network, coin, owner);
    if (isRevoked(account)) return fail(409, 'account-revoked', 'This account reference has been revoked');

    const admitted = admit(owner, p.nonce, nowS, cfg);
    if (admitted === 'replayed') return fail(409, 'replayed-request', 'Signed request has already been used');
    if (admitted !== 'ok') return Object.assign(fail(admitted === 'full' ? 503 : 429, admitted === 'full' ? 'busy' : 'rate-limited', 'Receipts are limited right now'), { headers: { 'Retry-After': '60' } });

    let read;
    try { read = await opts.readBalance(domain, coin, owner); } catch (e) { read = { status: 'unavailable' }; }
    if (!read || typeof read !== 'object' || read.status === 'unavailable') return fail(502, 'ledger-unavailable', 'The ledger could not be read');
    if (read.status === 'no-coin') return fail(404, 'unknown-coin', 'Coin not registered on this domain');
    if (read.status === 'no-account') return fail(404, 'account-not-found', 'The ledger has no account for this owner and coin');
    if (read.status !== 'ok' || typeof read.coinId !== 'string' || !read.coinId || !Number.isInteger(read.decimals) || read.decimals < 0 || read.decimals > MAX_DECIMALS
        || typeof read.amount !== 'string' || !/^(0|[1-9][0-9]{0,39})$/.test(read.amount)) {
      return fail(502, 'ledger-unavailable', 'The ledger could not be read');
    }
    if (!pinDecimals(read.coinId, read.decimals)) return fail(502, 'ledger-mismatch', 'The coin\'s decimals changed');

    const observedS = Math.floor(now() / 1000);
    if (!signingKeyUsable(observedS)) return fail(503, 'issuer-key-unavailable', 'The established issuer key is not available or not valid now');
    const payload = receiptPayload(p, owner, network, coin, account, read.amount, read.decimals, observedS);
    const signature = await opts.sign(payload);
    record(account, coin, observedS);
    return { status: 200, body: { ok: true, contract: CONTRACT, payload, signerKey: opts.publicKey, signature } };
  }

  return { handle, config };
}

// A read-only reader over the two Labs 29 databases in `privateDir`. Neither file is created.
function sqliteReader(privateDir) {
  const { DatabaseSync } = require('node:sqlite');
  const registryFile = path.join(privateDir, 'coin26.sqlite');
  const ledgerFile = path.join(privateDir, 'ledger29.sqlite');
  return function readBalance(domain, coin, ownerKey) {
    if (!fs.existsSync(registryFile) || !fs.existsSync(ledgerFile)) return { status: 'unavailable' };
    let registry = null, ledger = null;
    try {
      registry = new DatabaseSync(registryFile, { readOnly: true });
      ledger = new DatabaseSync(ledgerFile, { readOnly: true });
      const row = registry.prepare('SELECT id,decimals FROM coins WHERE domain=? AND symbol=?').get(domain, coin);
      if (!row) return { status: 'no-coin' };
      const acc = ledger.prepare('SELECT amount_units FROM accounts WHERE coin_id=? AND owner_key=?').get(row.id, ownerKey);
      if (!acc) return { status: 'no-account' };
      return { status: 'ok', coinId: String(row.id), decimals: Number(row.decimals), amount: String(acc.amount_units) };
    } catch (e) {
      return { status: 'unavailable' };
    } finally {
      try { if (registry) registry.close(); } catch (e) { /* closed */ }
      try { if (ledger) ledger.close(); } catch (e) { /* closed */ }
    }
  };
}

module.exports = { createLedgerReceipts, sqliteReader, CONTRACT, REQUEST_TYPE, RECEIPT_TYPE };
