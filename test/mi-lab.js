// Shared helpers for the multi-issuer lab tests: independent `php -S` sites (own docroot, key,
// private directory and SQLite file each), browser-style test identities, and signing utilities.
//
// Every site is a separate server with separate keys and storage; sites reach each other only over
// HTTP, through the discovery manifests each domain publishes at its own well-known path.

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');

const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'issuer-php', 'atlas', 'demo');
const MI_SRC = path.join(SRC, 'multi-issuer');
const TXLAB_SRC = path.join(SRC, 'txlab');
const CRYPTO_SRC = path.join(REPO, 'issuer-php', 'lib', 'crypto.php');
const TOOL = path.join(MI_SRC, 'tools', 'mi-admin.php');
const API = '/atlas/demo/multi-issuer/api.php';
const subtle = crypto.webcrypto.subtle;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const keyIdOf = (pub) => sha256hex(unb64u(pub)).slice(0, 32);
const digestOf = (o) => sha256hex(canonicalize(o));

function php(args, opts) { return execFileSync('php', args, { encoding: 'utf8', ...opts }); }

async function verifySig(pubB64u, signatureB64u, obj) {
  const key = await subtle.importKey('raw', unb64u(pubB64u), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64u(signatureB64u), Buffer.from(canonicalize(obj)));
}
function signWithPem(pem, obj) {
  const key = crypto.createPrivateKey(pem);
  return b64u(crypto.sign('sha256', Buffer.from(canonicalize(obj)), { key, dsaEncoding: 'ieee-p1363' }));
}

// A browser-style owner identity: P-256 key pair, raw public key, signs canonical JSON.
function makeOwner(name) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const pub = b64u(spki.subarray(spki.length - 65));
  return {
    name, pub, keyId: keyIdOf(pub), privateKey,
    sign(obj) { return b64u(crypto.sign('sha256', Buffer.from(canonicalize(obj)), { key: privateKey, dsaEncoding: 'ieee-p1363' })); },
  };
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(src, e.name), path.join(dst, e.name));
    else fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
  }
}

// Ports are remembered so two sites can never be handed the same number before their servers start.
const handedOut = new Set();
async function freePort() {
  for (;;) {
    const p = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const q = s.address().port; s.close(() => res(q)); }); });
    if (!handedOut.has(p)) { handedOut.add(p); return p; }
  }
}
async function waitPort(port) {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise((res) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
    if (ok) return;
    await sleep(100);
  }
  throw new Error('server on ' + port + ' did not start');
}

