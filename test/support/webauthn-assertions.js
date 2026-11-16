// Passkey assertions for the envelope-verification tests, built once so the Node and PHP issuers are held to the same
// cases: each case is { name, expect, payload, envelope, env } where env is the operator configuration the case runs
// under. Signatures are real (a throw-away P-256 key); what varies is the client data and authenticator data the
// signature covers, so a refusal can only come from the structural checks.
//
//   node test/support/webauthn-assertions.js out.json   writes the cases for the PHP test
'use strict';
const crypto = require('crypto');
const fs = require('fs');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha = (x) => crypto.createHash('sha256').update(x).digest();
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

const OWN_ORIGIN = 'https://issuer.example';
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXT_ORIGIN = 'chrome-extension://' + EXT_ID;
const MOZ_ID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

function makeIdentity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, spki: b64u(publicKey.export({ type: 'spki', format: 'der' })) };
}

// o: type, origin, rpId, rpIdHash (Buffer), flags, extra (Buffer appended to authenticatorData), challenge, clientData
// (extra client data fields), rawClientData (Buffer used as is), authDataLength (truncate), tamper ('authData' flips a
// byte after signing), signer (another identity)
function assertion(identity, payload, o) {
  o = o || {};
  const challenge = o.challenge || b64u(sha(canonicalize(payload)));
  const cd = Object.assign({ type: 'webauthn.get', challenge, origin: EXT_ORIGIN }, o.clientData);
  if (o.type !== undefined) cd.type = o.type;
  if (o.origin !== undefined) cd.origin = o.origin;
  if (o.noType) delete cd.type;
  if (o.noOrigin) delete cd.origin;
  const clientDataJSON = o.rawClientData || Buffer.from(JSON.stringify(cd));
  const rpId = o.rpId !== undefined ? o.rpId : (() => { const m = /^[a-z-]+:\/\/([^/:]+)/.exec(String(cd.origin)); return m ? m[1] : 'x'; })();
  const rpIdHash = o.rpIdHash || sha(rpId);
  let authData = Buffer.concat([rpIdHash, Buffer.from([o.flags === undefined ? 0x01 : o.flags]), Buffer.from([0, 0, 0, 1]), o.extra || Buffer.alloc(0)]);
  if (o.authDataLength !== undefined) authData = authData.subarray(0, o.authDataLength);
  const signedData = Buffer.concat([authData, sha(clientDataJSON)]);
  const signature = crypto.sign('sha256', signedData, { key: (o.signer || identity).privateKey, dsaEncoding: 'der' });
  let sentAuth = authData;
  if (o.tamper === 'authData') { sentAuth = Buffer.from(authData); sentAuth[36] ^= 0xff; }
  return {
    signerRole: 'webauthn', publicKey: identity.spki,
    clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(sentAuth), signature: b64u(signature)
  };
}

