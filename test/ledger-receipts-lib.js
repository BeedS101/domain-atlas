// Test doubles and helpers for the signed balance receipt tests.
//
//   - makeLedger(): the Labs 29 databases. With the real Core files available (CORE_LABS_DIR, or the
//     staged Core checkout) the accounts are opened by Core's own account30.php and the figures are
//     read from the databases it created; otherwise a SCHEMA STAND-IN creates the same two tables
//     the Core code defines. It says which one it is in `label`.
//   - startReceiptIssuer('php' | 'node', ledger): the receipt endpoint. 'php' is the real issuer
//     (issuer-php) in a temporary copy with its own key and state, reading the ledger databases from
//     the private folder beside its document root. 'node' is the TEST MIRROR (issuer-server/
//     lib-ledger-receipts.js) behind a test-only HTTP front, with its own throwaway key; the Node
//     issuer server has no receipt route.
//   - buildReceiptRequest(owner, coin, edit): the owner-signed request, signed as the wallet signs.
//   - verifyReceipt(...): an independent acceptance check written for the tests, not shared with the
//     issuer or the wallet.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { webcrypto, createHash } = require('crypto');
const { subtle } = webcrypto;
const L = require('./ledger-issuance-lib');
const { createLedgerReceipts, sqliteReader } = require('../issuer-server/lib-ledger-receipts');

const { DOMAIN, NETWORK, REPO, canonicalize, b64, hex, iso, call, freePort, waitFor, newOwner, derivedId } = L;
const RECEIPT_URL = 'https://' + DOMAIN + '/atlas/ledger/balance-receipt';
const ROUTE = '/atlas/ledger/balance-receipt';
const REQUEST_TYPE = 'atlas.ledger.balance-receipt.request';
const CONTRACT = 'chainblock-ledger38/signed-receipt-experimental';
const CORE_DIR = process.env.CORE_LABS_DIR || '/mnt/user-data/uploads/domain-atlas-core/labs/chainblock-web';
const php = (code) => execFileSync('php', ['-r', code], { stdio: 'pipe' }).toString();

// Puts an account row in the ledger database as the test's own set-up (the same table either way).
function addRow(priv, ownerKey, coin, units) {
  php('$d=new PDO("sqlite:' + priv + '/ledger29.sqlite");$d->exec("CREATE TABLE IF NOT EXISTS accounts (coin_id TEXT NOT NULL, owner_key TEXT NOT NULL, amount_units INTEGER NOT NULL DEFAULT 0 CHECK(amount_units>=0), PRIMARY KEY(coin_id,owner_key))");$d->prepare("INSERT OR REPLACE INTO accounts(coin_id,owner_key,amount_units) VALUES(?,?,?)")->execute(["c-' + coin.toLowerCase() + '","' + ownerKey + '",' + Number(units) + ']);');
}

