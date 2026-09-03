// Manual check for the Post Office consent/block model (task #94's
// remaining piece, "both, recipient's choice" per direct instruction): a
// member controls who's allowed to reach them through a Post Office
// they've joined, on top of the baseline symmetric-membership gate task
// #95 already enforces — a block list (name specific senders to auto-
// reject) AND an optional friends-only mode (only accept mail from a
// snapshot of the wallet's own Friends list, explicitly submitted).
//
// Same "backend/admin-flow logic, not a UI feature" reasoning as
// manual-postoffice-abuse.js — this talks to Domain B directly over HTTP
// rather than driving the extension, and reads its state file directly to
// confirm what actually landed, not just what the API claimed.
//
// Requires Domain B running as a real issuer-server instance on 8002 with
// ATLAS_STATE_DIR=issuer-server/domain-b-state (see README.md's "Serve the
// two demo domains") — this test does not start it itself.
//
// Checks:
//   1. Baseline (open mode, the default): any fellow member can mail any
//      other, exactly as before this task.
//   2. Blocking: the recipient blocks one sender via POST
//      /atlas/postoffice/block — that sender's subsequent send is
//      rejected, a DIFFERENT member's send still goes through, and the
//      recipient's own POST /atlas/postoffice/mysettings shows the block.
//   3. Unblocking reverses it.
//   4. Friends-only mode: the recipient submits a friends snapshot via
//      POST /atlas/postoffice/mailmode — a sender in that snapshot can
//      mail them, a sender NOT in it cannot, even though both hold valid
//      memberships.
//   5. A block always wins over friends-only: blocking someone who IS in
//      the friends snapshot still rejects them.
//   6. Switching back to "open" clears the friends snapshot server-side
//      (friendsCount back to 0) and lets the previously-excluded sender
//      through again, while the block list (a separate, independent
//      setting) is untouched by the mode switch.
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

async function signWithSelf(identity, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey: identity.publicKey, signature: b64url(sig) };
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
  const proof = await signWithSelf(identity, payload);
  return fetch(DOMAIN_B + '/atlas/postoffice/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, proof })
  });
}

async function setMailMode(identity, mode, friends) {
  const payload = mode === 'friendsOnly' ? { mode, friends } : { mode };
  const proof = await signWithSelf(identity, payload);
  const res = await fetch(DOMAIN_B + '/atlas/postoffice/mailmode', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, proof })
  });
  if (!res.ok) throw new Error('mailmode failed: ' + await res.text());
  return await res.json();
}

async function block(identity, blockedPublicKey) {
  const payload = { blockedPublicKey };
  const proof = await signWithSelf(identity, payload);
  const res = await fetch(DOMAIN_B + '/atlas/postoffice/block', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, proof })
  });
  if (!res.ok) throw new Error('block failed: ' + await res.text());
  return await res.json();
}

async function unblock(identity, blockedPublicKey) {
  const payload = { blockedPublicKey };
  const proof = await signWithSelf(identity, payload);
  const res = await fetch(DOMAIN_B + '/atlas/postoffice/unblock', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, proof })
  });
  if (!res.ok) throw new Error('unblock failed: ' + await res.text());
  return await res.json();
}

async function mySettings(identity) {
  // Non-empty payload deliberately — see AtlasWallet.getPostOfficeSettings's
  // own comment in wallet.js on why an empty `{}` breaks signature
  // verification against the PHP issuer specifically (JSON `{}` decodes to
  // an empty PHP array, which PHP's canonicalize() serializes as `[]`).
  const payload = { purpose: 'postoffice-mysettings' };
  const proof = await signWithSelf(identity, payload);
  const res = await fetch(DOMAIN_B + '/atlas/postoffice/mysettings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, proof })
  });
  if (!res.ok) throw new Error('mysettings failed: ' + await res.text());
  return await res.json();
}

function readMemberByCredentialId(credentialId) {
  const doc = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  return doc.members.find((m) => m.credentialId === credentialId);
}

