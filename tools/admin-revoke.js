#!/usr/bin/env node
// Revokes a credential as a registered domain admin — the CLI replacement
// for the plain, unauthenticated `curl -d '{"id":...}' /atlas/revoke` the
// README used to document, now that revoke requires a signed admin proof
// envelope (requireAdmin(), issuer-server/server.js) instead of trusting
// whoever can reach the endpoint.
//
// This is deliberately a local operator tool, not a general client: it
// reads (or creates, on first run) a persistent admin keypair from a file
// next to this script, and writes that same public key straight into the
// target domain's admin roster file if it isn't already there. That's the
// same bootstrap a real domain operator does by hand — edit the roster
// file directly, since there's no self-service admin registration by
// design — this script just automates it for local demo use, on the
// assumption that whoever can run it already has filesystem access to the
// server's own state directory (the same trust boundary as editing the
// JSON file in an editor instead).
//
// Usage:
//   node tools/admin-revoke.js <credentialId> [reason]
//   node tools/admin-revoke.js <credentialId> [reason] --domain-b

const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const useDomainB = process.argv.includes('--domain-b');
const [credentialId, reason] = args;

if (!credentialId) {
  console.error('Usage: node tools/admin-revoke.js <credentialId> [reason] [--domain-b]');
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

// Loads this operator's own admin identity, generating and persisting one
// on first run so repeated calls (against either demo domain) reuse the
// same key rather than minting a fresh, never-registered one every time.
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
  ensureRegistered(admin.publicKey);

  const payload = { id: credentialId, reason: reason || 'issuer-request' };
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, admin.privateKey, data));
  const proof = { signerRole: 'raw-ecdsa', publicKey: admin.publicKey, signature: b64url(sig) };

  const res = await fetch(DOMAIN_URL + '/atlas/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, proof })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Revoke failed:', body.error || res.status);
    process.exit(1);
  }
  console.log('Revoked', credentialId, 'on', DOMAIN_URL);
})();
