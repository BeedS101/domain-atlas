// Manual end-to-end check for recovering an interrupted claim of an exported
// file (SPEC.md §13.5.2): the claim record's commit point, finishing a claim
// that stopped part-way, and the guarantees around it. HTTP layer only,
// against an isolated issuer that the test stops and restarts on the same
// state folder.
//
//   node test/manual-asset-file-claim-recovery.js          # issuer-server (Node)
//   node test/manual-asset-file-claim-recovery.js php      # issuer-php
//
// A claim used to take the file out of the bearer registry, mint the
// claimer's credential and revoke the file, with the new credential existing
// only in the reply. It now commits a record (claimer key + minted
// credential) before the registry or the revocation list is touched. The
// issuer can be made to stop dead right after any step with
// ATLAS_TEST_CRASH_AT=<point>; this test does that at every point.
//
// Checks:
//   1. A reply lost in transit: the claimer's retry gets the identical
//      credential, repeated and eight at once, and across a restart; exactly
//      one credential is ever minted for the file.
//   2. Nobody else gets it: another key claiming the same file is told it is
//      claimed, learns nothing about the credential, and cannot disturb the
//      real claimer's retry.
//   3. A stop at every step (after minting, after the record is written,
//      after the registry entry is taken, after the revocation, after the
//      record is marked claimed): before the record exists the file is still
//      claimable and nothing was lost; from the record on, the file is dead
//      for everyone else and the claimer's retry returns the credential
//      stored in the record.
//   4. The owner's export recovery, asked while a claim is half finished,
//      finishes it and reports the file as claimed (not "in progress").
//   5. Different keys claiming one file at once, repeatedly: one claimer, one
//      credential, one record.
//   6. After the replay window the credential is dropped from the record and
//      a retry is told the file is claimed, with the receipt; the receipt
//      keeps ids and timestamps.
//
// Not part of the permanent suite, same reasoning as the other manual-*.js
// scripts.

const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { webcrypto, createHmac } = require('crypto');
const { subtle } = webcrypto;

const BACKEND = process.argv[2] === 'php' ? 'php' : 'node';
const PORT = BACKEND === 'php' ? 8248 : 8247; // isolated, distinct from every other manual-*.js test
const PROXY_PORT = BACKEND === 'php' ? 8250 : 8249;
const BASE = 'http://localhost:' + PORT;
const PROXY_BASE = 'http://localhost:' + PROXY_PORT;
const DOMAIN = 'localhost:' + PORT;
const REPO = path.resolve(__dirname, '..');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-file-claim-recovery-'));
// issuer-php keeps its state in lib/ inside the bundle, which is also its docroot.
const DOCROOT = BACKEND === 'php' ? path.join(TMP_ROOT, 'domain') : path.join(TMP_ROOT, 'docroot');
const STATE_DIR = BACKEND === 'php' ? path.join(DOCROOT, 'lib') : path.join(TMP_ROOT, 'state');
const MANIFEST = path.join(DOCROOT, '.well-known', 'spatial.json');
const REVOCATIONS = path.join(DOCROOT, '.well-known', 'atlas-revocations.json');
const BEARER_STORE = path.join(STATE_DIR, 'atlas-bearer-store.json');
const EXPORTS_STORE = path.join(STATE_DIR, 'atlas-file-exports-store.json');
const CLAIMS_STORE = path.join(STATE_DIR, 'atlas-file-claims-store.json');
const RING = 'atlas.wearable.ring';

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
async function post(urlPath, body, base) {
  const res = await fetch((base || BASE) + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed = {};
  try { parsed = JSON.parse(text); } catch (err) { /* leave empty */ }
  return { status: res.status, body: parsed, text };
}
async function get(urlPath) {
  const res = await fetch(BASE + urlPath);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function mint(owner, assetClass) {
  const r = await post('/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass });
  assert(r.status === 200, 'mint failed: ' + r.status + ' ' + r.text);
  return r.body;
}
async function exportToFile(identity, credential, base) {
  const payload = { credentialId: credential.id, action: 'transfer-to-file' };
  return post('/atlas/asset/transfer-to-file', { credential, intent: { payload, proof: await proofFor(identity, payload) } }, base);
}
async function claim(identity, credential) {
  const payload = { credentialId: credential.id, newOwnerPublicKey: identity.publicKey, action: 'claim-from-file' };
  return post('/atlas/asset/claim-from-file', { credential, intent: { payload, proof: await proofFor(identity, payload) } });
}
function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}
function revocationOf(id) {
  return readJson(REVOCATIONS, { revoked: [] }).revoked.find((r) => r.id === id) || null;
}
function bearerHas(id) {
  return Object.prototype.hasOwnProperty.call(readJson(BEARER_STORE, { bearers: {} }).bearers, id);
}
function exportRecord(originalId) {
  return readJson(EXPORTS_STORE, { exports: {} }).exports[originalId] || null;
}
function claimRecord(fileId) {
  return readJson(CLAIMS_STORE, { claims: {} }).claims[fileId] || null;
}
function claimCount() {
  return Object.keys(readJson(CLAIMS_STORE, { claims: {} }).claims).length;
}
async function recoverExport(identity, credentialId) {
  const ch = await post('/atlas/asset/recover-file-export-challenge', { credentialId });
  const payload = { credentialId, action: 'recover-file-export', challenge: ch.body.challenge };
  return post('/atlas/asset/recover-file-export', { intent: { payload, proof: await proofFor(identity, payload) } });
}

let serverProc = null;
function startServer(extraEnv) {
  return new Promise((resolve, reject) => {
    let proc;
    if (BACKEND === 'php') {
      // Several workers so the simultaneous requests below genuinely overlap.
      proc = spawn('php', ['-S', 'localhost:' + PORT, 'test-router.php'], {
        cwd: DOCROOT, detached: true, env: { ...process.env, PHP_CLI_SERVER_WORKERS: '8', ...(extraEnv || {}) }, stdio: ['ignore', 'pipe', 'pipe']
      });
      const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
      proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); serverProc = proc; resolve(proc); } });
    } else {
      proc = spawn('node', ['issuer-server/server.js'], {
        cwd: REPO, detached: true,
        env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: DOCROOT, ...(extraEnv || {}) },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
      proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); serverProc = proc; resolve(proc); } });
    }
    proc.on('exit', () => { if (serverProc === proc) serverProc = null; });
  });
}
// Kills the whole process group, so PHP's workers go with the server.
function stopServer() {
  return new Promise((resolve) => {
    if (!serverProc) return resolve();
    const proc = serverProc;
    proc.once('exit', () => setTimeout(resolve, 50));
    try { process.kill(-proc.pid, 'SIGKILL'); } catch (err) { proc.kill('SIGKILL'); }
  });
}
function waitForExit(proc) {
  return new Promise((resolve) => {
    if (BACKEND === 'php') return resolve(86); // a PHP request ends; the server keeps running
    if (proc.exitCode !== null) return resolve(proc.exitCode);
    proc.once('exit', (code) => resolve(code));
  });
}
async function restartServer(extraEnv) {
  await stopServer();
  return startServer(extraEnv);
}
// True when an export request was cut off before any file reached the caller.
async function exportCutOff(identity, credential) {
  try {
    const r = await exportToFile(identity, credential);
    return !(r.status === 200 && r.body && r.body.file);
  } catch (err) {
    return true;
  }
}

