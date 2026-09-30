// Manual check for the admin-gated clawback mechanism against the PHP port
// specifically, at the HTTP layer directly — same "own isolated bundle
// copy" reasoning every other manual-*-php.js test in this project uses
// (see test/manual-asset-history-php.js). test/manual-clawback.js already
// covers the same 7 checks against the Node backend; this is its PHP
// mirror, exercising issuer-php/atlas/clawback.php and its use of
// atlas_revoke()/issue_asset()/find_postoffice_membership()/append_mail()
// in lib/store.php and lib/bootstrap.php instead.
//
// Checks (same as manual-clawback.js):
//   1. Admin claws back a fungible balance from its current holder
//      ("thief") to a different public key ("victim") — the response
//      names the victim as the new owner, preserves the exact quantity,
//      and the new credential is genuinely usable: it passes a real
//      /atlas/asset/split the same as any other live balance would.
//   2. /atlas/mail/check reports the OLD id as {status: 'revoked',
//      reason: 'clawback'}, with no newCredential attached to it.
//   3. Clawing back an id that's already revoked is rejected.
//   4. Clawing back to the SAME public key that already holds it is
//      rejected outright.
//   5. A non-fungible (unique) credential's exact asset state survives a
//      clawback byte-for-byte.
//   6. A recipient who already holds a live Post Office membership gets
//      the clawed-back credential delivered by mail, not just returned.
//   7. An unauthenticated call (no proof, no token) is rejected 401.
//
// Not covered here, same reasoning as manual-clawback.js's own header
// comment: clawing back a BOUND relationship credential (a Post Office/
// Trading Station membership card) — a known, pre-existing bookkeeping
// gap between a credential and the separate roster file that gates
// sending mail or trading, not something worth a dedicated scenario here.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const PORT = 8174; // isolated — distinct from every other manual-*.js/-php.js test's chosen port (see manual-clawback.js's 8173 for this feature's Node-side companion)
const BASE = 'http://localhost:' + PORT;
const BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-clawback-php-'));

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
async function issueAsset(ownerPublicKey, assetClass, quantity) {
  const res = await postJson('/atlas/asset/issue', { ownerPublicKey, assetClass, quantity });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ': ' + JSON.stringify(res.body));
  return res.body;
}
async function split(credential, sendAmount, toPublicKey) {
  return postJson('/atlas/asset/split', { credential, sendAmount, toPublicKey });
}
async function mailCheck(ids) {
  const res = await postJson('/atlas/mail/check', { credentialIds: ids });
  if (res.status !== 200) throw new Error('mail check failed: ' + JSON.stringify(res.body));
  return res.body;
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
    console.log('SETUP: seeding an admin identity and a thief holding a stolen fungible balance');
    const admin = await genIdentity();
    const thief = await genIdentity();
    const victim = await genIdentity();
    const bystander = await genIdentity();
    fs.writeFileSync(path.join(BUNDLE_DIR, 'lib', 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
    const stolen = await issueAsset(thief.publicKey, 'atlas.element.gold', 50); // fungible

    console.log('STEP 1: admin claws the balance back from the thief to the victim');
    const clawbackRes = await adminCall('/atlas/clawback', admin, { credential: stolen, toPublicKey: victim.publicKey });
    assert(clawbackRes.status === 200, 'expected the clawback to succeed, got ' + clawbackRes.status + ': ' + JSON.stringify(clawbackRes.body));
    assert(clawbackRes.body.status === 'clawed-back', 'expected status "clawed-back", got: ' + JSON.stringify(clawbackRes.body));
    assert(clawbackRes.body.delivered === false, 'expected delivered:false — the victim holds no Post Office membership yet, got: ' + JSON.stringify(clawbackRes.body));
    let clawedCredential = clawbackRes.body.newCredential;
    assert(clawedCredential.owner.publicKey === victim.publicKey, 'expected the new credential to name the victim as owner');
    assert(clawedCredential.quantity === stolen.quantity, 'expected the exact stolen quantity to carry over');
    assert(clawedCredential.supersedes === stolen.id, 'expected the new credential to supersede the stolen one');
    console.log('PASS: clawed back', stolen.quantity, 'atlas.element.gold ->', clawedCredential.id);

    console.log('STEP 1b: the clawed-back credential is genuinely spendable — proof it is a real, usable credential, not just a paper record');
    const onwardSplit = await split(clawedCredential, 10, bystander.publicKey);
    assert(onwardSplit.status === 200, 'expected the clawed-back credential to be splittable, got ' + onwardSplit.status + ': ' + JSON.stringify(onwardSplit.body));
    assert(onwardSplit.body.remainder.owner.publicKey === victim.publicKey, 'expected the split remainder to stay with the victim');
    console.log('PASS: clawed-back credential successfully spent onward via split');

    console.log('STEP 2: mail/check reports the OLD (thief-held) id as revoked, reason "clawback" — not "superseded", since the replacement went to someone else');
    const status = await mailCheck([stolen.id]);
    const update = status.updates.find((u) => u.id === stolen.id);
    assert(update && update.status === 'revoked', 'expected the old id to be reported revoked, got: ' + JSON.stringify(update));
    assert(update.reason === 'clawback', 'expected the revocation reason to be "clawback", got: ' + JSON.stringify(update));
    assert(!update.newCredential, 'expected no newCredential handed to the old (thief) id — it belongs to someone else now, got: ' + JSON.stringify(update));
    console.log('PASS: mail/check shows', JSON.stringify(update));

    console.log('STEP 3: clawing back an already-revoked id is rejected');
    const alreadyRevoked = await adminCall('/atlas/clawback', admin, { credential: stolen, toPublicKey: victim.publicKey });
    assert(alreadyRevoked.status === 400, 'expected a 400 for an already-revoked credential, got ' + alreadyRevoked.status);
    assert(/already revoked/.test(alreadyRevoked.body.error || ''), 'expected an "already revoked" error, got: ' + JSON.stringify(alreadyRevoked.body));
    console.log('PASS: already-revoked clawback rejected ->', alreadyRevoked.body.error);

    console.log('STEP 4: clawing back to the credential\'s own current owner is rejected — nothing to claw back');
    const freshHold = await issueAsset(bystander.publicKey, 'atlas.element.gold', 10);
    const sameOwner = await adminCall('/atlas/clawback', admin, { credential: freshHold, toPublicKey: bystander.publicKey });
    assert(sameOwner.status === 400, 'expected a 400 when toPublicKey matches the current owner, got ' + sameOwner.status);
    assert(/nothing to claw back/.test(sameOwner.body.error || ''), 'expected a "nothing to claw back" error, got: ' + JSON.stringify(sameOwner.body));
    console.log('PASS: same-owner clawback rejected ->', sameOwner.body.error);

    console.log('STEP 5: a non-fungible credential\'s exact asset state survives a clawback byte-for-byte');
    const uniqueStolen = await issueAsset(thief.publicKey, 'atlas.demo.attestation.filing');
    const uniqueClawback = await adminCall('/atlas/clawback', admin, { credential: uniqueStolen, toPublicKey: victim.publicKey });
    assert(uniqueClawback.status === 200, 'expected the unique clawback to succeed, got: ' + JSON.stringify(uniqueClawback.body));
    assert(JSON.stringify(uniqueClawback.body.newCredential.asset) === JSON.stringify(uniqueStolen.asset), 'expected the exact asset object to survive the clawback unchanged');
    console.log('PASS: unique asset state preserved exactly across the clawback');

    console.log('STEP 6: a recipient who already holds a live Post Office membership gets the clawed-back credential delivered by mail, not just returned');
    const member = await genIdentity();
    const memberCred = await issueAsset(member.publicKey, 'atlas.postoffice.membership');
    const memberStolen = await issueAsset(thief.publicKey, 'atlas.element.gold', 30);
    const deliveredClawback = await adminCall('/atlas/clawback', admin, { credential: memberStolen, toPublicKey: member.publicKey });
    assert(deliveredClawback.status === 200, 'expected the clawback to succeed, got: ' + JSON.stringify(deliveredClawback.body));
    assert(deliveredClawback.body.delivered === true, 'expected delivered:true — the recipient holds a live Post Office membership, got: ' + JSON.stringify(deliveredClawback.body));
    const memberMail = await mailCheck([memberCred.id]);
    const gift = memberMail.messages.find((m) => m.attachedAsset && m.attachedAsset.id === deliveredClawback.body.newCredential.id);
    assert(gift, 'expected the member\'s own mail check to show the clawed-back credential attached as a gift, got: ' + JSON.stringify(memberMail.messages));
    assert(/returned to you/.test(gift.subject || ''), 'expected a "returned to you" subject line, got: ' + JSON.stringify(gift));
    console.log('PASS: member\'s mail check shows the delivered gift ->', gift.subject);

    console.log('STEP 7: an unauthenticated clawback call is rejected 401');
    const anotherStolen = await issueAsset(thief.publicKey, 'atlas.element.gold', 5);
    const unauthed = await postJson('/atlas/clawback', { payload: { credential: anotherStolen, toPublicKey: victim.publicKey } });
    assert(unauthed.status === 401, 'expected an unauthenticated call to be rejected 401, got ' + unauthed.status);
    console.log('PASS: unauthenticated clawback rejected 401 ->', unauthed.body.error);

    console.log('\nALL PHP CLAWBACK CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    proc.kill();
    fs.rmSync(BUNDLE_DIR, { recursive: true, force: true });
  }
})();
