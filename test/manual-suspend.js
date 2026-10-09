// Manual check for the suspend/unsuspend mechanism: a reversible pause
// between "valid" and "revoked" (see SUSPENSIONS_FILE's own comment in
// issuer-server/server.js for the full design — a fraud-investigation
// freeze that can be lifted, or can carry its own expiresAt and lift
// itself, as opposed to revoke's permanent, one-way kill).
//
// One isolated issuer-server instance (own port/state dir), same
// self-contained pattern as test/manual-bank-approval.js and
// test/manual-asset-history-php.js.
//
// Checks:
//   1. Admin suspends a held, transferable credential (indefinite, no
//      expiresAt) — a subsequent /atlas/asset/transfer is rejected with a
//      clear "currently suspended" error, not the generic revoked one.
//   2. GET-equivalent /atlas/mail/check reports {status: 'suspended',
//      reason, expiresAt: null} for that id.
//   3. Admin unsuspends it — the same transfer that was just rejected now
//      succeeds.
//   4. A suspension given an expiresAt already in the past never blocks
//      anything and is invisible to mail/check — it auto-lifted, no
//      explicit unsuspend call needed.
//   5. A suspended Post Office membership can no longer send mail through
//      this domain (same "you do not hold a membership" rejection a
//      revoked membership already gets — suspension and revocation share
//      that roster-lookup gate, so the message doesn't distinguish them,
//      same as it already didn't distinguish revoked-vs-never-joined).
//
// Cross-domain enforcement (a foreign domain's suspension, checked via
// .well-known/atlas-suspensions.json in verifyForeignAssetCredential) is
// NOT separately covered here — it reuses the exact same fetch-and-check
// shape already exercised for foreign revocation in
// test/manual-federation-relay.js, just against a second document, and is
// verified by code review against that identical, already-proven pattern
// rather than a new dedicated cross-domain test this round.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const PORT = 8171; // isolated — distinct from every other manual-*.js test's chosen port
const DOMAIN = 'localhost:' + PORT;
const BASE = 'http://' + DOMAIN;
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-suspend-node-'));
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-suspend-docroot-'));
const ADMIN_KEYS_FILE = path.join(STATE_DIR, 'atlas-admin-keys-store.json');

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
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
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}
function postJson(urlPath, body) {
  return fetch(BASE + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
}
async function adminCall(urlPath, admin, payload) {
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  return postJson(urlPath, { payload, proof });
}
async function issueAsset(ownerPublicKey, assetClass) {
  const res = await postJson('/atlas/asset/issue', { ownerPublicKey, assetClass });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ': ' + JSON.stringify(res.body));
  return res.body;
}
async function transfer(credential, ownerKp, ownerPublicKey, recipientPublicKey) {
  const intentPayload = { credentialId: credential.id, recipientPublicKey, action: 'transfer' };
  const intentProof = await signWithSelf(ownerKp, ownerPublicKey, intentPayload);
  return postJson('/atlas/asset/transfer', { credential, recipientPublicKey, intent: { payload: intentPayload, proof: intentProof } });
}
async function mailCheckStatus(who, credential) {
  const payload = { action: 'mail-check', domain: new URL(BASE).host, credentialIds: [credential.id], issuedAt: new Date().toISOString(), nonce: b64url(webcrypto.getRandomValues(new Uint8Array(18))) };
  const proof = await signWithSelf(who.kp, who.publicKey, payload);
  const res = await postJson('/atlas/mail/check', { credentials: [credential], payload, proof });
  if (res.status !== 200) throw new Error('mail check failed: ' + JSON.stringify(res.body));
  return res.body.updates.find((u) => u.id === credential.id) || null;
}