// ---------------------------------------------------------------------------------------------
async function makeLedger() {
  if (fs.existsSync(path.join(CORE_DIR, 'account30.php')) && fs.existsSync(path.join(CORE_DIR, 'ledger29.php'))) {
    const core = await L.startCoreReal(CORE_DIR);
    core.label = 'real Core files (account30.php opens the accounts)';
    core.real = true;
    core.setDecimals = (coin, d) => { php('$p=new PDO("sqlite:' + core.priv + '/coin26.sqlite");$p->exec("UPDATE coins SET decimals=' + Number(d) + ' WHERE symbol=\'' + coin + '\'");'); };
    core.hasAccountsFile = () => fs.existsSync(path.join(core.priv, 'ledger29.sqlite'));
    core.addAccountRow = (ownerKey, coin, units) => addRow(core.priv, ownerKey, coin, units);
    return core;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-schema-'));
  const priv = path.join(tmp, 'chainblock-labs-private');
  fs.mkdirSync(priv);
  php('$p=new PDO("sqlite:' + priv + '/coin26.sqlite");$p->exec("CREATE TABLE coins(id TEXT PRIMARY KEY,domain TEXT NOT NULL,name TEXT NOT NULL,symbol TEXT NOT NULL,decimals INTEGER NOT NULL,UNIQUE(domain,symbol))");$p->exec("INSERT INTO coins VALUES(\'c-goph\',\'' + DOMAIN + '\',\'Test Gold\',\'GOPH\',6),(\'c-mwc\',\'' + DOMAIN + '\',\'Test Credits\',\'MWC\',6)");');
  const ledgerPhp = (body) => php('$d=new PDO("sqlite:' + priv + '/ledger29.sqlite");$d->exec("CREATE TABLE IF NOT EXISTS accounts (coin_id TEXT NOT NULL, owner_key TEXT NOT NULL, amount_units INTEGER NOT NULL DEFAULT 0 CHECK(amount_units>=0), PRIMARY KEY(coin_id,owner_key))");' + body);
  const ledger = {
    kind: 'schema', real: false, label: 'SCHEMA STAND-IN (same tables as the Core code)', priv, base: null,
    async openAccount(owner, coin) { ledgerPhp('$d->prepare("INSERT OR IGNORE INTO accounts(coin_id,owner_key,amount_units) VALUES(?,?,0)")->execute(["c-' + coin.toLowerCase() + '","' + owner.key + '"]);'); return { created: true }; },
    async seedBalance(ownerKey, coin, units) { ledgerPhp('$d->prepare("UPDATE accounts SET amount_units=? WHERE owner_key=? AND coin_id=?")->execute([' + Number(units) + ',"' + ownerKey + '","c-' + coin.toLowerCase() + '"]);'); },
    async balanceOf(ownerKey, coin) { const o = ledgerPhp('$q=$d->prepare("SELECT amount_units FROM accounts WHERE owner_key=? AND coin_id=?");$q->execute(["' + ownerKey + '","c-' + coin.toLowerCase() + '"]);$v=$q->fetchColumn();echo $v===false?"none":$v;'); return o === 'none' ? null : Number(o); },
    setDecimals(coin, d) { php('$p=new PDO("sqlite:' + priv + '/coin26.sqlite");$p->exec("UPDATE coins SET decimals=' + Number(d) + ' WHERE symbol=\'' + coin + '\'");'); },
    addAccountRow: (ownerKey, coin, units) => addRow(priv, ownerKey, coin, units),
    hasAccountsFile: () => fs.existsSync(path.join(priv, 'ledger29.sqlite')),
    close: () => fs.rmSync(tmp, { recursive: true, force: true })
  };
  return ledger;
}

// ---------------------------------------------------------------------------------------------
async function startReceiptIssuer(kind, ledger, opts) {
  opts = opts || {};
  if (kind === 'php') {
    const issuer = await L.startIssuer('php', null);
    // The private folder sits beside the document root, as on the live host.
    const link = path.join(issuer.tmp, 'chainblock-labs-private');
    fs.symlinkSync(ledger.priv, link);
    Object.assign(issuer, {
      route: ROUTE,
      configPath: path.join(issuer.copy, 'lib', 'atlas-ledger-receipts-config.json'),
      storePath: path.join(issuer.copy, 'lib', 'atlas-ledger-receipts-store.json'),
      issuanceConfigPath: path.join(issuer.copy, 'lib', 'atlas-ledger-issuance-config.json'),
      privateLink: link,
      privateKeyMaterial: () => fs.readFileSync(issuer.keyFile, 'utf8')
    });
    issuer.enable = (over) => fs.writeFileSync(issuer.configPath, JSON.stringify(Object.assign({ enabled: true, domain: DOMAIN }, over || {})));
    issuer.resetStore = () => { try { fs.unlinkSync(issuer.storePath); } catch (e) { /* none */ } };
    issuer.store = () => { try { return JSON.parse(fs.readFileSync(issuer.storePath, 'utf8')); } catch (e) { return null; } };
    issuer.publishedKey = () => issuer.keyDoc().keys[0].publicKey;
    // A ledger-account credential signed by this issuer's own key file (test set-up: the wallet
    // checks it against the published key like any other).
    issuer.credentialFor = (ownerKey, coin) => {
      const id = derivedId(NETWORK, coin, ownerKey);
      const issuedAt = iso(Date.now());
      const payload = { id, ledger: { network: NETWORK, coin }, owner: { publicKey: ownerKey }, issuedAt };
      const out = execFileSync('php', ['-r', "require '" + path.join(issuer.copy, 'lib', 'bootstrap.php') + "'; $k = atlas_load_keys(); echo atlas_sign($k['privateKey'], json_decode($argv[1], true)) . ' ' . $k['publicKeyB64url'];", '--', JSON.stringify(payload)], { stdio: 'pipe', env: Object.assign({}, process.env, { HTTP_HOST: DOMAIN }) }).toString().split(' ');
      return { credential: 'domain-atlas-ledger-account/1.0', id, issuer: { domain: DOMAIN, publicKey: out[1] }, ledger: { network: NETWORK, coin }, owner: { publicKey: ownerKey }, issuedAt, signature: out[0] };
    };
    return issuer;
  }

  // The Node mirror: its own key, key document and state, behind a front that follows the route.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-node-'));
  const state = path.join(tmp, 'state'), wk = path.join(tmp, 'docroot', '.well-known');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(wk, { recursive: true });
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = b64(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)));
  const jwk = await subtle.exportKey('jwk', kp.privateKey);
  const issuer = {
    kind: 'node', tmp, route: ROUTE, publicKey,
    configPath: path.join(state, 'atlas-ledger-receipts-config.json'), storePath: path.join(state, 'atlas-ledger-receipts-store.json'),
    keyDocPath: path.join(wk, 'atlas-key.json'), revocationsPath: path.join(wk, 'atlas-revocations.json'),
    privateKeyMaterial: () => JSON.stringify(jwk)
  };
  fs.writeFileSync(issuer.keyDocPath, JSON.stringify({ keys: [{ publicKey, validFrom: iso(Date.now() - 5000), validUntil: null }] }));
  const reader = opts.readBalance || sqliteReader(ledger.priv);
  const mirror = createLedgerReceipts({
    configFile: issuer.configPath, storeFile: issuer.storePath, keyDocFile: issuer.keyDocPath, revocationsFile: issuer.revocationsPath,
    canonicalize, publicKey, readBalance: (d, c, o) => (issuer.readOverride ? issuer.readOverride(d, c, o) : reader(d, c, o)),
    storageProbe: () => fs.existsSync(path.join(ledger.priv, 'coin26.sqlite')) && fs.existsSync(path.join(ledger.priv, 'ledger29.sqlite')),
    sign: async (payload) => b64(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(canonicalize(payload)))))
  });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let out;
      const wk = /^\/\.well-known\/(atlas-key|atlas-revocations)\.json$/.exec(req.url);
      if (wk) {
        const file = wk[1] === 'atlas-key' ? issuer.keyDocPath : issuer.revocationsPath;
        if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{}'); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(fs.readFileSync(file));
      }
      if (req.url !== ROUTE) out = { status: 404, body: { ok: false, code: 'unknown-operation' } };
      else out = await mirror.handle({ method: req.method, host: req.headers.host, secure: req.headers['x-forwarded-proto'] === 'https', client: req.socket.remoteAddress, rawBody: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(out.status, Object.assign({ 'Content-Type': 'application/json' }, out.headers || {}));
      res.end(JSON.stringify(out.body));
    });
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  Object.assign(issuer, { port, wellKnownDir: wk });
  issuer.call = (m, u, b, h) => call(port, m, u, b, h);
  issuer.post = (body, headers) => call(port, 'POST', ROUTE, body, headers);
  issuer.enable = (over) => fs.writeFileSync(issuer.configPath, JSON.stringify(Object.assign({ enabled: true, domain: DOMAIN }, over || {})));
  issuer.disable = () => { try { fs.unlinkSync(issuer.configPath); } catch (e) { /* none */ } };
  issuer.keyDoc = () => JSON.parse(fs.readFileSync(issuer.keyDocPath, 'utf8'));
  issuer.setKeyDoc = (doc) => fs.writeFileSync(issuer.keyDocPath, JSON.stringify(doc));
  issuer.revoke = (id) => { let d = { revoked: [] }; try { d = JSON.parse(fs.readFileSync(issuer.revocationsPath, 'utf8')); } catch (e) { /* none */ } d.revoked.push({ id, revokedAt: new Date().toISOString() }); fs.writeFileSync(issuer.revocationsPath, JSON.stringify(d)); };
  issuer.resetStore = () => { try { fs.unlinkSync(issuer.storePath); } catch (e) { /* none */ } };
  issuer.store = () => { try { return JSON.parse(fs.readFileSync(issuer.storePath, 'utf8')); } catch (e) { return null; } };
  issuer.publishedKey = () => publicKey;
  issuer.credentialFor = async (ownerKey, coin) => {
    const id = derivedId(NETWORK, coin, ownerKey);
    const issuedAt = iso(Date.now());
    const payload = { id, ledger: { network: NETWORK, coin }, owner: { publicKey: ownerKey }, issuedAt };
    const signature = b64(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(canonicalize(payload)))));
    return { credential: 'domain-atlas-ledger-account/1.0', id, issuer: { domain: DOMAIN, publicKey }, ledger: { network: NETWORK, coin }, owner: { publicKey: ownerKey }, issuedAt, signature };
  };
  issuer.close = () => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); };
  return issuer;
}

