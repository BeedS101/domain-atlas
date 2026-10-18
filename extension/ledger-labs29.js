// An EXPERIMENTAL adapter for the Chainblock Labs 29 balance prototype (contract name
// "chainblock-ledger29/experimental"). It is switched off by default and the wallet registers it
// only when the person turns the experimental interface on.
//
// What that prototype is: a read-only balance lookup. Discovery is not signed, balance answers are
// not signed, there is no account issuance and no recovery service, and nothing it returns is
// final or spendable. So this adapter:
//   - reads a balance and nothing else (no account listing, no spending),
//   - reaches only the one operation address derived from the issuing host, never an address the
//     discovery answer merely suggests,
//   - signs only with an identity whose proof the service can check (a password identity),
//   - checks the network, coin and owner in every answer against the credential,
//   - never treats the service's own "verifiedRequest" or "balanceProof" fields as proof.
//
// One file, loaded as a script (global AtlasLedgerLabs29) by the wallet pages and the service
// worker, and required as a module by the tests. It has no storage access and no network access
// of its own: every request goes through the ctx the wallet hands it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AtlasLedgerLabs29 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CONTRACT = 'chainblock-ledger29/experimental';
  const LABEL = 'Chainblock Labs 29 (experimental)';
  const HOSTS = ['evtec.co.za', 'domain-atlas.co.za'];
  const NETWORK_PREFIX = 'chainblock-labs29-';
  const PROOF_FORMATS = ['raw-ecdsa-p256'];
  const DISCOVERY_PATH = '/chain-labs/ledger29.php?action=discovery';
  const BALANCE_PATH = '/chain-labs/ledger29.php?action=balance';
  const COIN_RE = /^[A-Z][A-Z0-9]{1,9}$/;
  const MAX_BODY_CHARS = 8192;
  const MAX_FUTURE_MS = 10 * 60 * 1000;

  // The service's codes mapped to the wallet's own problem codes. A code the table does not know,
  // or no code, is a bad answer rather than a guess.
  const CODE_TO_PROBLEM = {
    'malformed-request': 'bad-response',
    'unsupported-proof': 'proof-unsupported',
    'bad-signature': 'unauthorized',
    'stale-request': 'clock',
    'replayed-request': 'busy',
    'wrong-audience': 'bad-response',
    'unknown-network': 'not-supported',
    'unknown-coin': 'unknown-coin',
    'no-account': 'not-found',
    'rate-limited': 'rate-limited',
    'unavailable': 'network'
  };

  function problem(code, message) { return Object.assign(new Error(message || code), { code }); }

  // `opts.hosts` and `opts.loopback` exist so tests can point the adapter at a local stand-in; the
  // wallet's own instance uses neither.
  function createAdapter(opts) {
    const hosts = (opts && opts.hosts) || HOSTS;
    const scheme = opts && opts.loopback ? 'http' : 'https';
    const hostOk = (h) => typeof h === 'string' && hosts.includes(h);
    const networkOf = (h) => NETWORK_PREFIX + h;
    const urlFor = (h, pathAndQuery) => scheme + '://' + h + pathAndQuery;

    async function readJson(response) {
      const text = await response.text();
      if (text.length > MAX_BODY_CHARS) throw problem('bad-response');
      try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (err) { return null; }
    }

    // The failure an answer describes, as a wallet problem code. Looks only at the structured
    // `code`; the free-text message is never parsed.
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
      proofFormats: PROOF_FORMATS.slice(),

      // Only the named hosts, only that host's own network, and only a coin the service could list.
      supports(target) {
        if (!target || !hostOk(target.issuerDomain)) return false;
        if (target.network !== null && target.network !== networkOf(target.issuerDomain)) return false;
        if (target.coin !== null && !COIN_RE.test(target.coin)) return false;
        return true;
      },

      // Whether an operation address is the one this adapter sends balance requests to.
      ownsOperation(url) {
        return typeof url === 'string' && hosts.some((h) => url === urlFor(h, BALANCE_PATH));
      },

      // Reads the service's description of itself and accepts it only if it agrees with the
      // credential and names the one address this adapter would use anyway.
      async discover(target, ctx) {
        const host = target.issuerDomain;
        const response = await ctx.fetch(urlFor(host, DISCOVERY_PATH), { method: 'GET', headers: { Accept: 'application/json' } });
        const doc = await readJson(response);
        if (!response.ok || !doc || doc.ok !== true) throw problem(problemOf(response, doc));
        if (doc.contract !== CONTRACT || doc.issuer !== host || doc.network !== networkOf(host)) throw problem('bad-response');
        const advertised = doc.operations && typeof doc.operations.balance === 'string' ? doc.operations.balance : null;
        if (advertised !== urlFor(host, BALANCE_PATH)) throw problem('bad-response');
        return { operations: { balance: advertised }, discoverySigned: false };
      },

      async fetchBalance(target, found, ctx) {
        const url = found && found.operations && found.operations.balance;
        if (url !== urlFor(target.issuerDomain, BALANCE_PATH)) throw problem('bad-response');
        if (!target.ownerPublicKey) throw problem('wrong-identity');
        const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16))).map((b) => b.toString(16).padStart(2, '0')).join('');
        const payload = { type: 'atlas.ledger.balance', v: 1, audience: url, network: target.network, coin: target.coin, nonce, issuedAt: new Date().toISOString() };
        const proof = await ctx.sign(payload);
        // The identity that signed must be the account's owner, whatever the wallet handed back.
        if (!proof || proof.publicKey !== target.ownerPublicKey || typeof proof.signature !== 'string') throw problem('wrong-identity');
        const body = JSON.stringify({ payload, proof: { publicKey: proof.publicKey, signature: proof.signature } });
        const response = await ctx.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body });
        const answer = await readJson(response);
        if (!response.ok || !answer || answer.ok !== true) throw problem(problemOf(response, answer));
        // Whose balance, in which coin, on which network: every answer must say so, and say what
        // the credential says. Anything else is not this account's balance.
        if (answer.network !== target.network || answer.coin !== target.coin || answer.ownerKey !== target.ownerPublicKey) throw problem('bad-response');
        if (typeof answer.amount !== 'string' || !/^\d{1,40}$/.test(answer.amount)) throw problem('bad-response');
        if (!Number.isInteger(answer.decimals) || answer.decimals < 0 || answer.decimals > 18) throw problem('bad-response');
        const asOf = typeof answer.asOf === 'string' ? Date.parse(answer.asOf) : NaN;
        if (Number.isNaN(asOf) || asOf > Date.now() + MAX_FUTURE_MS) throw problem('bad-response');
        return { amount: answer.amount, decimals: answer.decimals, asOf: answer.asOf };
      }
    };
  }

  return { CONTRACT, LABEL, HOSTS, PROOF_FORMATS, CODE_TO_PROBLEM, createAdapter };
});