async function buildCases() {
  const id = makeIdentity();
  const other = makeIdentity();
  const payload = { action: 'block', blockedPublicKey: 'BLOCKED-KEY', domain: 'issuer.example', note: 'shared case' };
  const cases = [];
  const add = (name, expect, o, extra) => cases.push(Object.assign({ name, expect, payload, envelope: assertion(id, payload, o), env: {} }, extra));
  const addEnv = (name, expect, env, o) => add(name, expect, o, { env });

  // What the wallet really sends: an extension-origin passkey, rpIdHash = sha256(extension id), user present.
  add('wallet passkey: extension origin, user present', true, {});
  add('wallet passkey: extension origin, relying party is the extension origin (what Chrome sends)', true, { rpId: EXT_ORIGIN });
  add('a Firefox extension origin as its own relying party', true, { origin: 'moz-extension://' + MOZ_ID, rpId: 'moz-extension://' + MOZ_ID });
  add('wallet passkey with user verification', true, { flags: 0x05 });
  add('synced passkey (backup eligible and backed up)', true, { flags: 0x1d });
  add('authenticator extension data after the fixed part', true, { flags: 0x81, extra: Buffer.from([0xa1, 0x61, 0x78, 0x01]) });
  add('a Firefox extension origin', true, { origin: 'moz-extension://' + MOZ_ID, rpId: MOZ_ID });
  add("this domain's own https origin", true, { origin: OWN_ORIGIN, rpId: 'issuer.example' });
  cases.push({ name: 'the raw-ECDSA path is untouched', expect: true, payload, env: {}, envelope: (() => {
    const sig = crypto.sign('sha256', Buffer.from(canonicalize(payload)), { key: id.privateKey, dsaEncoding: 'ieee-p1363' });
    const raw = crypto.createPublicKey({ key: Buffer.from(id.spki, 'base64url'), format: 'der', type: 'spki' }).export({ format: 'jwk' });
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(raw.x, 'base64url'), Buffer.from(raw.y, 'base64url')]);
    return { signerRole: 'raw-ecdsa', publicKey: b64u(point), signature: b64u(sig) };
  })() });

  // Operator configuration.
  addEnv('pinned origin that matches', true, { ATLAS_WEBAUTHN_ORIGINS: EXT_ORIGIN }, {});
  addEnv('pinned origin list with several entries', true, { ATLAS_WEBAUTHN_ORIGINS: 'https://other.example, ' + EXT_ORIGIN }, {});
  addEnv('pinned relying-party id that matches', true, { ATLAS_WEBAUTHN_RP_IDS: EXT_ID }, {});
  addEnv('a pinned page origin may use its parent domain as the relying party', true, { ATLAS_WEBAUTHN_ORIGINS: 'https://app.issuer.example' }, { origin: 'https://app.issuer.example', rpId: 'issuer.example' });
  addEnv('user verification required and present', true, { ATLAS_WEBAUTHN_REQUIRE_UV: '1' }, { flags: 0x05 });
  addEnv('a local development origin, when pinned', true, { ATLAS_WEBAUTHN_ORIGINS: 'http://localhost:8080' }, { origin: 'http://localhost:8080', rpId: 'localhost' });

  addEnv('pinned origin that is a different extension', false, { ATLAS_WEBAUTHN_ORIGINS: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba' }, {});
  addEnv('pinned origins replace the default, so own origin is refused unless listed', false, { ATLAS_WEBAUTHN_ORIGINS: EXT_ORIGIN }, { origin: OWN_ORIGIN, rpId: 'issuer.example' });
  addEnv('pinned relying-party id that does not match', false, { ATLAS_WEBAUTHN_RP_IDS: 'other.example' }, {});
  addEnv('user verification required but absent', false, { ATLAS_WEBAUTHN_REQUIRE_UV: '1' }, { flags: 0x01 });

  // The assertion is not a "get" assertion.
  add('a registration (webauthn.create) client data', false, { type: 'webauthn.create' });
  add('no type in the client data', false, { noType: true });
  add('type is not a string', false, { type: 5 });
  add('type has trailing whitespace', false, { type: 'webauthn.get ' });
  add('challenge is for another payload', false, { challenge: b64u(sha('another payload')) });
  add('challenge is not a string', false, { challenge: 7 });
  add('a cross-origin assertion', false, { clientData: { crossOrigin: true } });
  add('crossOrigin given as a string', false, { clientData: { crossOrigin: 'false' } });

  // The authenticator data.
  add('user presence flag clear', false, { flags: 0x00 });
  add('only user verification set', false, { flags: 0x04 });
  add('attested credential data present in an assertion', false, { flags: 0x41, extra: Buffer.alloc(40, 1) });
  add('extension flag set but no extension data', false, { flags: 0x81 });
  add('trailing bytes without the extension flag', false, { flags: 0x01, extra: Buffer.from([1, 2, 3]) });
  add('authenticator data one byte short', false, { authDataLength: 36 });
  add('empty authenticator data', false, { authDataLength: 0 });

  // Relying-party context.
  add('rpIdHash of the wrong relying party', false, { rpId: 'other-extension-id' });
  add('another extension\'s origin as the relying party', false, { rpId: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba' });
  add('a web origin never gets the extension form of the relying party', false, { origin: OWN_ORIGIN, rpId: OWN_ORIGIN });
  add('rpIdHash all zero', false, { rpIdHash: Buffer.alloc(32, 0) });
  add('an origin that is not this domain', false, { origin: 'https://evil.example', rpId: 'evil.example' });
  add('a look-alike of this domain', false, { origin: 'https://issuer.example.evil.example', rpId: 'issuer.example.evil.example' });
  add('this domain over plain http', false, { origin: 'http://issuer.example', rpId: 'issuer.example' });
  add('own origin with a relying party that is not a suffix of it', false, { origin: OWN_ORIGIN, rpId: 'evil.example' });
  add('own origin with a bare public suffix as relying party', false, { origin: OWN_ORIGIN, rpId: 'example' });
  add('origin with a path', false, { origin: EXT_ORIGIN + '/page.html' });
  add('origin with a trailing slash', false, { origin: EXT_ORIGIN + '/' });
  add('origin with userinfo', false, { origin: 'https://user@issuer.example', rpId: 'issuer.example' });
  add('origin "null"', false, { origin: 'null', rpId: 'null' });
  add('origin is not a string', false, { origin: 5 });
  add('origin missing', false, { noOrigin: true, rpId: EXT_ID });
  add('a file: origin', false, { origin: 'file://', rpId: '' });
  add('a data: scheme origin', false, { origin: 'data://abc', rpId: 'abc' });
  add('a javascript: scheme origin', false, { origin: 'javascript://abc', rpId: 'abc' });

  // Malformed encodings.
  add('client data that is not JSON', false, { rawClientData: Buffer.from('not json') });
  add('client data that is a JSON array', false, { rawClientData: Buffer.from('[1,2]') });
  add('client data that is a JSON string', false, { rawClientData: Buffer.from('"webauthn.get"') });
  add('oversized client data', false, { clientData: { padding: 'x'.repeat(20000) } });
  const padded = (name, field) => {
    const c = { name, expect: false, payload, env: {}, envelope: assertion(id, payload, {}) };
    c.envelope[field] = c.envelope[field] + '=';
    cases.push(c);
  };
  padded('padded base64 in clientDataJSON', 'clientDataJSON');
  padded('padded base64 in authenticatorData', 'authenticatorData');
  padded('padded base64 in signature', 'signature');
  const field = (name, mutate) => { const c = { name, expect: false, payload, env: {}, envelope: assertion(id, payload, {}) }; mutate(c.envelope); cases.push(c); };
  field('base64 with a standard-alphabet character', (e) => { e.signature = e.signature.slice(0, 8) + '+' + e.signature.slice(9); });
  field('clientDataJSON is a number', (e) => { e.clientDataJSON = 5; });
  field('authenticatorData is an array', (e) => { e.authenticatorData = []; });
  field('signature is an object', (e) => { e.signature = {}; });
  field('publicKey is missing', (e) => { delete e.publicKey; });
  field('publicKey is not a key', (e) => { e.publicKey = b64u(Buffer.from('not a key')); });
  field('an unknown signer role', (e) => { e.signerRole = 'passkey'; });
  field('no signature at all', (e) => { delete e.signature; });

  // Signatures.
  add('signature by a different key than the one named', false, { signer: other });
  add('authenticator data altered after signing', false, { tamper: 'authData' });
  return cases;
}

module.exports = { buildCases, assertion, makeIdentity, canonicalize, b64u, sha, OWN_ORIGIN, EXT_ORIGIN, EXT_ID };

if (require.main === module) {
  buildCases().then((cases) => { fs.writeFileSync(process.argv[2], JSON.stringify(cases)); console.log('wrote ' + cases.length + ' cases'); });
}
