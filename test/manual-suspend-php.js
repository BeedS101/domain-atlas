// Manual check for the suspend/unsuspend mechanism against the PHP port
// specifically, at the HTTP layer directly — same "own isolated bundle
// copy" reasoning every other manual-*-php.js test in this project uses
// (see test/manual-asset-history-php.js). test/manual-suspend.js already
// covers the same 6 checks against the Node backend; this is its PHP
// mirror, exercising is_suspended()/atlas_suspend()/atlas_unsuspend() in
// issuer-php/lib/store.php and the two new atlas/suspend.php and
// atlas/unsuspend.php endpoints instead.
//
// Single-domain (no cross-domain relaying involved), so unlike
// manual-federation-relay-php.js this doesn't need
// PHP_CLI_SERVER_WORKERS — a single php -S worker never needs to call
// back into itself here.
//
// Checks (same as manual-suspend.js):
//   1. Admin suspends a held, transferable credential (indefinite, no
//      expiresAt) — a subsequent /atlas/asset/transfer is rejected with a
//      clear "currently suspended" error, not the generic revoked one.
//   2. /atlas/mail/check reports {status: 'suspended', reason,
//      expiresAt: null} for that id.
//   3. Admin unsuspends it — the same transfer that was just rejected now
//      succeeds.
//   4. Unsuspending an id that isn't currently suspended reports
//      wasSuspended: false, not an error.
//   5. A suspension given an expiresAt already in the past never blocks
//      anything and is invisible to mail/check — it auto-lifted, no
//      explicit unsuspend call needed.
//   6. A suspended Post Office membership can no longer send mail through
//      this domain (same "you do not hold a membership" rejection a
//      revoked membership already gets).
//
// Cross-domain enforcement (a foreign domain's suspension, checked via
// .well-known/atlas-suspensions.json in verify_foreign_asset_credential())
// is NOT separately covered here, same reasoning as manual-suspend.js's
// own header comment — verified by code review against the already-proven
// foreign-revocation fetch-and-check shape rather than a new dedicated
// cross-domain test this round.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { withAdminAuth } = require('./lib/admin-auth');
const { subtle } = webcrypto;

const PORT = 8172; // isolated — distinct from every other manual-*.js/-php.js test's chosen port (see manual-suspend.js's 8171 for this feature's Node-side companion)
const BASE = 'http://localhost:' + PORT;
const BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-suspend-php-'));

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
  payload = withAdminAuth(payload, BASE, urlPath);
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
  console.log('SETUP: copying issuer-php into an isolated bundle dir and starting its own dev server on port ' + PORT);
  fs.cpSync(path.resolve(__dirname, '..', 'issuer-php'), BUNDLE_DIR, { recursive: true });
  const proc = spawn('php', ['-S', 'localhost:' + PORT, 'test-router.php'], { cwd: BUNDLE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
    proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
    proc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-php dev server up on port ' + PORT);

  try {
    console.log('SETUP: seeding an admin identity, minting a transferable credential to an owner, joining the Post Office');
    const admin = await genIdentity();
    const owner = await genIdentity();
    const recipient = await genIdentity();
    fs.writeFileSync(path.join(BUNDLE_DIR, 'lib', 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
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

    console.log('\nALL PHP SUSPEND/UNSUSPEND CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    proc.kill();
    fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
  }
})();