class Lab {
  constructor(prefix) {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'mi-lab-'));
    this.ids = {};     // identity name -> {domain, dir, pub, pem}
    this.sites = {};   // label -> site
    this.procs = {};
    this.seen = [];    // every response body, scanned for leaked secrets at the end
    this.checks = 0;
  }

  assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }
  pass(msg) { this.checks++; console.log('PASS: ' + msg); }

  identity(name, domain) {
    const dir = path.join(this.root, 'keys', name);
    const out = php([TOOL, 'keygen', '--dir', dir, '--domain', domain]);
    this.ids[name] = { name, domain, dir, pub: /public key:\s+(\S+)/.exec(out)[1], pem: fs.readFileSync(path.join(dir, 'signing-key.pem'), 'utf8') };
    return this.ids[name];
  }

  // opts: identity, state (identity name), roster [identity names], issuance {t, m:[names]}, transfer {t, m},
  //       pub (null = public mode off | string "k=v,k=v" | ''), open, port, wkPort, overrides ({identityName: url}), classes
  async site(label, opts) {
    const id = this.ids[opts.identity];
    const port = opts.port || await freePort();
    const wkPort = opts.wkPort || await freePort();
    const docroot = path.join(this.root, label, 'public_html');
    copyDir(MI_SRC, path.join(docroot, 'atlas', 'demo', 'multi-issuer'));
    copyDir(TXLAB_SRC, path.join(docroot, 'atlas', 'demo', 'txlab'));
    fs.mkdirSync(path.join(docroot, 'lib'), { recursive: true });
    fs.copyFileSync(CRYPTO_SRC, path.join(docroot, 'lib', 'crypto.php'));
    const privDir = path.join(this.root, label, 'private');
    fs.mkdirSync(privDir, { recursive: true, mode: 0o700 });
    for (const f of ['signing-key.pem', 'public-key.txt']) fs.copyFileSync(path.join(id.dir, f), path.join(privDir, f));
    fs.chmodSync(path.join(privDir, 'signing-key.pem'), 0o600);
    const wkRoot = path.join(this.root, label, 'wellknown');
    fs.mkdirSync(path.join(wkRoot, '.well-known'), { recursive: true });
    const site = { label, opts, id, port, wkPort, base: 'http://127.0.0.1:' + port, wkBase: 'http://127.0.0.1:' + wkPort, docroot, privDir, wkRoot, domain: id.domain };
    this.sites[label] = site;
    return site;
  }

  // Writes config.php for a site once every site's well-known port is known.
  configure(label) {
    const s = this.sites[label];
    const o = s.opts;
    const roster = o.roster.map((n) => this.ids[n].domain + '=' + this.ids[n].pub).join(',');
    const extra = o.extraOverrides || [];
    const overrides = Object.keys(this.sites).map((l) => this.sites[l]).filter((x) => o.roster.includes(x.opts.identity) || extra.includes(x.label))
      .map((x) => x.domain + '=' + x.wkBase + '/.well-known/atlas-multi-issuer.json');
    const args = [TOOL, 'config', '--dir', s.privDir, '--domain', s.domain, '--state', this.ids[o.state].domain, '--roster', roster,
      '--issuance-threshold', String(o.issuance.t), '--issuance-mandatory', o.issuance.m.map((n) => this.ids[n].domain).join(','),
      '--transfer-threshold', String(o.transfer.t), '--transfer-mandatory', o.transfer.m.map((n) => this.ids[n].domain).join(','),
      '--allow-insecure-http', '--enable'];
    if (overrides.length) args.push('--override', overrides.join(','));
    if (o.open) args.push('--open-discovery');
    if (o.classes) args.push('--classes', o.classes);
    if (o.pub !== null && o.pub !== undefined) { args.push('--public-demo'); if (o.pub) args.push('--public-set', o.pub); }
    php(args);
  }

  // Signs and publishes this site's discovery manifest (default: its own service endpoint serves everything it can).
  publish(label, opts) {
    const s = this.sites[label];
    const o = opts || {};
    const url = (o.api || s.base + API);
    const caps = ['asset.issue.approve=' + url, 'asset.transfer.approve=' + url];
    if (s.opts.identity === s.opts.state) caps.push('asset.state=' + url);
    const args = [TOOL, 'manifest', '--dir', s.privDir, '--service', (o.services || caps).join(',')];
    if (o.signerDir) args.push('--signer-dir', o.signerDir);
    if (o.validDays) args.push('--valid-days', String(o.validDays));
    php(args);
    fs.copyFileSync(path.join(s.privDir, 'manifest.json'), path.join(s.wkRoot, '.well-known', 'atlas-multi-issuer.json'));
  }

  async start(label) {
    const s = this.sites[label];
    if (!this.procs[label]) {
      s.log = path.join(this.root, label, 'php.log');
      const api = spawn('php', ['-S', '127.0.0.1:' + s.port, '-t', s.docroot], { env: { ...process.env, MI_PRIVATE_DIR: s.privDir, PHP_CLI_SERVER_WORKERS: '8' }, stdio: ['ignore', 'ignore', fs.openSync(s.log, 'a')], detached: true });
      this.procs[label] = api;
      await waitPort(s.port);
    }
    if (!this.procs['wk-' + label]) {
      this.procs['wk-' + label] = spawn('php', ['-S', '127.0.0.1:' + s.wkPort, '-t', s.wkRoot], { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
      await waitPort(s.wkPort);
    }
  }
  async stop(label) {
    const p = this.procs[label];
    if (!p) return;
    // php -S forks its workers: kill the whole process group so nothing keeps the port
    try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { p.kill('SIGKILL'); }
    await new Promise((r) => (p.exitCode !== null ? r() : p.once('exit', r)));
    await sleep(50);
    delete this.procs[label];
  }
  // Errors logged by the PHP side of every site (internal errors show up here).
  phpErrors() {
    const out = [];
    for (const l of Object.keys(this.sites)) {
      const f = path.join(this.root, l, 'php.log');
      if (!fs.existsSync(f)) continue;
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) if (/multi-issuer:|Fatal|Warning|Notice|Deprecated/.test(line)) out.push(l + ': ' + line);
    }
    return out;
  }
  async stopAll() { for (const l of Object.keys(this.procs)) await this.stop(l); }

  // Convenience: build a full set of sites, configure, publish and start them.
  async network(spec) {
    // spec: {names: [..], state, issuance:{t,m}, transfer:{t,m}, pub, open?}
    for (const n of spec.names) this.identity(n, n + '.test');
    for (const n of spec.names) await this.site(n, { identity: n, state: spec.state, roster: spec.names, issuance: spec.issuance, transfer: spec.transfer, pub: spec.pub === undefined ? '' : spec.pub });
    for (const n of spec.names) this.configure(n);
    for (const n of spec.names) this.publish(n);
    for (const n of spec.names) await this.start(n);
  }

  async raw(label, op, o) {
    o = o || {};
    const s = this.sites[label];
    const q = (o.id ? '&id=' + encodeURIComponent(o.id) : '') + (o.nonce ? '&nonce=' + o.nonce : '');
    const url = s.base + API + '?op=' + op + q;
    const headers = Object.assign(o.body !== undefined && !o.noType ? { 'Content-Type': o.type || 'application/json' } : {}, o.headers || {});
    const init = o.body !== undefined || o.method ? { method: o.method || 'POST', headers, body: o.body !== undefined ? (typeof o.body === 'string' ? o.body : JSON.stringify(o.body)) : undefined } : { headers };
    const r = await fetch(url, init);
    const text = await r.text();
    this.seen.push(text);
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* non-JSON */ }
    return { status: r.status, body };
  }

  sql(label, query) {
    const file = path.join(this.sites[label].privDir, 'mi.sqlite');
    const code = '$d=new PDO("sqlite:".$argv[1]);$d->exec("PRAGMA busy_timeout=5000");$q=$d->query($argv[2]);echo json_encode($q?$q->fetchAll(PDO::FETCH_ASSOC):[]);';
    return JSON.parse(php(['-r', code, file, query]));
  }
  sqlExec(label, query) {
    const file = path.join(this.sites[label].privDir, 'mi.sqlite');
    const code = '$d=new PDO("sqlite:".$argv[1]);$d->setAttribute(PDO::ATTR_ERRMODE,PDO::ERRMODE_EXCEPTION);$d->exec("PRAGMA busy_timeout=5000");$d->exec($argv[2]);echo "ok";';
    return php(['-r', code, file, query]);
  }
}

