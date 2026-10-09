// Server-side security checks for the authenticated POST /atlas/mail/check
// (SPEC.md §11.8), run against either issuer:
//
//   node test/manual-mail-check-auth.js node
//   node test/manual-mail-check-auth.js php
//
//   1. The owner reads her own mailbox (Post Office mail, a friend request,
//      the welcome mail) and the asset updates for her credentials.
//   2. Requests that carry only ids, or ids plus a copy of a credential, get
//      an authentication-required error and no data.
//   3. Another identity cannot read the mailbox: not with the real
//      credential, a credential with the owner swapped, an invented one, or
//      a request signed by someone else.
//   4. A mixed request returns only the caller's own mailboxes, and an id
//      the caller does not own looks exactly like an id that does not exist.
//   5. Replay: a used nonce is refused, including under concurrency.
//   6. Time window and clock-skew answer, wrong domain, tampered payload.
//   7. Delegation (the passkey session path): honoured only while valid,
//      for this domain, for reading, signed by the delegated key.
//   8. Passkey assertions are accepted as signatures only when they are
//      "get" assertions with user presence.
//   9. Revoked and superseded credentials still let their owner collect
//      notices; nobody else.
//  10. Limits on ids and credentials.
//
// Starts its own issuer on an isolated state directory. Not part of the
// permanent suite, same reasoning as the other manual-*.js scripts.

const path = require('path');
const { webcrypto } = require('crypto');
const H = require('./lib/delivery-harness');

const KIND = process.argv[2] === 'php' ? 'php' : 'node';
const PORT = 8261;
const BASE = 'http://localhost:' + PORT;
const MEMBERSHIP = 'atlas.postoffice.membership';
const FRIEND_MARKER = '\u0000atlas.friend.v1';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS: ' : 'FAIL: ') + name + (ok ? '' : ' => ' + detail));
}
const subjects = (r) => ((r.body && r.body.messages) || []).map((m) => m.subject).sort();
const shape = (r) => JSON.stringify({ status: r.status, messages: r.body.messages, updates: r.body.updates });

// A WebAuthn-style assertion made with a software ES256 key, to exercise the
// server's passkey branch without a browser. `flags` and `type` let a test
// break the parts a read grant insists on.
function derSignature(raw) {
  const trim = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); return b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b; };
  const r = trim(Buffer.from(raw.slice(0, 32))), s = trim(Buffer.from(raw.slice(32)));
  return Buffer.concat([Buffer.from([0x30, 2 + r.length + 2 + s.length, 0x02, r.length]), r, Buffer.from([0x02, s.length]), s]);
}
async function passkeyIdentity() {
  const kp = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { kp, publicKey: H.b64url(new Uint8Array(await webcrypto.subtle.exportKey('spki', kp.publicKey))) };
}
async function passkeyEnvelope(identity, payload, o) {
  o = o || {};
  const hash = new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(H.canonicalize(payload))));
  const clientDataJSON = Buffer.from(JSON.stringify({ type: o.type || 'webauthn.get', challenge: o.challenge || H.b64url(hash), origin: 'chrome-extension://test' }));
  const authData = Buffer.concat([Buffer.alloc(32, 7), Buffer.from([o.flags === undefined ? 0x05 : o.flags]), Buffer.from([0, 0, 0, 1])]);
  const clientHash = Buffer.from(await webcrypto.subtle.digest('SHA-256', clientDataJSON));
  const raw = new Uint8Array(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.kp.privateKey, Buffer.concat([authData, clientHash])));
  return {
    signerRole: 'webauthn', publicKey: identity.publicKey,
    clientDataJSON: H.b64url(clientDataJSON), authenticatorData: H.b64url(authData), signature: H.b64url(derSignature(raw))
  };
}

