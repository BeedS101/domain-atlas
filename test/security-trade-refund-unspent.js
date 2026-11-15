// A refund of the first leg of a cross-domain trade must never create value: the credit it takes back from the poster has to
// still stand. A trusted peer that is faulty or hostile, or merely late, asks the claimant's issuer to refund after the
// poster already spent, split, consolidated, transferred or had that credit revoked; the issuer must refuse and mint nothing.
//
//   node test/security-trade-refund-unspent.js [node|php|both]
//
// One throw-away issuer X (the claimant's) and a fake trusted peer P that signs attestations with its own published key, as a
// real station does. For each case the value that is live across every credential the test knows about is counted: it must be
// the original balance, never more.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { startNode, startPhp, api } = require('./lib/gen1-issuers');
const { newOwner } = require('./lib/owner-auth');

const WHICH = process.argv.find((a) => ['node', 'php', 'both'].includes(a)) || 'both';
const CLASS = 'atlas.element.gold';
let failures = 0;
function check(be, name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL') + ' [' + be.kind + '] ' + name + (!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''));
}
function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}
const revokedIds = (be) => { try { return new Set(JSON.parse(fs.readFileSync(be.revFile, 'utf8')).revoked.map((r) => r.id)); } catch (e) { return new Set(); } };
const noSweep = (extra) => Object.assign({ ATLAS_TXN_NO_SWEEP: '1' }, extra);
const peersFile = (be) => (be.kind === 'php' ? path.join(be.bundle, 'lib', 'atlas-trusted-trade-peers-store.json') : path.join(be.state, 'atlas-trusted-trade-peers-store.json'));
const newId = () => crypto.randomBytes(18).toString('base64url');
const BUDGET = { ATLAS_OUTBOUND_RATE: '500', ATLAS_OUTBOUND_RATE_ALL: '2000', ATLAS_OUTBOUND_KEY_RATE: '500', ATLAS_OUTBOUND_KEY_RATE_ALL: '2000' };