// ---------------------------------------------------------------- the visitor's flows, as the page performs them

function reqId() { return 'req-' + crypto.randomBytes(8).toString('hex'); }

// Builds and signs a transfer exactly as the browser page does.
function buildTransfer(view, owner, toOwnerPub, sid, extra) {
  const e = extra || {};
  const def = view.asset.definition;
  const now = Date.now();
  const payload = {
    v: 'domain-atlas-mi-transfer/1', txId: e.txId || crypto.randomUUID(), assetId: def.assetId, definitionDigest: view.asset.definitionDigest,
    registry: def.stateAuthority.domain, fromOwner: e.fromOwner || owner.pub, toOwner: toOwnerPub,
    baseVersion: e.baseVersion !== undefined ? e.baseVersion : view.live.version, baseStateDigest: e.baseStateDigest || view.live.stateDigest,
    createdAtMs: now, expiresAtMs: now + (e.ttlMs || 120000), session: sid,
  };
  const digest = digestOf(payload);
  const auth = { v: 'domain-atlas-mi-owner-auth/1', txId: payload.txId, transferDigest: digest, owner: keyIdOf(payload.fromOwner), signedAtMs: now };
  return { payload, digest, auth, signature: (e.signer || owner).sign(auth) };
}

// ---------------------------------------------------------------- independent offline verifier (does not use the PHP code)

function evaluatePolicy(policy, decisions) {
  const approved = [], rejected = [];
  for (const [d, v] of Object.entries(decisions)) { if (!policy.roster.includes(d)) continue; (v === 'approve' ? approved : rejected).push(d); }
  const missing = policy.mandatory.filter((m) => !approved.includes(m));
  return { approved, rejected, missingMandatory: missing, satisfied: approved.length >= policy.threshold && missing.length === 0 };
}

