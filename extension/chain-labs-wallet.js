// The wallet's side of the chain labs coins (chain-labs/spend34.php): a list of domains the wallet may ask, a signed
// holdings lookup against each, sending coins with an owner-signed transfer, and buying a coin with a Gold credential.
//
// A domain on the list is a domain the person agreed to ask. The wallet keeps the list, the key it pinned for each domain
// when the domain was added, and a cache of the last answers; the balances stay the domains' statements, shown with their
// time and never stored as the wallet's own.
//
// Nothing here touches the page, extension storage or the network by itself: everything it needs is passed to create(), so
// the same code runs in the wallet page and in the tests, against the real endpoint.
//   env.fetch(url, init)            like fetch
//   env.sign(payload)               async; the wallet's signature over the canonical text of an atlas.ledger.* payload,
//                                   raw r||s, base64url; throws when the identity cannot make one
//   env.ownerKey()                  async; the active identity's public key in the canonical spelling, or null
//   env.loadDomains() / saveDomains(list)   the list of domains, which is part of the wallet backup
//   env.loadCache() / saveCache(obj)        last answers and unfinished sends and purchases (not backed up)
//   env.now()                       milliseconds
//   env.origin(domain)              the address of a domain (default https://domain; tests point it at loopback)
//   env.path                        where the endpoint is on a domain (default /chain-labs/spend34.php)
//   env.goldCredentials()           async; the Gold credentials the wallet holds: [{credential, quantity, label}]
//   env.afterPurchase(prepared, balance)    optional, async; called once a purchase is delivered, with the Gold the issuer returned
//
// One file, loaded as a script (global AtlasChainLabs) by the wallet pages, and required as a module by the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AtlasChainLabs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PATH = '/chain-labs/spend34.php';
  const MAX_DOMAINS = 24;
  const MAX_COINS_PER_DOMAIN = 100;
  const MAX_BODY_CHARS = 262144;
  const TIMEOUT_MS = 8000;
  const STATEMENT_MAX_AGE_S = 300;
  const CLOCK_SKEW_S = 120;
  const STALE_AFTER_MS = 30 * 60 * 1000;
  const MAX_UNITS_DIGITS = 13;
  const MAX_PENDING = 20;
  const TRANSFER_WINDOW_S = 200;
  const INTENT_WINDOW_S = 300;

  const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
  const COIN_RE = /^[a-f0-9]{32}$/;
  const HASH_RE = /^[a-f0-9]{64}$/;
  const SYMBOL_RE = /^[A-Z][A-Z0-9]{1,9}$/;
  const REQUEST_RE = /^[a-f0-9]{32}$/;
  const SPKI_P256_HEADER = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

  function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  // ---------- encoding ----------

  function fromB64(s, url) {
    if (typeof s !== 'string' || s.length === 0 || s.length > 4096) return null;
    const text = url ? s.replace(/-/g, '+').replace(/_/g, '/') : s;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || (url && /[+/=]/.test(s))) return null;
    try {
      const bin = atob(text + (url ? '='.repeat((4 - text.length % 4) % 4) : ''));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch (err) { return null; }
  }

  function toHex(bytes) { return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''); }

  function randomHex(bytes) { return toHex(crypto.getRandomValues(new Uint8Array(bytes))); }

  // The same text the PHP ledger signs and checks: keys sorted, no whitespace, no floats.
  function canonical(v) {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (isObject(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
    if (typeof v === 'number' && !Number.isInteger(v)) throw new Error('floating point values are not allowed');
    return JSON.stringify(v);
  }

  function isOwnerKey(s) {
    const bytes = fromB64(s, true);
    return !!bytes && bytes.length === 65 && bytes[0] === 4;
  }

  function iso(ms) { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

  // ---------- domain keys ----------

  // A domain's key is a P-256 public key in PEM; its statements are DER ECDSA signatures, which WebCrypto wants as r||s.
  function spkiOfPem(pem) {
    if (typeof pem !== 'string' || pem.length > 400) return null;
    const m = /^-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END PUBLIC KEY-----\s*$/.exec(pem);
    if (!m) return null;
    const der = fromB64(m[1].replace(/\s+/g, ''), false);
    if (!der || der.length !== 91 || toHex(der.slice(0, 26)) !== SPKI_P256_HEADER) return null;
    return der;
  }

  function derToRaw(der) {
    let i = 0;
    const len = () => { let n = der[i++]; if (n & 0x80) { const c = n & 0x7f; if (c < 1 || c > 2) return -1; n = 0; for (let k = 0; k < c; k++) n = (n << 8) | der[i++]; } return n; };
    if (!der || der[i++] !== 0x30) return null;
    const total = len();
    if (total < 0 || i + total !== der.length) return null;
    const out = new Uint8Array(64);
    for (let part = 0; part < 2; part++) {
      if (der[i++] !== 0x02) return null;
      let n = len();
      if (n < 1 || n > 33 || i + n > der.length) return null;
      let slice = der.slice(i, i + n);
      i += n;
      while (slice.length > 32 && slice[0] === 0) slice = slice.slice(1);
      if (slice.length > 32) return null;
      out.set(slice, part * 32 + 32 - slice.length);
    }
    return i === der.length ? out : null;
  }

  async function verifyDomainSignature(pem, text, signature) {
    const spki = spkiOfPem(pem);
    const der = fromB64(signature, true);
    const raw = der && derToRaw(der);
    if (!spki || !raw) return false;
    try {
      const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, new TextEncoder().encode(text));
    } catch (err) { return false; }
  }

  async function fingerprint(pem) {
    const spki = spkiOfPem(pem);
    if (!spki) return '';
    return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', spki))).slice(0, 16);
  }

  // ---------- amounts ----------

  // 1250 units of a coin with 2 decimals is "12.5"; units are whole numbers of the smallest part.
  function formatUnits(units, decimals) {
    if (typeof units !== 'string' || !/^\d{1,13}$/.test(units) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
    const digits = units.replace(/^0+(?=\d)/, '');
    if (decimals === 0) return digits;
    const padded = digits.padStart(decimals + 1, '0');
    const whole = padded.slice(0, padded.length - decimals);
    const frac = padded.slice(padded.length - decimals).replace(/0+$/, '');
    return frac ? whole + '.' + frac : whole;
  }

  // The exact reverse: "12.5" becomes "1250", and more places than the coin has, or a figure that is not a plain positive
  // decimal, is refused rather than rounded.
  function parseAmount(text, decimals) {
    if (typeof text !== 'string' || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
    const m = /^(\d{1,13})(?:\.(\d{1,18}))?$/.exec(text.trim());
    if (!m) return null;
    const frac = m[2] || '';
    if (frac.length > decimals) return null;
    const units = (m[1] + frac.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '');
    if (units.length > MAX_UNITS_DIGITS || /^0+$/.test(units)) return null;
    return units;
  }

  function normalizeDomain(input) {
    if (typeof input !== 'string') return null;
    const d = input.trim().toLowerCase();
    return d.length <= 253 && HOST_RE.test(d) ? d : null;
  }

  // ---------- reading a holdings statement ----------

  const VISIBILITY = ['public', 'private'];
  const MODES = ['single', 'multi'];
  const STATES = ['active', 'frozen'];

  function readCoin(c) {
    if (!isObject(c)) return null;
    const keys = Object.keys(c).sort().join(',');
    if (keys !== 'coinId,decimals,headHash,headIndex,mode,roster,seq,state,symbol,threshold,units,visibility') return null;
    if (!COIN_RE.test(c.coinId) || !SYMBOL_RE.test(c.symbol) || !Number.isInteger(c.decimals) || c.decimals < 0 || c.decimals > 18) return null;
    if (!VISIBILITY.includes(c.visibility) || !MODES.includes(c.mode) || !STATES.includes(c.state)) return null;
    if (!Number.isInteger(c.threshold) || c.threshold < 1 || c.threshold > 5 || !Number.isInteger(c.roster) || c.roster < 1 || c.roster > 5) return null;
    if (typeof c.units !== 'string' || !/^\d{1,13}$/.test(c.units) || !Number.isInteger(c.seq) || c.seq < 0 || !Number.isInteger(c.headIndex) || c.headIndex < 0) return null;
    if (!HASH_RE.test(c.headHash)) return null;
    return { coinId: c.coinId, symbol: c.symbol, decimals: c.decimals, visibility: c.visibility, mode: c.mode, threshold: c.threshold, roster: c.roster, state: c.state, units: c.units, seq: c.seq, headIndex: c.headIndex, headHash: c.headHash };
  }

  // The statement a domain signed: for this domain and this key, recent, in the form this wallet reads. `proven` says whether
  // the domain saw a request this key signed, so a public lookup can never show private coins as proven.
  async function checkHoldings(answer, pem, domain, key, nowMs, wantProven) {
    if (!isObject(answer) || !isObject(answer.statement)) return { ok: false, reason: 'unreadable' };
    const s = answer.statement;
    if (Object.keys(s).sort().join(',') !== 'asOf,coins,domain,key,proven,type,v') return { ok: false, reason: 'unreadable' };
    if (s.type !== 'atlas.ledger.holdings' || s.v !== 1 || s.domain !== domain || s.key !== key || s.proven !== wantProven) return { ok: false, reason: 'not-for-this-request' };
    let text;
    try { text = canonical(s); } catch (err) { return { ok: false, reason: 'unreadable' }; }
    if (!await verifyDomainSignature(pem, text, answer.signature)) return { ok: false, reason: 'bad-signature' };
    const at = typeof s.asOf === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s.asOf) ? Date.parse(s.asOf) : NaN;
    if (Number.isNaN(at)) return { ok: false, reason: 'unreadable' };
    if (at > nowMs + CLOCK_SKEW_S * 1000) return { ok: false, reason: 'clock' };
    if (nowMs - at > STATEMENT_MAX_AGE_S * 1000) return { ok: false, reason: 'clock' };
    if (!Array.isArray(s.coins) || s.coins.length > MAX_COINS_PER_DOMAIN) return { ok: false, reason: 'unreadable' };
    const coins = [];
    for (const c of s.coins) { const read = readCoin(c); if (!read) return { ok: false, reason: 'unreadable' }; coins.push(read); }
    return { ok: true, asOf: s.asOf, proven: s.proven, coins };
  }

  // ---------- what the person is told ----------

  const PROBLEMS = {
    'bad-signature': 'The answer was not signed by the key pinned for this domain, so it was ignored.',
    'not-for-this-request': 'The answer was not for this domain and key, so it was ignored.',
    unreadable: 'The answer was not in a form the wallet reads, so it was ignored.',
    clock: 'The answer\'s time does not match this device\'s clock. Check the clock and try again.',
    network: 'The domain did not answer.',
    'proof-unsupported': 'This identity cannot sign for a ledger, so only public coins are shown.',
    'not-listed': 'That domain is not on your list.'
  };

  const SEND_PROBLEMS = {
    stale: 'Your balance changed while the transfer was being made. Try again.',
    insufficient: 'That is more than you hold.',
    'pending-exists': 'You already have a transfer waiting at this domain. Wait for it to finish.',
    'not-active': 'This coin is not active; a frozen coin takes no new transfers.',
    expired: 'The transfer expired before it was made. Try again.',
    'bad-signature': 'The domain did not accept the signature.',
    'unknown-coin': 'The domain does not know this coin.',
    busy: 'The domain is busy. Try again in a moment.',
    'peer-down': 'A partner domain did not answer, so the transfer could not be approved.',
    'not-enough-approvals': 'The partner domains did not approve the transfer.'
  };

  const OFFER_STATE_TTL_MS = 30000;
  const BUY_PROBLEMS = {
    locked: 'That Gold is already being used for another purchase.',
    'request-reused': 'That purchase request was already used for something else.',
    'insufficient-treasury': 'The coin has fewer units left than this purchase.',
    'duplicate-purchase': 'That purchase was already delivered.',
    'purchase-key-limit': 'This key has reached the most it can buy of this coin.',
    'purchase-day-limit': 'The coin has sold all it sells today. Try again tomorrow.',
    'purchase-too-small': 'That is below the smallest price this coin sells for.',
    'bad-purchase': 'The domain did not accept the credential or the purchase.',
    'revoked-credential': 'The issuer has revoked that Gold.',
    'no-purchase-policy': 'This coin is not for sale.',
    'purchases-off': 'This domain does not take Gold purchases yet.',
    'not-authority': 'Buy from the coin\'s authority domain.',
    'not-active': 'This coin is not active.',
    'unknown-coin': 'The domain does not know this coin.'
  };

  function create(env) {
    const nowMs = () => (env.now ? env.now() : Date.now());
    const origin = (domain) => (env.origin ? env.origin(domain) : 'https://' + domain);

    async function request(domain, method, query, body) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
      try {
        const init = { method, cache: 'no-store', credentials: 'omit', redirect: 'error', headers: {} };
        if (controller) init.signal = controller.signal;
        if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
        const res = await env.fetch(origin(domain) + (env.path || PATH) + '?' + query, init);
        const text = await res.text();
        if (typeof text !== 'string' || text.length > MAX_BODY_CHARS) return { status: res.status, json: null };
        let json = null;
        try { json = JSON.parse(text); } catch (err) { /* not JSON */ }
        return { status: res.status, json: isObject(json) ? json : null };
      } catch (err) {
        return { status: 0, json: null };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async function domains() {
      const list = await env.loadDomains();
      return Array.isArray(list) ? list.filter((d) => isObject(d) && normalizeDomain(d.domain) && spkiOfPem(d.key)) : [];
    }

    async function cache() {
      const c = await env.loadCache();
      const base = isObject(c) ? c : {};
      return { answers: isObject(base.answers) ? base.answers : {}, pendingSends: Array.isArray(base.pendingSends) ? base.pendingSends : [], pendingBuys: Array.isArray(base.pendingBuys) ? base.pendingBuys : [] };
    }

    // Changes to the list and to the cache are made one at a time, each on what the one before left, so a lookup that finishes
    // while a domain is being removed, or a send that is being recorded, cannot write over the other's change.
    let queue = Promise.resolve();
    function serial(fn) {
      const run = queue.then(fn, fn);
      queue = run.then(() => undefined, () => undefined);
      return run;
    }

    function mutateCache(fn) {
      return serial(async () => {
        const c = await cache();
        const out = await fn(c);
        await env.saveCache(c);
        return out;
      });
    }

    async function recordFor(domain) {
      const d = normalizeDomain(domain);
      const found = d && (await domains()).find((x) => x.domain === d);
      if (!found) throw Object.assign(new Error(PROBLEMS['not-listed']), { code: 'not-listed' });
      return found;
    }

    // Adding a domain is the consent to ask it. The key it answers with is pinned now, and every later statement is checked
    // against it; there is no other source for that key yet, so the person sees its fingerprint.
    async function addDomain(input) {
      const domain = normalizeDomain(input);
      if (!domain) throw Object.assign(new Error('That is not a domain name.'), { code: 'bad-domain' });
      const first = await domains();
      if (first.some((d) => d.domain === domain)) throw Object.assign(new Error('That domain is already on the list.'), { code: 'exists' });
      if (first.length >= MAX_DOMAINS) throw Object.assign(new Error('The list is full.'), { code: 'full' });
      const r = await request(domain, 'GET', 'action=coins');
      if (r.status !== 200 || !r.json || r.json.ok !== true || r.json.domain !== domain || !spkiOfPem(r.json.domainKey)) {
        throw Object.assign(new Error(r.status === 0 ? PROBLEMS.network : 'That domain does not look like a chain labs domain.'), { code: r.status === 0 ? 'network' : 'not-chain-labs' });
      }
      const record = { domain, key: r.json.domainKey.trim(), fingerprint: await fingerprint(r.json.domainKey), addedAt: iso(nowMs()) };
      return serial(async () => {
        const list = await domains();
        if (list.some((d) => d.domain === domain)) throw Object.assign(new Error('That domain is already on the list.'), { code: 'exists' });
        if (list.length >= MAX_DOMAINS) throw Object.assign(new Error('The list is full.'), { code: 'full' });
        await env.saveDomains(list.concat([record]));
        return record;
      });
    }

    async function removeDomain(input) {
      const domain = normalizeDomain(input);
      await serial(async () => { await env.saveDomains((await domains()).filter((d) => d.domain !== domain)); });
      await mutateCache((c) => {
        delete c.answers[domain];
        c.pendingSends = c.pendingSends.filter((p) => p.domain !== domain);
        c.pendingBuys = c.pendingBuys.filter((p) => p.domain !== domain);
      });
    }

    // One lookup. A private-coin lookup is signed over a fresh challenge from the domain; a wallet that cannot sign for a
    // ledger asks for public coins only.
    async function lookupOnce(record, key, allowSigned) {
      let body = { key };
      let signed = false;
      if (allowSigned) {
        const ch = await request(record.domain, 'POST', 'action=challenge', {});
        if (ch.status !== 200 || !ch.json || !/^[a-f0-9]{32}$/.test(ch.json.challenge || '')) return { ok: false, reason: 'network' };
        let envelope;
        try { envelope = await env.sign({ type: 'atlas.ledger.holdings.request', v: 1, domain: record.domain, key, challenge: ch.json.challenge }); } catch (err) { return { ok: false, reason: 'proof-unsupported' }; }
        if (!envelope || envelope.publicKey !== key || typeof envelope.signature !== 'string') return { ok: false, reason: 'proof-unsupported' };
        body = { key, request: { payload: { type: 'atlas.ledger.holdings.request', v: 1, domain: record.domain, key, challenge: ch.json.challenge }, signature: envelope.signature } };
        signed = true;
      }
      const r = await request(record.domain, 'POST', 'action=holdings', body);
      if (r.status !== 200 || !r.json || r.json.ok !== true) return { ok: false, reason: r.status === 0 ? 'network' : 'unreadable' };
      const checked = await checkHoldings(r.json, record.key, record.domain, key, nowMs(), signed);
      return checked.ok ? Object.assign({ signed }, checked) : checked;
    }

    async function lookup(domain) {
      const record = await recordFor(domain);
      const key = await env.ownerKey();
      if (!key) throw Object.assign(new Error('Unlock your wallet first.'), { code: 'locked' });
      let got = await lookupOnce(record, key, true);
      if (!got.ok && got.reason === 'proof-unsupported') got = await lookupOnce(record, key, false);
      // A domain taken off the list while it was being asked is not put back by its answer.
      const answer = await mutateCache(async (c) => {
        if (!(await domains()).some((d) => d.domain === record.domain)) return null;
        const prior = c.answers[record.domain];
        c.answers[record.domain] = got.ok
          ? { asOf: got.asOf, proven: got.proven, coins: got.coins, fetchedAt: nowMs(), problem: null }
          : Object.assign({}, prior || { asOf: null, proven: false, coins: [], fetchedAt: null }, { problem: got.reason });
        return c.answers[record.domain];
      });
      return { ok: got.ok, reason: got.reason, answer };
    }

    // All listed domains in parallel. A domain that fails keeps its last answer, marked with the problem; one failing domain
    // never blanks the others.
    async function refresh() {
      const list = await domains();
      await Promise.all(list.map((d) => lookup(d.domain).catch(() => null)));
      return rows();
    }

    async function rows() {
      const list = await domains();
      const c = await cache();
      const out = [];
      for (const d of list) {
        const a = c.answers[d.domain];
        out.push({
          domain: d.domain, fingerprint: d.fingerprint || '', addedAt: d.addedAt, asOf: a ? a.asOf : null, fetchedAt: a ? a.fetchedAt : null, proven: !!(a && a.proven),
          problem: a && a.problem ? PROBLEMS[a.problem] || PROBLEMS.network : null, never: !a || a.fetchedAt === null,
          stale: !a || a.fetchedAt === null || nowMs() - a.fetchedAt > STALE_AFTER_MS || !!a.problem,
          coins: a ? a.coins.map((coin) => Object.assign({ amount: formatUnits(coin.units, coin.decimals) }, coin)) : []
        });
      }
      return { domains: out, pendingSends: c.pendingSends, pendingBuys: c.pendingBuys.map((p) => ({ domain: p.domain, coinId: p.coinId, requestId: p.requestId, price: p.price, createdAt: p.createdAt })) };
    }

    // ---------- sending ----------

    async function freshCoin(record, coinId) {
      const key = await env.ownerKey();
      let got = await lookupOnce(record, key, true);
      if (!got.ok && got.reason === 'proof-unsupported') got = await lookupOnce(record, key, false);
      if (!got.ok) throw Object.assign(new Error(PROBLEMS[got.reason] || PROBLEMS.network), { code: got.reason });
      const coin = got.coins.find((c) => c.coinId === coinId);
      if (!coin) throw Object.assign(new Error('This domain no longer lists that coin for you.'), { code: 'unknown-coin' });
      return { coin, key };
    }

    // Checks a transfer before anything is signed and describes it for the person to approve.
    async function prepareSend(domain, coinId, to, amountText) {
      const record = await recordFor(domain);
      const { coin, key } = await freshCoin(record, coinId);
      if (coin.state !== 'active') throw Object.assign(new Error(SEND_PROBLEMS['not-active']), { code: 'not-active' });
      if (!isOwnerKey(to)) throw Object.assign(new Error('The recipient is not a wallet key.'), { code: 'bad-recipient' });
      if (to === key) throw Object.assign(new Error('That is your own key.'), { code: 'bad-recipient' });
      const amount = parseAmount(amountText, coin.decimals);
      if (!amount) throw Object.assign(new Error('The amount must be a positive number with at most ' + coin.decimals + ' decimal places.'), { code: 'bad-amount' });
      if (BigInt(amount) > BigInt(coin.units)) throw Object.assign(new Error(SEND_PROBLEMS.insufficient), { code: 'insufficient' });
      return {
        domain: record.domain, coinId, symbol: coin.symbol, decimals: coin.decimals, private: coin.visibility === 'private', to, amount, from: key,
        text: 'Send ' + formatUnits(amount, coin.decimals) + ' ' + coin.symbol + ' to key ' + to.slice(0, 10) + '…' + to.slice(-6) + ' through ' + record.domain + '. You hold ' + formatUnits(coin.units, coin.decimals) + ' ' + coin.symbol + ' there.' +
          (coin.mode === 'multi' ? ' This coin needs approval from ' + coin.threshold + ' of its ' + coin.roster + ' domains, so it may take a moment.' : '')
      };
    }

    async function signTransfer(record, prepared) {
      const { coin, key } = await freshCoin(record, prepared.coinId);
      if (BigInt(prepared.amount) > BigInt(coin.units)) throw Object.assign(new Error(SEND_PROBLEMS.insufficient), { code: 'insufficient' });
      const t = nowMs();
      const payload = { type: 'atlas.ledger.transfer', v: 1, coinId: prepared.coinId, from: key, to: prepared.to, amount: prepared.amount, baseSeq: coin.seq, baseHead: coin.headHash, nonce: randomHex(16), issuedAt: iso(t - 5000), expiresAt: iso(t + TRANSFER_WINDOW_S * 1000) };
      const envelope = await env.sign(payload);
      if (!envelope || envelope.publicKey !== key || typeof envelope.signature !== 'string') throw Object.assign(new Error(PROBLEMS['proof-unsupported']), { code: 'proof-unsupported' });
      return { payload, signature: envelope.signature };
    }

    function receiptMatches(receipt, expect) {
      const e = isObject(receipt) ? receipt.entry : null;
      // A private coin's entry names accounts by reference, which only the domains can compute, so only the coin, the amount and the purchase are compared.
    const parties = expect.private ? true : e && e.to === expect.to && (expect.from === undefined || e.from === expect.from);
    return !!(isObject(e) && e.coinId === expect.coinId && parties && e.amount === expect.amount && (!expect.purchase || (isObject(e.purchase) && e.purchase.requestId === expect.purchase.requestId && e.purchase.price === expect.purchase.price)));
    }

    // Signs and sends a prepared transfer to the domain. A stale base is made again once.
    async function send(prepared) {
      const record = await recordFor(prepared.domain);
      for (let attempt = 0; attempt < 2; attempt++) {
        const authorization = await signTransfer(record, prepared);
        const r = await request(record.domain, 'POST', 'action=propose', { authorization });
        const j = r.json || {};
        if (r.status === 201 && j.ok && receiptMatches(j.receipt, { coinId: prepared.coinId, to: prepared.to, amount: prepared.amount, from: prepared.from, private: prepared.private })) {
          await lookup(record.domain).catch(() => null);
          return { status: 'done', receipt: j.receipt };
        }
        if (r.status === 201) throw Object.assign(new Error('The domain\'s receipt does not match what you signed, so it was not accepted.'), { code: 'bad-receipt' });
        if (r.status === 202 && j.proposal && HASH_RE.test(j.proposal.digest || '')) {
          await mutateCache((c) => { c.pendingSends = c.pendingSends.filter((p) => p.digest !== j.proposal.digest).concat([{ domain: record.domain, coinId: prepared.coinId, digest: j.proposal.digest, to: prepared.to, amount: prepared.amount, from: prepared.from, symbol: prepared.symbol, decimals: prepared.decimals, private: prepared.private, createdAt: nowMs() }]).slice(-MAX_PENDING); });
          return { status: 'waiting', digest: j.proposal.digest, note: j.note || '' };
        }
        if (r.status === 409 && j.code === 'stale' && attempt === 0) continue;
        if (r.status === 409 && j.code === 'not-authority') throw Object.assign(new Error('This coin is spent through ' + (typeof j.authority === 'string' ? j.authority : 'its authority domain') + '. Add that domain to your list and send from there.'), { code: 'not-authority' });
        throw Object.assign(new Error(r.status === 0 ? PROBLEMS.network : SEND_PROBLEMS[j.code] || 'The domain did not accept the transfer.'), { code: r.status === 0 ? 'network' : j.code || 'refused' });
      }
      throw Object.assign(new Error(SEND_PROBLEMS.stale), { code: 'stale' });
    }

    // Asks the domain how each waiting transfer ended.
    async function checkPending() {
      const c = await cache();
      const done = [];
      for (const p of c.pendingSends) {
        const r = await request(p.domain, 'GET', 'action=proposal&coin=' + p.coinId + '&digest=' + p.digest);
        const proposal = r.json && r.json.proposal;
        if (r.status === 200 && proposal && proposal.status === 'executed' && receiptMatches(proposal.receipt, p)) done.push(Object.assign({}, p, { outcome: 'done' }));
        else if (r.status === 200 && proposal && (proposal.status === 'expired' || proposal.status === 'rejected')) done.push(Object.assign({}, p, { outcome: proposal.status }));
      }
      await mutateCache((latest) => { latest.pendingSends = latest.pendingSends.filter((p) => !done.some((d) => d.digest === p.digest)); });
      return done;
    }

    // ---------- buying with Gold ----------

    // What a coin sells for, read from the coin's public genesis on its authority domain, which must be on the list.
    async function offer(domain, coinId) {
      const record = await recordFor(domain);
      const r = await request(record.domain, 'GET', 'action=coin&coin=' + coinId);
      const g = r.json && r.json.ok ? r.json.genesis : null;
      if (!g || !isObject(g.purchase)) throw Object.assign(new Error(BUY_PROBLEMS['no-purchase-policy']), { code: 'no-purchase-policy' });
      if (r.json.state !== 'active') throw Object.assign(new Error(BUY_PROBLEMS['not-active']), { code: 'not-active' });
      // The authority says whether it has the code that takes the Gold; a coin whose genesis has terms but whose domain cannot take payment is not for sale.
      if (r.json.purchasesEnabled !== true) throw Object.assign(new Error(BUY_PROBLEMS['purchases-off']), { code: 'purchases-off' });
      if (g.authority !== record.domain) throw Object.assign(new Error(BUY_PROBLEMS['not-authority'] + ' That is ' + g.authority + '.'), { code: 'not-authority', authority: g.authority });
      const p = g.purchase;
      if (!Number.isInteger(p.unitsPerPrice) || !Number.isInteger(p.minPrice) || p.unitsPerPrice < 1 || p.minPrice < 1) throw Object.assign(new Error('The coin\'s purchase terms are not readable.'), { code: 'unreadable' });
      return { domain: record.domain, coinId, symbol: g.symbol, decimals: g.decimals, private: g.visibility === 'private', priceClass: p.priceClass, unitsPerPrice: p.unitsPerPrice, minPrice: p.minPrice, perKeyUnits: p.perKeyUnits, perDayUnits: p.perDayUnits };
    }

    // Whether Buy with Gold may be offered for a coin: its authority publishes terms and can take the Gold. The answer is kept for
    // a short while so drawing the list does not ask the domain every time. Never throws.
    const offerStates = new Map();
    async function offerState(domain, coinId) {
      const key = domain + '/' + coinId;
      const hit = offerStates.get(key);
      if (hit && nowMs() - hit.at < OFFER_STATE_TTL_MS) return hit.state;
      let state;
      try { const terms = await offer(domain, coinId); state = { usable: true, terms }; }
      catch (err) { state = { usable: false, code: err && err.code ? err.code : 'unreadable', reason: err && err.message ? err.message : 'Not for sale.' }; }
      offerStates.set(key, { at: nowMs(), state });
      if (offerStates.size > 200) offerStates.delete(offerStates.keys().next().value);
      return state;
    }

    function credentialId(credential) {
      if (!isObject(credential)) return null;
      const id = credential.id !== undefined ? credential.id : isObject(credential.asset) ? credential.asset.id : undefined;
      return typeof id === 'string' && id.length > 0 && id.length <= 200 ? id : null;
    }

    async function prepareBuy(domain, coinId, credential, quantity, priceText, recipient) {
      const terms = await offer(domain, coinId);
      const key = await env.ownerKey();
      if (!key) throw Object.assign(new Error('Unlock your wallet first.'), { code: 'locked' });
      const price = /^\d{1,9}$/.test(String(priceText)) ? Number(priceText) : 0;
      if (!price || price < terms.minPrice) throw Object.assign(new Error(BUY_PROBLEMS['purchase-too-small'] + ' The smallest is ' + terms.minPrice + '.'), { code: 'purchase-too-small' });
      if (!Number.isInteger(quantity) || price > quantity) throw Object.assign(new Error('That is more Gold than the credential holds.'), { code: 'bad-amount' });
      if (!credentialId(credential)) throw Object.assign(new Error('That Gold credential cannot be used.'), { code: 'bad-credential' });
      const to = recipient || key;
      if (!isOwnerKey(to)) throw Object.assign(new Error('The recipient is not a wallet key.'), { code: 'bad-recipient' });
      const units = String(BigInt(price) * BigInt(terms.unitsPerPrice));
      return {
        domain: terms.domain, coinId, symbol: terms.symbol, decimals: terms.decimals, private: terms.private, credential, price, recipient: to, units, from: key, requestId: randomHex(16),
        text: 'Pay ' + price + ' Gold to get ' + formatUnits(units, terms.decimals) + ' ' + terms.symbol + ' from ' + terms.domain + (to === key ? '' : ' for key ' + to.slice(0, 10) + '…') + '. The domain spends the Gold you pay and gives back the rest of the credential. ' +
          'It sells at most ' + formatUnits(String(terms.perKeyUnits), terms.decimals) + ' ' + terms.symbol + ' to one key.'
      };
    }

    async function intentFor(prepared) {
      const payload = { type: 'atlas.ledger.purchase.intent', v: 1, coinId: prepared.coinId, credentialId: credentialId(prepared.credential), price: prepared.price, recipient: prepared.recipient, requestId: prepared.requestId, expiresAt: iso(nowMs() + INTENT_WINDOW_S * 1000) };
      const envelope = await env.sign(payload);
      if (!envelope || envelope.publicKey !== prepared.from || typeof envelope.signature !== 'string') throw Object.assign(new Error(PROBLEMS['proof-unsupported']), { code: 'proof-unsupported' });
      return { payload, signature: envelope.signature };
    }

    // Signs the intent and sends the purchase. The request id is kept until the domain has delivered, so a retry (with a new
    // signature and expiry, since an intent expires) is the same purchase and cannot be delivered twice.
    async function buy(prepared) {
      const record = await recordFor(prepared.domain);
      const intent = await intentFor(prepared);
      await mutateCache((c) => {
        if (c.pendingBuys.some((p) => p.requestId === prepared.requestId)) return;
        c.pendingBuys = c.pendingBuys.concat([{ domain: record.domain, coinId: prepared.coinId, requestId: prepared.requestId, credential: prepared.credential, price: prepared.price, recipient: prepared.recipient, from: prepared.from, symbol: prepared.symbol, decimals: prepared.decimals, private: prepared.private, units: prepared.units, createdAt: nowMs() }]).slice(-MAX_PENDING);
      });
      const r = await request(record.domain, 'POST', 'action=purchase', { coinId: prepared.coinId, intent, credential: prepared.credential });
      const j = r.json || {};
      if (r.status === 201 && j.ok && j.requestId === prepared.requestId && receiptMatches(j.receipt, { coinId: prepared.coinId, to: prepared.recipient, amount: prepared.units, private: prepared.private, purchase: { requestId: prepared.requestId, price: prepared.price } })) {
        await dropBuy(prepared.requestId);
        // The wallet takes the Gold the issuer returned in place of the credential it spent.
        if (typeof env.afterPurchase === 'function') await Promise.resolve(env.afterPurchase(prepared, j.balance || null)).catch(() => null);
        await lookup(record.domain).catch(() => null);
        return { status: 'done', receipt: j.receipt, balance: j.balance || null };
      }
      if (r.status === 201) throw Object.assign(new Error('The domain\'s receipt does not match what you signed, so it was not accepted.'), { code: 'bad-receipt' });
      if (r.status === 202) return { status: 'waiting', requestId: prepared.requestId, note: j.note || '' };
      // A refusal ends the request unless the domain may still be holding it.
      if (r.status !== 0 && r.status < 500) {
        await dropBuy(prepared.requestId);
      }
      throw Object.assign(new Error(r.status === 0 ? PROBLEMS.network : BUY_PROBLEMS[j.code] || 'The domain did not accept the purchase.'), { code: r.status === 0 ? 'network' : j.code || 'refused' });
    }

    // Repeats an unfinished purchase with the same request id.
    async function resumeBuy(requestId) {
      const c = await cache();
      const p = c.pendingBuys.find((x) => x.requestId === requestId);
      if (!p) throw Object.assign(new Error('That purchase is not waiting.'), { code: 'unknown-request' });
      return buy(Object.assign({}, p));
    }

    function dropBuy(requestId) {
      return mutateCache((c) => { c.pendingBuys = c.pendingBuys.filter((p) => p.requestId !== requestId); });
    }

    return { addDomain, removeDomain, lookup, refresh, rows, prepareSend, send, checkPending, offer, offerState, prepareBuy, buy, resumeBuy, dropBuy, domains };
  }

  // What to tell the person when no Gold credential can pay: each credential the wallet found and why it cannot be used, or that
  // it found none for the active identity. `report` is the wallet's inspectChainLabsGold() answer.
  function describeNoGold(report) {
    const excluded = report && Array.isArray(report.excluded) ? report.excluded : [];
    if (!excluded.length) return 'This wallet holds no Gold credential (atlas.element.gold) for the active identity' + (report && report.identity ? ' (' + String(report.identity).slice(0, 10) + '…)' : '') + '.';
    return 'This wallet has Gold, but none that can pay: ' + excluded.map((x) => x.label + (x.id ? ' (' + x.id + ')' : '') + ' cannot be used because ' + x.reason).join('; ') + '.';
  }

  return { create, describeNoGold, canonical, formatUnits, parseAmount, normalizeDomain, isOwnerKey, derToRaw, checkHoldings, spkiOfPem, fingerprint, PATH, LIMITS: { MAX_DOMAINS, STALE_AFTER_MS, STATEMENT_MAX_AGE_S, MAX_BODY_CHARS } };
});
