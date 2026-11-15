// A Trading Station claim whose two settlement legs both run on the station's own domain never loses a balance or pays
// one side twice when the request stops part-way. The process is stopped at chosen points (ATLAS_TEST_CRASH_AT, with
// "@2" for the second leg), restarted, and the claimant sends the same claim again: it must finish the trade exactly once.
//
//   node test/security-trade-settlement.js [node|php|both]
//
// A stopped process is not power loss; see the note in lib/replacement.php. Trades that cross domains keep the
// limitation described in SECURITY-HARDENING.md.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const { startNode, startPhp, api } = require('./lib/gen1-issuers');
const { newOwner, proofFor } = require('./lib/owner-auth');

const WHICH = process.argv.find((a) => ['node', 'php', 'both'].includes(a)) || 'both';
let failures = 0;
function check(be, name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL') + ' [' + be.kind + '] ' + name + (!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : ''));
}
const revokedIds = (be) => { try { return new Set(JSON.parse(fs.readFileSync(be.revFile, 'utf8')).revoked.map((r) => r.id)); } catch (e) { return new Set(); } };
const noSweep = (extra) => Object.assign({ ATLAS_TXN_NO_SWEEP: '1' }, extra);

async function issue(be, owner, cls, quantity) {
  const r = await api(be).post('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: cls, quantity: quantity || 1 });
  if (r.status !== 200) throw new Error('could not issue ' + cls + ': ' + JSON.stringify(r.body));
  return r.body;
}
function tradeIntent(owner, offer, want, counterparty, requestId) {
  const payload = Object.assign({ offer, want }, counterparty ? { counterparty } : {}, requestId ? { requestId } : {}, { expiresAt: new Date(Date.now() + 10 * 60000).toISOString() });
  return { payload, proof: proofFor(owner, payload) };
}
async function mailFor(be, owner, credential) {
  const payload = { action: 'mail-check', domain: new URL(be.base).host, credentialIds: [credential.id], issuedAt: new Date().toISOString(), nonce: crypto.randomBytes(18).toString('base64url') };
  const r = await api(be).post('/atlas/mail/check', { credentials: [credential], payload, proof: proofFor(owner, payload) });
  return r.body || {};
}

async function scenario(be, crashAt) {
  const alice = newOwner(), bob = newOwner();
  const aliceMember = await issue(be, alice, 'atlas.tradingstation.membership');
  const bobMember = await issue(be, bob, 'atlas.tradingstation.membership');
  const aliceIron = await issue(be, alice, 'atlas.element.iron', 10);
  const bobGold = await issue(be, bob, 'atlas.element.gold', 10);
  await be.restart(noSweep());
  const posted = await api(be).post('/atlas/trade/submit', { membership: aliceMember, intent: tradeIntent(alice, { class: 'atlas.element.iron', quantity: 10 }, { class: 'atlas.element.gold', quantity: 5 }), balance: aliceIron });
  if (posted.status !== 200) throw new Error('could not post the listing: ' + JSON.stringify(posted.body));
  // The claim carries a request id, so an outcome that was recorded is returned again to a repeat of the request.
  const requestId = crypto.randomBytes(18).toString('base64url');
  const claim = () => api(be).post('/atlas/trade/claim', { pendingId: posted.body.pendingId, membership: bobMember, requestId, intent: tradeIntent(bob, { class: 'atlas.element.gold', quantity: 5 }, { class: 'atlas.element.iron', quantity: 10 }, alice, requestId), balance: bobGold });
  const label = 'claim stopped at ' + crashAt;

  await be.restart(noSweep({ ATLAS_TEST_CRASH_AT: crashAt }));
  const first = await claim();
  check(be, label + ': the request produced no settled answer', !(first.body && first.body.status === 'settled'), first);
  await be.restart(noSweep());

  const second = await claim();
  const done = second.status === 200 && second.body.status === 'settled';
  check(be, label + ': asking again settles the trade', done, second);
  if (!done) return;
  check(be, label + ': the claimant receives the iron', second.body.received.asset.class === 'atlas.element.iron' && second.body.received.quantity === 10 && second.body.received.owner.publicKey === bob, second.body.received);
  check(be, label + ': the claimant keeps the change', second.body.remainder && second.body.remainder.asset.class === 'atlas.element.gold' && second.body.remainder.quantity === 5 && second.body.remainder.owner.publicKey === bob, second.body.remainder);
  const third = await claim();
  check(be, label + ': asking a third time returns the same credentials', third.status === 200 && third.body.received && third.body.received.id === second.body.received.id, third);

  const mail = (await mailFor(be, alice, aliceIron)).messages || [];
  const notices = mail.filter((m) => m.credentialId === aliceIron.id);
  check(be, label + ': the poster is told exactly once', notices.length === 1, notices.length);
  const paid = notices[0] && notices[0].attachedAsset;
  check(be, label + ': the poster is paid 5 gold, owned by the poster', !!paid && paid.asset.class === 'atlas.element.gold' && paid.quantity === 5 && paid.owner.publicKey === alice, paid);
  const revoked = revokedIds(be);
  check(be, label + ': both original balances are spent', revoked.has(aliceIron.id) && revoked.has(bobGold.id), { alice: revoked.has(aliceIron.id), bob: revoked.has(bobGold.id) });
  check(be, label + ': everything delivered is live', !revoked.has(second.body.received.id) && !revoked.has(second.body.remainder.id) && !!paid && !revoked.has(paid.id));
  check(be, label + ': the listing is gone', ((await api(be).get('/atlas/trade/listings')).body.listings || (await api(be).get('/atlas/trade/listings')).body.trades || []).every((t) => t.id !== posted.body.pendingId && t.pendingId !== posted.body.pendingId));
  check(be, label + ': no journal entry is left behind', api(be).txnEntries().length === 0, api(be).txnEntries());
}

async function strangerCannotResume(be) {
  // A balance spent for a trade can be resumed only by its owner presenting the genuine credential.
  const alice = newOwner(), bob = newOwner(), mallory = newOwner();
  const aliceMember = await issue(be, alice, 'atlas.tradingstation.membership');
  const bobMember = await issue(be, bob, 'atlas.tradingstation.membership');
  const malloryMember = await issue(be, mallory, 'atlas.tradingstation.membership');
  const aliceIron = await issue(be, alice, 'atlas.element.iron', 10);
  const bobGold = await issue(be, bob, 'atlas.element.gold', 10);
  await be.restart(noSweep());
  const posted = await api(be).post('/atlas/trade/submit', { membership: aliceMember, intent: tradeIntent(alice, { class: 'atlas.element.iron', quantity: 10 }, { class: 'atlas.element.gold', quantity: 5 }), balance: aliceIron });
  await be.restart(noSweep({ ATLAS_TEST_CRASH_AT: 'txn:revoked@1' }));
  const claim = (member, who, balance) => api(be).post('/atlas/trade/claim', { pendingId: posted.body.pendingId, membership: member, intent: tradeIntent(who, { class: 'atlas.element.gold', quantity: 5 }, { class: 'atlas.element.iron', quantity: 10 }, alice), balance });
  await claim(bobMember, bob, bobGold);
  await be.restart(noSweep());
  const thief = await claim(malloryMember, mallory, bobGold);
  check(be, 'a stranger presenting the spent balance does not take over the trade', !(thief.body && thief.body.status === 'settled') && !(thief.body && thief.body.received && thief.body.received.owner.publicKey === aliceIron.owner.publicKey), thief);
  const owner = await claim(bobMember, bob, bobGold);
  check(be, 'the owner can still finish it', owner.status === 200 && owner.body.status === 'settled' && owner.body.received.owner.publicKey === bob, owner);
}

(async () => {
  const kinds = WHICH === 'both' ? ['node', 'php'] : [WHICH];
  for (const kind of kinds) {
    const be = kind === 'node' ? await startNode(8601) : await startPhp(8603, { workers: 0 });
    try {
      for (const point of ['txn:journal-written@1', 'revoke:written@1', 'txn:revoked@1', 'txn:journal-written@2', 'revoke:written@2', 'txn:revoked@2', 'txn:effects-applied@2', 'txn:journal-removed@2']) await scenario(be, point);
      await strangerCannotResume(be);
    } catch (e) { failures++; console.log('FAIL [' + kind + '] ' + (e.stack || e)); } finally { be.stop(); }
  }
  console.log(failures ? failures + ' FAILED' : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
