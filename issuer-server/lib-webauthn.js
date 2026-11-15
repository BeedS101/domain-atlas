// Passkey (WebAuthn) assertions as owner and identity proofs. Mirrors issuer-php/lib/webauthn.php rule for rule.
//
// An envelope { signerRole: 'webauthn', publicKey, clientDataJSON, authenticatorData, signature } is accepted only when
//   - every field is canonical base64url within a size limit, and the client data is a JSON object;
//   - it is an authentication ("webauthn.get") assertion, not a registration, whose challenge is the SHA-256 of the
//     canonical payload, and it was not made by a cross-origin frame;
//   - the authenticator data is well formed (37 bytes, plus extension data only when flagged), the user was present, and
//     it carries no attested credential data, which an assertion never has;
//   - the origin is one this issuer expects, and the relying-party hash is the SHA-256 of an id that origin may use;
//   - the ECDSA P-256 signature over authenticatorData || SHA-256(clientDataJSON) verifies under the named key.
//
// The origin and relying-party id are reported by the client, so they are never trusted for what they claim: an origin
// must be on the list this issuer expects, and the authenticator-signed rpIdHash must agree with it.
//
// Expected origins: by default this domain's own origins and any browser-extension origin (the wallet is an extension,
// and its id differs between installs). ATLAS_WEBAUTHN_ORIGINS (comma-separated origins) replaces that default with an
// exact list. ATLAS_WEBAUTHN_RP_IDS additionally pins the relying-party ids. ATLAS_WEBAUTHN_REQUIRE_UV=1 refuses an
// assertion whose authenticator did not verify the user (the wallet asks for "preferred", so this is off by default).
// The signature counter is not checked: synced passkeys report 0. Replay protection is the payload's own nonce.
'use strict';
const crypto = require('crypto');

