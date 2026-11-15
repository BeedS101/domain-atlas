// A cross-domain Trading Station claim whose second leg is settled by a foreign issuer must never refund the claimant
// while the issuer's outcome is unknown. The issuer (A) is stopped at chosen points while it settles the poster's
// balance, restarted, and the claimant sends the same claim again: it must finish the trade exactly once, with no refund
// minted and the poster paid once.
//
//   node test/security-trade-relay-recovery.js [node|php|both]
//
// Throw-away issuers only. A stopped process is not power loss.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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
const peersFile = (be) => (be.kind === 'php' ? path.join(be.bundle, 'lib', 'atlas-trusted-trade-peers-store.json') : path.join(be.state, 'atlas-trusted-trade-peers-store.json'));

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

// X is the issuer that is stopped; S is the station that hosts the listing and the claim. `foreignLeg` says which side X
// issues: 'poster' (X issues the poster's iron, settled second) or 'claimant' (X issues the claimant's gold, settled first).
async function scenario(X, S, crashAt, foreignLeg) {
  const A = foreignLeg === 'poster' ? X : S; // issuer of the poster's iron
  const C = foreignLeg === 'poster' ? S : X; // issuer of the claimant's gold
  const B = S;
  const alice = newOwner(), bob = newOwner();
  const aliceMember = await issue(B, alice, 'atlas.tradingstation.membership');
  const bobMember = await issue(B, bob, 'atlas.tradingstation.membership');
  const aliceIron = await issue(A, alice, 'atlas.element.iron', 10);
  const bobGold = await issue(C, bob, 'atlas.element.gold', 10);
  await X.restart(noSweep());
  await S.restart(noSweep());
  const posted = await api(B).post('/atlas/trade/submit', { membership: aliceMember, intent: tradeIntent(alice, { class: 'atlas.element.iron', quantity: 10 }, { class: 'atlas.element.gold', quantity: 5 }), balance: aliceIron });
  if (posted.status !== 200) throw new Error('could not post the listing: ' + JSON.stringify(posted.body));
  const requestId = crypto.randomBytes(18).toString('base64url');
  const claim = () => api(B).post('/atlas/trade/claim', { pendingId: posted.body.pendingId, membership: bobMember, requestId, intent: tradeIntent(bob, { class: 'atlas.element.gold', quantity: 5 }, { class: 'atlas.element.iron', quantity: 10 }, alice, requestId), balance: bobGold });
  const label = (foreignLeg === 'poster' ? 'poster' : 'claimant') + '\'s issuer stopped at ' + crashAt;

  await X.restart(noSweep({ ATLAS_TEST_CRASH_AT: crashAt }));
  const first = await claim();
  // A request-scoped stop (PHP) leaves the issuer able to answer the station's own retry, so a settled answer is possible
  // and then it must carry the issuer's credential; otherwise the claim is left open.
  check(B, label + ': a settlement is reported only with the issuer\'s credential', !(first.body && first.body.status === 'settled') || (first.body.received && first.body.received.issuer.domain === A.domain), first);
  check(B, label + ': the claimant is not refunded while the issuer\'s outcome is unknown', !(first.body && first.body.refund), first.body);
  await X.restart(noSweep());

  const second = await claim();
  const done = second.status === 200 && second.body.status === 'settled' && !!second.body.received;
  check(B, label + ': asking again settles the trade', done, second);
  if (!done || !second.body.received) return;
  check(B, label + ': the claimant receives the iron from the issuer', second.body.received.asset.class === 'atlas.element.iron' && second.body.received.quantity === 10 && second.body.received.owner.publicKey === bob && second.body.received.issuer.domain === A.domain, second.body.received);
  check(B, label + ': the claimant keeps the change', second.body.remainder && second.body.remainder.quantity === 5 && second.body.remainder.owner.publicKey === bob && second.body.remainder.issuer.domain === C.domain, second.body.remainder);
  const third = await claim();
  check(B, label + ': asking a third time returns the same credentials', third.status === 200 && third.body.received && third.body.received.id === second.body.received.id, third);

  const notices = ((await mailFor(A, alice, aliceIron)).messages || []).filter((m) => m.credentialId === aliceIron.id);
  check(B, label + ': the poster is told exactly once', notices.length === 1, notices.length);
  const paid = notices[0] && notices[0].attachedAsset;
  check(B, label + ': the poster is paid 5 gold, and that credential is live', !!paid && paid.quantity === 5 && paid.owner.publicKey === alice && !revokedIds(C).has(paid.id), paid);
  const revokedA = revokedIds(A), revokedC = revokedIds(C);
  check(B, label + ': both original balances are spent', revokedA.has(aliceIron.id) && revokedC.has(bobGold.id));
  check(B, label + ': what the claimant received is live', !revokedA.has(second.body.received.id) && !revokedC.has(second.body.remainder.id));
  check(B, label + ': no journal entry is left on either domain', api(X).txnEntries().length === 0 && api(S).txnEntries().length === 0, [api(X).txnEntries(), api(S).txnEntries()]);
}

(async () => {
  const kinds = WHICH === 'both' ? ['node', 'php'] : [WHICH];
  for (const kind of kinds) {
    const base = kind === 'node' ? 8611 : 8621;
    const A = kind === 'node' ? await startNode(base) : await startPhp(base, { workers: 0 });
    const B = kind === 'node' ? await startNode(base + 1) : await startPhp(base + 1);
    try {
      fs.writeFileSync(peersFile(A), JSON.stringify({ peers: [B.domain] }));
      fs.writeFileSync(peersFile(B), JSON.stringify({ peers: [A.domain] }));
      for (const foreignLeg of ['poster', 'claimant']) {
        for (const point of ['txn:journal-written@1', 'revoke:written@1', 'txn:revoked@1', 'txn:journal-removed@1']) await scenario(A, B, point, foreignLeg);
      }
    } catch (e) { failures++; console.log('FAIL [' + kind + '] ' + (e.stack || e)); } finally { A.stop(); B.stop(); }
  }
  console.log(failures ? failures + ' FAILED' : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