// A peer domain that publishes a key and signs attestations with it. Its own key is the only thing X ever checks.
async function startPeer(host, port) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
  const keyDoc = { keys: [{ publicKey: raw, validFrom: new Date(Date.now() - 86400000).toISOString() }] };
  const server = http.createServer((req, res) => {
    if (req.url.split('?')[0] === '/.well-known/atlas-key.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(keyDoc)); }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  const sign = (att, key) => crypto.sign('sha256', Buffer.from(canonicalize(att)), { key: key || privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return { domain: host + ':' + port, sign, stop: () => { server.close(); server.closeAllConnections && server.closeAllConnections(); } };
}

async function issue(X, owner, quantity) {
  const r = await api(X).post('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: CLASS, quantity });
  if (r.status !== 200) throw new Error('could not issue: ' + JSON.stringify(r.body));
  return r.body;
}
const relay = (X, P, endpoint, credential, fields, opts) => {
  opts = opts || {};
  const attestation = Object.assign({ relayingDomain: opts.relayingDomain || P.domain, tradeId: opts.tradeId, credentialId: credential.id }, fields || {});
  return api(X).post('/atlas/trade/' + endpoint, { credential, attestation, attestationSignature: opts.signature || P.sign(attestation, opts.key) });
};

// Bob holds 10 gold at X. The first leg of a trade spends 5 of it for alice, as a station's claim does, which mints alice a
// 5-gold credit and bob 5 gold change. `known` collects every credential the test learns of, so live value can be counted.
async function firstLeg(X, P) {
  const alice = newOwner(), bob = newOwner();
  const balance = await issue(X, bob, 10);
  const tradeId = newId();
  const exp = new Date(Date.now() + 10 * 60000).toISOString();
  const lock = await relay(X, P, 'relay-lock', balance, { expiresAt: exp }, { tradeId });
  if (lock.status !== 200) throw new Error('relay-lock refused: ' + JSON.stringify(lock.body));
  const settle = await relay(X, P, 'relay-settle', balance, { spendQuantity: 5, newOwnerPublicKey: alice }, { tradeId });
  if (settle.status !== 200) throw new Error('relay-settle refused: ' + JSON.stringify(settle.body));
  const t = { alice, bob, balance, tradeId, received: settle.body.received, remainder: settle.body.remainder, known: [balance, settle.body.received, settle.body.remainder].filter(Boolean) };
  t.refund = (opts) => relay(X, P, 'relay-refund', balance, null, Object.assign({ tradeId }, opts));
  return t;
}
// Value that stands across the credentials the test knows of.
const live = (X, t) => { const rev = revokedIds(X); return t.known.filter((c) => !rev.has(c.id)).reduce((n, c) => n + c.quantity, 0); };
const learn = (t, ...creds) => { for (const c of creds) if (c && c.id && !t.known.some((k) => k.id === c.id)) t.known.push(c); };

// What every refused refund must leave behind: the claimant's issuer answered with an error and no credential, minted and
// revoked nothing, and left no journal entry.
function assertRefused(X, label, t, res, revokedBefore, expectStatus) {
  check(X, label + ': the refund is refused (' + (expectStatus || 409) + ')', res.status === (expectStatus || 409) && !(res.body && res.body.refund), res);
  const after = revokedIds(X);
  check(X, label + ': nothing more is revoked', after.size === revokedBefore.size && [...after].every((id) => revokedBefore.has(id)), [after.size, revokedBefore.size]);
  check(X, label + ': no value was created', live(X, t) === (t.expectLive || 10), live(X, t));
  check(X, label + ': no journal entry is left behind', api(X).txnEntries().length === 0, api(X).txnEntries());
}

// The poster spends the credit in some way, then the peer asks for a refund anyway.
async function spentThenRefund(X, P, label, spend) {
  const t = await firstLeg(X, P);
  check(X, label + ': before the spend the credit and the change stand', live(X, t) === 10 && !revokedIds(X).has(t.received.id));
  await spend(t);
  const before = revokedIds(X);
  check(X, label + ': the poster\'s credit is gone', before.has(t.received.id));
  assertRefused(X, label, t, await t.refund(), before);
  assertRefused(X, label + ' (asked again)', t, await t.refund(), before);
}

const spends = {
  'the poster split it': async (X, t) => {
    const r = await api(X).post('/atlas/asset/split', { credential: t.received, sendAmount: 2, toPublicKey: newOwner() });
    if (r.status !== 200) throw new Error('split refused: ' + JSON.stringify(r.body));
    learn(t, r.body.sent, r.body.remainder);
  },
  'the poster sent all of it to someone else': async (X, t) => {
    const r = await api(X).post('/atlas/asset/split', { credential: t.received, sendAmount: t.received.quantity, toPublicKey: newOwner() });
    if (r.status !== 200) throw new Error('split refused: ' + JSON.stringify(r.body));
    learn(t, r.body.sent, r.body.remainder);
  },
  'the poster consolidated it with another balance': async (X, t) => {
    const other = await issue(X, t.alice, 3);
    const r = await api(X).post('/atlas/asset/consolidate', { credentials: [t.received, other] });
    if (r.status !== 200) throw new Error('consolidate refused: ' + JSON.stringify(r.body));
    learn(t, r.body);
    t.expectLive = 13; // the poster's own 3 gold joined the credit
  },
  'the credit was revoked by the issuer': async (X, t) => {
    const doc = JSON.parse(fs.readFileSync(X.revFile, 'utf8'));
    doc.revoked.push({ id: t.received.id, revokedAt: new Date().toISOString(), reason: 'revoked by the issuer' });
    fs.writeFileSync(X.revFile, X.revLayout(doc));
    t.expectLive = 5; // the 5 gold of the credit are out of circulation; only the claimant's change stands
  }
};

// A faithful refund still works, and asking again returns the same credential without revoking or minting anything more.
async function baseline(X, P) {
  const label = 'untouched credit';
  const t = await firstLeg(X, P);
  const first = await t.refund();
  check(X, label + ': the claimant is refunded', first.status === 200 && first.body.status === 'refunded' && first.body.refund && first.body.refund.owner.publicKey === t.bob && first.body.refund.quantity === 5 && first.body.refund.asset.class === CLASS, first);
  if (!first.body.refund) return;
  learn(t, first.body.refund);
  check(X, label + ': the credit that was never delivered is revoked and the refund stands', revokedIds(X).has(t.received.id) && !revokedIds(X).has(first.body.refund.id));
  check(X, label + ': value is conserved', live(X, t) === 10, live(X, t));
  const after = revokedIds(X);
  const again = await t.refund();
  check(X, label + ': an identical refund request replays the same credential', again.status === 200 && again.body.refund && again.body.refund.id === first.body.refund.id, again);
  check(X, label + ': the replay changes nothing', revokedIds(X).size === after.size && live(X, t) === 10);
  check(X, label + ': no journal entry is left behind', api(X).txnEntries().length === 0);
  // The credit is revoked now; the poster cannot spend it, and nothing but the one refund exists.
  const late = await api(X).post('/atlas/asset/split', { credential: t.received, sendAmount: 1, toPublicKey: newOwner() });
  check(X, label + ': the revoked credit can no longer be spent', late.status >= 400, late);
}

// Requests a peer should never get through, none of which may touch value.
async function hostileRequests(X, P, other) {
  const t = await firstLeg(X, P);
  const before = revokedIds(X);
  const label = 'hostile request';
  assertRefused(X, label + ' - attestation signed by a key that is not the peer\'s', t, await t.refund({ key: other.key }), before, 400);
  assertRefused(X, label + ' - attestation with a bad signature', t, await t.refund({ signature: P.sign({ x: 1 }) }), before, 400);
  assertRefused(X, label + ' - relayed in the name of a domain that is not trusted', t, await t.refund({ relayingDomain: other.domain }), before, 403);
  assertRefused(X, label + ' - a trade this domain never settled', t, await t.refund({ tradeId: newId() }), before, 400);
  const forged = Object.assign({}, t.balance, { quantity: 100 });
  assertRefused(X, label + ' - a balance whose size was changed', t, await relay(X, P, 'relay-refund', forged, null, { tradeId: t.tradeId }), before, 400);
  // A balance spent in the ordinary way, with no trade leg recorded for it, is not refundable either.
  const plain = await issue(X, t.bob, 4);
  const spent = await api(X).post('/atlas/asset/split', { credential: plain, sendAmount: 1, toPublicKey: newOwner() });
  const beforePlain = revokedIds(X);
  const res = await relay(X, P, 'relay-refund', plain, null, { tradeId: newId() });
  check(X, label + ' - a balance spent outside any trade: refused, nothing minted or revoked', spent.status === 200 && res.status === 400 && !(res.body && res.body.refund) && revokedIds(X).size === beforePlain.size, res);
  // The one genuine request, after all of that, still refunds exactly once.
  const good = await t.refund();
  check(X, label + ' - the genuine request afterwards still refunds', good.status === 200 && good.body.refund && good.body.refund.quantity === 5, good);
  learn(t, good.body.refund);
  check(X, label + ' - value is conserved', live(X, t) === 10, live(X, t));
}

// The poster's spend and the peer's refund arrive together. Whichever wins, the value exists once.
async function race(X, P, rounds) {
  let spendWon = 0, refundWon = 0;
  for (let i = 0; i < rounds; i++) {
    const t = await firstLeg(X, P);
    const to = newOwner();
    // The request that goes first alternates and the other follows within a few milliseconds, so each can win.
    const lag = (i * 3) % 14, wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const [sp, rf] = await Promise.all([
      wait(i % 2 ? lag : 0).then(() => api(X).post('/atlas/asset/split', { credential: t.received, sendAmount: 5, toPublicKey: to })),
      wait(i % 2 ? 0 : lag).then(() => t.refund())
    ]);
    if (sp.status === 200) learn(t, sp.body.sent, sp.body.remainder);
    if (rf.status === 200 && rf.body.refund) learn(t, rf.body.refund);
    const spent = sp.status === 200, refunded = rf.status === 200 && !!(rf.body && rf.body.refund);
    spendWon += spent ? 1 : 0; refundWon += refunded ? 1 : 0;
    check(X, 'race ' + (i + 1) + ': exactly one of the spend and the refund succeeded (' + (spent ? 'spend' : '') + (refunded ? 'refund' : '') + ')', spent !== refunded, [sp.status, sp.body, rf.status, rf.body]);
    check(X, 'race ' + (i + 1) + ': value exists exactly once', live(X, t) === 10, live(X, t));
    check(X, 'race ' + (i + 1) + ': no journal entry is left behind', api(X).txnEntries().length === 0, api(X).txnEntries());
    // A later identical refund agrees with whoever won.
    const later = await t.refund();
    check(X, 'race ' + (i + 1) + ': asking again gives the same answer as the first time', spent ? (later.status === 409 && !later.body.refund) : (later.status === 200 && later.body.refund && later.body.refund.id === rf.body.refund.id), later);
  }
  console.log('INFO [' + X.kind + '] race outcomes: spend won ' + spendWon + ', refund won ' + refundWon);
}

// The issuer stops while it refunds. The poster spends the credit, or the refund had already committed; asking again never
// pays twice.
async function crashes(X, P, restartWith) {
  {
    const label = 'stopped before the refund committed, the poster then spends';
    const t = await firstLeg(X, P);
    await restartWith(noSweep({ ATLAS_TEST_CRASH_AT: 'txn:journal-written@1' }));
    const dead = await t.refund();
    check(X, label + ': the interrupted refund is not an answer', !(dead.body && dead.body.refund), dead);
    await restartWith(noSweep());
    const sp = await api(X).post('/atlas/asset/split', { credential: t.received, sendAmount: 2, toPublicKey: newOwner() });
    check(X, label + ': the poster can still spend the credit', sp.status === 200, sp);
    if (sp.status === 200) learn(t, sp.body.sent, sp.body.remainder);
    const before = revokedIds(X);
    const res = await t.refund();
    assertRefused(X, label + ' - the refund asked again', t, res, before);
  }
  for (const point of ['txn:revoked@1', 'revoke:written@1', 'txn:journal-removed@1']) {
    const label = 'stopped at ' + point + ' while refunding';
    const t = await firstLeg(X, P);
    await restartWith(noSweep({ ATLAS_TEST_CRASH_AT: point }));
    await t.refund();
    await restartWith(noSweep());
    const done = await t.refund();
    check(X, label + ': asking again finishes the same refund', done.status === 200 && done.body.refund && done.body.refund.quantity === 5, done);
    if (!done.body.refund) continue;
    learn(t, done.body.refund);
    check(X, label + ': value exists once', live(X, t) === 10, live(X, t));
    const after = revokedIds(X);
    const again = await t.refund();
    check(X, label + ': asking once more replays it', again.status === 200 && again.body.refund.id === done.body.refund.id && revokedIds(X).size === after.size, again);
    const late = await api(X).post('/atlas/asset/split', { credential: t.received, sendAmount: 1, toPublicKey: newOwner() });
    check(X, label + ': the credit that was taken back cannot be spent', late.status >= 400, late);
    check(X, label + ': no journal entry is left behind', api(X).txnEntries().length === 0, api(X).txnEntries());
  }
}

(async () => {
  const run = WHICH === 'both' ? ['node', 'php'] : [WHICH];
  let slot = 0;
  for (const kind of run) {
    const base = 8731 + 6 * slot++;
    let X, X2, P, other;
    try {
      const host = kind === 'node' ? 'localhost' : '127.0.0.1';
      X = kind === 'node' ? await startNode(base, { env: BUDGET }) : await startPhp(base, { env: BUDGET, workers: 8 });
      P = await startPeer(host, base + 1);
      const stranger = await startPeer(host, base + 2);
      other = { domain: stranger.domain, key: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey };
      fs.writeFileSync(peersFile(X), JSON.stringify({ peers: [P.domain] }));
      const env = Object.assign({}, BUDGET, { ATLAS_MINT_LIMITS: 'off', ATLAS_PRIVATE_MINT: 'off' });
      await baseline(X, P);
      for (const name of Object.keys(spends)) await spentThenRefund(X, P, name, (t) => spends[name](X, t));
      await hostileRequests(X, P, other);
      await race(X, P, 10);
      // A crash point ends one PHP script, so the crash cases run on an issuer without worker processes.
      X2 = kind === 'node' ? await startNode(base + 3, { env: BUDGET }) : await startPhp(base + 3, { env: BUDGET, workers: 0 });
      fs.writeFileSync(peersFile(X2), JSON.stringify({ peers: [P.domain] }));
      await crashes(X2, P, (extra) => X2.restart(Object.assign({}, env, extra)));
      stranger.stop();
    } catch (e) { failures++; console.log('FAIL [' + kind + '] ' + (e.stack || e)); } finally {
      if (P) P.stop();
      if (X) X.stop();
      if (X2) X2.stop();
      // PHP's worker processes outlive the server that forked them and keep its port.
      if (kind === 'php') require('child_process').spawnSync('pkill', ['-f', 'php -S 127.0.0.1:' + base]);
      if (kind === 'php') require('child_process').spawnSync('pkill', ['-f', 'php -S 127.0.0.1:' + (base + 3)]);
    }
  }
  console.log(failures ? failures + ' FAILED' : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
