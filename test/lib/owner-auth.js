// Owners with real P-256 keys for tests that call split, consolidate and
// convert, which need a signature from the credential's owner.
//
//   newOwner(label)      a raw public key (base64url) whose private key is kept here
//   register(identity)   keep the private key of an identity made with Web Crypto
//   signSpend(path, body) the same body with `intent` added, signed by the owner of
//                         the presented credential(s) when that owner came from newOwner;
//                         any other body is returned as it is
//   ownerIntent(owner, action, fields) the {payload, proof} pair for one request
'use strict';
const crypto = require('crypto');

const KEYS = new Map(); // public key -> private KeyObject

function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}

function newOwner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
  KEYS.set(raw, privateKey);
  return raw;
}

// An identity made with Web Crypto elsewhere ({ publicKey: raw base64url, kp: CryptoKeyPair } or { publicKey, privateKey }).
function register(identity) {
  KEYS.set(identity.publicKey, crypto.KeyObject.from((identity.kp || identity).privateKey));
  return identity;
}

function proofFor(owner, payload) {
  const key = KEYS.get(owner);
  if (!key) throw new Error('no key for this owner');
  const signature = crypto.sign('sha256', Buffer.from(canonicalize(payload)), { key, dsaEncoding: 'ieee-p1363' });
  return { signerRole: 'raw-ecdsa', publicKey: owner, signature: signature.toString('base64url') };
}

const PAYLOADS = {
  '/atlas/asset/split': (b, c) => ({ action: 'split', credentialId: c[0].id, sendAmount: b.sendAmount, toPublicKey: b.toPublicKey }),
  '/atlas/asset/consolidate': (b, c) => ({ action: 'consolidate', credentialIds: c.map((x) => x.id) }),
  '/atlas/convert': (b, c) => ({ action: 'convert', credentialId: c[0].id, spendAmount: b.spendAmount, toClass: b.toClass })
};

function ownerIntent(owner, action, fields) {
  const payload = Object.assign({ action }, fields);
  return { payload, proof: proofFor(owner, payload) };
}

// The payload an owner signs for a split, consolidate or convert request body, or null for any other.
function spendPayload(path, body) {
  const build = PAYLOADS[path];
  if (!build || !body || typeof body !== 'object') return null;
  const creds = Array.isArray(body.credentials) ? body.credentials : (body.credential ? [body.credential] : []);
  if (!creds.length || creds.some((c) => !c || typeof c !== 'object')) return null;
  return Object.assign(build(body, creds), {
    requestId: body.requestId === undefined ? null : body.requestId,
    domain: creds[0].issuer && creds[0].issuer.domain
  });
}

function signSpend(path, body) {
  if (!body || typeof body !== 'object' || body.intent) return body;
  try {
    const payload = spendPayload(path, body);
    const creds = Array.isArray(body.credentials) ? body.credentials : [body.credential];
    if (!payload || !KEYS.has(creds[0].owner && creds[0].owner.publicKey)) return body;
    return Object.assign({}, body, { intent: { payload, proof: proofFor(creds[0].owner.publicKey, payload) } });
  } catch (err) {
    return body;
  }
}

// An older wallet.js (Buffer) that also sends the owner's signed intent on a consolidation, which the issuer now
// requires. Only that request changes, so the copy keeps the older behaviour a negative control is about.
function withSignedConsolidation(source) {
  return Buffer.from(source.toString('latin1')
    .replace("body: Object.assign({}, spec.body, { requestId }),", "body: Object.assign({}, typeof spec.body === 'function' ? await spec.body(requestId) : spec.body, { requestId }),")
    .replace("path: '/atlas/asset/consolidate', body: { credentials }, predecessors: credentials.map((c) => c.id)",
      "path: '/atlas/asset/consolidate', predecessors: credentials.map((c) => c.id), body: async (requestId) => { const intentPayload = { action: 'consolidate', credentialIds: credentials.map((c) => c.id), requestId, domain: credentials[0].issuer.domain }; return { credentials, intent: { payload: intentPayload, proof: await signAs('self', intentPayload) } }; }"), 'latin1');
}

module.exports = { withSignedConsolidation, newOwner, register, signSpend, spendPayload, ownerIntent, canonicalize };
