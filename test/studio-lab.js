// Harness for the Asset Studio integration tests: an isolated copy of the PHP issuer served by PHP's
// built-in server, with its own freshly generated issuer key, private state and Studio storage. Nothing
// under issuer-php/ is modified and no real key or wallet is involved; wallet signatures come from keys
// generated here, using the same Web Crypto formats the extension produces.
//
//   const lab = await StudioLab.start({ mint: true });   // instance with minting configured on
//   await lab.post('challenge', {...});  await lab.stop();

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const handedOut = new Set();
const SITE_MODEL_STANDIN = 'SITE-OWN-MODEL: not a glTF or PNG, must never be read or changed by Studio';

function freePort() {
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = srv.address().port;
        srv.close(() => { if (handedOut.has(p)) tryOnce(); else { handedOut.add(p); resolve(p); } });
      });
      srv.on('error', reject);
    };
    tryOnce();
  });
}

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}

// A wallet-style identity: a raw local P-256 key ('raw-ecdsa') or a WebAuthn-style one ('webauthn').
function makeIdentity(role) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const raw = spki.subarray(spki.length - 65);
  const id = { role: role || 'raw-ecdsa', privateKey, publicKey, spki, raw };
  id.publicKeyB64 = id.role === 'webauthn' ? b64u(spki) : b64u(raw);
  return id;
}

// What the wallet's bridge confirmation produces for a page request: the proof envelope plus the
// exact object signed, { ctx, origin, payload }. `opts.flags` / `opts.type` allow malformed assertions.
function signBridge(identity, origin, payload, opts) {
  opts = opts || {};
  const signedPayload = { ctx: opts.ctx || 'atlas.bridge.sign/1', origin, payload };
  if (identity.role === 'raw-ecdsa') {
    const sig = crypto.sign('sha256', Buffer.from(canonicalize(signedPayload)), { key: identity.privateKey, dsaEncoding: 'ieee-p1363' });
    return { signerRole: 'raw-ecdsa', publicKey: identity.publicKeyB64, signature: b64u(sig), signedPayload };
  }
  const hash = crypto.createHash('sha256').update(canonicalize(signedPayload)).digest();
  const clientData = Buffer.from(JSON.stringify({ type: opts.type || 'webauthn.get', challenge: b64u(hash), origin }));
  const flags = opts.flags === undefined ? 0x05 : opts.flags;
  const authData = Buffer.concat([crypto.createHash('sha256').update('rp').digest(), Buffer.from([flags]), Buffer.alloc(4)]);
  const signed = Buffer.concat([authData, crypto.createHash('sha256').update(clientData).digest()]);
  const sig = crypto.sign('sha256', signed, { key: identity.privateKey });
  return { signerRole: 'webauthn', publicKey: identity.publicKeyB64, signature: b64u(sig), clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signedPayload };
}

// Signs an arbitrary protocol payload as the identity (the envelope the issuer's verify_envelope() reads):
// what the wallet's own signWithSelf() produces for an owner-authorized intent.
function signPayload(identity, payload) {
  if (identity.role === 'raw-ecdsa') {
    const sig = crypto.sign('sha256', Buffer.from(canonicalize(payload)), { key: identity.privateKey, dsaEncoding: 'ieee-p1363' });
    return { signerRole: 'raw-ecdsa', publicKey: identity.publicKeyB64, signature: b64u(sig) };
  }
  const hash = crypto.createHash('sha256').update(canonicalize(payload)).digest();
  const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: b64u(hash), origin: 'http://wallet.test' }));
  const authData = Buffer.concat([crypto.createHash('sha256').update('rp').digest(), Buffer.from([0x05]), Buffer.alloc(4)]);
  const signed = Buffer.concat([authData, crypto.createHash('sha256').update(clientData).digest()]);
  const sig = crypto.sign('sha256', signed, { key: identity.privateKey });
  return { signerRole: 'webauthn', publicKey: identity.publicKeyB64, signature: b64u(sig), clientDataJSON: b64u(clientData), authenticatorData: b64u(authData) };
}

function request(port, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({ Host: 'localhost:' + port }, data !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers || {});
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('request timed out')));
    if (data !== null) req.write(data);
    req.end();
  });
}

