// Outbound request budgets: one caller, or one kind of operation, must not be able to use up what other callers and
// other operations need. A stranger can make an issuer fetch another domain's published documents without signing in
// (presenting a credential that names that domain as its issuer), so every budget shared by all callers is a lever on
// the rest of the issuer's cross-domain work: key lookups for relayed claims and mail, revocation checks, trade and
// world-drop relays.
//
//   host   the issuer under test, with small budgets
//   attacker  loopback addresses 127.0.0.2, 127.0.0.10 ... (the issuer keys callers by the socket address)
//   legit     127.0.0.3, doing ordinary cross-domain work
//   peers     throw-away local servers; nothing leaves this machine
//
// Run: STACK=node node test/security-outbound-isolation.js   (or STACK=php)
'use strict';
const http = require('http');
const crypto = require('crypto');
const S = require('./support/issuer-stack');

const STACK = process.env.STACK || 'node';
const BASE = STACK === 'php' ? 8640 : 8620;
const COUNTER_BASE = STACK === 'php' ? 9460 : 9400;
const MIN = 60 * 1000;
const ATTACKER = '127.0.0.2', LEGIT = '127.0.0.3';
const MANY = Array.from({ length: 8 }, (_, i) => '127.0.0.' + (10 + i));
// Small budgets so the scenarios are quick: per-domain key 20, overall key 40, per-domain other 20, overall other 60.
const BUDGETS = { ATLAS_OUTBOUND_KEY_RATE: '20', ATLAS_OUTBOUND_KEY_RATE_ALL: '40', ATLAS_OUTBOUND_RATE: '20', ATLAS_OUTBOUND_RATE_ALL: '60' };

