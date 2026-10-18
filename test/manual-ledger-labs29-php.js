// The experimental Labs 29 adapter against the real prototype file, run under PHP.
//
// The prototype lives in another repository, so this test does not run unless it is pointed at a
// copy of it:
//   LABS29_PHP=/path/to/ledger29.php node test/manual-ledger-labs29-php.js
// It needs `php` with openssl and pdo_sqlite. Everything happens in a temporary folder with its own
// test registry and ledger database; nothing is contacted but a PHP server on loopback.
//
// What it shows: the adapter's discovery check, its request (signed the way the wallet signs) and
// its reading of the answers agree with the prototype as it is. What it does not show: anything
// about the live sites, a funded real account, or a signed receipt (there are none).
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;
const A = require(path.resolve(__dirname, '..', 'extension', 'ledger-labs29.js'));

const SRC = process.env.LABS29_PHP;
if (!SRC || !fs.existsSync(SRC)) { console.log('SKIP set LABS29_PHP to a copy of ledger29.php to run this'); process.exit(0); }
try { execFileSync('php', ['-m'], { stdio: 'pipe' }); } catch (err) { console.log('SKIP php is not available'); process.exit(0); }

let passes = 0, failures = 0;
const failed = [];
function check(name, ok, detail) {
  if (ok) { passes++; console.log('PASS ' + name); }
  else { failures++; failed.push(name); console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
// The same text the wallet signs (AtlasWallet.canonicalize).
function canonicalize(v) { if (v === null || typeof v !== 'object') return JSON.stringify(v); if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']'; return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}'; }

const HOST = 'evtec.co.za';
const NET = 'chainblock-labs29-' + HOST;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'labs29-php-'));
const docroot = path.join(tmp, 'htdocs');
const priv = path.join(tmp, 'chainblock-labs-private');
fs.mkdirSync(path.join(docroot, 'chain-labs'), { recursive: true });
fs.mkdirSync(priv);
fs.copyFileSync(SRC, path.join(docroot, 'chain-labs', 'ledger29.php'));
fs.writeFileSync(path.join(tmp, 'prepend.php'), "<?php $_SERVER['HTTPS']='on';\n");

function php(code) { return execFileSync('php', ['-r', code], { stdio: 'pipe' }).toString(); }
php('$p=new PDO("sqlite:' + priv + '/coin26.sqlite");$p->exec("CREATE TABLE coins(id TEXT PRIMARY KEY,domain TEXT NOT NULL,name TEXT NOT NULL,symbol TEXT NOT NULL,decimals INTEGER NOT NULL,UNIQUE(domain,symbol))");$p->exec("INSERT INTO coins VALUES(\'c-goph\',\'' + HOST + '\',\'Test Gold\',\'GOPH\',2),(\'c-mwc\',\'' + HOST + '\',\'Test Credits\',\'MWC\',3)");');

async function newIdentity() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { kp, key: b64(new Uint8Array(await subtle.exportKey('raw', kp.publicKey))), spki: b64(new Uint8Array(await subtle.exportKey('spki', kp.publicKey))) };
}
async function signWith(id, payload) {
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, id.kp.privateKey, new TextEncoder().encode(canonicalize(payload)));
  return b64(new Uint8Array(sig));
}
function fund(ownerKey, coinId, units) {
  php('$p=new PDO("sqlite:' + priv + '/ledger29.sqlite");$p->exec("CREATE TABLE IF NOT EXISTS accounts (coin_id TEXT NOT NULL, owner_key TEXT NOT NULL, amount_units INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(coin_id,owner_key))");$p->exec("INSERT OR REPLACE INTO accounts VALUES(\'' + coinId + '\',\'' + ownerKey + '\',' + units + ')");');
}

// ctx.fetch for the adapter: the address it asks for is the real https one; it is delivered to the
// local PHP server with the Host header the real site would see.
function makeCtx(port, id, edit) {
  const sent = [];
  return {
    sent,
    fetch: (url, init) => new Promise((resolve, reject) => {
      const u = new URL(url);
      sent.push(url);
      const req = http.request({ host: '127.0.0.1', port, path: u.pathname + u.search, method: (init && init.method) || 'GET', headers: Object.assign({ Host: u.host }, (init && init.headers) || {}) }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(new Response(body, { status: res.statusCode, headers: { 'Content-Type': 'application/json' } })));
      });
      req.on('error', reject);
      if (init && init.body) req.write(init.body);
      req.end();
    }),
    sign: async (payload) => {
      if (edit) edit(payload);
      return { signerRole: 'raw-ecdsa', publicKey: id.claimKey || id.key, signature: id.badSignature || await signWith(id, payload) };
    },
    signal: new AbortController().signal
  };
}

const outcome = async (promise) => { try { return { ok: true, value: await promise }; } catch (err) { return { ok: false, code: err && err.code, message: err && err.message }; } };

