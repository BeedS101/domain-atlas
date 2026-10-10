#!/usr/bin/env node
// Signs the admin request POST /atlas/admin/email-tickets/poll-now needs
// (SPEC.md §13.3) — the CLI companion for wiring that endpoint up to a
// cron job on a real issuer-php deployment, which has no background
// timer of its own to run the inbound mailbox poll on (see lib/store.php's
// own atlas_email_tickets_config() comment).
//
// Every signed admin request now carries a timestamp and a single-use nonce
// (payload.adminAuth) and is accepted once, within a couple of minutes of
// signing, so a signed body can no longer be saved and replayed from cron.
// The cron job runs this tool with --post instead, which signs a fresh
// request each time. That means the cron host needs Node and the admin
// identity file (.admin-identity.json, an admin private key); keep it
// readable by that user only.
//
// Three modes, same shape as admin-reissue.js/admin-revoke.js/admin-mail-send.js/
// admin-mint.js plus --post:
//
//   Local demo (Node issuer-server on localhost:8001/8002): writes the
//   admin public key straight into the target's admin roster file and
//   runs one real poll right now, printing the summary.
//
//     node tools/admin-poll-now-sign.js [--domain-b]
//
//   Real deployment, from cron: signs a fresh request and POSTs it to
//   <base-url>/atlas/admin/email-tickets/poll-now. The admin public key
//   must already be on that domain's roster. --domain is the host as the
//   server sees it (defaults to the host in <base-url>).
//
//     node tools/admin-poll-now-sign.js --post https://your-domain.example [--domain your-domain.example]
//
//     */5 * * * * node /home/youruser/domain-atlas/tools/admin-poll-now-sign.js --post https://your-domain.example >/dev/null 2>&1
//
//   Any other case: --print-only signs one request and prints it with the
//   admin public key to register. The body is good for one POST within a
//   couple of minutes; --domain <host> is required.
//
//     node tools/admin-poll-now-sign.js --print-only --domain your-domain.example
//
// Shares the same local admin identity file (.admin-identity.json) as
// every other admin-*.js tool here, so one registered key covers this
// alongside every other admin action.

const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { adminAuth, argValue } = require('./lib/admin-auth');
const { subtle } = webcrypto;

const flags = process.argv.filter((a) => a.startsWith('--'));
const useDomainB = flags.includes('--domain-b');
const printOnly = flags.includes('--print-only');
const postBase = argValue('post');

const DOMAIN_URL = postBase ? postBase.replace(/\/+$/, '') : (useDomainB ? 'http://localhost:8002' : 'http://localhost:8001');
// Host the request is signed for (adminAuth.domain). The local demo servers are
// known; with --print-only, name the real domain with --domain <host>, exactly as
// the server sees it (ATLAS_DOMAIN, or the Host header on issuer-php).
const ADMIN_DOMAIN = argValue('domain') || (printOnly ? '' : new URL(DOMAIN_URL).host);
if (!ADMIN_DOMAIN) {
  console.error('--print-only needs --domain <host>, e.g. --domain example.com');
  process.exit(1);
}
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

// Same persistent local admin identity admin-reissue.js/admin-revoke.js/
// admin-mail-send.js/admin-mint.js already share — one registered key
// covers every admin action across all of these tools.
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

  const payload = { action: 'poll-now' };
  payload.adminAuth = adminAuth(ADMIN_DOMAIN, '/atlas/admin/email-tickets/poll-now');
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, admin.privateKey, data));
  const proof = { signerRole: 'raw-ecdsa', publicKey: admin.publicKey, signature: b64url(sig) };
  const requestBody = { payload, proof };

  if (printOnly) {
    console.log('Admin public key (register this in your domain\'s admin roster, e.g.');
    console.log('lib/atlas-admin-keys-store.json for issuer-php, if it is not already there):');
    console.log(admin.publicKey);
    console.log('\nSigned request body — valid for one POST within a couple of minutes:\n');
    console.log(JSON.stringify(requestBody, null, 2));
    console.log('\nFor a recurring job use --post instead; see the top of this file.');
    return;
  }

  if (!postBase) ensureRegistered(admin.publicKey);
  const res = await fetch(DOMAIN_URL + '/atlas/admin/email-tickets/poll-now', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody)
  });
  const resBody = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Poll-now failed:', resBody.error || res.status);
    process.exit(1);
  }
  console.log('Polled', DOMAIN_URL, '->', JSON.stringify(resBody.summary));
})();
