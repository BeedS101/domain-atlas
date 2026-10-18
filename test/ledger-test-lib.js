// Test doubles for the Ledger tab tests: an issuer that publishes a signing key and signs
// ledger-account credentials, and a SIMULATED ledger service.
//
// The simulated ledger implements an invented request shape so the wallet's consent, signing,
// scoping and bookkeeping can be exercised. It is not any real ledger's interface and proves
// nothing about one: the real account interface has not been agreed, and the wallet ships no
// adapter for it.
'use strict';
const http = require('http');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const b64url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => new Uint8Array(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { resolve(null); } });
  });
}

// An issuer on loopback. `domain` is what a credential names as issuer.domain.
async function startIssuer() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = b64url(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)));
  const state = { revoked: [], endpoint: null, requests: [], keyValidFrom: '2026-01-01T00:00:00Z' };
  const server = http.createServer((req, res) => {
    state.requests.push(req.method + ' ' + req.url);
    const send = (obj, code) => { res.writeHead(code || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/.well-known/atlas-key.json') return send({ keys: [{ publicKey, validFrom: state.keyValidFrom, validUntil: null }] });
    if (req.url === '/.well-known/atlas-revocations.json') return send({ revoked: state.revoked.map((id) => ({ id })) });
    if (req.url === '/.well-known/atlas-ledger.json') return send({ endpoint: state.endpoint });
    return send({ error: 'not found' }, 404);
  });
  const port = await listen(server);
  const issuer = {
    domain: 'localhost:' + port, origin: 'http://localhost:' + port, publicKey, state,
    // Signs a ledger-account credential over {id, ledger, owner, issuedAt}.
    async issue(ownerPublicKey, ledger, over) {
      over = over || {};
      const credential = {
        credential: 'domain-atlas-ledger-account/1.0',
        id: over.id || ('urn:atlas:ledger-account:' + Buffer.from(webcrypto.getRandomValues(new Uint8Array(12))).toString('hex')),
        issuer: { domain: over.issuerDomain || ('localhost:' + port), publicKey },
        ledger: { network: ledger.network, coin: ledger.coin },
        owner: { publicKey: ownerPublicKey },
        issuedAt: over.issuedAt || '2026-10-01T00:00:00Z'
      };
      const payload = { id: credential.id, ledger: credential.ledger, owner: credential.owner, issuedAt: credential.issuedAt };
      credential.signature = b64url(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(canonicalize(payload)))));
      return credential;
    },
    close: () => new Promise((r) => server.close(() => r()))
  };
  return issuer;
}

// A SIMULATED ledger. Accounts are keyed by owner key, network and coin; a balance request has to
// be signed by the owner and addressed to this ledger's origin.
async function startLedger() {
  const state = { accounts: new Map(), requests: [], delayMs: 0, mode: 'ok', seenPayloads: [] };
  const key = (owner, network, coin) => owner + '|' + network + '|' + coin;
  let origin;
  const server = http.createServer(async (req, res) => {
    state.requests.push(req.method + ' ' + req.url);
    const send = (obj, code) => { res.writeHead(code || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method !== 'POST') return send({ error: 'not found' }, 404);
    const body = await readJson(req);
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (!body || !body.payload || !body.proof) return send({ error: 'bad request' }, 400);
    const p = body.payload;
    state.seenPayloads.push(p);
    let valid = false;
    try {
      const pub = await subtle.importKey('raw', unb64(body.proof.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      valid = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unb64(body.proof.signature), new TextEncoder().encode(canonicalize(p)));
    } catch (e) { valid = false; }
    if (!valid || p.audience !== origin) return send({ error: 'unauthorized' }, 401);
    const owner = body.proof.publicKey;
    if (state.mode === 'garbage') return send({ amount: 'lots', decimals: 2 });
    if (req.url === '/balance' && p.type === 'atlas.ledger.balance') {
      const acct = state.accounts.get(key(owner, p.network, p.coin));
      if (!acct) return send({ error: 'no such account' }, 404);
      return send({ amount: acct.amount, decimals: acct.decimals, asOf: new Date().toISOString() });
    }
    if (req.url === '/accounts' && p.type === 'atlas.ledger.accounts') {
      return send({ accounts: state.listing ? state.listing(owner) : [] });
    }
    return send({ error: 'not found' }, 404);
  });
  const port = await listen(server);
  origin = 'http://localhost:' + port;
  return {
    origin, state,
    open(owner, network, coin, amount, decimals) { state.accounts.set(key(owner, network, coin), { amount, decimals }); },
    has(owner, network, coin) { return state.accounts.has(key(owner, network, coin)); },
    balanceOf(owner, network, coin) { const a = state.accounts.get(key(owner, network, coin)); return a ? a.amount : null; },
    close: () => new Promise((r) => server.close(() => r()))
  };
}

// Evaluated inside the wallet (service worker or page). Registers an adapter for the SIMULATED
// ledger. Self-contained: it runs in another JavaScript realm from the test.
function installSimulatedAdapter(arg) {
  const adapter = {
    contract: 'simulated-ledger/0',
    supports: (t) => /^localhost:\d+$/.test(t.issuerDomain),
    async discover(target, ctx) {
      const r = await ctx.fetch('http://' + target.issuerDomain + '/.well-known/atlas-ledger.json');
      const j = await r.json();
      return { endpoint: j.endpoint };
    },
    async fetchBalance(target, endpoint, ctx) {
      if (arg.leakTo) {
        try { await ctx.fetch(arg.leakTo + '/leak'); globalThis.__leak = 'reached'; } catch (e) { globalThis.__leak = 'blocked:' + e.code; }
      }
      const payload = { type: 'atlas.ledger.balance', v: 1, audience: endpoint, network: target.network, coin: target.coin, nonce: crypto.randomUUID(), issuedAt: new Date().toISOString() };
      const proof = await ctx.sign(payload);
      const r = await ctx.fetch(endpoint + '/balance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload, proof }) });
      if (r.status === 401) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
      if (r.status === 404) throw Object.assign(new Error('not found'), { code: 'not-found' });
      return r.json();
    },
    async listAccounts(target, endpoint, ctx) {
      const payload = { type: 'atlas.ledger.accounts', v: 1, audience: endpoint, nonce: crypto.randomUUID(), issuedAt: new Date().toISOString() };
      const proof = await ctx.sign(payload);
      const r = await ctx.fetch(endpoint + '/accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload, proof }) });
      if (r.status === 401) throw Object.assign(new Error('unauthorized'), { code: 'unauthorized' });
      return (await r.json()).accounts;
    }
  };
  return AtlasWallet.registerLedgerAdapter(adapter) && true;
}

module.exports = { startIssuer, startLedger, installSimulatedAdapter, canonicalize, b64url };
