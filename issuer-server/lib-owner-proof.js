// Owner proof for membership issuance: the recipient key signs an exact "issue" request.
//
// A pure decision over plain data, so issuer-php/lib/owner-proof.php can implement the identical table and both are
// checked against test/vectors/owner-proof.json. Signature verification is injected: the issuer passes its own
// envelope check (raw P-256 or passkey assertion) and this module never sees a key store, a clock or a file.
//
// The signed payload, the same intent shape split, consolidate and convert already use:
//   { action: 'issue', assetClass, domain, issuedAt, ownerPublicKey, quantity: 1, requestId }
// signed by ownerPublicKey. Binding it to the issuer domain, the class, the recipient, the operation and the request id
// means it authorizes exactly one issuance at exactly one issuer.
//
// Order of checks (each refusal names its code):
//   1 mode 'off', or a class outside OWNER_PROOF_CLASSES: not this module's business
//   2 no intent: 'accept' lets the request through as an unsigned (legacy) issuance, 'require' refuses
//   3 an intent that is present is checked in every mode: shape, request id, exact payload, signature, signer
//   4 freshness (only when asked: a retry of an issuance already completed has legitimately aged)
'use strict';

const OWNER_PROOF_CLASSES = ['atlas.membership', 'atlas.postoffice.membership', 'atlas.tradingstation.membership'];
const OWNER_PROOF_MODES = ['off', 'accept', 'require'];
const OWNER_PROOF_WINDOW_MS = 2 * 60 * 1000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/;
const ISSUED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// What a wallet that predates the signed request shows when this issuer insists on one.
const UPDATE_WALLET_MESSAGE = 'This domain requires a newer version of Domain Atlas Wallet to join this service. Please update your wallet and try again.';

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

// The configured mode, or 'accept' for a missing or unknown value (reported by the caller).
function parseMode(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return OWNER_PROOF_MODES.includes(v) ? v : null;
}

function needsProof(assetClass, mode) {
  return mode !== 'off' && OWNER_PROOF_CLASSES.includes(assetClass);
}

function issuePayload(fields) {
  return {
    action: 'issue', assetClass: fields.assetClass, domain: fields.domain, issuedAt: fields.issuedAt,
    ownerPublicKey: fields.ownerPublicKey, quantity: 1, requestId: fields.requestId
  };
}

// Milliseconds for a canonical UTC timestamp with milliseconds, or null. The round trip refuses dates that roll over
// (2026-02-31) and any spelling other than the one a wallet writes, so every implementation reads the same instant.
function parseIssuedAt(value) {
  if (typeof value !== 'string' || !ISSUED_AT_PATTERN.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) return null;
  return ms;
}

function refuse(status, code, error, extra) {
  return Object.assign({ ok: false, status, code, error }, extra || {});
}

// pastWindowMs widens only how old a request may be (a native app re-sending its saved request); a request signed ahead
// of the issuer's clock is judged by the standard window either way.
function staleProblem(issuedAtMs, nowMs, pastWindowMs) {
  const past = Number.isFinite(pastWindowMs) ? Math.max(pastWindowMs, OWNER_PROOF_WINDOW_MS) : OWNER_PROOF_WINDOW_MS;
  if (issuedAtMs - nowMs <= OWNER_PROOF_WINDOW_MS && nowMs - issuedAtMs <= past) return null;
  return refuse(401, 'stale-request', 'request is outside the allowed time window', { serverTime: new Date(nowMs).toISOString() });
}

// ctx: { domain, mode, nowMs, requireFresh }. verify(payload, proof) resolves to exactly true for a good signature.
// Resolves to { ok: true, skipped | legacy | signed, issuedAtMs? } or { ok: false, status, code, error }.
async function ownerProofVerdict(body, ctx, verify) {
  const assetClass = isObject(body) ? body.assetClass : undefined;
  if (!needsProof(assetClass, ctx.mode)) return { ok: true, skipped: true };
  const intent = body.intent;
  if (intent === undefined || intent === null) {
    if (ctx.mode === 'require') {
      return refuse(403, 'owner-authorization-required', UPDATE_WALLET_MESSAGE, { updateWallet: true });
    }
    return { ok: true, legacy: true };
  }
  if (!isObject(intent) || !isObject(intent.payload) || !isObject(intent.proof)) {
    return refuse(403, 'owner-authorization-required', 'The signed request is malformed.');
  }
  if (typeof body.requestId !== 'string' || !REQUEST_ID_PATTERN.test(body.requestId)) {
    return refuse(400, 'request-id-required', 'A signed membership request needs a requestId of 16 to 80 characters of letters, digits, - and _.');
  }
  if (typeof body.ownerPublicKey !== 'string' || body.ownerPublicKey === '') {
    return refuse(403, 'owner-authorization-required', 'The signed request does not name the recipient.');
  }
  const issuedAtMs = parseIssuedAt(intent.payload.issuedAt);
  if (issuedAtMs === null) return refuse(403, 'owner-authorization-required', 'The signed request has no valid issue time.');
  const expected = issuePayload({
    assetClass, domain: ctx.domain, issuedAt: intent.payload.issuedAt, ownerPublicKey: body.ownerPublicKey, requestId: body.requestId
  });
  if (canonicalize(intent.payload) !== canonicalize(expected)) {
    return refuse(403, 'owner-authorization-required', 'The signed request does not authorize exactly this issuance at this domain.');
  }
  let good = false;
  try { good = typeof intent.proof.publicKey === 'string' && (await verify(intent.payload, intent.proof)) === true; } catch (err) { good = false; }
  if (!good) return refuse(403, 'owner-signature-invalid', 'The request signature does not check out.');
  if (intent.proof.publicKey !== body.ownerPublicKey) {
    return refuse(403, 'not-owner', 'The request was not signed by the key the membership is issued to.');
  }
  if (ctx.requireFresh) {
    const stale = staleProblem(issuedAtMs, ctx.nowMs);
    if (stale) return stale;
  }
  return { ok: true, signed: true, issuedAtMs };
}

