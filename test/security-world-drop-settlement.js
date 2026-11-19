// Picking up a world drop never loses the item or duplicates it when a request stops part-way, and a claimant who
// asks again after a lost answer receives the same credential. The process is stopped at chosen points
// (ATLAS_TEST_CRASH_AT), restarted, and the same claim is sent again.
//
//   node test/security-world-drop-settlement.js [node|php|both]
//
// Two layouts: the host of the world also issued the item (local claim), and another domain issued it (the host relays
// the claim to the issuer). A stopped process is not power loss; see the note in lib/replacement.php.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const { startNode, startPhp, api } = require('./lib/gen1-issuers');
const { newOwner, proofFor, ownerIntent } = require('./lib/owner-auth');

const WHICH = process.argv.find((a) => ['node', 'php', 'both'].includes(a)) || 'both';
let failures = 0;
function check(be, name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL') + ' [' + be.kind + '] ' + name + (!ok && detail !== undefined ? ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400) : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLASS = 'atlas.trophy.chess';
const RESERVE_SECONDS = 3;
const WORLD = 'world-settlement';

const revokedIds = (be) => { try { return new Set(JSON.parse(fs.readFileSync(be.revFile, 'utf8')).revoked.map((r) => r.id)); } catch (e) { return new Set(); } };
const got = (r) => r && r.status === 200 && r.body && r.body.status === 'claimed' && r.body.credential;

async function issue(issuer, owner) {
  const r = await api(issuer).post('/atlas/asset/issue', { ownerPublicKey: owner, assetClass: CLASS, quantity: 1 });
  if (r.status !== 200) throw new Error('could not issue: ' + JSON.stringify(r.body));
  return r.body;
}
async function dropAt(host, owner, credential) {
  const dropId = 'urn:atlas:worlddrop:' + crypto.randomUUID();
  const payload = { action: 'drop', credentialId: credential.id, world: WORLD, domain: host.domain, dropId, droppedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
  const r = await api(host).post('/atlas/world/drop', { credential, world: WORLD, position: [1, 0, 1], intent: { payload, proof: proofFor(owner, payload) } });
  if (r.status !== 200) throw new Error('could not drop: ' + JSON.stringify(r.body));
  return dropId;
}
function claimAt(host, claimant, dropId) {
  const payload = { action: 'claim', dropId, domain: host.domain, claimedAt: new Date().toISOString() };
  return api(host).post('/atlas/world/drops/claim', { dropId, intent: { payload, proof: proofFor(claimant, payload) } });
}
async function listed(host, dropId) {
  const r = await api(host).get('/atlas/world/drops?world=' + encodeURIComponent(WORLD));
  return !!(r.body && r.body.drops && r.body.drops.some((d) => d.dropId === dropId));
}
const hostEnv = (extra) => Object.assign({ ATLAS_DROP_RESERVE_SECONDS: String(RESERVE_SECONDS), ATLAS_TXN_NO_SWEEP: '1' }, extra);

// Settled exactly once: the answer is the claimant's credential, a repeat returns the same one, the original is revoked
// and the new one live, nothing remains listed, and no journal entry is left on the issuer.
async function assertSettled(be, issuer, label, first, original, claimant, dropId) {
  check(be, label + ': the claim succeeds', !!got(first), first);
  if (!got(first)) return;
  check(be, label + ': the credential belongs to the claimant', first.body.credential.owner.publicKey === claimant, first.body);
  const again = await claimAt(be, claimant, dropId);
  check(be, label + ': asking again returns the same credential', !!got(again) && again.body.credential.id === first.body.credential.id, again);
  const revoked = revokedIds(issuer);
  check(be, label + ': the original is revoked and the new credential live', revoked.has(original.id) && !revoked.has(first.body.credential.id), { old: revoked.has(original.id), new: revoked.has(first.body.credential.id) });
  check(be, label + ': nothing is listed any more', !(await listed(be, dropId)));
  check(be, label + ': no journal entry is left on the issuer', api(issuer).txnEntries().length === 0, api(issuer).txnEntries());
}

// The host also issued the item.
async function local(be) {
  for (const point of ['drop:reserved', 'txn:journal-written', 'revoke:written', 'txn:revoked', 'txn:replay-stored', 'txn:journal-removed']) {
    const alice = newOwner(), bob = newOwner(), carol = newOwner();
    const original = await issue(be, alice);
    const dropId = await dropAt(be, alice, original);
    const label = 'local claim stopped at ' + point;
    await be.restart(hostEnv({ ATLAS_TEST_CRASH_AT: point }));
    const first = await claimAt(be, bob, dropId);
    check(be, label + ': no credential was returned', !got(first), first);
    await be.restart(hostEnv());
    const rival = await claimAt(be, carol, dropId);
    check(be, label + ': another claimant is not given the item while the claim is pending', !got(rival), rival);
    const retry = await claimAt(be, bob, dropId);
    await assertSettled(be, be, label, retry, original, bob, dropId);
    const late = await claimAt(be, carol, dropId);
    check(be, label + ': a later claimant finds it gone', !got(late) && late.status >= 400, late);
  }

  // A claim that never reached settlement frees the item once its reservation lapses.
  {
    const alice = newOwner(), bob = newOwner(), carol = newOwner();
    const original = await issue(be, alice);
    const dropId = await dropAt(be, alice, original);
    await be.restart(hostEnv({ ATLAS_TEST_CRASH_AT: 'drop:reserved' }));
    await claimAt(be, bob, dropId);
    await be.restart(hostEnv());
    check(be, 'an abandoned reservation leaves the item listed', await listed(be, dropId));
    await sleep((RESERVE_SECONDS + 1) * 1000);
    const takeover = await claimAt(be, carol, dropId);
    check(be, 'after the reservation lapses another claimant can pick it up', !!got(takeover) && takeover.body.credential.owner.publicKey === carol, takeover);
    const loser = await claimAt(be, bob, dropId);
    check(be, 'the first claimant then finds it gone', !got(loser) && loser.status >= 400, loser);
  }

  // A stale reservation never hands an item to a second claimant once the first claim has already committed.
  {
    const alice = newOwner(), bob = newOwner(), carol = newOwner();
    const original = await issue(be, alice);
    const dropId = await dropAt(be, alice, original);
    await be.restart(hostEnv({ ATLAS_TEST_CRASH_AT: 'txn:revoked' }));
    await claimAt(be, bob, dropId);
    await be.restart(hostEnv());
    await sleep((RESERVE_SECONDS + 1) * 1000);
    const takeover = await claimAt(be, carol, dropId);
    check(be, 'a lapsed reservation does not give a committed item to a second claimant', !got(takeover), takeover);
    await sleep((RESERVE_SECONDS + 1) * 1000);
    const retry = await claimAt(be, bob, dropId);
    check(be, 'the first claimant still receives it', !!got(retry) && retry.body.credential.owner.publicKey === bob, retry);
    check(be, 'exactly one live credential remains', !!got(retry) && !revokedIds(be).has(retry.body.credential.id) && revokedIds(be).has(original.id));
  }

  // The dropper may take the item back by the same path, and a refused claim leaves nothing stranded.
  {
    const alice = newOwner();
    const original = await issue(be, alice);
    const dropId = await dropAt(be, alice, original);
    await be.restart(hostEnv());
    const back = await claimAt(be, alice, dropId);
    check(be, 'the dropper can pick the item up again', !!got(back) && back.body.credential.owner.publicKey === alice, back);
  }
}

// Another domain (issuer) issued the item; the host relays the claim.
async function crossDomain(issuer, host) {
  const be = host;
  const alice = newOwner(), bob = newOwner(), carol = newOwner();
  const scenarios = [
    ['the issuer stopped before revoking', issuer, 'txn:journal-written'],
    ['the issuer stopped after revoking', issuer, 'txn:revoked'],
    ['the issuer stopped before answering', issuer, 'txn:journal-removed'],
    ['the host stopped after reserving', host, 'drop:reserved']
  ];
  for (const [what, target, point] of scenarios) {
    const original = await issue(issuer, alice);
    const dropId = await dropAt(host, alice, original);
    const label = 'relayed claim, ' + what;
    await issuer.restart(hostEnv(target === issuer ? { ATLAS_TEST_CRASH_AT: point } : {}));
    await host.restart(hostEnv(target === host ? { ATLAS_TEST_CRASH_AT: point } : {}));
    const first = await claimAt(host, bob, dropId);
    check(be, label + ': no credential was returned', !got(first), first);
    check(be, label + ': the item is not given to another claimant meanwhile', !got(await claimAt(host, carol, dropId)));
    await issuer.restart(hostEnv());
    await host.restart(hostEnv());
    const retry = await claimAt(host, bob, dropId);
    await assertSettled(be, issuer, label, retry, original, bob, dropId);
    if (got(retry)) check(be, label + ': the new credential is still issued by the issuer', retry.body.credential.issuer.domain === issuer.domain, retry.body.credential.issuer);
  }

  // The issuer cannot be reached: the item stays listed and the same claim works once it is back.
  {
    const original = await issue(issuer, alice);
    const dropId = await dropAt(host, alice, original);
    issuer.proc.removeAllListeners('exit'); issuer.proc.kill(); await sleep(400);
    const down = await claimAt(host, bob, dropId);
    check(be, 'issuer unreachable: the claim fails cleanly', !got(down) && down.status >= 400, down);
    check(be, 'issuer unreachable: the item is still listed', await listed(host, dropId));
    await issuer.start(hostEnv());
    const retry = await claimAt(host, bob, dropId);
    await assertSettled(be, issuer, 'issuer unreachable, then back', retry, original, bob, dropId);
  }

  // An issuer that rejects the claim for good (the credential was spent elsewhere) leaves no stuck listing.
  {
    const original = await issue(issuer, alice);
    const dropId = await dropAt(host, alice, original);
    const away = newOwner();
    const moved = await api(issuer).post('/atlas/asset/transfer', { credential: original, recipientPublicKey: away, intent: ownerIntent(alice, 'transfer', { credentialId: original.id, recipientPublicKey: away }) });
    check(be, 'the owner spent it elsewhere first', moved.status === 200, moved);
    const spent = await claimAt(host, bob, dropId);
    check(be, 'a spent credential cannot be claimed', !got(spent), spent);
    check(be, 'and its listing does not linger', !(await listed(host, dropId)));
  }
}

(async () => {
  const kinds = WHICH === 'both' ? ['node', 'php'] : [WHICH];
  for (const kind of kinds) {
    const start = kind === 'node' ? (p) => startNode(p, { env: hostEnv() }) : (p, o) => startPhp(p, Object.assign({ env: hostEnv() }, o));
    const base = kind === 'node' ? 8581 : 8591;
    const solo = await start(base, { workers: 0 });
    try { await local(solo); } catch (e) { failures++; console.log('FAIL [' + kind + '] local: ' + (e.stack || e)); } finally { solo.stop(); }
    // The issuer runs one worker at a time (so a stopped request is the only one in flight); the host keeps several, as
    // a relayed claim makes the issuer call back for the host's key.
    const issuer = await start(base + 1, { workers: 0 });
    const host = await start(base + 2);
    try { await crossDomain(issuer, host); } catch (e) { failures++; console.log('FAIL [' + kind + '] relayed: ' + (e.stack || e)); } finally { issuer.stop(); host.stop(); }
  }
  console.log(failures ? failures + ' FAILED' : 'ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
