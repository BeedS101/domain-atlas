// Spending on multi authority coins of the chain labs (chain-labs/spend34.php) across three live PHP servers, one per
// domain, each with its own database, domain key and pinned partner keys. The wallet side is simulated in Node.
//   - opening a coin with its partners, and what stops it when a partner is not pinned or not answering
//   - all-of and 2-of-3 approval, owner-signed transfers proposed to the authority
//   - a domain that is down, the authority restarted with a proposal waiting, recovery, a partner catching up
//   - two spends of the same units at the same time
//   - requests from domains that are not pinned, and requests with bad signatures
//   - signed head statements, comparing heads, and the freeze when the authority is restored from an old backup
//
//   node test/chain-labs-multi-http.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..', 'chain-labs');
let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : '')); };

const A = 'a.example', B = 'b.example', C = 'c.example', D = 'd.example';
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const canon = (v) => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : (v && typeof v === 'object') ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const key = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
  return { key, sign: (payload) => b64u(crypto.sign('sha256', Buffer.from(canon(payload)), { key: privateKey, dsaEncoding: 'ieee-p1363' })) };
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-labs-multi-http-'));
const base = 21000 + Math.floor(Math.random() * 12000);
const nodes = {};
[A, B, C].forEach((domain, i) => {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  nodes[domain] = { domain, port: base + i * 3, pair, token: crypto.randomBytes(32).toString('hex'), proc: null, dir: path.join(work, domain) };
});
const pem = (k) => Buffer.from(k.export({ type: 'spki', format: 'pem' })).toString('base64');

// Each node pins the keys of the others and reaches them on loopback; D is a listed lab domain with no pinned key.
for (const n of Object.values(nodes)) {
  const root = path.join(n.dir, 'public'), priv = path.join(n.dir, 'chainblock-labs-private');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(priv);
  n.root = root; n.priv = priv;
  for (const f of ['coin26.php', 'spend34.php']) fs.copyFileSync(path.join(DIR, f), path.join(root, f));
  fs.cpSync(path.join(DIR, 'lib'), path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(priv, 'federation20-config.php'), "<?php return ['private_pem_b64' => '" + Buffer.from(n.pair.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64') + "', 'admin_token_hex' => '" + n.token + "'];\n");
  const keys = {}, urls = {};
  for (const o of Object.values(nodes)) if (o.domain !== n.domain) { keys[o.domain] = pem(o.pair.publicKey); urls[o.domain] = 'http://127.0.0.1:' + o.port + '/spend34.php?action=peer'; }
  fs.writeFileSync(path.join(priv, 'chainlabs-peers.json'), JSON.stringify({ keys, urls }));
  const others = [A, B, C, D].filter((d) => d !== n.domain);
  fs.writeFileSync(path.join(priv, 'chainlabs-config.json'), JSON.stringify({ hosts: [A, B, C, D], partners: { [n.domain]: others } }));
  fs.writeFileSync(path.join(n.dir, 'prepend.php'), "<?php $_SERVER['HTTPS'] = 'on';\n");
}
function start(n) {
  n.proc = spawn('php', ['-S', '127.0.0.1:' + n.port, '-t', n.root, '-d', 'auto_prepend_file=' + path.join(n.dir, 'prepend.php')], { stdio: 'ignore', env: { ...process.env, PHP_CLI_SERVER_WORKERS: '6' } });
  return waitUp(n);
}
// Waits until the server answers, up to ten seconds.
async function waitUp(n) {
  for (let i = 0; i < 100; i++) {
    const r = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: n.port, path: '/spend34.php?action=coins', method: 'GET', headers: { host: n.domain } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', () => resolve(0));
      req.end();
    });
    if (r !== 0) return;
    await sleep(100);
  }
}
async function stop(n) {
  if (!n.proc) return;
  n.proc.kill('SIGKILL');
  n.proc = null;
  await sleep(300);
}