(async () => {
  console.log('Authenticated mail check (' + KIND + ' issuer)');
  const issuer = KIND === 'node'
    ? await H.startNodeIssuer({ port: PORT, stateDir: H.tmpDir('atlas-mail-auth-'), docrootDir: path.join(H.ROOT, 'demo-domain-a') })
    : await H.startPhpIssuer({ port: PORT, bundleDir: H.preparePhpBundle() });
  try {
    const sender = await H.genIdentity();
    const alice = await H.genIdentity();
    const bob = await H.genIdentity();
    const mallory = await H.genIdentity();
    await H.issueAsset(BASE, sender.publicKey, MEMBERSHIP);
    const aliceCard = await H.issueAsset(BASE, alice.publicKey, MEMBERSHIP);
    const bobCard = await H.issueAsset(BASE, bob.publicKey, MEMBERSHIP);
    const malloryCard = await H.issueAsset(BASE, mallory.publicKey, MEMBERSHIP);

    const send = async (to, subject, body) => {
      const payload = { to: { publicKey: to.publicKey }, subject, body: body || 'b' };
      const r = await H.postJson(BASE, '/atlas/postoffice/send', { payload, proof: await H.signWithSelf(sender, payload) });
      if (r.status !== 200) throw new Error('send failed: ' + JSON.stringify(r.body));
    };
    await send(alice, 'for-alice');
    await send(alice, FRIEND_MARKER, JSON.stringify({ v: 1, type: 'request' }));
    await send(bob, 'for-bob');

    console.log('STEP 1: the owner reads her own mailbox');
    let r = await H.mailCheck(BASE, alice, aliceCard);
    check('alice gets her mail, friend request and welcome mail', r.status === 200 && subjects(r).includes('for-alice') && subjects(r).includes(FRIEND_MARKER) && r.body.messages.length === 3, shape(r));
    check('none of it is bob\'s', !subjects(r).includes('for-bob'), shape(r));

    console.log('STEP 2: ids alone, or ids with a copy of the credential, are refused');
    r = await H.postJson(BASE, '/atlas/mail/check', { credentialIds: [aliceCard.id] });
    check('legacy ids-only request: 401 auth-required, no data', r.status === 401 && r.body.code === 'auth-required' && !r.body.messages, JSON.stringify(r));
    r = await H.postJson(BASE, '/atlas/mail/check', { credentialIds: [aliceCard.id], credentials: [aliceCard] });
    check('legacy request with the real credential: 401 auth-required, no data', r.status === 401 && r.body.code === 'auth-required' && !r.body.messages, JSON.stringify(r));
    r = await H.postJson(BASE, '/atlas/mail/check', {});
    check('empty request: 401 auth-required', r.status === 401 && r.body.code === 'auth-required', JSON.stringify(r));
    r = await H.mailCheck(BASE, mallory, aliceCard, { noProof: true });
    check('payload without a proof: 401 auth-required', r.status === 401 && r.body.code === 'auth-required', JSON.stringify(r));

    console.log('STEP 3: another identity cannot read it');
    const nothing = await H.mailCheck(BASE, mallory, { id: 'urn:atlas:asset:does-not-exist', owner: { publicKey: mallory.publicKey } });
    check('baseline: a request for nothing returns an empty 200', nothing.status === 200 && nothing.body.messages.length === 0 && nothing.body.updates.length === 0, shape(nothing));
    r = await H.mailCheck(BASE, mallory, aliceCard);
    check('mallory presents alice\'s real credential, signs as herself: empty', r.status === 200 && shape(r) === shape(nothing), shape(r));
    const swapped = JSON.parse(JSON.stringify(aliceCard));
    swapped.owner.publicKey = mallory.publicKey;
    r = await H.mailCheck(BASE, mallory, swapped);
    check('credential with the owner swapped to mallory (signature broken): empty', r.status === 200 && shape(r) === shape(nothing), shape(r));
    const invented = { ...JSON.parse(JSON.stringify(aliceCard)), signature: H.b64url(new Uint8Array(64)) };
    invented.owner.publicKey = mallory.publicKey;
    r = await H.mailCheck(BASE, mallory, invented);
    check('credential with an invented signature: empty', r.status === 200 && shape(r) === shape(nothing), shape(r));
    r = await H.mailCheck(BASE, alice, aliceCard, { signer: mallory });
    check('alice\'s credential, request signed by mallory: empty', r.status === 200 && shape(r) === shape(nothing), shape(r));
    r = await H.mailCheck(BASE, bob, aliceCard);
    check('bob cannot read alice\'s mailbox', r.status === 200 && shape(r) === shape(nothing), shape(r));
    r = await H.mailCheck(BASE, alice, bobCard);
    check('alice cannot read bob\'s mailbox', r.status === 200 && shape(r) === shape(nothing), shape(r));

    console.log('STEP 4: a mixed request returns only what the caller owns');
    r = await H.mailCheck(BASE, alice, [aliceCard, bobCard, malloryCard]);
    check('alice asks for three mailboxes and gets only her own', r.status === 200 && subjects(r).includes('for-alice') && !subjects(r).includes('for-bob') && r.body.messages.length === 3, shape(r));
    const aliceOnly = await H.mailCheck(BASE, alice, aliceCard);
    check('the answer is the same as asking for her mailbox alone', JSON.stringify(r.body.messages.map((m) => m.id).sort()) === JSON.stringify(aliceOnly.body.messages.map((m) => m.id).sort()), shape(r));
    r = await H.mailCheck(BASE, alice, [aliceCard], { credentialIds: [aliceCard.id, bobCard.id, 'urn:atlas:asset:nope'] });
    check('ids without a matching credential are dropped silently', r.status === 200 && r.body.messages.length === 3, shape(r));

    console.log('STEP 5: replay');
    const nonce = H.b64url(webcrypto.getRandomValues(new Uint8Array(18)));
    const issuedAt = new Date().toISOString();
    r = await H.mailCheck(BASE, alice, aliceCard, { nonce, issuedAt });
    check('first use of a request succeeds', r.status === 200, shape(r));
    r = await H.mailCheck(BASE, alice, aliceCard, { nonce, issuedAt });
    check('the identical request again: 401 replayed-request, no data', r.status === 401 && r.body.code === 'replayed-request' && !r.body.messages, JSON.stringify(r));
    const burst = H.b64url(webcrypto.getRandomValues(new Uint8Array(18)));
    const burstAt = new Date().toISOString();
    const results = await Promise.all(Array.from({ length: 8 }, () => H.mailCheck(BASE, alice, aliceCard, { nonce: burst, issuedAt: burstAt })));
    const ok = results.filter((x) => x.status === 200).length;
    check('eight concurrent copies of one request: exactly one succeeds', ok === 1 && results.filter((x) => x.body.code === 'replayed-request').length === 7, results.map((x) => x.status + ':' + (x.body.code || '')).join(','));
    r = await H.mailCheck(BASE, mallory, aliceCard, { nonce, issuedAt });
    check('the same nonce from another signer is not a replay (nonces are per signer)', r.status === 200, shape(r));

    console.log('STEP 6: time window, domain, tampering');
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    r = await H.mailCheck(BASE, alice, aliceCard, { issuedAt: old });
    check('a request from ten minutes ago: 401 stale-request with the server time', r.status === 401 && r.body.code === 'stale-request' && Number.isFinite(Date.parse(r.body.serverTime)) && !r.body.messages, JSON.stringify(r));
    const skew = Date.parse(r.body.serverTime) - Date.now();
    r = await H.mailCheck(BASE, alice, aliceCard, { issuedAt: new Date(Date.now() + skew + 60 * 1000).toISOString() });
    check('a request stamped with the corrected clock works', r.status === 200, shape(r));
    r = await H.mailCheck(BASE, alice, aliceCard, { issuedAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() });
    check('a request from ten minutes in the future: stale-request', r.status === 401 && r.body.code === 'stale-request', JSON.stringify(r));
    r = await H.mailCheck(BASE, alice, aliceCard, { domain: 'localhost:1' });
    check('a request addressed to another domain: 400 wrong-domain', r.status === 400 && r.body.code === 'wrong-domain', JSON.stringify(r));
    r = await H.mailCheck(BASE, alice, aliceCard, { nonce: 'short' });
    check('a too-short nonce is refused', r.status === 400, JSON.stringify(r));
    {
      const payload = { action: 'mail-check', domain: 'localhost:' + PORT, credentialIds: [aliceCard.id], issuedAt: new Date().toISOString(), nonce: H.b64url(webcrypto.getRandomValues(new Uint8Array(18))) };
      const proof = await H.signWithSelf(alice, payload);
      const tampered = { ...payload, credentialIds: [aliceCard.id, bobCard.id] };
      r = await H.postJson(BASE, '/atlas/mail/check', { credentials: [aliceCard, bobCard], payload: tampered, proof });
      check('a payload edited after signing: 401 bad-signature, no data', r.status === 401 && r.body.code === 'bad-signature' && !r.body.messages, JSON.stringify(r));
      r = await H.postJson(BASE, '/atlas/mail/check', { credentials: [aliceCard], payload: { ...payload, action: 'mail-delete' }, proof });
      check('a payload with the wrong action is refused', r.status === 400, JSON.stringify(r));
    }

    console.log('STEP 7: delegation (the passkey session path)');
    let d = await H.mailDelegation(BASE, alice);
    r = await H.mailCheck(BASE, alice, aliceCard, { signer: d.session, delegation: d.delegation });
    check('alice\'s delegated key reads her mailbox', r.status === 200 && r.body.messages.length === 3, shape(r));
    r = await H.mailCheck(BASE, alice, aliceCard, { signer: alice, delegation: d.delegation });
    check('the identity key itself cannot use a delegation made for another key', r.status === 401 && r.body.code === 'bad-delegation', JSON.stringify(r));
    r = await H.mailCheck(BASE, alice, aliceCard, { signer: mallory, delegation: d.delegation });
    check('another key cannot use alice\'s delegation', r.status === 401 && r.body.code === 'bad-delegation', JSON.stringify(r));
    d = await H.mailDelegation(BASE, alice);
    const dn = H.b64url(webcrypto.getRandomValues(new Uint8Array(18)));
    const dAt = new Date().toISOString();
    await H.mailCheck(BASE, alice, aliceCard, { signer: d.session, delegation: d.delegation, nonce: dn, issuedAt: dAt });
    r = await H.mailCheck(BASE, alice, aliceCard, { signer: d.session, delegation: d.delegation, nonce: dn, issuedAt: dAt });
    check('replaying a delegated request is refused', r.status === 401 && r.body.code === 'replayed-request', JSON.stringify(r));
    r = await H.mailCheck(BASE, alice, aliceCard, { signer: d.session, delegation: d.delegation });
    check('a fresh request under the same live delegation works', r.status === 200, shape(r));
    r = await H.mailCheck(BASE, alice, aliceCard, { signer: d.session, delegation: d.delegation, issuedAt: new Date(Date.now() + 12 * 60 * 1000).toISOString() });
    check('a request after the delegation window is refused', r.status === 401, JSON.stringify(r));
    d = await H.mailDelegation(BASE, alice, { issuedAt: new Date(Date.now() - 20 * 60 * 1000), lifetimeMs: 10 * 60 * 1000 });
    r = await H.mailCheck(BASE, alice, aliceCard, { signer: d.session, delegation: d.delegation });
    check('an expired delegation: 401 session-expired', r.status === 401 && r.body.code === 'session-expired', JSON.stringify(r));
    d = await H.mailDelegation(BASE, alice, { lifetimeMs: 60 * 60 * 1000 });
    r = await H.mailCheck(BASE, alice, aliceCard, { signer: d.session, delegation: d.delegation });
    check('a delegation lasting an hour is refused (15 minute cap)', r.status === 401 && r.body.code === 'bad-delegation', JSON.stringify(r));
    d = await H.mailDelegation(BASE, alice, { domain: 'localhost:1' });
    r = await H.mailCheck(BASE, alice, aliceCard, { signer: d.session, delegation: d.delegation });
    check('a delegation for another domain is refused', r.status === 401 && r.body.code === 'bad-delegation', JSON.stringify(r));
    d = await H.mailDelegation(BASE, alice, { purpose: 'mail-write' });
    r = await H.mailCheck(BASE, alice, aliceCard, { signer: d.session, delegation: d.delegation });
    check('a delegation for any purpose but reading is refused', r.status === 401 && r.body.code === 'bad-delegation', JSON.stringify(r));
    d = await H.mailDelegation(BASE, mallory);
    r = await H.mailCheck(BASE, alice, aliceCard, { signer: d.session, delegation: d.delegation });
    check('mallory\'s delegation cannot read alice\'s mailbox', r.status === 200 && shape(r) === shape(nothing), shape(r));
    d = await H.mailDelegation(BASE, alice);
    const forgedDelegation = { payload: { ...d.delegation.payload, sessionPublicKey: mallory.publicKey }, proof: d.delegation.proof };
    r = await H.mailCheck(BASE, alice, aliceCard, { signer: mallory, delegation: forgedDelegation });
    check('a delegation edited to name mallory\'s key: 401 bad-signature', r.status === 401 && r.body.code === 'bad-signature', JSON.stringify(r));

    console.log('STEP 8: passkey assertions');
    const pk = await passkeyIdentity();
    const pkCard = await H.issueAsset(BASE, pk.publicKey, MEMBERSHIP);
    await send(pk, 'for-passkey');
    const delegate = async (o) => {
      const session = await H.genIdentity();
      const issued = new Date();
      const payload = { action: 'mail-session', purpose: 'mail-read', domain: 'localhost:' + PORT, sessionPublicKey: session.publicKey, issuedAt: issued.toISOString(), expiresAt: new Date(issued.getTime() + 600000).toISOString() };
      return { session, delegation: { payload, proof: await passkeyEnvelope(pk, payload, o) } };
    };
    let pd = await delegate();
    r = await H.mailCheck(BASE, pk, pkCard, { signer: pd.session, delegation: pd.delegation });
    check('a passkey delegation reads the passkey owner\'s mailbox', r.status === 200 && subjects(r).includes('for-passkey'), shape(r));
    pd = await delegate({ flags: 0x00 });
    r = await H.mailCheck(BASE, pk, pkCard, { signer: pd.session, delegation: pd.delegation });
    check('an assertion without user presence is refused', r.status === 401 && r.body.code === 'bad-signature', JSON.stringify(r));
    pd = await delegate({ type: 'webauthn.create' });
    r = await H.mailCheck(BASE, pk, pkCard, { signer: pd.session, delegation: pd.delegation });
    check('a webauthn.create client data is refused', r.status === 401 && r.body.code === 'bad-signature', JSON.stringify(r));
    pd = await delegate({ challenge: H.b64url(new Uint8Array(32)) });
    r = await H.mailCheck(BASE, pk, pkCard, { signer: pd.session, delegation: pd.delegation });
    check('an assertion over a different challenge is refused', r.status === 401 && r.body.code === 'bad-signature', JSON.stringify(r));
    pd = await delegate();
    r = await H.mailCheck(BASE, alice, aliceCard, { signer: pd.session, delegation: pd.delegation });
    check('the passkey owner\'s delegation cannot read alice\'s mailbox', r.status === 200 && shape(r) === shape(nothing), shape(r));

    console.log('STEP 9: revoked and superseded credentials');
    const leaver = await H.genIdentity();
    const leaverCard = await H.issueAsset(BASE, leaver.publicKey, MEMBERSHIP);
    await send(leaver, 'before-leaving');
    const leavePayload = { credentialId: leaverCard.id };
    await H.postJson(BASE, '/atlas/postoffice/leave', { payload: leavePayload, proof: await H.signWithSelf(leaver, leavePayload) });
    r = await H.mailCheck(BASE, leaver, leaverCard);
    check('the owner of a revoked card still gets its revoked notice', r.status === 200 && r.body.updates.some((u) => u.id === leaverCard.id && u.status === 'revoked'), shape(r));
    r = await H.mailCheck(BASE, mallory, leaverCard);
    check('nobody else gets it', r.status === 200 && shape(r) === shape(nothing), shape(r));

    console.log('STEP 10: limits');
    const many = Array.from({ length: 201 }, (_, i) => 'urn:atlas:asset:x' + i);
    r = await H.mailCheck(BASE, alice, aliceCard, { credentialIds: many });
    check('201 ids in one request: 400', r.status === 400, JSON.stringify(r));
    r = await H.mailCheck(BASE, alice, aliceCard, { credentialIds: [aliceCard.id, 42] });
    check('a non-string id: 400', r.status === 400, JSON.stringify(r));
    r = await H.mailCheck(BASE, alice, aliceCard, { credentialIds: [] });
    check('no ids: 400', r.status === 400, JSON.stringify(r));
    r = await H.postJson(BASE, '/atlas/mail/check', { credentials: Array.from({ length: 201 }, () => aliceCard), payload: {}, proof: {} });
    check('garbage payload is refused without data', r.status >= 400 && !r.body.messages, JSON.stringify(r));

    console.log(failures === 0 ? '\nMAIL CHECK AUTH CHECKS PASSED (' + KIND + ')' : '\n' + failures + ' CHECK(S) FAILED (' + KIND + ')');
  } finally {
    await H.stopIssuer(issuer);
  }
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
