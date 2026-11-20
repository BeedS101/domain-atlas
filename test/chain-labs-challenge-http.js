// Challenge flooding against the spending endpoint (chain-labs/spend34.php) on a throw-away PHP server with several workers.
// Anyone can ask for a challenge without signing anything, so asking must not use up anything a wallet needs:
//   - a flood of unauthenticated challenge requests does not stop a wallet from looking up its private holdings or sending
//   - asking for a challenge writes nothing to the domain's database
//   - a challenge still works once, only for a request the key signed for this domain, and only while it is fresh
//   - the same signed request sent many times at once is answered once
//   - after a flood, ordinary lookups and transfers work as before
//
//   node test/chain-labs-challenge-http.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'chain-labs');
let failures = 0, total = 0;
const line = (ok, text, detail) => { total++; if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + text + (!ok && detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 300) : '')); };

const A = 'a.example', B = 'b.example';
const TOKEN = crypto.randomBytes(32).toString('hex');
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const canon = (v) => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : (v && typeof v === 'object') ? '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v);

function wallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const key = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
  return { key, sign: (payload) => b64u(crypto.sign('sha256', Buffer.from(canon(payload)), { key: privateKey, dsaEncoding: 'ieee-p1363' })) };
}
const domain = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const domainPem = domain.privateKey.export({ type: 'pkcs8', format: 'pem' });
const domainPublic = domain.publicKey;
const peer = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-labs-challenge-'));
const root = path.join(work, 'public');
const priv = path.join(work, 'chainblock-labs-private');
fs.mkdirSync(root);
fs.mkdirSync(priv);
for (const f of ['coin26.php', 'spend34.php']) fs.copyFileSync(path.join(DIR, f), path.join(root, f));
fs.cpSync(path.join(DIR, 'lib'), path.join(root, 'lib'), { recursive: true });
fs.writeFileSync(path.join(priv, 'federation20-config.php'), '<?php return [' + "'private_pem_b64' => '" + Buffer.from(domainPem).toString('base64') + "', 'peer_public_pem_b64' => '" + Buffer.from(peer.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64') + "', 'admin_token_hex' => '" + TOKEN + "'];\n");
fs.writeFileSync(path.join(priv, 'chainlabs-config.json'), JSON.stringify({ hosts: [A, B], peers: { [A]: B, [B]: A } }));
fs.writeFileSync(path.join(work, 'prepend.php'), "<?php $_SERVER['HTTPS'] = 'on';\n");
const port = 21000 + Math.floor(Math.random() * 15000);
const server = spawn('php', ['-S', '127.0.0.1:' + port, '-t', root, '-d', 'auto_prepend_file=' + path.join(work, 'prepend.php')], { stdio: 'ignore', env: Object.assign({}, process.env, { PHP_CLI_SERVER_WORKERS: '6' }) });
const agent = new http.Agent({ keepAlive: true, maxSockets: 24 });

function call(file, method, query, body, opts = {}) {
  return new Promise((resolve) => {
    const host = opts.host || A;
    const headers = { host, origin: 'https://' + host };
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    if (data !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, path: '/' + file + '.php?' + query, method, headers, agent }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch (e) {} resolve({ status: res.statusCode, json, raw: b }); });
    });
    req.on('error', () => resolve({ status: 0, json: null, raw: '' }));
    if (data !== null) req.write(data);
    req.end();
  });
}
const get = (q, opts) => call('spend34', 'GET', q, undefined, opts);
const post = (q, body, opts) => call('spend34', 'POST', q, body, opts);
const op = (action, body) => post('action=' + action, { adminToken: TOKEN, ...body });
const createCoin = (symbol, extra = {}) => call('coin26', 'POST', 'action=create', { name: 'Coin ' + symbol, symbol, decimals: 2, maxSupply: '100000', initialSupply: '1000', description: '', adminToken: TOKEN, ...extra });
const NOW = () => Math.floor(Date.now() / 1000);
const iso = (t) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
const hex32 = /^[a-f0-9]{32}$/;

const request = (w, challenge, over = {}, signer = w) => { const payload = { type: 'atlas.ledger.holdings.request', v: 1, domain: A, key: w.key, challenge, ...over }; return { payload, signature: signer.sign(payload) }; };
const lookup = async (w) => {
  const ch = await post('action=challenge', {});
  if (ch.status !== 200 || !ch.json || !hex32.test(ch.json.challenge || '')) return { status: ch.status, ch };
  return post('action=holdings', { key: w.key, request: request(w, ch.json.challenge) });
};
const rows = () => {
  const r = spawnSync('php', ['-r', '$d=new PDO("sqlite:' + path.join(priv, 'chain34.sqlite') + '");echo (int)$d->query("SELECT COUNT(*) FROM ledger_challenges")->fetchColumn();'], { encoding: 'utf8' });
  return parseInt(r.stdout, 10);
};
async function pool(count, size, make) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => { while (next < count) { const i = next++; out[i] = await make(i); } }));
  return out;
}