(async () => {
  console.log('SETUP: starting an isolated issuer-server instance on port ' + PORT);
  const proc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: DOCROOT_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    proc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-server up on port ' + PORT);

  try {
    console.log('SETUP: seeding an admin identity, minting a transferable credential to an owner, joining the Post Office');
    const admin = await genIdentity();
    const owner = await genIdentity();
    const recipient = await genIdentity();
    fs.writeFileSync(ADMIN_KEYS_FILE, JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
    let credential = await issueAsset(owner.publicKey, 'atlas.demo.attestation.filing'); // confirmed transferable, no tradeScope override

    console.log('STEP 1: admin suspends the credential (indefinite, no expiresAt) — a transfer is rejected with a clear "suspended" error');
    const suspendRes = await adminCall('/atlas/suspend', admin, { id: credential.id, reason: 'fraud-investigation' });
    assert(suspendRes.status === 200, 'expected the suspend call to succeed, got ' + suspendRes.status + ': ' + JSON.stringify(suspendRes.body));
    const blockedTransfer = await transfer(credential, owner.kp, owner.publicKey, recipient.publicKey);
    assert(blockedTransfer.status === 400, 'expected the transfer to be rejected while suspended, got ' + blockedTransfer.status);
    assert(/currently suspended pending review/.test(blockedTransfer.body.error || ''), 'expected a "currently suspended" error, got: ' + JSON.stringify(blockedTransfer.body));
    console.log('PASS: transfer rejected while suspended ->', blockedTransfer.body.error);

    console.log('STEP 2: /atlas/mail/check reports a suspended status for the id, with the reason and expiresAt: null');
    const status1 = await mailCheckStatus(owner, credential);
    assert(status1 && status1.status === 'suspended', 'expected mail/check to report status "suspended", got: ' + JSON.stringify(status1));
    assert(status1.reason === 'fraud-investigation', 'expected the suspension reason to come through, got: ' + JSON.stringify(status1));
    assert(status1.expiresAt === null, 'expected expiresAt to be null for an indefinite suspension, got: ' + JSON.stringify(status1));
    console.log('PASS: mail/check shows', JSON.stringify(status1));

    console.log('STEP 3: admin unsuspends it — the same transfer now succeeds');
    const unsuspendRes = await adminCall('/atlas/unsuspend', admin, { id: credential.id });
    assert(unsuspendRes.status === 200 && unsuspendRes.body.wasSuspended === true, 'expected unsuspend to report wasSuspended true, got: ' + JSON.stringify(unsuspendRes.body));
    const okTransfer = await transfer(credential, owner.kp, owner.publicKey, recipient.publicKey);
    assert(okTransfer.status === 200, 'expected the transfer to succeed after unsuspending, got ' + okTransfer.status + ': ' + JSON.stringify(okTransfer.body));
    credential = okTransfer.body.credential;
    console.log('PASS: transfer succeeded immediately after unsuspend, no restart or cache to clear');

    console.log('STEP 4: unsuspending an id that is not currently suspended reports wasSuspended: false, not an error');
    const noopUnsuspend = await adminCall('/atlas/unsuspend', admin, { id: credential.id });
    assert(noopUnsuspend.status === 200 && noopUnsuspend.body.wasSuspended === false, 'expected wasSuspended false for a no-op unsuspend, got: ' + JSON.stringify(noopUnsuspend.body));
    console.log('PASS: no-op unsuspend is a clean 200, not an error');

    console.log('STEP 5: a suspension with expiresAt already in the past never blocks anything and is invisible to mail/check — auto-lifted, no manual unsuspend needed');
    const pastExpiry = new Date(Date.now() - 60000).toISOString();
    const expiredSuspend = await adminCall('/atlas/suspend', admin, { id: credential.id, reason: 'already over', expiresAt: pastExpiry });
    assert(expiredSuspend.status === 200, 'expected the suspend call itself to succeed even with a past expiresAt, got: ' + JSON.stringify(expiredSuspend.body));
    const transferAfterExpiredSuspend = await transfer(credential, recipient.kp, recipient.publicKey, owner.publicKey);
    assert(transferAfterExpiredSuspend.status === 200, 'expected the transfer to succeed — the suspension already expired, got ' + transferAfterExpiredSuspend.status + ': ' + JSON.stringify(transferAfterExpiredSuspend.body));
    const status2 = await mailCheckStatus(recipient, credential);
    assert(status2 === null || status2.status !== 'suspended', 'expected an already-expired suspension to be invisible to mail/check, got: ' + JSON.stringify(status2));
    console.log('PASS: an already-expired suspension blocks nothing and reports nothing, with no explicit unsuspend call');

    console.log('STEP 6: a suspended Post Office membership can no longer send mail through this domain');
    const member = await genIdentity();
    const recipientMember = await genIdentity();
    const memberCred = await issueAsset(member.publicKey, 'atlas.postoffice.membership');
    await issueAsset(recipientMember.publicKey, 'atlas.postoffice.membership');
    // Build a real signed send before suspension, to prove the roster path
    // works at all, then suspend and prove it stops.
    async function sendMail(identity, toPublicKey, subject) {
      const payload = { to: { publicKey: toPublicKey }, subject, body: 'test' };
      const proof = await signWithSelf(identity.kp, identity.publicKey, payload);
      return postJson('/atlas/postoffice/send', { payload, proof });
    }
    const beforeSuspend = await sendMail(member, recipientMember.publicKey, 'Before suspension');
    assert(beforeSuspend.status === 200, 'expected the send to succeed before suspension, got ' + beforeSuspend.status + ': ' + JSON.stringify(beforeSuspend.body));
    await adminCall('/atlas/suspend', admin, { id: memberCred.id, reason: 'fraud-investigation' });
    const afterSuspend = await sendMail(member, recipientMember.publicKey, 'After suspension');
    assert(afterSuspend.status === 400, 'expected the send to be rejected once the membership is suspended, got ' + afterSuspend.status);
    assert(/do not hold a valid Global Mail membership|do not hold a Global Mail membership/.test(afterSuspend.body.error || ''), 'expected the same membership-gate rejection a revoked member already gets, got: ' + JSON.stringify(afterSuspend.body));
    console.log('PASS: a suspended Post Office membership can no longer send ->', afterSuspend.body.error);

    console.log('\nALL SUSPEND/UNSUSPEND CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    proc.kill();
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.rmSync(DOCROOT_DIR, { recursive: true, force: true });
  }
})();
