// A credential that is replaced by another (an administrator's reissue or clawback, a transfer) is never lost or
// duplicated when the request stops part-way. The process is stopped at chosen points (ATLAS_TEST_CRASH_AT; the
// request's script for PHP, the whole server for Node), restarted, and the same request is sent again: it must
// return the same successor, and exactly one of the old and new credentials may be live afterwards.
//
//   node test/security-replacement-recovery.js [node|php|both]
//
// A stopped process is not power loss; see the note in lib/replacement.php.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { startNode, startPhp, api } = require('./lib/gen1-issuers');
const { newOwner, ownerIntent, proofFor } = require('./lib/owner-auth');
const { withAdminAuth } = require('./lib/admin-auth');

const WHICH = process.argv.find((a) => ['node', 'php', 'both'].includes(a)) || 'both';
let failures = 0;
function check(be, name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL') + ' [' + be.kind + '] ' + name + (!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : ''));
}
const canonicalize = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? '[' + v.map(canonicalize).join(',') + ']'
    : '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLASS = 'atlas.trophy.chess';

function newAdmin() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
  return { publicKey: raw, privateKey };
}
function adminBody(be, route, payload, admin) {
  const signed = withAdminAuth(payload, be.base, route);
  const signature = crypto.sign('sha256', Buffer.from(canonicalize(signed)), { key: admin.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { payload: signed, proof: { signerRole: 'raw-ecdsa', publicKey: admin.publicKey, signature } };
}
const revokedIds = (be) => { try { return new Set(JSON.parse(fs.readFileSync(be.revFile, 'utf8')).revoked.map((r) => r.id)); } catch (e) { return new Set(); } };
const updatesFile = (be) => (be.kind === 'php' ? path.join(be.bundle, 'lib', 'atlas-asset-updates-store.json') : path.join(be.state, 'atlas-asset-updates-store.json'));
const updatesFor = (be, id) => { try { return JSON.parse(fs.readFileSync(updatesFile(be), 'utf8')).updates.filter((u) => u.id === id); } catch (e) { return []; } };
const journal = (be) => api(be).txnEntries();

async function setup(be) {
  const admin = newAdmin();
  const keysFile = be.kind === 'php' ? path.join(be.bundle, 'lib', 'atlas-admin-keys-store.json') : path.join(be.state, 'atlas-admin-keys-store.json');
  fs.writeFileSync(keysFile, JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }));
  return admin;
}
async function issueUnique(be, owner) {
  const r = await api(be).post('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: CLASS, quantity: 1 });
  if (r.status !== 200) throw new Error('could not issue: ' + JSON.stringify(r.body));
  return r.body;
}

// Each operation: how to send it, and where the successor is in the answer.
const OPS = {
  reissue: {
    send: (be, admin, cred) => api(be).post('/atlas/asset/reissue', adminBody(be, '/atlas/asset/reissue', { credential: cred, tradeScope: 'bound' }, admin)),
    successor: (r) => r.body && r.body.newCredential
  },
  clawback: {
    send: (be, admin, cred, ctx) => api(be).post('/atlas/clawback', adminBody(be, '/atlas/clawback', { credential: cred, toPublicKey: ctx.victim }, admin)),
    successor: (r) => r.body && r.body.newCredential
  },
  transfer: {
    // The owner's signed intent, without a requestId (the older request shape).
    send: (be, admin, cred, ctx) => api(be).post('/atlas/asset/transfer', { credential: cred, recipientPublicKey: ctx.victim, intent: ownerIntent(ctx.owner, 'transfer', { credentialId: cred.id, recipientPublicKey: ctx.victim }) }),
    successor: (r) => r.body && r.body.credential
  }
};

async function scenario(be, admin, name, crashAt) {
  const op = OPS[name];
  const owner = newOwner(), victim = newOwner();
  const ctx = { owner, victim };
  const cred = await issueUnique(be, owner);
  const label = name + ' stopped at ' + crashAt;

  await be.restart({ ATLAS_TEST_CRASH_AT: crashAt, ATLAS_TXN_NO_SWEEP: '1' });
  const first = await op.send(be, admin, cred, ctx);
  check(be, label + ': the request produced no answer', first.status === 0 || first.status >= 500 || !op.successor(first), first);
  await be.restart({ ATLAS_TXN_NO_SWEEP: '1' });

  const second = await op.send(be, admin, cred, ctx);
  const succ = op.successor(second);
  check(be, label + ': asking again succeeds', second.status === 200 && !!succ, second);
  const third = await op.send(be, admin, cred, ctx);
  check(be, label + ': asking a third time returns the same successor', third.status === 200 && succ && op.successor(third) && op.successor(third).id === succ.id, third);
  const revoked = revokedIds(be);
  check(be, label + ': the old credential is revoked and the new one is live', revoked.has(cred.id) && succ && !revoked.has(succ.id), { old: revoked.has(cred.id), new: succ && revoked.has(succ.id) });
  check(be, label + ": no journal entry is left behind", journal(be).length === 0, journal(be));
  return { cred, succ };
}

async function run(be) {
  const admin = await setup(be);
  for (const name of Object.keys(OPS)) {
    for (const point of ['revoke:written', 'txn:journal-written', 'txn:effects-applied']) {
      await scenario(be, admin, name, point);
    }
  }

  // The published update for a reissue is completed by recovery even when nobody asks again.
  const owner = newOwner();
  const cred = await issueUnique(be, owner);
  await be.restart({ ATLAS_TEST_CRASH_AT: 'revoke:written', ATLAS_TXN_NO_SWEEP: '1' });
  await OPS.reissue.send(be, admin, cred, { owner });
  await be.restart({ ATLAS_TXN_NO_SWEEP: '' });
  if (be.kind === 'php') await api(be).post('/atlas/asset/issue', { ownerPublicKey: newOwner(), assetClass: 'atlas.element.iron', quantity: 1, requestId: crypto.randomBytes(18).toString('base64url') });
  await sleep(800);
  const updates = updatesFor(be, cred.id);
  check(be, 'recovery alone publishes the update for a reissue that stopped after the revocation', updates.length === 1 && updates[0].newCredential && !revokedIds(be).has(updates[0].newCredential.id), updates);
}

// The roster entry that names a membership credential follows it to the clawback's new credential and owner. Recovery
// completes that when the request stopped after the revocation, and a second application changes nothing.
async function membership(be, admin) {
  const rosterFile = be.kind === 'php' ? path.join(be.bundle, 'lib', 'atlas-postoffice-members-store.json') : path.join(be.state, 'atlas-postoffice-members-store.json');
  const entries = () => { try { return JSON.parse(fs.readFileSync(rosterFile, 'utf8')).members; } catch (e) { return []; } };
  const holder = newOwner(), victim = newOwner();
  const cred = (await api(be).post('/atlas/asset/issue', { ownerPublicKey: holder, assetClass: 'atlas.postoffice.membership', quantity: 1 })).body;
  const handlePayload = { handle: 'h' + crypto.randomBytes(5).toString('hex') };
  const set = await api(be).post('/atlas/postoffice/handle', { payload: handlePayload, proof: proofFor(holder, handlePayload) });
  check(be, 'a roster entry exists for the membership', set.status === 200 && entries().some((m) => m.credentialId === cred.id), set);

  await be.restart({ ATLAS_TEST_CRASH_AT: 'revoke:written', ATLAS_TXN_NO_SWEEP: '1' });
  await OPS.clawback.send(be, admin, cred, { victim });
  await be.restart({ ATLAS_TXN_NO_SWEEP: '' });
  if (be.kind === 'php') await api(be).post('/atlas/asset/issue', { ownerPublicKey: newOwner(), assetClass: 'atlas.element.iron', quantity: 1, requestId: crypto.randomBytes(18).toString('base64url') });
  await sleep(800);
  const moved = entries().find((m) => m.ownerPublicKey === victim);
  check(be, 'recovery alone re-points the roster entry at the new credential and owner', !!moved && moved.credentialId !== cred.id && moved.handle === handlePayload.handle, entries());
  const again = await OPS.clawback.send(be, admin, cred, { victim });
  check(be, 'asking again returns the same credential the roster entry now names', again.status === 200 && moved && again.body.newCredential.id === moved.credentialId, again);
  check(be, 'the roster still has exactly one entry for the handle', entries().filter((m) => m.handle === handlePayload.handle).length === 1, entries());
}

// A class-wide patch is applied to a credential when its owner next checks in. A check-in that stops after the revocation
// loses nothing: the next one (or recovery alone) delivers the same replacement.
async function classPatch(be, admin) {
  const owner = newOwner();
  const cred = await issueUnique(be, owner);
  const patch = await api(be).post('/atlas/admin/class-patch', adminBody(be, '/atlas/admin/class-patch', { assetClass: CLASS, properties: { 'com.example.awardedFor': 'Season ' + crypto.randomBytes(3).toString('hex') } }, admin));
  check(be, 'a class patch is stored', patch.status === 200, patch);
  const checkIn = () => {
    const payload = { action: 'mail-check', domain: new URL(be.base).host, credentialIds: [cred.id], issuedAt: new Date().toISOString(), nonce: crypto.randomBytes(18).toString('base64url') };
    return api(be).post('/atlas/mail/check', { credentials: [cred], payload, proof: proofFor(owner, payload) });
  };
  await be.restart({ ATLAS_TEST_CRASH_AT: 'revoke:written', ATLAS_TXN_NO_SWEEP: '1' });
  const first = await checkIn();
  check(be, 'class patch stopped after the revocation: the check-in produced no replacement', !(first.body && first.body.updates && first.body.updates.some((u) => u.newCredential)), first);
  await be.restart({ ATLAS_TXN_NO_SWEEP: '1' });
  const second = await checkIn();
  const update = second.body && second.body.updates && second.body.updates.find((u) => u.id === cred.id);
  const succ = update && update.newCredential;
  check(be, 'class patch stopped after the revocation: the next check-in delivers the replacement', second.status === 200 && !!succ, second);
  const third = await checkIn();
  const again = third.body && third.body.updates && third.body.updates.find((u) => u.id === cred.id);
  check(be, 'class patch: a further check-in delivers the same replacement, not another', !!again && !!succ && again.newCredential.id === succ.id, third);
  const revoked = revokedIds(be);
  check(be, 'class patch: the old credential is revoked and the new one live', revoked.has(cred.id) && succ && !revoked.has(succ.id));
}

// Only the owner can fetch a recorded transfer result: someone holding a copy of the old credential cannot.
async function strangerCannotReplay(be) {
  const owner = newOwner(), recipient = newOwner(), stranger = newOwner();
  const cred = await issueUnique(be, owner);
  const asOwner = await OPS.transfer.send(be, null, cred, { owner, victim: recipient });
  const intent = ownerIntent(stranger, 'transfer', { credentialId: cred.id, recipientPublicKey: recipient });
  const asStranger = await api(be).post('/atlas/asset/transfer', { credential: cred, recipientPublicKey: recipient, intent });
  check(be, 'the owner\'s transfer succeeds', asOwner.status === 200, asOwner);
  check(be, 'a stranger holding a copy of the old credential is not given the recorded result', asStranger.status >= 400 && !(asStranger.body && asStranger.body.credential), asStranger);
  const owner2 = newOwner();
  const stolen = await issueUnique(be, owner2);
  await OPS.transfer.send(be, null, stolen, { owner: owner2, victim: recipient });
  const intent2 = ownerIntent(owner2, 'transfer', { credentialId: stolen.id, recipientPublicKey: stranger });
  const elsewhere = await api(be).post('/atlas/asset/transfer', { credential: stolen, recipientPublicKey: stranger, intent: intent2 });
  check(be, 'the same item sent to a different recipient is refused, not answered with the first result', elsewhere.status >= 400, elsewhere);
}

(async () => {
  const kinds = WHICH === 'both' ? ['node', 'php'] : [WHICH];
  for (const kind of kinds) {
    const be = kind === 'node' ? await startNode(8571 + 0) : await startPhp(8573, { workers: 0 });
    try { await run(be); const admin2 = await setup(be); await membership(be, admin2); await classPatch(be, admin2); await strangerCannotReplay(be); } catch (e) { failures++; console.log('FAIL [' + kind + '] ' + (e.stack || e)); } finally { be.stop(); }
  }
  console.log(failures ? failures + ' FAILED' : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
