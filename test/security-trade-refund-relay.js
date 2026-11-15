// A cross-domain Trading Station claim whose first leg already spent the claimant's balance at a foreign issuer, and
// whose second leg the poster's issuer then refuses for good, must give the claimant their value back exactly once: no
// permanent loss, no duplicate, and a retried claim never settles a trade that was refunded.
//
//   node test/security-trade-refund-relay.js [node|php|mixed|both]
//
// 'mixed' runs a Node station with a PHP claimant issuer and a Node poster issuer, then the reverse, to show the two
// stacks keep speaking the same protocol; 'both' runs node, php and mixed.
//
// Three throw-away issuers per stack: S hosts the listing and the claim, X issued the claimant's gold, Y issued the
// poster's iron. X and Y sit behind a test proxy so Y can refuse the second leg and X can be made to lack the refund
// endpoint (an older issuer). A stopped process is not power loss.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { startNode, startPhp, api } = require('./lib/gen1-issuers');
const { newOwner, proofFor } = require('./lib/owner-auth');
const { startEndpointProxy } = require('./support/endpoint-proxy');

const WHICH = process.argv.find((a) => ['node', 'php', 'mixed', 'both'].includes(a)) || 'both';
let failures = 0;
function check(be, name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL') + ' [' + be.kind + '] ' + name + (!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500) : ''));
}
const revokedIds = (be) => { try { return new Set(JSON.parse(fs.readFileSync(be.revFile, 'utf8')).revoked.map((r) => r.id)); } catch (e) { return new Set(); } };
const noSweep = (extra) => Object.assign({ ATLAS_TXN_NO_SWEEP: '1' }, extra);
const peersFile = (be) => (be.kind === 'php' ? path.join(be.bundle, 'lib', 'atlas-trusted-trade-peers-store.json') : path.join(be.state, 'atlas-trusted-trade-peers-store.json'));
const SETTLE = '/atlas/trade/relay-settle';
const REFUND = '/atlas/trade/relay-refund';

// An issuer whose identity is the proxy's address: clients and peers use the proxy, the issuer listens on its own port.
async function fronted(kind, proxyPort, realPort, workers) {
  const domain = (kind === 'node' ? 'localhost:' : '127.0.0.1:') + proxyPort;
  const env = { ATLAS_DOMAIN: domain, ATLAS_OUTBOUND_RATE: '500', ATLAS_OUTBOUND_RATE_ALL: '2000', ATLAS_OUTBOUND_KEY_RATE: '500', ATLAS_OUTBOUND_KEY_RATE_ALL: '2000' };
  const be = kind === 'node' ? await startNode(realPort, { env }) : await startPhp(realPort, { env, workers });
  be.proxy = await startEndpointProxy(proxyPort, realPort);
  be.domain = domain;
  be.base = 'http://' + domain;
  const restart = be.restart;
  be.restart = (extra) => restart(Object.assign({}, env, { ATLAS_MINT_LIMITS: 'off', ATLAS_PRIVATE_MINT: 'off' }, extra));
  const stop = be.stop;
  be.stop = () => { be.proxy.stop(); stop(); };
  return be;
}

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

// Sets up one trade: alice posts 10 iron (issued by Y) for 5 gold, bob holds 10 gold issued by X. `unique` makes bob's side
// a one-of-a-kind item instead.
async function setup(S, X, Y, unique) {
  const alice = newOwner(), bob = newOwner();
  const aliceMember = await issue(S, alice, 'atlas.tradingstation.membership');
  const bobMember = await issue(S, bob, 'atlas.tradingstation.membership');
  const aliceIron = await issue(Y, alice, 'atlas.element.iron', 10);
  const bobClass = unique ? 'atlas.trophy.chess' : 'atlas.element.gold';
  const bobQty = unique ? 1 : 5;
  const bobBalance = await issue(X, bob, bobClass, unique ? 1 : 10);
  const posted = await api(S).post('/atlas/trade/submit', { membership: aliceMember, intent: tradeIntent(alice, { class: 'atlas.element.iron', quantity: 10 }, { class: bobClass, quantity: bobQty }), balance: aliceIron });
  if (posted.status !== 200) throw new Error('could not post the listing: ' + JSON.stringify(posted.body));
  const claim = (requestId) => api(S).post('/atlas/trade/claim', { pendingId: posted.body.pendingId, membership: bobMember, requestId, intent: tradeIntent(bob, { class: bobClass, quantity: bobQty }, { class: 'atlas.element.iron', quantity: 10 }, alice, requestId), balance: bobBalance });
  const newId = () => crypto.randomBytes(18).toString('base64url');
  return { alice, bob, aliceIron, bobBalance, bobClass, bobQty, posted: posted.body, claim, newId };
}
const listed = async (S, pendingId) => {
  const r = await api(S).get('/atlas/trade/listings');
  return (r.body.listings || r.body.trades || []).some((t) => t.id === pendingId || t.pendingId === pendingId);
};

