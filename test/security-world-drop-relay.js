// A cross-domain world drop settles only with the credential owner's own signature: a domain that merely holds a copy of a
// credential and signs its own attestation cannot move it. The same cases run against both issuers.
//
// Run: STACK=node node test/security-world-drop-relay.js   (or STACK=php)
// Two throw-away issuers (A issues, B hosts the world) and one stand-in domain that publishes only a key. Nothing leaves this machine.
'use strict';
const S = require('./support/issuer-stack');

const STACK = process.env.STACK || 'node';
const BASE_PORT = STACK === 'php' ? 8420 : 8410;
let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS ' + name);
  else { failures++; console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 220))); }
}
const uuid = () => require('crypto').randomUUID();
const newDropId = () => 'urn:atlas:worlddrop:' + uuid();

async function issue(issuer, owner, cls, quantity) {
  const r = await S.post(issuer.base, '/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: cls, quantity: quantity || 1 });
  if (r.status !== 200) throw new Error('issue ' + cls + ' failed: ' + JSON.stringify(r.body));
  return r.body;
}
async function revokedIds(issuer) {
  const r = await S.get(issuer.base, '/.well-known/atlas-revocations.json');
  return new Set(((r.body && r.body.revoked) || []).map((e) => e.id));
}
// What the wallet signs and sends to drop an item into `host`'s world.
async function ownerDrop(host, owner, credential, world, dropId) {
  const payload = { action: 'drop', credentialId: credential.id, world, domain: host.domain, dropId, droppedAt: new Date().toISOString() };
  const proof = await S.signPayload(owner, payload);
  return { payload, proof };
}
async function dropAt(host, owner, credential, world) {
  const dropId = newDropId();
  const intent = await ownerDrop(host, owner, credential, world, dropId);
  const res = await S.post(host.base, '/atlas/world/drop', { credential, world, position: [1, 0, 1], intent });
  return { res, dropId, intent };
}
async function claimAt(host, claimant, dropId) {
  const payload = { action: 'claim', dropId, domain: host.domain, claimedAt: new Date().toISOString() };
  const proof = await S.signPayload(claimant, payload);
  return S.post(host.base, '/atlas/world/drops/claim', { dropId, intent: { payload, proof } });
}
// What a relaying domain sends the issuer: the credential, its own signed attestation, and the two signed intents.
async function relayBody(relayer, signKey, { credential, dropId, world, claimant, dropIntent, claimIntent, claimantKey }) {
  const attestation = { relayingDomain: relayer, world, dropId, credentialId: credential.id, claimantPublicKey: claimantKey || claimant.publicKey };
  const attestationSignature = await S.signDetached(signKey, attestation);
  const body = { credential, attestation, attestationSignature };
  if (dropIntent) body.dropIntent = dropIntent;
  if (claimIntent === undefined && claimant) {
    const payload = { action: 'claim', dropId, domain: relayer, claimedAt: new Date().toISOString() };
    body.claimIntent = { payload, proof: await S.signPayload(claimant, payload) };
  } else if (claimIntent) body.claimIntent = claimIntent;
  return body;
}

(async () => {
  const A = await S.startIssuer(STACK, BASE_PORT);
  const B = await S.startIssuer(STACK, BASE_PORT + 1);
  const M = await S.startStandInDomain(BASE_PORT + 2);
  const WORLD = 'world-' + Date.now();
  const relay = (body) => S.post(A.base, '/atlas/world/drops/relay-claim', body);
  try {
    const alice = await S.generateIdentity();
    const bob = await S.generateIdentity();
    const mallory = await S.generateIdentity();
    const carol = await S.generateIdentity();

    console.log('--- the attack: a domain with a copy of the credential and its own attestation ---');
    const stolen = await issue(A, alice, 'atlas.trophy.chess');
    let r = await relay(await relayBody(M.domain, M.identity, { credential: stolen, dropId: newDropId(), world: WORLD, claimant: mallory }));
    check('attestation alone is refused', r.status >= 400 && r.status < 500, r);
    check('the credential is still live afterwards', !(await revokedIds(A)).has(stolen.id));
    check('no credential was issued to the attacker', !(r.body && r.body.credential), r.body);

    r = await relay(await relayBody(M.domain, M.identity, { credential: stolen, dropId: newDropId(), world: WORLD, claimant: mallory, dropIntent: null }));
    check('a null drop intent is refused too', r.status >= 400 && r.status < 500 && !(await revokedIds(A)).has(stolen.id), r);

    const forgedDrop = await ownerDrop(M, mallory, stolen, WORLD, newDropId());
    r = await relay(await relayBody(M.domain, M.identity, { credential: stolen, dropId: forgedDrop.payload.dropId, world: WORLD, claimant: mallory, dropIntent: forgedDrop }));
    check('a drop intent signed by someone other than the owner is refused', r.status >= 400 && r.status < 500 && !(await revokedIds(A)).has(stolen.id), r);

    const other = await issue(A, alice, 'atlas.trophy.chess');
    const ownerOther = await ownerDrop(M, alice, other, WORLD, newDropId());
    r = await relay(await relayBody(M.domain, M.identity, { credential: stolen, dropId: ownerOther.payload.dropId, world: WORLD, claimant: mallory, dropIntent: ownerOther }));
    check('the owner\'s intent for a different credential is refused', r.status >= 400 && r.status < 500 && !(await revokedIds(A)).has(stolen.id), r);

    console.log('--- the owner really dropped it, but into another domain ---');
    const droppedAtB = await dropAt(B, alice, stolen, WORLD);
    check('Alice drops it into B\'s world', droppedAtB.res.status === 200 && droppedAtB.res.body.dropId === droppedAtB.dropId, droppedAtB.res);
    r = await relay(await relayBody(M.domain, M.identity, { credential: stolen, dropId: droppedAtB.dropId, world: WORLD, claimant: mallory, dropIntent: droppedAtB.intent }));
    check('a copy of her intent is useless to a domain it does not name', r.status >= 400 && r.status < 500 && !(await revokedIds(A)).has(stolen.id), r);
    const listed = await S.get(B.base, '/atlas/world/drops?world=' + encodeURIComponent(WORLD));
    check('the public listing does not publish her signed intent', listed.body.drops.every((d) => d.dropIntent === undefined && d.intent === undefined), listed.body);

    console.log('--- the claim must be the claimant\'s own and name the same drop ---');
    const wrongClaimant = await relayBody(B.domain, M.identity, { credential: stolen, dropId: droppedAtB.dropId, world: WORLD, claimant: bob, dropIntent: droppedAtB.intent, claimantKey: mallory.publicKey });
    r = await relay(wrongClaimant);
    check('a request whose attestation is not signed by B is refused', r.status >= 400 && r.status < 500, r);

    console.log('--- the legitimate flow: drop at B, pick up at B, settled by A ---');
    const cred1 = await issue(A, alice, 'atlas.trophy.chess');
    const d1 = await dropAt(B, alice, cred1, WORLD);
    check('drop accepted', d1.res.status === 200, d1.res);
    const c1 = await claimAt(B, bob, d1.dropId);
    check('Bob picks it up', c1.status === 200 && c1.body.status === 'claimed' && c1.body.credential.owner.publicKey === bob.publicKey, c1);
    check('it is still issued by A', c1.body.credential && c1.body.credential.issuer.domain === A.domain, c1.body);
    check('the dropped credential is revoked', (await revokedIds(A)).has(cred1.id));
    const gone = await claimAt(B, carol, d1.dropId);
    check('a second pick-up of the same drop is refused', gone.status === 404, gone);

    console.log('--- Alice takes her own drop back ---');
    const cred2 = await issue(A, alice, 'atlas.trophy.chess');
    const d2 = await dropAt(B, alice, cred2, WORLD);
    const back = await claimAt(B, alice, d2.dropId);
    check('reclaiming one\'s own drop works the same way', back.status === 200 && back.body.credential.owner.publicKey === alice.publicKey, back);

    console.log('--- a third domain the issuers have never heard of can host a drop ---');
    const cred3 = await issue(A, alice, 'atlas.trophy.chess');
    const dropId3 = newDropId();
    const intent3 = await ownerDrop(M, alice, cred3, WORLD, dropId3);
    const body3 = await relayBody(M.domain, M.identity, { credential: cred3, dropId: dropId3, world: WORLD, claimant: carol, dropIntent: intent3 });
    r = await relay(body3);
    check('with the owner\'s intent naming it, its relay settles', r.status === 200 && r.body.credential && r.body.credential.owner.publicKey === carol.publicKey, r);
    const firstSuccessor = r.body.credential;

    console.log('--- replays cannot make a second transfer ---');
    r = await relay(body3);
    check('the identical request returns nothing new', r.status === 200 ? (r.body.credential && r.body.credential.id === firstSuccessor.id) : (r.status >= 400 && r.status < 500), r);
    const claimMallory = await relayBody(M.domain, M.identity, { credential: cred3, dropId: dropId3, world: WORLD, claimant: mallory, dropIntent: intent3 });
    r = await relay(claimMallory);
    check('the same authorization with a different claimant is refused', r.status >= 400 && r.status < 500 && !(r.body && r.body.credential), r);
    const newer = await relayBody(M.domain, M.identity, { credential: cred3, dropId: newDropId(), world: WORLD, claimant: mallory, dropIntent: intent3 });
    r = await relay(newer);
    check('and so is it under a fresh drop id', r.status >= 400 && r.status < 500 && !(r.body && r.body.credential), r);

    console.log('--- credentials that may not move ---');
    const spentCred = await issue(A, alice, 'atlas.trophy.chess');
    const dSpent = await dropAt(B, alice, spentCred, WORLD);
    const sendPayload = { action: 'transfer', credentialId: spentCred.id, recipientPublicKey: carol.publicKey };
    const sent = await S.post(A.base, '/atlas/asset/transfer', { credential: spentCred, recipientPublicKey: carol.publicKey, intent: { payload: sendPayload, proof: await S.signPayload(alice, sendPayload) } });
    check('Alice sends the dropped credential to Carol instead', sent.status === 200, sent);
    const lateClaim = await claimAt(B, bob, dSpent.dropId);
    check('a later pick-up fails and issues nothing', lateClaim.status >= 400 && !(lateClaim.body && lateClaim.body.credential), lateClaim);

    const bound = await issue(A, alice, 'atlas.membership');
    const dBound = newDropId();
    const intentBound = await ownerDrop(M, alice, bound, WORLD, dBound);
    r = await relay(await relayBody(M.domain, M.identity, { credential: bound, dropId: dBound, world: WORLD, claimant: mallory, dropIntent: intentBound }));
    check('a bound credential is refused even with every signature valid', r.status >= 400 && r.status < 500 && !(await revokedIds(A)).has(bound.id), r);

    console.log('--- a drop on the issuer\'s own domain is checked again when it is claimed ---');
    const local = await issue(A, alice, 'atlas.trophy.chess');
    const dLocal = await dropAt(A, alice, local, WORLD);
    check('Alice drops it into A\'s own world', dLocal.res.status === 200, dLocal.res);
    const sendLocal = { action: 'transfer', credentialId: local.id, recipientPublicKey: carol.publicKey };
    const sentLocal = await S.post(A.base, '/atlas/asset/transfer', { credential: local, recipientPublicKey: carol.publicKey, intent: { payload: sendLocal, proof: await S.signPayload(alice, sendLocal) } });
    check('then sends the same credential to Carol', sentLocal.status === 200, sentLocal);
    const lateLocal = await claimAt(A, bob, dLocal.dropId);
    check('Bob\'s pick-up issues nothing, so the value is not duplicated', lateLocal.status >= 400 && !(lateLocal.body && lateLocal.body.credential), lateLocal);

    console.log('--- drops listed before owners signed them: only a peer the operator names may relay without intents ---');
    const L = await S.startIssuer(STACK, BASE_PORT + 3, { ATLAS_LEGACY_DROP_PEERS: M.domain });
    try {
      const old = await issue(L, alice, 'atlas.trophy.chess');
      const unsigned = await relayBody(M.domain, M.identity, { credential: old, dropId: newDropId(), world: WORLD, claimant: null, claimantKey: bob.publicKey, dropIntent: null, claimIntent: null });
      r = await S.post(L.base, '/atlas/world/drops/relay-claim', unsigned);
      check('a listed legacy peer\'s unsigned relay settles', r.status === 200 && r.body.credential && r.body.credential.owner.publicKey === bob.publicKey, r);
      const other2 = await issue(L, alice, 'atlas.trophy.chess');
      const stranger = await S.startStandInDomain(BASE_PORT + 4);
      try {
        r = await S.post(L.base, '/atlas/world/drops/relay-claim', await relayBody(stranger.domain, stranger.identity, { credential: other2, dropId: newDropId(), world: WORLD, claimant: null, claimantKey: bob.publicKey, dropIntent: null, claimIntent: null }));
        check('any other domain\'s unsigned relay is still refused', r.status >= 400 && r.status < 500, r);
      } finally { stranger.stop(); }
    } finally { L.stop(); }

    console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  } finally {
    A.stop(); B.stop(); M.stop();
  }
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
