// Manual check for Post Office handle addressing (task #94's last
// remaining piece — "hide the raw public key from users", per direct
// instruction): a member can register a short handle at a domain's Post
// Office instead of handing out their raw public key. Deliberately
// `handle#domain`, NOT `handle@domain` — the @ shape reads as a real email
// address and would mislead people about what this actually is.
//
// Same "backend/admin-flow logic" reasoning as manual-postoffice-
// consent.js — this talks to Domain B directly over HTTP rather than
// driving the extension (see manual-postoffice-handle-ui.js for the real
// wallet panel/compose flow).
//
// Requires Domain B running as a real issuer-server instance on 8002 with
// ATLAS_STATE_DIR=issuer-server/domain-b-state (see README.md's "Serve the
// two demo domains") — this test does not start it itself.
//
// Checks:
//   1. No handle by default; mysettings reports handle: null.
//   2. Claiming a valid handle succeeds and is visible via mysettings.
//   3. A DIFFERENT member can't claim the same handle, even with different
//      casing ("Bob" vs "bob") — matching is case-insensitive.
//   4. A member CAN re-save (or re-case) their own current handle — the
//      uniqueness check excludes the caller's own live entry.
//   5. Format is enforced (too short, disallowed characters, containing
//      '#' itself) and the profanity blocklist is enforced too, both
//      server-side regardless of what a client would have caught first.
//   6. Resolve is a case-insensitive single lookup: finds the right public
//      key for correct casing, wrong casing, and reports 404 for a handle
//      nobody's claimed.
//   7. Sending mail stamps the SENDER's registered handle onto the
//      outgoing message's `from` field automatically — no separate step —
//      and a sender with no handle produces a `from` with no handle field
//      at all (not a null one).
//   8. Clearing a handle removes it from mysettings and makes it
//      resolvable by no one; the vacated handle can then be claimed by
//      someone else.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const DOMAIN_B = 'http://localhost:8002';

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

async function setHandle(identity, handle) {
  const payload = { handle };
  const proof = await signWithSelf(identity, payload);
  return fetch(DOMAIN_B + '/atlas/postoffice/handle', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, proof })
  });
}

async function mySettings(identity) {
  const payload = { purpose: 'postoffice-mysettings' };
  const proof = await signWithSelf(identity, payload);
  const res = await fetch(DOMAIN_B + '/atlas/postoffice/mysettings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, proof })
  });
  if (!res.ok) throw new Error('mysettings failed: ' + await res.text());
  return await res.json();
}

async function resolve(handle) {
  return fetch(DOMAIN_B + '/atlas/postoffice/resolve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ handle })
  });
}

async function sendMail(identity, toPublicKey, subject, body) {
  const payload = { to: { publicKey: toPublicKey }, subject, body };
  const proof = await signWithSelf(identity, payload);
  return fetch(DOMAIN_B + '/atlas/postoffice/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, proof })
  });
}