function call(n, file, method, query, body) {
  return new Promise((resolve) => {
    const headers = { host: n.domain, origin: 'https://' + n.domain };
    const data = body === undefined ? null : JSON.stringify(body);
    if (data !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port: n.port, path: '/' + file + '.php?' + query, method, headers }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
    });
    req.on('error', () => resolve({ status: 0, json: null, raw: '' }));
    if (data !== null) req.write(data);
    req.end();
  });
}
const get = (n, q) => call(n, 'spend34', 'GET', q);
const post = (n, q, body) => call(n, 'spend34', 'POST', q, body);
const op = (n, action, body) => post(n, 'action=' + action, { adminToken: n.token, ...body });
const createCoin = (n, symbol, extra = {}) => call(n, 'coin26', 'POST', 'action=create', { name: 'Coin ' + symbol, symbol, decimals: 2, maxSupply: '100000', initialSupply: '1000', description: '', adminToken: n.token, ...extra });
const NOW = () => Math.floor(Date.now() / 1000);
const iso = (t) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
async function transfer(w, n, coinId, to, amount, over = {}) {
  const h = (await post(n, 'action=holdings', { key: w.key })).json.statement.coins.find((c) => c.coinId === coinId);
  const payload = { type: 'atlas.ledger.transfer', v: 1, coinId, from: w.key, to, amount, baseSeq: h ? h.seq : 0, baseHead: h ? h.headHash : '0'.repeat(64), nonce: crypto.randomBytes(16).toString('hex'), issuedAt: iso(NOW() - 5), expiresAt: iso(NOW() + 200), ...over };
  return { payload, signature: w.sign(payload) };
}
const units = async (n, w, coinId) => { const h = (await post(n, 'action=holdings', { key: w.key })).json.statement.coins.find((c) => c.coinId === coinId); return h ? h.units : '0'; };
const headOf = async (n, coinId) => { const r = await get(n, 'action=coin&coin=' + coinId); return r.json && r.json.ok ? r.json.head.index + ':' + r.json.head.hash.slice(0, 16) : 'none'; };
async function level(coinId, ns = [A, B, C]) {
  const heads = [];
  for (const d of ns) heads.push(await headOf(nodes[d], coinId));
  return new Set(heads).size === 1 ? heads[0] : heads;
}
const levelOk = (v) => typeof v === 'string' && v !== 'none';

