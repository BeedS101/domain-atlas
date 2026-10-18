// Opening a ledger account from the wallet: what may be asked of which service, the exact
// messages the owner signs, and how each answer is read. Nothing here sends a request, signs a
// message or stores anything; the wallet does those, so every rule below can be tested alone.
//
// The workflow has two separately approved steps, against three published addresses on one
// issuing host:
//   open     POST /chain-labs/account30.php?action=open     opens an empty account (idempotent)
//   issue    POST /atlas/ledger/account-credential          asks the issuer for a signed reference
//   accounts POST /chain-labs/accounts31.php?action=accounts is never called by the wallet: a
//            freshly signed request for it travels inside the issuance request, and the issuer
//            relays it to the ledger to confirm the account exists.
// Experimental: the services behind these addresses are prototypes and the issuance one is off
// unless its operator switches it on.
//
// One file, loaded as a script (global AtlasLedgerOpen) by the wallet pages and the service
// worker, and required as a module by the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AtlasLedgerOpen = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NETWORK_PREFIX = 'chainblock-labs29-';
  const PROOF_FORMATS = ['raw-ecdsa-p256'];
  const TYPES = { open: 'atlas.ledger.account.open', accounts: 'atlas.ledger.accounts', issue: 'atlas.ledger.account.issue' };
  const PATHS = { open: '/chain-labs/account30.php?action=open', accounts: '/chain-labs/accounts31.php?action=accounts', issue: '/atlas/ledger/account-credential' };
  const MAX_BODY_CHARS = 16384;
  const NONCE_RE = /^[a-f0-9]{32,64}$/;
  const COIN_RE = /^[A-Z][A-Z0-9]{1,9}$/;
  const ID_RE = /^urn:atlas:ledger-account:[a-f0-9]{64}$/;

  // The accounts this wallet will ask for. A host and coin that are not listed here are refused
  // before anything is signed or sent.
  const TARGETS = [
    { domain: 'evtec.co.za', coin: 'GOPH', label: 'GOPH on evtec.co.za' }
  ];

  function targets() { return TARGETS.map((t) => Object.assign({ network: networkOf(t.domain) }, t)); }

  function networkOf(domain) { return NETWORK_PREFIX + domain; }

  function targetFor(domain, coin) {
    const t = TARGETS.find((x) => x.domain === domain && x.coin === coin);
    return t ? Object.assign({ network: networkOf(t.domain) }, t) : null;
  }

  function urlsFor(domain) {
    const base = 'https://' + domain;
    return { open: base + PATHS.open, accounts: base + PATHS.accounts, issue: base + PATHS.issue };
  }

  function isoSeconds(date) { return new Date(date).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

  function isNonce(s) { return typeof s === 'string' && NONCE_RE.test(s); }

  // ---------- what is signed ----------

  function openPayload(target, nonce, issuedAt) {
    return { type: TYPES.open, v: 1, audience: urlsFor(target.domain).open, network: target.network, coin: target.coin, nonce, issuedAt };
  }

  function listingPayload(target, nonce, issuedAt) {
    return { type: TYPES.accounts, v: 1, audience: urlsFor(target.domain).accounts, network: target.network, nonce, issuedAt };
  }

  function issuePayload(target, nonce, issuedAt, existenceNonce) {
    return { type: TYPES.issue, v: 1, audience: urlsFor(target.domain).issue, network: target.network, coin: target.coin, nonce, issuedAt, existenceNonce };
  }

  // ---------- what the person is told before each step ----------

  function explainOpen(target) {
    const u = urlsFor(target.domain);
    return 'Open an empty ' + target.coin + ' account for the identity you selected? ' +
      'This is an experimental test service run by ' + target.domain + '. ' +
      'The wallet will send one signed request to ' + u.open + ' that names the network, the coin and your public key. ' +
      'The ledger opens an account with nothing in it, or tells the wallet that it already exists; it never changes an existing balance. ' +
      'Nothing is minted, deposited or spent, no balance is looked up, and no credential is requested yet.';
  }

  function explainIssue(target) {
    const u = urlsFor(target.domain);
    return 'Ask ' + target.domain + ' for an issuer-signed reference to your ' + target.coin + ' account? ' +
      'This is experimental, and the issuing service may be switched off. ' +
      'The wallet will send one request to ' + u.issue + ', signed with the identity you selected, together with a second freshly signed request that ' + target.domain + ' relays to ' + u.accounts + ' to confirm the account exists. ' +
      'The wallet then checks the issuer\'s signature against the key ' + target.domain + ' publishes and its revocation list, and keeps the reference only if both pass. ' +
      'The reference holds no balance, and no balance is looked up.';
  }

  // ---------- reading answers ----------

  function parseBody(text) {
    if (typeof text !== 'string' || text.length > MAX_BODY_CHARS) return null;
    try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (err) { return null; }
  }

  const COMMON_CODES = {
    'malformed-request': 'bad-response',
    'wrong-audience': 'bad-response',
    'unknown-network': 'not-supported',
    'unknown-host': 'bad-response',
    'https-required': 'bad-response',
    'unsupported-proof': 'proof-unsupported',
    'bad-signature': 'unauthorized',
    'stale-request': 'clock',
    'replayed-request': 'busy',
    'rate-limited': 'rate-limited',
    'unavailable': 'network'
  };

  const OPEN_CODES = Object.assign({}, COMMON_CODES, { 'unknown-coin': 'unknown-coin' });

  const ISSUE_CODES = Object.assign({}, COMMON_CODES, {
    'disabled': 'issuance-off',
    'misconfigured': 'issuer-unavailable',
    'busy': 'busy',
    'issuer-key-unavailable': 'issuer-unavailable',
    'ledger-unavailable': 'issuer-unavailable',
    'ledger-mismatch': 'issuer-unavailable',
    'ledger-refused': 'issuer-unavailable',
    'account-not-found': 'account-missing',
    'account-revoked': 'account-revoked',
    'existence-proof-rejected': 'unauthorized'
  });

  // The wallet problem a failed answer stands for. Only the structured `code` is read; the
  // free-text message is never parsed. An unknown code is a bad answer, not a guess.
  function problemOf(table, status, body) {
    const code = body && typeof body.code === 'string' ? body.code : null;
    if (code && Object.prototype.hasOwnProperty.call(table, code)) return table[code];
    if (status === 429) return 'rate-limited';
    if (status >= 500) return 'network';
    return 'bad-response';
  }

  // The answer to the open request. 201 `account-opened` or 200 `account-exists`, for this
  // network, coin and owner. The quantity the ledger reports with it is deliberately not read.
  function readOpened(status, body, expect) {
    if (!body || body.ok !== true) return { ok: false, code: problemOf(OPEN_CODES, status, body) };
    const created = body.code === 'account-opened' && status === 201;
    const existed = body.code === 'account-exists' && status === 200;
    if (!created && !existed) return { ok: false, code: 'bad-response' };
    if (body.network !== expect.network || body.coin !== expect.coin || body.ownerKey !== expect.owner) return { ok: false, code: 'bad-response' };
    if (typeof body.accountId !== 'string' || !ID_RE.test(body.accountId)) return { ok: false, code: 'bad-response' };
    return { ok: true, created, accountId: body.accountId };
  }

  // The answer to the issuance request. The credential is returned unchecked: its shape, its
  // owner and its signature are the wallet's to verify before it keeps anything.
  function readIssued(status, body) {
    if (!body || body.ok !== true) return { ok: false, code: problemOf(ISSUE_CODES, status, body) };
    if (status !== 200 || body.code !== 'credential-issued' || !body.credential || typeof body.credential !== 'object' || Array.isArray(body.credential)) return { ok: false, code: 'bad-response' };
    return { ok: true, credential: body.credential };
  }

  // Whether a credential the issuer returned is for the account that was asked for.
  function credentialMatches(credential, ask) {
    return !!credential && credential.id === ask.id && credential.issuer && credential.issuer.domain === ask.domain &&
      credential.ledger && credential.ledger.network === ask.network && credential.ledger.coin === ask.coin &&
      credential.owner && credential.owner.publicKey === ask.owner;
  }

  return {
    NETWORK_PREFIX, PROOF_FORMATS, TYPES, PATHS, COIN_RE, ID_RE,
    targets, targetFor, networkOf, urlsFor, isoSeconds, isNonce,
    openPayload, listingPayload, issuePayload,
    explainOpen, explainIssue,
    parseBody, problemOf, readOpened, readIssued, credentialMatches,
    OPEN_CODES, ISSUE_CODES
  };
});