// Forwards a request to the issuer and swallows the answer, so the caller
// sees a dropped connection although the issuer completed the work.
function startDroppingProxy() {
  const server = net.createServer((client) => {
    const upstream = net.connect(PORT, '127.0.0.1');
    // issuer-php takes its domain from the Host header, so the proxy presents
    // itself as the issuer.
    let first = true;
    client.on('data', (d) => {
      if (first) { first = false; upstream.write(Buffer.from(d.toString('latin1').replace(/^Host: .*$/mi, 'Host: localhost:' + PORT), 'latin1')); }
      else upstream.write(d);
    });
    upstream.on('data', () => { client.destroy(); upstream.destroy(); });
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  return new Promise((resolve) => server.listen(PROXY_PORT, '127.0.0.1', () => resolve(server)));
}

function setManifest(extra) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  Object.assign(manifest, extra);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
}


// True when a claim request was cut off before any credential reached the caller.
async function claimCutOff(identity, file) {
  try {
    const r = await claim(identity, file);
    return !(r.status === 200 && r.body && r.body.credential);
  } catch (err) {
    return true;
  }
}
async function newFile(owner) {
  const ring = await mint(owner, RING);
  const ex = await exportToFile(owner, ring);
  assert(ex.status === 200, 'export failed: ' + ex.text);
  return { ring, file: ex.body.file };
}

(async () => {
  console.log('SETUP: isolated ' + BACKEND + ' issuer on port ' + PORT);
  if (BACKEND === 'php') {
    fs.cpSync(path.join(REPO, 'issuer-php'), DOCROOT, { recursive: true });
    fs.mkdirSync(path.join(DOCROOT, '.well-known'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'demo-domain-a', '.well-known', 'spatial.json'), MANIFEST);
  } else {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.cpSync(path.join(REPO, 'demo-domain-a'), DOCROOT, { recursive: true });
  }
  setManifest({ fileTransfer: { classes: [RING] } });
  await startServer();
  const proxy = await startDroppingProxy();

  try {
    const alice = await genIdentity();
    const bob = await genIdentity();
    const mallory = await genIdentity();

    console.log('STEP 1: a lost reply is recovered by repeating the claim');
    const one = await newFile(alice);
    let dropped = null;
    try { await (async () => { const payload = { credentialId: one.file.id, newOwnerPublicKey: bob.publicKey, action: 'claim-from-file' }; return post('/atlas/asset/claim-from-file', { credential: one.file, intent: { payload, proof: await proofFor(bob, payload) } }, PROXY_BASE); })(); } catch (err) { dropped = err; }
    assert(dropped, 'expected the proxied claim to fail with a dropped connection');
    const rec1 = claimRecord(one.file.id);
    assert(rec1 && rec1.state === 'claimed' && rec1.minted && rec1.claimantPublicKey === bob.publicKey, 'the issuer should have finished the claim, got ' + JSON.stringify(rec1 && rec1.state));
    assert(revocationOf(one.file.id) && revocationOf(one.file.id).reason === 'file-claimed', 'the file should be revoked as claimed');
    assert(!bearerHas(one.file.id), 'the file should be out of the registry');
    const retry = await claim(bob, one.file);
    assert(retry.status === 200 && retry.body.status === 'claimed', 'the retry should succeed, got ' + retry.status + ' ' + retry.text);
    assert(canonicalize(retry.body.credential) === canonicalize(rec1.minted), 'the retry must return exactly the credential minted the first time');
    assert(retry.body.credential.owner.publicKey === bob.publicKey, 'the credential belongs to the claimer');
    const many = await Promise.all(Array.from({ length: 8 }, () => claim(bob, one.file)));
    assert(many.every((m) => m.status === 200 && canonicalize(m.body.credential) === canonicalize(rec1.minted)), 'eight simultaneous retries should all return the same credential');
    await restartServer();
    const afterRestart = await claim(bob, one.file);
    assert(afterRestart.status === 200 && canonicalize(afterRestart.body.credential) === canonicalize(rec1.minted), 'the credential should survive a restart');
    assert(claimCount() === 1, 'exactly one claim record expected, got ' + claimCount());
    const st = await get('/atlas/asset/file-status?id=' + encodeURIComponent(one.file.id));
    assert(st.body.state === 'claimed', 'file-status should read claimed, got ' + JSON.stringify(st.body));
    console.log('PASS: identical credential on every retry (8 at once, across a restart), one record, one credential');

    console.log('STEP 2: nobody else can take the claimer\'s credential');
    const thief = await claim(mallory, one.file);
    assert(thief.status === 409 && thief.body.code === 'already-claimed', 'another key must be told it is claimed, got ' + thief.status + ' ' + thief.text);
    assert(!thief.text.includes(rec1.mintedId) && !thief.text.includes('"owner"'), 'the other key must learn nothing about the credential');
    const thiefAgain = await Promise.all(Array.from({ length: 6 }, () => claim(mallory, one.file)));
    assert(thiefAgain.every((t) => t.status === 409), 'every attempt by the other key is refused');
    const bobStill = await claim(bob, one.file);
    assert(bobStill.status === 200 && canonicalize(bobStill.body.credential) === canonicalize(rec1.minted), 'the real claimer is unaffected');
    console.log('PASS: other keys refused with nothing disclosed; the claimer still gets the credential');

    console.log('STEP 3: stop after every step of a claim');
    const points = [
      ['claim:minted', { record: false, bearer: true, revoked: false }],
      ['claim:committed', { record: 'committed', bearer: true, revoked: false }],
      ['claim:bearer-taken', { record: 'committed', bearer: false, revoked: false }],
      ['claim:revoked', { record: 'committed', bearer: false, revoked: true }],
      ['claim:claimed', { record: 'claimed', bearer: false, revoked: true }]
    ];
    for (const [point, expected] of points) {
      const f = await newFile(alice);
      await restartServer({ ATLAS_TEST_CRASH_AT: point });
      assert(await claimCutOff(bob, f.file), point + ': the claim should have been cut off');
      await stopServer();
      const rec = claimRecord(f.file.id);
      if (expected.record === false) assert(!rec, point + ': no record should exist yet');
      else assert(rec && rec.state === expected.record && rec.minted && rec.claimantPublicKey === bob.publicKey, point + ': expected a ' + expected.record + ' record, got ' + JSON.stringify(rec && rec.state));
      assert(bearerHas(f.file.id) === expected.bearer, point + ': registry entry should be ' + (expected.bearer ? 'present' : 'gone'));
      assert(!!revocationOf(f.file.id) === expected.revoked, point + ': file revoked should be ' + expected.revoked);
      const storedBefore = rec && rec.minted ? canonicalize(rec.minted) : null;

      await startServer();
      const thiefHere = await claim(mallory, f.file);
      if (expected.record === false) {
        assert(thiefHere.status === 200, point + ': before the record exists the file is still claimable by whoever asks first, got ' + thiefHere.text);
        console.log('  ok   ' + point + ': nothing committed; the file stayed claimable and was claimed afresh');
        continue;
      }
      assert(thiefHere.status === 409 && thiefHere.body.code === 'already-claimed', point + ': another key must not get the file, got ' + thiefHere.text);
      const again = await claim(bob, f.file);
      assert(again.status === 200 && canonicalize(again.body.credential) === storedBefore, point + ': the claimer must get the credential stored in the record, got ' + again.text);
      const done = claimRecord(f.file.id);
      assert(done.state === 'claimed' && !bearerHas(f.file.id) && revocationOf(f.file.id) && revocationOf(f.file.id).reason === 'file-claimed', point + ': the claim should be finished');
      assert(done.transitions.map((t) => t.state).join() === 'committed,claimed', point + ': each state entered once, got ' + done.transitions.map((t) => t.state).join());
      console.log('  ok   ' + point + ': committed claim finished; the claimer got the stored credential');
    }
    console.log('PASS: a stop at every step loses nothing and never lets a second party in');

    console.log('STEP 4: export recovery finishes a half-finished claim');
    {
      const f = await newFile(alice);
      await restartServer({ ATLAS_TEST_CRASH_AT: 'claim:bearer-taken' });
      assert(await claimCutOff(bob, f.file), 'the claim should have been cut off');
      await stopServer();
      await startServer();
      const rec = await recoverExport(alice, f.ring.id);
      assert(rec.status === 409 && rec.body.code === 'already-claimed', 'recovery should report the file claimed, got ' + rec.status + ' ' + rec.text);
      assert(revocationOf(f.file.id) && claimRecord(f.file.id).state === 'claimed', 'the claim should now be finished');
      assert(exportRecord(f.ring.id).state === 'claimed', 'the export record should read claimed');
      const bobGets = await claim(bob, f.file);
      assert(bobGets.status === 200, 'the claimer still gets the credential, got ' + bobGets.text);
    }
    console.log('PASS: the owner is told the file is claimed, not left waiting');

    console.log('STEP 5: different keys claiming at once, three rounds');
    for (let round = 1; round <= 3; round++) {
      const f = await newFile(alice);
      const before = claimCount();
      const jobs = [];
      for (let i = 0; i < 8; i++) jobs.push(claim(i % 2 ? bob : mallory, f.file));
      const out = await Promise.all(jobs);
      const wins = out.filter((o) => o.status === 200);
      assert(wins.length >= 1 && new Set(wins.map((w) => w.body.credential.id)).size === 1 && new Set(wins.map((w) => w.body.credential.owner.publicKey)).size === 1, 'round ' + round + ': one claimer, one credential expected');
      assert(out.every((o) => o.status === 200 || o.status === 409), 'round ' + round + ': unexpected statuses ' + out.map((o) => o.status).join(','));
      assert(claimCount() === before + 1, 'round ' + round + ': exactly one new claim record');
    }
    console.log('PASS: one claimer, one credential, one record per round');

    console.log('STEP 6: after the replay window only a receipt remains');
    {
      const f = await newFile(alice);
      const first = await claim(bob, f.file);
      assert(first.status === 200, 'claim failed: ' + first.text);
      const doc = readJson(CLAIMS_STORE, { claims: {} });
      doc.claims[f.file.id].claimedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(CLAIMS_STORE, JSON.stringify(doc, null, 2));
      const g = await newFile(alice);
      assert((await claim(bob, g.file)).status === 200, 'a later claim should work');
      const kept = claimRecord(f.file.id);
      assert(kept && !kept.minted && kept.mintedId === first.body.credential.id && kept.claimId && kept.createdAt && kept.claimedAt && kept.transitions.length === 2, 'the old record should keep ids and timestamps but not the credential: ' + JSON.stringify(Object.keys(kept || {})));
      const late = await claim(bob, f.file);
      assert(late.status === 409 && late.body.code === 'already-claimed' && late.body.receipt && late.body.receipt.mintedId === first.body.credential.id, 'a late retry gets the receipt, got ' + late.text);
      const lateStranger = await claim(mallory, f.file);
      assert(lateStranger.status === 409 && !lateStranger.body.receipt, 'another key gets no receipt, got ' + lateStranger.text);
    }
    console.log('PASS: credential dropped after the window; ids, outcome and timestamps kept');

    console.log('\nALL FILE CLAIM RECOVERY CHECKS PASSED (' + BACKEND + ')');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    proxy.close();
    await stopServer();
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    process.exit(process.exitCode || 0);
  }
})();