const MAX_CLIENT_DATA = 8192;
const MAX_AUTH_DATA = 4096;
const MAX_SIGNATURE = 128;
const MAX_KEY = 256;

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const WEB_HOST = '(' + LABEL + '(?:\\.' + LABEL + ')+)';
const PORT = '(?::[0-9]{1,5})?';
const ORIGIN_SHAPES = [
  { scheme: 'https', re: new RegExp('^https://' + WEB_HOST + PORT + '$') },
  { scheme: 'http', re: new RegExp('^http://(localhost)' + PORT + '$') },
  { scheme: 'chrome-extension', re: /^chrome-extension:\/\/([a-p]{32})$/ },
  { scheme: 'moz-extension', re: /^moz-extension:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/ },
  { scheme: 'safari-web-extension', re: /^safari-web-extension:\/\/([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$/ }
];
const isExtensionScheme = (s) => s !== 'https' && s !== 'http';
const IPV4 = /^[0-9.]+$/;

// {scheme, host} for a serialized origin this module can reason about, else null.
function parseOrigin(origin) {
  if (typeof origin !== 'string' || origin.length > 300) return null;
  for (const shape of ORIGIN_SHAPES) {
    const m = shape.re.exec(origin);
    if (m) {
      if (shape.scheme === 'https' && IPV4.test(m[1])) return null; // an address is not a relying-party id
      return { scheme: shape.scheme, host: m[1] };
    }
  }
  return null;
}

// The relying-party ids a page or extension at this origin may use: its host and each parent domain that still has two
// labels (a bare public suffix is never one); an extension or localhost has only itself.
function allowedRpIds(parsed) {
  if (isExtensionScheme(parsed.scheme) || !parsed.host.includes('.')) return [parsed.host];
  const labels = parsed.host.split('.');
  const out = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'));
  return out;
}

function listOf(value) {
  return typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

// ownOrigins: the origins a page of this domain is served from.
function policyFromEnv(env, ownOrigins) {
  env = env || {};
  const pinnedOrigins = env.ATLAS_WEBAUTHN_ORIGINS;
  const pinnedRpIds = env.ATLAS_WEBAUTHN_RP_IDS;
  return {
    ownOrigins: Array.isArray(ownOrigins) ? ownOrigins : [],
    // A pin that is set but lists nothing usable matches nothing, so a typo cannot silently widen the policy.
    origins: typeof pinnedOrigins === 'string' && pinnedOrigins.trim() !== '' ? listOf(pinnedOrigins) : null,
    rpIds: typeof pinnedRpIds === 'string' && pinnedRpIds.trim() !== '' ? listOf(pinnedRpIds) : null,
    requireUv: env.ATLAS_WEBAUTHN_REQUIRE_UV === '1' || env.ATLAS_WEBAUTHN_REQUIRE_UV === 'true'
  };
}

// Strict base64url (no padding, canonical) within a size limit, else null.
function decode(value, maxBytes) {
  if (typeof value !== 'string' || value === '' || value.length > Math.ceil(maxBytes * 4 / 3) + 4) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  const raw = Buffer.from(value, 'base64url');
  if (raw.length > maxBytes || raw.toString('base64url') !== value) return null;
  return raw;
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

// A short reason the assertion is not acceptable, or null. Checks structure and context, not the signature.
function assertionProblem(envelope, expectedChallenge, policy, parts) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || !policy || envelope.signerRole !== 'webauthn') return 'not an assertion';
  const clientDataRaw = decode(envelope.clientDataJSON, MAX_CLIENT_DATA);
  const authData = decode(envelope.authenticatorData, MAX_AUTH_DATA);
  if (!clientDataRaw || !authData) return 'malformed encoding';
  let clientData;
  try { clientData = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clientDataRaw)); } catch (e) { return 'client data is not JSON'; }
  if (!clientData || typeof clientData !== 'object' || Array.isArray(clientData)) return 'client data is not an object';
  if (clientData.type !== 'webauthn.get') return 'not an authentication assertion';
  if (typeof clientData.challenge !== 'string' || clientData.challenge !== expectedChallenge) return 'challenge does not match the payload';
  if (Object.prototype.hasOwnProperty.call(clientData, 'crossOrigin') && clientData.crossOrigin !== false) return 'cross-origin assertion';

  if (authData.length < 37) return 'authenticator data too short';
  const flags = authData[32];
  if ((flags & 0x01) === 0) return 'user not present';
  if ((flags & 0x40) !== 0) return 'attested credential data in an assertion';
  if (((flags & 0x80) !== 0) !== (authData.length > 37)) return 'extension data does not match its flag';
  if (policy.requireUv && (flags & 0x04) === 0) return 'user verification required';

  const parsed = parseOrigin(clientData.origin);
  if (!parsed) return 'unexpected origin';
  const originOk = policy.origins
    ? policy.origins.includes(clientData.origin)
    : policy.ownOrigins.includes(clientData.origin) || isExtensionScheme(parsed.scheme);
  if (!originOk) return 'origin not expected here';
  const rpHash = authData.subarray(0, 32);
  if (!allowedRpIds(parsed).some((id) => rpHash.equals(sha256(id)))) return 'relying party does not match the origin';
  if (policy.rpIds && !policy.rpIds.some((id) => rpHash.equals(sha256(id)))) return 'relying party not expected here';
  if (parts) { parts.clientDataRaw = clientDataRaw; parts.authData = authData; }
  return null;
}

// canonicalPayload: the canonical JSON text of the payload the assertion is meant to sign.
async function verifyWebauthnEnvelope(canonicalPayload, envelope, policy) {
  try {
    const parts = {};
    const challenge = sha256(Buffer.from(canonicalPayload, 'utf8')).toString('base64url');
    if (assertionProblem(envelope, challenge, policy, parts) !== null) return false;
    const signature = decode(envelope.signature, MAX_SIGNATURE);
    const spki = decode(envelope.publicKey, MAX_KEY);
    if (!signature || !spki) return false;
    const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails.namedCurve !== 'prime256v1') return false;
    const signed = Buffer.concat([parts.authData, sha256(parts.clientDataRaw)]);
    return crypto.verify('sha256', signed, { key, dsaEncoding: 'der' }, signature);
  } catch (e) {
    return false;
  }
}

module.exports = { verifyWebauthnEnvelope, assertionProblem, policyFromEnv, parseOrigin, allowedRpIds };