// ---------------------------------------------------------------------------------------------
// The owner-signed request. `edit.payload(p)` changes the fields before signing, `edit.proof(pr)` the
// proof, `edit.after(body)` the finished body, `edit.signer` signs with another key.
async function buildReceiptRequest(owner, coin, edit) {
  edit = edit || {};
  const payload = { type: REQUEST_TYPE, v: 1, audience: RECEIPT_URL, network: NETWORK, coin, nonce: hex(16), issuedAt: iso(edit.now || Date.now()) };
  if (edit.payload) edit.payload(payload);
  const proof = { publicKey: owner.key, signature: await (edit.signer || owner).sign(payload) };
  if (edit.proof) edit.proof(proof);
  const body = { payload, proof };
  if (edit.after) edit.after(body);
  return body;
}

// ---------------------------------------------------------------------------------------------
// An independent acceptance check. Returns { ok: true } or { ok: false, why }.
async function verifyReceipt(answer, request, keyDoc, opts) {
  opts = opts || {};
  const keys = (o) => Object.keys(o).sort().join();
  const fail = (why) => ({ ok: false, why });
  if (!answer || keys(answer) !== 'contract,ok,payload,signature,signerKey' || answer.ok !== true || answer.contract !== CONTRACT) return fail('envelope');
  const p = answer.payload, q = request.payload;
  if (keys(p) !== 'account,amount,coin,decimals,network,observedAt,owner,request,state,type,v') return fail('payload shape');
  if (keys(p.request) !== 'hash,nonce' || keys(p.state) !== 'status') return fail('nested shape');
  if (p.type !== 'atlas.ledger.balance-receipt' || p.v !== 1 || p.state.status !== 'no-state-version') return fail('type');
  if (p.request.nonce !== q.nonce || p.request.hash !== createHash('sha256').update(canonicalize(q)).digest('hex')) return fail('request binding');
  if (p.network !== q.network || p.coin !== q.coin || p.owner !== request.proof.publicKey) return fail('network/coin/owner');
  if (p.account !== derivedId(q.network, q.coin, p.owner)) return fail('account');
  if (typeof p.amount !== 'string' || !/^(0|[1-9][0-9]{0,39})$/.test(p.amount) || !Number.isInteger(p.decimals) || p.decimals < 0 || p.decimals > 18) return fail('amount');
  const obs = Date.parse(p.observedAt) / 1000, iss = Date.parse(q.issuedAt) / 1000;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(p.observedAt) || Math.abs(obs - iss) > 120) return fail('observedAt');
  const k = (keyDoc.keys || []).find((x) => x.publicKey === answer.signerKey);
  if (!k) return fail('signer not listed');
  const from = Date.parse(k.validFrom) / 1000, until = k.validUntil ? Date.parse(k.validUntil) / 1000 : Infinity;
  if (!(obs >= from && obs < until)) return fail('signer not valid at observation');
  try {
    const pub = await subtle.importKey('raw', Buffer.from(answer.signerKey, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const good = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(answer.signature, 'base64url'), new TextEncoder().encode(canonicalize(p)));
    return good ? { ok: true } : fail('signature');
  } catch (e) { return fail('signature'); }
}

