// The wallet module of the chain labs (extension/chain-labs-wallet.js) against three live PHP servers running the real
// endpoint (chain-labs/spend34.php), with the stand-in for the code that holds Gold:
//   - the domain list: adding a domain pins its key, and what stops a bad domain, a duplicate and an unreachable one
//   - the holdings lookup, public and signed, and what is ignored: a wrong signature, a wrong time, a wrong shape
//   - a domain that is down keeps its last answer while the others stay current
//   - sending: checks before signing, the receipt, a transfer that waits for approvals, the authority redirect
//   - buying with Gold: the offer, the checks, a sale that waits and is resumed with the same request id
//
//   node test/chain-labs-wallet.js
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('./support/chain-labs-servers');
const { A, B, C, D, nodes, issuerKey, POLICY, b64u, canon, wallet, start, stop, get, post, op, createCoin, units, NOW, iso, level, levelOk, headOf, hex, credential } = S;

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };

const Chain = require('../extension/chain-labs-wallet.js');

// The wallet environment: the identity is a Node wallet, a domain is reached on loopback with its own Host header.
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
    now: () => Date.now() + (state.skew || 0),
    ...over
  };
}
const freshState = () => ({ domains: [], cache: {}, skew: 0 });

(async () => {
  console.log('== amounts, names and signatures');
  line(Chain.formatUnits('1250', 2) === '12.5' && Chain.formatUnits('5', 2) === '0.05' && Chain.formatUnits('700', 0) === '700' && Chain.formatUnits('100', 2) === '1' && Chain.formatUnits('x', 2) === null, 'units are shown with the coin\'s decimals');
  line(Chain.parseAmount('12.5', 2) === '1250' && Chain.parseAmount('0.05', 2) === '5' && Chain.parseAmount('3', 0) === '3' && Chain.parseAmount(' 7 ', 2) === '700', 'an amount is read exactly');
  const badAmounts = ['0', '0.00', '-1', '1e3', '1,5', '1.234', '', '.5', '5.', 'abc', '99999999999999', '1 2'];
  line(badAmounts.every((x) => Chain.parseAmount(x, 2) === null) && Chain.parseAmount('1.5', 0) === null, 'and these are refused: zero, negatives, exponents, too many places, nonsense, too large', badAmounts.filter((x) => Chain.parseAmount(x, 2) !== null));
  line(Chain.normalizeDomain(' A.Example ') === 'a.example' && ['localhost', 'a', 'a.example/path', 'http://a.example', 'a.example:8080', '-a.example', ''].every((x) => Chain.normalizeDomain(x) === null), 'a domain is a plain lower-case host name');
  line(Chain.canonical({ b: 1, a: [true, 'x', { d: 2, c: 'é/' }] }) === '{"a":[true,"x",{"c":"é/","d":2}],"b":1}', 'the signed text sorts keys and has no spaces');
  const der = crypto.sign('sha256', Buffer.from('x'), { key: crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey });
  line(Chain.derToRaw(new Uint8Array(der)).length === 64 && Chain.derToRaw(new Uint8Array([1, 2, 3])) === null && Chain.derToRaw(new Uint8Array(der.subarray(0, der.length - 1))) === null, 'a DER signature becomes r||s and a damaged one is refused');

  for (const n of Object.values(nodes)) await start(n);
  const a = nodes[A], b = nodes[B], c = nodes[C];
  try {
    const alice = wallet(), bob = wallet();
    const st = freshState();
    const chain = Chain.create(envFor(alice, st));

    const sgl = (await createCoin(a, 'SGL')).json;
    const prv = (await createCoin(a, 'PRV', { visibility: 'private' })).json;
    const twoOf = (await createCoin(a, 'TWO', { mode: 'multi', partners: [B, C], threshold: 2 })).json;
    const allOf = (await createCoin(a, 'ALL', { mode: 'multi', partners: [B, C] })).json;
    const plain = (await createCoin(a, 'PLN')).json;
    for (const [coin, purchase] of [[sgl, POLICY], [prv, undefined], [twoOf, POLICY], [allOf, POLICY], [plain, undefined]]) {
      const r = await op(a, 'open', purchase ? { coinId: coin.id, purchase } : { coinId: coin.id });
      if (r.status !== 201) line(false, 'setup: a coin opens', r.json);
    }
    await op(a, 'grant', { coinId: sgl.id, to: alice.key, amount: '5000' });
    await op(a, 'grant', { coinId: prv.id, to: alice.key, amount: '700' });
    await op(a, 'grant', { coinId: twoOf.id, to: alice.key, amount: '3000' });
    await op(a, 'grant', { coinId: allOf.id, to: alice.key, amount: '3000' });

    console.log('\n== the list of domains');
    const rec = await chain.addDomain(A);
    line(rec.domain === A && /^[a-f0-9]{16}$/.test(rec.fingerprint) && st.domains.length === 1 && st.domains[0].key.includes('BEGIN PUBLIC KEY'), 'adding a domain pins the key it answers with and shows its fingerprint', rec);
    const dup = await chain.addDomain(A).catch((e) => e);
    line(dup.code === 'exists', 'a domain is on the list once', dup.message);
    line((await chain.addDomain('not a domain').catch((e) => e)).code === 'bad-domain' && (await chain.addDomain('http://' + A).catch((e) => e)).code === 'bad-domain', 'something that is not a host name is refused');
    const gone = await chain.addDomain(D).catch((e) => e);
    line(gone.code === 'network' && st.domains.length === 1, 'a domain that does not answer is not added', gone.message);
    const e2 = Chain.create(envFor(alice, freshState(), { fetch: async () => ({ status: 200, text: async () => JSON.stringify({ ok: true, domain: 'x.example', domainKey: 'nope', coins: [] }) }) }));
    line((await e2.addDomain(A).catch((er) => er)).code === 'not-chain-labs', 'and neither is one that answers with something else');
    await chain.addDomain(B);
    line((await chain.domains()).length === 2, 'a second domain joins the list');

    console.log('\n== holdings');
    const l1 = await chain.lookup(A);
    const byId = Object.fromEntries(l1.answer.coins.map((x) => [x.symbol, x]));
    line(l1.ok && l1.answer.proven === true && Object.keys(byId).sort().join() === 'ALL,PRV,SGL,TWO', 'a signed lookup lists every coin, private ones included, as proven', l1.answer.coins.map((x) => x.symbol));
    line(byId.SGL.units === '5000' && byId.SGL.mode === 'single' && byId.TWO.mode === 'multi' && byId.TWO.threshold === 2 && byId.PRV.visibility === 'private' && byId.SGL.seq === 0, 'with balance, mode, threshold, visibility and the account\'s position');
    const view = await chain.rows();
    const ra = view.domains.find((d) => d.domain === A);
    line(ra.coins.find((x) => x.symbol === 'SGL').amount === '50' && !ra.stale && ra.problem === null && ra.proven, 'the tab reads the amount with the coin\'s decimals and marks it current and proven', ra);
    const noSign = Chain.create(envFor(alice, (() => { const s = freshState(); s.domains = JSON.parse(JSON.stringify(st.domains)); return s; })(), { sign: async () => { throw new Error('passkey'); } }));
    const pub = await noSign.lookup(A);
    line(pub.ok && pub.answer.proven === false && pub.answer.coins.map((x) => x.symbol).sort().join() === 'ALL,SGL,TWO', 'a wallet that cannot sign for a ledger sees public coins only and the answer is not marked proven', pub.answer);
    const rb = await chain.lookup(B);
    line(rb.ok && rb.answer.coins.length >= 0 && rb.answer.fetchedAt !== null, 'a partner answers too');

    const bobState = freshState();
    const bobChain = Chain.create(envFor(bob, bobState));
    await bobChain.addDomain(A);
    const bl = await bobChain.lookup(A);
    line(bl.ok && bl.answer.coins.length === 0, 'a key with nothing there gets an empty list, not an error');
    line((await chain.lookup(C).catch((e) => e)).code === 'not-listed', 'a domain that is not on the list is not asked');

    console.log('\n== what is ignored');
    const wrongKey = freshState();
    wrongKey.domains = JSON.parse(JSON.stringify(st.domains));
    wrongKey.domains[0].key = st.domains[1].key;
    const w1 = Chain.create(envFor(alice, wrongKey));
    const bad = await w1.lookup(A);
    line(!bad.ok && bad.reason === 'bad-signature', 'an answer signed by another key than the pinned one is ignored', bad);
    const vr = await w1.rows();
    line(vr.domains[0].problem && vr.domains[0].coins.length === 0, 'and the tab says so and shows nothing for it', vr.domains[0]);
    const skewed = freshState();
    skewed.domains = JSON.parse(JSON.stringify(st.domains));
    skewed.skew = 20 * 60 * 1000;
    const w2 = Chain.create(envFor(alice, skewed));
    const late = await w2.lookup(A);
    line(!late.ok && late.reason === 'clock', 'an answer whose time does not fit this device\'s clock is ignored', late);
    const rewrite = (fn) => Chain.create(envFor(alice, Object.assign(freshState(), { domains: JSON.parse(JSON.stringify(st.domains)) }), {
      fetch: async (url, init) => { const res = await envFor(alice, st).fetch(url, init); const text = await res.text(); return { status: res.status, text: async () => fn(url, text) }; }
    }));
    const tamper = rewrite((url, text) => { if (!url.includes('action=holdings')) return text; const j = JSON.parse(text); j.statement.coins[0].units = '999999'; return JSON.stringify(j); });
    line((await tamper.lookup(A)).reason === 'bad-signature', 'a statement changed after it was signed is ignored');
    const reshaped = rewrite((url, text) => { if (!url.includes('action=holdings')) return text; const j = JSON.parse(text); j.statement.extra = 1; return JSON.stringify(j); });
    line((await reshaped.lookup(A)).reason === 'unreadable', 'a statement with fields the wallet does not know is ignored');
    const huge = rewrite((url, text) => (url.includes('action=holdings') ? text + ' '.repeat(300000) : text));
    line((await huge.lookup(A)).reason === 'unreadable', 'and so is one larger than the size the wallet reads');
    const replay = rewrite((url, text) => { if (!url.includes('action=holdings')) return text; const j = JSON.parse(text); j.statement.proven = false; return JSON.stringify(j); });
    line(!(await replay.lookup(A)).ok, 'a statement that claims less than was asked for is ignored');

    // Statements the domain's own key signed but that are not what was asked for or not in the form the wallet reads.
    const resigned = (fn) => rewrite((url, text) => {
      if (!url.includes('action=holdings')) return text;
      const j = JSON.parse(text);
      fn(j.statement);
      j.signature = b64u(crypto.sign('sha256', Buffer.from(canon(j.statement)), a.pair.privateKey));
      return JSON.stringify(j);
    });
    const reasonOf = async (fn) => (await resigned(fn).lookup(A)).reason;
    line(await reasonOf((x) => { x.domain = B; }) === 'not-for-this-request' && await reasonOf((x) => { x.key = bob.key; }) === 'not-for-this-request', 'a signed statement for another domain or another key is ignored');
    line(await reasonOf((x) => { x.type = 'atlas.ledger.other'; }) === 'not-for-this-request' && await reasonOf((x) => { x.v = 3; }) === 'unreadable' && await reasonOf((x) => { x.v = 1; }) === 'unreadable' && await reasonOf((x) => { delete x.nonce; }) === 'unreadable' && await reasonOf((x) => { x.proven = false; }) === 'not-for-this-request', 'and so is one of another kind, another version, or one that is less proven than asked');
    line(await reasonOf((x) => { x.asOf = iso(NOW() + 600); }) === 'clock' && await reasonOf((x) => { x.asOf = iso(NOW() - 600); }) === 'clock', 'a signed statement dated ten minutes ahead or behind is ignored');
    line(await reasonOf((x) => { x.coins[0].headHash = 'xyz'; }) === 'unreadable' && await reasonOf((x) => { delete x.coins[0].seq; }) === 'unreadable' && await reasonOf((x) => { x.coins[0].extra = 1; }) === 'unreadable' && await reasonOf((x) => { x.coins[0].units = '-5'; }) === 'unreadable' && await reasonOf((x) => { x.coins[0].symbol = 'bad symbol'; }) === 'unreadable', 'a coin with a bad hash, a missing or extra field, a bad amount or a bad symbol makes the statement unreadable');
    line(await reasonOf((x) => { x.coins = x.coins.concat(Array(101).fill(x.coins[0])); }) === 'unreadable' && await reasonOf((x) => { x.coins = 'none'; }) === 'unreadable', 'and so does a list that is too long or not a list');
    let signed = 0;
    const oddChallenge = Chain.create(envFor(alice, Object.assign(freshState(), { domains: JSON.parse(JSON.stringify(st.domains)) }), {
      sign: async (p) => { signed++; return { publicKey: alice.key, signature: alice.sign(p) }; },
      fetch: async (url, init) => { const res = await envFor(alice, st).fetch(url, init); if (!url.includes('action=challenge')) return res; return { status: res.status, text: async () => JSON.stringify({ ok: true, challenge: 'sign this: ' + 'x'.repeat(40) }) }; }
    }));
    const oc = await oddChallenge.lookup(A);
    line(!oc.ok && signed === 0, 'a challenge that is not 32 hex characters is never signed', oc);
    const frozenView = resigned((x) => { x.coins.find((c) => c.symbol === 'SGL').state = 'frozen'; });
    line((await frozenView.prepareSend(A, sgl.id, bob.key, '1').catch((e) => e)).code === 'not-active', 'a coin the domain says is frozen takes no transfer from the wallet');

    console.log('\n== a domain that is down');
    await stop(b);
    const before = (await chain.rows()).domains.find((d) => d.domain === B);
    const down = await chain.refresh();
    const rA = down.domains.find((d) => d.domain === A), rB = down.domains.find((d) => d.domain === B);
    line(rA.problem === null && rA.coins.length === 4 && rB.problem !== null && rB.fetchedAt === before.fetchedAt, 'the other domain stays current and the one that is down keeps its last answer with the problem', [rA.problem, rB.problem]);
    await start(b);
    line((await chain.refresh()).domains.every((d) => d.problem === null), 'and it recovers when the domain is back');

    console.log('\n== sending');
    const sendOf = (domain, coinId, to, amount) => chain.prepareSend(domain, coinId, to, amount);
    const refusal = async (p) => (await p.catch((e) => e)).code;
    line(await refusal(sendOf(A, sgl.id, 'nonsense', '1')) === 'bad-recipient' && await refusal(sendOf(A, sgl.id, alice.key, '1')) === 'bad-recipient', 'a recipient that is not a key, or is the sender\'s own, is refused before signing');
    line(await refusal(sendOf(A, sgl.id, bob.key, '0.001')) === 'bad-amount' && await refusal(sendOf(A, sgl.id, bob.key, '0')) === 'bad-amount', 'an amount with too many places, or zero, is refused before signing');
    line(await refusal(sendOf(A, sgl.id, bob.key, '50.01')) === 'insufficient', 'more than the balance is refused before signing');
    line(await refusal(sendOf(A, 'f'.repeat(32), bob.key, '1')) === 'unknown-coin', 'a coin the domain does not list is refused');
    const p1 = await sendOf(A, sgl.id, bob.key, '12.5');
    line(p1.amount === '1250' && p1.text.includes('12.5 SGL') && p1.text.includes(A), 'a prepared transfer says what will be signed', p1.text);
    const s1 = await chain.send(p1);
    line(s1.status === 'done' && s1.receipt.entry.amount === '1250' && s1.receipt.entry.to === bob.key, 'sending executes the transfer and the receipt matches', s1);
    const after = (await chain.rows()).domains.find((d) => d.domain === A).coins.find((x) => x.symbol === 'SGL');
    line(after.units === '3750' && after.amount === '37.5', 'and the tab shows the new balance');
    line((await bobChain.lookup(A)).answer.coins.find((x) => x.symbol === 'SGL').units === '1250', 'the recipient sees it');
    const p2 = await sendOf(A, prv.id, bob.key, '1');
    const s2 = await chain.send(p2);
    const bobPublic = Chain.create(envFor(bob, Object.assign(freshState(), { domains: JSON.parse(JSON.stringify(bobState.domains)) }), { sign: async () => { throw new Error('passkey'); } }));
    line(s2.status === 'done' && (await bobPublic.lookup(A)).answer.coins.every((x) => x.symbol !== 'PRV') && (await bobChain.lookup(A)).answer.coins.find((x) => x.symbol === 'PRV').units === '100', 'a private coin is sent too; the recipient sees it in a signed lookup and not in a public one', s2.status);
    const forgedReceipt = rewrite((url, text) => { if (!url.includes('action=propose')) return text; const j = JSON.parse(text); if (j.receipt) j.receipt.entry.amount = '1'; return JSON.stringify(j); });
    const fr = await forgedReceipt.prepareSend(A, sgl.id, bob.key, '1').then((p) => forgedReceipt.send(p)).catch((e) => e);
    line(fr.code === 'bad-receipt', 'a receipt that does not match what was signed is not accepted', fr.message);

    let staleOnce = true;
    const flaky = Chain.create(envFor(alice, Object.assign(freshState(), { domains: JSON.parse(JSON.stringify(st.domains)) }), {
      fetch: async (url, init) => {
        if (staleOnce && url.includes('action=propose')) { staleOnce = false; return { status: 409, text: async () => JSON.stringify({ ok: false, code: 'stale', error: 'stale' }) }; }
        return envFor(alice, st).fetch(url, init);
      }
    }));
    const sf = await flaky.prepareSend(A, sgl.id, bob.key, '0.5').then((p) => flaky.send(p)).catch((e) => e);
    line(sf.status === 'done' && staleOnce === false, 'a transfer made against a balance that moved is signed again once and goes through', sf);
    const wrongCoin = rewrite((url, text) => { if (!url.includes('action=propose')) return text; const j = JSON.parse(text); if (j.receipt) j.receipt.entry.coinId = 'f'.repeat(32); return JSON.stringify(j); });
    line((await wrongCoin.prepareSend(A, sgl.id, bob.key, '0.5').then((p) => wrongCoin.send(p)).catch((e) => e)).code === 'bad-receipt', 'a receipt for another coin is not accepted');

    // A signature names the domain that issues the coin and the digest of its genesis, read from the domain and checked before signing.
    const sent = [];
    const watching = Chain.create(envFor(alice, Object.assign(freshState(), { domains: JSON.parse(JSON.stringify(st.domains)) }), {
      fetch: async (url, init) => { if (url.includes('action=propose')) sent.push(JSON.parse(init.body)); return envFor(alice, st).fetch(url, init); }
    }));
    const coinNow = (await get(nodes[A], 'action=coin&coin=' + sgl.id)).json;
    const sw = await watching.prepareSend(A, sgl.id, bob.key, '0.25').then((p) => watching.send(p)).catch((e) => e);
    const sp = sent[0] && sent[0].authorization && sent[0].authorization.payload;
    line(sw.status === 'done' && sp && sp.v === 2 && sp.authority === A && sp.genesis === coinNow.genesisDigest && /^[a-f0-9]{64}$/.test(sp.baseHead), 'a signed transfer names the issuing domain, the genesis digest and the base head', sp);
    const noteDigest = (g) => crypto.createHash('sha256').update(canon(g)).digest('hex');
    const ownGenesis = rewrite((url, text) => { if (!/action=coin&/.test(url)) return text; const j = JSON.parse(text); j.genesis.symbol = 'EVL'; return JSON.stringify(j); });
    const og = await ownGenesis.prepareSend(A, sgl.id, bob.key, '0.5').then((p) => ownGenesis.send(p)).catch((e) => e);
    line(og.code === 'wrong-genesis', 'a genesis that does not match the digest the domain gives is not signed for', og.code);
    const proposed = [];
    const fa = Chain.create(envFor(alice, Object.assign(freshState(), { domains: JSON.parse(JSON.stringify(st.domains)) }), {
      fetch: async (url, init) => {
        if (url.includes('action=propose')) proposed.push(url);
        const res = await envFor(alice, st).fetch(url, init); const text = await res.text();
        return { status: res.status, text: async () => (/action=coin&/.test(url) ? (() => { const j = JSON.parse(text); j.genesis.authority = 'elsewhere.example'; j.genesis.roster = [{ domain: 'elsewhere.example', key: 'x' }]; j.genesisDigest = noteDigest(j.genesis); return JSON.stringify(j); })() : text) };
      }
    }));
    const fr2 = await fa.prepareSend(A, sgl.id, bob.key, '0.5').then((p) => fa.send(p)).catch((e) => e);
    line(fr2.code === 'wrong-authority' && proposed.length === 0, 'a coin whose authority and roster do not include the domain being asked is not signed for, and nothing is sent', fr2.code);

    console.log('\n== a transfer that waits for approvals');
    await stop(c);
    const p3 = await sendOf(A, allOf.id, bob.key, '5');
    const s3 = await chain.send(p3);
    line(s3.status === 'waiting' && /^[a-f0-9]{64}$/.test(s3.digest), 'with a partner down, a coin that needs every domain answers waiting', s3);
    line((await chain.rows()).pendingSends.length === 1 && (await chain.checkPending()).length === 0, 'the wallet keeps the waiting transfer and it is still waiting');
    const second = await sendOf(A, allOf.id, bob.key, '5');
    const twice = await chain.send(second).catch((e) => e);
    line(twice.code === 'pending-exists', 'a second transfer while one waits is refused with a plain message', twice.message);
    await start(c);
    await op(a, 'recover', { coinId: allOf.id });
    const finished = await chain.checkPending();
    line(finished.length === 1 && finished[0].outcome === 'done' && (await chain.rows()).pendingSends.length === 0, 'once the partner is back and the authority recovers, the wallet learns it was made', finished);

    console.log('\n== a coin sent from a partner');
    for (const n of [b]) await get(n, 'action=coin&coin=' + twoOf.id);
    const viaB = await chain.lookup(B);
    const hasTwo = viaB.answer.coins.find((x) => x.symbol === 'TWO');
    line(hasTwo && hasTwo.units === '3000', 'a partner lists the coin it holds a copy of', viaB.answer.coins);
    const pb = await sendOf(B, twoOf.id, bob.key, '1');
    const sb = await chain.send(pb).catch((e) => e);
    line(sb.code === 'not-authority' && sb.message.includes(A), 'a transfer sent through a partner is pointed at the authority', sb.message);

    console.log('\n== buying with Gold');
    const o = await chain.offer(A, sgl.id);
    line(o.unitsPerPrice === 10 && o.minPrice === 5 && o.symbol === 'SGL', 'the offer is read from the coin\'s genesis', o);
    line(await refusal(chain.offer(A, plain.id)) === 'no-purchase-policy', 'a coin with no policy has no offer');
    line(await refusal(chain.offer(A, 'f'.repeat(32))) === 'no-purchase-policy', 'and neither does a coin the domain does not know');
    const sgs = await chain.offerState(A, sgl.id);
    line(sgs.usable === true && sgs.terms.unitsPerPrice === 10, 'Buy is offered for a coin with terms on a domain that takes the Gold', sgs);
    const pls = await chain.offerState(A, plain.id);
    line(pls.usable === false && pls.code === 'no-purchase-policy', 'and not for a coin with no terms', pls);
    const nos = await chain.offerState(A, 'f'.repeat(32));
    line(nos.usable === false, 'nor for a coin the domain does not know', nos);
    const adapter = require('path').join(a.priv, 'gold-adapter.php');
    const fs = require('fs');
    fs.renameSync(adapter, adapter + '.off');
    const cached = await chain.offerState(A, sgl.id);
    line(cached.usable === true, 'an answer is kept for a short while, so drawing the list does not ask the domain every time');
    st.skew += 60000;
    const noAdapter = await chain.offerState(A, sgl.id);
    const refusedOffer = await refusal(chain.offer(A, sgl.id));
    fs.renameSync(adapter + '.off', adapter);
    line(noAdapter.usable === false && noAdapter.code === 'purchases-off' && refusedOffer === 'purchases-off', 'a domain without the Gold adapter is not for sale, whatever the genesis says, and the answer is asked again after a while', [noAdapter, refusedOffer]);
    st.skew += 60000;
    line((await chain.offerState(A, sgl.id)).usable === true, 'and it is for sale again once the domain can take the Gold');
    st.skew -= 120000;
    const gold = credential(100, alice);
    line(await refusal(chain.prepareBuy(A, sgl.id, gold, 100, '4')) === 'purchase-too-small', 'a price under the minimum is refused before signing');
    line(await refusal(chain.prepareBuy(A, sgl.id, gold, 100, '101')) === 'bad-amount', 'and so is a price over what the credential holds');
    line(await refusal(chain.prepareBuy(A, sgl.id, { class: 'x' }, 100, '10')) === 'bad-credential', 'and a credential with no id');
    const pbuy = await chain.prepareBuy(A, sgl.id, gold, 100, '20');
    line(pbuy.units === '200' && pbuy.text.includes('Pay 20 Gold') && pbuy.text.includes('2 SGL'), 'a prepared purchase says what is paid and what is received', pbuy.text);
    const bought = await chain.buy(pbuy);
    line(bought.status === 'done' && bought.receipt.entry.amount === '200' && bought.balance.balance.quantity === 80, 'buying delivers the coin and returns the Gold that is left', bought);
    line((await chain.rows()).pendingBuys.length === 0, 'and nothing is left waiting');
    const sgBal = (await chain.rows()).domains.find((d) => d.domain === A).coins.find((x) => x.symbol === 'SGL');
    line(sgBal.units === '3725', 'the balance includes the purchase (5000, less 1250, 100, 50, 50 and 25 sent, plus 200)', sgBal);
    const wrongRequest = rewrite((url, text) => { if (!url.includes('action=purchase')) return text; const j = JSON.parse(text); j.requestId = 'a'.repeat(32); return JSON.stringify(j); });
    const wr = await wrongRequest.buy(await wrongRequest.prepareBuy(A, sgl.id, credential(100, alice), 100, '5')).catch((e) => e);
    line(wr.code === 'bad-receipt', 'a purchase result for another request is not accepted', wr.message);
    const spentAgain = await chain.buy(await chain.prepareBuy(A, sgl.id, gold, 100, '20')).catch((e) => e);
    line(spentAgain.code === 'locked' && (await chain.rows()).pendingBuys.length === 0, 'the same Gold cannot be spent twice, and the refused purchase is not kept', spentAgain.message);
    const forged = (() => { const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }); const p = { id: hex(12), class: 'atlas.element.gold', quantity: 100, owner: alice.key }; return { ...p, signature: b64u(crypto.sign('sha256', Buffer.from(canon(p)), other.privateKey)) }; })();
    const fb = await chain.buy(await chain.prepareBuy(A, sgl.id, forged, 100, '20')).catch((e) => e);
    line(fb.code === 'bad-purchase', 'a credential the issuer did not sign is refused', fb.message);
    line(/The domain said: .+/.test(fb.message) && fb.message.startsWith('The domain did not accept the credential or the purchase.'), 'and the message carries the domain\'s own reason', fb.message);
    const lim = await chain.buy(await chain.prepareBuy(A, sgl.id, credential(600, alice), 600, '600')).catch((e) => e);
    line(lim.code === 'purchase-key-limit', 'a purchase past the key\'s limit is refused with a plain message', lim.message);
    const wrongPlace = await chain.prepareBuy(B, twoOf.id, credential(100, alice), 100, '20').catch((e) => e);
    line(wrongPlace.code === 'not-authority' && wrongPlace.message.includes(A), 'a purchase is made at the coin\'s authority only', wrongPlace.message);

    console.log('\n== a purchase that waits');
    await stop(c);
    const waitGold = credential(100, alice);
    const pw = await chain.prepareBuy(A, allOf.id, waitGold, 100, '20');
    const bw = await chain.buy(pw);
    line(bw.status === 'waiting' && (await chain.rows()).pendingBuys.length === 1, 'with a partner down the sale waits and the wallet keeps the request', bw);
    const lockedElsewhere = await chain.buy(await chain.prepareBuy(A, allOf.id, waitGold, 100, '20')).catch((e) => e);
    line(lockedElsewhere.code === 'locked', 'the credential cannot be used for another sale meanwhile', lockedElsewhere.message);
    await start(c);
    const resumed = await chain.resumeBuy(pw.requestId);
    line(resumed.status === 'done' && resumed.receipt.entry.purchase.requestId === pw.requestId && (await chain.rows()).pendingBuys.length === 0, 'the same request, signed again, finishes it once the partner is back', resumed);
    const delivered = await post(a, 'action=holdings', { key: alice.key });
    line(delivered.json.statement.coins.find((x) => x.coinId === allOf.id).units === '2700', 'the coin was delivered once (3000, less the 5.00 sent, plus 200)');


    console.log('\n== a domain whose database is put back from an older copy');
    const dave = wallet();
    const rlb = (await createCoin(a, 'RLB')).json;
    await op(a, 'open', { coinId: rlb.id });
    await op(a, 'grant', { coinId: rlb.id, to: dave.key, amount: '1000' });
    const daveState = freshState();
    const daveChain = Chain.create(envFor(dave, daveState));
    await daveChain.addDomain(A);
    const first = await daveChain.lookup(A);
    const keptOf = () => (daveState.domains.find((d) => d.domain === A).heads || {})[rlb.id];
    line(first.ok && keptOf() && keptOf().index === 1 && !keptOf().suspect, 'a verified statement leaves the coin\'s head in the domain list', keptOf());
    const dbFile = path.join(a.priv, 'chain34.sqlite');
    await stop(a);
    const oldCopy = path.join(path.dirname(dbFile), 'chain34-old-' + process.pid + '.sqlite');
    fs.copyFileSync(dbFile, oldCopy);
    await start(a);
    const spend = await daveChain.send(await daveChain.prepareSend(A, rlb.id, bob.key, '1'));
    line(spend.status === 'done' && (await daveChain.lookup(A)).ok && keptOf().index === 2, 'a later statement moves the kept head up', keptOf());
    await stop(a);
    for (const x of ['', '-wal', '-shm']) fs.rmSync(dbFile + x, { force: true });
    fs.copyFileSync(oldCopy, dbFile);
    await start(a);
    line((await units(a, dave, rlb.id)) === '1000', 'the database holds the balance dave had before he spent');
    const looked = await daveChain.lookup(A);
    const markedRow = (await daveChain.rows()).domains.find((d) => d.domain === A).coins.find((x) => x.coinId === rlb.id);
    line(looked.ok && keptOf().index === 2 && keptOf().suspect && keptOf().suspect.kind === 'rollback-suspected' && keptOf().suspect.index === 1, 'a signed statement with a lower entry is not believed and the kept head stays', keptOf());
    line(markedRow.integrity && markedRow.integrity.code === 'rollback-suspected' && markedRow.integrity.trusted.index === 2 && markedRow.integrity.seen.index === 1, 'the tab is told what was trusted and what is seen now', markedRow.integrity);
    const refusedSend = await daveChain.prepareSend(A, rlb.id, bob.key, '1').catch((e) => e);
    line(refusedSend.code === 'rollback-suspected', 'a send is refused before anything is signed', refusedSend.code);
    const noLine = (await get(a, 'action=coin&coin=' + rlb.id)).json.head.index;
    line(noLine === 1 && (await units(a, bob, rlb.id)) === '0', 'and nothing reached the domain');
    const refusedBuy = await daveChain.prepareBuy(A, rlb.id, 'credential', 5, '1').catch((e) => e);
    line(refusedBuy.code === 'rollback-suspected', 'a purchase is not prepared either', refusedBuy.code);
    await daveChain.lookup(A);
    line(keptOf().index === 2 && keptOf().suspect.kind === 'rollback-suspected', 'asking again does not clear the mark while the domain still shows less');

    console.log('\n== the domain recovers');
    const replayAll = await op(a, 'restore', { coinId: rlb.id });
    line(replayAll.status === 200, 'the domain brings its entries back (a database copy that still holds them, put back, does the same)', replayAll.json);
    const healed = await daveChain.lookup(A);
    line(healed.ok && keptOf().index === 2 && !keptOf().suspect, 'the mark goes when the domain shows the kept entry again', keptOf());
    const okSend = await daveChain.prepareSend(A, rlb.id, bob.key, '1').catch((e) => e);
    line(okSend.amount === '100', 'and the coin can be sent again', [okSend.code, okSend.message]);

    console.log('\n== another history at the same entry');
    const forgedState = freshState();
    forgedState.domains = JSON.parse(JSON.stringify(daveState.domains));
    const forgedChain = Chain.create(envFor(dave, forgedState, {
      fetch: async (url, init) => { const res = await envFor(dave, daveState).fetch(url, init); const text = await res.text(); if (!url.includes('action=holdings')) return { status: res.status, text: async () => text }; const j = JSON.parse(text); j.statement.coins.find((x) => x.coinId === rlb.id).headHash = 'a'.repeat(64); j.signature = b64u(crypto.sign('sha256', Buffer.from(canon(j.statement)), a.pair.privateKey)); return { status: res.status, text: async () => JSON.stringify(j) }; }
    }));
    const keptNow0 = daveState.domains.find((d) => d.domain === A).heads[rlb.id];
    await forgedChain.lookup(A);
    const fKept = () => forgedState.domains.find((d) => d.domain === A).heads[rlb.id];
    line(fKept().suspect && fKept().suspect.kind === 'history-conflict' && (await forgedChain.prepareSend(A, rlb.id, bob.key, '1').catch((e) => e)).code === 'history-conflict', 'a different hash at the kept entry is marked and stops sends', fKept());
    const sus = fKept().suspect;
    const refusals = [
      (await forgedChain.acceptHead(A, rlb.id).catch((e) => e)).code,
      (await forgedChain.acceptHead(A, rlb.id, {}).catch((e) => e)).code,
      (await forgedChain.acceptHead(A, rlb.id, { index: sus.index, hash: 'b'.repeat(64) }).catch((e) => e)).code,
      (await forgedChain.acceptHead(A, rlb.id, { index: sus.index + 1, hash: sus.hash }).catch((e) => e)).code
    ];
    line(refusals.join() === 'confirm-needed,confirm-needed,confirm-mismatch,confirm-mismatch' && fKept().suspect && fKept().hash === keptNow0.hash, 'trusting a domain\'s state needs the state that was shown, repeated exactly; nothing less changes anything', refusals);
    await forgedChain.lookup(A);
    await forgedChain.refresh();
    line(fKept().suspect && fKept().hash === keptNow0.hash, 'and asking the domain again, or all of them, never clears the mark on its own');
    await forgedChain.acceptHead(A, rlb.id, { index: sus.index, hash: sus.hash });
    line(!fKept().suspect && fKept().hash === 'a'.repeat(64), 'trusting what the domain says now replaces the kept head and clears the mark', fKept());
    line((await forgedChain.acceptHead(A, rlb.id, { index: sus.index, hash: sus.hash }).catch((e) => e)).code === 'nothing-to-accept', 'and there is nothing to accept when nothing is marked');

    console.log('\n== a higher entry that does not continue the kept one');
    const headReply = (index, hash, signWith) => {
      const payload = { type: 'atlas.ledger.head', v: 1, coinId: rlb.id, domain: A, index, hash, issuedAt: iso(NOW()) };
      return { ok: true, head: { payload, signature: b64u(crypto.sign('sha256', Buffer.from(canon(payload)), (signWith || a.pair).privateKey)), authoritySignature: null, public: null }, state: 'active' };
    };
    const claimsHigher = (idx, hash, headAnswer) => {
      const state = freshState();
      state.domains = JSON.parse(JSON.stringify(daveState.domains));
      const calls = { purchase: 0, head: [] };
      const w = Chain.create(envFor(dave, state, {
        fetch: async (url, init) => {
          const res = await envFor(dave, daveState).fetch(url, init);
          const text = await res.text();
          if (url.includes('action=purchase')) calls.purchase++;
          if (url.includes('action=holdings')) {
            const j = JSON.parse(text);
            const c = j.statement.coins.find((x) => x.coinId === rlb.id);
            c.headIndex = idx; c.headHash = hash;
            j.signature = b64u(crypto.sign('sha256', Buffer.from(canon(j.statement)), a.pair.privateKey));
            return { status: 200, text: async () => JSON.stringify(j) };
          }
          if (url.includes('action=head')) {
            const at = /index=(\d+)/.exec(url);
            calls.head.push(at ? Number(at[1]) : null);
            const answer = headAnswer(at ? Number(at[1]) : null, text, res);
            return { status: answer.status || 200, text: async () => (typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)) };
          }
          return { status: res.status, text: async () => text };
        }
      }));
      return { w, state, calls, kept: () => state.domains.find((d) => d.domain === A).heads[rlb.id] };
    };
    const keptNow = daveState.domains.find((d) => d.domain === A).heads[rlb.id];
    const otherHash = 'd'.repeat(64);

    const fork = claimsHigher(5, 'c'.repeat(64), (at) => ({ body: headReply(at === null ? 5 : at, at === null ? 'c'.repeat(64) : otherHash) }));
    await fork.w.lookup(A);
    line(fork.kept().suspect && fork.kept().suspect.kind === 'history-conflict' && fork.kept().index === keptNow.index && fork.kept().hash === keptNow.hash, 'a higher head whose history holds another entry at the kept index is a conflict, and the kept head does not move', fork.kept());
    line((await fork.w.prepareSend(A, rlb.id, bob.key, '1').catch((e) => e)).code === 'history-conflict', 'and a send on it is refused');

    const silent = claimsHigher(5, 'c'.repeat(64), () => ({ status: 404, body: { ok: false, code: 'unknown-entry' } }));
    await silent.w.lookup(A);
    const silentSend = await silent.w.prepareSend(A, rlb.id, bob.key, '1').catch((e) => e);
    line(silent.kept().index === keptNow.index && silent.kept().hash === keptNow.hash && !silent.kept().suspect && silentSend.code === 'history-unproven', 'a domain that will not show the kept entry is not believed: the kept head stays and a send is refused', [silent.kept(), silentSend.code]);
    line((await silent.w.rows()).domains.find((d) => d.domain === A).problem === null && silent.calls.head.includes(keptNow.index), 'while the tab still shows the domain\'s answer, and the wallet asked for the kept entry');

    const ignoring = claimsHigher(5, 'c'.repeat(64), () => ({ body: headReply(5, 'c'.repeat(64)) }));
    await ignoring.w.lookup(A);
    line(ignoring.kept().index === keptNow.index && !ignoring.kept().suspect && (await ignoring.w.prepareSend(A, rlb.id, bob.key, '1').catch((e) => e)).code === 'history-unproven', 'a domain that answers with its newest entry instead of the one asked for is not believed either');

    const forgedSig = claimsHigher(5, 'c'.repeat(64), (at) => ({ body: headReply(at === null ? 5 : at, keptNow.hash, { privateKey: crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey }) }));
    await forgedSig.w.lookup(A);
    line(forgedSig.kept().index === keptNow.index && (await forgedSig.w.prepareSend(A, rlb.id, bob.key, '1').catch((e) => e)).code === 'history-unproven', 'an attestation signed by another key proves nothing');

    const extend = claimsHigher(5, 'c'.repeat(64), (at, text) => ({ body: headReply(at === null ? 5 : at, at === null ? 'c'.repeat(64) : keptNow.hash) }));
    await extend.w.lookup(A);
    line(extend.kept().index === 5 && extend.kept().hash === 'c'.repeat(64) && !extend.kept().suspect, 'a higher head the domain shows to pass through the kept entry moves the kept head up');

    console.log('\n== a purchase weighs the head now, before any Gold is sent');
    const prep = { domain: A, coinId: rlb.id, credential: 'x', price: 5, requestId: 'a'.repeat(32), recipient: dave.key, units: '50', from: dave.key };
    const lower = claimsHigher(5, 'c'.repeat(64), () => ({ body: headReply(1, 'e'.repeat(64)) }));
    const lowerBuy = await lower.w.buy(prep).catch((e) => e);
    line(lowerBuy.code === 'rollback-suspected' && lower.calls.purchase === 0, 'a lower newest head stops a purchase before the credential is sent', [lowerBuy.code, lower.calls.purchase]);
    const forkBuy = claimsHigher(5, 'c'.repeat(64), (at) => ({ body: headReply(at === null ? 6 : at, at === null ? 'c'.repeat(64) : otherHash) }));
    const forkBuyResult = await forkBuy.w.buy(prep).catch((e) => e);
    line(forkBuyResult.code === 'history-conflict' && forkBuy.calls.purchase === 0, 'so does a higher head on another history', [forkBuyResult.code, forkBuy.calls.purchase]);
    const noHead = claimsHigher(5, 'c'.repeat(64), () => ({ status: 503, body: { ok: false } }));
    const noHeadBuy = await noHead.w.buy(prep).catch((e) => e);
    line(noHeadBuy.code === 'history-unproven' && noHead.calls.purchase === 0, 'and so does a domain that will not state its head', [noHeadBuy.code, noHead.calls.purchase]);

    console.log('\n== a coin that disappears');
    const missingState = freshState();
    missingState.domains = JSON.parse(JSON.stringify(daveState.domains));
    const hiding = Chain.create(envFor(dave, missingState, {
      fetch: async (url, init) => { const res = await envFor(dave, daveState).fetch(url, init); const text = await res.text(); if (!url.includes('action=holdings')) return { status: res.status, text: async () => text }; const j = JSON.parse(text); j.statement.coins = j.statement.coins.filter((x) => x.coinId !== rlb.id); j.signature = b64u(crypto.sign('sha256', Buffer.from(canon(j.statement)), a.pair.privateKey)); return { status: res.status, text: async () => JSON.stringify(j) }; }
    }));
    await hiding.lookup(A);
    const mSus = missingState.domains.find((d) => d.domain === A).heads[rlb.id].suspect;
    line(mSus && mSus.kind === 'coin-missing', 'a coin the domain showed before and now leaves out is marked', mSus);

    console.log('\n== the kept heads survive a copy of the list');
    const copied = JSON.parse(JSON.stringify(daveState.domains));
    line(copied.find((d) => d.domain === A).heads[rlb.id].index === 2, 'the heads are part of the domain records that the wallet saves and backs up');

    console.log('\n== leaving');
    await chain.removeDomain(B);
    const left = await chain.rows();
    line(left.domains.length === 1 && left.domains[0].domain === A && !('b.example' in st.cache.answers), 'removing a domain forgets it and its answers');
  } finally {
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHAIN-LABS WALLET CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); process.exit(1); });