class StudioLab {
  // opts.mint: write a studio-config.json that enables minting (default false: the shipped default).
  // opts.config: extra settings merged into that file. opts.crashAt: ATLAS_TEST_CRASH_AT for the server.
  // opts.port: fixed port instead of a free one. opts.env: extra environment for the PHP server.
  static async start(opts) {
    opts = opts || {};
    const lab = new StudioLab();
    lab.root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-lab-'));
    lab.docroot = path.join(lab.root, 'docroot');
    lab.private = path.join(lab.root, 'private');
    lab.studio = path.join(lab.root, 'studio');
    if (opts.reuse) {
      Object.assign(lab, { root: opts.reuse.root, docroot: opts.reuse.docroot, private: opts.reuse.private, studio: opts.reuse.studio });
    } else {
      fs.cpSync(path.join(REPO, 'issuer-php'), lab.docroot, { recursive: true });
      // Studio's own models go where the issuer expects them. The site's own /assets/ models are stand-ins that
      // are not valid models, so any code that read the old /assets/{trophy,badge,key} paths would fail closed.
      fs.mkdirSync(path.join(lab.docroot, 'assets', 'studio'), { recursive: true });
      for (const f of ['trophy', 'badge', 'key']) for (const ext of ['glb', 'png']) {
        fs.copyFileSync(path.join(REPO, 'demo-domain-a', 'assets', 'studio', f + '.' + ext), path.join(lab.docroot, 'assets', 'studio', f + '.' + ext));
        fs.writeFileSync(path.join(lab.docroot, 'assets', f + '.' + ext), SITE_MODEL_STANDIN);
      }
      for (const ext of ['glb', 'png']) fs.copyFileSync(path.join(REPO, 'demo-domain-a', 'assets', 'compass.' + ext), path.join(lab.docroot, 'assets', 'compass.' + ext));
      fs.mkdirSync(lab.private, { recursive: true, mode: 0o700 });
      for (const b of ['drafts', 'uploads-quarantine', 'mint-receipts', 'tmp', 'rate']) fs.mkdirSync(path.join(lab.studio, b), { recursive: true, mode: 0o700 });
    }
    lab.port = opts.reuse ? opts.reuse.port : (opts.port || await freePort());
    lab.base = 'http://localhost:' + lab.port;
    lab.origin = lab.base;
    lab.host = 'localhost:' + lab.port;
    if (!opts.reuse) lab.writeConfig(opts);
    lab.env = Object.assign({}, process.env, {
      ATLAS_PRIVATE_DIR: lab.private, ATLAS_STUDIO_STORAGE_ROOT: lab.studio, PHP_CLI_SERVER_WORKERS: String(opts.workers || 4),
    }, opts.crashAt ? { ATLAS_TEST_CRASH_AT: opts.crashAt } : {}, opts.env || {});
    await lab.listen();
    return lab;
  }

  writeConfig(opts) {
    const cfg = Object.assign({ mintEnabled: !!opts.mint, domain: 'localhost:' + this.port, origins: ['http://localhost:' + this.port] }, opts.config || {});
    fs.writeFileSync(path.join(this.studio, 'studio-config.json'), JSON.stringify(cfg));
  }

  async listen() {
    this.proc = spawn('php', ['-S', 'localhost:' + this.port, '-t', this.docroot, path.join(this.docroot, 'test-router.php')], {
      cwd: this.docroot, env: this.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    this.log = '';
    this.proc.stderr.on('data', (d) => { this.log += d.toString(); });
    this.proc.stdout.on('data', (d) => { this.log += d.toString(); });
    for (let i = 0; i < 100; i++) {
      try { await request(this.port, 'GET', '/atlas/studio/api.php?op=status'); return; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error('php server did not start: ' + this.log);
  }

  // Kill the server process group without a clean shutdown, then start another on a new port over the same state.
  async hardStop() {
    if (this.proc) { try { process.kill(-this.proc.pid, 'SIGKILL'); } catch (e) { /* already gone */ } this.proc = null; }
    await new Promise((r) => setTimeout(r, 200));
  }
  async stop() { await this.hardStop(); }
  cleanup() { try { fs.rmSync(this.root, { recursive: true, force: true }); } catch (e) { /* best effort */ } }

  get(p, headers) { return request(this.port, 'GET', p, undefined, headers); }
  postRaw(p, body, headers) { return request(this.port, 'POST', p, body, headers); }
  api(op, body, headers) { return request(this.port, 'POST', '/atlas/studio/api.php?op=' + op, body, headers); }
  status() { return request(this.port, 'GET', '/atlas/studio/api.php?op=status'); }
  adminPost(p, body) { return request(this.port, 'POST', p, body); }

  // The full wallet-side steps against this lab: challenge, sign as the identity, mint.
  async mintAs(identity, design, tweak) {
    const ch = await this.api('challenge', { design, recipient: identity.publicKeyB64 });
    if (ch.status !== 200) return { challenge: ch };
    const proof = signBridge(identity, this.origin, ch.json.signRequest);
    const body = { design, nonce: ch.json.nonce, proof };
    if (tweak) tweak(body, ch.json);
    const mint = await this.api('mint', body);
    return { challenge: ch, body, mint };
  }

  // Files the lab's state dirs hold, for assertions about leftovers.
  studioFiles(bucket) { return fs.readdirSync(path.join(this.studio, bucket)); }
}

const DESIGN = { schema: 'atlas.asset-studio.design/0.1', template: 'trophy', name: 'First Light', description: 'Awarded for the first walk through the lobby.', finish: 'gold' };

module.exports = { SITE_MODEL_STANDIN, StudioLab, makeIdentity, signBridge, signPayload, canonicalize, b64u, request, DESIGN, REPO };
