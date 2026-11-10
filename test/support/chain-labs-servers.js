// Three live PHP servers running the real chain labs endpoints (chain-labs/spend34.php, scan35.php and coin26.php), one per domain
// (a.example, b.example, c.example), each with its own database, domain key and the others' keys pinned, and a stand-in for
// the code that holds Gold behind gold-adapter.php. Used by the tests that drive a wallet against them.
//   const S = require('./support/chain-labs-servers');  S.nodes, S.start(n), S.stop(n), S.op(n, action, body), ...
//   S.cleanup() stops the servers and removes their files.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DIR = path.join(__dirname, '..', '..', 'chain-labs');

const A = 'a.example', B = 'b.example', C = 'c.example', D = 'd.example';
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const canon = (v) => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : (v && typeof v === 'object') ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const key = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
  return { key, privateKey, sign: (payload) => b64u(crypto.sign('sha256', Buffer.from(canon(payload)), { key: privateKey, dsaEncoding: 'ieee-p1363' })) };
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-labs-servers-'));
const base = 24000 + Math.floor(Math.random() * 12000);
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
  for (const f of ['coin26.php', 'spend34.php', 'scan35.php', 'scan35.html', 'coin26.html']) fs.copyFileSync(path.join(DIR, f), path.join(root, f));
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
const STAND_IN = path.join(__dirname, 'gold-stand-in.php');
for (const n of Object.values(nodes)) {
  fs.writeFileSync(path.join(n.priv, 'issuer-public.pem'), issuerPem);
  if (n.domain === A) fs.writeFileSync(path.join(n.priv, 'issuer-private.pem'), issuer.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  n.adapter = path.join(n.priv, 'gold-adapter.php');
  fs.writeFileSync(n.adapter, "<?php\nrequire_once '" + STAND_IN + "';\n$issuer = ['public' => file_get_contents(__DIR__ . '/issuer-public.pem')];\nif (is_file(__DIR__ . '/issuer-private.pem')) $issuer['private'] = file_get_contents(__DIR__ . '/issuer-private.pem');\nreturn stand_in_gold(__DIR__ . '/gold-state.sqlite', $issuer);\n");
}
function start(n) {
  n.proc = spawn('php', ['-S', '127.0.0.1:' + n.port, '-t', n.root, '-d', 'auto_prepend_file=' + path.join(n.dir, 'prepend.php')], { stdio: process.env.CHAIN_LABS_DEBUG ? ['ignore', 'inherit', 'inherit'] : 'ignore', env: { ...process.env, PHP_CLI_SERVER_WORKERS: '6' } });
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
const scan = (n, q) => call(n, 'scan35', 'GET', q);
// A coin's purchase policy lives in its registry row (the Coin Creation Studio puts it there) and opening uses only that. Tests that give a
// ready-made ledger policy at open time register it the way the Studio would have, then open without one.
const { execFileSync: execPolicy } = require('child_process');
function registerPolicy(n, coinId, policy) {
  execPolicy('php', ['-r', '$d=new PDO("sqlite:"."' + path.join(n.priv, 'coin26.sqlite') + '");$q=$d->prepare("UPDATE coins SET purchase=? WHERE id=?");$q->execute([$argv[1],$argv[2]]);', JSON.stringify(policy), coinId]);
}
const op = async (n, action, body) => {
  if (action === 'open' && body && body.purchase !== undefined && body.purchase !== null) { registerPolicy(n, body.coinId, body.purchase); const { purchase, ...rest } = body; body = rest; }
  return post(n, 'action=' + action, { adminToken: n.token, ...body });
};
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
const POLICY = { priceClass: 'atlas.element.gold', issuerKey, unitsPerPrice: 10, minPrice: 5, perKeyUnits: '5000', perDayUnits: '8000' };
function cleanup() {
  for (const n of Object.values(nodes)) if (n.proc) n.proc.kill('SIGKILL');
  fs.rmSync(work, { recursive: true, force: true });
}
module.exports = { A, B, C, D, nodes, issuer, issuerKey, POLICY, b64u, canon, sleep, wallet, start, stop, call, get, post, scan, op, createCoin, NOW, iso, transfer, units, headOf, level, levelOk, hex, credential, cleanup };
