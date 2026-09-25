#!/usr/bin/env node
// Reissues an already-issued, non-fungible credential as a registered
// admin — the CLI replacement for the plain, unauthenticated
// `curl -d '{"credential": ..., "tradeScope": "bound"}' /atlas/asset/reissue`
// the README used to document, now that reissue requires a signed admin
// proof envelope (requireAdmin()/require_admin()) instead of trusting
// whoever could reach the endpoint. See issuer-server/server.js's and
// issuer-php/atlas/asset/reissue.php's own comments on the route for the
// full reasoning (SPEC.md §5.1.1, and why this exists at all: tradeScope
// and properties are both baked into a credential's signed payload at mint
// time, so tightening a catalog entry never retroactively updates an
// already-held credential — this is the only honest fix).
//
// Unlike admin-revoke.js/admin-mail-send.js, the payload here needs a full
// credential JSON object (the exact one the holder currently has), which
// doesn't fit on a command line — so it's read from a file instead.
//
// Two modes, same as admin-mail-send.js:
//
//   Local demo (Node issuer-server on localhost:8001/8002): writes the
//   admin public key straight into the target's admin roster file and
//   posts the request for you.
//
//     node tools/admin-reissue.js <credentialJsonFile> [--properties '<json patch>'] [--tradeScope local|bound] [--domain-b]
//
//   Any other domain (in particular a real issuer-php deployment this
//   script has no filesystem or network access to): --print-only signs
//   the request and prints the admin public key to register yourself
//   (paste it into lib/atlas-admin-keys-store.json by hand) plus the ready
//   {payload, proof} body to curl with.
//
//     node tools/admin-reissue.js <credentialJsonFile> [--properties '<json patch>'] [--tradeScope local|bound] --print-only
//
// At least one of --properties or --tradeScope is required, same
// restriction the endpoint itself enforces.

const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const flags = process.argv.filter((a) => a.startsWith('--'));
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const useDomainB = flags.includes('--domain-b');
const printOnly = flags.includes('--print-only');
const [credentialJsonFile] = positional;

function flagValue(name) {
  const idx = process.argv.indexOf('--' + name);
  return idx === -1 ? undefined : process.argv[idx + 1];
}
const propertiesArg = flagValue('properties');
const tradeScopeArg = flagValue('tradeScope');

if (!credentialJsonFile || (!propertiesArg && !tradeScopeArg)) {
  console.error('Usage: node tools/admin-reissue.js <credentialJsonFile> [--properties \'<json patch>\'] [--tradeScope local|bound] [--domain-b | --print-only]');
  process.exit(1);
}

let credential;
try {
  credential = JSON.parse(fs.readFileSync(credentialJsonFile, 'utf8'));
} catch (err) {
  console.error('Could not read/parse credential JSON from', credentialJsonFile, '-', err.message);
  process.exit(1);
}

let properties;
if (propertiesArg) {
  try {
    properties = JSON.parse(propertiesArg);
  } catch (err) {
    console.error('--properties must be a JSON object -', err.message);
    process.exit(1);
  }
}

const DOMAIN_URL = useDomainB ? 'http://localhost:8002' : 'http://localhost:8001';
const STATE_DIR = useDomainB
  ? path.resolve(__dirname, '..', 'issuer-server', 'domain-b-state')
  : path.resolve(__dirname, '..', 'issuer-server');
const ADMIN_KEYS_FILE = path.join(STATE_DIR, 'atlas-admin-keys-store.json');
const ADMIN_IDENTITY_FILE = path.join(__dirname, '.admin-identity.json');

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Same canonicalize() shape as extension/wallet.js and issuer-server/
// server.js's own crypto helpers — sorted-key JSON, no whitespace.
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

// Same persistent local admin identity tools/admin-revoke.js and
// tools/admin-mail-send.js use — shared across all three tools so one
// registered key covers every admin action.
async function loadOrCreateAdminIdentity() {
  if (fs.existsSync(ADMIN_IDENTITY_FILE)) {
    const saved = JSON.parse(fs.readFileSync(ADMIN_IDENTITY_FILE, 'utf8'));
    const privateKey = await subtle.importKey('jwk', saved.privateKeyJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    return { privateKey, publicKey: saved.publicKey };
  }
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const privateKeyJwk = await subtle.exportKey('jwk', kp.privateKey);
  const publicKey = b64url(raw);
  fs.writeFileSync(ADMIN_IDENTITY_FILE, JSON.stringify({ publicKey, privateKeyJwk }, null, 2));
  console.log('Created a new local admin identity ->', publicKey.slice(0, 20) + '...');
  return { privateKey: kp.privateKey, publicKey };
}

function ensureRegistered(publicKey) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const doc = fs.existsSync(ADMIN_KEYS_FILE) ? JSON.parse(fs.readFileSync(ADMIN_KEYS_FILE, 'utf8')) : { keys: [] };
  if (!doc.keys.some((k) => k.publicKey === publicKey)) {
    doc.keys.push({ publicKey, addedAt: new Date().toISOString() });
    fs.writeFileSync(ADMIN_KEYS_FILE, JSON.stringify(doc, null, 2));
    console.log('Registered this identity as an admin of', DOMAIN_URL, '(', ADMIN_KEYS_FILE, ')');
  }
}

(async () => {
  const admin = await loadOrCreateAdminIdentity();

  const payload = { credential };
  if (properties) payload.properties = properties;
  if (tradeScopeArg) payload.tradeScope = tradeScopeArg;
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, admin.privateKey, data));
  const proof = { signerRole: 'raw-ecdsa', publicKey: admin.publicKey, signature: b64url(sig) };
  const requestBody = { payload, proof };

  if (printOnly) {
    console.log('Admin public key (register this in your domain\'s admin roster, e.g.');
    console.log('lib/atlas-admin-keys-store.json for issuer-php, if it is not already there):');
    console.log(admin.publicKey);
    console.log('\nSigned request body — POST this to your domain\'s /atlas/asset/reissue:');
    console.log(JSON.stringify(requestBody, null, 2));
    return;
  }

  ensureRegistered(admin.publicKey);
  const res = await fetch(DOMAIN_URL + '/atlas/asset/reissue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });
  const resBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Reissue failed:', resBody.error || res.status);
    process.exit(1);
  }
  console.log('Reissued, new credential id ->', resBody.newCredential && resBody.newCredential.id);
})();