// What must hold once the claimant has been refunded, whichever way it got there.
async function assertRefunded(S, X, Y, label, t, res, revokedBeforeX, revokedBeforeY) {
  const refund = res.body && res.body.refund;
  check(S, label + ': the claimant is refunded', !!refund && res.status >= 400, res);
  if (!refund) return null;
  check(S, label + ': the refund is the claimant\'s own credential for the same class and size, issued by the issuer that spent the balance', refund.owner.publicKey === t.bob && refund.asset.class === t.bobClass && refund.quantity === t.bobQty && refund.issuer.domain === X.domain, refund);
  const rx = revokedIds(X);
  check(S, label + ': the refund is live', !rx.has(refund.id));
  check(S, label + ': the claimant\'s original balance is spent', rx.has(t.bobBalance.id));
  const newlyRevoked = [...rx].filter((id) => !revokedBeforeX.has(id));
  check(S, label + ': the credit that was never delivered to the poster is revoked, and only it and the original balance', newlyRevoked.length === 2 && newlyRevoked.includes(t.bobBalance.id), newlyRevoked);
  if (res.body.remainder) check(S, label + ': the change from the first leg stays live', !rx.has(res.body.remainder.id) && res.body.remainder.owner.publicKey === t.bob);
  const ry = revokedIds(Y);
  check(S, label + ': the poster\'s balance is untouched', !ry.has(t.aliceIron.id) && [...ry].every((id) => revokedBeforeY.has(id)));
  const notices = ((await mailFor(Y, t.alice, t.aliceIron)).messages || []).filter((m) => m.credentialId === t.aliceIron.id);
  check(S, label + ': the poster was told nothing', notices.length === 0, notices.length);
  check(S, label + ': the listing is still open', await listed(S, t.posted.pendingId));
  check(S, label + ': no journal entry is left behind', api(X).txnEntries().length === 0 && api(Y).txnEntries().length === 0 && api(S).txnEntries().length === 0, [api(X).txnEntries(), api(Y).txnEntries(), api(S).txnEntries()]);
  return refund;
}

// Asking again, in every way a claimant or a wallet can, never refunds twice and never settles the trade.
async function assertNoSecondOutcome(S, X, Y, label, t, refund, claimWith, revokedAfterX, revokedAfterY) {
  const again = await claimWith(t.newId());
  check(S, label + ': a new claim for the same trade does not settle it', !(again.body && again.body.status === 'settled') && again.status >= 400, again);
  check(S, label + ': it returns the same refund', !!(again.body && again.body.refund) && again.body.refund.id === refund.id, again.body);
  const rx = revokedIds(X), ry = revokedIds(Y);
  check(S, label + ': nothing more is revoked or issued', rx.size === revokedAfterX.size && ry.size === revokedAfterY.size, [rx.size, revokedAfterX.size, ry.size, revokedAfterY.size]);
}

async function refused(S, X, Y, status, unique, prefix) {
  const label = (prefix || '') + 'poster\'s issuer refuses with ' + status + (unique ? ' (unique item)' : '');
  const t = await setup(S, X, Y, unique);
  const rxBefore = revokedIds(X), ryBefore = revokedIds(Y);
  Y.proxy.rules[SETTLE] = { status, body: { error: 'refused by test' } };
  const requestId = t.newId();
  const first = await t.claim(requestId);
  const refund = await assertRefunded(S, X, Y, label, t, first, rxBefore, ryBefore);
  if (!refund) return;
  const second = await t.claim(requestId);
  check(S, label + ': the same claim returns the same refund', !!(second.body && second.body.refund) && second.body.refund.id === refund.id, second);
  delete Y.proxy.rules[SETTLE]; // the poster's issuer would now accept the settle
  await assertNoSecondOutcome(S, X, Y, label + ' (poster\'s issuer would now accept)', t, refund, t.claim, revokedIds(X), revokedIds(Y));
}

