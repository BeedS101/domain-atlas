// An EXPERIMENTAL adapter for Labs 38 signed balance receipts (contract name
// "chainblock-ledger38/signed-receipt-experimental"). It is switched off by default, is a separate
// opt-in from the Labs 29 adapter, and the wallet registers it only when the person turns it on.
//
// The service is the issuing domain's own receipt endpoint (POST <host>/atlas/ledger/balance-receipt).
// It answers a request signed by the account's owner with a statement signed by the issuer's
// established key: "at observedAt this ledger held N minor units of this coin for this owner". The
// ledger has no state version, so a receipt authenticates an observation, never a committed ledger
// state, and nothing it says is final or spendable.
//
// Two parts, both free of storage and of network access of their own:
//   - the adapter, which builds and sends the owner-signed request and hands back the answer as
//     evidence. It contacts only the one address derived from the issuing host. It never marks
//     anything verified.
//   - checkReceipt(), the acceptance check the WALLET runs on that evidence, with the issuer's
//     published key document and revocation list that the wallet fetched itself. The response's own
//     `signerKey` is only a selector into that document, never a trust root.
//
// One file, loaded as a script (global AtlasLedgerLabs38) by the wallet pages and the service
// worker, and required as a module by the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AtlasLedgerLabs38 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CONTRACT = 'chainblock-ledger38/signed-receipt-experimental';
  const LABEL = 'Chainblock Labs 38 signed receipts (experimental)';
  const HOSTS = ['evtec.co.za', 'domain-atlas.co.za'];
  const NETWORK_PREFIX = 'chainblock-labs29-';
  const PROOF_FORMATS = ['raw-ecdsa-p256'];
  const RECEIPT_PATH = '/atlas/ledger/balance-receipt';
  const REQUEST_TYPE = 'atlas.ledger.balance-receipt.request';
  const RECEIPT_TYPE = 'atlas.ledger.balance-receipt';
  const COIN_RE = /^[A-Z][A-Z0-9]{1,9}$/;
  const AMOUNT_RE = /^(0|[1-9][0-9]{0,39})$/;
  const MAX_BODY_CHARS = 8192;
  const WINDOW_S = 120;
  const MAX_AGE_S = 300;

  // The service's codes mapped to the wallet's own problem codes. A code the table does not know,
  // or no code, is a bad answer rather than a guess.
  const CODE_TO_PROBLEM = {
    'disabled': 'receipts-off',
    'misconfigured': 'receipt-unavailable',
    'issuer-key-unavailable': 'receipt-unavailable',
    'ledger-unavailable': 'receipt-unavailable',
    'ledger-mismatch': 'receipt-unavailable',
    'busy': 'busy',
    'malformed-request': 'bad-response',
    'wrong-audience': 'bad-response',
    'unknown-host': 'bad-response',
    'https-required': 'bad-response',
    'unknown-operation': 'bad-response',
    'unknown-network': 'not-supported',
    'unsupported-proof': 'proof-unsupported',
    'bad-signature': 'unauthorized',
    'stale-request': 'clock',
    'replayed-request': 'busy',
    'unknown-coin': 'unknown-coin',
    'account-not-found': 'not-found',
    'account-revoked': 'account-revoked',
    'rate-limited': 'rate-limited',
    'unavailable': 'network'
  };

  function problem(code, message) { return Object.assign(new Error(message || code), { code }); }

  // ---------- encodings ----------

  function fromB64url(s) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s) || s.length % 4 === 1) return null;
    try {
      const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (err) { return null; }
  }
  function toB64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  // Decodes only text that re-encodes to itself, so one value has one spelling.
  function strictBytes(s, length) {
    const b = fromB64url(s);
    return b && b.length === length && toB64url(b) === s ? b : null;
  }
  function pointBytes(s) {
    const b = typeof s === 'string' && s.length === 87 ? strictBytes(s, 65) : null;
    return b && b[0] === 4 ? b : null;
  }
  function hex(bytes) { return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(''); }

  // The sorted-key canonical JSON the wallet signs and the issuer checks.
  function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  async function sha256Hex(text) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))); }

  function exact(o, keys) {
    return !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
  }
  const SECONDS_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
  const TIME_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
  function parseTime(s, re) { if (typeof s !== 'string' || !(re || TIME_RE).test(s)) return null; const t = Date.parse(s); return Number.isNaN(t) ? null : t; }

  // ---------- what is signed and what is derived ----------

  function operationUrl(host) { return 'https://' + host + RECEIPT_PATH; }

  // The only message the owner signs for this operation; seven fields, none of them a quantity.
  function requestPayload(host, network, coin, nonce, issuedAt) {
    return { type: REQUEST_TYPE, v: 1, audience: operationUrl(host), network, coin, nonce, issuedAt };
  }

  async function accountIdOf(network, coin, owner) {
    return 'urn:atlas:ledger-account:' + await sha256Hex(canonical({ coin, network, owner, purpose: 'atlas.ledger.account-id', v: 1 }));
  }

  // ---------- the acceptance check ----------
  //
  // `input`: { answer, request: {payload, proof}, target: {issuerDomain, network, coin,
  //   ownerPublicKey, accountId?}, keyDoc, revocations, now (ms) }.
  // Resolves { ok: true, amount, decimals, observedAt, account, signerKey, requestHash } or
  // { ok: false, code, reason }. It reads nothing but its input.
  async function checkReceipt(input) {
    const fail = (code, reason) => ({ ok: false, code, reason });
    const bad = (reason) => fail('receipt-invalid', reason);
    const { answer, request, target, keyDoc, revocations } = input || {};
    const now = Number.isFinite(input && input.now) ? input.now : Date.now();
    if (!target || !request || !request.payload || !request.proof) return bad('no request to match');

    // Shape: nothing the wallet does not know.
    if (!exact(answer, ['ok', 'contract', 'payload', 'signerKey', 'signature']) || answer.ok !== true || answer.contract !== CONTRACT) return bad('unexpected envelope');
    const p = answer.payload;
    if (!exact(p, ['type', 'v', 'request', 'network', 'coin', 'account', 'owner', 'amount', 'decimals', 'observedAt', 'state'])) return bad('unexpected payload fields');
    if (!exact(p.request, ['nonce', 'hash']) || !exact(p.state, ['status'])) return bad('unexpected nested fields');
    if (p.type !== RECEIPT_TYPE || p.v !== 1) return bad('wrong receipt type');
    if (p.state.status !== 'no-state-version') return bad('unexpected state claim');

    // Binding: this receipt answers the request just sent, signed by the account's owner.
    const q = request.payload;
    if (q.type !== REQUEST_TYPE || q.audience !== operationUrl(target.issuerDomain)) return bad('request is not for this operation');
    if (p.request.nonce !== q.nonce) return bad('answers a different request (nonce)');
    if (typeof p.request.hash !== 'string' || p.request.hash !== await sha256Hex(canonical(q))) return bad('answers a different request (hash)');

    // Identity: the account and owner the wallet holds a reference to, and nothing else.
    if (request.proof.publicKey !== target.ownerPublicKey || p.owner !== target.ownerPublicKey) return bad('not this owner');
    if (p.network !== target.network || p.network !== NETWORK_PREFIX + target.issuerDomain || q.network !== target.network) return bad('not this network');
    if (p.coin !== target.coin || q.coin !== target.coin) return bad('not this coin');
    const derived = await accountIdOf(target.network, target.coin, target.ownerPublicKey);
    if (p.account !== derived || (target.accountId && target.accountId !== derived)) return bad('not this account');

    // Values: whole minor units only.
    if (typeof p.amount !== 'string' || !AMOUNT_RE.test(p.amount)) return bad('amount is not a whole number of minor units');
    if (!Number.isInteger(p.decimals) || p.decimals < 0 || p.decimals > 18) return bad('decimals out of range');

    // Time: made for this request, not older than a moment, not from the future.
    const observed = parseTime(p.observedAt, SECONDS_RE);
    const asked = parseTime(q.issuedAt);
    if (observed === null || asked === null) return bad('unreadable time');
    if (Math.abs(observed - asked) > WINDOW_S * 1000) return bad('statement time does not fit the request');
    if (observed > now + WINDOW_S * 1000) return bad('statement time is in the future');
    if (now - observed > MAX_AGE_S * 1000) return bad('statement is too old');

    // Authority: the issuing domain's published key document, not the response, decides who may sign.
    const signerBytes = pointBytes(answer.signerKey);
    if (!signerBytes) return bad('malformed signer key');
    const sig = strictBytes(answer.signature, 64);
    if (!sig) return bad('malformed signature');
    const keys = keyDoc && Array.isArray(keyDoc.keys) ? keyDoc.keys : null;
    if (!keys) return fail('signer-unknown', 'no published key document');
    const listed = keys.find((k) => {
      if (!k || k.publicKey !== answer.signerKey) return false;
      const from = parseTime(k.validFrom);
      const until = k.validUntil === null || k.validUntil === undefined ? Infinity : parseTime(k.validUntil);
      return from !== null && until !== null && observed >= from && observed < until && now >= from && now < until;
    });
    if (!listed) return fail('signer-unknown', 'the issuer does not list this key as valid at the statement time and now');
    const revoked = revocations && Array.isArray(revocations.revoked) ? revocations.revoked : [];
    if (revoked.some((r) => r && r.id === answer.signerKey)) return fail('signer-unknown', 'the issuer revoked this key');
    if (revoked.some((r) => r && r.id === p.account)) return fail('account-revoked', 'the issuer revoked this account');

    try {
      const key = await crypto.subtle.importKey('raw', fromB64url(listed.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, new TextEncoder().encode(canonical(p)))) return bad('signature does not match');
    } catch (err) { return bad('signature could not be checked'); }
    return { ok: true, amount: p.amount, decimals: p.decimals, observedAt: p.observedAt, account: p.account, signerKey: answer.signerKey, requestHash: p.request.hash };
  }

  // ---------- the adapter ----------

  // `opts.hosts` and `opts.loopback` exist so tests can point the adapter at a local stand-in; the
  // wallet's own instance uses neither.
  function createAdapter(opts) {
    const hosts = (opts && opts.hosts) || HOSTS;
    const scheme = opts && opts.loopback ? 'http' : 'https';
    const hostOk = (h) => typeof h === 'string' && hosts.includes(h);
    const networkOf = (h) => NETWORK_PREFIX + h;
    const urlFor = (h) => scheme + '://' + h + RECEIPT_PATH;

    async function readJson(response) {
      const text = await response.text();
      if (text.length > MAX_BODY_CHARS) throw problem('bad-response');
      try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (err) { return null; }
    }
    function problemOf(response, body) {
      const code = body && typeof body.code === 'string' ? body.code : null;
      if (code && Object.prototype.hasOwnProperty.call(CODE_TO_PROBLEM, code)) return CODE_TO_PROBLEM[code];
      if (response.status === 429) return 'rate-limited';
      if (response.status >= 500) return 'network';
      return 'bad-response';
    }

    return {
      contract: CONTRACT,
      label: LABEL,
      experimental: true,
      signed: true,
      requestTypes: [REQUEST_TYPE],
      proofFormats: PROOF_FORMATS.slice(),

      // An exact account only: a known host, that host's own network, a listable coin. It has no
      // account listing, so a search for accounts in general (no network, no coin) is not its job.
      supports(target) {
        if (!target || !hostOk(target.issuerDomain)) return false;
        if (target.network !== networkOf(target.issuerDomain)) return false;
        return typeof target.coin === 'string' && COIN_RE.test(target.coin);
      },

      // Whether an operation address is the one this adapter sends receipt requests to.
      ownsOperation(url) {
        return typeof url === 'string' && hosts.some((h) => url === urlFor(h));
      },

      // Reads the endpoint's status document and accepts it only if it agrees with the credential and
      // names the one address this adapter would use anyway. The document is unsigned, so it appoints
      // no key and carries no authority: it only says whether the service is switched on.
      async discover(target, ctx) {
        const host = target.issuerDomain;
        const response = await ctx.fetch(urlFor(host), { method: 'GET', headers: { Accept: 'application/json' } });
        const doc = await readJson(response);
        if (!response.ok || !doc || doc.ok !== true) throw problem(problemOf(response, doc));
        if (doc.contract !== CONTRACT || doc.network !== networkOf(host) || doc.operation !== urlFor(host)) throw problem('bad-response');
        if (doc.requestType !== REQUEST_TYPE || doc.receiptType !== RECEIPT_TYPE || doc.state !== 'no-state-version') throw problem('bad-response');
        return { operations: { balance: doc.operation }, discoverySigned: false };
      },

      // Sends the owner-signed request and returns the answer as evidence. Whether it is a genuine
      // receipt is for checkReceipt() to say; the figures returned here are provisional.
      async fetchBalance(target, found, ctx) {
        const url = found && found.operations && found.operations.balance;
        if (url !== urlFor(target.issuerDomain)) throw problem('bad-response');
        if (!target.ownerPublicKey) throw problem('wrong-identity');
        const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, '0')).join('');
        const payload = requestPayload(target.issuerDomain, target.network, target.coin, nonce, new Date().toISOString());
        payload.audience = url;
        const proof = await ctx.sign(payload);
        // The identity that signed must be the account's owner, whatever the wallet handed back.
        if (!proof || proof.publicKey !== target.ownerPublicKey || typeof proof.signature !== 'string') throw problem('wrong-identity');
        const request = { payload, proof: { publicKey: proof.publicKey, signature: proof.signature } };
        const response = await ctx.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(request) });
        const answer = await readJson(response);
        if (!response.ok || !answer || answer.ok !== true) throw problem(problemOf(response, answer));
        const p = answer.payload;
        if (!p || typeof p !== 'object' || typeof p.amount !== 'string' || !Number.isInteger(p.decimals) || typeof p.observedAt !== 'string') throw problem('receipt-invalid');
        return { amount: p.amount, decimals: p.decimals, asOf: p.observedAt, receipt: { request, answer } };
      }
    };
  }

  return { CONTRACT, LABEL, HOSTS, PROOF_FORMATS, RECEIPT_PATH, REQUEST_TYPE, RECEIPT_TYPE, CODE_TO_PROBLEM, createAdapter, checkReceipt, requestPayload, operationUrl, accountIdOf, canonical };
});
