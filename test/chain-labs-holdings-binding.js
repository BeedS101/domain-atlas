// Holdings statements bound to the request that asked for them (chain-labs/lib/spend.php spend_holdings, extension/chain-labs-wallet.js
// checkHoldings), against live PHP servers running the real endpoint:
//   - a captured statement cannot answer a later request (the replay that was possible before the nonce)
//   - the endpoint: the bound form, the nonce rules, single-use challenges, edited statements
//   - what the wallet accepts, pins and refuses, with explicit clocks around the end of the compatibility period
//   - an old wallet against the new server, and the new wallet against a server that has not been updated
//   - a domain that returned the bound form never goes back to the old one, whatever else it answers
//   - an unanswered transfer is not settled as "not made" on the strength of the old form
//
//   node test/chain-labs-holdings-binding.js
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const S = require('./support/chain-labs-servers');
const { A, B, nodes, wallet, start, post, op, createCoin, canon, b64u } = S;
const Chain = require('../extension/chain-labs-wallet.js');

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : '')); };

const DIR = path.join(__dirname, '..', 'chain-labs');
const UNTIL_MS = Date.UTC(2027, 1, 1);
const beforeEnd = Date.now() < UNTIL_MS;
const pemOf = (n) => Buffer.from(n.pair.publicKey.export({ type: 'spki', format: 'pem' })).toString();
const hex32 = () => crypto.randomBytes(16).toString('hex');

