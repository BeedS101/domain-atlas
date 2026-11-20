// A transfer request that gets no answer (extension/chain-labs-wallet.js), against three live PHP servers running the real endpoint:
//   - the signed transfer is kept, named by its digest, before it is sent, and stays on the list as unknown when no answer arrives
//   - the wallet never signs or sends another transfer in its place
//   - the domain's answer about that digest, with a receipt that verifies, settles it; a transfer the domain never received lapses
//   - nothing is lost when the wallet is restarted, and the Ledger tab data shows the state
//
//   node test/chain-labs-wallet-unanswered.js
'use strict';
const http = require('http');
const crypto = require('crypto');
const S = require('./support/chain-labs-servers');
const { A, B, C, nodes, POLICY, b64u, canon, wallet, start, stop, post, op, createCoin, credential } = S;

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };
const Chain = require('../extension/chain-labs-wallet.js');

function reach(n, urlPath, init) {
  return new Promise((resolve, reject) => {
    const data = init.body === undefined ? null : init.body;
    const headers = { host: n.domain, origin: 'https://' + n.domain, ...(init.headers || {}) };
    if (data !== null) headers['content-length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port: n.port, path: urlPath, method: init.method || 'GET', headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, text: async () => b }));
    });
    req.on('error', reject);
    if (init.signal) init.signal.addEventListener('abort', () => req.destroy(new Error('aborted')));
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
const freshState = () => ({ domains: [], cache: {} });
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const derSign = (node, text) => b64u(crypto.sign('sha256', Buffer.from(text), node.pair.privateKey));

// A wallet whose answers pass through `hook(url, init, real)`: it returns a response ({status, json}) to use instead, or null to leave the answer alone.
// `edit(match, fn)` makes a hook that changes the JSON of the answers whose address contains `match`.
let sent = 0;
function through(w, state, hook) {
  const base = envFor(w, state);
  return Chain.create(Object.assign({}, base, {
    fetch: async (url, init) => {
      if (url.includes('action=propose') || url.includes('action=purchase')) sent++;
      const forward = () => base.fetch(url, init);
      const out = await hook(url, init, forward);
      if (!out) return forward();
      return { status: out.status, text: async () => JSON.stringify(out.json) };
    }
  }));
}
const edit = (match, fn) => async (url, init, forward) => {
  if (!url.includes(match)) return null;
  const res = await forward();
  const json = JSON.parse(await res.text());
  const out = fn(json, res.status);
  return { status: out && out.status !== undefined ? out.status : res.status, json: out && out.json !== undefined ? out.json : json };
};
const both = (...hooks) => async (url, init, forward) => { for (const h of hooks) { const out = await h(url, init, forward); if (out) return out; } return null; };


let signs = 0;
// A wallet over `state` that counts the transfers it signs; `hook` may change or drop what the domains answer.
function walletOver(w, state, hook) {
  const base = envFor(w, state, { sign: async (payload) => { if (payload && payload.type === 'atlas.ledger.transfer') signs++; return { publicKey: w.key, signature: w.sign(payload) }; } });
  return Chain.create(Object.assign({}, base, {
    fetch: async (url, init) => {
      const forward = () => base.fetch(url, init);
      const out = hook ? await hook(url, init, forward) : null;
      if (!out) return forward();
      return { status: out.status, text: async () => JSON.stringify(out.json) };
    }
  }));
}
// The request is received and carried out by the domain; the answer never arrives.
const lostAnswer = async (url, init, forward) => { if (!url.includes('action=propose')) return null; await forward(); throw new Error('timed out'); };
// The request never reaches the domain.
const lostRequest = async (url) => { if (url.includes('action=propose')) throw new Error('timed out'); return null; };

(async () => {
  for (const n of Object.values(nodes)) await start(n);
  const a = nodes[A], b = nodes[B], c = nodes[C];
  try {
    const alice = wallet(), bob = wallet();
    const sgl = (await createCoin(a, 'SGL')).json;
    const allOf = (await createCoin(a, 'ALL', { mode: 'multi', partners: [B, C] })).json;
    for (const coin of [sgl, allOf]) {
      await op(a, 'open', { coinId: coin.id });
      await op(a, 'grant', { coinId: coin.id, to: alice.key, amount: '5000' });
    }
    const st = { domains: [], cache: {} };
    const setup = walletOver(alice, st);
    for (const d of [A, B, C]) await setup.addDomain(d);
    const pending = async (w) => (await w.rows()).pendingSends;
    const proposalAt = async (digest, coinId) => (await S.get(a, 'action=proposal&coin=' + coinId + '&digest=' + digest));
    const units = async (coinId) => ((await post(a, 'action=holdings', { key: bob.key })).json.statement.coins.find((x) => x.coinId === coinId) || { units: '0' }).units;
    // What the domain's clock would say once the authorization has lapsed, as far as the wallet can see: the stored expiry is moved back.
    const lapse = (digest) => { st.cache.pendingSends = st.cache.pendingSends.map((p) => (p.digest === digest ? Object.assign({}, p, { authorization: { signature: p.authorization.signature, payload: Object.assign({}, p.authorization.payload, { expiresAt: new Date(Date.now() - 3600000).toISOString().replace(/\.\d+Z$/, 'Z') }) } }) : p)); };

    console.log('== the signed transfer is kept before it is sent');
    let seenBefore = null;
    const watcher = walletOver(alice, st, async (url, init) => {
      if (url.includes('action=propose')) {
        const sentAuth = JSON.parse(init.body).authorization;
        const d = sha(canon(sentAuth.payload));
        seenBefore = (st.cache.pendingSends || []).find((p) => p.digest === d) || null;
        if (seenBefore) seenBefore = { state: seenBefore.state, same: JSON.stringify(seenBefore.authorization) === JSON.stringify(sentAuth) };
      }
      return null;
    });
    const fine = await watcher.send(await watcher.prepareSend(A, sgl.id, bob.key, '1'));
    line(fine.status === 'done', 'a transfer the domain answers is made as before', fine);
    line(seenBefore && seenBefore.state === 'unknown' && seenBefore.same, 'the signed authorization was on the list, as unknown, when the request went out', seenBefore);
    line((await pending(watcher)).length === 0, 'and the list is empty once the receipt verified');

    console.log('\n== no answer: the request never reached the domain');
    signs = 0;
    const lost1 = walletOver(alice, st, lostRequest);
    const before = await units(sgl.id);
    const r1 = await lost1.send(await lost1.prepareSend(A, sgl.id, bob.key, '2'));
    line(r1.status === 'unknown' && /^[0-9a-f]{64}$/.test(r1.digest), 'the transfer is reported as unknown, not as failed', r1);
    const k1 = await pending(lost1);
    line(k1.length === 1 && k1[0].state === 'unknown' && k1[0].digest === r1.digest && sha(canon(k1[0].authorization.payload)) === r1.digest && typeof k1[0].authorization.signature === 'string', 'it stays on the list with the signed authorization and its digest', k1);
    line((await proposalAt(r1.digest, sgl.id)).status === 404 && (await units(sgl.id)) === before, 'the domain never saw it');
    line(signs === 1, 'one transfer was signed', signs);
    const again1 = await lost1.checkPending();
    line(again1.length === 1 && again1[0].outcome === 'unknown' && (await pending(lost1)).length === 1 && signs === 1, 'asked before the authorization has lapsed, it is still unknown, and nothing new is signed or sent', again1);
    lapse(r1.digest);
    const calm = walletOver(alice, st);
    const settled1 = await calm.checkPending();
    line(settled1.length === 1 && settled1[0].outcome === 'not-made' && (await pending(calm)).length === 0, 'once it has lapsed and the signed holdings show the account where it was, it is settled as not made', settled1);
    line(signs === 1 && (await units(sgl.id)) === before, 'without any transfer being signed or sent in its place', signs);

    console.log('\n== no answer: the domain received and made it');
    signs = 0;
    const lost2 = walletOver(alice, st, lostAnswer);
    const before2 = BigInt(await units(sgl.id));
    const r2 = await lost2.send(await lost2.prepareSend(A, sgl.id, bob.key, '3'));
    line(r2.status === 'unknown' && (await pending(lost2)).length === 1, 'the transfer is unknown on the wallet', r2);
    line((await proposalAt(r2.digest, sgl.id)).json.proposal.status === 'executed' && BigInt(await units(sgl.id)) === before2 + 300n, 'though the domain made it');
    line(signs === 1, 'and the wallet signed it once', signs);
    const same = await lost2.checkPending();
    line(same.length === 1 && same[0].outcome === 'done' && (await pending(lost2)).length === 0, 'the domain\'s answer about that digest, with a receipt that verifies, settles it', same);
    line(signs === 1 && BigInt(await units(sgl.id)) === before2 + 300n, 'and it was not sent again', signs);

    console.log('\n== no answer, then the wallet restarts');
    signs = 0;
    const lost3 = walletOver(alice, st, lostAnswer);
    const r3 = await lost3.send(await lost3.prepareSend(A, sgl.id, bob.key, '4'));
    const saved = JSON.parse(JSON.stringify(st));
    const restarted = walletOver(alice, saved);
    const k3 = await pending(restarted);
    line(r3.status === 'unknown' && k3.length === 1 && k3[0].state === 'unknown' && k3[0].digest === r3.digest && !!k3[0].authorization, 'a new wallet over the saved data still holds it, with the authorization', k3);
    const after = await restarted.checkPending();
    line(after.length === 1 && after[0].outcome === 'done' && (await pending(restarted)).length === 0 && signs === 1, 'and settles it from the domain\'s answer, without signing again', after);
    st.cache = saved.cache;
    // The same for a request that never arrived.
    const lost4 = walletOver(alice, st, lostRequest);
    const r4 = await lost4.send(await lost4.prepareSend(A, sgl.id, bob.key, '1'));
    const saved4 = JSON.parse(JSON.stringify(st));
    saved4.cache.pendingSends = saved4.cache.pendingSends.map((p) => (p.digest === r4.digest ? Object.assign({}, p, { authorization: { signature: p.authorization.signature, payload: Object.assign({}, p.authorization.payload, { expiresAt: new Date(Date.now() - 3600000).toISOString().replace(/\.\d+Z$/, 'Z') }) } }) : p));
    const restarted4 = walletOver(alice, saved4);
    const out4 = await restarted4.checkPending();
    line(out4.length === 1 && out4[0].outcome === 'not-made' && (await pending(restarted4)).length === 0, 'a request that never arrived is settled the same way after a restart', out4);
    st.cache = saved4.cache;

    console.log('\n== an account that moved: the wallet does not guess');
    const lost5 = walletOver(alice, st, lostRequest);
    const r5 = await lost5.send(await lost5.prepareSend(A, sgl.id, bob.key, '1'));
    const other = await calm.send(await calm.prepareSend(A, sgl.id, bob.key, '1'));
    lapse(r5.digest);
    const moved = await calm.checkPending();
    line(other.status === 'done' && moved.length === 1 && moved[0].outcome === 'unknown' && /moved/.test(moved[0].reason || '') && (await pending(calm)).length === 1, 'when the sender made another transfer since, an unseen one stays unknown', moved);
    const only = await pending(calm);
    st.cache.pendingSends = st.cache.pendingSends.filter((p) => p.digest !== r5.digest);

    console.log('\n== a multi authority coin: received, and waiting for the partners');
    signs = 0;
    await stop(c);
    const lost6 = walletOver(alice, st, lostAnswer);
    const r6 = await lost6.send(await lost6.prepareSend(A, allOf.id, bob.key, '2'));
    const p6 = await proposalAt(r6.digest, allOf.id);
    line(r6.status === 'unknown' && p6.json.proposal.status === 'pending', 'the authority holds it waiting for the partners and the answer was lost', [r6.status, p6.json]);
    const w6 = await calm.checkPending();
    line(w6.length === 1 && w6[0].outcome === 'waiting' && (await pending(calm))[0].state === 'waiting', 'the wallet learns it is waiting, and keeps it', w6);
    await start(c);
    await op(a, 'recover', { coinId: allOf.id });
    const done6 = await calm.checkPending();
    line(done6.length === 1 && done6[0].outcome === 'done' && (await pending(calm)).length === 0 && signs === 1, 'and settles it when the partners have approved it, with one signature in all', done6);

    console.log('\n== a request the domain refuses is not kept');
    signs = 0;
    const refused = walletOver(alice, st, async (url) => (url.includes('action=propose') ? { status: 409, json: { ok: false, code: 'insufficient', error: 'no' } } : null));
    const rf = await refused.send(await refused.prepareSend(A, sgl.id, bob.key, '1')).catch((e) => e);
    line(rf.code === 'insufficient' && (await pending(refused)).length === 0 && signs === 1, 'a refusal from the domain says it was not made, and nothing is kept', rf.code || rf);
    const server500 = walletOver(alice, st, async (url) => (url.includes('action=propose') ? { status: 500, json: { ok: false } } : null));
    const rs = await server500.send(await server500.prepareSend(A, sgl.id, bob.key, '1')).catch((e) => e);
    line(rs.status === 'unknown' && (await pending(server500)).length === 1, 'a server error does not say that, and is kept as unknown', rs.status || rs.code);
    st.cache.pendingSends = [];

    console.log('\n== a 4xx answer that is not the domain refusing the transfer');
    // The domain makes the transfer and the answer that reaches the wallet is replaced: a rate limit or timeout from a proxy in front of the
    // domain, a busy answer, or a conflict the domain reports while the proposal stays stored and runs later.
    const ambiguous = [
      ['429 with no code (a rate limit)', 429, { ok: false, error: 'Too Many Requests' }],
      ['429 busy', 429, { ok: false, code: 'busy', error: 'busy' }],
      ['408 request timeout', 408, { ok: false, error: 'timeout' }],
      ['425 too early', 425, { ok: false }],
      ['409 wrong-index (the proposal stays stored)', 409, { ok: false, code: 'wrong-index', error: 'x' }],
      ['400 with a code the wallet does not know', 400, { ok: false, code: 'something-new', error: 'x' }],
      ['403 from a firewall in front of the domain', 403, { ok: false }]
    ];
    for (const [name, status, json] of ambiguous) {
      signs = 0;
      const sgBefore = BigInt(await units(sgl.id));
      const w = walletOver(alice, st, async (url, init, forward) => {
        if (!url.includes('action=propose')) return null;
        await forward();
        return { status, json };
      });
      const r = await w.send(await w.prepareSend(A, sgl.id, bob.key, '1')).catch((e) => e);
      const kept = await pending(w);
      line(r.status === 'unknown' && kept.length === 1 && kept[0].state === 'unknown' && signs === 1, name + ': the transfer is kept as unknown, not dropped', r.status || r.code);
      line(BigInt(await units(sgl.id)) === sgBefore + 100n, '    the domain had made it', await units(sgl.id));
      const out = await w.checkPending();
      line(out.length === 1 && out[0].outcome === 'done' && (await pending(w)).length === 0 && signs === 1, '    and the domain\'s answer about the digest settles it, with nothing sent again', out);
    }
    // The same answers where the domain did not make the transfer: kept as unknown until the domain says so.
    signs = 0;
    const notMade = walletOver(alice, st, async (url) => (url.includes('action=propose') ? { status: 429, json: { ok: false, error: 'Too Many Requests' } } : null));
    const nm = await notMade.send(await notMade.prepareSend(A, sgl.id, bob.key, '1')).catch((e) => e);
    line(nm.status === 'unknown' && (await pending(notMade)).length === 1 && (await notMade.checkPending())[0].outcome === 'unknown' && signs === 1, 'a rate limit that stopped the request is kept as unknown until the lapse shows nothing was made', nm.status || nm.code);
    st.cache.pendingSends = [];
    // A refusal the domain gives for a transfer it did not make still says so.
    for (const [code, status] of [['insufficient', 409], ['stale', 409], ['expired', 409], ['pending-exists', 409], ['bad-signature', 401], ['wrong-authority', 409]]) {
      signs = 0;
      const w = walletOver(alice, st, async (url) => (url.includes('action=propose') ? { status, json: { ok: false, code, error: 'no' } } : null));
      const r = await w.send(await w.prepareSend(A, sgl.id, bob.key, '1')).catch((e) => e);
      line((r.code === code || code === 'stale') && (await pending(w)).length === 0, code + ': a refusal that says it was not made removes it', r.code || r.status);
    }

    console.log('\n== unresolved transfers are not dropped');
    const capped = { domains: JSON.parse(JSON.stringify(st.domains)), cache: {} };
    const fake = (i, state) => Object.assign({ domain: A, coinId: sgl.id, digest: String(i).padStart(64, '0'), to: bob.key, amount: '100', from: alice.key, symbol: 'SGL', decimals: 2, createdAt: 1000 + i }, state ? { state } : {});
    capped.cache = { pendingSends: [fake(1, 'unknown')].concat(Array.from({ length: 25 }, (_, i) => fake(100 + i))) };
    const wcap = walletOver(alice, capped, lostRequest);
    await wcap.send(await wcap.prepareSend(A, sgl.id, bob.key, '1')).catch(() => null);
    const kept = (await wcap.rows()).pendingSends;
    line(kept.filter((p) => p.state === 'unknown').length === 2 && kept.some((p) => p.digest === fake(1).digest), 'an unknown transfer is not pushed off the list by newer ones', kept.map((p) => p.state));
    const full = { domains: JSON.parse(JSON.stringify(st.domains)), cache: { pendingSends: Array.from({ length: 50 }, (_, i) => fake(200 + i, 'unknown')) } };
    const wfull = walletOver(alice, full);
    signs = 0;
    const blocked = await wfull.send(await wfull.prepareSend(A, sgl.id, bob.key, '1')).catch((e) => e);
    line(blocked.code === 'too-many-unresolved' && signs === 0, 'with fifty unresolved transfers nothing more is signed', blocked.code || blocked);
  } finally {
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHAIN-LABS UNANSWERED TRANSFER CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
