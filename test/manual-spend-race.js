// Manual check that a credential can be spent only once even when several
// requests spending it arrive at the same moment, on either backend.
//
//   node test/manual-spend-race.js [php]
//
// Each spending endpoint checks the presented credential and later revokes
// it, with a wait for a signature check or a mint in between. Without a
// per-credential lock two requests can both pass the check. For every pair of
// different spends (and each spend against itself) the pair is fired at once
// for several rounds; in no round may both succeed. A final round fires one
// of each spend plus extra copies, all together: exactly one may succeed.
//
// Runs its own isolated issuer. Not part of the permanent suite, same
// reasoning as the other manual-*.js scripts.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { webcrypto } = require('crypto');
const { withAdminAuth } = require('./lib/admin-auth');
const { subtle } = webcrypto;

const MODE = process.argv[2] === 'php' ? 'php' : 'node';
const REPO = path.resolve(__dirname, '..');
const PORT = MODE === 'php' ? 8246 : 8245;
const DOMAIN = 'localhost:' + PORT;
const BASE = 'http://' + DOMAIN;
const RING = 'atlas.wearable.ring';
const ROUNDS = Number(process.env.ROUNDS || 12);
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-spend-race-'));

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
async function genIdentity() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { kp, publicKey: b64url(raw) };
}
async function proofFor(identity, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey: identity.publicKey, signature: b64url(sig) };
}
async function post(urlPath, body) {
  const res = await fetch(BASE + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch (err) { /* leave empty */ }
  return { status: res.status, body: parsed, text };
}

let proc = null;
function start(adminPublicKey) {
  const workDir = path.join(TMP_ROOT, MODE);
  fs.mkdirSync(workDir, { recursive: true });
  const roster = JSON.stringify({ keys: [{ publicKey: adminPublicKey, addedAt: new Date().toISOString() }] }, null, 2);
  return new Promise((resolve, reject) => {
    if (MODE === 'php') {
      const docroot = path.join(workDir, 'domain');
      fs.cpSync(path.join(REPO, 'issuer-php'), docroot, { recursive: true });
      fs.mkdirSync(path.join(docroot, '.well-known'), { recursive: true });
      const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'demo-domain-a', '.well-known', 'spatial.json'), 'utf8'));
      manifest.fileTransfer = { classes: [RING] };
      fs.writeFileSync(path.join(docroot, '.well-known', 'spatial.json'), JSON.stringify(manifest, null, 2));
      fs.writeFileSync(path.join(docroot, 'lib', 'atlas-admin-keys-store.json'), roster);
      proc = spawn('php', ['-S', 'localhost:' + PORT, 'test-router.php'], {
        cwd: docroot, detached: true, env: { ...process.env, PHP_CLI_SERVER_WORKERS: '16' }, stdio: ['ignore', 'pipe', 'pipe']
      });
      const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
      proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
    } else {
      const docroot = path.join(workDir, 'docroot');
      const stateDir = path.join(workDir, 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.cpSync(path.join(REPO, 'demo-domain-a'), docroot, { recursive: true });
      const manifestPath = path.join(docroot, '.well-known', 'spatial.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.fileTransfer = { classes: [RING] };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      fs.writeFileSync(path.join(stateDir, 'atlas-admin-keys-store.json'), roster);
      proc = spawn('node', ['issuer-server/server.js'], {
        cwd: REPO, detached: true,
        env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: stateDir, ATLAS_DOCROOT: docroot },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
      proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    }
  });
}
function stop() {
  if (!proc) return;
  try { process.kill(-proc.pid, 'SIGKILL'); } catch (err) { proc.kill('SIGKILL'); }
}

async function mint(owner) {
  const r = await post('/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: RING });
  assert(r.status === 200 && r.body.id, 'mint failed: ' + r.text);
  return r.body;
}

// Each spend returns a promise of the reply; success means the credential was
// consumed by that request.
function makeSpends(owner, other, admin) {
  return {
    redeem: async (c) => {
      const payload = { credentialId: c.id, action: 'redeem' };
      return post('/atlas/asset/redeem', { credential: c, intent: { payload, proof: await proofFor(owner, payload) } });
    },
    transfer: async (c) => {
      const payload = { credentialId: c.id, recipientPublicKey: other.publicKey, action: 'transfer' };
      return post('/atlas/asset/transfer', { credential: c, recipientPublicKey: other.publicKey, intent: { payload, proof: await proofFor(owner, payload) } });
    },
    file: async (c) => {
      const payload = { credentialId: c.id, action: 'transfer-to-file' };
      return post('/atlas/asset/transfer-to-file', { credential: c, intent: { payload, proof: await proofFor(owner, payload) } });
    },
    reissue: async (c) => {
      const payload = withAdminAuth({ credential: c, properties: { note: 'race' } }, BASE, '/atlas/asset/reissue');
      return post('/atlas/asset/reissue', { payload, proof: await proofFor(admin, payload) });
    }
  };
}

(async () => {
  const admin = await genIdentity();
  await start(admin.publicKey);
  try {
    const owner = await genIdentity();
    const other = await genIdentity();
    const spends = makeSpends(owner, other, admin);
    const names = Object.keys(spends);

    // Sanity: each spend works on its own, so a "both failed" round is not
    // mistaken for success.
    for (const name of names) {
      const r = await spends[name](await mint(owner));
      assert(r.status === 200, name + ' alone should succeed, got ' + r.status + ' ' + r.text);
    }

    console.log('STEP 1: every pair of spends fired together (' + MODE + ', ' + ROUNDS + ' rounds each)');
    const failures = [];
    for (let i = 0; i < names.length; i++) {
      for (let j = i; j < names.length; j++) {
        let both = 0;
        for (let round = 0; round < ROUNDS; round++) {
          const c = await mint(owner);
          const [a, b] = await Promise.all([spends[names[i]](c), spends[names[j]](c)]);
          if (a.status === 200 && b.status === 200) both++;
        }
        if (both) failures.push(names[i] + ' + ' + names[j] + ': both succeeded in ' + both + ' of ' + ROUNDS + ' rounds');
        console.log('  ' + (both ? 'FAIL' : 'ok  ') + ' ' + names[i] + ' + ' + names[j]);
      }
    }
    assert(failures.length === 0, 'a credential was spent twice:\n    ' + failures.join('\n    '));
    console.log('PASS: no pair spent a credential twice');

    console.log('STEP 2: one of each spend plus extra copies, all at once');
    const tally = [];
    for (let round = 0; round < ROUNDS; round++) {
      const c = await mint(owner);
      const calls = [];
      for (const name of names) { calls.push(spends[name](c)); calls.push(spends[name](c)); }
      const replies = await Promise.all(calls);
      const wins = replies.filter((r) => r.status === 200).length;
      tally.push(wins);
    }
    assert(tally.every((w) => w === 1), 'exactly one of ' + names.length * 2 + ' simultaneous spends may win in each round, got wins per round: ' + tally.join(','));
    console.log('PASS: exactly one winner in every round');

    console.log('\nALL SPEND RACE CHECKS PASSED (' + MODE + ')');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    stop();
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    process.exit(process.exitCode || 0);
  }
})();
