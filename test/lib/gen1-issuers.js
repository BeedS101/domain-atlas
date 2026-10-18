// Throw-away Node and PHP issuers for the Gen1 fungible tests. Each gets its own temporary state,
// key and revocation list on a private port; nothing live is read or written.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');

async function waitFor(log, proc, text, ms, name) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(name + ' did not start: ' + log.join('').slice(-400))), ms);
    const check = () => { if (log.join('').includes(text)) { clearTimeout(timer); resolve(); } else setTimeout(check, 40); };
    check();
    proc.on('exit', (c) => { clearTimeout(timer); reject(new Error(name + ' exited ' + c + ': ' + log.join('').slice(-400))); });
  });
}

async function startNode(port) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen1-node-'));
  const docroot = path.join(tmp, 'docroot');
  const state = path.join(tmp, 'state');
  fs.mkdirSync(path.join(docroot, '.well-known'), { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const domain = 'localhost:' + port;
  const be = {
    kind: 'node', base: 'http://localhost:' + port, domain, tmp, state, docroot,
    revFile: path.join(docroot, '.well-known', 'atlas-revocations.json'),
    keyFile: path.join(docroot, '.well-known', 'atlas-key.json'),
    dirsToWatch: [path.join(docroot, '.well-known'), state],
    replayDir: path.join(state, 'replay'), holdingsDir: path.join(state, 'holdings'),
    revLayout: (doc) => JSON.stringify(doc, null, 2),
    proc: null, log: []
  };
  be.start = async () => {
    be.log = [];
    be.proc = spawn('node', ['issuer-server/server.js'], {
      cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port), ATLAS_DOMAIN: domain, ATLAS_DOCROOT: docroot, ATLAS_STATE_DIR: state }
    });
    be.proc.stdout.on('data', (d) => be.log.push(d.toString()));
    be.proc.stderr.on('data', (d) => be.log.push(d.toString()));
    await waitFor(be.log, be.proc, 'listening', 15000, 'node issuer');
  };
  be.restart = async () => { be.proc.removeAllListeners('exit'); be.proc.kill(); await new Promise((r) => setTimeout(r, 200)); await be.start(); };
  be.stop = () => { if (be.proc) { be.proc.removeAllListeners('exit'); be.proc.kill(); } fs.rmSync(tmp, { recursive: true, force: true }); };
  await be.start();
  return be;
}

async function startPhp(port) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gen1-php-'));
  const bundle = path.join(tmp, 'bundle');
  fs.cpSync(path.join(REPO, 'issuer-php'), bundle, { recursive: true });
  for (const f of fs.readdirSync(path.join(bundle, 'lib'))) {
    if (/\.(json|pem|lock)$/.test(f) && /store|key|lock|admin|revoc/.test(f)) fs.rmSync(path.join(bundle, 'lib', f), { force: true });
  }
  for (const d of ['replay', 'holdings']) fs.rmSync(path.join(bundle, 'lib', d), { recursive: true, force: true });
  fs.mkdirSync(path.join(bundle, '.well-known'), { recursive: true });
  const domain = 'localhost:' + port;
  const be = {
    kind: 'php', base: 'http://127.0.0.1:' + port, domain: '127.0.0.1:' + port, tmp, bundle,
    revFile: path.join(bundle, '.well-known', 'atlas-revocations.json'),
    keyFile: path.join(bundle, '.well-known', 'atlas-key.json'),
    dirsToWatch: [path.join(bundle, '.well-known'), path.join(bundle, 'lib')],
    replayDir: path.join(bundle, 'lib', 'replay'), holdingsDir: path.join(bundle, 'lib', 'holdings'),
    revLayout: (doc) => JSON.stringify(doc, null, 4),
    proc: null, log: []
  };
  be.start = async () => {
    be.log = [];
    be.proc = spawn('php', ['-S', '127.0.0.1:' + port, 'test-router.php'], {
      cwd: bundle, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4' }
    });
    be.proc.stderr.on('data', (d) => be.log.push(d.toString()));
    await waitFor(be.log, be.proc, 'started', 8000, 'php');
  };
  be.restart = async () => { be.proc.removeAllListeners('exit'); be.proc.kill(); await new Promise((r) => setTimeout(r, 200)); await be.start(); };
  be.stop = () => { if (be.proc) { be.proc.removeAllListeners('exit'); be.proc.kill(); } fs.rmSync(tmp, { recursive: true, force: true }); };
  await be.start();
  return be;
}

function api(be) {
  const call = async (method, p, body) => {
    const t0 = process.hrtime.bigint();
    let res;
    try {
      res = await fetch(be.base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    } catch (e) { return { status: 0, body: { error: 'network: ' + e.message }, ms: 0 }; }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch (e) { json = { error: 'non-json: ' + text.slice(0, 160) }; }
    return { status: res.status, body: json, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  };
  return {
    post: (p, b) => call('POST', p, b),
    get: (p) => call('GET', p),
    revocations: () => { try { return JSON.parse(fs.readFileSync(be.revFile, 'utf8')).revoked; } catch (e) { return null; } },
    files: () => be.dirsToWatch.flatMap((d) => { try { return fs.readdirSync(d).map((f) => path.join(d, f)); } catch (e) { return []; } })
  };
}

module.exports = { REPO, startNode, startPhp, api };
