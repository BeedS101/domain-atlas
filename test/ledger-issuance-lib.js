// Test doubles and helpers for the ledger-account issuance tests.
//
//   - owners and requests: a raw P-256 owner key, and builders for the issuance request and the
//     listing request it carries, signed the way the wallet signs (SHA-256 over canonical JSON)
//   - startCoreStandin(): a STAND-IN for Core's Labs 31 listing operation that can be told to
//     misbehave. It follows the documented behaviour; it is not Core.
//   - startCoreReal(dir): the real Core files (account30.php, accounts31.php) under PHP, from a
//     folder given by CORE_LABS_DIR. Only used when that folder is supplied.
//   - startIssuer('node' | 'php', ...): the real issuer, run from this repository in a temporary
//     copy with its own key, state and document root.
//
// Everything listens on loopback. The issuers and the ledger are reached with the Host header
// the live sites would see, because the endpoint refuses any other host.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { webcrypto, createHash } = require('crypto');
const { subtle } = webcrypto;

const DOMAIN = 'evtec.co.za';
const NETWORK = 'chainblock-labs29-' + DOMAIN;
const OPERATION = 'https://' + DOMAIN + '/atlas/ledger/account-credential';
const ACCOUNTS_URL = 'https://' + DOMAIN + '/chain-labs/accounts31.php?action=accounts';
const OPEN_URL = 'https://' + DOMAIN + '/chain-labs/account30.php?action=open';
const REPO = path.resolve(__dirname, '..');

const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const hex = (n) => Buffer.from(webcrypto.getRandomValues(new Uint8Array(n))).toString('hex');
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
// The same text the wallet signs (AtlasWallet.canonicalize).
function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}
// An independent derivation of the account ID, written out here on purpose.
function derivedId(network, coin, owner) {
  return 'urn:atlas:ledger-account:' + createHash('sha256').update(canonicalize({ coin, network, owner, purpose: 'atlas.ledger.account-id', v: 1 })).digest('hex');
}

async function newOwner() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const key = b64(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)));
  const spki = b64(new Uint8Array(await subtle.exportKey('spki', kp.publicKey)));
  const sign = async (payload) => b64(new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(canonicalize(payload)))));
  return { kp, key, spki, sign };
}

// A complete, valid issuance request for `owner`. `edit` can change the parts before they are
// signed (intent, listing) and `after` can change the finished body.
async function buildRequest(owner, coin, edit) {
  edit = edit || {};
  const t = edit.now || Date.now();
  const listing = { type: 'atlas.ledger.accounts', v: 1, audience: ACCOUNTS_URL, network: NETWORK, nonce: hex(16), issuedAt: iso(t) };
  if (edit.listing) edit.listing(listing);
  const listingProof = { publicKey: edit.listingKey || owner.key, signature: await (edit.listingSigner || owner).sign(listing) };
  const intent = { type: 'atlas.ledger.account.issue', v: 1, audience: OPERATION, network: NETWORK, coin, nonce: hex(16), issuedAt: iso(t), existenceNonce: listing.nonce };
  if (edit.intent) edit.intent(intent);
  const proof = { signerRole: 'raw-ecdsa', publicKey: owner.key, signature: await (edit.signer || owner).sign(intent) };
  if (edit.proof) edit.proof(proof);
  const body = { payload: intent, proof, existence: { payload: listing, proof: listingProof } };
  if (edit.after) edit.after(body);
  return body;
}

// One HTTP call with the Host header the live site would see.
function call(port, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: Object.assign({ Host: DOMAIN, 'X-Forwarded-Proto': 'https' }, raw !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : {}, headers || {}) }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch (e) { json = null; } resolve({ status: res.statusCode, json, text, headers: res.headers }); });
    });
    req.on('error', reject);
    if (raw !== undefined) req.write(raw);
    req.end();
  });
}

