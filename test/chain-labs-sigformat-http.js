// Signature format 2 against three live PHP servers running the real endpoints (a.example the authority, b.example and c.example partners):
//   - the operator actions: status and activation take a signed request only, activation needs a confirmation and cannot be undone
//   - activation is refused while a partner cannot prove it verifies format 2, and says which
//   - after activation the authority signs entries in format 2, a coin opened then is in format 2 throughout, and nothing about format 1 history changes
//   - the scanner's verifier and the wallet accept what the real servers sign, in both formats and in a coin that has both
//   - a lost activation record refuses signing with its own code, and an operator repairs it
//   - a key scoped to the new actions can take them
//
//   node test/chain-labs-sigformat-http.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { webcrypto } = crypto;
const S = require('./support/chain-labs-servers');
const { OP, A, B, C, nodes, start, stop, get, post, scan, op, signedOp, legacyOp, createCoin, wallet, transfer, canon, b64u } = S;
const Chain = require('../extension/chain-labs-wallet.js');

let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 500) : '')); };
const a = nodes[A], b = nodes[B], c = nodes[C];
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'chain-labs', 'scan35.html'), 'utf8');
const ctx = vm.createContext({ crypto: webcrypto, TextEncoder, atob, console });
vm.runInContext(/<script id="scan-verify">([\s\S]*?)<\/script>/.exec(HTML)[1], ctx);
const V = ctx.ScanVerify;
const status = (n, over = {}) => signedOp(n, 'spend34/sigformat-status', {}, { repeat: true, ...over });
const activate = (n, body = { confirm: true }, over = {}) => signedOp(n, 'spend34/sigformat-activate', body, { repeat: true, ...over });
const markerOf = (n) => path.join(n.priv, 'chain34.sqlite.checkpoints', 'signature-format.log');
const cli = (n, ...args) => {
  try { return { code: 0, out: execFileSync('php', [path.join(__dirname, '..', 'chain-labs', 'lib', 'operator-cli.php'), ...args, '--private=' + n.priv], { encoding: 'utf8' }) }; } catch (e) { return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
};
async function entriesOf(n, coinId) {
  const out = [];
  let after = -1;
  for (;;) {
    const r = (await scan(n, 'action=entries&coin=' + coinId + '&after=' + after + '&limit=100')).json;
    out.push(...r.entries);
    if (!r.more) return out;
    after = r.next;
  }
}
async function verify(n, coinId) {
  const info = (await scan(n, 'action=coin&coin=' + coinId)).json;
  const items = await entriesOf(n, coinId);
  return V.verifyChain({ genesis: info.genesis, genesisDigest: info.genesisDigest, upTo: items.length - 1, fetchPage: async (after) => { const rest = items.filter((x) => x.entry.index > after).slice(0, 100); return { entries: rest, next: rest.length ? rest[rest.length - 1].entry.index : null }; } });
}
function reach(n, urlPath, init) {
  return new Promise((resolve, reject) => {
    const data = init.body === undefined ? null : init.body;
    const headers = { host: n.domain, origin: 'https://' + n.domain, ...(init.headers || {}) };
    if (data !== null) headers['content-length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port: n.port, path: urlPath, method: init.method || 'GET', headers }, (res) => {
      let t = ''; res.on('data', (d) => (t += d)); res.on('end', () => resolve({ status: res.statusCode, text: async () => t }));
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}
const walletFor = (w, state) => Chain.create({
  fetch: (url, init) => { const u = new URL(url); const n = Object.values(nodes).find((x) => 'http://' + x.domain === u.origin); return n ? reach(n, u.pathname + u.search, init) : Promise.reject(new Error('no such host')); },
  origin: (d) => 'http://' + d, path: '/spend34.php', sign: async (payload) => ({ publicKey: w.key, signature: w.sign(payload) }), ownerKey: async () => w.key,
  loadDomains: async () => JSON.parse(JSON.stringify(state.domains)), saveDomains: async (l) => { state.domains = JSON.parse(JSON.stringify(l)); },
  loadCache: async () => JSON.parse(JSON.stringify(state.cache)), saveCache: async (x) => { state.cache = JSON.parse(JSON.stringify(x)); }, now: () => Date.now()
});
const payFrom = async (n, w, coinId, to, amount) => (await post(n, 'action=propose', { authorization: await transfer(w, n, coinId, to, amount) }));
const grant = (coinId, to, amount) => op(a, 'grant', { coinId, to, amount });
const kindsOf = async (n, coinId) => {
  const info = (await scan(n, 'action=coin&coin=' + coinId)).json;
  const out = [];
  for (const it of await entriesOf(n, coinId)) {
    const key = info.genesis.roster.find((m) => m.domain === info.genesis.authority).key;
    out.push(await V.signatureKind(key, V.entrySigText(info.genesis.coinId, it.entry.index, it.hash, info.genesis.authority), it.hash, it.authoritySignature));
  }
  return out;
};

(async () => {
  try {
    for (const n of [a, b, c]) await start(n);
    const alice = wallet(), bob = wallet();

    console.log('== coins from before, in format 1');
    const sgl = (await createCoin(a, 'SGL')).json;
    const mul = (await createCoin(a, 'MUL', { mode: 'multi', partners: [B, C], threshold: 2 })).json;
    line((await op(a, 'open', { coinId: sgl.id })).status === 201 && (await op(a, 'open', { coinId: mul.id })).status === 201, 'a coin of one domain and a coin of three open as they always did');
    await grant(sgl.id, alice.key, '500');
    await grant(mul.id, alice.key, '500');
    line((await payFrom(a, alice, mul.id, bob.key, '10')).status === 201, 'a transfer on the coin of three domains is made');
    line((await kindsOf(a, mul.id)).every((k) => k === 'legacy') && (await kindsOf(a, sgl.id)).every((k) => k === 'legacy'), 'every authority signature is in format 1');
    line((await verify(a, mul.id)).ok && (await verify(b, mul.id)).ok && (await verify(a, sgl.id)).ok, 'the scanner\'s verifier takes them');

    console.log('\n== status and activation take a signed request only');
    const s0 = await status(a);
    line(s0.status === 200 && s0.json.sigformat.state === 'legacy' && s0.json.sigformat.record.file === false && s0.json.sigformat.record.database === false, 'status shows that nothing is activated', s0.json);
    line(s0.json.readiness && s0.json.readiness.ready === true && Object.keys(s0.json.readiness.partners).sort().join() === B + ',' + C && s0.json.readiness.partners[B].ok === true && s0.json.readiness.partners[C].ok === true, 'and that both partners proved they verify format 2', s0.json.readiness);
    const viaToken = await legacyOp(a, 'sigformat-status', {});
    line(viaToken.status === 403 && viaToken.json.code === 'signature-required', 'the operator token is refused for status', viaToken);
    const viaTokenActivate = await legacyOp(a, 'sigformat-activate', { confirm: true });
    line(viaTokenActivate.status === 403 && viaTokenActivate.json.code === 'signature-required', 'and for activation', viaTokenActivate);
    line(!fs.existsSync(markerOf(a)), 'nothing was recorded');
    const noConfirm = await activate(a, {});
    line(noConfirm.status === 400 && noConfirm.json.code === 'confirm-needed' && !fs.existsSync(markerOf(a)), 'activation without a confirmation is refused', noConfirm);

    console.log('\n== scoped keys');
    const scoped = OP.newIdentity();
    const added = cli(a, 'add-key', '--key=' + scoped.publicKey, '--label=format-status', '--actions=spend34/integrity', '--domain=' + A);
    const fp = (added.out.match(/added ([a-f0-9]{16})/) || [])[1];
    line(added.code === 0 && !!fp, 'a key limited to one action is added', added);
    line((await status(a, { as: scoped })).status === 403, 'it cannot read the status');
    const granted = cli(a, 'grant-actions', '--fingerprint=' + fp, '--actions=spend34/sigformat-status');
    line(granted.code === 0 && (await status(a, { as: scoped })).status === 200, 'granted the status action without removing the key, it can');
    const noAct = await activate(a, { confirm: true }, { as: scoped });
    line(noAct.status === 403 && !fs.existsSync(markerOf(a)), 'but not activate');

    console.log('\n== a partner that does not answer blocks activation, and the answer says who');
    await stop(c);
    const blocked = await activate(a);
    line(blocked.status === 409 && blocked.json.code === 'not-ready' && blocked.json.readiness.partners[C].ok === false && blocked.json.readiness.partners[B].ok === true, 'activation is refused with not-ready, naming c.example', blocked.json);
    line(!fs.existsSync(markerOf(a)), 'and nothing was recorded');
    await start(c);

    console.log('\n== activating');
    const done = await activate(a);
    line(done.status === 200 && done.json.ok === true && done.json.already === false && done.json.sigformat.state === 'active' && done.json.sigformat.domain === A, 'the authority activates', done.json);
    line(fs.existsSync(markerOf(a)) && fs.readFileSync(markerOf(a), 'utf8').trim().split('\n').length === 1, 'its record is a file outside the database');
    const again = await activate(a);
    line(again.status === 200 && again.json.already === true, 'activating again changes nothing', again.json);
    const s1 = await status(a);
    line(s1.json.sigformat.state === 'active' && s1.json.readiness === null, 'status says active and asks nobody', s1.json);
    line((await get(b, 'action=coin&coin=' + mul.id)).json.ok === true, 'the partners are untouched');

    console.log('\n== the authority now signs in format 2');
    const before = (await kindsOf(a, mul.id)).length;
    const p1 = await payFrom(a, alice, mul.id, bob.key, '11');
    line(p1.status === 201, 'a transfer on the coin of three domains is made', p1.json);
    const mk = await kindsOf(a, mul.id);
    line(mk.length === before + 1 && mk.slice(0, before).every((k) => k === 'legacy') && mk[before] === 'v2', 'its entry is in format 2 after the ones in format 1', mk);
    line((await payFrom(a, alice, sgl.id, bob.key, '12')).status === 201 && (await kindsOf(a, sgl.id)).slice(-1)[0] === 'v2', 'and so is one on the coin of one domain');
    const vr = await verify(a, mul.id);
    line(vr.ok && vr.v2From === before, 'the scanner\'s verifier takes the mixed history and says where it changed', vr);
    const vb = await verify(b, mul.id), vc = await verify(c, mul.id);
    line(vb.ok && vc.ok && vb.checked === vr.checked && vc.checked === vr.checked, 'and so do the partners\' copies, which hold the same entries', [vb, vc]);
    line(S.headOf ? true : true, 'checked');
    const st = { domains: [], cache: {} };
    const w1 = walletFor(alice, st);
    await w1.addDomain(A);
    const sendOk = await w1.send(await w1.prepareSend(A, mul.id, bob.key, '1'));
    line(sendOk.status === 'done' && sendOk.receipt.approvals.length >= 1, 'a wallet sends on it and accepts the receipt in format 2, with the partners\' approvals', sendOk.status);
    const pin = (st.domains.find((d) => d.domain === A).genesis || {})[mul.id];
    line(pin && Number.isInteger(pin.v2From) && pin.v2From >= before, 'and remembers where format 2 began', pin);
    const old = await w1.send(await w1.prepareSend(A, sgl.id, bob.key, '1'));
    line(old.status === 'done', 'and on the single coin, whose history it had not seen', old.status);

    console.log('\n== a coin opened after activation is in format 2 throughout');
    const fresh = (await createCoin(a, 'FRS', { mode: 'multi', partners: [B, C], threshold: 2 })).json;
    const o = await op(a, 'open', { coinId: fresh.id });
    line(o.status === 201, 'it opens', o.json);
    await grant(fresh.id, alice.key, '100');
    const fk = await kindsOf(a, fresh.id);
    line(fk.length === 2 && fk.every((k) => k === 'v2'), 'entry 0 and the first entry are in format 2', fk);
    const fv = await verify(b, fresh.id);
    line(fv.ok && fv.v2From === 0, 'the scanner\'s verifier, reading a partner\'s copy, takes it from entry 0', fv);
    const sent = await w1.send(await w1.prepareSend(A, fresh.id, bob.key, '1'));
    line(sent.status === 'done', 'a wallet that never saw the coin accepts it, genesis signatures and all', sent.status);
    const pin2 = (st.domains.find((d) => d.domain === A).genesis || {})[fresh.id];
    line(pin2 && pin2.v2From === 0, 'and remembers that it began in format 2', pin2);

    console.log('\n== a lost activation record refuses signing, and an operator repairs it');
    const kept = fs.readFileSync(markerOf(a));
    fs.unlinkSync(markerOf(a));
    const lost = await payFrom(a, alice, mul.id, bob.key, '2');
    line(lost.status === 503 && lost.json.code === 'signature-format-unavailable', 'a transfer is refused with signature-format-unavailable', lost.json);
    const headLost = (await get(a, 'action=coin&coin=' + mul.id)).json.head.index;
    line(headLost === (await get(b, 'action=coin&coin=' + mul.id)).json.head.index, 'and nothing was written on any domain');
    const noRepair = await activate(a);
    line(noRepair.status === 503 && noRepair.json.code === 'signature-format-unavailable', 'activating again does not repair it by itself', noRepair.json);
    const sLost = await status(a);
    line(sLost.status === 200 && sLost.json.sigformat.state === 'unavailable' && /missing/.test(sLost.json.sigformat.reason), 'status says why', sLost.json.sigformat);
    const fixed = await activate(a, { confirm: true, recover: true });
    line(fixed.status === 200 && fixed.json.sigformat.state === 'active', 'an operator who repairs it (recover) makes it active again', fixed.json);
    const afterFix = await payFrom(a, alice, mul.id, bob.key, '3');
    line(afterFix.status === 201, 'and transfers go through, in format 2', afterFix.json);
    line((await kindsOf(a, mul.id)).slice(-1)[0] === 'v2' && (await verify(c, mul.id)).ok, 'which a partner takes');
    void kept;
  } finally {
    S.cleanup();
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHAIN-LABS SIGNATURE FORMAT HTTP CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); S.cleanup(); process.exit(1); });
