#!/usr/bin/env node
// Signs the admin request POST /atlas/admin/email-tickets/poll-now needs
// (SPEC.md §13.3) — the CLI companion for wiring that endpoint up to a
// cron job on a real issuer-php deployment, which has no background
// timer of its own to run the inbound mailbox poll on (see lib/store.php's
// own atlas_email_tickets_config() comment).
//
// The one thing that makes this different from every other admin-*.js
// tool here: require_admin()'s raw-signature path (issuer-server/
// server.js, issuer-php/lib/store.php) carries no nonce or timestamp at
// all, unlike the admin SESSION layer's own login step — a signature over
// this fixed payload ({action: 'poll-now'}) checks out just as well on
// its hundredth use as its first. So this only ever needs to run ONCE per
// deployment: sign it, save the resulting body to a file on the server,
// and point cron at a plain `curl --data-binary @that-file.json` forever,
// no re-signing per run.
//
// Two modes, same as admin-reissue.js/admin-revoke.js/admin-mail-send.js/
// admin-mint.js:
//
//   Local demo (Node issuer-server on localhost:8001/8002): writes the
//   admin public key straight into the target's admin roster file and
//   runs one real poll right now, printing the summary.
//
//     node tools/admin-poll-now-sign.js [--domain-b]
//
//   Any other domain (in particular a real issuer-php deployment this
//   script has no filesystem or network access to): --print-only signs
//   the request and prints the admin public key to register yourself
//   (paste it into lib/atlas-admin-keys-store.json by hand, if it isn't
//   there already) plus the ready, reusable {payload, proof} body and a
//   sample cron line.
//
//     node tools/admin-poll-now-sign.js --print-only
//
// Shares the same local admin identity file (.admin-identity.json) as
// every other admin-*.js tool here, so one registered key covers this
// alongside every other admin action.

const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const flags = process.argv.filter((a) => a.startsWith('--'));
const useDomainB = flags.includes('--domain-b');
const printOnly = flags.includes('--print-only');

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
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, admin.privateKey, data));
  const proof = { signerRole: 'raw-ecdsa', publicKey: admin.publicKey, signature: b64url(sig) };
  const requestBody = { payload, proof };

  if (printOnly) {
    console.log('Admin public key (register this in your domain\'s admin roster, e.g.');
    console.log('lib/atlas-admin-keys-store.json for issuer-php, if it is not already there):');
    console.log(admin.publicKey);
    console.log('\nSigned request body — no nonce, so this exact body is good for every future');
    console.log('cron run, not just one. Save it to a file on the server, e.g.:\n');
    console.log('  cat > poll-now-body.json <<\'EOF\'');
    console.log(JSON.stringify(requestBody, null, 2));
    console.log('EOF');
    console.log('\nThen point a cron job at it (adjust the path and the schedule to taste):\n');
    console.log('  */5 * * * * curl -fsS -X POST -H "Content-Type: application/json" \\');
    console.log('    --data-binary @/home/youruser/poll-now-body.json \\');
    console.log('    https://your-domain.example/atlas/admin/email-tickets/poll-now >/dev/null 2>&1');
    return;
  }

  ensureRegistered(admin.publicKey);
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