// The outcome of the second leg is unknown first, then the poster's issuer refuses; the claimant's issuer is stopped while it
// refunds. Asking again finishes the refund.
async function refundInterrupted(S, X, Y, point) {
  const label = 'claimant\'s issuer stopped at ' + point + ' while refunding';
  const t = await setup(S, X, Y, false);
  const rxBefore = revokedIds(X), ryBefore = revokedIds(Y);
  Y.proxy.rules[SETTLE] = 'drop';
  const requestId = t.newId();
  const unknown = await t.claim(requestId);
  check(S, label + ': an unknown outcome refunds nothing', !(unknown.body && unknown.body.refund) && unknown.status >= 400, unknown);
  Y.proxy.rules[SETTLE] = { status: 400, body: { error: 'refused by test' } };
  await X.restart(noSweep({ ATLAS_TEST_CRASH_AT: point }));
  const stopped = await t.claim(requestId);
  check(S, label + ': the claim reports no settlement', !(stopped.body && stopped.body.status === 'settled'), stopped);
  await X.restart(noSweep());
  const resumed = await t.claim(requestId);
  const refund = await assertRefunded(S, X, Y, label, t, resumed, rxBefore, ryBefore);
  if (!refund) return;
  delete Y.proxy.rules[SETTLE];
  await assertNoSecondOutcome(S, X, Y, label, t, refund, t.claim, revokedIds(X), revokedIds(Y));
}

// The claimant's issuer is an older one without the refund endpoint: nothing is lost or duplicated, the claimant is told so,
// and the same claim refunds once that issuer can.
async function olderIssuer(S, X, Y) {
  const label = 'claimant\'s issuer without the refund endpoint';
  const t = await setup(S, X, Y, false);
  const rxBefore = revokedIds(X), ryBefore = revokedIds(Y);
  Y.proxy.rules[SETTLE] = { status: 400, body: { error: 'refused by test' } };
  X.proxy.rules[REFUND] = { status: 404, body: { error: 'not found' } };
  const requestId = t.newId();
  const first = await t.claim(requestId);
  check(S, label + ': the claim is not reported as settled, with no refund yet', first.status >= 400 && !(first.body && first.body.refund) && !(first.body && first.body.status === 'settled'), first);
  check(S, label + ': the claimant is told to contact the operator or ask again', /operator|again/i.test(String(first.body && first.body.error)), first.body);
  check(S, label + ': nothing else changed at the issuers', revokedIds(X).size === rxBefore.size + 1 && revokedIds(Y).size === ryBefore.size, [revokedIds(X).size, rxBefore.size]);
  delete X.proxy.rules[REFUND];
  const later = await t.claim(requestId);
  await assertRefunded(S, X, Y, label + ', once it can', t, later, rxBefore, ryBefore);
}

(async () => {
  // [station, claimant's issuer, poster's issuer]
  const layouts = { node: ['node', 'node', 'node'], php: ['php', 'php', 'php'], mixedA: ['node', 'php', 'node'], mixedB: ['php', 'node', 'php'] };
  const run = WHICH === 'both' ? ['node', 'php', 'mixedA', 'mixedB'] : WHICH === 'mixed' ? ['mixedA', 'mixedB'] : [WHICH];
  let slot = 0;
  for (const name of run) {
    const [sk, xk, yk] = layouts[name];
    const base = 8631 + 10 * slot++;
    let S, X, Y;
    try {
      // Many claims in a short time: the outbound request budgets are raised for the stations, not removed.
      const budget = { ATLAS_OUTBOUND_RATE: '500', ATLAS_OUTBOUND_RATE_ALL: '2000', ATLAS_OUTBOUND_KEY_RATE: '500', ATLAS_OUTBOUND_KEY_RATE_ALL: '2000' };
      S = sk === 'node' ? await startNode(base, { env: budget }) : await startPhp(base, { env: budget });
      X = await fronted(xk, base + 2, base + 1, 0);
      Y = await fronted(yk, base + 4, base + 3);
      fs.writeFileSync(peersFile(S), JSON.stringify({ peers: [X.domain, Y.domain] }));
      fs.writeFileSync(peersFile(X), JSON.stringify({ peers: [S.domain] }));
      fs.writeFileSync(peersFile(Y), JSON.stringify({ peers: [S.domain] }));
      for (const status of [400, 403]) await refused(S, X, Y, status, false);
      await refused(S, X, Y, 400, true);
      await refused(S, S, Y, 400, false, 'claimant\'s balance issued by the station itself, ');
      for (const point of ['txn:journal-written@1', 'revoke:written@1', 'txn:revoked@1', 'txn:journal-removed@1']) await refundInterrupted(S, X, Y, point);
      await olderIssuer(S, X, Y);
    } catch (e) { failures++; console.log('FAIL [' + name + '] ' + (e.stack || e)); } finally {
      for (const be of [S, X, Y]) if (be) be.stop();
    }
  }
  console.log(failures ? failures + ' FAILED' : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
