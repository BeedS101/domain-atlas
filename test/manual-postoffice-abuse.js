// Manual check for Post Office abuse detection (task #96): sends are now
// tracked per membership, a rolling-window threshold auto-flags a
// membership the operator can see, and revoking a flagged membership
// through the EXISTING POST /atlas/revoke endpoint (task #95's symmetric
// check) cuts off both sending AND receiving through this domain in one
// call — no new revocation mechanism needed, just a new trigger for the
// one that already exists.
//
// Deliberately NOT a new public "list activity" HTTP endpoint — see
// recordPostOfficeSend()'s own comment in issuer-server/server.js (and
// record_postoffice_send()'s in issuer-php/lib/store.php) for why: same
// "would leak every member's public key + activity to anyone who asks"
// reasoning already applied to the subscriber roster elsewhere in this
// codebase. The operator reads flagged/recentSendCount straight off
// atlas-postoffice-members-store.json instead — which is exactly what
// this test does too, the same way a real operator would.
//
// This is backend/admin-flow logic, not a UI feature, so unlike the other
// manual-*.js scripts this one talks to Domain B directly over HTTP and
// reads its state file directly, rather than driving the extension.
//
// Requires Domain B running as a real issuer-server instance on 8002 with
// ATLAS_STATE_DIR=issuer-server/domain-b-state (see README.md's "Serve
// the two demo domains") — this test does not start it itself, and reads
// that same state dir directly, so it must run alongside that server on
// the same machine.
//
// Uses the demo defaults (ATLAS_POSTOFFICE_SPAM_THRESHOLD=5,
// ATLAS_POSTOFFICE_SPAM_WINDOW_MS=60000 — more than 5 sends within a
// minute triggers a flag) — sends 6 messages in a quick burst to cross it.
//
// Checks:
//   1. A member who bursts past the threshold gets flagged=true with the
//      right recentSendCount, visible directly in the state file — and
//      none of those sends are themselves blocked; flagging only marks
//      the roster entry, it never rejects a message.
//   2. A different member sending normally (once) is NOT flagged.
//   3. Revoking a flagged membership via /atlas/revoke — the same
//      endpoint every other credential type already uses, nothing new
//      built for this — blocks that identity from BOTH sending through
//      this domain AND being sent to, in one call.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { webcrypto } = require('crypto');
const fs = require('fs');
const path = require('path');
const { subtle } = webcrypto;

const DOMAIN_B = 'http://localhost:8002';
const STATE_FILE = path.resolve(__dirname, '..', 'issuer-server', 'domain-b-state', 'atlas-postoffice-members-store.json');

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

async function genIdentity() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { kp, publicKey: b64url(raw) };
}

// Mirrors extension/wallet.js's signWithSelf() — a raw-ecdsa self-signed
// envelope, the same one verifyEnvelope() on the server checks.
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}

async function claimMembership(ownerPublicKey) {
  const res = await fetch(DOMAIN_B + '/atlas/asset/issue', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerPublicKey, assetClass: 'atlas.postoffice.membership' })
  });
  if (!res.ok) throw new Error('claim failed: ' + await res.text());
  return await res.json();
}

async function sendMail(identity, toPublicKey, subject, body) {
  const payload = { to: { publicKey: toPublicKey }, subject, body };
  const proof = await signWithSelf(identity.kp, identity.publicKey, payload);
  return fetch(DOMAIN_B + '/atlas/postoffice/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, proof })
  });
}

function readMemberByCredentialId(credentialId) {
  const doc = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  return doc.members.find((m) => m.credentialId === credentialId);
}

(async () => {
  console.log('STEP 0: two identities, both claim Domain B Post Office membership');
  const A = await genIdentity();
  const B = await genIdentity();
  const credA = await claimMembership(A.publicKey);
  const credB = await claimMembership(B.publicKey);
  console.log('PASS: A ->', credA.id, ' B ->', credB.id);

  console.log('STEP 1: A sends 6 messages in a quick burst (threshold is 5 within the window)');
  for (let i = 0; i < 6; i++) {
    const res = await sendMail(A, B.publicKey, 'Burst ' + i, 'message ' + i);
    if (!res.ok) throw new Error('send #' + i + ' unexpectedly failed: ' + await res.text());
  }
  console.log('PASS: all 6 sends succeeded — flagging marks the roster entry, it never blocks a send by itself');

  console.log('STEP 2: the operator reading the state file directly sees A flagged, with the right count');
  const memberA = readMemberByCredentialId(credA.id);
  if (!memberA) throw new Error('Expected to find A\'s membership entry in the state file');
  if (memberA.recentSendCount !== 6) throw new Error('Expected recentSendCount 6, got ' + memberA.recentSendCount);
  if (memberA.flagged !== true) throw new Error('Expected flagged true after 6 sends past a threshold of 5, got ' + JSON.stringify(memberA));
  if (!Array.isArray(memberA.sendLog) || memberA.sendLog.length !== 6) throw new Error('Expected sendLog to have 6 entries, got ' + JSON.stringify(memberA.sendLog));
  console.log('PASS: flagged=true, recentSendCount=6, sendLog has 6 timestamps ->', memberA.sendLog);

  console.log('STEP 3: a different member (B) sending normally, just once, is NOT flagged');
  const sendOnce = await sendMail(B, A.publicKey, 'Just one message', 'nothing unusual here');
  if (!sendOnce.ok) throw new Error('B\'s single send unexpectedly failed: ' + await sendOnce.text());
  const memberB = readMemberByCredentialId(credB.id);
  if (!memberB) throw new Error('Expected to find B\'s membership entry in the state file');
  if (memberB.recentSendCount !== 1) throw new Error('Expected B\'s recentSendCount to be 1, got ' + memberB.recentSendCount);
  if (memberB.flagged !== false) throw new Error('Expected B to NOT be flagged after a single normal send, got ' + JSON.stringify(memberB));
  console.log('PASS: B is not flagged — detection is per-membership, not a global trip-wire');

  console.log('STEP 4: operator revokes A\'s flagged membership via the EXISTING /atlas/revoke endpoint');
  const revokeRes = await fetch(DOMAIN_B + '/atlas/revoke', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: credA.id, reason: 'flagged for irregular send activity' })
  });
  if (!revokeRes.ok) throw new Error('revoke failed: ' + await revokeRes.text());
  console.log('PASS: revoke call succeeded — nothing new built for this, it\'s the same endpoint every other credential type already uses');

  console.log('STEP 5: thanks to #95\'s symmetric check, revoked A can no longer send OR receive through Domain B');
  const sendAfterRevoke = await sendMail(A, B.publicKey, 'Should be rejected', 'A is revoked now');
  if (sendAfterRevoke.ok) throw new Error('Expected A\'s send to be rejected after revocation, but it succeeded');
  const sendToRevokedA = await sendMail(B, A.publicKey, 'Should also be rejected', 'A cannot receive either');
  if (sendToRevokedA.ok) throw new Error('Expected a send TO revoked A to be rejected, but it succeeded');
  console.log('PASS: revoked membership can neither send nor receive — one revoke call closed both directions at once');

  console.log('\nALL POST OFFICE ABUSE-DETECTION CHECKS PASSED');
})().catch((err) => {
  console.error('FAILURE:', err);
  process.exitCode = 1;
});
