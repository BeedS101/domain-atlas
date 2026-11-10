// Buying a ledger coin with a price credential over HTTP (chain-labs/spend34.php, lib/purchase.php) on three live PHP servers,
// each with its own database, domain key and pinned partner keys, and a stand-in for the code that holds Gold credentials
// behind gold-adapter.php. The wallet side is simulated in Node.
//   - a purchase policy at open, a sale on a single authority coin and on 2-of-3 and all-of coins
//   - the answers to bad credentials, bad intents, limits and a credential that is already in use
//   - a partner that is down, the authority restarted with a sale waiting, recovery, cancelling a sale
//   - a partner that has the credential on its revocation list
//   - many buyers at once
//
//   node test/chain-labs-purchase-http.js
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-labs-purchase-http-'));
const base = 22000 + Math.floor(Math.random() * 12000);
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
// The code that holds the credentials: one issuer; only the authority holds its private key, to sign remainders.
const issuer = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const issuerPem = issuer.publicKey.export({ type: 'spki', format: 'pem' });
const issuerKey = b64u(Buffer.from(issuerPem));
const STAND_IN = path.join(__dirname, 'support', 'gold-stand-in.php');
for (const n of Object.values(nodes)) {
  fs.writeFileSync(path.join(n.priv, 'issuer-public.pem'), issuerPem);
  if (n.domain === A) fs.writeFileSync(path.join(n.priv, 'issuer-private.pem'), issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  n.adapter = path.join(n.priv, 'gold-adapter.php');
  fs.writeFileSync(n.adapter, "<?php\nrequire_once '" + STAND_IN + "';\n$issuer = ['public' => file_get_contents(__DIR__ . '/issuer-public.pem')];\nif (is_file(__DIR__ . '/issuer-private.pem')) $issuer['private'] = file_get_contents(__DIR__ . '/issuer-private.pem');\nreturn stand_in_gold(__DIR__ . '/gold-state.sqlite', $issuer);\n");
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

const hex = (n) => crypto.randomBytes(n).toString('hex');
function credential(quantity, w, id) {
  const payload = { id: id || hex(12), class: 'atlas.element.gold', quantity, owner: w.key };
  return { ...payload, signature: b64u(crypto.sign('sha256', Buffer.from(canon(payload)), issuer.privateKey)) };
}
function intent(w, coinId, cred, price, requestId, recipient) {
  const payload = { action: 'purchase-coin', coinId, credentialId: cred.id, price, recipient: recipient || w.key, requestId, expiresAt: iso(NOW() + 300) };
  return { payload, signature: w.sign(payload) };
}
async function buy(n, w, coinId, quantity, price, o = {}) {
  const cred = o.credential || credential(quantity, w);
  const requestId = o.requestId || hex(16);
  const r = await post(n, 'action=purchase', { coinId, intent: intent(w, coinId, cred, price, requestId, o.recipient), credential: cred });
  return { ...r, requestId, cred };
}
const revoke = (n, id) => require('child_process').execFileSync('php', ['-r', "$d=new PDO('sqlite:" + path.join(n.priv, 'gold-state.sqlite') + "');$d->exec(\"INSERT INTO revoked(credential_id) VALUES('" + id + "')\");"]);
const POLICY = { priceClass: 'atlas.element.gold', issuerKey, unitsPerPrice: 10, minPrice: 5, perKeyUnits: '5000', perDayUnits: '8000' };

(async () => {
  for (const n of Object.values(nodes)) await start(n);
  const a = nodes[A], b = nodes[B], c = nodes[C];
  try {
    const alice = wallet(), bob = wallet(), carol = wallet(), dave = wallet();

    console.log('== the policy at open');
    const sgl = (await createCoin(a, 'SGL')).json;
    const twoOf = (await createCoin(a, 'TWO', { mode: 'multi', partners: [B, C], threshold: 2 })).json;
    const allOf = (await createCoin(a, 'ALL', { mode: 'multi', partners: [B, C] })).json;
    const closed = (await createCoin(a, 'CLS')).json;
    const badPolicy = await op(a, 'open', { coinId: sgl.id, purchase: { ...POLICY, unitsPerPrice: 0 } });
    line(badPolicy.status === 400, 'a purchase policy that does not hold is refused at open', badPolicy.json);
    line((await get(a, 'action=coins')).json.coins.length === 0, 'and nothing was opened');
    const o1 = await op(a, 'open', { coinId: sgl.id, purchase: POLICY });
    const o2 = await op(a, 'open', { coinId: twoOf.id, purchase: POLICY });
    const o3 = await op(a, 'open', { coinId: allOf.id, purchase: POLICY });
    const o4 = await op(a, 'open', { coinId: closed.id });
    line([o1, o2, o3, o4].every((o) => o.status === 201), 'the coins open', [o1, o2, o3, o4].map((o) => o.json));
    line(o1.json.coin.genesis.purchase.unitsPerPrice === 10 && o2.json.coin.genesis.purchase.issuerKey === issuerKey && o4.json.coin.genesis.purchase === undefined, 'the policy is part of the public genesis of the coins that have one');
    const gb = await get(b, 'action=coin&coin=' + twoOf.id);
    line(gb.json.genesis.purchase && gb.json.genesis.purchase.minPrice === 5, 'and the partners hold the same genesis');

    console.log('\n== a sale on a single authority coin');
    const s1 = await buy(a, alice, sgl.id, 100, 20);
    line(s1.status === 201 && s1.json.receipt.entry.amount === '200' && s1.json.receipt.entry.purchase.price === 20 && s1.json.balance.balance.quantity === 80, 'a purchase delivers the units at the coin\'s rate and returns the remainder', s1.json);
    line((await units(a, alice, sgl.id)) === '200', 'the buyer holds them');
    const s1b = await post(a, 'action=purchase', { coinId: sgl.id, intent: intent(alice, sgl.id, s1.cred, 20, s1.requestId), credential: s1.cred });
    line(s1b.status === 201 && s1b.json.receipt.hash === s1.json.receipt.hash && (await units(a, alice, sgl.id)) === '200', 'the same request again returns the same result and delivers nothing more', s1b.json);
    const diffPrice = await post(a, 'action=purchase', { coinId: sgl.id, intent: intent(alice, sgl.id, s1.cred, 30, s1.requestId), credential: s1.cred });
    line(diffPrice.status === 409 && diffPrice.json.code === 'request-reused', 'the request id cannot be used for another price', diffPrice.json);
    const gift = await buy(a, alice, sgl.id, 50, 10, { recipient: bob.key });
    line(gift.status === 201 && (await units(a, bob, sgl.id)) === '100', 'the units can go to another key', gift.json);

    console.log('\n== refusals');
    const before = await headOf(a, sgl.id);
    const stranger = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const forged = (() => { const p = { id: hex(12), class: 'atlas.element.gold', quantity: 100, owner: carol.key }; return { ...p, signature: b64u(crypto.sign('sha256', Buffer.from(canon(p)), stranger.privateKey)) }; })();
    const cases = [
      ['a credential another issuer signed', await buy(a, carol, sgl.id, 100, 20, { credential: forged }), 400, 'bad-purchase'],
      ['a price below the minimum', await buy(a, carol, sgl.id, 100, 4), 400, 'purchase-too-small'],
      ['a price above the credential', await buy(a, carol, sgl.id, 10, 11), 400, 'bad-purchase'],
      ['a credential already spent', await buy(a, alice, sgl.id, 100, 20, { credential: s1.cred }), 409, 'locked'],
    ];
    for (const [name, r, status, code] of cases) line(r.status === status && r.json.code === code, 'refused: ' + name, r.json);
    const other = await post(a, 'action=purchase', { coinId: sgl.id, intent: intent(carol, closed.id, credential(100, carol), 20, hex(16)), credential: credential(100, carol) });
    line(other.status === 400 && other.json.code === 'bad-purchase', 'refused: an intent that names another coin', other.json);
    const noPolicy = await buy(a, carol, closed.id, 100, 20);
    line(noPolicy.status === 409 && noPolicy.json.code === 'no-purchase-policy', 'a coin with no policy is not for sale', noPolicy.json);
    const badBody = await post(a, 'action=purchase', { coinId: sgl.id, credential: s1.cred });
    line(badBody.status === 400, 'a request with no intent is refused', badBody.json);
    const tooBig = await post(a, 'action=purchase', { coinId: sgl.id, intent: { payload: {}, signature: 'x'.repeat(40000) }, credential: {} });
    line(tooBig.status >= 400 && tooBig.status < 500, 'and so is one that is far too large', tooBig.status);
    const partner = await buy(b, carol, twoOf.id, 100, 20);
    line((await headOf(a, sgl.id)) === before, 'nothing was written by any of them');
    line(partner.status === 409 && partner.json.code === 'not-authority' && partner.json.authority === A, 'a partner points the buyer at the authority', partner.json);
    const lim = await buy(a, alice, sgl.id, 500, 500);
    line(lim.status === 409 && lim.json.code === 'purchase-key-limit', 'a key cannot buy more than the coin\'s limit', lim.json);
    fs.renameSync(a.adapter, a.adapter + '.off');
    const off = await buy(a, carol, sgl.id, 100, 20);
    fs.renameSync(a.adapter + '.off', a.adapter);
    line(off.status === 503 && off.json.code === 'purchases-off', 'a domain with no adapter says purchases are not enabled', off.json);
    const wallet404 = await post(a, 'action=purchase', { coinId: 'f'.repeat(32), intent: intent(carol, 'f'.repeat(32), credential(100, carol), 20, hex(16)), credential: credential(100, carol) });
    line(wallet404.status === 404, 'and an unknown coin is a 404', wallet404.json);

    console.log('\n== a sale on a 2-of-3 coin');
    const t1 = await buy(a, alice, twoOf.id, 100, 20);
    line(t1.status === 201 && t1.json.receipt.approvals.length === 1 && t1.json.receipt.entry.amount === '200', 'the sale carries one partner\'s approval', t1.json);
    for (const n of [b, c]) await get(n, 'action=coin&coin=' + twoOf.id);
    line(levelOk(await level(twoOf.id)), 'all three hold the same log');
    for (const n of [a, b, c]) line((await units(n, alice, twoOf.id)) === '200', n.domain + ' reports the units');
    await stop(c);
    const t2 = await buy(a, bob, twoOf.id, 100, 20);
    line(t2.status === 201 && t2.json.receipt.approvals[0].domain === B, 'with one partner down the other approves', t2.json);
    await start(c);

    console.log('\n== a sale on an all-of coin while a partner is down');
    await stop(c);
    const w1 = await buy(a, carol, allOf.id, 100, 20);
    line(w1.status === 202 && w1.json.code === 'pending' && (await units(a, carol, allOf.id)) === '0', 'the sale waits and nothing is delivered', w1.json);
    const reuse = await buy(a, carol, allOf.id, 100, 20, { credential: w1.cred });
    line(reuse.status === 409 && reuse.json.code === 'locked', 'the credential cannot be used for another sale while this one waits', reuse.json);
    const again = await post(a, 'action=purchase', { coinId: allOf.id, intent: intent(carol, allOf.id, w1.cred, 20, w1.requestId), credential: w1.cred });
    line(again.status === 202, 'asking again while the partner is still down changes nothing', again.json);
    await stop(a);
    await start(a);
    await start(c);
    const rec = await op(a, 'purchase-recover', { coinId: allOf.id });
    line(rec.status === 200 && String(rec.json.results[w1.requestId]).startsWith('done'), 'after the authority restarted and the partner came back, recovery delivers it', rec.json);
    line((await units(a, carol, allOf.id)) === '200', 'once');
    const stored = await post(a, 'action=purchase', { coinId: allOf.id, intent: intent(carol, allOf.id, w1.cred, 20, w1.requestId), credential: w1.cred });
    line(stored.status === 201 && stored.json.balance.balance.quantity === 80, 'and the buyer asking again gets the stored result with the remainder', stored.json);
    for (const n of [b, c]) await get(n, 'action=coin&coin=' + allOf.id);
    line(levelOk(await level(allOf.id)), 'the partner that was down is level with the others');
    const again2 = await op(a, 'purchase-recover', { coinId: allOf.id });
    line(again2.status === 200 && Object.keys(again2.json.results).length === 0, 'a second recovery has nothing to do', again2.json);

    console.log('\n== partners that refuse the credential');
    const rv = await buy(a, dave, twoOf.id, 100, 20);
    line(rv.status === 201, 'a first sale is fine', rv.json);
    const doomed = credential(100, dave);
    revoke(b, doomed.id);
    revoke(c, doomed.id);
    const rq = hex(16);
    const bad = await post(a, 'action=purchase', { coinId: twoOf.id, intent: intent(dave, twoOf.id, doomed, 20, rq), credential: doomed });
    line(bad.status === 202 && (await units(a, dave, twoOf.id)) === '200', 'with both partners holding it on their revocation lists the sale cannot be approved and waits', bad.json);
    const cancel = await op(a, 'purchase-cancel', { coinId: twoOf.id, requestId: rq });
    line(cancel.status === 200, 'the operator can cancel it', cancel.json);
    const afterCancel = await op(a, 'purchase-recover', { coinId: twoOf.id });
    line(Object.keys(afterCancel.json.results).length === 0 && (await units(a, dave, twoOf.id)) === '200', 'and recovery leaves it alone', afterCancel.json);
    const cancelDone = await op(a, 'purchase-cancel', { coinId: twoOf.id, requestId: t1.requestId });
    line(cancelDone.status === 409 && cancelDone.json.code === 'cannot-cancel', 'a sale that was delivered cannot be cancelled', cancelDone.json);
    const needToken = await post(a, 'action=purchase-recover', { coinId: twoOf.id });
    line(needToken.status === 401 || needToken.status === 403, 'recovery needs the operator token', needToken.status);

    console.log('\n== many buyers at once');
    const buyers = [wallet(), wallet(), wallet(), wallet(), wallet(), wallet()];
    const results = await Promise.all(buyers.map((w) => buy(a, w, sgl.id, 100, 20)));
    line(results.every((r) => r.status === 201 || r.status === 202), 'every sale is delivered or waits, none fails', results.map((r) => r.status + ':' + (r.json && r.json.code)));
    await op(a, 'purchase-recover', { coinId: sgl.id });
    let total = 0;
    for (const w of buyers) total += Number(await units(a, w, sgl.id));
    line(total === 1200, 'after recovery every buyer holds exactly what was bought', total);
    const final = await op(a, 'purchase-recover', { coinId: sgl.id });
    line(Object.keys(final.json.results).length === 0, 'and nothing is left waiting', final.json);
  } finally {
    for (const n of Object.values(nodes)) if (n.proc) n.proc.kill('SIGKILL');
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHAIN-LABS PURCHASE ENDPOINT CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.log('ERROR ' + e.stack); process.exit(1); });