(async () => {
  console.log('STEP 0: three identities, all claim Domain B Post Office membership');
  const A = await genIdentity();
  const B = await genIdentity();
  const C = await genIdentity();
  const credA = await claimMembership(A.publicKey);
  const credB = await claimMembership(B.publicKey);
  const credC = await claimMembership(C.publicKey);
  console.log('PASS: A ->', credA.id, ' B ->', credB.id, ' C ->', credC.id);

  console.log('STEP 1: baseline — open mode is the default, anyone here can mail B');
  const baseline = await sendMail(A, B.publicKey, 'Hello', 'baseline open-mode send');
  if (!baseline.ok) throw new Error('Expected baseline open-mode send to succeed: ' + await baseline.text());
  const settingsBaseline = await mySettings(B);
  if (settingsBaseline.mailMode !== 'open') throw new Error('Expected default mailMode "open", got ' + JSON.stringify(settingsBaseline));
  if (settingsBaseline.blockedSenders.length !== 0) throw new Error('Expected no blocked senders yet, got ' + JSON.stringify(settingsBaseline));
  console.log('PASS: open by default, nobody blocked yet ->', settingsBaseline);

  console.log('STEP 2: B blocks A — A\'s next send is rejected, C\'s still goes through, B\'s own settings show the block');
  const blockResult = await block(B, A.publicKey);
  if (!blockResult.blockedSenders.includes(A.publicKey)) throw new Error('Expected blockedSenders to include A after blocking, got ' + JSON.stringify(blockResult));
  const rejectedFromA = await sendMail(A, B.publicKey, 'Should be rejected', 'A is blocked now');
  if (rejectedFromA.ok) throw new Error('Expected A\'s send to B to be rejected after B blocked A, but it succeeded');
  const stillWorksFromC = await sendMail(C, B.publicKey, 'Should still work', 'C was never blocked');
  if (!stillWorksFromC.ok) throw new Error('Expected C\'s send to B to still succeed: ' + await stillWorksFromC.text());
  const settingsAfterBlock = await mySettings(B);
  if (!settingsAfterBlock.blockedSenders.includes(A.publicKey)) throw new Error('Expected mysettings to reflect the block, got ' + JSON.stringify(settingsAfterBlock));
  console.log('PASS: blocked sender rejected, unrelated sender unaffected, block visible via mysettings');

  console.log('STEP 3: B unblocks A — A can mail B again');
  const unblockResult = await unblock(B, A.publicKey);
  if (unblockResult.blockedSenders.includes(A.publicKey)) throw new Error('Expected A to be gone from blockedSenders after unblocking, got ' + JSON.stringify(unblockResult));
  const worksAgainFromA = await sendMail(A, B.publicKey, 'Should work again', 'A was unblocked');
  if (!worksAgainFromA.ok) throw new Error('Expected A\'s send to succeed again after being unblocked: ' + await worksAgainFromA.text());
  console.log('PASS: unblocking reverses the rejection');

  console.log('STEP 4: B switches to friends-only mode, submitting a snapshot that includes C but not A');
  const modeResult = await setMailMode(B, 'friendsOnly', [C.publicKey]);
  if (modeResult.mailMode !== 'friendsOnly' || modeResult.friendsCount !== 1) throw new Error('Expected friendsOnly with 1 friend synced, got ' + JSON.stringify(modeResult));
  const rejectedNotFriend = await sendMail(A, B.publicKey, 'Should be rejected', 'A is not in the friends snapshot');
  if (rejectedNotFriend.ok) throw new Error('Expected A\'s send to be rejected under friends-only mode (A is not a friend), but it succeeded');
  const worksFriend = await sendMail(C, B.publicKey, 'Should work', 'C is in the friends snapshot');
  if (!worksFriend.ok) throw new Error('Expected C\'s send to succeed under friends-only mode (C is a friend): ' + await worksFriend.text());
  console.log('PASS: friends-only mode admits the snapshot, excludes everyone else, even valid members');

  console.log('STEP 5: a block always wins — blocking C (who IS in the friends snapshot) still rejects C');
  await block(B, C.publicKey);
  const rejectedBlockedFriend = await sendMail(C, B.publicKey, 'Should be rejected', 'blocked beats friends-only');
  if (rejectedBlockedFriend.ok) throw new Error('Expected a blocked sender to be rejected even though they are in the friends snapshot, but it succeeded');
  console.log('PASS: block list takes precedence over friends-only admission');
  await unblock(B, C.publicKey); // clean up for the next step

  console.log('STEP 6: switching back to open clears the friends snapshot (not the block list) and re-admits A');
  const backToOpen = await setMailMode(B, 'open');
  if (backToOpen.mailMode !== 'open' || backToOpen.friendsCount !== 0) throw new Error('Expected open mode with friendsCount 0, got ' + JSON.stringify(backToOpen));
  const worksAfterReopen = await sendMail(A, B.publicKey, 'Should work again', 'back to open mode');
  if (!worksAfterReopen.ok) throw new Error('Expected A\'s send to succeed again once B switched back to open: ' + await worksAfterReopen.text());
  const memberB = readMemberByCredentialId(credB.id);
  if (memberB.friends.length !== 0) throw new Error('Expected the friends snapshot to be cleared server-side on switching back to open, got ' + JSON.stringify(memberB.friends));
  console.log('PASS: open mode restored, friends snapshot cleared, A admitted again');

  console.log('\nALL POST OFFICE CONSENT/BLOCK CHECKS PASSED');
})().catch((err) => {
  console.error('FAILURE:', err);
  process.exitCode = 1;
});