// Runs the Core verifier (CLI only) on a receipt. Returns { code, out, err }.
function runVerify38(dir, keyDoc, request, receipt) {
  const verifier = path.join(CORE_DIR, 'verify38.php');
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify(keyDoc));
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify(request));
  const r = require('child_process').spawnSync('php', [verifier, path.join(dir, 'keys.json'), path.join(dir, 'request.json')], { input: JSON.stringify(receipt), encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// ---------------------------------------------------------------------------------------------
// An HTTPS front for the browser: https://evtec.co.za/... resolves to it (throwaway certificate),
// /chain-labs/ goes to the ledger service when there is one, everything else to the issuer. Each
// request is recorded in `hits`. `mutators` is a list of { re, fn }: a matching answer is passed to
// fn({status, text, json, req}), which returns { status?, text?, json? } to change what the wallet
// receives (a test's way of being a network attacker or a misbehaving issuer).
async function receiptFront(issuer, ledgerService, tls, hits, mutators) {
  const https = require('https');
  const corePort = ledgerService && ledgerService.base ? Number(new URL(ledgerService.base).port) : null;
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      hits.push({ method: req.method, url: req.url, body: raw });
      const toLedger = req.url.startsWith('/chain-labs/');
      if (toLedger && !corePort) { res.writeHead(502); return res.end(); }
      const up = http.request({ host: '127.0.0.1', port: toLedger ? corePort : issuer.port, path: req.url, method: req.method, headers: Object.assign({}, req.headers, { host: DOMAIN, 'x-forwarded-proto': 'https' }) }, (r) => {
        const mut = (mutators || []).find((m) => m.re.test(req.url) && (!m.method || m.method === req.method));
        if (!mut) { res.writeHead(r.statusCode, r.headers); r.pipe(res); return; }
        let text = '';
        r.on('data', (c) => { text += c; });
        r.on('end', () => {
          let json = null; try { json = JSON.parse(text); } catch (e) { json = null; }
          const out = mut.fn({ status: r.statusCode, text, json, req: { url: req.url, body: raw } }) || {};
          // A mutator may answer with raw bytes, and may ask for an honest Content-Length (the default is a
          // chunked body, which tells the reader nothing about its size in advance).
          const body = out.bytes !== undefined ? out.bytes : out.text !== undefined ? out.text : (out.json !== undefined ? JSON.stringify(out.json) : text);
          const headers = Object.assign({}, r.headers); delete headers['content-length']; delete headers['transfer-encoding'];
          if (out.withLength) headers['content-length'] = String(Buffer.byteLength(body));
          res.writeHead(out.status || (out.json !== undefined ? 200 : r.statusCode), headers); res.end(body);
        });
      });
      up.on('error', () => { res.writeHead(502); res.end(); });
      up.end(raw);
    });
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  return { port, close: () => new Promise((r) => server.close(() => r())) };
}

module.exports = Object.assign({}, L, { receiptFront, RECEIPT_URL, ROUTE, REQUEST_TYPE, CONTRACT, CORE_DIR, makeLedger, startReceiptIssuer, buildReceiptRequest, verifyReceipt, runVerify38, php, newOwner, derivedId });
