// Local throw-away issuers for the owner-proof tests: the Node issuer and the PHP issuer, each with its own state, on loopback.
// Nothing here contacts a live domain.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// ---------- instances ----------
function waitFor(cond, ms, what) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try { if (await cond()) return resolve(); } catch (e) { /* keep waiting */ }
      if (Date.now() - start > ms) return reject(new Error('timed out waiting for ' + what));
      setTimeout(tick, 150);
    };
    tick();
  });
}
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-owner-proof-'));
const procs = [];

async function startNode(name, port, mode, strict) {
  const state = path.join(tmpRoot, name + '-state');
  const docroot = path.join(tmpRoot, name + '-docroot');
  fs.mkdirSync(state, { recursive: true });
  fs.cpSync(path.join(ROOT, 'demo-domain-b'), docroot, { recursive: true });
  // The manifest names the domain it is served from; a copy on another port names its own.
  const manifest = path.join(docroot, '.well-known', 'spatial.json');
  if (fs.existsSync(manifest)) fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').split('localhost:8002').join('localhost:' + port));
  const env = Object.assign({}, process.env, { PORT: String(port), ATLAS_DOMAIN: 'localhost:' + port, ATLAS_DOCROOT: docroot, ATLAS_STATE_DIR: state });
  for (const k of ['ATLAS_PRIVATE_MINT', 'ATLAS_MINT_LIMITS', 'ATLAS_OWNER_PROOF', 'ATLAS_MINT_ORIGINS', 'ATLAS_FEDERATION_MINT_ORIGINS']) delete env[k];
  if (!strict) { env.ATLAS_PRIVATE_MINT = 'off'; env.ATLAS_MINT_LIMITS = 'off'; }
  if (mode) env.ATLAS_OWNER_PROOF = mode;
  const proc = spawn('node', [path.join(ROOT, 'issuer-server', 'server.js')], { cwd: path.join(ROOT, 'issuer-server'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  proc.stdout.on('data', (d) => log.push(String(d)));
  proc.stderr.on('data', (d) => log.push(String(d)));
  procs.push(proc);
  const base = 'http://localhost:' + port;
  await waitFor(async () => (await fetch(base + '/atlas/capabilities')).ok, 20000, name);
  return { name, kind: 'node', base, domain: 'localhost:' + port, state, files: state, log, rosterFile: (f) => path.join(state, f), statsFile: path.join(state, 'atlas-owner-proof-stats-store.json') };
}

async function startPhp(name, port, mode, strict, opts) {
  const bundle = path.join(tmpRoot, name);
  fs.cpSync(path.join(ROOT, 'issuer-php'), bundle, { recursive: true });
  for (const f of fs.readdirSync(path.join(bundle, 'lib'))) {
    if (/^atlas-.*\.json$/.test(f)) fs.rmSync(path.join(bundle, 'lib', f));
  }
  for (const d of ['replay', 'txn', 'owner-proof', 'mint-allowance']) fs.rmSync(path.join(bundle, 'lib', d), { recursive: true, force: true });
  if (opts && opts.withoutProofLibrary) fs.rmSync(path.join(bundle, 'lib', 'owner-proof.php'));
  const env = Object.assign({}, process.env, { PHP_CLI_SERVER_WORKERS: '4' });
  for (const k of ['ATLAS_PRIVATE_MINT', 'ATLAS_MINT_LIMITS', 'ATLAS_OWNER_PROOF', 'ATLAS_MINT_ORIGINS', 'ATLAS_FEDERATION_MINT_ORIGINS', 'ATLAS_DOMAIN']) delete env[k];
  if (!strict) { env.ATLAS_PRIVATE_MINT = 'off'; env.ATLAS_MINT_LIMITS = 'off'; }
  if (mode) env.ATLAS_OWNER_PROOF = mode;
  const proc = spawn('php', ['-S', 'localhost:' + port, 'test-router.php'], { cwd: bundle, env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(proc);
  const base = 'http://localhost:' + port;
  await waitFor(async () => (await fetch(base + '/atlas/capabilities')).ok, 20000, name);
  const lib = path.join(bundle, 'lib');
  return { name, kind: 'php', base, domain: 'localhost:' + port, files: lib, rosterFile: (f) => path.join(lib, f), statsFile: path.join(lib, 'owner-proof', 'stats.json'), bundle };
}

// ---------- what an issuer has written ----------
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const listDir = (d) => { try { return fs.readdirSync(d).filter((n) => !n.startsWith('.')).sort(); } catch (e) { return []; } };
function snapshot(inst) {
  const roster = (f, k) => (readJson(inst.rosterFile(f), {})[k] || []).length;
  return {
    subscribers: roster('atlas-subscribers-store.json', 'subscribers'),
    postOffice: roster('atlas-postoffice-members-store.json', 'members'),
    tradingStation: roster('atlas-tradingstation-members-store.json', 'members'),
    mail: roster('atlas-mail-store.json', 'messages'),
    replay: listDir(path.join(inst.files, 'replay')).length,
    journal: listDir(path.join(inst.files, 'txn')).length
  };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const rosterTotal = (s) => s.subscribers + s.postOffice + s.tradingStation;
const mailFor = (inst, credentialId) => (readJson(inst.rosterFile('atlas-mail-store.json'), {}).messages || []).filter((m) => m.credentialId === credentialId).length;


function stopAll() {
  for (const p of procs) { try { p.kill(); } catch (e) { /* already gone */ } }
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* temp folder */ }
}
module.exports = { startNode, startPhp, snapshot, readJson, listDir, mailFor, rosterTotal, stopAll, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