async function waitFor(port, urlPath, ms) {
  const end = Date.now() + (ms || 15000);
  while (Date.now() < end) {
    try { const r = await call(port, 'GET', urlPath); if (r.status > 0) return true; } catch (e) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server on ' + port + ' did not come up for ' + urlPath);
}

const freePort = () => new Promise((resolve) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

// ---------------------------------------------------------------------------------------------
// A STAND-IN for Core's listing operation (accounts31.php). Same envelope checks, same answer
// shape; `state.mode` makes it lie, fail or stall.
async function startCoreStandin() {
  const state = { accounts: new Map(), calls: [], mode: 'ok' };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const send = (status, code, extra) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(Object.assign({ ok: status < 400, code }, extra || {}))); };
      state.calls.push({ url: req.url, host: req.headers.host, body: raw });
      if (state.mode === 'down') return send(503, 'unavailable');
      if (state.mode === 'error500') return send(500, 'boom');
      if (state.mode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>not json</html>'); }
      if (state.mode === 'redirect') { res.writeHead(302, { Location: 'https://example.invalid/' }); return res.end(); }
      if (state.mode === 'huge') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, pad: 'x'.repeat(200000) })); }
      if (state.mode === 'refuse401') return send(401, 'bad-signature');
      if (state.mode === 'refuse400') return send(400, 'malformed-request');
      if (req.method !== 'POST' || req.url !== '/chain-labs/accounts31.php?action=accounts') return send(404, 'unknown-operation');
      if (req.headers.host !== DOMAIN) return send(400, 'unknown-host');
      let r; try { r = JSON.parse(raw); } catch (e) { return send(400, 'malformed-request'); }
      const p = r && r.payload, pr = r && r.proof;
      if (!p || !pr || p.type !== 'atlas.ledger.accounts' || p.audience !== ACCOUNTS_URL) return send(401, 'wrong-audience');
      if (p.network !== NETWORK) return send(400, 'unknown-network');
      if (Math.abs(Date.now() - Date.parse(p.issuedAt)) > 120000) return send(401, 'stale-request');
      try {
        const pub = await subtle.importKey('raw', Buffer.from(pr.publicKey, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        if (!(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(pr.signature, 'base64url'), new TextEncoder().encode(canonicalize(p))))) return send(401, 'bad-signature');
      } catch (e) { return send(401, 'bad-signature'); }
      const mine = [...(state.accounts.get(pr.publicKey) || [])];
      const entry = (coin) => ({ accountId: derivedId(NETWORK, coin, pr.publicKey), network: NETWORK, coin, coinId: 'c-' + coin.toLowerCase(), ownerKey: pr.publicKey });
      let accounts = mine.map(entry);
      let answer = { network: NETWORK, ownerKey: pr.publicKey };
      if (state.mode === 'wrong-owner') answer.ownerKey = 'A'.repeat(87);
      if (state.mode === 'wrong-network') answer.network = 'chainblock-labs29-domain-atlas.co.za';
      if (state.mode === 'wrong-id') accounts = accounts.map((a) => Object.assign({}, a, { accountId: 'urn:atlas:ledger-account:' + '0'.repeat(64) }));
      if (state.mode === 'account-wrong-owner') accounts = accounts.map((a) => Object.assign({}, a, { ownerKey: 'B'.repeat(87) }));
      if (state.mode === 'duplicate') accounts = accounts.concat(accounts);
      if (state.mode === 'invent') accounts = accounts.concat([entry('GOPH')]); // lists an account the ledger does not hold
      if (state.mode === 'wrong-code') return send(200, 'something-else', Object.assign(answer, { accounts, count: accounts.length }));
      return send(200, 'accounts-found', Object.assign(answer, { accounts, count: accounts.length }));
    });
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  return {
    kind: 'standin', port, state, base: 'http://127.0.0.1:' + port,
    async openAccount(owner, coin) { const l = state.accounts.get(owner.key) || new Set(); l.add(coin); state.accounts.set(owner.key, l); return { created: true }; },
    callCount: () => state.calls.length,
    close: () => new Promise((r) => server.close(() => r()))
  };
}