(async () => {
  await new Promise((r) => setTimeout(r, 900));
  try {
    const alice = wallet(), bob = wallet();
    const sec = (await createCoin('SEC', { visibility: 'private' })).json;
    const open = await op('open', { coinId: sec.id });
    const grant = await op('grant', { coinId: sec.id, to: alice.key, amount: '700' });
    line(open.status === 201 && grant.status === 201, 'a private coin is opened and the wallet holds some of it', { open: open.json, grant: grant.json });
    console.log('== a wallet before any flood');
    const before = await lookup(alice);
    line(before.status === 200 && before.json.statement.proven === true && before.json.statement.coins.length === 1 && before.json.statement.coins[0].units === '700', 'a key-signed lookup is answered as proven and lists the private coin', before.json || before);

    console.log('\n== a flood of unauthenticated challenge requests');
    const kept = rows();
    const started = Date.now();
    const [answers, midway] = await Promise.all([pool(5300, 20, () => post('action=challenge', {})), pool(60, 3, async () => { await new Promise((r) => setTimeout(r, 40)); return lookup(alice); })]);
    line(midway.every((r) => r.status === 200 && r.json.statement.proven === true), 'wallets looking up while the flood is under way are all answered', midway.filter((r) => r.status !== 200).slice(0, 1).map((r) => r.status));
    const refused = answers.filter((a) => a.status !== 200);
    line(refused.length === 0, 'every one of 5300 requests for a challenge is answered, none is turned away', { refused: refused.length, first: refused[0] && refused[0].json });
    line(answers.filter((a) => a.status === 200).every((a) => hex32.test(a.json.challenge || '')) && new Set(answers.map((a) => a.json && a.json.challenge)).size === answers.length, 'each answer is a distinct 32 character challenge');
    console.log('     (' + Math.round((Date.now() - started) / 100) / 10 + ' s)');
    line(rows() === kept + midway.length, 'asking for a challenge writes nothing; the only records are the lookups that redeemed theirs', { before: kept, lookups: midway.length, after: rows() });

    console.log('\n== a wallet during and after the flood');
    const during = await lookup(alice);
    line(during.status === 200 && during.json.statement.proven === true && during.json.statement.coins.length === 1 && during.json.statement.coins[0].units === '700', 'a key-signed lookup is answered as proven after the flood, with the private coin', during.json || during);
    const fresh = await lookup(bob);
    line(fresh.status === 200 && fresh.json.statement.proven === true, 'a second wallet is served as well');
    const spare = await Promise.all(Array.from({ length: 30 }, () => lookup(wallet())));
    line(spare.every((r) => r.status === 200 && r.json.statement.proven === true), '30 more wallets looking up together are all answered');

    console.log('\n== flooding with signed requests from keys of its own');
    const mine = await pool(400, 16, async () => { const w = wallet(); return lookup(w); });
    line(mine.every((r) => r.status === 200), 'requests that spend their challenges are answered', mine.filter((r) => r.status !== 200).slice(0, 2));
    const after = await lookup(alice);
    line(after.status === 200 && after.json.statement.proven === true, 'a wallet is still answered afterwards');

    console.log('\n== a challenge works once, for the signed request it was used in, and only while it is fresh');
    const ch = (await post('action=challenge', {})).json;
    const first = await post('action=holdings', { key: alice.key, request: request(alice, ch.challenge) });
    const again = await post('action=holdings', { key: alice.key, request: request(alice, ch.challenge) });
    line(first.status === 200 && again.status === 401, 'the same challenge a second time is refused', { first: first.status, again: again.status });
    const c2 = (await post('action=challenge', {})).json;
    line((await post('action=holdings', { key: alice.key, request: request(alice, c2.challenge, {}, bob) })).status === 401, 'a request for one key signed by another is refused');
    line((await post('action=holdings', { key: alice.key, request: request(alice, c2.challenge, { domain: B }) })).status === 400, 'a request meant for another domain is refused');
    const forged = [crypto.randomBytes(16).toString('hex'), c2.challenge.slice(0, 31) + (c2.challenge[31] === '0' ? '1' : '0'), '0'.repeat(32), 'f'.repeat(32)];
    const outcomes = await Promise.all(forged.map((c) => post('action=holdings', { key: alice.key, request: request(alice, c) })));
    line(outcomes.every((o) => o.status === 401), 'a made-up challenge, or an issued one with a digit changed, is refused', outcomes.map((o) => o.status));
    const stillGood = await post('action=holdings', { key: alice.key, request: request(alice, c2.challenge) });
    line(stillGood.status === 200, 'the genuine challenge is untouched by those refusals');
    const other = await post('action=challenge', {}, { host: B });
    line(other.status === 200 && (await post('action=holdings', { key: alice.key, request: request(alice, other.json.challenge) })).status === 401, 'a challenge another domain gave is refused here');

    console.log('\n== the same signed request, many times at once');
    const c3 = (await post('action=challenge', {})).json;
    const sameRequest = request(alice, c3.challenge);
    const many = await Promise.all(Array.from({ length: 12 }, () => post('action=holdings', { key: alice.key, request: sameRequest })));
    line(many.filter((m) => m.status === 200).length === 1 && many.filter((m) => m.status === 401).length === 11, 'exactly one is answered, the others are refused as used', many.map((m) => m.status));

    console.log('\n== transfers are unaffected');
    const payload = { type: 'atlas.ledger.transfer', v: 2, coinId: sec.id, authority: A, genesis: (await get('action=coin&coin=' + sec.id)).json.genesisDigest, from: alice.key, to: bob.key, amount: '100', baseSeq: 0, baseHead: (await get('action=coin&coin=' + sec.id)).json.head.hash, nonce: crypto.randomBytes(16).toString('hex'), issuedAt: iso(NOW() - 5), expiresAt: iso(NOW() + 200) };
    const sent = await post('action=propose', { authorization: { payload, signature: alice.sign(payload) } });
    line(sent.status === 201, 'a signed transfer is executed after the flood', sent.json);
    const moved = await lookup(alice);
    line(moved.status === 200 && moved.json.statement.coins[0].units === '600', 'and the next lookup shows it', moved.json);
  } finally {
    server.kill();
    agent.destroy();
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHAIN-LABS CHALLENGE ENDPOINT CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();