(async () => {
  console.log('STEP 0: two identities, both claim Domain B Post Office membership');
  const A = await genIdentity();
  const B = await genIdentity();
  await claimMembership(A.publicKey);
  await claimMembership(B.publicKey);
  console.log('PASS: A and B are both members');

  console.log('STEP 1: no handle by default');
  const settingsBefore = await mySettings(B);
  if (settingsBefore.handle !== null) throw new Error('Expected no handle by default, got ' + JSON.stringify(settingsBefore));
  console.log('PASS: handle is null before claiming one');

  console.log('STEP 2: B claims "bob"');
  const claimBob = await setHandle(B, 'bob');
  if (!claimBob.ok) throw new Error('Expected claiming "bob" to succeed: ' + await claimBob.text());
  const claimBobResult = await claimBob.json();
  if (claimBobResult.handle !== 'bob') throw new Error('Expected handle "bob", got ' + JSON.stringify(claimBobResult));
  const settingsAfterClaim = await mySettings(B);
  if (settingsAfterClaim.handle !== 'bob') throw new Error('Expected mysettings to show "bob", got ' + JSON.stringify(settingsAfterClaim));
  console.log('PASS: B is now "bob", visible via mysettings');

  console.log('STEP 3: A cannot claim "Bob" (different casing of an already-taken handle)');
  const claimConflict = await setHandle(A, 'Bob');
  if (claimConflict.ok) throw new Error('Expected claiming "Bob" to fail while B holds "bob", but it succeeded');
  console.log('PASS: case-insensitive uniqueness enforced ->', (await claimConflict.json()).error);

  console.log('STEP 4: B CAN re-save their own handle, including re-casing it to "Bob"');
  const resave = await setHandle(B, 'Bob');
  if (!resave.ok) throw new Error('Expected B to be able to re-save their own handle: ' + await resave.text());
  console.log('PASS: uniqueness check excludes the caller\'s own live entry');
  await setHandle(B, 'bob'); // back to lowercase for the rest of the test

  console.log('STEP 5: format and profanity are enforced server-side');
  const tooShort = await setHandle(A, 'a');
  if (tooShort.ok) throw new Error('Expected a 1-character handle to be rejected');
  const badChars = await setHandle(A, 'has spaces');
  if (badChars.ok) throw new Error('Expected a handle with spaces to be rejected');
  const withHash = await setHandle(A, 'no#hash');
  if (withHash.ok) throw new Error('Expected a handle containing "#" to be rejected (it\'s the separator)');
  const profane = await setHandle(A, 'fuckyou');
  if (profane.ok) throw new Error('Expected a blocklisted handle to be rejected');
  console.log('PASS: format and profanity checks all reject their cases');

  console.log('STEP 6: A claims "alice"; resolve is a case-insensitive single lookup');
  const claimAlice = await setHandle(A, 'alice');
  if (!claimAlice.ok) throw new Error('Expected claiming "alice" to succeed: ' + await claimAlice.text());
  const resolveExact = await resolve('bob');
  if (!resolveExact.ok) throw new Error('Expected resolving "bob" to succeed: ' + await resolveExact.text());
  const resolveExactResult = await resolveExact.json();
  if (resolveExactResult.publicKey !== B.publicKey) throw new Error('Expected resolve("bob") to return B\'s public key');
  const resolveWrongCase = await resolve('BOB');
  if (!resolveWrongCase.ok) throw new Error('Expected resolving "BOB" (wrong case) to still succeed');
  if ((await resolveWrongCase.json()).publicKey !== B.publicKey) throw new Error('Expected resolve("BOB") to also return B\'s public key');
  const resolveMissing = await resolve('nobody-has-this-handle');
  if (resolveMissing.ok) throw new Error('Expected resolving an unclaimed handle to 404');
  console.log('PASS: resolve is case-insensitive and 404s for an unclaimed handle');

  console.log('STEP 7: sending mail stamps the SENDER\'s handle onto `from` automatically');
  const sentByAlice = await sendMail(A, B.publicKey, 'Hi', 'from a handled sender');
  if (!sentByAlice.ok) throw new Error('Expected A\'s send to succeed: ' + await sentByAlice.text());
  const messageByAlice = await sentByAlice.json();
  if (messageByAlice.from.handle !== 'alice') throw new Error('Expected from.handle "alice", got ' + JSON.stringify(messageByAlice.from));
  const sentByB = await sendMail(B, A.publicKey, 'Hi back', 'from bob to alice');
  const messageByB = await sentByB.json();
  if (messageByB.from.handle !== 'bob') throw new Error('Expected from.handle "bob" (still set from earlier), got ' + JSON.stringify(messageByB.from));
  console.log('PASS: outgoing relayed mail carries the sender\'s registered handle, no extra step needed');

  console.log('STEP 7b: a sender with NO handle produces a `from` with no handle field at all');
  const C = await genIdentity();
  await claimMembership(C.publicKey);
  const sentByC = await sendMail(C, B.publicKey, 'Hi', 'no handle here');
  if (!sentByC.ok) throw new Error('Expected C\'s send to succeed: ' + await sentByC.text());
  const messageByC = await sentByC.json();
  if ('handle' in messageByC.from) throw new Error('Expected no handle field at all for a sender with none registered, got ' + JSON.stringify(messageByC.from));
  console.log('PASS: no handle field when the sender has not registered one — not a null, just absent');

  console.log('STEP 8: clearing a handle removes it, and frees it up for someone else');
  const clearBob = await setHandle(B, null);
  if (!clearBob.ok) throw new Error('Expected clearing B\'s handle to succeed: ' + await clearBob.text());
  const settingsAfterClear = await mySettings(B);
  if (settingsAfterClear.handle !== null) throw new Error('Expected handle to be null after clearing, got ' + JSON.stringify(settingsAfterClear));
  const resolveAfterClear = await resolve('bob');
  if (resolveAfterClear.ok) throw new Error('Expected "bob" to no longer resolve after B cleared it');
  const claimByC = await setHandle(C, 'bob');
  if (!claimByC.ok) throw new Error('Expected C to be able to claim the now-vacated "bob": ' + await claimByC.text());
  console.log('PASS: cleared handle is gone from mysettings, no longer resolves, and is claimable by someone else');

  console.log('\nALL POST OFFICE HANDLE-ADDRESSING CHECKS PASSED');
})().catch((err) => {
  console.error('FAILURE:', err);
  process.exitCode = 1;
});
