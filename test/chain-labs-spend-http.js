// The spending endpoint of the chain labs (chain-labs/spend34.php) on a throw-away PHP server, driven the way a wallet
// drives it: Node generates the wallet keys, signs the way the wallet does, and verifies the domain's answers.
//   - opening coins of the registry as ledgers, operator grants
//   - owner-signed transfers: executed, idempotent, and every way one is refused
//   - receipts and holdings a wallet can verify; private coins only to a key-signed challenge
//   - no account key in any public read of a private coin
//
//   node test/chain-labs-spend-http.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-labs-spend-'));
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
const server = spawn('php', ['-S', '127.0.0.1:' + port, '-t', root, '-d', 'auto_prepend_file=' + path.join(work, 'prepend.php')], { stdio: 'ignore' });

function call(file, method, query, body, opts = {}) {
  return new Promise((resolve) => {
    const host = opts.host || A;
    const headers = { host, origin: 'https://' + host };
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    if (data !== null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, path: '/' + file + '.php?' + query, method, headers }, (res) => {
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
const transfer = (w, coinId, to, amount, over = {}) => {
  const payload = { type: 'atlas.ledger.transfer', v: 1, coinId, from: w.key, to, amount, baseSeq: 0, baseHead: '0'.repeat(64), nonce: crypto.randomBytes(16).toString('hex'), issuedAt: iso(NOW() - 5), expiresAt: iso(NOW() + 120), ...over };
  return { payload, signature: w.sign(payload) };
};
const verifySig = (data, sig) => crypto.verify('sha256', Buffer.from(data), domainPublic, Buffer.from(sig, 'base64url'));
const receiptOk = (r) => r && crypto.createHash('sha256').update(canon(r.entry)).digest('hex') === r.hash && verifySig(r.hash, r.authoritySignature);
const statementOk = (a, key) => a.statement.domain === A && a.statement.key === key && verifySig(canon(a.statement), a.signature);

(async () => {
  await new Promise((r) => setTimeout(r, 800));
  try {
    console.log('== before anything is opened');
    line((await get('action=coins')).json.coins.length === 0, 'no coins are listed');
    line((await get('action=coin&coin=' + '0'.repeat(32))).status === 404, 'an unknown coin is a 404');
    line((await get('action=receipt&coin=' + '0'.repeat(32) + '&index=0')).status === 404, 'an unknown receipt is a 404');
    const alice = wallet(), bob = wallet(), carol = wallet();
    const none = await post('action=holdings', { key: alice.key });
    line(none.status === 200 && none.json.statement.coins.length === 0 && statementOk(none.json, alice.key), 'a lookup with nothing open is an empty signed statement', none.json);

    console.log('\n== opening coins');
    const pub = (await createCoin('PUB')).json, sec = (await createCoin('SEC', { visibility: 'private' })).json, mul = (await createCoin('MUL', { mode: 'multi', partners: [B] })).json;
    line(pub.ok && sec.ok && mul.ok, 'three coins are registered through the coin form endpoint', [pub, sec, mul].map((x) => x.error));
    const tooMany = { faucet: { maxAmount: '30000', perKeyLimit: '60000', cooldownSeconds: 0 } };
    line((await post('action=open', { coinId: pub.id })).status === 403 && (await post('action=open', { adminToken: '0'.repeat(64), coinId: pub.id })).status === 403, 'opening needs the operator token');
    line((await op('open', { coinId: 'xyz' })).status === 400 && (await op('open', { coinId: '0'.repeat(32) })).status === 404, 'a bad or unknown coin id is refused');
    const o1 = await op('open', { coinId: pub.id });
    line(o1.status === 201 && o1.json.coin.state === 'active' && o1.json.coin.entries === 1 && o1.json.coin.supply === '100000' && o1.json.coin.genesis.visibility === 'public' && o1.json.coin.genesis.faucet === null, 'a registered coin is opened as a ledger with its supply in the treasury', o1.json);
    line((await op('open', { coinId: pub.id })).status === 409, 'a coin is opened once');
    const o2 = await op('open', { coinId: sec.id, ...tooMany });
    line(o2.status === 201 && o2.json.coin.genesis.visibility === 'private' && o2.json.coin.genesis.faucet.maxAmount === '30000', 'a private coin opens, with a faucet policy if the operator gives one', o2.json);
    const o3 = await op('open', { coinId: mul.id });
    line(o3.status === 400 && o3.json.code === 'needs-partners', 'a multi coin does not open on one domain', o3.json);
    const list = (await get('action=coins')).json;
    line(list.coins.length === 2 && list.coins.every((c) => c.state === 'active') && list.domainKey.includes('BEGIN PUBLIC KEY'), 'the two opened coins are listed with the domain key', list);
    const keyFile = path.join(priv, 'treasury-' + pub.id + '.json');
    line(fs.existsSync(keyFile) && (process.platform === 'win32' || (fs.statSync(keyFile).mode & 0o777) === 0o600), 'the treasury key file is in the private folder and readable by its owner only');
    line(fs.existsSync(path.join(priv, 'chain34.sqlite')) && !fs.existsSync(path.join(root, 'chain34.sqlite')), 'the ledger database is in the private folder, not the web root');

    // A treasury key file left by an attempt that stopped before the ledger was written is used, not replaced.
    const left = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const lj = left.publicKey.export({ format: 'jwk' });
    const leftKey = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(lj.x, 'base64url'), Buffer.from(lj.y, 'base64url')]));
    const lft = (await createCoin('LFT')).json;
    fs.writeFileSync(path.join(priv, 'treasury-' + lft.id + '.json'), JSON.stringify({ key: leftKey, private: left.privateKey.export({ type: 'pkcs8', format: 'pem' }) }), { mode: 0o600 });
    const ol = await op('open', { coinId: lft.id });
    line(ol.status === 201 && ol.json.coin.genesis.treasuryRef === leftKey, 'opening uses a treasury key file that is already there', ol.json);
    line((await op('grant', { coinId: lft.id, to: bob.key, amount: '10' })).status === 201, 'and that key signs grants');

    console.log('\n== grants');
    const g0 = await op('grant', { coinId: pub.id, to: alice.key, amount: '50000' });
    line(g0.status === 201 && receiptOk(g0.json.receipt) && g0.json.receipt.entry.index === 1, 'an operator grant executes and returns a verifiable receipt', g0.json);
    line((await post('action=grant', { coinId: pub.id, to: alice.key, amount: '1' })).status === 403, 'a grant needs the operator token');
    line((await op('grant', { coinId: pub.id, to: 'nobody', amount: '1' })).status === 400 && (await op('grant', { coinId: pub.id, to: alice.key, amount: '0' })).status === 400, 'a bad recipient or amount is refused');
    line((await op('grant', { coinId: pub.id, to: alice.key, amount: '5000000' })).status === 409, 'a grant above the treasury balance is refused');
    const gs = await op('grant', { coinId: sec.id, to: alice.key, amount: '25000' });
    const gs2 = await op('grant', { coinId: sec.id, to: alice.key, amount: '25000' });
    line(gs.status === 201 && gs2.status === 201, 'grants on the private coin', [gs.json, gs2.json]);
    const gl = await op('grant', { coinId: sec.id, to: bob.key, amount: '30001' });
    line(gl.status === 400 && gl.json.code === 'faucet-amount', 'the faucet policy limits a grant', gl.json);

    console.log('\n== spending');
    const t1 = transfer(alice, pub.id, bob.key, '1200');
    const r1 = await post('action=propose', { authorization: t1 });
    line(r1.status === 201 && receiptOk(r1.json.receipt) && r1.json.receipt.entry.index === 2 && r1.json.receipt.entry.amount === '1200', 'an owner-signed transfer executes and returns a receipt a wallet verifies', r1.json);
    line(r1.json.receipt.entry.prevHash === g0.json.receipt.hash, 'the receipt extends the previous one');
    const r1again = await post('action=propose', { authorization: t1 });
    line(r1again.status === 201 && r1again.json.receipt.hash === r1.json.receipt.hash, 'sending the same transfer again returns the same receipt', r1again.json);
    const hold = await post('action=holdings', { key: bob.key });
    const bobPub = hold.json.statement.coins.find((c) => c.symbol === 'PUB');
    line(bobPub && bobPub.units === '1200' && bobPub.seq === 0, 'the recipient holds the units', hold.json);
    const ah = await post('action=holdings', { key: alice.key });
    line(ah.json.statement.coins.length === 1 && ah.json.statement.coins[0].units === '48800' && ah.json.statement.coins[0].seq === 1 && ah.json.statement.coins[0].headIndex === 2, "the sender's balance and sequence number moved", ah.json);
    const bad = {
      'a stale sequence number': [transfer(alice, pub.id, bob.key, '1', { baseSeq: 0 }), 409, 'stale'],
      'more than the balance': [transfer(alice, pub.id, bob.key, '999999', { baseSeq: 1 }), 409, 'insufficient'],
      'a zero amount': [transfer(alice, pub.id, bob.key, '0', { baseSeq: 1 }), 400, 'bad-amount'],
      'a transfer to oneself': [transfer(alice, pub.id, alice.key, '1', { baseSeq: 1 }), 400, 'bad-authorization'],
      'an expired proposal': [transfer(alice, pub.id, bob.key, '1', { baseSeq: 1, issuedAt: iso(NOW() - 100), expiresAt: iso(NOW() - 10) }), 409, 'expired'],
      'a sender with no account': [transfer(carol, pub.id, bob.key, '1'), 400, 'no-account'],
    };
    for (const [name, [auth, status, code]] of Object.entries(bad)) {
      const r = await post('action=propose', { authorization: auth });
      line(r.status === status && r.json.code === code, 'refused: ' + name, r.json);
    }
    const forged = transfer(alice, pub.id, bob.key, '10', { baseSeq: 1 });
    forged.payload.amount = '9000';
    line((await post('action=propose', { authorization: forged })).status === 401, 'refused: an amount changed after signing');
    const stolen = transfer(bob, pub.id, carol.key, '10');
    stolen.payload.from = alice.key;
    line((await post('action=propose', { authorization: stolen })).status === 401, "refused: a spend signed by someone else's key");
    const nonceReuse = transfer(alice, pub.id, carol.key, '5', { baseSeq: 1, nonce: t1.payload.nonce });
    line((await post('action=propose', { authorization: nonceReuse })).json.code === 'replayed', 'refused: a nonce that was already used');
    line((await post('action=propose', { authorization: transfer(alice, '1'.repeat(32), bob.key, '1') })).status === 404, 'refused: a coin that does not exist');
    line((await post('action=propose', { authorization: { payload: { coinId: 5 } } })).status === 400 && (await post('action=propose', '{not json')).status === 400 && (await post('action=propose', {})).status === 400, 'refused: malformed requests');
    line((await post('action=propose', 'x'.repeat(9000))).status === 413, 'refused: a request that is too large');
    line((await get('action=propose')).status === 404 && (await call('spend34', 'POST', 'action=coin', {})).status === 404, 'a transfer cannot be sent with GET, and reads cannot be sent with POST');
    const sent = transfer(alice, pub.id, carol.key, '300', { baseSeq: 1 });
    const r2 = await post('action=propose', { authorization: sent });
    line(r2.status === 201 && r2.json.receipt.entry.index === 3 && r2.json.receipt.entry.prevHash === r1.json.receipt.hash, 'a second transfer from the same account follows the first');
    const pr = await get('action=proposal&coin=' + pub.id + '&digest=' + crypto.createHash('sha256').update(canon(sent.payload)).digest('hex'));
    line(pr.json.proposal.status === 'executed' && pr.json.proposal.index === 3 && receiptOk(pr.json.proposal.receipt), 'a proposal can be looked up by its digest', pr.json);
    line((await get('action=proposal&coin=' + pub.id + '&digest=' + 'a'.repeat(64))).status === 404 && (await get('action=proposal&coin=' + pub.id + '&digest=zz')).status === 400, 'an unknown or malformed digest is refused');
    const rc = await get('action=receipt&coin=' + pub.id + '&index=2');
    line(rc.status === 200 && rc.json.receipt.hash === r1.json.receipt.hash, 'a receipt can be read back');
    const coinView = (await get('action=coin&coin=' + pub.id)).json;
    line(coinView.entries === 4 && coinView.head.index === 3 && coinView.accounts === 4, 'the coin view counts entries and accounts', coinView);

    console.log('\n== holdings of private coins');
    const plain = await post('action=holdings', { key: alice.key });
    line(plain.json.statement.proven === false && plain.json.statement.coins.length === 1 && !plain.raw.includes('SEC') && !plain.raw.includes(sec.id), 'a plain lookup does not show, or hint at, the private coin');
    const challenge = (await post('action=challenge', {})).json;
    const holdingsRequest = (w, challengeId, over = {}) => { const payload = { type: 'atlas.ledger.holdings.request', v: 1, domain: A, key: alice.key, challenge: challengeId, ...over }; return { payload, signature: w.sign(payload) }; };
    const proven = await post('action=holdings', { key: alice.key, request: holdingsRequest(alice, challenge.challenge) });
    const byCoin = Object.fromEntries(proven.json.statement.coins.map((c) => [c.symbol, c.units]));
    line(proven.status === 200 && proven.json.statement.proven === true && byCoin.SEC === '50000' && byCoin.PUB === '48500', 'a key-signed request also lists the private coin', proven.json);
    line(statementOk(proven.json, alice.key), 'and the statement verifies against the domain key');
    line((await post('action=holdings', { key: alice.key, request: holdingsRequest(alice, challenge.challenge) })).status === 401, 'a challenge works once');
    const c2 = (await post('action=challenge', {})).json;
    line((await post('action=holdings', { key: alice.key, request: holdingsRequest(bob, c2.challenge) })).status === 401, "a request signed by another key is refused, not answered as a plain lookup");
    line((await post('action=holdings', { key: alice.key, request: holdingsRequest(alice, c2.challenge, { domain: B }) })).status === 400, 'a request meant for another domain is refused');
    line((await post('action=holdings', { key: 'abc' })).status === 400 && (await post('action=holdings', { key: alice.key, request: 'x' })).status === 400, 'a bad key or request is refused');

    console.log('\n== a private coin in public');
    const s1 = await post('action=propose', { authorization: transfer(alice, sec.id, bob.key, '700') });
    line(s1.status === 201 && receiptOk(s1.json.receipt), 'a transfer on the private coin executes');
    const reads = [await get('action=coins'), await get('action=coin&coin=' + sec.id)];
    for (let i = 0; i <= 2; i++) reads.push(await get('action=receipt&coin=' + sec.id + '&index=' + i));
    const publicText = reads.map((r) => r.raw).join('\n') + JSON.stringify(s1.json) + JSON.stringify(gs.json);
    const secrets = [alice.key, bob.key, JSON.parse(fs.readFileSync(path.join(priv, 'treasury-' + sec.id + '.json'), 'utf8')).key];
    line(reads.every((r) => r.status === 200) && secrets.every((k) => !publicText.includes(k) && !publicText.includes(Buffer.from(k, 'base64url').toString('hex'))), 'no account key appears in any public read or receipt of the private coin');
    line(s1.json.receipt.entry.from.length > 20 && s1.json.receipt.entry.to.length > 20 && s1.json.receipt.entry.from !== alice.key, 'the receipt names accounts by reference');

    console.log('\n== host and file checks');
    line((await get('action=coins', { host: 'other.example' })).status === 400, 'a host that is not configured is refused');
    line((await call('spend34', 'GET', 'action=coins', undefined, { host: B })).status === 200, 'another configured host answers');
    const direct = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/lib/spend.php', headers: { host: A } }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }));
    line(direct.status === 404 && direct.body.trim() === '', 'a direct request for the library gets an empty 404');
  } finally {
    server.kill();
    fs.rmSync(work, { recursive: true, force: true });
  }
  console.log('\n' + (failures === 0 ? 'ALL ' + total + ' CHAIN-LABS SPEND ENDPOINT CHECKS PASSED' : failures + ' of ' + total + ' checks FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();
