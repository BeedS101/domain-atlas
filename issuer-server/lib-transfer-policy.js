// Transfer and delivery policy, evaluated before any custody change.
//
// A pure function over plain data: the caller gathers the facts (is the
// credential revoked, does the signature verify, is the id in the bearer
// registry, ...) and this module decides, so the identical decision table
// can be implemented in issuer-php/lib/transfer-policy.php and checked
// against the shared vectors in test/vectors/transfer-policy.json.
//
// Operations (what happens to authority):
//   transfer  ownership moves to a new holder; the sender's credential is
//             revoked and a new one is signed for the recipient
//   copy      a non-authoritative derivative is delivered (not built yet)
//   custody   an agent holds the asset for its owner (not built yet)
// Transports (how the result reaches the recipient): wallet, email, file.
// Authorization models (who may ask): owner-signed, bearer, issuer-agent.
//
// Class policy: a catalog entry may carry a `transfer` block
//   { operations?: [..], transports?: [..] }
// that can only narrow what the built-in rules allow (non-fungible,
// not bound, not revoked, ...). A class with no block gets the built-in
// rules unchanged.
//
// Error text and codes are the ones the existing endpoints already return;
// each profile below is the exact check order of the endpoint it replaces.

const KNOWN_OPERATIONS = ['transfer', 'copy', 'custody'];
const KNOWN_TRANSPORTS = ['wallet', 'email', 'file'];

// Messages keyed by profile and code. `status` is the HTTP status the
// existing endpoint used for that failure when it was not a plain 400.
const MESSAGES = {
  'holder-send': {
    'not-an-asset': 'not an asset credential',
    'wrong-owner': 'asset does not belong to this signer',
    'wrong-class': 'asset is the wrong class',
    bound: 'asset is bound to its owner and cannot be sent to anyone else',
    fungible: 'asset class is fungible — this endpoint only transfers a unique item',
    revoked: 'asset already revoked',
    suspended: 'asset is currently suspended pending review',
    expired: 'asset has expired',
    'bad-signature': 'asset signature does not check out'
  },
  'bearer-claim:identity': {
    'not-an-asset': 'not an asset credential',
    'bad-signature': 'asset signature does not check out'
  },
  'bearer-claim:state': {
    revoked: 'this file has already been claimed or withdrawn',
    suspended: 'this asset is currently suspended pending review',
    expired: 'asset has expired',
    fungible: 'only a unique item can be claimed from a file',
    bound: 'asset is bound and cannot be claimed from a file',
    'not-bearer': 'this is not a transfer file issued by this domain'
  }
};
// Wire `code` the claim endpoint attaches to each failure.
const CLAIM_CODES = {
  'not-an-asset': 'not-claimable',
  'bad-signature': 'not-claimable',
  revoked: 'already-claimed',
  suspended: 'suspended',
  expired: 'expired',
  fungible: 'not-claimable',
  bound: 'not-claimable',
  'not-bearer': 'not-claimable'
};

function fail(profile, code, extra) {
  const table = MESSAGES[profile] || {};
  const out = { ok: false, code, message: table[code] || code };
  if (profile.startsWith('bearer-claim') && CLAIM_CODES[code]) out.wireCode = CLAIM_CODES[code];
  return Object.assign(out, extra || {});
}

function isAssetCredential(credential) {
  return !!credential && typeof credential === 'object' && credential.credential === 'domain-atlas-asset/1.0';
}

// Class policy can only narrow. Returns null when allowed.
function classPolicyProblem(classPolicy, operation, transport) {
  if (!classPolicy || typeof classPolicy !== 'object') return null;
  if (Array.isArray(classPolicy.operations) && !classPolicy.operations.includes(operation)) {
    return 'this asset class does not permit ' + operation;
  }
  if (Array.isArray(classPolicy.transports) && !classPolicy.transports.includes(transport)) {
    return 'this asset class does not permit delivery by ' + transport;
  }
  return null;
}

