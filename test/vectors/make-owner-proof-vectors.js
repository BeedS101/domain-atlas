// Regenerates test/vectors/owner-proof.json: the cases both issuers' owner-proof decision tables must agree on.
// Signatures are made with throw-away test keys created on each run, so a regenerated file differs in every
// signature; commit it only when the set of cases changes.
//   node test/vectors/make-owner-proof-vectors.js
'use strict';
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;
const proofLib = require('../../issuer-server/lib-owner-proof');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const DOMAIN = 'issuer.example.test';
const OTHER_DOMAIN = 'other.example.test';
const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const POST_OFFICE = 'atlas.postoffice.membership';
const RID = 'req-0123456789abcdef';
const ONE_POINT_ZERO = '__ONE_POINT_ZERO__';

async function newKey() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { pair, publicKey: b64u(await subtle.exportKey('raw', pair.publicKey)) };
}
async function sign(key, payload) {
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.pair.privateKey, new TextEncoder().encode(proofLib.canonicalize(payload)));
  return { signerRole: 'raw-ecdsa', publicKey: key.publicKey, signature: b64u(sig) };
}

(async () => {
  const owner = await newKey();
  const victim = await newKey();
  const attacker = await newKey();
  const cases = [];
  const add = (name, body, expect, ctx) => cases.push({ name, ctx: Object.assign({ domain: DOMAIN, mode: 'require', nowMs: NOW, requireFresh: true }, ctx || {}), body, expect });
  const request = async (signer, fields, payloadOver) => {
    const f = Object.assign({ assetClass: POST_OFFICE, domain: DOMAIN, issuedAt: iso(NOW), ownerPublicKey: owner.publicKey, requestId: RID }, fields || {});
    const payload = Object.assign(proofLib.issuePayload(f), payloadOver || {});
    return { payload, proof: await sign(signer, payload) };
  };
  const body = (intent, over) => Object.assign({ ownerPublicKey: owner.publicKey, assetClass: POST_OFFICE, requestId: RID, intent }, over || {});
  const refused = (status, code) => ({ ok: false, status, code });
  const OWNER_REQUIRED = refused(403, 'owner-authorization-required');
  const SIGNED = { ok: true, signed: true };

  // modes
  add('off: an unsigned request is not this check\'s business', body(undefined), { ok: true, skipped: true }, { mode: 'off' });
  add('off: even a bad intent is ignored', body('garbage'), { ok: true, skipped: true }, { mode: 'off' });
  add('accept: an unsigned request passes as an unsigned issuance', body(undefined), { ok: true, legacy: true }, { mode: 'accept' });
  add('accept: an intent of null counts as none', body(null), { ok: true, legacy: true }, { mode: 'accept' });
  add('require: an unsigned request is refused', body(undefined), OWNER_REQUIRED);
  add('require: an intent of null is refused', body(null), OWNER_REQUIRED);
  add('a class outside the three is never gated (require)', { ownerPublicKey: owner.publicKey, assetClass: 'atlas.badge', requestId: RID }, { ok: true, skipped: true });
  add('no assetClass is not gated here', { ownerPublicKey: owner.publicKey }, { ok: true, skipped: true });

  // good requests, in both modes and for each class
  for (const cls of proofLib.OWNER_PROOF_CLASSES) {
    for (const mode of ['accept', 'require']) {
      const intent = await request(owner, { assetClass: cls });
      add(`${mode}: a correct request for ${cls} is accepted`, body(intent, { assetClass: cls }), SIGNED, { mode });
    }
  }
  {
    const intent = await request(owner);
    add('a correct request for the Global Mail class (canonical bytes pinned for the wallet)', body(intent), SIGNED);
    cases[cases.length - 1].canonicalPayload = proofLib.canonicalize(intent.payload);
  }

  // bad signatures are refused in accept as well as require
  for (const mode of ['accept', 'require']) {
    const good = await request(owner);
    const flipped = JSON.parse(JSON.stringify(good));
    flipped.proof.signature = flipped.proof.signature.slice(0, -2) + (flipped.proof.signature.slice(-2) === 'AA' ? 'BB' : 'AA');
    add(`${mode}: a signature with its last bytes changed is refused`, body(flipped), refused(403, 'owner-signature-invalid'), { mode });
    const bytes = Buffer.from(good.proof.signature, 'base64url');
    add(`${mode}: a truncated signature is refused`, body({ payload: good.payload, proof: Object.assign({}, good.proof, { signature: b64u(bytes.subarray(0, 40)) }) }), refused(403, 'owner-signature-invalid'), { mode });
    const forged = await request(attacker);
    forged.proof.publicKey = owner.publicKey;
    add(`${mode}: the attacker's signature under the owner's name is refused`, body(forged), refused(403, 'owner-signature-invalid'), { mode });
    add(`${mode}: a passkey-style proof that does not verify is refused`, body({ payload: good.payload, proof: { signerRole: 'webauthn', publicKey: owner.publicKey, clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' } }), refused(403, 'owner-signature-invalid'), { mode });
    add(`${mode}: an unknown signer role is refused`, body({ payload: good.payload, proof: Object.assign({}, good.proof, { signerRole: 'magic' }) }), refused(403, 'owner-signature-invalid'), { mode });
  }

  // wrong identity
  {
    const asVictim = await request(attacker, { ownerPublicKey: victim.publicKey });
    add('the attacker signs a request naming the victim: refused as not the owner', body(asVictim, { ownerPublicKey: victim.publicKey }), refused(403, 'not-owner'));
    add('the same, in accept mode', body(asVictim, { ownerPublicKey: victim.publicKey }), refused(403, 'not-owner'), { mode: 'accept' });
    const own = await request(attacker, { ownerPublicKey: attacker.publicKey });
    add('the attacker\'s own request replayed with the victim as the body recipient is refused', body(own, { ownerPublicKey: victim.publicKey }), OWNER_REQUIRED);
    const ownerReq = await request(owner);
    add('the owner\'s request with the proof key swapped for the attacker\'s is refused', body({ payload: ownerReq.payload, proof: Object.assign({}, ownerReq.proof, { publicKey: attacker.publicKey }) }), refused(403, 'owner-signature-invalid'));
  }

  // wrong binding
  {
    add('a request signed for another domain is refused', body(await request(owner, { domain: OTHER_DOMAIN })), OWNER_REQUIRED);
    add('a request for one class presented for another is refused', body(await request(owner, { assetClass: 'atlas.membership' })), OWNER_REQUIRED);
    add('a request for another recipient is refused', body(await request(owner, { ownerPublicKey: victim.publicKey })), OWNER_REQUIRED);
    add('a request for another request id is refused', body(await request(owner, { requestId: 'req-ffffffffffffffff' })), OWNER_REQUIRED);
    add('a quantity of 2 is refused', body(await request(owner, {}, { quantity: 2 })), OWNER_REQUIRED);
    add('a quantity of "1" (text) is refused', body(await request(owner, {}, { quantity: '1' })), OWNER_REQUIRED);
    const wholeNumber = await request(owner, {}, { quantity: 1 });
    const p = JSON.parse(JSON.stringify(wholeNumber));
    p.payload.quantity = ONE_POINT_ZERO;
    add('a quantity written 1.0 is the same value as 1', body(p), SIGNED);
    add('an extra field in the signed payload is refused', body(await request(owner, {}, { note: 'x' })), OWNER_REQUIRED);
    const missing = await request(owner);
    delete missing.payload.quantity;
    missing.proof = await sign(owner, missing.payload);
    add('a signed payload with a field missing is refused', body(missing), OWNER_REQUIRED);
    add('another operation named in the signed payload is refused', body(await request(owner, {}, { action: 'convert' })), OWNER_REQUIRED);
    add('a signed mail check presented as an issue request is refused', body({ payload: { action: 'mail-check', domain: DOMAIN, credentialIds: [], issuedAt: iso(NOW), nonce: 'nnnnnnnnnnnnnnnnnn' }, proof: await sign(owner, { action: 'mail-check', domain: DOMAIN, credentialIds: [], issuedAt: iso(NOW), nonce: 'nnnnnnnnnnnnnnnnnn' }) }), OWNER_REQUIRED);
    const wrapped = { ctx: 'atlas.bridge.sign/1', origin: 'https://page.example.test', payload: proofLib.issuePayload({ assetClass: POST_OFFICE, domain: DOMAIN, issuedAt: iso(NOW), ownerPublicKey: owner.publicKey, requestId: RID }) };
    add('a bridge-wrapped signature is refused', body({ payload: wrapped, proof: await sign(owner, wrapped) }), OWNER_REQUIRED);
  }

  // request id
  {
    const intent = await request(owner);
    const noId = body(intent); delete noId.requestId;
    add('a signed request without a requestId is refused', noId, refused(400, 'request-id-required'));
    add('a requestId that is too short is refused', body(intent, { requestId: 'short' }), refused(400, 'request-id-required'));
    add('a requestId that is not text is refused', body(intent, { requestId: 12345678901234567 }), refused(400, 'request-id-required'));
    add('a requestId with a forbidden character is refused', body(intent, { requestId: 'req 0123456789abcdef' }), refused(400, 'request-id-required'));
  }

  // malformed shapes
  for (const [label, value] of [['a string', 'x'], ['a number', 7], ['true', true], ['an array', []], ['an empty object', {}], ['a list of two', [1, 2]]]) {
    add(`an intent that is ${label} is refused`, body(value), OWNER_REQUIRED);
    add(`accept: an intent that is ${label} is refused`, body(value), OWNER_REQUIRED, { mode: 'accept' });
  }
  {
    const good = await request(owner);
    add('a payload that is a list is refused', body({ payload: [good.payload], proof: good.proof }), OWNER_REQUIRED);
    add('a proof that is a string is refused', body({ payload: good.payload, proof: 'x' }), OWNER_REQUIRED);
    add('a proof without a key is refused', body({ payload: good.payload, proof: { signerRole: 'raw-ecdsa', signature: good.proof.signature } }), refused(403, 'owner-signature-invalid'));
    add('a proof key that is not text is refused', body({ payload: good.payload, proof: Object.assign({}, good.proof, { publicKey: 5 }) }), refused(403, 'owner-signature-invalid'));
    add('no recipient in the body is refused', { assetClass: POST_OFFICE, requestId: RID, intent: good }, OWNER_REQUIRED);
    add('a recipient that is not text is refused', body(good, { ownerPublicKey: 5 }), OWNER_REQUIRED);
  }

  // time
  {
    const at = async (ms) => body(await request(owner, { issuedAt: iso(ms) }));
    add('a request made now is fresh', await at(NOW), SIGNED);
    add('a request exactly two minutes old is still fresh', await at(NOW - 120000), SIGNED);
    add('a request exactly two minutes ahead is still fresh', await at(NOW + 120000), SIGNED);
    add('a request 121 seconds old is stale', await at(NOW - 121000), { ok: false, status: 401, code: 'stale-request', serverTime: iso(NOW) });
    add('a request 121 seconds ahead is stale', await at(NOW + 121000), { ok: false, status: 401, code: 'stale-request', serverTime: iso(NOW) });
    add('an old request is accepted when freshness is not being asked for (a retry of a completed issuance)', await at(NOW - 86400000), SIGNED, { requireFresh: false });
    add('an old request in accept mode is stale when freshness is asked for', await at(NOW - 600000), { ok: false, status: 401, code: 'stale-request', serverTime: iso(NOW) }, { mode: 'accept' });
    for (const [label, text] of [
      ['without milliseconds', '2026-11-17T12:00:00Z'], ['with an offset', '2026-11-17T12:00:00.000+00:00'], ['date only', '2026-11-17'],
      ['an impossible day', '2026-02-31T12:00:00.000Z'], ['an impossible hour', '2026-11-17T25:00:00.000Z'], ['a space for the T', '2026-11-17 12:00:00.000Z'],
      ['not a date', 'now'], ['empty', '']
    ]) {
      const bad = await request(owner, {}, { issuedAt: text });
      add(`an issue time ${label} is refused`, body(bad), OWNER_REQUIRED);
    }
    const num = await request(owner, {}, { issuedAt: NOW });
    add('an issue time that is a number is refused', body(num), OWNER_REQUIRED);
  }

  let text = JSON.stringify({
    about: 'Decision table shared by issuer-server/lib-owner-proof.js and issuer-php/lib/owner-proof.php. Each case is a request body, the context the issuer supplies, and the exact verdict both must return. Signatures are raw P-256 over the canonical payload, made with throw-away test keys.',
    keys: { owner: owner.publicKey, victim: victim.publicKey, attacker: attacker.publicKey },
    cases
  }, null, 1);
  text = text.split('"' + ONE_POINT_ZERO + '"').join('1.0');
  fs.writeFileSync(path.join(__dirname, 'owner-proof.json'), text + '\n');
  console.log('wrote', cases.length, 'cases');
})();