let failures = 0;
function check(name, ok, detail) {
  if (ok) console.log('PASS ' + name);
  else { failures++; console.log('FAIL ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 300))); }
}
const uuid = () => crypto.randomUUID();
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (issuer) => ({ port: Number(issuer.domain.split(':')[1]), domain: issuer.domain });

// A request from a chosen loopback address, so the issuer sees a different caller.
function post(from, issuer, path, body) {
  const { port, domain } = hostOf(issuer);
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST', localAddress: from, agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Host: domain }
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { let json = {}; try { json = JSON.parse(text); } catch (e) { json = { raw: text }; } resolve({ status: res.statusCode, body: json }); });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// Many throw-away servers, each its own domain (host:port), counting what is asked of them.
async function startCounters(first, n) {
  const hits = { key: 0, docs: 0 };
  const servers = [];
  for (let i = 0; i < n; i++) {
    const server = http.createServer((req, res) => {
      // Real-looking documents, so a verification goes on to ask for the revocation and suspension lists too.
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url.startsWith('/.well-known/atlas-key.json')) { hits.key++; return res.end(JSON.stringify({ keys: [{ publicKey: 'AAAA', validFrom: '2020-01-01T00:00:00Z' }] })); }
      hits.docs++;
      res.end(JSON.stringify(req.url.includes('suspensions') ? { suspended: [] } : { revoked: [] }));
    });
    await new Promise((ok) => server.listen(first + i, '127.0.0.1', ok));
    servers.push(server);
  }
  return { hits, domains: servers.map((_, i) => 'localhost:' + (first + i)), stop() { servers.forEach((s) => { s.closeAllConnections && s.closeAllConnections(); s.close(); }); } };
}

const newDropId = () => 'urn:atlas:worlddrop:' + uuid();
async function issue(issuer, owner, cls) {
  const r = await S.post(issuer.base, '/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: cls || 'atlas.trophy.chess' });
  if (r.status !== 200) throw new Error('issue failed: ' + JSON.stringify(r.body));
  return r.body;
}
async function ownerIntent(hostDomain, owner, credential, world, dropId) {
  const now = Date.now();
  const payload = { action: 'drop', credentialId: credential.id, world, domain: hostDomain, dropId, droppedAt: iso(now), expiresAt: iso(now + 10 * MIN) };
  return { payload, proof: await S.signPayload(owner, payload) };
}

// What an abusive visitor sends: a credential that merely names `target` as its issuer, with an intent signed by a key
// the visitor just made. It needs no account and no minted asset, and makes the host look `target` up before it can
// say the credential is not genuine.
async function forgedDrop(from, host, target, world) {
  const who = await S.generateIdentity();
  const credential = {
    credential: 'domain-atlas-asset/1.0', id: 'urn:atlas:asset:' + uuid(),
    asset: { name: 'Fake', class: 'atlas.trophy.chess', fungible: false, tradeScope: 'local' },
    owner: { publicKey: who.publicKey }, quantity: 1, supersedes: null, issuedAt: iso(Date.now()),
    issuer: { domain: target, publicKey: who.publicKey }, signature: 'AAAA'
  };
  const intent = await ownerIntent(host.domain, who, credential, world, newDropId());
  return post(from, host, '/atlas/world/drop', { credential, world, position: [0, 0, 0], intent });
}
const limited = (r) => /too many requests/i.test(JSON.stringify(r.body));

// A genuine drop of an item issued by the standing-in issuer `peer`, made by `from`.
async function legitDrop(from, host, peer, world) {
  const owner = await S.generateIdentity();
  const credential = await peer.issue(owner);
  const dropId = newDropId();
  const intent = await ownerIntent(host.domain, owner, credential, world, dropId);
  const res = await post(from, host, '/atlas/world/drop', { credential, world, position: [1, 0, 1], intent });
  return { res, dropId, owner, credential };
}
async function claim(from, host, claimant, dropId) {
  const payload = { action: 'claim', dropId, domain: host.domain, claimedAt: iso(Date.now()) };
  return post(from, host, '/atlas/world/drops/claim', { dropId, intent: { payload, proof: await S.signPayload(claimant, payload) } });
}
// A relayed claim of an item `host` issued, vouched for by `relayer` (a federated domain `host` has never looked up).
async function legitRelay(from, host, relayer, world) {
  const owner = await S.generateIdentity(), claimant = await S.generateIdentity();
  const credential = await issue(host, owner);
  const dropId = newDropId();
  const dropIntent = await ownerIntent(relayer.domain, owner, credential, world, dropId);
  const attestation = { relayingDomain: relayer.domain, world, dropId, credentialId: credential.id, claimantPublicKey: claimant.publicKey };
  const claimPayload = { action: 'claim', dropId, domain: relayer.domain, claimedAt: iso(Date.now()) };
  return post(from, host, '/atlas/world/drops/relay-claim', {
    credential, attestation, attestationSignature: await S.signDetached(relayer.identity, attestation), dropIntent,
    claimIntent: { payload: claimPayload, proof: await S.signPayload(claimant, claimPayload) }
  });
}
const relayed = (r) => r.status === 200 && !!(r.body && r.body.credential);
const reachedRelay = (peer) => peer.state.hits.filter((u) => u.startsWith('/atlas/world/drops/relay-claim')).length;
async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

(async () => {
  const counters = await startCounters(COUNTER_BASE, 60);
  const instances = [];
  const start = async (port, env) => { const s = await S.startIssuer(STACK, port, env); instances.push(s); return s; };
  const standIns = [];
  const standIn = async (port) => { const s = await S.startStandInIssuer(port); standIns.push(s); return s; };
  try {
    console.log('--- A: made-up domains cannot use up the key lookups other callers need ---');
    {
      const H = await start(BASE, BUDGETS);
      const P = await standIn(BASE + 20);
      const results = await inBatches(counters.domains.slice(0, 50), 10, (d) => forgedDrop(ATTACKER, H, d, 'wA'));
      const refused = results.filter(limited).length;
      check('the abusive caller is stopped by a limit well before it has made fifty lookups', refused > 0, results.map((r) => r.status));
      check('it could not use the whole overall key budget (a slice stays free for others)', counters.hits.key < 40, counters.hits.key);
      const legit = await legitRelay(LEGIT, H, P, 'wA');
      check('a different caller\'s first-time lookup of a federated domain still works', relayed(legit), legit);
    }

    console.log('--- B: probing one peer cannot stop relays to that peer, and cannot stop others verifying its credentials ---');
    {
      const H = await start(BASE + 1, BUDGETS);
      const I = await standIn(BASE + 21);
      const placed = await legitDrop(LEGIT, H, I, 'wB');
      check('setup: a genuine item issued by the peer is dropped on the host', placed.res.status === 200, placed.res);
      const flood = await inBatches(Array.from({ length: 40 }), 10, () => forgedDrop(ATTACKER, H, I.domain, 'wB'));
      check('the abusive caller is eventually refused', flood.some(limited), flood.map((r) => r.status));
      const before = reachedRelay(I);
      const taker = await S.generateIdentity();
      await claim(LEGIT, H, taker, placed.dropId);
      check('a pick-up that must be relayed to that peer still reaches it', reachedRelay(I) === before + 1, { before, after: reachedRelay(I) });
      const second = await legitDrop(LEGIT, H, I, 'wB');
      check('a different caller can still have a credential from that peer verified', second.res.status === 200, second.res);
    }

    console.log('--- C: an abusive caller that has used its share cannot take the last of any budget ---');
    {
      const H = await start(BASE + 2, BUDGETS);
      const I = await standIn(BASE + 22);
      const flood = await inBatches(Array.from({ length: 40 }), 10, () => forgedDrop(ATTACKER, H, I.domain, 'wC'));
      const served = flood.filter((r) => !limited(r)).length;
      check('the abusive caller is served for a while, then refused', served > 0 && served < 40, served);
      const again = await forgedDrop(ATTACKER, H, I.domain, 'wC');
      check('and stays refused', limited(again), again);
      const legit = await legitDrop(LEGIT, H, I, 'wC');
      check('while another caller is served as usual', legit.res.status === 200, legit.res);
    }

    console.log('--- D: the overall cap still bounds total outbound traffic, however many callers there are ---');
    {
      const H = await start(BASE + 3, BUDGETS);
      counters.hits.key = 0; counters.hits.docs = 0;
      const jobs = MANY.flatMap((ip, i) => Array.from({ length: 8 }, (_, j) => ({ ip, target: counters.domains[(i * 8 + j) % 60] })));
      await inBatches(jobs, 16, (j) => forgedDrop(j.ip, H, j.target, 'wD'));
      check('key lookups made never exceed the overall key budget', counters.hits.key > 0 && counters.hits.key <= 40, counters.hits.key);
      check('document fetches made never exceed the overall budget', counters.hits.docs <= 60, counters.hits.docs);
    }

    console.log('--- E: one kind of operation cannot take another kind\'s share ---');
    {
      const H = await start(BASE + 4, BUDGETS);
      const I = await standIn(BASE + 24);
      counters.hits.key = 0; counters.hits.docs = 0;
      const placed = await legitDrop(LEGIT, H, I, 'wE');
      check('setup: a genuine item issued by the peer is dropped on the host', placed.res.status === 200, placed.res);
      const jobs = ['127.0.0.2', '127.0.0.4', '127.0.0.5', '127.0.0.6'].flatMap((ip, i) => Array.from({ length: 30 }, (_, j) => ({ ip, target: counters.domains[(i * 30 + j) % 60] })));
      await inBatches(jobs, 20, (j) => forgedDrop(j.ip, H, j.target, 'wE'));
      const before = reachedRelay(I);
      await claim(LEGIT, H, await S.generateIdentity(), placed.dropId);
      check('after four callers flood revocation checks, a world-drop relay to the peer still goes out', reachedRelay(I) === before + 1, { before, after: reachedRelay(I) });
    }

    console.log('--- F: cached and uncached key lookups ---');
    {
      const H = await start(BASE + 5, BUDGETS);
      const P = await standIn(BASE + 25);
      const first = await legitRelay(LEGIT, H, P, 'wF');
      check('a first relayed claim from a federated domain is served', relayed(first), first);
      await inBatches(MANY.flatMap((ip, i) => Array.from({ length: 6 }, (_, j) => ({ ip, target: counters.domains[(i * 6 + j) % 60] }))), 16, (j) => forgedDrop(j.ip, H, j.target, 'wF'));
      const keyHitsBefore = P.state.hits.filter((u) => u.startsWith('/.well-known/atlas-key.json')).length;
      const warm = await legitRelay(LEGIT, H, P, 'wF');
      const keyHitsAfter = P.state.hits.filter((u) => u.startsWith('/.well-known/atlas-key.json')).length;
      check('with every caller flooding, a peer whose key is already remembered is still served', relayed(warm), warm);
      check('and without another lookup of it', keyHitsAfter === keyHitsBefore, { keyHitsBefore, keyHitsAfter });
      const U = await start(BASE + 6, Object.assign({}, BUDGETS, { ATLAS_OUTBOUND_KEY_CACHE_MS: '0' }));
      const Q = await standIn(BASE + 26);
      for (let i = 0; i < 4; i++) await legitRelay(LEGIT, U, Q, 'wF2');
      const lookups = Q.state.hits.filter((u) => u.startsWith('/.well-known/atlas-key.json')).length;
      check('with the memory turned off every claim costs a lookup', lookups === 4, lookups);
    }

    console.log('--- G: simultaneous requests are counted exactly ---');
    {
      const H = await start(BASE + 7, BUDGETS);
      const P = await standIn(BASE + 27);
      counters.hits.key = 0; counters.hits.docs = 0;
      const burst = Array.from({ length: 60 }, (_, i) => forgedDrop(ATTACKER, H, counters.domains[i % 60], 'wG'));
      const legitAtTheSameTime = legitRelay(LEGIT, H, P, 'wG');
      const [outcomes, legit] = [await Promise.all(burst), await legitAtTheSameTime];
      check('sixty simultaneous requests never get more lookups through than the key budget allows', counters.hits.key <= 40, counters.hits.key);
      check('and some are refused', outcomes.some(limited), outcomes.length);
      check('a legitimate request made at the same moment is served', relayed(legit), legit);
    }

    console.log('--- H: the budgets recover when the window passes ---');
    {
      const H = await start(BASE + 8, Object.assign({}, BUDGETS, { ATLAS_OUTBOUND_RATE_WINDOW_MS: '4000' }));
      const flood = await inBatches(Array.from({ length: 50 }, (_, i) => counters.domains[i]), 10, (d) => forgedDrop(ATTACKER, H, d, 'wH'));
      check('the abusive caller is refused while its budget is spent', limited(flood[flood.length - 1]), flood[flood.length - 1]);
      await sleep(4600);
      counters.hits.key = 0;
      const after = await forgedDrop(ATTACKER, H, counters.domains[55], 'wH');
      check('once the window has passed it is served again', !limited(after) && counters.hits.key === 1, { limited: limited(after), keyHits: counters.hits.key });
    }
  } finally {
    instances.forEach((x) => x.stop());
    standIns.forEach((x) => x.stop());
    counters.stop();
  }
  console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