// ---------- what an operator needs to know before switching to 'require' ----------
// One small JSON document per issuer, written by whichever issuer (Node or PHP) serves the requests, read by
// tools/owner-proof-readiness.js. It counts outcomes per class and holds no keys, credentials or request ids.
function emptyStats() {
  return { version: 1, mode: null, modeSince: null, updatedAt: null, classes: {}, refusedByCode: {} };
}
function classStats(doc, assetClass) {
  if (!doc.classes[assetClass]) doc.classes[assetClass] = { signed: 0, unsigned: 0, refused: 0, lastSignedAt: null, lastUnsignedAt: null, lastRefusedAt: null };
  return doc.classes[assetClass];
}
// kind: 'signed' | 'unsigned' | 'refused' (code names the refusal). Returns the document.
function recordOutcome(doc, assetClass, kind, code, nowIso) {
  const d = doc && typeof doc === 'object' && doc.classes ? doc : emptyStats();
  const c = classStats(d, assetClass);
  if (kind === 'signed') { c.signed++; c.lastSignedAt = nowIso; }
  else if (kind === 'unsigned') { c.unsigned++; c.lastUnsignedAt = nowIso; }
  else {
    c.refused++; c.lastRefusedAt = nowIso;
    const k = typeof code === 'string' ? code : 'unknown';
    d.refusedByCode[k] = (d.refusedByCode[k] || 0) + 1;
  }
  d.updatedAt = nowIso;
  return d;
}
function recordMode(doc, mode, nowIso) {
  const d = doc && typeof doc === 'object' && doc.classes ? doc : emptyStats();
  if (d.mode !== mode) { d.mode = mode; d.modeSince = nowIso; d.updatedAt = nowIso; }
  return d;
}
// Whether this issuer can switch to 'require' without turning away a wallet that works today: nothing unsigned within
// the last `days`, and at least one signed issuance seen at all (so the signed path is known to work on this deployment).
function readiness(doc, nowMs, days) {
  const d = doc && typeof doc === 'object' && doc.classes ? doc : emptyStats();
  const windowMs = (days || 7) * 86400000;
  const recent = (iso) => typeof iso === 'string' && Number.isFinite(Date.parse(iso)) && nowMs - Date.parse(iso) < windowMs;
  const rows = Object.keys(d.classes).sort().map((cls) => {
    const c = d.classes[cls];
    return { assetClass: cls, signed: c.signed, unsigned: c.unsigned, refused: c.refused, lastSignedAt: c.lastSignedAt, lastUnsignedAt: c.lastUnsignedAt, unsignedRecently: recent(c.lastUnsignedAt) };
  });
  const signedSeen = rows.some((r) => r.signed > 0);
  const unsignedRecently = rows.filter((r) => r.unsignedRecently).map((r) => r.assetClass);
  let state;
  if (d.mode === 'require') state = 'enforcing';
  else if (d.mode === 'off') state = 'off';
  else if (unsignedRecently.length) state = 'not-ready';
  else if (!signedSeen) state = 'no-signed-yet';
  else state = 'ready';
  return { state, mode: d.mode, modeSince: d.modeSince, days: days || 7, signedSeen, unsignedRecently, rows, refusedByCode: d.refusedByCode, updatedAt: d.updatedAt };
}

module.exports = {
  UPDATE_WALLET_MESSAGE, emptyStats, recordOutcome, recordMode, readiness,
  OWNER_PROOF_CLASSES, OWNER_PROOF_MODES, OWNER_PROOF_WINDOW_MS,
  parseMode, needsProof, issuePayload, parseIssuedAt, staleProblem, ownerProofVerdict, canonicalize
};
