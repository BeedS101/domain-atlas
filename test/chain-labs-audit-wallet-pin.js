// Reproduction: the wallet remembers the lowest index at which it saw a format 2 authority signature (v2From) before it has checked the
// receipt's approvals or that the domain's own history holds the entry. A receipt that is refused afterwards has already moved the pin.
//
//   node test/chain-labs-audit-wallet-pin.js
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
    const allOf = (await createCoin(a, 'ALL', { mode: 'multi', partners: [B, C] })).json;
    for (const coin of [sgl, allOf]) if ((await op(a, 'open', { coinId: coin.id })).status !== 201) line(false, 'setup: a coin opens');
    for (const coin of [sgl, allOf]) await op(a, 'grant', { coinId: coin.id, to: alice.key, amount: '5000' });
    const refusal = async (p) => { const r = await p.catch((e) => e); return r && r.code ? r.code : (r && r.status) || 'none'; };
    const entText = (coinId, index, hash, domain) => canon({ type: 'atlas.ledger.entry.authority', v: 1, coinId, index, hash, domain });
    const listed = async (names = [A]) => { const stt = freshState(); const w = Chain.create(envFor(alice, stt)); for (const n of names) await w.addDomain(n); return stt; };
    const pinOf = (state, coinId) => { const rec = state.domains.find((d) => d.domain === A); return rec && rec.genesis ? rec.genesis[coinId] : null; };
    const asV2 = (j) => { const r = j.receipt; r.authoritySignature = derSign(a, entText(r.coinId, r.entry.index, r.hash, A)); };

    console.log('== a format 2 receipt with too few approvals');
    const few = await listed([A, B, C]);
    const prime = Chain.create(envFor(alice, few));
    const warm = await prime.send(await prime.prepareSend(A, allOf.id, bob.key, '1'));
    line(warm.status === 'done' && pinOf(few, allOf.id) && pinOf(few, allOf.id).v2From === null, 'an honest transfer is accepted and nothing has moved to format 2', pinOf(few, allOf.id));
    const pinsOf = (state) => JSON.stringify(state.domains.map((d) => [d.domain, d.genesis || null]));
    const pinsBefore = pinsOf(few);
    const stripped = through(alice, few, edit('action=propose', (j) => { asV2(j); j.receipt.approvals = []; }));
    line(await refusal(stripped.send(await stripped.prepareSend(A, allOf.id, bob.key, '1'))) === 'bad-receipt', 'a receipt signed in format 2 by the authority with the partners\' approvals taken out is refused');
    line(pinOf(few, allOf.id).v2From === null, 'and the wallet has not moved its remembered format 2 index', pinOf(few, allOf.id));
    line(pinsOf(few) === pinsBefore, 'nor changed any other pin it holds');
    const half = through(alice, few, edit('action=propose', (j) => { asV2(j); j.receipt.approvals = j.receipt.approvals.slice(0, 1); }));
    line(await refusal(half.send(await half.prepareSend(A, allOf.id, bob.key, '1'))) === 'bad-receipt' && pinsOf(few) === pinsBefore, 'a receipt with one of its two partners\' approvals missing leaves the pins as they were');
    const selfApproved = through(alice, few, edit('action=propose', (j) => {
      asV2(j);
      const bytes = canon({ type: 'atlas.ledger.entry.approval', v: 1, coinId: allOf.id, index: j.receipt.entry.index, hash: j.receipt.hash });
      j.receipt.approvals = [{ domain: B, signature: derSign(a, bytes) }, { domain: C, signature: derSign(a, bytes) }];
    }));
    line(await refusal(selfApproved.send(await selfApproved.prepareSend(A, allOf.id, bob.key, '1'))) === 'bad-receipt' && pinsOf(few) === pinsBefore, 'and so does one whose approvals were made up by the authority');
    const moving = through(alice, few, edit('action=propose', asV2));
    const whole = await moving.send(await moving.prepareSend(A, allOf.id, bob.key, '1'));
    line(whole.status === 'done' && pinOf(few, allOf.id).v2From === whole.receipt.entry.index, 'a receipt in format 2 with every approval, found in the domain\'s history, does move it', pinOf(few, allOf.id));
    const movedTo = pinOf(few, allOf.id).v2From;
    const lateLegacy = Chain.create(envFor(alice, few));
    line(await refusal(lateLegacy.send(await lateLegacy.prepareSend(A, allOf.id, bob.key, '1'))) === 'bad-receipt', 'and the ratchet then refuses a receipt in format 1 for a later entry, as before');
    line(pinOf(few, allOf.id).v2From === movedTo, 'without moving it');

    console.log('\n== a format 2 receipt for an entry the domain\'s history does not hold');
    const notThere = await listed();
    const warm2 = Chain.create(envFor(alice, notThere));
    await warm2.send(await warm2.prepareSend(A, sgl.id, bob.key, '1'));
    await warm2.send(await warm2.prepareSend(A, sgl.id, bob.key, '1'));
    const made = (j) => {
      const prepared = { amount: '100', from: alice.key, to: bob.key };
      const entry = { amount: prepared.amount, coinId: sgl.id, executedAt: '2026-01-01T00:00:00Z', from: prepared.from, index: 1, prevHash: 'a'.repeat(64), to: prepared.to, type: 'transfer' };
      const hash = sha(canon(entry));
      return { status: 201, json: { ok: true, receipt: { coinId: sgl.id, entry, hash, authoritySignature: derSign(a, entText(sgl.id, 1, hash, A)), approvals: [] } } };
    };
    const forged = through(alice, notThere, edit('action=propose', made));
    line(await refusal(forged.send(await forged.prepareSend(A, sgl.id, bob.key, '1'))) === 'bad-receipt', 'a format 2 receipt for entry 1 that the domain\'s own history shows to be another entry is refused');
    line(pinOf(notThere, sgl.id).v2From === null, 'and the wallet has not moved its remembered format 2 index', pinOf(notThere, sgl.id));
    // The domain does not answer when asked to show the entry: the receipt is left unchecked and nothing is pinned.
    const silent = through(alice, notThere, both(edit('action=propose', asV2), async (url) => (url.includes('action=head') ? { status: 503, json: { ok: false } } : null)));
    const prepared = await warm2.prepareSend(A, sgl.id, bob.key, '1');
    const waiting = await silent.send(prepared).catch((e) => e);
    line(waiting.status === 'waiting' && pinOf(notThere, sgl.id).v2From === null, 'a format 2 receipt whose entry the domain does not show (it does not answer) is left unchecked and pins nothing', waiting.status || waiting.code);
    const honestAfter = Chain.create(envFor(alice, notThere));
    const later = await honestAfter.send(await honestAfter.prepareSend(A, sgl.id, bob.key, '1')).catch((e) => e);
    line(later.status === 'done', 'so an honest receipt in format 1 for a later entry is still accepted', later.code || later.status);
  } finally {
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHAIN-LABS WALLET PIN CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
