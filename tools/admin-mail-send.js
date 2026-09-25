#!/usr/bin/env node
// Sends domain-to-subscriber mail as a registered admin — the replacement
// for the plain, unauthenticated curl command issuer-php/README.txt and
// this project's own manual-*.js tests used to document, now that
// /atlas/mail/send requires a signed admin proof envelope (requireAdmin()/
// require_admin()) instead of trusting whoever could reach the endpoint.
//
// Two modes:
//
//   Local demo (Node issuer-server on localhost:8001/8002): writes the
//   admin public key straight into the target's admin roster file and
//   posts the request for you, the same convenience tools/admin-revoke.js
//   already gives that pair of servers.
//
//     node tools/admin-mail-send.js <credentialId> <subject> <body> [--domain-b]
//
//   Any other domain (in particular a real issuer-php deployment this
//   script has no filesystem or network access to): --print-only signs
//   the request and prints the admin public key to register yourself
//   (paste it into lib/atlas-admin-keys-store.json via your host's file
//   manager or SSH, same way this bundle's subscriber roster is already
//   edited by hand) plus the ready {payload, proof} body to curl with.
//
//     node tools/admin-mail-send.js <credentialId> <subject> <body> --print-only

const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const flags = process.argv.filter((a) => a.startsWith('--'));
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const useDomainB = flags.includes('--domain-b');
const printOnly = flags.includes('--print-only');
const [credentialId, subject, body] = positional;

if (!credentialId || !subject || !body) {
  console.error('Usage: node tools/admin-mail-send.js <credentialId> <subject> <body> [--domain-b | --print-only]');
  process.exit(1);
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

// Same persistent local admin identity tools/admin-revoke.js uses — shared
// across both tools so one registered key covers every admin action.
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

  const payload = { credentialId, subject, body };
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, admin.privateKey, data));
  const proof = { signerRole: 'raw-ecdsa', publicKey: admin.publicKey, signature: b64url(sig) };
  const requestBody = { payload, proof };

  if (printOnly) {
    console.log('Admin public key (register this in your domain\'s admin roster, e.g.');
    console.log('lib/atlas-admin-keys-store.json for issuer-php, if it is not already there):');
    console.log(admin.publicKey);
    console.log('\nSigned request body — POST this to your domain\'s /atlas/mail/send:');
    console.log(JSON.stringify(requestBody, null, 2));
    return;
  }

  ensureRegistered(admin.publicKey);
  const res = await fetch(DOMAIN_URL + '/atlas/mail/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });
  const resBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Send failed:', resBody.error || res.status);
    process.exit(1);
  }
  console.log('Sent, id ->', resBody.id);
})();