// input: {
//   profile: 'holder-send' | 'bearer-claim:identity' | 'bearer-claim:state',
//   credential, expectedOwner?, expectedClass?,
//   facts: { revoked, suspended, expired, signatureValid, listedBearer },
//   classPolicy?, operation?, transport?
// }
// returns { ok: true } or { ok: false, code, message, wireCode? }
function evaluateTransferPolicy(input) {
  const { profile, credential } = input;
  const facts = input.facts || {};
  const asset = credential && typeof credential === 'object' ? credential.asset : null;

  if (profile === 'holder-send') {
    if (!isAssetCredential(credential)) return fail(profile, 'not-an-asset');
    if (!credential.owner || credential.owner.publicKey !== input.expectedOwner) return fail(profile, 'wrong-owner');
    if (!asset || asset.class !== input.expectedClass) return fail(profile, 'wrong-class');
    if (asset.tradeScope === 'bound') return fail(profile, 'bound');
    if (asset.fungible !== false) return fail(profile, 'fungible');
    if (facts.revoked) return fail(profile, 'revoked');
    if (facts.suspended) return fail(profile, 'suspended');
    if (facts.expired) return fail(profile, 'expired');
    if (!facts.signatureValid) return fail(profile, 'bad-signature');
    const problem = classPolicyProblem(input.classPolicy, input.operation || 'transfer', input.transport || 'wallet');
    if (problem) return { ok: false, code: 'class-policy', message: problem };
    return { ok: true };
  }

  if (profile === 'bearer-claim:identity') {
    if (!isAssetCredential(credential) || !asset || typeof asset !== 'object') return fail(profile, 'not-an-asset');
    if (!facts.signatureValid) return fail(profile, 'bad-signature');
    return { ok: true };
  }

  if (profile === 'bearer-claim:state') {
    if (facts.revoked) return fail(profile, 'revoked');
    if (facts.suspended) return fail(profile, 'suspended');
    if (facts.expired) return fail(profile, 'expired');
    if (!asset || asset.fungible !== false) return fail(profile, 'fungible');
    if (asset.tradeScope === 'bound') return fail(profile, 'bound');
    if (!facts.listedBearer) return fail(profile, 'not-bearer');
    const problem = classPolicyProblem(input.classPolicy, input.operation || 'transfer', input.transport || 'file');
    if (problem) return { ok: false, code: 'class-policy', message: problem, wireCode: 'not-claimable' };
    return { ok: true };
  }

  throw new Error('unknown transfer policy profile: ' + profile);
}

// Domain-level gates for a delivery transport, evaluated where the
// endpoint evaluated them. config: { fileTransfer: null | {classes: null|[..]},
// emailConfigured: bool }. actor: { isAdmin }.
//   stage 'enabled'  is the transport turned on for this domain?
//   stage 'class'    is this asset class allowed on it?
//   stage 'actor'    may this signer start this transport?
function evaluateDeliveryGate(input) {
  const { transport, stage, config = {}, actor = {}, assetClass } = input;
  if (stage === 'enabled') {
    if (transport === 'file') {
      if (!config.fileTransfer) return { ok: false, code: 'not-enabled', message: 'this domain has not enabled file transfers (SPEC.md §13.5)' };
      return { ok: true };
    }
    if (transport === 'email') {
      if (!config.emailConfigured) return { ok: false, code: 'not-configured', message: 'this domain has not configured email-delivered tickets (SPEC.md §13)' };
      return { ok: true };
    }
    return { ok: true };
  }
  if (stage === 'class') {
    const ft = config.fileTransfer;
    if (transport === 'file' && ft && Array.isArray(ft.classes) && !ft.classes.includes(assetClass)) {
      return { ok: false, code: 'class-not-allowed', message: 'this domain does not allow ' + assetClass + ' to be exported to a file' };
    }
    return { ok: true };
  }
  if (stage === 'actor') {
    // The domain sends mail from its own mailbox, so until a per-class and
    // per-sender permission model exists only a registered admin may
    // start an email delivery.
    if (transport === 'email' && !actor.isAdmin) {
      return { ok: false, code: 'not-admin', status: 403, message: 'only a domain admin can send a ticket to an email address' };
    }
    return { ok: true };
  }
  throw new Error('unknown delivery gate stage: ' + stage);
}

// Catalog-level eligibility for minting straight into a bearer delivery
// (the admin "issue to an address" route). Same two conditions as above,
// read from the class definition because no credential exists yet.
function evaluateMintForDelivery(input) {
  const entry = input.catalogEntry;
  if (entry.fungible) return { ok: false, code: 'fungible', message: 'only a unique (non-fungible) item can be sent as an email ticket' };
  if (entry.tradeScope === 'bound') return { ok: false, code: 'bound', message: 'a bound item cannot be sent as an email ticket' };
  const problem = classPolicyProblem(entry.transfer, 'transfer', input.transport || 'email');
  if (problem) return { ok: false, code: 'class-policy', message: problem };
  return { ok: true };
}

module.exports = { evaluateTransferPolicy, evaluateDeliveryGate, evaluateMintForDelivery, KNOWN_OPERATIONS, KNOWN_TRANSPORTS };