async function checkSigs(def, entries, refId, digest, policy) {
  const decisions = {}; const seen = new Set(); const rows = [];
  for (const e of entries || []) {
    const dom = e && (e.domain || e.approver);
    const iss = def.issuers.find((i) => i.domain === dom);
    let ok = false, why = null;
    if (!iss || !policy.roster.includes(dom)) why = 'not an issuer';
    else if (seen.has(dom)) why = 'duplicate';
    else if (!e.approval || e.approval.approver !== dom || e.approval.txId !== refId || e.approval.payloadDigest !== digest) why = 'binding';
    else if (!(await verifySig(iss.publicKey, e.signature, e.approval).catch(() => false))) why = 'signature';
    else { ok = true; decisions[dom] = e.approval.decision; }
    if (dom) seen.add(dom);
    rows.push({ domain: dom, ok, why });
  }
  return { rows, eval: evaluatePolicy(policy, decisions) };
}

// Returns {definitionDigestOk, issuanceVerified, signedBy, chainValid, version, owner, problems}
async function verifyPortableJs(asset) {
  const out = { definitionDigestOk: false, issuanceVerified: false, signedBy: [], chainValid: false, version: null, owner: null, problems: [] };
  const def = asset.definition;
  out.definitionDigestOk = digestOf(def) === asset.definitionDigest;
  if (!out.definitionDigestOk) return out;
  const r = await checkSigs(def, asset.issuance.signatures, def.assetId, asset.definitionDigest, def.issuancePolicy);
  out.signedBy = r.eval.approved;
  out.issuanceVerified = r.eval.satisfied;
  const reg = def.issuers.find((i) => i.domain === def.stateAuthority.domain);
  let prev = null, owner = null;
  const ev = (asset.ownership && asset.ownership.evidence) || [];
  if (!ev.length) { out.problems.push('no evidence'); return out; }
  for (let i = 0; i < ev.length; i++) {
    const { receipt: rc, signature } = ev[i];
    if (!(await verifySig(reg.publicKey, signature, rc).catch(() => false))) { out.problems.push('v' + i + ': registry signature'); break; }
    if (i === 0) {
      if (rc.assetId !== def.assetId || rc.definitionDigest !== asset.definitionDigest || rc.owner !== def.originalOwner.publicKey) { out.problems.push('v0: registration mismatch'); break; }
      if (rc.stateDigest !== digestOf({ v: 'domain-atlas-mi-state/1', assetId: def.assetId, version: 0, owner: rc.owner, previous: asset.definitionDigest })) { out.problems.push('v0: state digest'); break; }
      owner = rc.owner; prev = rc.stateDigest; continue;
    }
    const t = rc.transfer;
    if (digestOf(t) !== rc.transferDigest || t.fromOwner !== owner || t.baseVersion !== i - 1 || t.baseStateDigest !== prev || t.assetId !== def.assetId) { out.problems.push('v' + i + ': transfer binding'); break; }
    if (!(await verifySig(t.fromOwner, rc.ownerAuthorization.signature, rc.ownerAuthorization.object).catch(() => false)) || rc.ownerAuthorization.object.transferDigest !== rc.transferDigest) { out.problems.push('v' + i + ': owner signature'); break; }
    const q = await checkSigs(def, rc.approvals, t.txId, rc.transferDigest, def.transferPolicy);
    if (!q.eval.satisfied) { out.problems.push('v' + i + ': quorum'); break; }
    if (rc.stateDigest !== digestOf({ v: 'domain-atlas-mi-state/1', assetId: def.assetId, version: i, owner: t.toOwner, previous: prev })) { out.problems.push('v' + i + ': state digest'); break; }
    owner = t.toOwner; prev = rc.stateDigest;
  }
  out.chainValid = out.problems.length === 0;
  if (out.chainValid) { out.version = ev.length - 1; out.owner = owner; }
  return out;
}

module.exports = { verifyPortableJs, evaluatePolicy, Lab, makeOwner, buildTransfer, reqId, canonicalize, sha256hex, digestOf, keyIdOf, signWithPem, verifySig, php, sleep, b64u, unb64u, copyDir, freePort, waitPort, API, TOOL, MI_SRC, REPO, subtle };