(async () => {
  const port = 8100 + Math.floor(Math.random() * 800);
  const server = spawn('php', ['-S', '127.0.0.1:' + port, '-t', docroot, '-d', 'auto_prepend_file=' + path.join(tmp, 'prepend.php')], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: HOST } }, (r) => { r.resume(); res(); }).on('error', rej)); break; } catch (e) { await new Promise((r) => setTimeout(r, 100)); } }

    const adapter = A.createAdapter();
    const me = await newIdentity();
    const target = (over) => Object.assign({ issuerDomain: HOST, network: NET, coin: 'GOPH', ownerPublicKey: me.key }, over || {});

    console.log('--- discovery as the prototype publishes it ---');
    const found = await outcome(adapter.discover(target(), makeCtx(port, me)));
    check('the adapter accepts the prototype\'s own discovery answer', found.ok && found.value.operations.balance === 'https://' + HOST + '/chain-labs/ledger29.php?action=balance', found);
    const operations = found.ok ? found.value.operations : { balance: 'https://' + HOST + '/chain-labs/ledger29.php?action=balance' };

    console.log('--- balances ---');
    let r = await outcome(adapter.fetchBalance(target(), { operations }, makeCtx(port, me)));
    check('an account the ledger has not opened is "not found", with no balance', !r.ok && r.code === 'not-found', r);
    r = await outcome(adapter.fetchBalance(target({ coin: 'ZZZZ' }), { operations }, makeCtx(port, me)));
    check('a coin the registry does not list is "unknown coin"', !r.ok && r.code === 'unknown-coin', r);
    fund(me.key, 'c-goph', 1250);
    const ctx = makeCtx(port, me);
    r = await outcome(adapter.fetchBalance(target(), { operations }, ctx));
    check('once the test ledger holds a row, the signed request is accepted and read back exactly', r.ok && r.value.amount === '1250' && r.value.decimals === 2, r);
    check('the request went to the exact operation address only', ctx.sent.length === 1 && ctx.sent[0] === operations.balance, ctx.sent);
    r = await outcome(adapter.fetchBalance(target({ coin: 'MWC' }), { operations }, makeCtx(port, me)));
    check('a different coin of the same owner has its own answer (none)', !r.ok && r.code === 'not-found', r);
    const someone = await newIdentity();
    fund(someone.key, 'c-goph', 777);
    r = await outcome(adapter.fetchBalance(target(), { operations }, makeCtx(port, me)));
    check('another identity\'s row does not change this owner\'s answer', r.ok && r.value.amount === '1250', r);

    console.log('--- what the prototype refuses ---');
    const forged = Object.assign({}, me, { badSignature: b64(webcrypto.getRandomValues(new Uint8Array(64))) });
    r = await outcome(adapter.fetchBalance(target(), { operations }, makeCtx(port, forged)));
    check('a signature that does not verify is "unauthorized"', !r.ok && r.code === 'unauthorized', r);
    const wrongKey = Object.assign({}, me, { badSignature: await signWith(someone, { x: 1 }) });
    r = await outcome(adapter.fetchBalance(target(), { operations }, makeCtx(port, wrongKey)));
    check('a signature made by another key is "unauthorized"', !r.ok && r.code === 'unauthorized', r);
    const passkeyLike = { kp: me.kp, key: me.spki };
    r = await outcome(adapter.fetchBalance(target({ ownerPublicKey: me.spki }), { operations }, makeCtx(port, passkeyLike)));
    check('a passkey-style key is "proof unsupported" (the wallet never sends one; this shows the code)', !r.ok && r.code === 'proof-unsupported', r);
    const alph = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const altKey = me.key.slice(0, -1) + alph[alph.indexOf(me.key.slice(-1)) ^ 1];
    r = await outcome(adapter.fetchBalance(target({ ownerPublicKey: altKey }), { operations }, makeCtx(port, Object.assign({}, me, { claimKey: altKey }))));
    check('a non-canonical spelling of the key is refused, not looked up under a second name', !r.ok && r.code === 'unauthorized', r);
    r = await outcome(adapter.fetchBalance(target(), { operations }, makeCtx(port, me, (p) => { p.audience = 'https://' + HOST + '/chain-labs/ledger29.php?action=discovery'; })));
    check('a request addressed to another operation is refused', !r.ok && (r.code === 'bad-response' || r.code === 'not-supported'), r);
    r = await outcome(adapter.fetchBalance(target(), { operations }, makeCtx(port, me, (p) => { p.issuedAt = new Date(Date.now() - 600000).toISOString(); })));
    check('a request ten minutes old is refused', !r.ok, r);
    r = await outcome(adapter.fetchBalance(target(), { operations }, makeCtx(port, me, (p) => { p.network = 'chainblock-labs29-domain-atlas.co.za'; })));
    check('a request for the other domain\'s network is refused', !r.ok, r);

    console.log('--- what is not there yet ---');
    const before = await outcome(adapter.fetchBalance(target(), { operations }, makeCtx(port, me, (p) => { p.__probe = true; })));
    check('an extra field in the payload is refused', !before.ok, before);
    console.log('NOTE the prototype keeps no record of nonces, so a captured request can be repeated within its two-minute window (read-only today); this test does not rely on either behaviour.');
    console.log('NOTE the prototype has no signed discovery, no signed receipt, no account issuance and no listing operation; the adapter reads none of them.');
  } finally {
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  if (failures) { console.log('Failed: ' + failed.join(' | ')); process.exit(1); }
})();