// ---------------------------------------------------------------------------------------------
// The real Core files under PHP. `dir` holds account30.php and accounts31.php (and ledger29.php).
async function startCoreReal(dir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'core-real-'));
  const docroot = path.join(tmp, 'htdocs');
  const priv = path.join(tmp, 'chainblock-labs-private');
  fs.mkdirSync(path.join(docroot, 'chain-labs'), { recursive: true });
  fs.mkdirSync(priv);
  for (const f of ['account30.php', 'accounts31.php', 'ledger29.php']) {
    if (fs.existsSync(path.join(dir, f))) fs.copyFileSync(path.join(dir, f), path.join(docroot, 'chain-labs', f));
  }
  fs.writeFileSync(path.join(tmp, 'prepend.php'), "<?php $_SERVER['HTTPS']='on';\n");
  const php = (code) => execFileSync('php', ['-r', code], { stdio: 'pipe' }).toString();
  php('$p=new PDO("sqlite:' + priv + '/coin26.sqlite");$p->exec("CREATE TABLE coins(id TEXT PRIMARY KEY,domain TEXT NOT NULL,name TEXT NOT NULL,symbol TEXT NOT NULL,decimals INTEGER NOT NULL,UNIQUE(domain,symbol))");$p->exec("INSERT INTO coins VALUES(\'c-goph\',\'' + DOMAIN + '\',\'Test Gold\',\'GOPH\',6),(\'c-mwc\',\'' + DOMAIN + '\',\'Test Credits\',\'MWC\',6)");');
  const port = await freePort();
  const child = spawn('php', ['-S', '127.0.0.1:' + port, '-t', docroot, '-d', 'auto_prepend_file=' + path.join(tmp, 'prepend.php')], { stdio: 'ignore', env: Object.assign({}, process.env, { PHP_CLI_SERVER_WORKERS: '4' }) });
  await waitFor(port, '/');
  // A counting pass-through in front of PHP, so a test can tell how many times the ledger was asked.
  const calls = [];
  const front = http.createServer((req, res) => {
    calls.push(req.url);
    const up = http.request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  const frontPort = await new Promise((r) => front.listen(0, '127.0.0.1', () => r(front.address().port)));
  return {
    kind: 'real', port, calls, base: 'http://127.0.0.1:' + frontPort,
    // Opens the account the way Labs 33 does: a signed Labs 30 request.
    async openAccount(owner, coin) {
      const payload = { type: 'atlas.ledger.account.open', v: 1, audience: OPEN_URL, network: NETWORK, coin, nonce: hex(16), issuedAt: iso(Date.now()) };
      const r = await call(port, 'POST', '/chain-labs/account30.php?action=open', { payload, proof: { publicKey: owner.key, signature: await owner.sign(payload) } });
      if (r.status !== 201 && r.status !== 200) throw new Error('could not open the account: ' + r.text);
      return { created: r.status === 201 };
    },
    callCount: () => calls.length,
    close: () => { front.close(); child.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }
  };
}

// ---------------------------------------------------------------------------------------------
// The real issuer, in a temporary copy. Returns uniform paths so a test can edit config, the
// published key document and the revocation list without caring which backend it is.
async function startIssuer(kind, core) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'issuer-' + kind + '-'));
  const port = await freePort();
  let child;
  const issuer = { kind, port, tmp, call: (m, u, b, h) => call(port, m, u, b, h), route: '/atlas/ledger/account-credential' };
  if (kind === 'node') {
    const docroot = path.join(tmp, 'docroot'), state = path.join(tmp, 'state');
    fs.mkdirSync(path.join(docroot, '.well-known'), { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    Object.assign(issuer, {
      configPath: path.join(state, 'atlas-ledger-issuance-config.json'), storePath: path.join(state, 'atlas-ledger-issuance-store.json'),
      keyDocPath: path.join(docroot, '.well-known', 'atlas-key.json'), revocationsPath: path.join(docroot, '.well-known', 'atlas-revocations.json'),
      keyFile: path.join(state, 'issuer-private-key.jwk.json'), wellKnownDir: path.join(docroot, '.well-known')
    });
    child = spawn('node', [path.join(REPO, 'issuer-server', 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(port), ATLAS_DOMAIN: DOMAIN, ATLAS_DOCROOT: docroot, ATLAS_STATE_DIR: state, ATLAS_LEDGER_TRUST_FORWARDED_PROTO: '1' }),
      stdio: 'ignore'
    });
    await waitFor(port, '/.well-known/atlas-key.json');
  } else {
    const copy = path.join(tmp, 'php');
    fs.cpSync(path.join(REPO, 'issuer-php'), copy, { recursive: true, filter: (src) => !/\.lock$|-store\.json$|issuer-private-key\.pem$|reviewer-private-key\.pem$|atlas-key\.json$|atlas-reviewer-key\.json$|atlas-revocations\.json$|atlas-suspensions\.json$|-config\.json$/.test(src) });
    fs.mkdirSync(path.join(copy, '.well-known'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'prepend.php'), "<?php $_SERVER['HTTPS']='on';\n");
    Object.assign(issuer, {
      configPath: path.join(copy, 'lib', 'atlas-ledger-issuance-config.json'), storePath: path.join(copy, 'lib', 'atlas-ledger-issuance-store.json'),
      keyDocPath: path.join(copy, '.well-known', 'atlas-key.json'), revocationsPath: path.join(copy, '.well-known', 'atlas-revocations.json'),
      keyFile: path.join(copy, 'lib', 'issuer-private-key.pem'), wellKnownDir: path.join(copy, '.well-known'), copy
    });
    // The established key: made once, by the issuer's own start-up code, before anything is tested.
    issuer.establishKey = () => execFileSync('php', ['-r', "require '" + path.join(copy, 'lib', 'bootstrap.php') + "'; atlas_load_keys();"], { stdio: 'pipe', env: Object.assign({}, process.env, { HTTP_HOST: DOMAIN }) });
    issuer.establishKey();
    child = spawn('php', ['-S', '127.0.0.1:' + port, '-t', copy, '-d', 'auto_prepend_file=' + path.join(tmp, 'prepend.php'), path.join(copy, 'test-router.php')], { stdio: 'ignore', env: Object.assign({}, process.env, { PHP_CLI_SERVER_WORKERS: '4' }) });
    await waitFor(port, '/.well-known/atlas-key.json');
  }
  issuer.enable = (over) => fs.writeFileSync(issuer.configPath, JSON.stringify(Object.assign({ enabled: true, domain: DOMAIN, coreBase: core ? core.base : undefined }, over || {})));
  issuer.disable = () => { try { fs.unlinkSync(issuer.configPath); } catch (e) { /* none */ } };
  issuer.keyDoc = () => JSON.parse(fs.readFileSync(issuer.keyDocPath, 'utf8'));
  issuer.setKeyDoc = (doc) => fs.writeFileSync(issuer.keyDocPath, JSON.stringify(doc));
  issuer.revoke = (id) => { let d = { revoked: [] }; try { d = JSON.parse(fs.readFileSync(issuer.revocationsPath, 'utf8')); } catch (e) { /* none */ } d.revoked.push({ id, revokedAt: new Date().toISOString() }); fs.writeFileSync(issuer.revocationsPath, JSON.stringify(d)); };
  issuer.resetStore = () => { try { fs.unlinkSync(issuer.storePath); } catch (e) { /* none */ } };
  issuer.store = () => { try { return JSON.parse(fs.readFileSync(issuer.storePath, 'utf8')); } catch (e) { return null; } };
  issuer.post = (body, headers) => call(port, 'POST', issuer.route, body, headers);
  issuer.close = () => { child.kill(); fs.rmSync(tmp, { recursive: true, force: true }); };
  return issuer;
}

// Checks a credential's issuer signature with the published key document, independently of the
// issuer and of the wallet (Node's WebCrypto, the wallet's signed-fields rule).
async function credentialSignatureValid(credential, keyDoc) {
  const k = (keyDoc.keys || []).find((x) => x.publicKey === credential.issuer.publicKey);
  if (!k) return false;
  const payload = { id: credential.id, ledger: { network: credential.ledger.network, coin: credential.ledger.coin }, owner: { publicKey: credential.owner.publicKey }, issuedAt: credential.issuedAt };
  const pub = await subtle.importKey('raw', Buffer.from(k.publicKey, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(credential.signature, 'base64url'), new TextEncoder().encode(canonicalize(payload)));
}

module.exports = { DOMAIN, NETWORK, OPERATION, ACCOUNTS_URL, REPO, newOwner, buildRequest, derivedId, canonicalize, b64, hex, iso, call, startCoreStandin, startCoreReal, startIssuer, credentialSignatureValid, freePort, waitFor };
