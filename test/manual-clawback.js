// Manual check for the admin-gated clawback mechanism: revoke a credential
// wherever it currently sits and mint a fresh one straight to its rightful
// owner, in the same act (see POST /atlas/clawback's own comment in
// issuer-server/server.js for the full design — the other half of what
// suspend/unsuspend exists to buy time for).
//
// One isolated issuer-server instance (own port/state dir), same
// self-contained pattern as test/manual-suspend.js.
//
// Checks:
//   1. Admin claws back a fungible balance from its current holder
//      ("thief") to a different public key ("victim") — the response
//      names the victim as the new owner, preserves the exact quantity,
//      and the new credential is genuinely usable: it passes a real
//      /atlas/asset/split the same as any other live balance would.
//   2. /atlas/mail/check reports the OLD id as {status: 'revoked',
//      reason: 'clawback'} — reusing the plain revocation channel, not a
//      "superseded" entry (the replacement went to someone else, so the
//      old holder's wallet has nothing to adopt).
//   3. Clawing back an id that's already revoked is rejected — nothing
//      left to claw back.
//   4. Clawing back to the SAME public key that already holds it is
//      rejected outright (a same-owner "clawback" is not a real
//      remedy — /atlas/revoke or /atlas/asset/reissue already cover
//      "kill it" and "reissue with a patch" respectively).
//   5. A non-fungible (unique) credential's exact asset state survives a
//      clawback byte-for-byte, same as transferUniqueAsset()'s existing
//      guarantee for an ordinary transfer.
//   6. When the named recipient already holds a live Post Office
//      membership at this domain, the fresh credential is ALSO delivered
//      as a mail gift attachment addressed to that membership — the
//      response says delivered: true, and the recipient's own
//      /atlas/mail/check turns up the notice with the same credential.
//   7. An unauthenticated call (no proof, no token) is rejected 401 —
//      same admin gate every other consequential endpoint here uses.
//   8. Clawing back a Post Office membership credential re-points the
//      SAME roster entry at the new owner rather than leaving them
//      invisible to the send gate: a handle registered before the
//      clawback still resolves (now to the new owner's public key), the
//      new owner can send mail immediately, the old holder no longer
//      can, and abuse-tracking (sendLog/recentSendCount/flagged) comes
//      back clean rather than inheriting the old holder's history.
//   9. Clawing back a Trading Station membership credential the same
//      way re-points its own (simpler) roster entry.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const PORT = 8173; // isolated — distinct from every other manual-*.js test's chosen port
const DOMAIN = 'localhost:' + PORT;
const BASE = 'http://' + DOMAIN;
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-clawback-node-'));
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-clawback-docroot-'));
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
async function issueAsset(ownerPublicKey, assetClass, quantity) {
  const res = await postJson('/atlas/asset/issue', { ownerPublicKey, assetClass, quantity });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ': ' + JSON.stringify(res.body));
  return res.body;
}
async function transfer(credential, ownerKp, ownerPublicKey, recipientPublicKey) {
  const intentPayload = { credentialId: credential.id, recipientPublicKey, action: 'transfer' };
  const intentProof = await signWithSelf(ownerKp, ownerPublicKey, intentPayload);
  return postJson('/atlas/asset/transfer', { credential, recipientPublicKey, intent: { payload: intentPayload, proof: intentProof } });
}
async function split(credential, sendAmount, toPublicKey) {
  return postJson('/atlas/asset/split', { credential, sendAmount, toPublicKey });
}
async function mailCheck(ids) {
  const res = await postJson('/atlas/mail/check', { credentialIds: ids });
  if (res.status !== 200) throw new Error('mail check failed: ' + JSON.stringify(res.body));
  return res.body;
}
async function setHandle(identity, handle) {
  const payload = { handle };
  const proof = await signWithSelf(identity.kp, identity.publicKey, payload);
  return postJson('/atlas/postoffice/handle', { payload, proof });
}
async function resolveHandle(handle) {
  return postJson('/atlas/postoffice/resolve', { handle });
}
async function sendMail(identity, toPublicKey, subject) {
  const payload = { to: { publicKey: toPublicKey }, subject, body: 'test' };
  const proof = await signWithSelf(identity.kp, identity.publicKey, payload);
  return postJson('/atlas/postoffice/send', { payload, proof });
}
async function adminDirectory(admin) {
  const res = await adminCall('/atlas/admin/directory', admin, {});
  if (res.status !== 200) throw new Error('admin directory failed: ' + JSON.stringify(res.body));
  return res.body;
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
    console.log('SETUP: seeding an admin identity and a thief holding a stolen fungible balance');
    const admin = await genIdentity();
    const thief = await genIdentity();
    const victim = await genIdentity();
    const bystander = await genIdentity();
    fs.writeFileSync(ADMIN_KEYS_FILE, JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
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

    console.log('STEP 8: clawing back a Post Office membership re-points the SAME roster entry at the new owner');
    const thief2 = await genIdentity();
    const victim2 = await genIdentity();
    const hijackedMembership = await issueAsset(thief2.publicKey, 'atlas.postoffice.membership');
    const handleSet = await setHandle(thief2, 'recoveredacct');
    assert(handleSet.status === 200, 'expected the handle registration to succeed, got: ' + JSON.stringify(handleSet.body));
    const beforeClawbackSend = await sendMail(thief2, member.publicKey, 'Before the account was recovered');
    assert(beforeClawbackSend.status === 200, 'expected the thief to be able to send before the clawback, got: ' + JSON.stringify(beforeClawbackSend.body));

    const membershipClawback = await adminCall('/atlas/clawback', admin, { credential: hijackedMembership, toPublicKey: victim2.publicKey });
    assert(membershipClawback.status === 200, 'expected the membership clawback to succeed, got: ' + JSON.stringify(membershipClawback.body));
    const newMembershipCredential = membershipClawback.body.newCredential;

    // Checked BEFORE the new owner sends anything of their own — this is
    // the state right after the clawback itself, proving the reset is the
    // clawback's own doing, not just an empty log because nothing has
    // happened yet.
    const directoryRightAfter = await adminDirectory(admin);
    const rosterEntry = directoryRightAfter.postOfficeMembers.find((m) => m.credentialId === newMembershipCredential.id);
    assert(rosterEntry, 'expected to find the reassigned roster entry in the admin directory, got: ' + JSON.stringify(directoryRightAfter.postOfficeMembers));
    assert(rosterEntry.ownerPublicKey === victim2.publicKey, 'expected the roster entry\'s owner to be the new owner');
    assert(rosterEntry.handle === 'recoveredacct', 'expected the handle to be preserved on the reassigned entry');
    assert(Array.isArray(rosterEntry.sendLog) && rosterEntry.sendLog.length === 0, 'expected sendLog to be reset, got: ' + JSON.stringify(rosterEntry.sendLog));
    assert(rosterEntry.recentSendCount === 0, 'expected recentSendCount to be reset, got: ' + rosterEntry.recentSendCount);
    assert(rosterEntry.flagged === false, 'expected flagged to be reset, got: ' + rosterEntry.flagged);
    console.log('PASS: roster entry shows the new owner, preserved handle, and reset abuse-tracking');

    const resolved = await resolveHandle('recoveredacct');
    assert(resolved.status === 200 && resolved.body.publicKey === victim2.publicKey, 'expected the handle to still resolve, now to the new owner, got: ' + JSON.stringify(resolved.body));
    console.log('PASS: handle "recoveredacct" still resolves, now to the new owner');

    const victim2Send = await sendMail(victim2, member.publicKey, 'The account is back with its rightful owner');
    assert(victim2Send.status === 200, 'expected the new owner to be able to send immediately, got: ' + JSON.stringify(victim2Send.body));
    console.log('PASS: new owner can send mail immediately, no separate rejoin needed');

    const thief2SendAfter = await sendMail(thief2, member.publicKey, 'Should no longer work');
    assert(thief2SendAfter.status === 400, 'expected the old holder to no longer be able to send, got ' + thief2SendAfter.status);
    console.log('PASS: old holder can no longer send ->', thief2SendAfter.body.error);

    console.log('STEP 9: clawing back a Trading Station membership re-points its own (simpler) roster entry the same way');
    const thief3 = await genIdentity();
    const victim3 = await genIdentity();
    const hijackedTsMembership = await issueAsset(thief3.publicKey, 'atlas.tradingstation.membership');
    const tsClawback = await adminCall('/atlas/clawback', admin, { credential: hijackedTsMembership, toPublicKey: victim3.publicKey });
    assert(tsClawback.status === 200, 'expected the Trading Station membership clawback to succeed, got: ' + JSON.stringify(tsClawback.body));
    const newTsCredential = tsClawback.body.newCredential;
    const tsRoster = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'atlas-tradingstation-members-store.json'), 'utf8'));
    const tsEntry = tsRoster.members.find((m) => m.credentialId === newTsCredential.id);
    assert(tsEntry, 'expected to find the reassigned Trading Station roster entry on disk, got: ' + JSON.stringify(tsRoster.members));
    assert(tsEntry.ownerPublicKey === victim3.publicKey, 'expected the Trading Station roster entry\'s owner to be the new owner');
    console.log('PASS: Trading Station roster entry re-pointed at the new owner');

    console.log('\nALL CLAWBACK CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    proc.kill();
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.rmSync(DOCROOT_DIR, { recursive: true, force: true });
  }
})();