(async () => {
  for (const n of Object.values(nodes)) await start(n);
  const a = nodes[A], b = nodes[B], c = nodes[C];
  try {
    const alice = wallet(), bob = wallet(), carol = wallet();

    console.log('== opening a coin with its partners');
    const allOf = (await createCoin(a, 'ALL', { mode: 'multi', partners: [B, C] })).json;
    const twoOf = (await createCoin(a, 'TWO', { mode: 'multi', partners: [B, C], threshold: 2 })).json;
    const priv3 = (await createCoin(a, 'PRV', { mode: 'multi', partners: [B, C], threshold: 2, visibility: 'private' })).json;
    const unpinned = (await createCoin(a, 'UNP', { mode: 'multi', partners: [B, D] })).json;
    line(allOf.ok && twoOf.ok && priv3.ok && unpinned.ok && allOf.roster.length === 3 && allOf.threshold === 3 && twoOf.threshold === 2, 'multi coins with two partners are registered on the authority', [allOf, twoOf, priv3, unpinned].map((x) => x.error));
    const nu = await op(a, 'open', { coinId: unpinned.id });
    line(nu.status === 400 && nu.json.code === 'needs-partners' && nu.json.missing[0] === D, 'a coin whose partner has no pinned key does not open, and the answer names it', nu.json);
    line((await get(a, 'action=coins')).json.coins.length === 0, 'and nothing is left half open');
    const ot = await op(b, 'open', { coinId: allOf.id });
    line(ot.status >= 400 && ot.status < 600 && !ot.json.ok, 'a partner cannot open a coin that is registered on the authority', ot.json);

    await stop(c);
    const down = await op(a, 'open', { coinId: allOf.id });
    line(down.status === 502 && down.json.code === 'peer-down', 'opening stops while a partner does not answer', down.json);
    line((await get(a, 'action=coins')).json.coins.length === 0 && (await get(b, 'action=coin&coin=' + allOf.id)).status === 200, 'the coin stays pending: unlisted, and the partner that answered already holds it');
    await start(c);
    const o1 = await op(a, 'open', { coinId: allOf.id });
    line(o1.status === 201 && o1.json.coin.state === 'active' && o1.json.coin.genesis.roster.length === 3 && o1.json.coin.genesis.threshold === 3, 'repeating the request opens it with the same genesis', o1.json);
    const listed = await Promise.all([b, c].map(async (n) => ((await get(n, 'action=coins')).json.coins || []).some((x) => x.coinId === allOf.id && x.state === 'active')));
    line(listed.every(Boolean), 'and both partners hold it as open at once, before anyone reads it from them (the notice reached them)', listed);
    line((await op(a, 'open', { coinId: allOf.id })).status === 409, 'a coin opens once');
    const o2 = await op(a, 'open', { coinId: twoOf.id });
    const o3 = await op(a, 'open', { coinId: priv3.id });
    line(o2.status === 201 && o3.status === 201 && o3.json.coin.genesis.visibility === 'private', 'a 2-of-3 coin and a private multi coin open', [o2.json, o3.json]);
    for (const [name, id] of [['all-of', allOf.id], ['2-of-3', twoOf.id], ['private', priv3.id]]) {
      const ha = await get(a, 'action=coin&coin=' + id), hb = await get(b, 'action=coin&coin=' + id), hc = await get(c, 'action=coin&coin=' + id);
      line([hb, hc].every((h) => h.status === 200 && h.json.state === 'active' && h.json.genesisDigest === ha.json.genesisDigest), 'the ' + name + ' coin is active on both partners with the same genesis', [hb.json, hc.json]);
    }
    line(levelOk(await level(allOf.id)), 'all three copies of entry 0 are the same');

    console.log('\n== all three domains approve');
    const g1 = await op(a, 'grant', { coinId: allOf.id, to: alice.key, amount: '50000' });
    line(g1.status === 201 && g1.json.receipt.approvals.length === 2 && g1.json.receipt.entry.index === 1, 'a grant on the all-of coin carries both partners\' approvals', g1.json);
    const t1 = await transfer(alice, a, allOf.id, bob.key, '1200');
    const r1 = await post(a, 'action=propose', { authorization: t1 });
    line(r1.status === 201 && r1.json.receipt.entry.index === 2 && r1.json.receipt.approvals.length === 2, 'an owner-signed transfer proposed to the authority executes', r1.json);
    line(levelOk(await level(allOf.id)), 'the partners hold the same log');
    for (const n of [a, b, c]) line((await units(n, bob, allOf.id)) === '1200' && (await units(n, alice, allOf.id)) === '48800', n.domain + ' reports the same balances');
    const again = await post(a, 'action=propose', { authorization: t1 });
    line(again.status === 201 && again.json.receipt.hash === r1.json.receipt.hash, 'the same transfer sent again returns the same receipt');
    const rb = await get(b, 'action=receipt&coin=' + allOf.id + '&index=2');
    line(rb.status === 200 && rb.json.receipt.hash === r1.json.receipt.hash && rb.json.receipt.approvals.length === 2, 'a partner serves the same receipt');
    const wrong = await post(b, 'action=propose', { authorization: await transfer(alice, a, allOf.id, bob.key, '1') });
    line(wrong.status === 409 && wrong.json.code === 'not-authority' && wrong.json.authority === A, 'a transfer sent to a partner is pointed at the authority', wrong.json);
    const wrongGrant = await op(b, 'grant', { coinId: allOf.id, to: bob.key, amount: '1' });
    line(wrongGrant.status === 409, 'and a partner does not grant');

    console.log('\n== a domain is down');
    await stop(c);
    const t2 = await transfer(alice, a, allOf.id, bob.key, '300');
    const r2 = await post(a, 'action=propose', { authorization: t2 });
    line(r2.status === 202 && r2.json.code === 'needs-approvals' && r2.json.proposal.status === 'pending', 'with every domain required, the transfer waits for the one that is down', r2.json);
    line((await units(a, bob, allOf.id)) === '1200', 'and nothing is written');
    const wait = await get(a, 'action=proposal&coin=' + allOf.id + '&digest=' + r2.json.proposal.digest);
    line(wait.status === 200 && wait.json.proposal.status === 'pending', 'the proposal can be read while it waits', wait.json);
    // The authority restarts with the proposal waiting.
    await stop(a);
    await start(a);
    await start(c);
    const rec = await op(a, 'recover', { coinId: allOf.id });
    line(rec.status === 200 && Object.values(rec.json.results).some((x) => x.startsWith('executed')), 'after the authority and the partner are back, recovery executes the waiting proposal', rec.json);
    line((await units(a, bob, allOf.id)) === '1500', 'the transfer is written once');
    const done2 = await get(a, 'action=proposal&coin=' + allOf.id + '&digest=' + r2.json.proposal.digest);
    line(done2.json.proposal.status === 'executed' && done2.json.proposal.receipt, 'and the proposal reads as executed with its receipt', done2.json);
    line(levelOk(await level(allOf.id)), 'the partner that was down is level with the others');

    console.log('\n== 2 of 3');
    const g2 = await op(a, 'grant', { coinId: twoOf.id, to: alice.key, amount: '5000' });
    line(g2.status === 201 && g2.json.receipt.approvals.length === 1, 'two approvals are enough: the entry carries one partner\'s', g2.json);
    await stop(c);
    const t3 = await transfer(alice, a, twoOf.id, bob.key, '100');
    const r3 = await post(a, 'action=propose', { authorization: t3 });
    line(r3.status === 201 && r3.json.receipt.approvals.length === 1 && r3.json.receipt.approvals[0].domain === B, 'with one partner down the other approves and the transfer executes', r3.json);
    await stop(b);
    const t4 = await transfer(alice, a, twoOf.id, bob.key, '50');
    const r4 = await post(a, 'action=propose', { authorization: t4 });
    line(r4.status === 202 && (await units(a, bob, twoOf.id)) === '100', 'with both partners down nothing is written', r4.json);
    await start(b);
    await start(c);
    const rec2 = await op(a, 'recover', { coinId: twoOf.id });
    line(rec2.status === 200 && Object.values(rec2.json.results).every((x) => x.startsWith('executed')) && (await units(a, bob, twoOf.id)) === '150', 'recovery finishes it once a partner is back', rec2.json);
    const hc = await get(c, 'action=coin&coin=' + twoOf.id);
    line(hc.status === 200 && levelOk(await level(twoOf.id)), 'a partner that missed entries catches up when it is next asked', [hc.json && hc.json.head, await level(twoOf.id)]);

    console.log('\n== two spends of the same units at the same time');
    const g3 = await op(a, 'grant', { coinId: twoOf.id, to: carol.key, amount: '100' });
    const dest1 = wallet(), dest2 = wallet();
    const s1 = await transfer(carol, a, twoOf.id, dest1.key, '80'), s2 = await transfer(carol, a, twoOf.id, dest2.key, '80');
    const raced = await Promise.all([post(a, 'action=propose', { authorization: s1 }), post(a, 'action=propose', { authorization: s2 })]);
    const won = raced.filter((r) => r.status === 201).length;
    line(g3.status === 201 && won === 1 && raced.filter((r) => r.status === 409).length === 1, 'exactly one of two concurrent spends of the same 80 of 100 units executes, the other is refused', raced.map((r) => [r.status, r.json && r.json.code]));
    const total1 = Number(await units(a, carol, twoOf.id)) + Number(await units(a, dest1, twoOf.id)) + Number(await units(a, dest2, twoOf.id));
    line(total1 === 100 && Number(await units(a, carol, twoOf.id)) === 20, 'the units are conserved: 20 stay, 80 move once', total1);
    let sum = 0;
    for (const w of [alice, bob, carol, dest1, dest2]) sum += Number(await units(a, w, twoOf.id));
    for (const n of [b, c]) await get(n, 'action=coin&coin=' + twoOf.id);
    line(levelOk(await level(twoOf.id)) && (await units(b, dest1, twoOf.id)) === (await units(a, dest1, twoOf.id)) && (await units(c, dest2, twoOf.id)) === (await units(a, dest2, twoOf.id)), 'all three domains agree who got it', await level(twoOf.id));
    // Many at once, from different senders: all of them execute and the log has no gap.
    const senders = [wallet(), wallet(), wallet(), wallet(), wallet(), wallet()];
    for (const s of senders) await op(a, 'grant', { coinId: twoOf.id, to: s.key, amount: '10' });
    const sink = wallet();
    const batch = await Promise.all(senders.map(async (s) => post(a, 'action=propose', { authorization: await transfer(s, a, twoOf.id, sink.key, '10') })));
    line(batch.every((r) => r.status === 201) && (await units(a, sink, twoOf.id)) === '60', 'six senders spending at once all execute', batch.map((r) => [r.status, r.json && r.json.code, r.json && r.json.note]));
    for (const n of [b, c]) await get(n, 'action=coin&coin=' + twoOf.id);
    const idx = new Set();
    for (const r of batch) idx.add(r.json.receipt.entry.index);
    line(idx.size === 6 && levelOk(await level(twoOf.id)), 'each took its own place in the log and the copies agree', [...idx]);

    console.log('\n== a private multi coin');
    await op(a, 'grant', { coinId: priv3.id, to: alice.key, amount: '700' });
    const pt = await post(a, 'action=propose', { authorization: await transfer(alice, a, priv3.id, bob.key, '200') });
    line(pt.status === 201, 'a transfer on a private multi coin executes', pt.json);
    for (const n of [a, b, c]) {
      await get(n, 'action=coin&coin=' + priv3.id);
      const pubText = JSON.stringify((await get(n, 'action=coin&coin=' + priv3.id)).json) + JSON.stringify((await get(n, 'action=receipt&coin=' + priv3.id + '&index=2')).json);
      const plain = (await post(n, 'action=holdings', { key: alice.key })).json.statement.coins.find((x) => x.coinId === priv3.id);
      line(!pubText.includes(alice.key) && !pubText.includes(bob.key) && !plain, n.domain + ' shows no account key and no holding of the private coin without a signed request');
    }
    line(levelOk(await level(priv3.id)), 'the three domains hold the same private log');

    console.log('\n== requests between domains');
    const attacker = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const envelope = (from, to, action, body, key) => {
      const payload = { type: 'atlas.peer.request', v: 1, from, to, action, body, issuedAt: iso(NOW()), nonce: crypto.randomBytes(16).toString('hex') };
      return { payload, signature: b64u(crypto.sign('sha256', Buffer.from(canon(payload)), key)) };
    };
    const forged = await post(b, 'action=peer', envelope(A, B, 'sync', { coinId: allOf.id, after: -1 }, attacker.privateKey));
    line(forged.status === 401 && forged.json.code === 'bad-signature', 'a request signed with a key that is not the pinned key of the sender is refused', forged.json);
    const stranger = await post(b, 'action=peer', envelope('z.example', B, 'sync', { coinId: allOf.id, after: -1 }, attacker.privateKey));
    line(stranger.status === 403 && stranger.json.code === 'unknown-peer', 'a request from a domain that is not pinned is refused', stranger.json);
    const genuine = envelope(A, B, 'sync', { coinId: allOf.id, after: -1 }, nodes[A].pair.privateKey);
    const first = await post(b, 'action=peer', genuine);
    const replay = await post(b, 'action=peer', genuine);
    line(first.status === 200 && first.json.answer.records.length >= 3 && replay.status === 409 && replay.json.code === 'replayed', 'a genuine request is answered once; sending it again is refused', [first.status, replay.status, replay.json]);
    const toWrong = await post(c, 'action=peer', envelope(A, B, 'sync', { coinId: allOf.id, after: -1 }, nodes[A].pair.privateKey));
    line(toWrong.status === 400, 'a request addressed to another domain is refused', toWrong.json);
    const fromC = await post(a, 'action=peer', envelope(C, A, 'approve', { coinId: allOf.id, prepared: { public: {}, private: null, hash: '0' } }, nodes[C].pair.privateKey));
    line(fromC.status >= 400 && fromC.status < 500, 'a partner cannot ask the authority for approvals', fromC.json);
    const big = await post(b, 'action=peer', { payload: { pad: 'x'.repeat(70000) }, signature: 'x' });
    line(big.status === 413, 'an oversized request is refused');
    line((await call(b, 'spend34', 'GET', 'action=peer')).status === 404, 'the peer route takes POST only');

    console.log('\n== comparing heads and freezing');
    const mir = (await createCoin(a, 'MIR', { mode: 'multi', partners: [B, C], threshold: 2 })).json;
    await op(a, 'open', { coinId: mir.id });
    await op(a, 'grant', { coinId: mir.id, to: alice.key, amount: '1000' });
    await post(a, 'action=propose', { authorization: await transfer(alice, a, mir.id, bob.key, '10') });
    for (const n of [b, c]) await get(n, 'action=coin&coin=' + mir.id);
    const domainVerify = (n, att) => crypto.verify('sha256', Buffer.from(canon(att.payload)), n.pair.publicKey, Buffer.from(att.signature, 'base64url'));
    const ha = await get(a, 'action=head&coin=' + mir.id), hb = await get(b, 'action=head&coin=' + mir.id);
    line(ha.status === 200 && domainVerify(a, ha.json.head) && ha.json.head.payload.domain === A && ha.json.head.payload.index === 2 && ha.json.state === 'active', 'a domain publishes a signed statement of its head that anyone can verify', ha.json);
    line(hb.json.head.payload.hash === ha.json.head.payload.hash && crypto.createHash('sha256').update(canon(hb.json.head.public)).digest('hex') === hb.json.head.payload.hash, 'the partners state the same head, and the entry\'s public form hashes to it');
    line((await get(a, 'action=head&coin=' + '0'.repeat(32))).status === 404, 'a head for an unknown coin is a 404');
    const cmp = await op(b, 'compare', { coinId: mir.id });
    line(cmp.status === 200 && cmp.json.results[A] === 'equal' && cmp.json.results[C] === 'equal' && cmp.json.state === 'active', 'comparing heads with the other domains finds them level', cmp.json);
    line((await post(b, 'action=compare', { coinId: mir.id })).status === 403 && (await op(a, 'compare', { coinId: allOf.id })).status === 200, 'comparing needs the operator token');
    // The authority is restored from a backup made at entry 2 after the partners have seen entries 3 and 4.
    await stop(a);
    const copyDb = (from, to) => { for (const ext of ['', '-wal', '-shm']) { try { fs.rmSync(to + ext, { force: true }); fs.copyFileSync(from + ext, to + ext); } catch (e) {} } };
    const dbFile = path.join(a.priv, 'chain34.sqlite'), backup = path.join(work, 'backup-a.sqlite');
    copyDb(dbFile, backup);
    await start(a);
    await post(a, 'action=propose', { authorization: await transfer(alice, a, mir.id, bob.key, '11') });
    await post(a, 'action=propose', { authorization: await transfer(alice, a, mir.id, bob.key, '12') });
    for (const n of [b, c]) await get(n, 'action=coin&coin=' + mir.id);
    line((await level(mir.id)) === (await headOf(a, mir.id)) && (await headOf(b, mir.id)).startsWith('4:'), 'the partners hold entries 3 and 4', await level(mir.id));
    await stop(a);
    copyDb(backup, dbFile);
    await start(a);
    await sleep(1500);
    line((await headOf(a, mir.id)).startsWith('2:'), 'the authority is back with two entries fewer');
    const found = await op(b, 'compare', { coinId: mir.id });
    line(found.status === 200 && found.json.results[A] === 'rollback' && found.json.state === 'frozen', 'a partner that compares freezes on the rolled-back authority', found.json);
    const states = [];
    for (const n of [a, b, c]) states.push((await get(n, 'action=head&coin=' + mir.id)).json.state);
    line(states.every((x) => x === 'frozen'), 'the authority and the other partner checked the evidence and froze too', states);
    const evid = await op(c, 'evidence', { coinId: mir.id });
    line(evid.status === 200 && evid.json.state === 'frozen' && evid.json.evidence.length >= 1 && evid.json.evidence[0].kind === 'rollback', 'the evidence is kept for review', evid.json);
    const stuck = await post(a, 'action=propose', { authorization: await transfer(alice, a, mir.id, bob.key, '1') });
    line(stuck.status === 409 && stuck.json.code === 'not-active', 'a frozen coin takes no new spend', stuck.json);
    line((await get(b, 'action=coin&coin=' + mir.id)).json.state === 'frozen' && (await get(b, 'action=receipt&coin=' + mir.id + '&index=4')).status === 200, 'and its history stays readable');
    const frozenRun = await op(b, 'compare', { coinId: mir.id });
    line(frozenRun.status === 200 && Object.keys(frozenRun.json.results).length === 0 && frozenRun.json.state === 'frozen', 'a frozen copy compares nothing more', frozenRun.json);
  } finally {
    for (const n of Object.values(nodes)) if (n.proc) n.proc.kill('SIGKILL');
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHAIN-LABS MULTI ENDPOINT CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); process.exit(1); });
