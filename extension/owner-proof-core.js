// The wallet's side of the signed membership request: what to sign, when to sign it, and how to word a refusal.
//
// An issuer that wants proof of key ownership before it issues a membership card says so in GET /atlas/capabilities
// (ownerProof). The wallet then signs one exact "issue" request with the key the card is for and sends it with the
// issue request. The same bytes are checked by issuer-server/lib-owner-proof.js and issuer-php/lib/owner-proof.php;
// test/vectors/owner-proof.json pins all three to one result.
//
// Nothing here touches the page, extension storage, the clock or the network: the signer and the time are passed in,
// so the same file runs in the wallet pages, in the tests and in a standalone wallet.
//
// One file, loaded as a script (global AtlasOwnerProof) by the wallet pages, and required as a module by the tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AtlasOwnerProof = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OWNER_PROOF_CLASSES = ['atlas.membership', 'atlas.postoffice.membership', 'atlas.tradingstation.membership'];
  const OWNER_PROOF_WINDOW_MS = 2 * 60 * 1000;
  const UPDATE_WALLET_MESSAGE = 'This domain requires a newer version of Domain Atlas Wallet to join this service. Please update your wallet and try again.';

  function canonicalize(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }

  // The exact payload the recipient key signs.
  function issuePayload(f) {
    return {
      action: 'issue', assetClass: f.assetClass, domain: f.domain, issuedAt: f.issuedAt,
      ownerPublicKey: f.ownerPublicKey, quantity: 1, requestId: f.requestId
    };
  }

  // The issuer's ownerProof record, or null when it is missing or not one this wallet understands.
  function parseCapability(capabilities) {
    const rec = capabilities && typeof capabilities === 'object' ? capabilities.ownerProof : null;
    if (!rec || typeof rec !== 'object' || Number(rec.version) < 1 || rec.operation !== 'issue' || !Array.isArray(rec.classes)) return null;
    return { version: Number(rec.version), classes: rec.classes.filter((c) => typeof c === 'string'), mode: typeof rec.mode === 'string' ? rec.mode : null };
  }

  // Whether to sign for this class at this issuer. Only classes this wallet knows are ever signed for, whatever an issuer lists.
  function shouldSign(record, assetClass) {
    return !!record && record.mode !== 'off' && OWNER_PROOF_CLASSES.includes(assetClass) && record.classes.includes(assetClass);
  }

  // The signed request: { payload, proof }. sign(payload) resolves to the wallet's proof envelope for the identity the card is for.
  async function buildIssueIntent(fields, nowMs, sign) {
    const payload = issuePayload({
      assetClass: fields.assetClass, domain: fields.domain, issuedAt: new Date(nowMs).toISOString(),
      ownerPublicKey: fields.ownerPublicKey, requestId: fields.requestId
    });
    const proof = await sign(payload);
    if (!proof || proof.publicKey !== fields.ownerPublicKey) throw new Error('the request was not signed by the identity the membership is for');
    return { payload, proof };
  }

  // The offset to apply to this wallet's clock for an issuer that answered stale-request, or null.
  function clockOffsetFrom(refusal, localNowMs) {
    const t = refusal && typeof refusal.serverTime === 'string' ? Date.parse(refusal.serverTime) : NaN;
    return Number.isFinite(t) ? t - localNowMs : null;
  }

  // What to tell the person when an issuer turned the request away because it wants a signed one (a refusal that carries
  // updateWallet), or null for any other error. A refusal of a request that was signed is a different problem and keeps its own words.
  function explainRefusal(refusal) {
    return refusal && refusal.updateWallet === true ? UPDATE_WALLET_MESSAGE : null;
  }

  return { OWNER_PROOF_CLASSES, OWNER_PROOF_WINDOW_MS, UPDATE_WALLET_MESSAGE, canonicalize, issuePayload, parseCapability, shouldSign, buildIssueIntent, clockOffsetFrom, explainRefusal };
});
