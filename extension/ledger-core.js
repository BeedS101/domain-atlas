// Domain Atlas ledger accounts: the credential shape, the rules every wallet applies to it, and
// the small model the Ledger tab uses to say what a wallet can, may and is doing.
//
// A ledger-account credential names an account whose balance is kept by a remote ledger. It is
// not an asset: it carries no quantity, and nothing in this file turns one into a balance. The
// wallet learns a balance only by asking the ledger, after the person has agreed to that.
//
// One file, loaded as a script (global AtlasLedgerCore) by the wallet pages and the service
// worker, and required as a module by the tests. It has no network or storage access and keeps
// no state, so the same checks can be ported to another language and compared by test.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AtlasLedgerCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CREDENTIAL_TYPE = 'domain-atlas-ledger-account/1.0';

  const LIMITS = {
    // Shortest and longest gap between background checks of one account.
    syncMinIntervalMs: 5 * 60 * 1000,
    syncDefaultIntervalMs: 10 * 60 * 1000,
    syncMaxIntervalMs: 60 * 60 * 1000,
    // A balance older than this is shown as out of date.
    staleAfterMs: 30 * 60 * 1000,
    maxAmountDigits: 40,
    maxDecimals: 18,
    maxAccountsPerIdentity: 200
  };

  // The only keys a credential may carry, at each level.
  const ALLOWED_KEYS = {
    top: ['credential', 'id', 'issuer', 'ledger', 'owner', 'issuedAt', 'signature'],
    issuer: ['domain', 'publicKey'],
    ledger: ['network', 'coin'],
    owner: ['publicKey']
  };

  // Names that would put a quantity into the credential. Refused at any depth, so a figure cannot
  // be tucked inside a nested object and mistaken for what the account holds.
  const BALANCE_LIKE = /^(quantity|qty|balance|amount|available|total|holdings|funds|value|supply|decimals|units|minor|major)$/i;

  const ID_RE = /^urn:atlas:ledger-account:[A-Za-z0-9-]{8,64}$/;
  const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
  const KEY_RE = /^[A-Za-z0-9_-]{60,120}$/;
  const SIG_RE = /^[A-Za-z0-9_-]{60,200}$/;
  const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
  const HOST_RE = /^(localhost|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)(:\d{1,5})?$/;

  function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  // ---------- owner keys ----------
  //
  // An owner is named by one spelling only: the unpadded base64url of the 65-byte uncompressed
  // P-256 point. A password identity already uses it. A passkey identity's key is stored as a
  // 91-byte SubjectPublicKeyInfo (122 characters), which is the same point behind a fixed
  // header, so the point is taken out of it. Any other spelling of a key is refused rather than
  // converted, so one key can never be filed or looked up under two names.

  const SPKI_P256_HEADER = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

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

  function isCanonicalPointKey(s) {
    const bytes = fromB64url(s);
    return !!bytes && bytes.length === 65 && bytes[0] === 4 && toB64url(bytes) === s;
  }

  // The canonical key for a wallet identity's public key as the wallet stores it, or null when it
  // is neither a canonical point nor a P-256 SubjectPublicKeyInfo.
  function canonicalOwnerKey(publicKey) {
    if (isCanonicalPointKey(publicKey)) return publicKey;
    const bytes = fromB64url(publicKey);
    if (!bytes || bytes.length !== 91) return null;
    const header = Array.from(bytes.slice(0, 26)).map((b) => b.toString(16).padStart(2, '0')).join('');
    if (header !== SPKI_P256_HEADER) return null;
    const point = toB64url(bytes.slice(26));
    return isCanonicalPointKey(point) ? point : null;
  }

  function validTime(s) { return typeof s === 'string' && TIME_RE.test(s) && !Number.isNaN(Date.parse(s)); }

  // A bare host (with an optional port), as a credential's issuer.domain is written everywhere else.
  function validDomain(s) {
    if (typeof s !== 'string' || s !== s.toLowerCase() || s.length > 253) return false;
    if (!HOST_RE.test(s)) return false;
    const m = /:(\d{1,5})$/.exec(s);
    return !m || (Number(m[1]) >= 1 && Number(m[1]) <= 65535);
  }

  function findBalanceLikeKey(value, depth) {
    if (depth > 6 || !isPlainObject(value) && !Array.isArray(value)) return null;
    for (const k of Object.keys(value)) {
      if (BALANCE_LIKE.test(k)) return k;
      const inner = findBalanceLikeKey(value[k], depth + 1);
      if (inner) return inner;
    }
    return null;
  }

  function noExtraKeys(obj, allowed) {
    return Object.keys(obj).every((k) => allowed.includes(k));
  }

  function bad(reason, message) { return { ok: false, reason, message }; }

  // Shape check only: it says nothing about whether the issuer signed it. The signature check
  // needs the issuer's published key and is done by the wallet.
  function validateAccountCredential(c) {
    if (!isPlainObject(c)) return bad('not-an-object', 'That is not a ledger-account credential.');
    if (c.credential !== CREDENTIAL_TYPE) return bad('wrong-type', 'That is not a ledger-account credential.');
    const stray = findBalanceLikeKey(c, 0);
    if (stray) return bad('carries-balance', 'A ledger-account credential must not carry a balance or quantity ("' + stray + '").');
    if (!noExtraKeys(c, ALLOWED_KEYS.top)) return bad('unknown-field', 'The credential has fields this wallet does not know.');
    if (typeof c.id !== 'string' || !ID_RE.test(c.id)) return bad('bad-id', 'The credential id is not valid.');
    if (!isPlainObject(c.issuer) || !noExtraKeys(c.issuer, ALLOWED_KEYS.issuer)) return bad('bad-issuer', 'The issuer is not valid.');
    if (!validDomain(c.issuer.domain)) return bad('bad-issuer-domain', 'The issuing domain must be a plain host name.');
    if (typeof c.issuer.publicKey !== 'string' || !KEY_RE.test(c.issuer.publicKey)) return bad('bad-issuer-key', 'The issuer key is not valid.');
    if (!isPlainObject(c.ledger) || !noExtraKeys(c.ledger, ALLOWED_KEYS.ledger)) return bad('bad-ledger', 'The ledger details are not valid.');
    if (typeof c.ledger.network !== 'string' || !TOKEN_RE.test(c.ledger.network)) return bad('bad-network', 'The network identifier is not valid.');
    if (typeof c.ledger.coin !== 'string' || !TOKEN_RE.test(c.ledger.coin)) return bad('bad-coin', 'The coin identifier is not valid.');
    if (!isPlainObject(c.owner) || !noExtraKeys(c.owner, ALLOWED_KEYS.owner)) return bad('bad-owner', 'The owner is not valid.');
    if (!isCanonicalPointKey(c.owner.publicKey)) return bad('bad-owner-key', 'The owner key is not in the one accepted form (the 65-byte point, base64url).');
    if (!validTime(c.issuedAt)) return bad('bad-issued-at', 'The issue time is not valid.');
    if (typeof c.signature !== 'string' || !SIG_RE.test(c.signature)) return bad('bad-signature-shape', 'The signature is not valid.');
    return { ok: true };
  }

  // What the issuer signs. Kept to the identifying fields so that no figure can ever be covered
  // by the signature.
  function signedPayloadOf(c) {
    return { id: c.id, ledger: { network: c.ledger.network, coin: c.ledger.coin }, owner: { publicKey: c.owner.publicKey }, issuedAt: c.issuedAt };
  }

  // ---------- balances as the wallet holds them ----------
  //
  // An adapter hands back whole units of the smallest denomination as a decimal string plus how
  // many of those digits sit after the decimal point. Strings keep large figures exact; nothing
  // here does arithmetic on them.

  function normalizeBalance(raw) {
    if (!isPlainObject(raw)) return null;
    const amount = raw.amount;
    const decimals = raw.decimals;
    if (typeof amount !== 'string' || !/^\d+$/.test(amount) || amount.length > LIMITS.maxAmountDigits) return null;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > LIMITS.maxDecimals) return null;
    if (!validTime(raw.asOf)) return null;
    return { amount: amount.replace(/^0+(?=\d)/, ''), decimals, asOf: raw.asOf };
  }

  function formatAmount(amount, decimals) {
    const digits = String(amount).replace(/^0+(?=\d)/, '');
    if (!decimals) return digits;
    const padded = digits.padStart(decimals + 1, '0');
    return padded.slice(0, padded.length - decimals) + '.' + padded.slice(padded.length - decimals);
  }

  function isStale(asOf, now) {
    const t = Date.parse(asOf);
    return Number.isNaN(t) || (now - t) > LIMITS.staleAfterMs;
  }

  function shortKey(publicKey) {
    return typeof publicKey === 'string' && publicKey.length > 14 ? publicKey.slice(0, 6) + '…' + publicKey.slice(-4) : String(publicKey || '');
  }

  // ---------- what a wallet can, may and is doing ----------
  //
  // Each of the two capabilities (looking up a balance, keeping it up to date in the background)
  // is in exactly one of four levels:
  //   unavailable  this wallet cannot do it right now, and the reason says why
  //   available    it could be turned on; nothing is allowed yet
  //   enabled      the person allowed it; nothing is happening at this moment
  //   connecting   a request to the ledger is in flight
  // The glyph and the words carry the level as well as any colour a page adds.

  const LEVELS = {
    unavailable: { level: 'unavailable', glyph: '⊘', word: 'Unavailable' },
    available: { level: 'available', glyph: '○', word: 'Available' },
    enabled: { level: 'enabled', glyph: '●', word: 'Enabled' },
    connecting: { level: 'connecting', glyph: '◐', word: 'Connecting' }
  };

  function levelOf(name, detail) { return Object.assign({}, LEVELS[name], { detail }); }

  function indicatorsFor(s) {
    const lookup = (() => {
      if (!s.ownerIsActive) return levelOf('unavailable', 'Switch to the identity that owns this account to check it.');
      if (s.identityLocked) return levelOf('unavailable', 'Unlock your wallet to check this account.');
      if (s.proofUnsupported) return levelOf('unavailable', 'This ledger cannot check this kind of identity yet, so the wallet makes no request.');
      if (!s.adapterSupports) return levelOf('unavailable', 'This wallet has no way to reach this ledger yet.');
      if (s.inFlight) return levelOf('connecting', 'Talking to ' + s.domain + ' now.');
      if (s.endpointChanged) return levelOf('available', s.domain + ' now names a different ledger address. Allow it again to continue.');
      if (s.consent) return levelOf('enabled', 'Allowed: this wallet contacts ' + s.domain + ' when you open this tab or press Check.');
      return levelOf('available', 'Not allowed yet. The wallet asks before it contacts ' + s.domain + '.');
    })();
    const background = (() => {
      if (lookup.level === 'unavailable') return levelOf('unavailable', lookup.detail);
      if (!s.canSignSilently) return levelOf('unavailable', 'This identity needs your confirmation for every request, so checks stay manual.');
      if (!s.consent || s.endpointChanged) return levelOf('unavailable', 'Allow checking this account first.');
      if (s.inFlight && s.inFlightReason === 'background') return levelOf('connecting', 'Background check in progress.');
      if (s.backgroundSync) return levelOf('enabled', 'On: checked about every ' + Math.round((s.intervalMs || LIMITS.syncDefaultIntervalMs) / 60000) + ' minutes while the wallet is open.');
      return levelOf('available', 'Off. Turn it on to keep the balance up to date while the wallet is open.');
    })();
    return { lookup, background };
  }

  // Why a lookup did not happen or did not finish, in words for the person. Codes are stable;
  // the text may be reworded.
  const PROBLEMS = {
    'no-adapter': 'This wallet has no way to reach this ledger yet.',
    'not-supported': 'This wallet does not support this ledger.',
    'no-consent': 'You have not allowed this wallet to contact this ledger.',
    'wrong-identity': 'Switch to the identity that owns this account.',
    'locked': 'Unlock your wallet first.',
    'endpoint-changed': 'The issuing domain now names a different ledger address. Allow it again to continue.',
    'network': 'The ledger could not be reached.',
    'timeout': 'The ledger did not answer in time.',
    'unauthorized': 'The ledger did not accept this identity for the account.',
    'not-found': 'The ledger has no such account.',
    'bad-response': 'The ledger sent an answer this wallet could not use.',
    'proof-unsupported': 'This ledger cannot check this kind of identity yet (for example a passkey), so no request was made.',
    'clock': 'The ledger says this device\'s clock is too far from its own. Check the date and time on this device.',
    'unknown-coin': 'The ledger does not list this coin.',
    'rate-limited': 'The ledger asked this wallet to slow down. Try again later.',
    'credential-invalid': 'The issuer no longer vouches for this account reference.',
    'cancelled': 'The check was cancelled.',
    'busy': 'A check is already running for this account.',
    'experimental-off': 'Turn on the experimental ledger interface first. It is off by default.',
    'unsupported-target': 'This wallet does not open accounts for that coin and domain.',
    'already-held': 'This wallet already holds a reference to that account.',
    'issuance-off': 'The issuing domain is not issuing account references right now. Your account stays open; try again when it is.',
    'issuer-unavailable': 'The issuing domain could not issue the reference right now. Your account stays open; try again later.',
    'account-missing': 'The ledger has no such account yet. Open it first.',
    'account-revoked': 'The issuing domain has revoked this account reference and will not issue it again.',
    'unknown': 'The check did not finish.'
  };

  function problemText(code) { return PROBLEMS[code] || PROBLEMS.unknown; }

  // How far a balance can be trusted. The wallet has no way to check a signed receipt yet, so every
  // balance it shows is unsigned, whatever the ledger says about itself. An adapter cannot raise
  // this: the wallet sets it, not the answer.
  const VERIFICATION = {
    unsigned: { level: 'unsigned', label: 'Reported \u2014 Not Cryptographically Verified', detail: 'The ledger said so over a secure connection. Nothing signed by the ledger backs it, and it is not a final or spendable balance.' }
  };

  return {
    CREDENTIAL_TYPE, LIMITS, ALLOWED_KEYS, PROBLEMS,
    validateAccountCredential, signedPayloadOf, validDomain, validTime,
    normalizeBalance, formatAmount, isStale, shortKey,
    indicatorsFor, problemText, VERIFICATION,
    isCanonicalPointKey, canonicalOwnerKey
  };
});
