// Manual check that two identities can never hold the same Post Office
// handle at one domain, on either backend.
//
//   node test/manual-postoffice-handle-uniqueness.js [php]
//
// Covers the cases the claim check must get right:
//   1. Casing does not make a different name ("Bruno" / "bruno" / "BRUNO").
//   2. A suspended member keeps their handle, so nobody can take it while
//      they are suspended and then share it once the suspension is lifted.
//   3. Many members claiming the same name at the same instant: exactly one
//      wins (the PHP check and write share one lock).
//   4. Re-saving or re-casing your own handle still works.
//   5. A revoked membership releases its handle for someone else.
//   6. Resolving a handle gives exactly one owner throughout.
//
// Runs its own isolated issuer (no shared state with other tests). Not part
// of the permanent suite, same reasoning as the other manual-*.js scripts.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const MODE = process.argv[2] === 'php' ? 'php' : 'node';
const REPO = path.resolve(__dirname, '..');
const PORT = MODE === 'php' ? 8244 : 8243;
const DOMAIN = 'localhost:' + PORT;
const BASE = 'http://' + DOMAIN;
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-handle-uniqueness-'));

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
let workDir = null;
function start(adminPublicKey) {
  workDir = path.join(TMP_ROOT, MODE);
  fs.mkdirSync(workDir, { recursive: true });
  const roster = JSON.stringify({ keys: [{ publicKey: adminPublicKey, addedAt: new Date().toISOString() }] }, null, 2);
  return new Promise((resolve, reject) => {
    if (MODE === 'php') {
      const docroot = path.join(workDir, 'domain');
      fs.cpSync(path.join(REPO, 'issuer-php'), docroot, { recursive: true });
      fs.mkdirSync(path.join(docroot, '.well-known'), { recursive: true });
      fs.copyFileSync(path.join(REPO, 'demo-domain-b', '.well-known', 'spatial.json'), path.join(docroot, '.well-known', 'spatial.json'));
      fs.writeFileSync(path.join(docroot, 'lib', 'atlas-admin-keys-store.json'), roster);
      proc = spawn('php', ['-S', 'localhost:' + PORT, 'test-router.php'], {
        cwd: docroot, detached: true, env: { ...process.env, PHP_CLI_SERVER_WORKERS: '8' }, stdio: ['ignore', 'pipe', 'pipe']
      });
      const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
      proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
    } else {
      const docroot = path.join(workDir, 'docroot');
      const stateDir = path.join(workDir, 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.cpSync(path.join(REPO, 'demo-domain-b'), docroot, { recursive: true });
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

async function join(identity) {
  const r = await post('/atlas/asset/issue', { ownerPublicKey: identity.publicKey, assetClass: 'atlas.postoffice.membership' });
  assert(r.status === 200 && r.body.id, 'joining failed: ' + r.text);
  return r.body.id;
}
async function claim(identity, handle) {
  const payload = { handle };
  return post('/atlas/postoffice/handle', { payload, proof: await proofFor(identity, payload) });
}
async function resolve(handle) {
  return post('/atlas/postoffice/resolve', { handle });
}
async function adminAct(admin, route, id) {
  const payload = { id, reason: 'test' };
  const r = await post(route, { payload, proof: await proofFor(admin, payload) });
  assert(r.status === 200, route + ' failed: ' + r.text);
}

(async () => {
  const admin = await genIdentity();
  await start(admin.publicKey);
  try {
    const A = await genIdentity();
    const B = await genIdentity();
    const aMembership = await join(A);
    await join(B);

    console.log('STEP 1: another casing of a taken name is refused (' + MODE + ')');
    assert((await claim(A, 'Bruno')).status === 200, 'A should get "Bruno"');
    for (const variant of ['bruno', 'BRUNO', 'bRuNo']) {
      const r = await claim(B, variant);
      assert(r.status === 400 && /already taken/.test(r.body.error || ''), 'B must not get "' + variant + '": ' + r.text);
    }
    let seen = await resolve('bruno');
    assert(seen.status === 200 && seen.body.publicKey === A.publicKey, 'the name should still resolve to A: ' + seen.text);
    console.log('PASS: only A holds the name, in any casing');

    console.log('STEP 2: a suspended member keeps their name');
    await adminAct(admin, '/atlas/suspend', aMembership);
    const whileSuspended = await claim(B, 'bruno');
    assert(whileSuspended.status === 400, 'B must not take a suspended member\'s name: ' + whileSuspended.text);
    await adminAct(admin, '/atlas/unsuspend', aMembership);
    seen = await resolve('bruno');
    assert(seen.status === 200 && seen.body.publicKey === A.publicKey, 'after the suspension is lifted the name is still A\'s alone: ' + seen.text);
    console.log('PASS: refused while suspended, A\'s alone afterwards');

    console.log('STEP 3: thirty members claim one name at the same instant, six rounds');
    for (let round = 0; round < 6; round++) {
      const contenders = [];
      for (let i = 0; i < 30; i++) { const c = await genIdentity(); await join(c); contenders.push(c); }
      const name = 'contested' + round;
      const replies = await Promise.all(contenders.map((c) => claim(c, name)));
      const winners = replies.map((r, i) => (r.status === 200 ? i : -1)).filter((i) => i >= 0);
      assert(winners.length === 1, 'round ' + round + ': exactly one claimant should win, got ' + winners.length + ' (' + replies.map((r) => r.status).join(',') + ')');
      const owner = await resolve(name);
      assert(owner.status === 200 && owner.body.publicKey === contenders[winners[0]].publicKey, 'round ' + round + ': the name should resolve to the winner');
    }
    console.log('PASS: one winner every round');

    console.log('STEP 4: re-saving or re-casing your own name still works');
    assert((await claim(A, 'Bruno')).status === 200, 'A re-saving "Bruno" should succeed');
    const recased = await claim(A, 'BRUNO');
    assert(recased.status === 200 && recased.body.handle === 'BRUNO', 'A re-casing to "BRUNO" should succeed: ' + recased.text);
    console.log('PASS: own name can be re-saved and re-cased');

    console.log('STEP 5: a revoked membership releases its name');
    await adminAct(admin, '/atlas/revoke', aMembership);
    assert((await resolve('bruno')).status === 404, 'a revoked member must not resolve');
    const taken = await claim(B, 'bruno');
    assert(taken.status === 200, 'B should be able to take the released name: ' + taken.text);
    seen = await resolve('bruno');
    assert(seen.status === 200 && seen.body.publicKey === B.publicKey, 'the name should now resolve to B');
    console.log('PASS: released on revocation, B now holds it alone');

    console.log('\nALL HANDLE UNIQUENESS CHECKS PASSED (' + MODE + ')');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    stop();
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    process.exit(process.exitCode || 0);
  }
})();