function reach(n, urlPath, init) {
  return new Promise((resolve, reject) => {
    const data = init.body === undefined ? null : init.body;
    const headers = { host: n.domain, origin: 'https://' + n.domain, ...(init.headers || {}) };
    if (data !== null) headers['content-length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port: n.port, path: urlPath, method: init.method || 'GET', headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, text: async () => b }));
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}
function envFor(w, state, over = {}) {
  return {
    fetch: (url, init) => {
      const u = new URL(url);
      const n = Object.values(nodes).find((x) => 'http://' + x.domain === u.origin) || null;
      if (!n) return Promise.reject(new Error('no such host'));
      return reach(n, u.pathname + u.search, init);
    },
    origin: (domain) => 'http://' + domain,
    path: '/spend34.php',
    sign: async (payload) => ({ publicKey: w.key, signature: w.sign(payload) }),
    ownerKey: async () => w.key,
    loadDomains: async () => JSON.parse(JSON.stringify(state.domains)),
    saveDomains: async (list) => { state.domains = JSON.parse(JSON.stringify(list)); },
    loadCache: async () => JSON.parse(JSON.stringify(state.cache)),
    saveCache: async (c) => { state.cache = JSON.parse(JSON.stringify(c)); },
    now: () => Date.now(),
    ...over
  };
}
// A wallet whose answers pass through `hook(url, init, forward)`: a response ({status, json | text}) to use instead, or null to leave the answer alone.
function walletOver(w, state, hook, over = {}) {
  const base = envFor(w, state, over);
  return Chain.create(Object.assign({}, base, {
    fetch: async (url, init) => {
      const forward = () => base.fetch(url, init);
      const out = hook ? await hook(url, init, forward) : null;
      if (!out) return forward();
      return { status: out.status, text: async () => (out.text !== undefined ? out.text : JSON.stringify(out.json)) };
    }
  }));
}
const bodyOf = (init) => { try { return JSON.parse(init.body); } catch (e) { return null; } };

// The server of a domain that has not been updated: it ignores the nonce and answers in the old form, whatever the date.
function oldServer(n) {
  const front = path.join(n.root, 'spend34.php'), lib = path.join(n.root, 'lib', 'spend.php');
  const f = fs.readFileSync(path.join(DIR, 'spend34.php'), 'utf8'), l = fs.readFileSync(path.join(DIR, 'lib', 'spend.php'), 'utf8');
  const f2 = f.replace("$nonce = $m['nonce'] ?? null;", '$nonce = null;');
  const l2 = l.replace(/const SPEND_HOLDINGS_LEGACY_UNTIL = \d+;/, 'const SPEND_HOLDINGS_LEGACY_UNTIL = 9999999999;');
  if (f2 === f || l2 === l) throw new Error('the server files do not have the lines this test rewrites');
  fs.writeFileSync(front, f2);
  fs.writeFileSync(lib, l2);
}
function newServer(n) {
  fs.copyFileSync(path.join(DIR, 'spend34.php'), path.join(n.root, 'spend34.php'));
  fs.copyFileSync(path.join(DIR, 'lib', 'spend.php'), path.join(n.root, 'lib', 'spend.php'));
}

// What a wallet from before the nonce read (the checks of the old wallet, which read only the form with no nonce).
function oldWalletReads(answer, pem, domain, key) {
  const s = answer && answer.statement;
  if (!s || Object.keys(s).sort().join(',') !== 'asOf,coins,domain,key,proven,type,v') return false;
  if (s.type !== 'atlas.ledger.holdings' || s.v !== 1 || s.domain !== domain || s.key !== key) return false;
  return crypto.verify('sha256', Buffer.from(canon(s)), pem, Buffer.from(answer.signature, 'base64url'));
}
const holdingsPost = (n, body) => post(n, 'action=holdings', body);
const challengeOf = async (n) => (await post(n, 'action=challenge', {})).json.challenge;
const signedRequest = (w, domain, challenge) => { const payload = { type: 'atlas.ledger.holdings.request', v: 1, domain, key: w.key, challenge }; return { payload, signature: w.sign(payload) }; };

(async () => {
  for (const n of [nodes[A], nodes[B]]) await start(n);
  const a = nodes[A], b = nodes[B];
  try {
    const alice = wallet(), bob = wallet();
    const sgl = (await createCoin(a, 'SGL')).json;
    await op(a, 'open', { coinId: sgl.id });
    await op(a, 'grant', { coinId: sgl.id, to: alice.key, amount: '5000' });
    const keyA = pemOf(a), keyB = pemOf(b);

    console.log('== the replay that was possible: a captured statement answering a later request');
    const nonce1 = hex32(), nonce2 = hex32();
    const first = (await holdingsPost(a, { key: alice.key, nonce: nonce1 })).json;
    await op(a, 'grant', { coinId: sgl.id, to: alice.key, amount: '1000' });
    const read1 = await Chain.checkHoldings(first, keyA, A, alice.key, Date.now(), false, { nonce: nonce1, pinned: false });
    line(read1.ok === true && read1.bound === true, 'a statement answers the request whose nonce it carries', read1);
    const replay = await Chain.checkHoldings(first, keyA, A, alice.key, Date.now(), false, { nonce: nonce2, pinned: false });
    line(replay.ok === false && replay.reason === 'not-for-this-request', 'the same statement does not answer a later request, though it is signed and recent', replay);
    const fresh2 = (await holdingsPost(a, { key: alice.key, nonce: nonce2 })).json;
    const read2 = await Chain.checkHoldings(fresh2, keyA, A, alice.key, Date.now(), false, { nonce: nonce2, pinned: false });
    line(read2.ok === true && read2.coins[0].units === '6000', 'and the statement made for it carries the new balance', read2);
    line(first.statement.nonce === nonce1 && fresh2.statement.nonce === nonce2 && first.statement.v === 2, 'the statements carry their own nonces in the bound form');

    console.log('\n== the endpoint');
    const ch = await challengeOf(a);
    const reqs = signedRequest(alice, A, ch);
    const mismatch = await holdingsPost(a, { key: alice.key, request: reqs, nonce: hex32() });
    line(mismatch.status === 400 && mismatch.json.code === 'nonce-mismatch', 'a signed lookup whose nonce is not its challenge is refused', mismatch.json);
    const sgd = await holdingsPost(a, { key: alice.key, request: reqs, nonce: ch });
    line(sgd.status === 200 && sgd.json.statement.v === 2 && sgd.json.statement.nonce === ch && sgd.json.statement.proven === true, 'the refusal did not use the challenge up, and the lookup then carries it', sgd.json);
    const again = await holdingsPost(a, { key: alice.key, request: reqs, nonce: ch });
    line(again.status === 401 && again.json.code === 'bad-challenge', 'the same signed request is refused a second time: the challenge is single use', again.json);
    for (const bad of ['abc', 'A'.repeat(32), 'g'.repeat(32), 'a'.repeat(33), '']) {
      const r = await holdingsPost(a, { key: alice.key, nonce: bad });
      if (!(r.status === 400 && r.json.code === 'bad-nonce')) line(false, 'a nonce of ' + JSON.stringify(bad) + ' is refused', r.json);
    }
    line(true, 'malformed nonces are refused as bad-nonce');
    line((await holdingsPost(a, { key: alice.key, nonce: 12345 })).status === 400 && (await holdingsPost(a, { key: alice.key, nonce: [hex32()] })).status === 400, 'so are nonces that are not text');
    const tampered = JSON.parse(JSON.stringify(fresh2));
    tampered.statement.coins[0].units = '9999999';
    const t1 = await Chain.checkHoldings(tampered, keyA, A, alice.key, Date.now(), false, { nonce: nonce2, pinned: false });
    line(t1.ok === false && t1.reason === 'bad-signature', 'an edited balance fails the domain signature', t1);
    const swapped = JSON.parse(JSON.stringify(fresh2));
    swapped.statement.nonce = nonce1;
    const t2 = await Chain.checkHoldings(swapped, keyA, A, alice.key, Date.now(), false, { nonce: nonce1, pinned: false });
    line(t2.ok === false && t2.reason === 'bad-signature', 'an edited nonce fails it too, even when the wallet is told to expect that one', t2);
    const other = await Chain.checkHoldings(fresh2, keyB, A, alice.key, Date.now(), false, { nonce: nonce2, pinned: false });
    line(other.ok === false && other.reason === 'bad-signature', 'a statement signed by another key than the pinned one is refused', other);

    console.log('\n== an old wallet against the updated server');
    const oldPublic = await holdingsPost(a, { key: alice.key, nonce: null });
    const oc = await challengeOf(a);
    const oldSigned = await holdingsPost(a, { key: alice.key, request: signedRequest(alice, A, oc), nonce: null });
    if (beforeEnd) {
      line(oldPublic.status === 200 && oldWalletReads(oldPublic.json, a.pair.publicKey, A, alice.key), 'a lookup with no nonce is answered in the form the old wallet reads', oldPublic.json);
      line(oldSigned.status === 200 && oldSigned.json.statement.proven === true && oldWalletReads(oldSigned.json, a.pair.publicKey, A, alice.key), 'so is a key-signed one', oldSigned.json);
    } else {
      line(oldPublic.status === 400 && oldPublic.json.code === 'nonce-required' && oldSigned.status === 400 && oldSigned.json.code === 'nonce-required', 'a lookup with no nonce is refused as nonce-required: the compatibility period is over', [oldPublic.json, oldSigned.json]);
    }

    console.log('\n== what the wallet accepts, around the end of the compatibility period');
    const signer = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const signerPem = Buffer.from(signer.publicKey.export({ type: 'spki', format: 'pem' })).toString();
    const asOf = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
    const stmt = (ms, over = {}) => Object.assign({ type: 'atlas.ledger.holdings', v: 2, domain: 'x.example', key: alice.key, nonce: nonce1, asOf: asOf(ms), proven: false, coins: [] }, over);
    const signedBy = (s) => ({ statement: s, signature: crypto.sign('sha256', Buffer.from(canon(s)), signer.privateKey).toString('base64url') });
    const check = (answer, nowMs, expect, proven = false) => Chain.checkHoldings(answer, signerPem, 'x.example', alice.key, nowMs, proven, expect);
    const day = 86400000;
    const t0 = UNTIL_MS - 3 * day;
    const legacy = (ms) => { const s = stmt(ms, { v: 1 }); delete s.nonce; return signedBy(s); };
    let r = await check(signedBy(stmt(t0)), t0, { nonce: nonce1, pinned: false });
    line(r.ok === true && r.bound === true, 'the bound form is read', r);
    r = await check(signedBy(stmt(t0, { nonce: nonce2 })), t0, { nonce: nonce1, pinned: false });
    line(r.ok === false && r.reason === 'not-for-this-request', 'a nonce that is not the one sent is refused', r);
    const noNonce = stmt(t0); delete noNonce.nonce;
    r = await check(signedBy(noNonce), t0, { nonce: nonce1, pinned: false });
    line(r.ok === false && r.reason === 'unreadable', 'the bound form without a nonce is refused', r);
    r = await check(signedBy(stmt(t0, { extra: 1 })), t0, { nonce: nonce1, pinned: false });
    line(r.ok === false && r.reason === 'unreadable', 'and with a field it does not know', r);
    r = await check(signedBy(stmt(t0, { nonce: 'short' })), t0, { nonce: 'short', pinned: false });
    line(r.ok === false, 'a nonce that is not 32 hex characters is refused even when it was the one sent', r);
    r = await check(legacy(t0), t0, { nonce: nonce1, pinned: false });
    line(r.ok === true && r.bound === false, 'the old form is read, and marked as not bound, from a domain not known to answer in the bound form', r);
    r = await check(legacy(t0), t0, { nonce: nonce1, pinned: true });
    line(r.ok === false && r.reason === 'downgrade', 'but never from a domain that has answered in the bound form', r);
    r = await check(legacy(UNTIL_MS - 1000), UNTIL_MS - 1000, { nonce: nonce1, pinned: false });
    line(r.ok === true && r.bound === false, 'one second before the end of 31 January 2027 UTC it is still read');
    r = await check(legacy(UNTIL_MS), UNTIL_MS, { nonce: nonce1, pinned: false });
    line(r.ok === false && r.reason === 'legacy-ended', 'from 1 February 2027, 00:00 UTC it is refused, though the domain was never known to answer in the bound form', r);
    r = await check(signedBy(stmt(UNTIL_MS + day)), UNTIL_MS + day, { nonce: nonce1, pinned: false });
    line(r.ok === true && r.bound === true, 'the bound form is read after it too', r);
    r = await check(legacy(t0), t0, undefined);
    line(r.ok === true && r.bound === false, 'a check that names no expectation reads only what an unpinned wallet reads');
    r = await check(signedBy(stmt(t0 - 400000)), t0, { nonce: nonce1, pinned: false });
    line(r.ok === false && r.reason === 'clock', 'a bound statement older than the allowed age is refused', r);
    r = await check(signedBy(stmt(t0, { proven: true })), t0, { nonce: nonce1, pinned: false }, false);
    line(r.ok === false && r.reason === 'not-for-this-request', 'one that claims to be signed for when the wallet asked in public is refused', r);

    if (!beforeEnd) {
      console.log('\n(the compatibility period is over on this date: the checks that need an old-form answer from a live server are not run)');
    } else {
      console.log('\n== the wallet against the updated server and one that has not been updated');
      oldServer(b);
      await op(b, 'open', { coinId: (await createCoin(b, 'OLD')).json.id }).catch(() => null);
      const oldCoin = (await createCoin(b, 'OLD2')).json;
      await op(b, 'open', { coinId: oldCoin.id });
      await op(b, 'grant', { coinId: oldCoin.id, to: alice.key, amount: '700' });
      const st = { domains: [], cache: {} };
      const seenBodies = [];
      const spy = async (url, init) => { if (url.includes('action=holdings')) seenBodies.push({ url, body: bodyOf(init) }); return null; };
      const w1 = walletOver(alice, st, spy);
      await w1.addDomain(A);
      await w1.addDomain(B);
      const la = await w1.lookup(A);
      const lb = await w1.lookup(B);
      let rows = (await w1.rows()).domains;
      const rowA = rows.find((d) => d.domain === A), rowB = rows.find((d) => d.domain === B);
      line(la.ok && lb.ok, 'both domains answer', [la, lb]);
      line(rowA.legacy === false && rowB.legacy === true && typeof rowB.legacyUntil === 'string' && /2027/.test(rowB.legacyUntil), 'the domain that has not been updated is marked, with the date; the updated one is not', [rowA.legacy, rowB.legacy, rowB.legacyUntil]);
      const recA = st.domains.find((d) => d.domain === A), recB = st.domains.find((d) => d.domain === B);
      line(recA.holdings && recA.holdings.v === 2 && typeof recA.holdings.since === 'string' && !recB.holdings, 'the updated one is recorded as answering in the bound form; the other is not');
      line(seenBodies.length >= 2 && seenBodies.every((x) => x.body && /^[a-f0-9]{32}$/.test(x.body.nonce || '')) && seenBodies.filter((x) => x.body.request).every((x) => x.body.nonce === x.body.request.payload.challenge), 'every lookup the wallet made carried a nonce, which for a signed one is its challenge');
      const nonces = new Set(seenBodies.map((x) => x.body.nonce));
      line(nonces.size === seenBodies.length, 'and no two lookups carried the same nonce');
      await w1.lookup(A);
      await w1.lookup(A);
      const publicNonces = [];
      const spy2 = walletOver(alice, st, async (url, init) => { if (url.includes('action=holdings') && !bodyOf(init).request) publicNonces.push(bodyOf(init).nonce); return null; }, { sign: async () => { throw new Error('this identity cannot sign for a ledger'); } });
      await spy2.lookup(A); await spy2.lookup(A); await spy2.lookup(A);
      line(publicNonces.length === 3 && new Set(publicNonces).size === 3 && publicNonces.every((x) => /^[a-f0-9]{32}$/.test(x)), 'a public lookup picks a new random nonce each time', publicNonces);

      console.log('\n== the replay, against the wallet');
      let captured = null;
      const recorder = walletOver(alice, st, async (url, init, forward) => { if (url.includes('action=holdings')) { const res = await forward(); captured = JSON.parse(await res.text()); return { status: res.status, json: captured }; } return null; });
      await recorder.lookup(A);
      const fresh = await w1.send(await w1.prepareSend(A, sgl.id, bob.key, '10'));
      const victim = walletOver(alice, st, async (url) => (url.includes('action=holdings') ? { status: 200, json: captured } : null));
      const before = JSON.stringify((await victim.rows()).domains.find((d) => d.domain === A).coins.map((c) => c.units));
      const got = await victim.lookup(A);
      const after = JSON.stringify((await victim.rows()).domains.find((d) => d.domain === A).coins.map((c) => c.units));
      line(fresh.status === 'done' && got.ok === false && got.reason === 'not-for-this-request' && before === after, 'a statement captured before a transfer does not replace what the wallet knows after it', [got, before, after]);

      console.log('\n== a domain that answered in the bound form does not go back');
      const heldBefore = JSON.stringify({ heads: st.domains.find((d) => d.domain === A).heads, genesis: st.domains.find((d) => d.domain === A).genesis, holdings: st.domains.find((d) => d.domain === A).holdings });
      newServer(b);
      const up = await w1.lookup(B);
      const rowB2 = (await w1.rows()).domains.find((d) => d.domain === B);
      line(up.ok && rowB2.legacy === false && st.domains.find((d) => d.domain === B).holdings.v === 2, 'once the other domain is updated its next lookup records the capability and the notice goes', [up, rowB2.legacy]);
      const pinB = JSON.stringify(st.domains.find((d) => d.domain === B).holdings);
      const stateBefore = JSON.stringify(st.domains.map((d) => ({ domain: d.domain, heads: d.heads, genesis: d.genesis, holdings: d.holdings })));
      oldServer(b);
      let calls = 0;
      const counting = walletOver(alice, st, async (url, init) => { if (url.includes('action=holdings')) calls++; return null; });
      const down = await counting.lookup(B);
      line(down.ok === false && down.reason === 'downgrade' && calls === 1, 'the domain is refused when it answers in the old form again, with one request and no second try', [down, calls]);
      const rowDown = (await counting.rows()).domains.find((d) => d.domain === B);
      line(typeof rowDown.problem === 'string' && /earlier|bound|redeploy|update/i.test(rowDown.problem), 'the person is told, in words', rowDown.problem);
      line(JSON.stringify(st.domains.find((d) => d.domain === B).holdings) === pinB && JSON.stringify(st.domains.map((d) => ({ domain: d.domain, heads: d.heads, genesis: d.genesis, holdings: d.holdings }))) === stateBefore, 'nothing the wallet pinned is removed or changed: not the capability, the genesis pins or the kept heads');
      const failures5 = [
        ['an HTTP failure', { status: 500, json: { ok: false } }],
        ['no answer', { status: 0, text: '' }],
        ['text that is not JSON', { status: 200, text: 'not json' }],
        ['a statement with fields missing', { status: 200, json: { ok: true, statement: { type: 'atlas.ledger.holdings', v: 2 }, signature: 'x' } }],
        ['an answer in the old form that is unsigned', { status: 200, json: { ok: true, statement: { type: 'atlas.ledger.holdings', v: 1, domain: B, key: alice.key, asOf: asOf(Date.now()), proven: true, coins: [] }, signature: 'AA' } }]
      ];
      for (const [name, reply] of failures5) {
        const w = walletOver(alice, st, async (url) => (url.includes('action=holdings') ? reply : null));
        const res = await w.lookup(B);
        const kept = JSON.stringify(st.domains.find((d) => d.domain === B).holdings) === pinB;
        const row = (await w.rows()).domains.find((d) => d.domain === B);
        line(res.ok === false && kept && row.legacy === false, 'for a pinned domain ' + name + ' is a refused lookup, not a way back to the old form', [res, row.legacy]);
      }
      newServer(b);
      const back = await w1.lookup(B);
      line(back.ok === true, 'when the correct server is back the next lookup works, with nothing to reset', back);
      line(heldBefore === JSON.stringify({ heads: st.domains.find((d) => d.domain === A).heads, genesis: st.domains.find((d) => d.domain === A).genesis, holdings: st.domains.find((d) => d.domain === A).holdings }), 'and the other domain\'s pins are as they were');

      console.log('\n== backups carry the capability');
      const backup = JSON.parse(JSON.stringify(st.domains));
      const restored = { domains: backup, cache: {} };
      const w2 = walletOver(alice, restored);
      const lr = await w2.lookup(A);
      line(lr.ok && restored.domains.find((d) => d.domain === A).holdings.v === 2 && restored.domains.find((d) => d.domain === B).holdings.v === 2, 'a wallet restored from a copy of the list still holds the capability of each domain', restored.domains.map((d) => d.holdings));
      oldServer(b);
      const refused = await w2.lookup(B);
      line(refused.ok === false && refused.reason === 'downgrade', 'and refuses the old form from it');
      newServer(b);
      const older = JSON.parse(JSON.stringify(st.domains)).map((d) => { const c = Object.assign({}, d); delete c.holdings; return c; });
      const w3 = walletOver(alice, { domains: older, cache: {} });
      const lo = await w3.lookup(B);
      line(lo.ok === true, 'a list from before the capability was recorded works, and records it again on the next verified answer');

      console.log('\n== an unanswered transfer is not settled on the old form');
      const ob = (await createCoin(b, 'UNS')).json;
      await op(b, 'open', { coinId: ob.id });
      await op(b, 'grant', { coinId: ob.id, to: alice.key, amount: '900' });
      const st2 = { domains: [], cache: {} };
      const setup = walletOver(alice, st2);
      await setup.addDomain(B);
      const lostRequest = async (url) => { if (url.includes('action=propose')) throw new Error('timed out'); return null; };
      const sender = walletOver(alice, st2, lostRequest);
      const sent = await sender.send(await sender.prepareSend(B, ob.id, bob.key, '1'));
      line(sent.status === 'unknown', 'a transfer whose request got no answer is unknown', sent);
      const lapse = () => { st2.cache.pendingSends = st2.cache.pendingSends.map((p) => Object.assign({}, p, { authorization: { signature: p.authorization.signature, payload: Object.assign({}, p.authorization.payload, { expiresAt: new Date(Date.now() - 3600000).toISOString().replace(/\.\d+Z$/, 'Z') }) } })); };
      lapse();
      oldServer(b);
      st2.domains = st2.domains.map((d) => { const c = Object.assign({}, d); delete c.holdings; return c; });
      const viaOld = await walletOver(alice, st2).checkPending();
      const kept = (await walletOver(alice, st2).rows()).pendingSends;
      line(viaOld.length === 1 && viaOld[0].outcome === 'unknown' && /tied|bound|old form|each request/i.test(viaOld[0].reason || '') && kept.length === 1, 'the old form is not taken as proof that it was not made: the transfer stays, still unknown', [viaOld, kept.length]);
      newServer(b);
      const viaNew = await walletOver(alice, st2).checkPending();
      line(viaNew.length === 1 && viaNew[0].outcome === 'not-made' && (await walletOver(alice, st2).rows()).pendingSends.length === 0, 'once the domain answers in the bound form the same evidence settles it as not made', viaNew);
    }
  } finally {
    for (const n of Object.values(nodes)) if (n.proc) n.proc.kill('SIGKILL');
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' BOUND HOLDINGS CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
