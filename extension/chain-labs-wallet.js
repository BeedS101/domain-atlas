// The wallet's side of the chain labs coins (chain-labs/spend34.php): a list of domains the wallet may ask, a signed
// holdings lookup against each, sending coins with an owner-signed transfer, and buying a coin with a Gold credential.
//
// A domain on the list is a domain the person agreed to ask. The wallet keeps the list, the key it pinned for each domain
// when the domain was added, and a cache of the last answers; the balances stay the domains' statements, shown with their
// time and never stored as the wallet's own.
//
// What the wallet checks itself, and does not take on a domain's word:
//   - a coin's genesis: its digest is worked out here, the keys in it must be the keys pinned for the domains the wallet knows, and the
//     coin's first entry must show that the authority signed it and every roster domain signed the genesis. The digest is then pinned
//     with the domain's record, and a different genesis under the same coin id is refused.
//   - a receipt: the entry's hash, the authority's signature over it and, for a multi coin, enough approvals from distinct roster
//     domains, all against the keys of the pinned genesis. A receipt that does not verify is refused, never read as it stands.
//   - purchase terms: read from that verified genesis, not from the plain answer of the domain.
// First contact: the first genesis seen for a coin is pinned as it is. The keys of roster domains that are not on the wallet's list are
// those the genesis names, so they are as trustworthy as that first sight; a domain added to the list later is held to the genesis from then on.
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
  // Holdings statements that are not tied to the request that asked for them (v1) are read only before this moment, 1 February 2027
  // 00:00 UTC, and never from a domain that has answered with a statement that is tied to its request (v2).
  const LEGACY_UNTIL_MS = Date.UTC(2027, 1, 1);
  const LEGACY_UNTIL_TEXT = '31 January 2027';
  const STALE_AFTER_MS = 30 * 60 * 1000;
  const MAX_UNITS_DIGITS = 13;
  const MAX_PENDING = 20;
  const GENESIS_KEPT = 200;
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

  async function sha256Hex(text) {
    return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
  }

  // Two spellings of one P-256 key.
  function sameKey(a, b) {
    const x = spkiOfPem(a), y = spkiOfPem(b);
    return !!x && !!y && toHex(x) === toHex(y);
  }

  // The bytes a roster domain signs to approve an entry (the same text as ledger_approval_bytes in the PHP ledger).
  function approvalText(coinId, index, hash) {
    return canonical({ type: 'atlas.ledger.entry.approval', v: 1, coinId, index, hash });
  }

  // The bytes a domain signs in signature format 2 (the same text as sigformat_genesis_bytes and sigformat_entry_bytes in the PHP ledger). The
  // `v:1` inside is the version of the message; "format 2" is the signature format. Format 1 signed the bare 64-character hex digest or hash.
  function genesisSigText(coinId, digest, domain) {
    return canonical({ type: 'atlas.ledger.genesis.signature', v: 1, coinId, digest, domain });
  }
  function entrySigText(coinId, index, hash, domain) {
    return canonical({ type: 'atlas.ledger.entry.authority', v: 1, coinId, index, hash, domain });
  }
  // Which format a signature is in: 'v2', 'legacy', or null when it verifies in neither. Format 1 is read only for a bare lowercase hex hash.
  async function signatureKind(pem, v2Text, bare, signature) {
    if (await verifyDomainSignature(pem, v2Text, signature)) return 'v2';
    return /^[a-f0-9]{64}$/.test(bare) && await verifyDomainSignature(pem, bare, signature) ? 'legacy' : null;
  }

  // A genesis in the form the ledger writes: one to five distinct domains with P-256 keys, the authority first, and a threshold that fits the mode.
  // Returns { authority, threshold, keys: {domain: pem}, domains: [domain] } or null.
  function readGenesis(g, coinId) {
    if (!isObject(g) || g.type !== 'atlas.ledger.genesis' || g.v !== 1 || g.coinId !== coinId || !MODES.includes(g.mode)) return null;
    if (!Array.isArray(g.roster) || g.roster.length < 1 || g.roster.length > 5) return null;
    const keys = {};
    const domains = [];
    for (const m of g.roster) {
      if (!isObject(m) || typeof m.domain !== 'string' || normalizeDomain(m.domain) !== m.domain || keys[m.domain] !== undefined || !spkiOfPem(m.key)) return null;
      keys[m.domain] = m.key;
      domains.push(m.domain);
    }
    if (g.authority !== domains[0]) return null;
    if (g.mode === 'single' ? (domains.length !== 1 || g.threshold !== 1) : (domains.length < 2 || !Number.isInteger(g.threshold) || g.threshold < 2 || g.threshold > domains.length)) return null;
    return { authority: g.authority, threshold: g.threshold, keys, domains };
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

  const NONCE_RE = /^[a-f0-9]{32}$/;
  const STATEMENT_KEYS_V1 = 'asOf,coins,domain,key,proven,type,v';
  const STATEMENT_KEYS_V2 = 'asOf,coins,domain,key,nonce,proven,type,v';

  // The statement a domain signed: for this domain and this key, recent, in a form this wallet reads. `proven` says whether
  // the domain saw a request this key signed, so a public lookup can never show private coins as proven.
  //
  // `expect` is what the wallet knows about the request: `nonce`, the one it sent, and `pinned`, whether this domain has answered with
  // a statement tied to its request before. A v2 statement is accepted only with exactly the nonce that was sent, which the domain
  // signed, so an answer captured earlier cannot answer a later request. A v1 statement is not tied to anything: it is read only from
  // a domain not known to answer in v2 and only before LEGACY_UNTIL_MS, and the result says so (`bound: false`).
  async function checkHoldings(answer, pem, domain, key, nowMs, wantProven, expect) {
    if (!isObject(answer) || !isObject(answer.statement)) return { ok: false, reason: 'unreadable' };
    const s = answer.statement;
    const want = isObject(expect) ? expect : {};
    const shape = Object.keys(s).sort().join(',');
    const bound = s.v === 2;
    if (bound ? shape !== STATEMENT_KEYS_V2 : shape !== STATEMENT_KEYS_V1) return { ok: false, reason: 'unreadable' };
    if (bound && (typeof s.nonce !== 'string' || !NONCE_RE.test(s.nonce))) return { ok: false, reason: 'unreadable' };
    if (s.type !== 'atlas.ledger.holdings' || (s.v !== 1 && s.v !== 2) || s.domain !== domain || s.key !== key || s.proven !== wantProven) return { ok: false, reason: 'not-for-this-request' };
    if (bound && s.nonce !== want.nonce) return { ok: false, reason: 'not-for-this-request' };
    let text;
    try { text = canonical(s); } catch (err) { return { ok: false, reason: 'unreadable' }; }
    if (!await verifyDomainSignature(pem, text, answer.signature)) return { ok: false, reason: 'bad-signature' };
    if (!bound && want.pinned === true) return { ok: false, reason: 'downgrade' };
    if (!bound && nowMs >= LEGACY_UNTIL_MS) return { ok: false, reason: 'legacy-ended' };
    const at = typeof s.asOf === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s.asOf) ? Date.parse(s.asOf) : NaN;
    if (Number.isNaN(at)) return { ok: false, reason: 'unreadable' };
    if (at > nowMs + CLOCK_SKEW_S * 1000) return { ok: false, reason: 'clock' };
    if (nowMs - at > STATEMENT_MAX_AGE_S * 1000) return { ok: false, reason: 'clock' };
    if (!Array.isArray(s.coins) || s.coins.length > MAX_COINS_PER_DOMAIN) return { ok: false, reason: 'unreadable' };
    const coins = [];
    for (const c of s.coins) { const read = readCoin(c); if (!read) return { ok: false, reason: 'unreadable' }; coins.push(read); }
    return { ok: true, asOf: s.asOf, proven: s.proven, coins, bound };
  }

  // ---------- what the person is told ----------

  const PROBLEMS = {
    'bad-signature': 'The answer was not signed by the key pinned for this domain, so it was ignored.',
    'not-for-this-request': 'The answer was not for this domain, this key and this request, so it was ignored.',
    downgrade: 'This domain has answered before with holdings that are tied to each request, and has now answered in the earlier form, which is not. The answer was ignored and nothing the wallet pinned for this domain was changed. If its server was rolled back, its operator should redeploy the current version; there is no need to remove the domain.',
    'legacy-ended': 'This domain still answers in the earlier holdings form, which this wallet stopped accepting on 1 February 2027. Its operator needs to update the server.',
    unreadable: 'The answer was not in a form the wallet reads, so it was ignored.',
    clock: 'The answer\'s time does not match this device\'s clock. Check the clock and try again.',
    network: 'The domain did not answer.',
    'rollback-suspected': 'This domain now reports an older state of this coin than it did before. Its database may have been restored from a backup, which can bring back balances that were already spent. Nothing is sent or bought on this coin until the domain recovers or you decide to trust the new state.',
    'history-conflict': 'This domain now reports a different history for this coin than the one it reported before. Nothing is sent or bought on this coin until the difference is explained or you decide to trust the new state.',
    'coin-missing': 'This domain no longer lists a coin it listed before. Its database may have been restored from an older backup. Nothing is sent or bought on this coin until the domain recovers or you decide to trust the new state.',
    'history-unproven': 'This domain reports newer entries for this coin but does not show that they continue the history it reported before, so they are not trusted yet. Nothing is sent or bought on this coin until it does.',
    'proof-unsupported': 'This identity cannot sign for a ledger, so only public coins are shown.',
    'genesis-changed': 'This domain now describes this coin differently from the first time the wallet saw it, so nothing was signed.',
    'wrong-genesis': 'The domain\'s description of this coin could not be verified, so nothing was signed.',
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
    'not-enough-approvals': 'The partner domains did not approve the transfer.',
    'legacy-authorization': 'This domain no longer takes transfers in the old form. Update the wallet and try again.',
    'wrong-authority': 'The domain says this transfer was signed for a different domain. Nothing was sent.',
    'wrong-genesis': 'The domain says this transfer was signed for a different version of the coin. Nothing was sent.',
    'unknown-base': 'The domain does not recognise the balance this transfer was made from. Refresh and try again.',
    'rollback-detected': 'The domain has found that its own database was restored from an older copy, and has stopped this coin until that is sorted out. Nothing was sent.',
    'checkpoint-conflict': 'The domain has found that its database holds a different history from the one it recorded, and has stopped this coin. Nothing was sent.',
    'checkpoint-corrupt': 'The domain\'s integrity record is damaged, so it has stopped this coin until the operator repairs it. Nothing was sent.',
    'checkpoint-unavailable': 'The domain could not record the transfer safely, so it did not make it. Try again later.',
    'rollback-suspected': 'This domain now reports an older state of this coin than it did before. Nothing is sent until it recovers or you decide to trust the new state.',
    'history-conflict': 'This domain now reports a different history for this coin than before. Nothing is sent until the difference is explained or you decide to trust the new state.',
    'coin-missing': 'This domain no longer lists this coin. Nothing is sent until it recovers or you decide to trust the new state.',
    'history-unproven': 'This domain does not show that its newer entries continue the history it reported before. Nothing is sent until it does.',
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
    'unknown-coin': 'The domain does not know this coin.',
    'legacy-authorization': 'This domain no longer takes purchases in the old form. Update the wallet and try again.',
    'wrong-authority': 'The domain says this purchase was signed for a different domain. Nothing was bought.',
    'wrong-genesis': 'The domain says this purchase was signed for a different version of the coin. Nothing was bought.',
    'rollback-detected': 'The domain has found that its own database was restored from an older copy, and has stopped this coin. Nothing was bought.',
    'checkpoint-conflict': 'The domain has found that its database holds a different history from the one it recorded, and has stopped this coin. Nothing was bought.',
    'checkpoint-corrupt': 'The domain\'s integrity record is damaged, so it has stopped this coin until the operator repairs it. Nothing was bought.',
    'checkpoint-unavailable': 'The domain could not record the purchase safely, so it did not make it. Try again later.',
    'rollback-suspected': 'This domain now reports an older state of this coin than it did before. Nothing is bought until it recovers or you decide to trust the new state.',
    'history-conflict': 'This domain now reports a different history for this coin than before. Nothing is bought until the difference is explained or you decide to trust the new state.',
    'coin-missing': 'This domain no longer lists this coin. Nothing is bought until it recovers or you decide to trust the new state.',
    'history-unproven': 'This domain does not show that its newer entries continue the history it reported before. Nothing is bought until it does.',
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

    // `ownerKey`, when given, names the identity the change is for. The cache belongs to whichever identity is active when it is
    // read and written, so a change begun for one identity is refused rather than applied to another after a switch.
    function identityChanged() {
      return Object.assign(new Error('The wallet is acting as a different identity now.'), { code: 'identity-changed' });
    }

    function mutateCache(fn, ownerKey) {
      return serial(async () => {
        if (ownerKey && (await env.ownerKey()) !== ownerKey) throw identityChanged();
        const c = await cache();
        const out = await fn(c);
        await env.saveCache(c, ownerKey);
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

    // One lookup. A private-coin lookup is signed over a fresh challenge from the domain, which it also sends as its nonce; a wallet that
    // cannot sign for a ledger asks for public coins only, with a random nonce of its own. The statement that comes back must carry that
    // nonce under the domain's signature. A domain that has once answered that way is recorded, and is not read in the earlier form
    // again, whatever it answers or fails to answer later.
    async function lookupOnce(record, key, allowSigned) {
      const current = (await domains()).find((d) => d.domain === record.domain) || record;
      const pinned = isObject(current.holdings) && current.holdings.v === 2;
      let nonce = randomHex(16);
      let body = { key, nonce };
      let signed = false;
      if (allowSigned) {
        const ch = await request(record.domain, 'POST', 'action=challenge', {});
        if (ch.status !== 200 || !ch.json || !NONCE_RE.test(ch.json.challenge || '')) return { ok: false, reason: 'network' };
        let envelope;
        try { envelope = await env.sign({ type: 'atlas.ledger.holdings.request', v: 1, domain: record.domain, key, challenge: ch.json.challenge }); } catch (err) { return { ok: false, reason: 'proof-unsupported' }; }
        if (!envelope || envelope.publicKey !== key || typeof envelope.signature !== 'string') return { ok: false, reason: 'proof-unsupported' };
        nonce = ch.json.challenge;
        body = { key, nonce, request: { payload: { type: 'atlas.ledger.holdings.request', v: 1, domain: record.domain, key, challenge: ch.json.challenge }, signature: envelope.signature } };
        signed = true;
      }
      const r = await request(record.domain, 'POST', 'action=holdings', body);
      if (r.status !== 200 || !r.json || r.json.ok !== true) return { ok: false, reason: r.status === 0 ? 'network' : 'unreadable' };
      const checked = await checkHoldings(r.json, record.key, record.domain, key, nowMs(), signed, { nonce, pinned });
      if (!checked.ok) return checked;
      if (checked.bound && !pinned) await pinHoldings(record.domain);
      return Object.assign({ signed }, checked);
    }

    // Records that a domain answered with a statement tied to its request. The mark is part of the domain's record, so it is in the
    // wallet backup, and nothing in the wallet removes it.
    function pinHoldings(domain) {
      return serial(async () => {
        const list = await domains();
        if (!list.some((d) => d.domain === domain && !(isObject(d.holdings) && d.holdings.v === 2))) return;
        await env.saveDomains(list.map((d) => (d.domain === domain ? Object.assign({}, d, { holdings: { v: 2, since: iso(nowMs()) } }) : d)));
      });
    }

    // ---------- the highest head a domain has shown ----------

    // A domain's database can be put back from an older copy, which brings back balances that were already spent. The statements a
    // domain signs name the newest entry it holds for each coin, so the wallet keeps the highest one it has verified, per domain and
    // coin, with the list of domains (and so in its backup). A later statement that holds a lower entry, another hash at the same
    // entry, or no longer lists the coin is not believed: the coin is marked and takes no send or purchase until the head
    // comes back to the kept one on the same history, or the person says to trust the new state.
    const HEADS_KEPT = 200;

    function headNote(h) { return { index: h.index, hash: h.hash }; }

    // The domain's signed head for a coin (the newest entry, or the one at an index), checked against the key pinned for the domain.
    // null when the domain does not answer, answers in another form, or answers for another entry than the one asked for.
    async function verifiedHead(record, coinId, index, meta) {
      const r = await request(record.domain, 'GET', 'action=head&coin=' + coinId + (index === null ? '' : '&index=' + index));
      if (meta) meta.reached = r.status > 0 && r.status < 500;
      const head = r.json && r.json.ok === true ? r.json.head : null;
      const payload = isObject(head) ? head.payload : null;
      if (!isObject(payload) || payload.type !== 'atlas.ledger.head' || payload.coinId !== coinId || payload.domain !== record.domain || !Number.isInteger(payload.index) || payload.index < 0 || (index !== null && payload.index !== index) || !HASH_RE.test(payload.hash || '') || typeof payload.issuedAt !== 'string') return null;
      let text;
      try { text = canonical(payload); } catch (err) { return null; }
      if (!await verifyDomainSignature(record.key, text, head.signature)) return null;
      return payload;
    }

    // Asks the domain for its signed head at an index, to see whether the history that reached it passes through the kept entry.
    // true: it does. false: another hash is held there. null: the domain cannot say (an older server, or no answer).
    async function headAt(record, coinId, index, hash, meta) {
      const payload = await verifiedHead(record, coinId, index, meta);
      return payload === null ? null : payload.hash === hash;
    }

    // What one statement says about one coin against the kept head: new, same, progress (a higher head that extends the kept one),
    // older (a statement older than the kept one, ignored), unproven (a higher head the domain does not show to extend the kept
    // one), rollback or conflict.
    async function judgeHead(record, kept, c, asOfMs) {
      if (!kept) return { kind: 'new' };
      if (asOfMs < kept.asOf) return { kind: 'older' };
      if (c.headIndex < kept.index) return { kind: 'rollback' };
      if (c.headIndex === kept.index) return { kind: c.headHash === kept.hash ? 'same' : 'conflict' };
      // A higher head is believed only when the domain shows, signed, that its history holds the kept entry. A domain that cannot or
      // will not say is not believed either: the kept head stays where it was.
      const same = await headAt(record, c.coinId, kept.index, kept.hash);
      return { kind: same === true ? 'progress' : same === false ? 'conflict' : 'unproven' };
    }

    // Weighs a verified statement against the kept heads, keeps the higher, and marks what is wrong. Returns the verdict per coin.
    async function observe(record, got) {
      const asOfMs = Date.parse(got.asOf);
      const kept = (await recordFor(record.domain)).heads || {};
      const verdicts = {};
      for (const c of got.coins) verdicts[c.coinId] = await judgeHead(record, isObject(kept[c.coinId]) ? kept[c.coinId] : null, c, asOfMs);
      // A coin the domain showed before and now leaves out, when the statement is one that would list it.
      for (const coinId of Object.keys(kept)) {
        if (got.partial || verdicts[coinId] || !isObject(kept[coinId])) continue;
        if ((got.signed || kept[coinId].isPublic === true) && asOfMs >= kept[coinId].asOf) verdicts[coinId] = { kind: 'missing' };
      }
      await serial(async () => {
        const list = await domains();
        const entry = list.find((d) => d.domain === record.domain);
        if (!entry) return;
        const heads = isObject(entry.heads) ? Object.assign({}, entry.heads) : {};
        for (const c of got.coins) {
          const v = verdicts[c.coinId];
          const prior = isObject(heads[c.coinId]) ? heads[c.coinId] : null;
          if (v.kind === 'new' || v.kind === 'progress' || v.kind === 'same') {
            heads[c.coinId] = { index: c.headIndex, hash: c.headHash, asOf: asOfMs, isPublic: c.visibility === undefined ? !!(prior && prior.isPublic) : c.visibility === 'public' };
          } else if (prior && (v.kind === 'rollback' || v.kind === 'conflict')) {
            heads[c.coinId] = Object.assign({}, prior, { suspect: { kind: v.kind === 'rollback' ? 'rollback-suspected' : 'history-conflict', index: c.headIndex, hash: c.headHash, asOf: asOfMs, seenAt: nowMs() } });
          }
        }
        for (const coinId of Object.keys(verdicts)) {
          if (verdicts[coinId].kind === 'missing' && isObject(heads[coinId])) heads[coinId] = Object.assign({}, heads[coinId], { suspect: { kind: 'coin-missing', index: -1, hash: null, asOf: asOfMs, seenAt: nowMs() } });
        }
        const ids = Object.keys(heads);
        if (ids.length > HEADS_KEPT) for (const id of ids.slice(0, ids.length - HEADS_KEPT)) delete heads[id];
        await env.saveDomains(list.map((d) => (d.domain === record.domain ? Object.assign({}, d, { heads }) : d)));
      });
      return verdicts;
    }

    // The mark on a coin, if any: what to tell the person and the heads involved.
    function integrityOf(record, coinId) {
      const kept = isObject(record && record.heads) ? record.heads[coinId] : null;
      const sus = isObject(kept) ? kept.suspect : null;
      if (!isObject(sus)) return null;
      return { code: sus.kind, message: PROBLEMS[sus.kind], trusted: headNote(kept), seen: { index: sus.index, hash: sus.hash } };
    }

    // For a purchase, which spends Gold before anything else is checked: the domain's own signed newest head, weighed against the kept
    // one now, not against what an earlier lookup left. A coin the wallet has kept no head for is not held back.
    async function checkHeadNow(record, coinId) {
      const kept = isObject((await recordFor(record.domain)).heads) ? (await recordFor(record.domain)).heads[coinId] : null;
      const payload = await verifiedHead(record, coinId, null);
      if (!payload) {
        if (isObject(kept)) throw Object.assign(new Error(PROBLEMS['history-unproven']), { code: 'history-unproven' });
        return;
      }
      const verdicts = await observe(record, { asOf: payload.issuedAt, signed: false, partial: true, coins: [{ coinId, headIndex: payload.index, headHash: payload.hash }] });
      await assertIntegrity(record, coinId);
      if (verdicts[coinId] && verdicts[coinId].kind === 'unproven') throw Object.assign(new Error(PROBLEMS['history-unproven']), { code: 'history-unproven' });
    }

    async function assertIntegrity(record, coinId) {
      const mark = integrityOf((await recordFor(record.domain)), coinId);
      if (mark) throw Object.assign(new Error(mark.message), { code: mark.code });
    }

    // The person trusts what the domain says now: the lower or different head becomes the kept one. This is what accepting a
    // domain's recovery or its loss looks like; nothing else clears the mark but the domain showing the kept entry again. It is
    // never done on its own: the caller must repeat the head the person was shown, and a domain that has said something else since is
    // refused, so what is accepted is exactly what was on the screen.
    async function acceptHead(domain, coinId, confirm) {
      if (!isObject(confirm) || !Number.isInteger(confirm.index) || !(confirm.hash === null || HASH_RE.test(confirm.hash || ''))) throw Object.assign(new Error('Accepting a domain\'s state needs the state that was shown to be repeated.'), { code: 'confirm-needed' });
      const record = await recordFor(domain);
      await serial(async () => {
        const list = await domains();
        const entry = list.find((d) => d.domain === record.domain);
        const kept = entry && isObject(entry.heads) ? entry.heads[coinId] : null;
        if (!isObject(kept) || !isObject(kept.suspect)) throw Object.assign(new Error('There is nothing to accept for that coin.'), { code: 'nothing-to-accept' });
        if (kept.suspect.index !== confirm.index || kept.suspect.hash !== confirm.hash) throw Object.assign(new Error('The domain has said something else since it was shown to you. Look at it again before you decide.'), { code: 'confirm-mismatch' });
        const heads = Object.assign({}, entry.heads);
        if (kept.suspect.kind === 'coin-missing') delete heads[coinId];
        else heads[coinId] = { index: kept.suspect.index, hash: kept.suspect.hash, asOf: kept.suspect.asOf, isPublic: kept.isPublic === true };
        await env.saveDomains(list.map((d) => (d.domain === record.domain ? Object.assign({}, d, { heads }) : d)));
      });
    }

    async function lookup(domain) {
      const record = await recordFor(domain);
      const key = await env.ownerKey();
      if (!key) throw Object.assign(new Error('Unlock your wallet first.'), { code: 'locked' });
      let got = await lookupOnce(record, key, true);
      if (!got.ok && got.reason === 'proof-unsupported') got = await lookupOnce(record, key, false);
      if (got.ok) await observe(record, got).catch(() => null);
      // A domain taken off the list while it was being asked is not put back by its answer, and an answer for a key the
      // wallet has since stopped acting as is dropped instead of being stored under the identity that is active now.
      const answer = await mutateCache(async (c) => {
        if (!(await domains()).some((d) => d.domain === record.domain)) return null;
        const prior = c.answers[record.domain];
        c.answers[record.domain] = got.ok
          ? { asOf: got.asOf, proven: got.proven, coins: got.coins, fetchedAt: nowMs(), problem: null, bound: got.bound === true }
          : Object.assign({}, prior || { asOf: null, proven: false, coins: [], fetchedAt: null }, { problem: got.reason });
        return c.answers[record.domain];
      }, key).catch((err) => { if (err && err.code === 'identity-changed') return null; throw err; });
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
      // The list and the cache are separate reads; both must be the same identity's.
      const readFor = await env.ownerKey();
      const list = await domains();
      const c = await cache();
      if ((await env.ownerKey()) !== readFor) throw identityChanged();
      const out = [];
      for (const d of list) {
        const a = c.answers[d.domain];
        const pinned = isObject(d.holdings) && d.holdings.v === 2;
        out.push({
          legacy: !pinned && !!a && a.fetchedAt !== null && a.bound === false, legacyUntil: LEGACY_UNTIL_TEXT,
          domain: d.domain, fingerprint: d.fingerprint || '', addedAt: d.addedAt, asOf: a ? a.asOf : null, fetchedAt: a ? a.fetchedAt : null, proven: !!(a && a.proven),
          problem: a && a.problem ? PROBLEMS[a.problem] || PROBLEMS.network : null, never: !a || a.fetchedAt === null,
          stale: !a || a.fetchedAt === null || nowMs() - a.fetchedAt > STALE_AFTER_MS || !!a.problem,
          coins: a ? a.coins.map((coin) => Object.assign({ amount: formatUnits(coin.units, coin.decimals), integrity: integrityOf(d, coin.coinId) }, coin)) : []
        });
      }
      return { domains: out, pendingSends: c.pendingSends, pendingBuys: c.pendingBuys.map((p) => ({ domain: p.domain, coinId: p.coinId, requestId: p.requestId, price: p.price, symbol: p.symbol, decimals: p.decimals, units: p.units, note: p.note || '', state: p.state || 'waiting', reason: p.reason || '', createdAt: p.createdAt })) };
    }

    // ---------- sending ----------

    async function freshCoin(record, coinId) {
      const key = await env.ownerKey();
      let got = await lookupOnce(record, key, true);
      if (!got.ok && got.reason === 'proof-unsupported') got = await lookupOnce(record, key, false);
      if (!got.ok) throw Object.assign(new Error(PROBLEMS[got.reason] || PROBLEMS.network), { code: got.reason });
      // The statement is weighed against the heads the domain showed before, so a rolled back domain is found at the moment of sending
      // and not only at the next refresh.
      const verdicts = await observe(record, got).catch(() => null);
      await assertIntegrity(record, coinId);
      if (verdicts && verdicts[coinId] && verdicts[coinId].kind === 'unproven') throw Object.assign(new Error(PROBLEMS['history-unproven']), { code: 'history-unproven' });
      const coin = got.coins.find((c) => c.coinId === coinId);
      if (!coin) throw Object.assign(new Error('This domain no longer lists that coin for you.'), { code: 'unknown-coin' });
      return { coin, key, bound: got.bound === true };
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

    // The genesis of a coin as a domain shows it, checked before anything depends on it. The digest is worked out here; the key in the genesis
    // for this domain is the key pinned for it, and the keys of other domains on the list are theirs. The first time a coin is seen, its
    // first entry must show that the authority signed it and that every roster domain signed this genesis; the digest is then pinned with
    // the domain's record. Afterwards a genesis with another digest under the same coin id is refused. Returns what the receipts and the
    // purchase terms are checked against.
    async function verifiedGenesis(listed, coinId) {
      // The record as it is now, with the pins made since the caller read it.
      const record = await recordFor(listed.domain);
      const r = await request(record.domain, 'GET', 'action=coin&coin=' + coinId);
      if (r.status === 0) throw Object.assign(new Error(PROBLEMS.network), { code: 'network' });
      const g = r.json && r.json.ok ? r.json.genesis : null;
      if (!isObject(g) || g.coinId !== coinId || typeof g.authority !== 'string' || !g.authority) throw Object.assign(new Error(SEND_PROBLEMS['unknown-coin']), { code: 'unknown-coin' });
      let digest;
      try { digest = await sha256Hex(canonical(g)); } catch (err) { digest = ''; }
      if (!HASH_RE.test(digest) || digest !== r.json.genesisDigest) throw Object.assign(new Error('The domain\'s description of this coin does not match its digest, so nothing was signed.'), { code: 'wrong-genesis' });
      const named = Array.isArray(g.roster) ? g.roster.map((m) => (isObject(m) ? m.domain : null)) : [];
      if (g.authority !== record.domain && !named.includes(record.domain)) throw Object.assign(new Error(SEND_PROBLEMS['wrong-authority']), { code: 'wrong-authority' });
      const read = readGenesis(g, coinId);
      if (!read) throw Object.assign(new Error(PROBLEMS['wrong-genesis']), { code: 'wrong-genesis' });
      const pin = isObject(record.genesis) && isObject(record.genesis[coinId]) ? record.genesis[coinId] : null;
      if (pin && pin.digest !== digest) throw Object.assign(new Error(PROBLEMS['genesis-changed']), { code: 'genesis-changed' });
      // A key in the genesis for a domain the wallet has pinned a key for must be that key.
      const list = await domains();
      for (const d of read.domains) {
        const known = list.find((x) => x.domain === d);
        if (known && !sameKey(known.key, read.keys[d])) throw Object.assign(new Error('The genesis names another key for ' + d + ' than the one pinned for it, so nothing was signed.'), { code: 'wrong-genesis' });
      }
      if (!pin) {
        const opened = await checkGenesisEntry(record, g, digest, read);
        await pinGenesis(record.domain, coinId, { digest, authority: read.authority, threshold: read.threshold, roster: read.domains, unpinned: read.domains.filter((d) => d !== record.domain && !list.some((x) => x.domain === d)), pinnedAt: iso(nowMs()), v2From: opened.entryZero === 'v2' ? 0 : null });
      }
      // Where the coin's authority signatures moved to format 2, as far as this wallet has seen: format 1 is not accepted from there on.
      const held = (await recordFor(record.domain)).genesis;
      const pinned = pin || (isObject(held) ? held[coinId] : null);
      const seen = isObject(pinned) ? pinned.v2From : null;
      return { genesis: g, digest, authority: read.authority, threshold: read.threshold, keys: read.keys, raw: r.json, v2From: Number.isInteger(seen) ? seen : null };
    }

    // The coin's first entry, from the domain: the authority signed it, and every roster domain signed this genesis digest. It is what
    // shows that the domains of the roster, and not only the one being asked, agreed on the coin and its terms.
    async function checkGenesisEntry(record, g, digest, read) {
      const bad = () => Object.assign(new Error('The coin\'s first entry does not show that its domains signed this description, so nothing was signed.'), { code: 'wrong-genesis' });
      const r = await request(record.domain, 'GET', 'action=receipt&coin=' + g.coinId + '&index=0');
      if (r.status === 0) throw Object.assign(new Error(PROBLEMS.network), { code: 'network' });
      const rc = r.json && r.json.ok ? r.json.receipt : null;
      const e = isObject(rc) ? rc.entry : null;
      if (!isObject(e) || e.type !== 'genesis' || e.index !== 0 || e.coinId !== g.coinId || e.prevHash !== digest || !HASH_RE.test(rc.hash || '')) throw bad();
      let hash;
      try { hash = await sha256Hex(canonical(e)); } catch (err) { throw bad(); }
      if (hash !== rc.hash) throw bad();
      // Entry 0 is in format 2 on a coin opened in it, and then every genesis signature must be in format 2 too; a coin from before has format 1 throughout.
      const zero = await signatureKind(read.keys[read.authority], entrySigText(g.coinId, 0, rc.hash, read.authority), rc.hash, rc.authoritySignature);
      if (zero === null) throw bad();
      const signed = new Set();
      for (const a of Array.isArray(rc.approvals) ? rc.approvals : []) {
        const key = isObject(a) && typeof a.domain === 'string' ? read.keys[a.domain] : undefined;
        const kind = key === undefined ? null : await signatureKind(key, genesisSigText(g.coinId, digest, a.domain), digest, a.signature);
        if (kind === null || signed.has(a.domain) || (zero === 'v2' && kind !== 'v2')) throw bad();
        signed.add(a.domain);
      }
      if (read.domains.some((d) => !signed.has(d))) throw bad();
      return { entryZero: zero };
    }

    function pinGenesis(domain, coinId, pin) {
      return serial(async () => {
        const list = await domains();
        const entry = list.find((d) => d.domain === domain);
        if (!entry) return;
        const kept = isObject(entry.genesis) ? Object.assign({}, entry.genesis) : {};
        if (isObject(kept[coinId])) return;
        kept[coinId] = pin;
        const ids = Object.keys(kept);
        if (ids.length > GENESIS_KEPT) for (const id of ids.slice(0, ids.length - GENESIS_KEPT)) delete kept[id];
        await env.saveDomains(list.map((d) => (d.domain === domain ? Object.assign({}, d, { genesis: kept }) : d)));
      });
    }

    // Remembers the lowest index at which this wallet has seen a verified format 2 authority signature on a coin, so that an authority signature in
    // format 1 at or after it is refused for a single receipt as it is for a whole chain. It only ever moves down.
    function pinV2From(domain, coinId, index) {
      return serial(async () => {
        const list = await domains();
        const entry = list.find((d) => d.domain === domain);
        const pin = entry && isObject(entry.genesis) ? entry.genesis[coinId] : null;
        if (!isObject(pin) || (Number.isInteger(pin.v2From) && pin.v2From <= index)) return;
        const kept = Object.assign({}, entry.genesis, { [coinId]: Object.assign({}, pin, { v2From: index }) });
        await env.saveDomains(list.map((d) => (d.domain === domain ? Object.assign({}, d, { genesis: kept }) : d)));
      });
    }

    // What a signature must name besides the coin id, which another domain can reuse: the domain that issues the coin and the digest of its
    // genesis, from the verified genesis. A domain that is neither the coin's authority nor on its roster has no business taking the signature.
    async function coinBinding(record, coinId) {
      const v = await verifiedGenesis(record, coinId);
      return { authority: v.authority, genesis: v.digest };
    }

    async function signTransfer(record, prepared) {
      const { coin, key } = await freshCoin(record, prepared.coinId);
      const binding = await coinBinding(record, prepared.coinId);
      if (BigInt(prepared.amount) > BigInt(coin.units)) throw Object.assign(new Error(SEND_PROBLEMS.insufficient), { code: 'insufficient' });
      const t = nowMs();
      const payload = { type: 'atlas.ledger.transfer', v: 2, coinId: prepared.coinId, authority: binding.authority, genesis: binding.genesis, from: key, to: prepared.to, amount: prepared.amount, baseSeq: coin.seq, baseHead: coin.headHash, nonce: randomHex(16), issuedAt: iso(t - 5000), expiresAt: iso(t + TRANSFER_WINDOW_S * 1000) };
      const envelope = await env.sign(payload);
      if (!envelope || envelope.publicKey !== key || typeof envelope.signature !== 'string') throw Object.assign(new Error(PROBLEMS['proof-unsupported']), { code: 'proof-unsupported' });
      return { payload, signature: envelope.signature };
    }

    // A transfer the domain has taken is kept in the cache until its outcome is verified. It is never dropped because its receipt could not be
    // verified: it stays, with the signed authorization and the digest that names it, and is marked `unconfirmed` when the receipt failed or left
    // waiting when the receipt could only not be checked yet. Nothing here sends a transfer again.
    const UNCONFIRMED_NOTE = 'The wallet has not counted it as made or as failed, and will not send it again.';
    // A transfer is kept, signed and named by its digest, before it leaves the wallet, as `unknown`: the request may be lost on the way
    // or its answer may never arrive, and the domain may have made the transfer either way. It is settled only by the domain's own answer
    // about that digest, or, once the authorization has lapsed, by the signed holdings showing the sender's account where it was.
    // The codes with which a domain refuses a transfer it did not make: it was refused before anything was stored, or the stored proposal was
  // closed. Others a domain can answer with (busy, wrong-index, a code this wallet does not know) leave a proposal stored that may still be made.
  const REFUSAL_CODES = new Set(['stale', 'insufficient', 'expired', 'pending-exists', 'bad-signature', 'bad-authorization', 'no-account', 'replayed',
    'legacy-authorization', 'wrong-authority', 'wrong-genesis', 'unknown-base', 'unknown-coin', 'not-authority']);
  const AMBIGUOUS_STATUS = new Set([408, 425, 429]);
  function isRefusal(status, j) {
    return status >= 400 && status < 500 && !AMBIGUOUS_STATUS.has(status) && isObject(j) && j.ok === false && typeof j.code === 'string' && REFUSAL_CODES.has(j.code);
  }
  const UNKNOWN_NOTE = 'The domain did not answer, so the transfer may or may not have been made. The wallet keeps it and will not send it again.';
    const UNSEEN_SETTLE_MS = 600000;
    const MAX_UNRESOLVED = 50;
    const isUnresolved = (p) => p.state === 'unconfirmed' || p.state === 'unknown';
    function capPending(list) {
      const keep = list.filter(isUnresolved);
      const rest = list.filter((p) => !isUnresolved(p)).slice(-MAX_PENDING);
      return list.filter((p) => keep.includes(p) || rest.includes(p));
    }
    function pendingSendOf(record, prepared, authorization, digest, extra) {
      return Object.assign({ domain: record.domain, coinId: prepared.coinId, digest, to: prepared.to, amount: prepared.amount, from: prepared.from, symbol: prepared.symbol, decimals: prepared.decimals, private: prepared.private, authorization, createdAt: nowMs() }, extra || {});
    }
    function keepPendingSend(item, ownerKey) {
      return mutateCache((c) => {
        const held = c.pendingSends.find((p) => p.digest === item.digest);
        c.pendingSends = capPending(c.pendingSends.filter((p) => p.digest !== item.digest).concat([held ? Object.assign({}, held, item, { createdAt: held.createdAt }) : item]));
      }, ownerKey);
    }

    function dropPendingSend(digest, ownerKey) {
      return mutateCache((c) => { c.pendingSends = c.pendingSends.filter((p) => p.digest !== digest); }, ownerKey);
    }

    function receiptMatches(receipt, expect) {
      const e = isObject(receipt) ? receipt.entry : null;
      // A private coin's entry names accounts by reference, which only the domains can compute, so only the coin, the amount and the purchase are compared.
    const parties = expect.private ? true : e && e.to === expect.to && (expect.from === undefined || e.from === expect.from);
    return !!(isObject(e) && e.coinId === expect.coinId && parties && e.amount === expect.amount && (!expect.purchase || (isObject(e.purchase) && e.purchase.requestId === expect.purchase.requestId && e.purchase.price === expect.purchase.price)));
    }

    const unverified = (why) => Object.assign(new Error('The domain\'s receipt could not be verified (' + why + '), so it was not accepted.'), { code: 'bad-receipt', reason: why });

    // The receipt of an entry against the coin's verified genesis: the entry is the one the hash names, the authority signed that hash, and
    // enough distinct roster domains (the authority counting once) approved it. Throws bad-receipt, with the reason, when any part is missing
    // or does not verify; nothing is read as it stands.
    async function verifyReceipt(record, coinId, receipt) {
      let v;
      try { v = await verifiedGenesis(record, coinId); } catch (err) {
        throw Object.assign(unverified('the coin\'s genesis could not be verified: ' + (err && err.message ? err.message : 'unknown')), { cause: err, unchecked: !!err && err.code === 'network' });
      }
      const e = isObject(receipt) ? receipt.entry : null;
      if (!isObject(e) || e.coinId !== coinId || receipt.coinId !== coinId || e.type !== 'transfer' || !Number.isInteger(e.index) || e.index < 1) throw unverified('it is not an entry of this coin');
      if (!HASH_RE.test(receipt.hash || '') || !Array.isArray(receipt.approvals) || receipt.approvals.length > 5) throw unverified('it is missing a part');
      let hash;
      try { hash = await sha256Hex(canonical(e)); } catch (err) { throw unverified('the entry cannot be hashed'); }
      if (hash !== receipt.hash) throw unverified('the hash is not the hash of the entry');
      const kind = await signatureKind(v.keys[v.authority], entrySigText(coinId, e.index, receipt.hash, v.authority), receipt.hash, receipt.authoritySignature);
      if (kind === null) throw unverified(v.authority + ' did not sign it');
      if (kind === 'legacy' && Number.isInteger(v.v2From) && e.index >= v.v2From) throw unverified(v.authority + ' signed it in the older format after the coin moved to the newer one');
      if (kind === 'v2') await pinV2From(record.domain, coinId, e.index);
      const signers = new Set([v.authority]);
      const text = approvalText(coinId, e.index, receipt.hash);
      for (const a of receipt.approvals) {
        if (!isObject(a) || typeof a.domain !== 'string' || v.keys[a.domain] === undefined || signers.has(a.domain)) throw unverified('an approval is not from a distinct domain of the roster');
        if (!await verifyDomainSignature(v.keys[a.domain], text, a.signature)) throw unverified('the approval of ' + a.domain + ' does not verify');
        signers.add(a.domain);
      }
      if (signers.size < v.threshold) throw unverified('it has ' + signers.size + ' of the ' + v.threshold + ' approvals the coin needs');
      // The domain must also show that entry at that place in its own history, in a head statement it signs: an authority can sign any
      // text, but not an entry that is not the one it attests at that index without contradicting itself.
      // A domain that does not answer (no connection, or a server error) leaves the receipt unchecked; one that answers without showing the entry does not.
      const meta = {};
      const shown = await headAt(record, coinId, e.index, receipt.hash, meta);
      if (shown === false) throw unverified('the domain\'s own history holds another entry there');
      if (shown !== true) throw Object.assign(unverified('the domain does not show it in its history'), { unchecked: !meta.reached });
    }

    // A receipt is accepted when it verifies and is for what was asked. Anything else is refused with bad-receipt.
    async function acceptReceipt(record, coinId, receipt, expect) {
      await verifyReceipt(record, coinId, receipt);
      if (!receiptMatches(receipt, expect)) throw Object.assign(new Error('The domain\'s receipt does not match what you signed, so it was not accepted.'), { code: 'bad-receipt', reason: 'it does not match what was signed' });
    }

    // Signs and sends a prepared transfer to the domain. A stale base is made again once.
    async function send(prepared) {
      const record = await recordFor(prepared.domain);
      if ((await cache()).pendingSends.filter(isUnresolved).length >= MAX_UNRESOLVED) throw Object.assign(new Error('Too many transfers are still unresolved. Check them before sending another.'), { code: 'too-many-unresolved' });
      for (let attempt = 0; attempt < 2; attempt++) {
        const authorization = await signTransfer(record, prepared);
        const digest = await sha256Hex(canonical(authorization.payload));
        // The signed transfer is kept before it leaves the wallet. A request that gets no answer may still have been received and made.
        await keepPendingSend(pendingSendOf(record, prepared, authorization, digest, { state: 'unknown', since: nowMs() }), prepared.from);
        const r = await request(record.domain, 'POST', 'action=propose', { authorization });
        const j = r.json || {};
        if (r.status === 201) {
          // The domain says the transfer was made. Whatever its receipt turns out to be, the wallet keeps the transfer until it has an outcome it can verify.
          try {
            if (!j.ok) throw unverified('the answer has no receipt');
            await acceptReceipt(record, prepared.coinId, j.receipt, { coinId: prepared.coinId, to: prepared.to, amount: prepared.amount, from: prepared.from, private: prepared.private });
          } catch (err) {
            if (!err || err.code !== 'bad-receipt') throw err;
            const reason = String(err.reason || '').slice(0, 200);
            if (err.unchecked) {
              await keepPendingSend(pendingSendOf(record, prepared, authorization, digest, { state: 'waiting', note: 'The domain says the transfer was made, but its receipt could not be checked yet.' }), prepared.from);
              return { status: 'waiting', digest, note: 'The domain says the transfer was made, but the wallet could not check its receipt yet (' + reason + '). It keeps the transfer and checks again.' };
            }
            await keepPendingSend(pendingSendOf(record, prepared, authorization, digest, { state: 'unconfirmed', reason, since: nowMs() }), prepared.from);
            throw Object.assign(new Error('The domain says the transfer was made, but its receipt could not be verified (' + reason + '), so the outcome is unconfirmed. ' + UNCONFIRMED_NOTE), { code: 'bad-receipt', reason, unconfirmed: true, digest });
          }
          await dropPendingSend(digest, prepared.from);
          await lookup(record.domain).catch(() => null);
          return { status: 'done', receipt: j.receipt };
        }
        if (r.status === 202 && j.proposal && HASH_RE.test(j.proposal.digest || '')) {
          await keepPendingSend(pendingSendOf(record, prepared, authorization, digest, { state: 'waiting', note: j.note || '' }), prepared.from);
          return { status: 'waiting', digest, note: j.note || '' };
        }
        // Only the domain's refusal of the transfer says it was not made. Any other answer, including a 4xx that a proxy, a rate limit or a
        // transient conflict can produce while the proposal stays stored, leaves it unknown.
        if (!isRefusal(r.status, j)) {
          await keepPendingSend(pendingSendOf(record, prepared, authorization, digest, { state: 'unknown', note: UNKNOWN_NOTE }), prepared.from);
          return { status: 'unknown', digest, note: UNKNOWN_NOTE };
        }
        await dropPendingSend(digest, prepared.from);
        // A refused transfer that the domain says is stale was not made; the next one is signed on the account as it is now.
        if (r.status === 409 && j.code === 'stale' && attempt === 0) continue;
        if (r.status === 409 && j.code === 'not-authority') throw Object.assign(new Error('This coin is spent through ' + (typeof j.authority === 'string' ? j.authority : 'its authority domain') + '. Add that domain to your list and send from there.'), { code: 'not-authority' });
        throw Object.assign(new Error(SEND_PROBLEMS[j.code] || 'The domain did not accept the transfer.'), { code: j.code || 'refused' });
      }
      throw Object.assign(new Error(SEND_PROBLEMS.stale), { code: 'stale' });
    }

    // The same receipt from another domain of the coin's roster that is on the list, for a transfer whose own domain's receipt did not verify.
    // It is checked in full against the pinned genesis (the hash, the authority and the approvals, and that domain's own signed head at that
    // index), so what settles the transfer is history the wallet has verified through a second domain. Only a public coin can be matched this way:
    // a private coin's entries name accounts by references the wallet cannot compute, so its amount alone would match another transfer.
    async function reconcileSend(p, index) {
      if (p.private || !Number.isInteger(index) || index < 1) return null;
      const list = await domains();
      const own = list.find((d) => d.domain === p.domain);
      const pin = own && isObject(own.genesis) && isObject(own.genesis[p.coinId]) ? own.genesis[p.coinId] : null;
      if (!pin || !Array.isArray(pin.roster)) return null;
      for (const d of list) {
        if (d.domain === p.domain || !pin.roster.includes(d.domain)) continue;
        const r = await request(d.domain, 'GET', 'action=receipt&coin=' + p.coinId + '&index=' + index);
        const receipt = r.json && r.json.ok ? r.json.receipt : null;
        try {
          if (!isObject(receipt) || !isObject(receipt.entry) || receipt.entry.index !== index) continue;
          await acceptReceipt(d, p.coinId, receipt, p);
          return d.domain;
        } catch (err) { /* this domain cannot settle it; the next one may */ }
      }
      return null;
    }

    // A transfer the domain says it has no record of. It was not made when the authorization has lapsed (a transfer that arrives after its
    // expiry is refused, with room for a domain's clock to differ) and the signed holdings show the sender's account where it stood when
    // the transfer was signed. Before that, or when the account has moved, nothing says whether the request was received.
    async function settleUnseen(p) {
      const payload = p.authorization && isObject(p.authorization.payload) ? p.authorization.payload : null;
      const expires = payload ? Date.parse(payload.expiresAt) : NaN;
      if (!payload || !Number.isFinite(expires) || !Number.isInteger(payload.baseSeq)) return { made: null, reason: 'the signed transfer cannot be read' };
      if (nowMs() < expires + UNSEEN_SETTLE_MS) return { made: null, reason: 'the domain has no record of it yet, and it could still arrive' };
      try {
        const { coin, bound } = await freshCoin(await recordFor(p.domain), p.coinId);
        // A statement that is not tied to the request that asked for it could be an earlier one replayed, so it cannot show the
        // account stood where it did because the transfer was never made.
        if (!bound) return { made: null, reason: 'the domain answered in the old form, which is not tied to each request, so it cannot show that this transfer was never made' };
        if (coin.seq === payload.baseSeq) return { made: false };
        return { made: null, reason: 'the account has moved since, so the wallet cannot tell whether this transfer was made' };
      } catch (err) {
        return { made: null, reason: 'the signed holdings could not be read' };
      }
    }

    // Asks the domain how each waiting transfer ended. An executed transfer is done only with a receipt that verifies, from its own domain or, for
    // a public coin, from another domain of the roster. A receipt that fails leaves the transfer `unconfirmed` and reported; one that cannot be
    // checked yet leaves it waiting. A transfer is removed only when a verified receipt settles it, or when the domain says it expired or was
    // rejected and the wallet never saw it reported as made.
    async function checkPending() {
      const c = await cache();
      const report = [];
      const settled = [];
      const marked = new Map();
      const claimed = new Set(c.pendingSends.filter((x) => x.state === 'unconfirmed' && Number.isInteger(x.index)).map((x) => x.domain + '/' + x.coinId + '/' + x.index));
      for (const p of c.pendingSends) {
        const r = await request(p.domain, 'GET', 'action=proposal&coin=' + p.coinId + '&digest=' + p.digest);
        const proposal = r.json && r.json.proposal;
        if (r.status === 200 && proposal && proposal.status === 'executed') {
          try {
            await acceptReceipt(await recordFor(p.domain), p.coinId, proposal.receipt, p);
            settled.push(p.digest);
            report.push(Object.assign({}, p, { outcome: 'done' }));
            continue;
          } catch (err) {
            if (!err || err.code !== 'bad-receipt') continue;
            if (err.unchecked) { report.push(Object.assign({}, p, { outcome: p.state === 'unconfirmed' || p.state === 'unknown' ? p.state : 'waiting', reason: String(err.reason || '').slice(0, 200) })); continue; }
            const reason = String(err.reason || '').slice(0, 200);
            const index = Number.isInteger(proposal.index) ? proposal.index : null;
            const spot = p.domain + '/' + p.coinId + '/' + index;
            // Another unconfirmed transfer already points at this entry: two transfers that look alike cannot both be settled by one entry.
            const taken = index !== null && claimed.has(spot) && !(p.state === 'unconfirmed' && p.index === index);
            const via = taken ? null : await reconcileSend(p, index);
            if (via) { settled.push(p.digest); report.push(Object.assign({}, p, { outcome: 'done', confirmedBy: via })); continue; }
            if (index !== null) claimed.add(spot);
            marked.set(p.digest, { state: 'unconfirmed', reason, index, since: p.state === 'unconfirmed' && p.since ? p.since : nowMs() });
            report.push(Object.assign({}, p, { outcome: 'unconfirmed', reason }));
          }
        } else if (r.status === 200 && proposal && (proposal.status === 'expired' || proposal.status === 'rejected') && p.state !== 'unconfirmed') {
          settled.push(p.digest);
          report.push(Object.assign({}, p, { outcome: proposal.status }));
        } else if (p.state === 'unknown') {
          if (r.status === 200 && proposal && proposal.status === 'pending') {
            // The domain holds it, waiting for approvals: it is an ordinary waiting transfer from here on.
            marked.set(p.digest, { state: 'waiting', note: '' });
            report.push(Object.assign({}, p, { outcome: 'waiting' }));
          } else if (r.status === 404 && r.json && r.json.code === 'unknown-proposal') {
            const seen = await settleUnseen(p);
            if (seen.made === false) { settled.push(p.digest); report.push(Object.assign({}, p, { outcome: 'not-made' })); } else report.push(Object.assign({}, p, { outcome: 'unknown', reason: seen.reason }));
          } else {
            report.push(Object.assign({}, p, { outcome: 'unknown', reason: 'the domain did not answer' }));
          }
        }
      }
      await mutateCache((latest) => {
        latest.pendingSends = latest.pendingSends.filter((p) => !settled.includes(p.digest)).map((p) => (marked.has(p.digest) ? Object.assign({}, p, marked.get(p.digest)) : p));
      });
      return report;
    }

    // ---------- buying with Gold ----------

    // What a coin sells for, read from the coin's verified genesis on its authority domain, which must be on the list. The terms are the
    // ones in the genesis the wallet pinned and the coin's domains signed, not whatever the domain's plain answer says now.
    async function offer(domain, coinId) {
      const record = await recordFor(domain);
      let v;
      try { v = await verifiedGenesis(record, coinId); } catch (err) {
        if (err && err.code === 'unknown-coin') throw Object.assign(new Error(BUY_PROBLEMS['no-purchase-policy']), { code: 'no-purchase-policy' });
        throw err;
      }
      const g = v.genesis;
      if (!isObject(g.purchase)) throw Object.assign(new Error(BUY_PROBLEMS['no-purchase-policy']), { code: 'no-purchase-policy' });
      if (v.raw.state !== 'active') throw Object.assign(new Error(BUY_PROBLEMS['not-active']), { code: 'not-active' });
      // The authority says whether it has the code that takes the Gold; a coin whose genesis has terms but whose domain cannot take payment is not for sale.
      if (v.raw.purchasesEnabled !== true) throw Object.assign(new Error(BUY_PROBLEMS['purchases-off']), { code: 'purchases-off' });
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
      await assertIntegrity(await recordFor(domain), coinId);
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

    async function intentFor(prepared, binding) {
      const payload = { type: 'atlas.ledger.purchase.intent', v: 2, authority: binding.authority, genesis: binding.genesis, coinId: prepared.coinId, credentialId: credentialId(prepared.credential), price: prepared.price, recipient: prepared.recipient, requestId: prepared.requestId, expiresAt: iso(nowMs() + INTENT_WINDOW_S * 1000) };
      const envelope = await env.sign(payload);
      if (!envelope || envelope.publicKey !== prepared.from || typeof envelope.signature !== 'string') throw Object.assign(new Error(PROBLEMS['proof-unsupported']), { code: 'proof-unsupported' });
      return { payload, signature: envelope.signature };
    }

    // Signs the intent and sends the purchase. The request id is kept until the domain has delivered, so a retry (with a new
    // signature and expiry, since an intent expires) is the same purchase and cannot be delivered twice.
    async function buy(prepared) {
      const record = await recordFor(prepared.domain);
      await checkHeadNow(record, prepared.coinId);
      const intent = await intentFor(prepared, await coinBinding(record, prepared.coinId));
      await mutateCache((c) => {
        if (c.pendingBuys.some((p) => p.requestId === prepared.requestId)) return;
        c.pendingBuys = capPending(c.pendingBuys.concat([{ domain: record.domain, coinId: prepared.coinId, requestId: prepared.requestId, credential: prepared.credential, price: prepared.price, recipient: prepared.recipient, from: prepared.from, symbol: prepared.symbol, decimals: prepared.decimals, private: prepared.private, units: prepared.units, createdAt: nowMs() }]));
      });
      const r = await request(record.domain, 'POST', 'action=purchase', { coinId: prepared.coinId, intent, credential: prepared.credential });
      const j = r.json || {};
      if (r.status === 201) {
        // The domain says the sale was made. The purchase stays in the cache until a receipt that verifies has settled it.
        try {
          if (!j.ok || j.requestId !== prepared.requestId) throw unverified('the answer is not for this purchase');
          await acceptReceipt(record, prepared.coinId, j.receipt, { coinId: prepared.coinId, to: prepared.recipient, amount: prepared.units, private: prepared.private, purchase: { requestId: prepared.requestId, price: prepared.price } });
        } catch (err) {
          if (!err || err.code !== 'bad-receipt') throw err;
          const reason = String(err.reason || '').slice(0, 200);
          if (err.unchecked) {
            const note = 'The domain says the sale was made, but the wallet could not check its receipt yet (' + reason + '). Try again; the same request is not delivered twice.';
            await mutateCache((cache) => { const held = cache.pendingBuys.find((x) => x.requestId === prepared.requestId); if (held) held.note = note; });
            return { status: 'waiting', requestId: prepared.requestId, note };
          }
          await mutateCache((cache) => { const held = cache.pendingBuys.find((x) => x.requestId === prepared.requestId); if (held) Object.assign(held, { state: 'unconfirmed', reason, since: held.since || nowMs() }); });
          throw Object.assign(new Error('The domain says the sale was made, but its receipt could not be verified (' + reason + '), so the outcome is unconfirmed. The wallet keeps the purchase and its Gold request, has not counted it as made or as failed, and sends nothing new; Try again repeats the same request.'), { code: 'bad-receipt', reason, unconfirmed: true, requestId: prepared.requestId });
        }
        await dropBuy(prepared.requestId);
        // The wallet takes the Gold the issuer returned in place of the credential it spent.
        if (typeof env.afterPurchase === 'function') await Promise.resolve(env.afterPurchase(prepared, j.balance || null)).catch(() => null);
        await lookup(record.domain).catch(() => null);
        return { status: 'done', receipt: j.receipt, balance: j.balance || null };
      }
      if (r.status === 202) {
        // What the domain is waiting for (for example which domain has not approved) is kept with the request so it can be shown again.
        const note = typeof j.note === 'string' ? j.note.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 300) : '';
        await mutateCache((cache) => { const held = cache.pendingBuys.find((x) => x.requestId === prepared.requestId); if (held) held.note = note; });
        return { status: 'waiting', requestId: prepared.requestId, note };
      }
      // Only the domain's own refusal ends the request. A rate limit, a timeout from a proxy in front of the domain, or an answer that is not
      // a refusal in the domain's form may arrive for a sale the domain went on to make, so the purchase stays and asking again repeats the same request.
      const refused = r.status >= 400 && r.status < 500 && !AMBIGUOUS_STATUS.has(r.status) && j.ok === false && typeof j.code === 'string';
      if (refused) {
        await dropBuy(prepared.requestId);
      } else if (r.status !== 0 && r.status < 500) {
        throw Object.assign(new Error('The domain did not answer clearly, so the sale may or may not have been made. The wallet keeps the purchase; asking again repeats the same request, which is not delivered twice.'), { code: 'network' });
      }
      throw Object.assign(new Error(r.status === 0 ? PROBLEMS.network : (BUY_PROBLEMS[j.code] || 'The domain did not accept the purchase.') + refusalDetail(j)), { code: r.status === 0 ? 'network' : j.code || 'refused', detail: refusalDetail(j).trim() });
    }

    // The domain's own words for why it refused, so a refusal can be told apart from the next one. Shown as text only.
    function refusalDetail(j) {
      const text = typeof j.error === 'string' ? j.error.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 300) : '';
      return text ? ' The domain said: ' + text + (/[.!?]$/.test(text) ? '' : '.') : '';
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

    return { addDomain, removeDomain, lookup, refresh, rows, acceptHead, prepareSend, send, checkPending, offer, offerState, prepareBuy, buy, resumeBuy, dropBuy, domains };
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
