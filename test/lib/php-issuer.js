// Starts a throw-away copy of issuer-php on a free local port, with a fresh key and no inherited state, and offers the
// few operations a credential's life needs: issue, split, revoke, suspend, unsuspend.
//
//   const issuer = await startIssuer();     issuer.base, issuer.origin, issuer.domain, issuer.dir, issuer.requests (every request line)
//   startIssuer({ prepare(bundleDir) {}, env: {}, workers: 1 })  prepare runs on the fresh copy before the server starts; env is
//                                           added to the server's environment; workers > 1 serves requests in parallel
//   await issuer.issue(ownerPublicKey, 'atlas.badge', 1)
//   await issuer.stop();                    stops the server and deletes the copy
'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { cleanIssuerPhpState } = require('./clean-issuer-php');
const { signSpend } = require('./owner-auth');
const { withAdminAuth } = require('./admin-auth');

const REPO = path.resolve(__dirname, '..', '..');

const canonicalize = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v)
  : Array.isArray(v) ? '[' + v.map(canonicalize).join(',') + ']'
    : '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function rawPublicKey(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
}

async function startIssuer(options) {
  options = options || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-issuer-'));
  const bundle = path.join(dir, 'issuer');
  fs.cpSync(path.join(REPO, 'issuer-php'), bundle, { recursive: true });
  cleanIssuerPhpState(bundle);
  if (options.prepare) options.prepare(bundle);
  const adminPair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const adminKey = rawPublicKey(adminPair.publicKey);
  fs.writeFileSync(path.join(bundle, 'lib', 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: adminKey, addedAt: new Date().toISOString() }] }));
  const port = await freePort();
  const requests = [];
  const env = Object.assign({}, process.env, { ATLAS_MINT_LIMITS: 'off', ATLAS_PRIVATE_MINT: 'off' }, options.workers > 1 ? { PHP_CLI_SERVER_WORKERS: String(options.workers) } : {}, options.env || {});
  const proc = spawn('php', ['-d', 'opcache.enable=0', '-S', 'localhost:' + port, 'test-router.php'], { cwd: bundle, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let started = false;
  proc.stderr.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.includes('started')) started = true;
      const m = /\] \S+ \[(\d+)\]: (GET|POST|HEAD|OPTIONS|PUT|DELETE) (\S+)/.exec(line);
      if (m) requests.push({ status: Number(m[1]), method: m[2], path: m[3] });
    }
  });
  for (let i = 0; i < 200 && !started; i++) await new Promise((r) => setTimeout(r, 25));
  if (!started) throw new Error('issuer-php did not start');
  const base = 'http://localhost:' + port;

  async function post(urlPath, body) {
    const res = await fetch(base + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
    return { status: res.status, body: json, text };
  }
  function adminRequest(urlPath, payload) {
    const signed = withAdminAuth(payload, base, urlPath);
    const signature = crypto.sign('sha256', Buffer.from(canonicalize(signed)), { key: adminPair.privateKey, dsaEncoding: 'ieee-p1363' });
    return post(urlPath, { payload: signed, proof: { signerRole: 'raw-ecdsa', publicKey: adminKey, signature: signature.toString('base64url') } });
  }
  async function ok(promise, what) {
    const res = await promise;
    if (res.status !== 200) throw new Error(what + ' failed: ' + res.status + ' ' + res.text.slice(0, 300));
    return res.body;
  }

  return {
    base,
    origin: base,
    domain: 'localhost:' + port,
    port,
    dir: bundle,
    requests,
    issue: (owner, assetClass, quantity) => ok(post('/atlas/asset/issue', Object.assign({ ownerPublicKey: owner, assetClass }, quantity === undefined ? {} : { quantity })), 'issue'),
    split: (credential, sendAmount, toPublicKey) => ok(post('/atlas/asset/split', signSpend('/atlas/asset/split', { credential, sendAmount, toPublicKey })), 'split'),
    revoke: (id, reason) => ok(adminRequest('/atlas/revoke', { id, reason: reason || 'test' }), 'revoke'),
    suspend: (id, fields) => ok(adminRequest('/atlas/suspend', Object.assign({ id }, fields || {})), 'suspend'),
    unsuspend: (id) => ok(adminRequest('/atlas/unsuspend', { id }), 'unsuspend'),
    post,
    admin: adminRequest,
    published: async (name) => { const r = await fetch(base + '/.well-known/' + name); return { status: r.status, text: await r.text() }; },
    stop: async () => {
      proc.kill();
      await new Promise((r) => setTimeout(r, 50));
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* already gone */ }
    }
  };
}

module.exports = { startIssuer, freePort, rawPublicKey, canonicalize };
