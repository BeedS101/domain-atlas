// What the wallet (extension/chain-labs-wallet.js) checks for itself before it believes a domain, against three live PHP servers running
// the real endpoint. The domains' answers are altered on the way to the wallet, the way a dishonest or compromised domain could:
//   - receipts: the entry hash, the authority's signature and the roster's approvals are checked, not only the amounts
//   - a multi authority receipt cannot be made up by the authority alone
//   - a coin's genesis is pinned the first time it is used, and a different one under the same coin id is refused
//   - purchase terms come from that verified genesis, not from the plain answer of the domain
//   - nothing falls back to unsigned data, and existing wallets keep working
//
//   node test/chain-labs-wallet-verify.js
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

(async () => {
  for (const n of Object.values(nodes)) await start(n);
  const a = nodes[A], b = nodes[B], c = nodes[C];
  try {
    const alice = wallet(), bob = wallet();
    const sgl = (await createCoin(a, 'SGL')).json;
    const prv = (await createCoin(a, 'PRV', { visibility: 'private' })).json;
    const allOf = (await createCoin(a, 'ALL', { mode: 'multi', partners: [B, C] })).json;
    const twoOf = (await createCoin(a, 'TWO', { mode: 'multi', partners: [B, C], threshold: 2 })).json;
    for (const [coin, purchase] of [[sgl, POLICY], [prv, undefined], [allOf, POLICY], [twoOf, undefined]]) {
      const r = await op(a, 'open', purchase ? { coinId: coin.id, purchase } : { coinId: coin.id });
      if (r.status !== 201) line(false, 'setup: a coin opens', r.json);
    }
    for (const coin of [sgl, prv, allOf, twoOf]) await op(a, 'grant', { coinId: coin.id, to: alice.key, amount: '5000' });

    const st = freshState();
    const honest = Chain.create(envFor(alice, st));
    await honest.addDomain(A);
    await honest.addDomain(B);
    await honest.addDomain(C);

    // The entry a dishonest authority would make up: a transfer that matches what the wallet asked for and was never executed.
    const fabricate = (coinId, prepared, index, node) => {
      const entry = { amount: prepared.amount, coinId, executedAt: '2026-01-01T00:00:00Z', from: prepared.from, index, prevHash: 'a'.repeat(64), to: prepared.to, type: 'transfer' };
      if (prepared.purchase) entry.purchase = prepared.purchase;
      const hash = sha(canon(entry));
      return { coinId, entry, hash, authoritySignature: derSign(node, hash), approvals: [] };
    };
    // Refused by the wallet itself with this code, before any signed transfer or purchase was sent.
    const refusedHere = async (p, code) => { const before = sent; const r = await p.catch((e) => e); return !!(r && r.code === code) && sent === before; };
    const refusal = async (p) => { const r = await p.catch((e) => e); return r && r.code ? r.code : (r && r.status) || 'none'; };

    console.log('== an honest domain');
    const ok1 = await honest.send(await honest.prepareSend(A, sgl.id, bob.key, '1'));
    line(ok1.status === 'done' && ok1.receipt.entry.amount === '100', 'a transfer on a single authority coin is accepted with its receipt', ok1);
    const ok2 = await honest.send(await honest.prepareSend(A, allOf.id, bob.key, '1'));
    line(ok2.status === 'done' && ok2.receipt.approvals.length === 2, 'a full roster coin is accepted with both partners\' approvals', ok2.receipt && ok2.receipt.approvals);
    const ok3 = await honest.send(await honest.prepareSend(A, twoOf.id, bob.key, '1'));
    line(ok3.status === 'done' && ok3.receipt.approvals.length >= 1, 'and a 2 of 3 coin with the approvals it needed', ok3.receipt && ok3.receipt.approvals);
    const ok4 = await honest.send(await honest.prepareSend(A, prv.id, bob.key, '1'));
    line(ok4.status === 'done', 'and a private coin, whose entry names accounts by reference', ok4);

    console.log('\n== a receipt that was not made by the coin');
    const madeUp = through(alice, st, edit('action=propose', (j, s) => ({ status: 201, json: { ok: true, receipt: fabricate(sgl.id, { amount: '100', from: alice.key, to: bob.key }, 99, a) } })));
    line(await refusal(madeUp.send(await madeUp.prepareSend(A, sgl.id, bob.key, '1'))) === 'bad-receipt', 'a receipt with the right amounts, made up and never signed by the domain\'s own entry, is not accepted');
    const realIndex = through(alice, st, edit('action=propose', (j) => ({ status: 201, json: { ok: true, receipt: fabricate(sgl.id, { amount: '100', from: alice.key, to: bob.key }, 1, a) } })));
    line(await refusal(realIndex.send(await realIndex.prepareSend(A, sgl.id, bob.key, '1'))) === 'bad-receipt', 'and so is one made up for an entry number the coin does hold, which its own history shows to be another entry');
    const noSig = through(alice, st, edit('action=propose', (j) => { j.receipt.authoritySignature = 'AAAA'; }));
    line(await refusal(noSig.send(await noSig.prepareSend(A, sgl.id, bob.key, '1'))) === 'bad-receipt', 'a receipt with no valid authority signature is not accepted');
    const otherKey = through(alice, st, edit('action=propose', (j) => { j.receipt.authoritySignature = derSign(b, j.receipt.hash); }));
    line(await refusal(otherKey.send(await otherKey.prepareSend(A, sgl.id, bob.key, '1'))) === 'bad-receipt', 'a receipt signed by another domain\'s key in place of the authority\'s is not accepted');
    const wrongHash = through(alice, st, edit('action=propose', (j) => { j.receipt.entry.executedAt = '2020-01-01T00:00:00Z'; }));
    line(await refusal(wrongHash.send(await wrongHash.prepareSend(A, sgl.id, bob.key, '1'))) === 'bad-receipt', 'an entry changed after it was signed (so the hash is not its hash) is not accepted');
    const wrongHash2 = through(alice, st, edit('action=propose', (j) => { j.receipt.hash = 'b'.repeat(64); }));
    line(await refusal(wrongHash2.send(await wrongHash2.prepareSend(A, sgl.id, bob.key, '1'))) === 'bad-receipt', 'and a hash that is not the hash of the entry');
    const otherCoin = through(alice, st, edit('action=propose', (j) => { j.receipt.coinId = 'f'.repeat(32); j.receipt.entry.coinId = 'f'.repeat(32); }));
    line(await refusal(otherCoin.send(await otherCoin.prepareSend(A, sgl.id, bob.key, '1'))) === 'bad-receipt', 'a receipt for another coin is not accepted');

    console.log('\n== a multi authority receipt without the partners');
    const strip = through(alice, st, edit('action=propose', (j) => { j.receipt.approvals = []; }));
    line(await refusal(strip.send(await strip.prepareSend(A, allOf.id, bob.key, '1'))) === 'bad-receipt', 'a full roster receipt with the approvals taken out is not accepted');
    const halfOfAll = through(alice, st, edit('action=propose', (j) => { j.receipt.approvals = j.receipt.approvals.slice(0, 1); }));
    line(await refusal(halfOfAll.send(await halfOfAll.prepareSend(A, allOf.id, bob.key, '1'))) === 'bad-receipt', 'and with one of its two partners missing');
    const stripTwo = through(alice, st, edit('action=propose', (j) => { j.receipt.approvals = []; }));
    line(await refusal(stripTwo.send(await stripTwo.prepareSend(A, twoOf.id, bob.key, '1'))) === 'bad-receipt', 'a 2 of 3 receipt with no partner approval is not accepted');
    const selfApproved = through(alice, st, edit('action=propose', (j) => {
      const bytes = canon({ type: 'atlas.ledger.entry.approval', v: 1, coinId: allOf.id, index: j.receipt.entry.index, hash: j.receipt.hash });
      j.receipt.approvals = [{ domain: B, signature: derSign(a, bytes) }, { domain: C, signature: derSign(a, bytes) }];
    }));
    line(await refusal(selfApproved.send(await selfApproved.prepareSend(A, allOf.id, bob.key, '1'))) === 'bad-receipt', 'approvals the authority signed with its own key in the partners\' names are not accepted');
    const twice = through(alice, st, edit('action=propose', (j) => { j.receipt.approvals = [j.receipt.approvals[0], j.receipt.approvals[0]]; }));
    line(await refusal(twice.send(await twice.prepareSend(A, allOf.id, bob.key, '1'))) === 'bad-receipt', 'one partner\'s approval counted twice is not accepted');
    const stranger = through(alice, st, edit('action=propose', (j) => { j.receipt.approvals = j.receipt.approvals.map((x) => Object.assign({}, x, { domain: 'z.example' })); }));
    line(await refusal(stranger.send(await stranger.prepareSend(A, allOf.id, bob.key, '1'))) === 'bad-receipt', 'approvals from a domain outside the roster are not accepted');
    const wholly = through(alice, st, edit('action=propose', (j) => ({ status: 201, json: { ok: true, receipt: fabricate(allOf.id, { amount: '100', from: alice.key, to: bob.key }, 99, a) } })));
    line(await refusal(wholly.send(await wholly.prepareSend(A, allOf.id, bob.key, '1'))) === 'bad-receipt', 'an entry the authority signed alone, matching what was asked, is not a receipt');

    const keptBad = (await honest.rows()).pendingSends;
    line(keptBad.length === 14 && keptBad.every((x) => x.state === 'unconfirmed' && x.authorization && x.digest), 'every transfer above, whose receipt was refused, is still on the list as unconfirmed', keptBad.length);
    st.cache.pendingSends = [];

    console.log('\n== a waiting transfer is judged the same way');
    await stop(c);
    const waiting = await honest.send(await honest.prepareSend(A, allOf.id, bob.key, '2'));
    line(waiting.status === 'waiting', 'with a partner down the transfer waits', waiting);
    await start(c);
    await op(a, 'recover', { coinId: allOf.id });
    const noApprovals = (j) => { if (j.receipt && j.receipt.entry && j.receipt.entry.index > 0) j.receipt.approvals = []; };
    const swapped = through(alice, st, both(
      edit('action=proposal', (j) => { if (j.proposal && j.proposal.receipt) j.proposal.receipt.approvals = []; }),
      edit('action=receipt&coin=', noApprovals)
    ));
    const judged = await swapped.checkPending();
    line(judged.length === 1 && judged[0].outcome !== 'done', 'a receipt with no approvals, from the domain and from the partners, is not taken for the transfer finishing', judged);
    line(judged[0] && judged[0].outcome === 'unconfirmed', 'and the person is told the outcome is unconfirmed', judged);
    const keptWaiting = (await honest.rows()).pendingSends;
    line(keptWaiting.length === 1 && keptWaiting[0].state === 'unconfirmed' && keptWaiting[0].authorization && keptWaiting[0].digest === judged[0].digest, 'and the transfer stays on the list with its authorization and digest, marked unconfirmed', keptWaiting);
    const lateHonest = await honest.checkPending();
    line(lateHonest.length === 1 && lateHonest[0].outcome === 'done' && (await honest.rows()).pendingSends.length === 0, 'and the honest answer, when it comes, settles it', lateHonest);
    await stop(c);
    const slow = await honest.send(await honest.prepareSend(A, allOf.id, bob.key, '2'));
    await start(c);
    await op(a, 'recover', { coinId: allOf.id });
    const unreachable = through(alice, st, async (url) => (url.includes('action=head') ? { status: 503, json: { ok: false } } : null));
    const unsure = await unreachable.checkPending();
    const unsureRows = (await honest.rows()).pendingSends;
    line(slow.status === 'waiting' && unsure.length === 1 && unsure[0].outcome === 'waiting' && unsureRows.length === 1 && unsureRows[0].state !== 'unconfirmed', 'a receipt that cannot be checked because the domain does not answer yet is asked about again, not judged', unsure);
    const settled = await honest.checkPending();
    line(settled.length === 1 && settled[0].outcome === 'done' && (await honest.rows()).pendingSends.length === 0, 'and the honest answer finishes it', settled);

    console.log('\n== a receipt that fails does not lose the transfer');
    const ust = Object.assign(freshState(), { domains: JSON.parse(JSON.stringify(st.domains)) });
    const calm = Chain.create(envFor(alice, ust));
    const pending = async (w) => (await w.rows()).pendingSends;
    const onlyA = (hook) => async (url, init, forward) => (url.startsWith('http://' + A + '/') ? hook(url, init, forward) : null);
    const notA = (hook) => async (url, init, forward) => (url.startsWith('http://' + A + '/') ? null : hook(url, init, forward));
    const badSig = (r) => { if (r && r.entry && r.entry.index > 0) r.authoritySignature = 'AAAA'; };
    const failing = () => both(
      edit('action=propose', (j) => badSig(j.receipt)),
      edit('action=proposal', (j) => badSig(j.proposal && j.proposal.receipt)),
      edit('action=receipt&coin=', (j) => badSig(j.receipt))
    );
    const lyingA = through(alice, ust, onlyA(failing()));
    const liars = through(alice, ust, failing());

    // The domain committed the transfer and answers with a receipt that does not verify.
    const mark = sent;
    const p1 = await lyingA.prepareSend(A, sgl.id, bob.key, '3');
    const e1 = await lyingA.send(p1).catch((e) => e);
    line(e1.code === 'bad-receipt' && e1.unconfirmed === true && /^[0-9a-f]{64}$/.test(e1.digest || ''), 'a transfer the domain says it made, with a receipt that does not verify, is reported as unconfirmed', e1.code || e1);
    line(sent === mark + 1, 'and it is sent once');
    const committed = (await S.get(a, 'action=proposal&coin=' + sgl.id + '&digest=' + e1.digest)).json;
    line(committed.proposal && committed.proposal.status === 'executed', 'the domain did make that transfer, so a wallet that forgot it would have lost a real one', committed.proposal && committed.proposal.status);
    const k1 = await pending(calm);
    line(k1.length === 1 && k1[0].state === 'unconfirmed' && k1[0].digest === e1.digest && k1[0].authorization && k1[0].authorization.payload && k1[0].authorization.payload.amount === '300' && typeof k1[0].authorization.signature === 'string' && sha(canon(k1[0].authorization.payload)) === k1[0].digest, 'the wallet keeps the signed authorization and the digest that names it', k1);
    line(typeof k1[0].reason === 'string' && k1[0].reason.length > 0 && typeof k1[0].since === 'number', 'with the reason the receipt failed and when', k1[0]);

    // Asked again while the domain still gives a receipt that fails.
    const r1 = await lyingA.checkPending();
    const k2 = await pending(calm);
    line(r1.length === 1 && r1[0].outcome === 'unconfirmed' && k2.length === 1 && k2[0].state === 'unconfirmed' && Number.isInteger(k2[0].index) && k2[0].digest === e1.digest && !!k2[0].authorization, 'asked again, a receipt that still fails keeps it unconfirmed, with the entry the domain names', r1);
    line(sent === mark + 1, 'and nothing is sent again');
    const r1b = await liars.checkPending();
    line(r1b.length === 1 && r1b[0].outcome === 'unconfirmed' && (await pending(calm)).length === 1, 'a single authority coin has no other domain to ask, so it stays unconfirmed');
    const s1 = await calm.checkPending();
    line(s1.length === 1 && s1[0].outcome === 'done' && (await pending(calm)).length === 0 && sent === mark + 1, 'the domain\'s receipt, when it verifies, settles it, still without a second transfer', s1);

    // A public multi authority coin can be settled by the other domains of its roster.
    const p2 = await lyingA.prepareSend(A, allOf.id, bob.key, '4');
    const e2 = await lyingA.send(p2).catch((e) => e);
    line(e2.code === 'bad-receipt' && e2.unconfirmed === true && (await pending(calm)).length === 1, 'a full roster transfer with a receipt that fails is kept unconfirmed too', e2.code);
    const r2 = await lyingA.checkPending();
    line(r2.length === 1 && r2[0].outcome === 'done' && [B, C].includes(r2[0].confirmedBy) && (await pending(calm)).length === 0, 'and is settled by a receipt of a partner domain that verifies against the pinned roster', r2);
    const p3 = await lyingA.prepareSend(A, allOf.id, bob.key, '5');
    await lyingA.send(p3).catch(() => null);
    const r3 = await liars.checkPending();
    line(r3.length === 1 && r3[0].outcome === 'unconfirmed' && (await pending(calm)).length === 1, 'when the partners\' receipts fail as well it stays unconfirmed', r3);
    const wrongEntry = through(alice, ust, both(onlyA(failing()), notA(edit('action=receipt&coin=', (j) => { j.receipt = ok2.receipt; }))));
    const r3b = await wrongEntry.checkPending();
    line(r3b.length === 1 && r3b[0].outcome === 'unconfirmed', 'a partner that shows another real entry of the coin does not settle it', r3b);
    const r3c = await calm.checkPending();
    line(r3c.length === 1 && r3c[0].outcome === 'done' && (await pending(calm)).length === 0, 'the honest answer settles it', r3c);

    // A private coin names its accounts by reference, so another domain's receipt cannot show which transfer it was.
    const pmv = (await createCoin(a, 'PMV', { mode: 'multi', partners: [B, C], visibility: 'private' })).json;
    await op(a, 'open', { coinId: pmv.id });
    await op(a, 'grant', { coinId: pmv.id, to: alice.key, amount: '5000' });
    const p4 = await lyingA.prepareSend(A, pmv.id, bob.key, '1');
    const e4 = await lyingA.send(p4).catch((e) => e);
    const r4 = await lyingA.checkPending();
    line(e4.code === 'bad-receipt' && e4.unconfirmed === true && r4.length === 1 && r4[0].outcome === 'unconfirmed' && (await pending(calm)).length === 1, 'a private coin\'s transfer is not settled through other domains, and stays unconfirmed', r4);
    const r4b = await calm.checkPending();
    line(r4b.length === 1 && r4b[0].outcome === 'done' && (await pending(calm)).length === 0, 'until its own domain\'s receipt verifies', r4b);

    // The domain cannot be asked yet: nothing is judged.
    let afterPropose = false;
    const flaky = (fails) => async (url) => {
      if (url.includes('action=propose') || url.includes('action=purchase')) { afterPropose = true; return null; }
      return afterPropose ? fails(url) : null;
    };
    const mark2 = sent;
    afterPropose = false;
    const headDown = through(alice, ust, flaky((url) => (url.includes('action=head') ? { status: 503, json: { ok: false } } : null)));
    const w1 = await headDown.send(await headDown.prepareSend(A, sgl.id, bob.key, '1')).catch((e) => e);
    const kw1 = await pending(calm);
    line(w1.status === 'waiting' && kw1.length === 1 && kw1[0].state !== 'unconfirmed' && kw1[0].authorization && kw1[0].digest === w1.digest && sent === mark2 + 1, 'a domain whose history cannot be reached right after a transfer leaves it waiting, not failed or unconfirmed', w1.status || w1.code || w1);
    const gone = through(alice, ust, async (url) => { if (url.includes('action=head') || url.includes('action=proposal')) throw new Error('offline'); return null; });
    const wr = await gone.checkPending();
    line(wr.length === 0 || (wr[0].outcome !== 'done' && wr[0].outcome !== 'unconfirmed'), 'asked while the network is down, it is neither settled nor judged', wr);
    const kw2 = await pending(calm);
    line(kw2.length === 1 && kw2[0].state !== 'unconfirmed' && sent === mark2 + 1, 'and stays on the list, with nothing sent again', kw2);
    const w1done = await calm.checkPending();
    line(w1done.length === 1 && w1done[0].outcome === 'done' && (await pending(calm)).length === 0, 'when the domain answers, the transfer is settled', w1done);
    afterPropose = false;
    const coinDown = through(alice, ust, flaky((url) => { if (url.includes('action=coin&coin=')) throw new Error('offline'); return null; }));
    const w2 = await coinDown.send(await coinDown.prepareSend(A, sgl.id, bob.key, '1')).catch((e) => e);
    line(w2.status === 'waiting' && (await pending(calm)).length === 1 && (await pending(calm))[0].state !== 'unconfirmed', 'a coin\'s genesis that cannot be fetched right after a transfer leaves it waiting', w2.status || w2.code || w2);
    const w2done = await calm.checkPending();
    line(w2done.length === 1 && w2done[0].outcome === 'done' && (await pending(calm)).length === 0, 'and the honest answer settles it', w2done);

    // A purchase whose receipt fails.
    let boughtAt = null;
    const badBuy = through(alice, ust, edit('action=purchase', (j) => { boughtAt = j.receipt.entry.index; j.receipt.authoritySignature = 'AAAA'; }));
    const pb = await badBuy.prepareBuy(A, sgl.id, credential(100, alice), 100, '20');
    const eb = await badBuy.buy(pb).catch((e) => e);
    const kb = (await calm.rows()).pendingBuys;
    line(eb.code === 'bad-receipt' && eb.unconfirmed === true && eb.requestId === pb.requestId && kb.length === 1 && kb[0].state === 'unconfirmed' && kb[0].requestId === pb.requestId && kb[0].reason.length > 0, 'a purchase the domain says it made, with a receipt that does not verify, is kept unconfirmed under its request', eb.code || eb);
    const resumed = await calm.resumeBuy(pb.requestId);
    line(resumed.status === 'done' && resumed.receipt.entry.index === boughtAt && (await calm.rows()).pendingBuys.length === 0, 'the same request asked again is answered with the entry already made, so it is delivered once', resumed.receipt && resumed.receipt.entry);
    afterPropose = false;
    const buyDown = through(alice, ust, flaky((url) => (url.includes('action=head') ? { status: 503, json: { ok: false } } : null)));
    const pb2 = await buyDown.prepareBuy(A, sgl.id, credential(100, alice), 100, '20');
    const eb2 = await buyDown.buy(pb2).catch((e) => e);
    const kb2 = (await calm.rows()).pendingBuys;
    line(eb2.status === 'waiting' && kb2.length === 1 && kb2[0].state !== 'unconfirmed', 'a purchase whose receipt cannot be checked yet waits under its request, not judged', eb2.status || eb2.code || eb2);
    const resumed2 = await calm.resumeBuy(pb2.requestId);
    line(resumed2.status === 'done' && (await calm.rows()).pendingBuys.length === 0, 'and finishes when the domain answers', resumed2.status);

    // The list of waiting transfers is capped, but never at the cost of an unconfirmed one.
    const capped = Object.assign(freshState(), { domains: JSON.parse(JSON.stringify(st.domains)) });
    const stale = (i, state) => Object.assign({ domain: A, coinId: sgl.id, digest: String(i).padStart(64, '0'), to: bob.key, amount: '100', from: alice.key, symbol: 'SGL', decimals: 2, createdAt: 1000 + i }, state ? { state, reason: 'x', since: 1 } : {});
    capped.cache = { pendingSends: [stale(1, 'unconfirmed')].concat(Array.from({ length: 25 }, (_, i) => stale(100 + i))) };
    const wcap = Chain.create(envFor(alice, capped));
    const lyingCap = through(alice, capped, onlyA(failing()));
    await lyingCap.send(await lyingCap.prepareSend(A, sgl.id, bob.key, '1')).catch(() => null);
    const kept = (await wcap.rows()).pendingSends;
    line(kept.filter((p) => p.state === 'unconfirmed').length === 2 && kept.some((p) => p.digest === stale(1).digest) && kept.length === 22, 'an unconfirmed transfer is not pushed off the list by newer ones', kept.map((p) => p.state || 'waiting'));

    console.log('\n== the coin\'s genesis is pinned');
    const pinned = JSON.stringify((await honest.domains()).find((d) => d.domain === A));
    const real = (await S.get(a, 'action=coin&coin=' + sgl.id)).json;
    line(pinned.includes(real.genesisDigest), 'the wallet keeps the digest of the genesis it verified, with the domain\'s record', pinned.slice(0, 300));
    // A genesis for the same coin id that is consistent in itself (its digest is the digest of its own text) but is not the one pinned.
    const swappedGenesis = (mutate) => edit('action=coin&coin=', (j) => { mutate(j.genesis); j.genesisDigest = sha(canon(j.genesis)); });
    const newAuthorityKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'pem' });
    const keyChanged = through(alice, st, swappedGenesis((g) => { g.roster[0].key = newAuthorityKey; }));
    line(await refusedHere(keyChanged.send(await keyChanged.prepareSend(A, sgl.id, bob.key, '1')), 'genesis-changed'), 'a genesis with another key for the authority is refused before anything is signed, though its digest is consistent');
    const nameChanged = through(alice, st, swappedGenesis((g) => { g.name = 'Another coin'; }));
    line(await refusedHere(nameChanged.send(await nameChanged.prepareSend(A, sgl.id, bob.key, '1')), 'genesis-changed'), 'and so is any other change to a pinned genesis');
    const fresh = Chain.create(envFor(alice, Object.assign(freshState(), { domains: JSON.parse(JSON.stringify(st.domains)).map((d) => { delete d.genesis; delete d.genesisPins; delete d.pins; return d; }) })));
    const firstUse = await fresh.send(await fresh.prepareSend(A, sgl.id, bob.key, '1'));
    line(firstUse.status === 'done', 'a wallet from before the pins existed pins on first use and keeps working', firstUse);
    const forgedFirst = through(alice, Object.assign(freshState(), { domains: JSON.parse(JSON.stringify(st.domains)).map((d) => { for (const k of ['genesis', 'genesisPins', 'pins']) delete d[k]; return d; }) }), swappedGenesis((g) => { g.roster[0].key = newAuthorityKey; }));
    line(await refusedHere(forgedFirst.send(await forgedFirst.prepareSend(A, sgl.id, bob.key, '1')), 'wrong-genesis'), 'even at first use, a genesis whose authority key is not the key pinned for the domain is refused before anything is signed');
    const rosterKeyOff = through(alice, st, swappedGenesis((g) => { g.roster[1].key = newAuthorityKey; }));
    line(await refusedHere(rosterKeyOff.send(await rosterKeyOff.prepareSend(A, allOf.id, bob.key, '1')), 'genesis-changed') || await refusedHere(rosterKeyOff.send(await rosterKeyOff.prepareSend(A, allOf.id, bob.key, '1')), 'wrong-genesis'), 'a roster key that differs from the key pinned for a partner on the list is refused before anything is signed');

    console.log('\n== first contact');
    const loneState = freshState();
    const lone = Chain.create(envFor(alice, loneState));
    await lone.addDomain(A);
    await lone.offer(A, allOf.id);
    const pinOf = (stt, coinId) => (stt.domains.find((d) => d.domain === A).genesis || {})[coinId];
    const realAll = (await S.get(a, 'action=coin&coin=' + allOf.id)).json;
    line(pinOf(loneState, allOf.id) && pinOf(loneState, allOf.id).digest === realAll.genesisDigest && pinOf(loneState, allOf.id).unpinned.slice().sort().join() === B + ',' + C, 'the first genesis seen for a coin is pinned, with the roster domains whose keys the wallet could only take from it', pinOf(loneState, allOf.id));
    await lone.addDomain(B);
    line((await lone.offer(A, allOf.id)).unitsPerPrice === 10, 'a partner added later, whose key is the one in the genesis, changes nothing');
    // An authority that made up a coin whose partners' keys are its own: complete and consistent, so nothing at first sight shows it.
    const attacker = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const attackerPem = attacker.publicKey.export({ type: 'spki', format: 'pem' });
    const attackerSign = (text) => b64u(crypto.sign('sha256', Buffer.from(text), attacker.privateKey));
    const fakeG = JSON.parse(JSON.stringify(realAll.genesis));
    fakeG.roster[1].key = attackerPem; fakeG.roster[2].key = attackerPem;
    const fakeDigest = sha(canon(fakeG));
    const real0 = (await S.get(a, 'action=receipt&coin=' + allOf.id + '&index=0')).json.receipt;
    const fake0entry = Object.assign({}, real0.entry, { prevHash: fakeDigest });
    const fake0hash = sha(canon(fake0entry));
    const fake0 = { coinId: allOf.id, entry: fake0entry, hash: fake0hash, authoritySignature: derSign(a, fake0hash), approvals: [{ domain: A, signature: derSign(a, fakeDigest) }, { domain: B, signature: attackerSign(fakeDigest) }, { domain: C, signature: attackerSign(fakeDigest) }] };
    const madeUpCoin = both(
      edit('action=coin&coin=', (j) => { j.genesis = fakeG; j.genesisDigest = fakeDigest; }),
      edit('action=receipt&coin=' + allOf.id + '&index=0', (j) => { j.receipt = fake0; })
    );
    const victimState = freshState();
    const victim = through(alice, victimState, madeUpCoin);
    await victim.addDomain(A);
    const first = await victim.offer(A, allOf.id).catch((e) => e);
    line(first.unitsPerPrice === 10 && pinOf(victimState, allOf.id).unpinned.length === 2, 'the limit: a coin whose partners\' keys exist only in its own genesis is accepted at first sight, and the unconfirmed domains are recorded', first.code || pinOf(victimState, allOf.id));
    await victim.addDomain(B);
    line(await refusal(victim.offer(A, allOf.id)) === 'wrong-genesis', 'but once the real partner is on the list, the coin that names another key for it is refused');

    console.log('\n== purchase terms');
    const honestOffer = await honest.offer(A, sgl.id);
    line(honestOffer.unitsPerPrice === 10 && honestOffer.minPrice === 5, 'the terms of an honest domain are read', honestOffer);
    const cheaper = through(alice, freshState(), edit('action=coin&coin=', (j) => { j.genesis.purchase.unitsPerPrice = 1000; j.genesis.purchase.minPrice = 1; j.genesisDigest = sha(canon(j.genesis)); }));
    await cheaper.addDomain(A);
    line(await refusal(cheaper.offer(A, sgl.id)) !== 'none', 'terms edited in the plain answer, with a digest made to fit, are not offered');
    const unsigned = through(alice, freshState(), edit('action=coin&coin=', (j) => { j.genesis.purchase.perKeyUnits = '99999'; j.genesisDigest = sha(canon(j.genesis)); }));
    await unsigned.addDomain(A);
    const state = await unsigned.offerState(A, sgl.id);
    line(state.usable === false, 'and the coin is then not for sale', state);
    const lied = through(alice, st, edit('action=coin&coin=', (j) => { j.genesis.purchase.unitsPerPrice = 1000; j.genesisDigest = sha(canon(j.genesis)); }));
    const buyLied = await lied.prepareBuy(A, sgl.id, credential(100, alice), 100, '20').catch((e) => e);
    line(buyLied.code !== undefined, 'a purchase is not prepared from terms that are not the pinned genesis\'s', buyLied.units || buyLied.code);
    const delivered = await honest.buy(await honest.prepareBuy(A, sgl.id, credential(100, alice), 100, '20'));
    line(delivered.status === 'done' && delivered.receipt.entry.amount === '200', 'an honest purchase still completes, with a verified receipt', delivered.receipt && delivered.receipt.entry);
    const madeUpBuy = through(alice, st, edit('action=purchase', (j, s) => {
      const requestId = j.requestId;
      return { status: 201, json: { ok: true, requestId, receipt: Object.assign(fabricate(sgl.id, { amount: '200', from: j.receipt.entry.from, to: alice.key, purchase: { requestId, price: 20 } }, 99, a), {}), balance: j.balance } };
    }));
    const mb = await madeUpBuy.buy(await madeUpBuy.prepareBuy(A, sgl.id, credential(100, alice), 100, '20')).catch((e) => e);
    line(mb.code === 'bad-receipt', 'a purchase receipt that was not signed by the coin is not accepted', mb.code || mb);

    console.log('\n== nothing falls back to unsigned data');
    const noReceipt = through(alice, st, edit('action=propose', (j) => { delete j.receipt.approvals; }));
    line(await refusal(noReceipt.send(await noReceipt.prepareSend(A, allOf.id, bob.key, '1'))) === 'bad-receipt', 'a receipt missing a part is refused, not read as it stands');
    const noGenesis = through(alice, st, edit('action=coin&coin=', (j) => { delete j.genesisDigest; }));
    line(await refusedHere(noGenesis.send(await noGenesis.prepareSend(A, sgl.id, bob.key, '1')), 'wrong-genesis'), 'a coin answer with no digest is refused, and nothing is signed');
  } finally {
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHAIN-LABS WALLET VERIFICATION CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
