// Manual end-to-end check for recovering an interrupted single-asset file
// export (SPEC.md §13.5.1): the export record's state machine, the
// challenge-signed recovery request, and the guarantees around it. HTTP
// layer only, against an isolated issuer-server that the test stops and
// restarts on the same state folder.
//
//   node test/manual-asset-file-recovery.js          # issuer-server (Node)
//
// An export is several separate writes (the export record, revoking the
// owner's credential, listing the file in the bearer registry). The issuer
// can be made to stop dead right after any one of them with
// ATLAS_TEST_CRASH_AT=<point>; this test does that at every point and checks
// what is on disk and what recovery then does.
//
// Checks:
//   1. A reply lost in transit (a proxy forwards the request and swallows the
//      answer): the owner still has no file, recovery returns it, and
//      repeating recovery returns the identical file every time, including
//      eight at once and across an issuer restart.
//   2. Nobody else can obtain the file: a stranger with a valid signature, an
//      unknown id, a challenge issued for another id, a forged or expired
//      challenge, a replayed request, a changed payload, a wrong action. The
//      stranger and the unknown id get byte-identical answers.
//   3. After the file is claimed, recovery reports it as claimed with a
//      compact receipt; the stored record has dropped the file and the
//      original but kept the ids, outcome and timestamps. Repeating it gives
//      the same answer.
//   4. Exporting again is refused as already-exported and creates nothing.
//   5. A stop after every step of the export (prepared, original revoked,
//      state recorded, file listed, pending): at no point on disk are the
//      original and a claimable file both live; before the file is listed it
//      cannot be claimed even if someone had it; recovery finishes the export
//      to the same end state from each.
//   6. A stop after `prepared` followed by the owner spending the original
//      elsewhere: recovery abandons the export, the file is never listed, and
//      a receipt says so.
//   7. Eight simultaneous recoveries from a half-finished state all return
//      the same file and advance each state exactly once.
//   8. Recovery, claim and re-export racing each other: exactly one claim
//      wins, no recovery ever returns a file other than the original, no
//      second file is created.
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

const BACKEND = 'node';
const PORT = 8231;
const PROXY_PORT = 8232;
const BASE = 'http://localhost:' + PORT;
const PROXY_BASE = 'http://localhost:' + PROXY_PORT;
const DOMAIN = 'localhost:' + PORT;
const REPO = path.resolve(__dirname, '..');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-file-recovery-'));
const DOCROOT = path.join(TMP_ROOT, 'docroot');
const STATE_DIR = path.join(TMP_ROOT, 'state');
const MANIFEST = path.join(DOCROOT, '.well-known', 'spatial.json');
const REVOCATIONS = path.join(DOCROOT, '.well-known', 'atlas-revocations.json');
const BEARER_STORE = path.join(STATE_DIR, 'atlas-bearer-store.json');
const EXPORTS_STORE = path.join(STATE_DIR, 'atlas-file-exports-store.json');
const SECRET_FILE = path.join(STATE_DIR, 'atlas-recovery-secret.json');
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
async function getChallenge(credentialId) {
  const r = await post('/atlas/asset/recover-file-export/challenge', { credentialId });
  assert(r.status === 200 && typeof r.body.challenge === 'string', 'challenge request failed: ' + r.text);
  return r.body.challenge;
}
// A complete recovery request, returned as the body so a test can replay or
// alter it.
async function recoveryBody(identity, credentialId, overrides) {
  const o = overrides || {};
  const challenge = o.challenge || (await getChallenge(o.challengeFor || credentialId));
  const payload = { credentialId, action: 'recover-file-export', challenge, ...(o.payload || {}) };
  return { intent: { payload, proof: await proofFor(identity, o.signPayload || payload) } };
}
async function recover(identity, credentialId, overrides) {
  return post('/atlas/asset/recover-file-export', await recoveryBody(identity, credentialId, overrides));
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
function exportCount() {
  return Object.keys(readJson(EXPORTS_STORE, { exports: {} }).exports).length;
}
// The one property that must hold at every instant: the original and a
// claimable file are never both live.
function assertNeverBothLive(originalId, fileId, when) {
  const originalLive = !revocationOf(originalId);
  const fileClaimable = bearerHas(fileId) && !revocationOf(fileId);
  assert(!(originalLive && fileClaimable), 'both the original and a claimable file are live ' + when);
}

let serverProc = null;
function startServer(extraEnv) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['issuer-server/server.js'], {
      cwd: REPO,
      env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: DOCROOT, ...(extraEnv || {}) },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); serverProc = proc; resolve(proc); } });
    proc.on('exit', (code) => { if (serverProc === proc) serverProc = null; });
  });
}
function stopServer() {
  return new Promise((resolve) => {
    if (!serverProc) return resolve();
    const proc = serverProc;
    proc.once('exit', () => resolve());
    proc.kill('SIGKILL');
  });
}
function waitForExit(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve(proc.exitCode);
    proc.once('exit', (code) => resolve(code));
  });
}
async function restartServer(extraEnv) {
  await stopServer();
  return startServer(extraEnv);
}

// Forwards a request to the issuer and swallows the answer, so the caller
// sees a dropped connection although the issuer completed the work.
function startDroppingProxy() {
  const server = net.createServer((client) => {
    const upstream = net.connect(PORT, '127.0.0.1');
    client.on('data', (d) => upstream.write(d));
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

// A correctly signed challenge that is already expired, built with the
// issuer's own secret (the test owns the state folder).
function expiredChallengeFor(credentialId) {
  const secret = Buffer.from(JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8')).secret, 'base64url');
  const nonce = 'expired-' + Date.now();
  const expiry = Date.now() - 1000;
  const mac = createHmac('sha256', secret).update('recover-file-export|v1|' + credentialId + '|' + nonce + '|' + expiry).digest('base64url');
  return nonce + '.' + expiry + '.' + mac;
}

(async () => {
  console.log('SETUP: isolated ' + BACKEND + ' issuer on port ' + PORT);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.cpSync(path.join(REPO, 'demo-domain-a'), DOCROOT, { recursive: true });
  setManifest({ fileTransfer: { classes: [RING] } });
  await startServer();
  const proxy = await startDroppingProxy();

  try {
    const alice = await genIdentity();
    const bob = await genIdentity();
    const mallory = await genIdentity();

    console.log('STEP 1: a lost reply is recovered, and recovery can be repeated');
    const ring1 = await mint(alice, RING);
    let dropped = null;
    try { await exportToFile(alice, ring1, PROXY_BASE); } catch (err) { dropped = err; }
    assert(dropped, 'expected the proxied export to fail with a dropped connection');
    const rec1 = exportRecord(ring1.id);
    assert(rec1 && rec1.state === 'pending', 'the issuer should have finished the export, got ' + (rec1 && rec1.state));
    assert(revocationOf(ring1.id) && revocationOf(ring1.id).reason === 'file-transferred', 'the original should be revoked');
    const file1 = rec1.file;
    assert(bearerHas(file1.id), 'the file should be listed');

    const r1 = await recover(alice, ring1.id);
    assert(r1.status === 200 && r1.body.status === 'pending', 'expected recovery to succeed, got ' + r1.status + ' ' + r1.text);
    assert(canonicalize(r1.body.file) === canonicalize(file1), 'recovery must return exactly the minted file');
    assert(r1.body.exportId === rec1.exportId, 'recovery should name the export');
    const r1b = await recover(alice, ring1.id);
    assert(r1b.status === 200 && canonicalize(r1b.body.file) === canonicalize(file1), 'a second recovery should return the same file');
    const many = await Promise.all(Array.from({ length: 8 }, () => recover(alice, ring1.id)));
    assert(many.every((m) => m.status === 200 && canonicalize(m.body.file) === canonicalize(file1)), 'eight simultaneous recoveries should all return the same file');
    assert(Object.keys(readJson(BEARER_STORE, { bearers: {} }).bearers).filter((k) => k === file1.id).length === 1, 'the file must be listed once');
    const stBefore = await get('/atlas/asset/file-status?id=' + encodeURIComponent(file1.id));
    assert(stBefore.body.state === 'claimable', 'recovery must not change claimability, got ' + JSON.stringify(stBefore.body));
    const pendingChallenge = await getChallenge(ring1.id);
    await restartServer();
    const afterRestart = await recover(alice, ring1.id, { challenge: pendingChallenge });
    assert(afterRestart.status === 200 && canonicalize(afterRestart.body.file) === canonicalize(file1), 'a challenge issued before a restart, and the file, should survive it');
    console.log('PASS: file recovered, identical on every repeat (including 8 at once and across a restart), still claimable once');

    console.log('STEP 2: nobody but the owner can get the file');
    const stranger = await recover(mallory, ring1.id);
    const unknown = await recover(mallory, 'urn:atlas:asset:does-not-exist');
    assert(stranger.status === 404 && stranger.body.code === 'not-found', 'a stranger should get 404 not-found, got ' + stranger.status + ' ' + stranger.text);
    assert(stranger.text === unknown.text && stranger.status === unknown.status, 'a stranger and an unknown id must get identical answers');
    assert(!stranger.text.includes(file1.id) && !stranger.text.includes('signature'), 'the stranger must learn nothing about the file');
    const wrongChallenge = await recover(alice, ring1.id, { challengeFor: 'urn:atlas:asset:another' });
    assert(wrongChallenge.status === 400 && wrongChallenge.body.code === 'invalid-challenge', 'a challenge issued for another id must be refused, got ' + wrongChallenge.text);
    const goodChallenge = await getChallenge(ring1.id);
    const forged = goodChallenge.slice(0, -3) + (goodChallenge.endsWith('AAA') ? 'BBB' : 'AAA');
    const forgedRes = await recover(alice, ring1.id, { challenge: forged });
    assert(forgedRes.status === 400 && forgedRes.body.code === 'invalid-challenge', 'a forged challenge must be refused, got ' + forgedRes.text);
    const expired = await recover(alice, ring1.id, { challenge: expiredChallengeFor(ring1.id) });
    assert(expired.status === 400 && expired.body.code === 'expired-challenge', 'an expired challenge must be refused, got ' + expired.text);
    const noChallenge = await recover(alice, ring1.id, { challenge: 'garbage' });
    assert(noChallenge.status === 400 && noChallenge.body.code === 'invalid-challenge', 'a malformed challenge must be refused');
    const wrongAction = await recover(alice, ring1.id, { payload: { action: 'transfer-to-file' } });
    assert(wrongAction.status === 400, 'a different action must be refused, got ' + wrongAction.status);
    const changed = await recover(alice, ring1.id, { signPayload: { credentialId: 'urn:atlas:asset:x', action: 'recover-file-export', challenge: 'x' } });
    assert(changed.status === 400 && /signature/.test(changed.body.error), 'a payload that does not match the signature must be refused, got ' + changed.text);
    // Replay: send one valid request twice.
    const captured = await recoveryBody(alice, ring1.id);
    const first = await post('/atlas/asset/recover-file-export', captured);
    const replay = await post('/atlas/asset/recover-file-export', captured);
    assert(first.status === 200, 'the genuine request should succeed, got ' + first.text);
    assert(replay.status === 400 && replay.body.code === 'challenge-used' && !replay.text.includes(file1.id), 'a replayed request must be refused without the file, got ' + replay.text);
    await restartServer();
    const replayAfterRestart = await post('/atlas/asset/recover-file-export', captured);
    assert(replayAfterRestart.status === 400 && replayAfterRestart.body.code === 'challenge-used', 'a replay must still be refused after a restart, got ' + replayAfterRestart.text);
    // Refused attempts must not have used up the owner's challenge.
    const stillOk = await recover(alice, ring1.id, { challenge: goodChallenge });
    assert(stillOk.status === 200, 'a stranger or a refusal must not burn the owner\'s challenge, got ' + stillOk.text);
    console.log('PASS: stranger/unknown id identical, wrong/forged/expired/garbage challenge, wrong action, altered payload and replays (also after restart) all refused');

    console.log('STEP 3: after the claim, recovery reports a compact receipt');
    const claimed = await claim(bob, file1);
    assert(claimed.status === 200, 'claim failed: ' + claimed.text);
    const afterClaim = await recover(alice, ring1.id);
    assert(afterClaim.status === 409 && afterClaim.body.code === 'already-claimed', 'expected already-claimed, got ' + afterClaim.text);
    assert(!afterClaim.text.includes('"signature"'), 'a claimed export must not return the file');
    const afterClaimAgain = await recover(alice, ring1.id);
    assert(afterClaimAgain.status === 409 && afterClaimAgain.body.code === 'already-claimed', 'repeating it should give the same answer');
    const receipt = exportRecord(ring1.id);
    assert(receipt.state === 'claimed' && receipt.outcomeReason === 'file-claimed', 'expected a claimed receipt, got ' + JSON.stringify(receipt));
    assert(receipt.file === undefined && receipt.original === undefined, 'the file and the original must be dropped from the receipt');
    assert(receipt.exportId && receipt.originalId === ring1.id && receipt.fileId === file1.id && receipt.claimCredentialId === claimed.body.credential.id, 'the receipt must keep the transaction ids');
    assert(receipt.createdAt && receipt.closedAt && receipt.claimedAt, 'the receipt must keep its timestamps');
    assert(receipt.transitions.map((t) => t.state).join(',') === 'prepared,original-revoked,pending,claimed', 'unexpected transitions: ' + JSON.stringify(receipt.transitions));
    assert(afterClaim.body.receipt.exportId === receipt.exportId && afterClaim.body.receipt.state === 'claimed', 'the answer should carry the receipt');
    console.log('PASS: claimed -> 409 already-claimed + receipt; record keeps ids, outcome and timestamps, drops the file');

    console.log('STEP 4: exporting the same credential again is refused and creates nothing');
    const recordsBefore = exportCount();
    const bearersBefore = Object.keys(readJson(BEARER_STORE, { bearers: {} }).bearers).length;
    const again = await exportToFile(alice, ring1);
    assert(again.status === 409 && again.body.code === 'already-exported', 'expected already-exported, got ' + again.text);
    assert(exportCount() === recordsBefore && Object.keys(readJson(BEARER_STORE, { bearers: {} }).bearers).length === bearersBefore, 'a refused re-export must create nothing');
    console.log('PASS: re-export refused as already-exported');

    console.log('STEP 5: a stop after every step of the export');
    const points = [
      ['export:prepared', 'prepared'],
      ['export:original-revoked-fact', 'prepared'],
      ['export:original-revoked', 'original-revoked'],
      ['export:bearer-registered', 'original-revoked'],
      ['export:pending', 'pending']
    ];
    for (const [point, expectedState] of points) {
      const ring = await mint(alice, RING);
      const crashing = await restartServer({ ATLAS_TEST_CRASH_AT: point });
      const exited = waitForExit(crashing);
      let failed = null;
      try { await exportToFile(alice, ring); } catch (err) { failed = err; }
      assert(failed, point + ': the export request should have been cut off');
      assert((await exited) === 86, point + ': the issuer should have stopped at the fault point');
      const stopped = exportRecord(ring.id);
      assert(stopped && stopped.state === expectedState, point + ': expected the record to read ' + expectedState + ', got ' + (stopped && stopped.state));
      const fileId = stopped.fileId;
      assertNeverBothLive(ring.id, fileId, 'after a stop at ' + point);
      if (!bearerHas(fileId)) {
        // Not listed yet: even somebody holding the file could not claim it.
        await startServer();
        const early = await claim(bob, stopped.file);
        assert(early.status === 400 && early.body.code === 'not-claimable', point + ': an unlisted file must not be claimable, got ' + early.text);
        assert(!revocationOf(fileId), point + ': a refused claim must not revoke the file');
      } else {
        await startServer();
      }
      const recovered = await recover(alice, ring.id);
      assert(recovered.status === 200 && recovered.body.file.id === fileId, point + ': recovery should return the file, got ' + recovered.text);
      assert(revocationOf(ring.id) && revocationOf(ring.id).reason === 'file-transferred', point + ': the original should now be revoked');
      assert(bearerHas(fileId), point + ': the file should now be listed');
      assertNeverBothLive(ring.id, fileId, 'after recovery from ' + point);
      assert(exportRecord(ring.id).state === 'pending', point + ': the record should now be pending');
      const win = await claim(bob, recovered.body.file);
      assert(win.status === 200, point + ': the recovered file should be claimable, got ' + win.text);
      const lose = await claim(mallory, recovered.body.file);
      assert(lose.status === 409, point + ': a second claim must lose, got ' + lose.status);
      console.log('  PASS: stop at ' + point + ' (record ' + expectedState + ') -> never both live; recovery finishes it; claimable exactly once');
    }
    console.log('PASS: all five stop points reconcile to the same end state');

    console.log('STEP 6: the original is spent elsewhere before recovery');
    const ring6 = await mint(alice, RING);
    const crash6 = await restartServer({ ATLAS_TEST_CRASH_AT: 'export:prepared' });
    const exit6 = waitForExit(crash6);
    try { await exportToFile(alice, ring6); } catch (err) { /* expected */ }
    await exit6;
    const prepared6 = exportRecord(ring6.id);
    assert(prepared6 && prepared6.state === 'prepared', 'expected a prepared record');
    await startServer();
    const redeemPayload = { credentialId: ring6.id, action: 'redeem' };
    const redeemed = await post('/atlas/asset/redeem', { credential: ring6, intent: { payload: redeemPayload, proof: await proofFor(alice, redeemPayload) } });
    assert(redeemed.status === 200, 'the owner should be able to spend the original, got ' + redeemed.text);
    const abandoned = await recover(alice, ring6.id);
    assert(abandoned.status === 409 && abandoned.body.code === 'export-abandoned', 'expected export-abandoned, got ' + abandoned.text);
    assert(!abandoned.text.includes('"signature"'), 'an abandoned export must not return the file');
    assert(!bearerHas(prepared6.fileId), 'an abandoned file must never be listed');
    const leaked = await claim(bob, prepared6.file);
    assert(leaked.status === 400 && leaked.body.code === 'not-claimable', 'an abandoned file must not be claimable, got ' + leaked.text);
    const receipt6 = exportRecord(ring6.id);
    assert(receipt6.state === 'abandoned' && receipt6.outcomeReason === 'original-spent' && receipt6.file === undefined && receipt6.original === undefined && receipt6.closedAt, 'expected a compact abandoned receipt, got ' + JSON.stringify(receipt6));
    assert(revocationOf(ring6.id).reason === 'issuer-request', 'the original keeps the reason it was really revoked for');
    console.log('PASS: abandoned, file never listed, receipt kept');

    console.log('STEP 7: simultaneous recoveries from a half-finished export');
    const ring7 = await mint(alice, RING);
    const crash7 = await restartServer({ ATLAS_TEST_CRASH_AT: 'export:original-revoked' });
    const exit7 = waitForExit(crash7);
    try { await exportToFile(alice, ring7); } catch (err) { /* expected */ }
    await exit7;
    const half = exportRecord(ring7.id);
    await startServer();
    const burst = await Promise.all(Array.from({ length: 8 }, () => recover(alice, ring7.id)));
    assert(burst.every((b) => b.status === 200 && b.body.file.id === half.fileId), 'all eight should return the same file, got ' + burst.map((b) => b.status).join(','));
    const settled = exportRecord(ring7.id);
    assert(settled.transitions.map((t) => t.state).join(',') === 'prepared,original-revoked,pending', 'each state must be entered exactly once, got ' + settled.transitions.map((t) => t.state).join(','));
    assert(readJson(REVOCATIONS, { revoked: [] }).revoked.filter((r) => r.id === ring7.id).length === 1, 'the original must be revoked exactly once');
    console.log('PASS: eight simultaneous recoveries, one outcome, each state entered once');

    console.log('STEP 8: recovery, claim and re-export racing each other');
    for (let round = 1; round <= 3; round++) {
      const ring = await mint(alice, RING);
      const ex = await exportToFile(alice, ring);
      assert(ex.status === 200, 'export failed: ' + ex.text);
      const file = ex.body.file;
      const claimers = [bob, mallory];
      const jobs = [];
      for (let i = 0; i < 6; i++) jobs.push(recover(alice, ring.id).then((r) => ({ kind: 'recover', r })));
      for (let i = 0; i < 4; i++) jobs.push(claim(claimers[i % 2], file).then((r) => ({ kind: 'claim', r })));
      for (let i = 0; i < 3; i++) jobs.push(exportToFile(alice, ring).then((r) => ({ kind: 'export', r })));
      const out = await Promise.all(jobs);
      const wins = out.filter((o) => o.kind === 'claim' && o.r.status === 200);
      assert(wins.length === 1, 'round ' + round + ': exactly one claim should win, got ' + wins.length);
      for (const o of out.filter((x) => x.kind === 'recover')) {
        assert(o.r.status === 200 || o.r.status === 409, 'round ' + round + ': unexpected recovery status ' + o.r.status);
        if (o.r.status === 200) assert(canonicalize(o.r.body.file) === canonicalize(file), 'round ' + round + ': a recovery returned a different file');
        else assert(['already-claimed', 'in-progress'].includes(o.r.body.code), 'round ' + round + ': unexpected recovery answer ' + o.r.text);
      }
      for (const o of out.filter((x) => x.kind === 'export')) {
        assert(o.r.status === 409 && ['already-exported', 'in-progress'].includes(o.r.body.code), 'round ' + round + ': a re-export must be refused, got ' + o.r.text);
      }
      const finalRec = await recover(alice, ring.id);
      assert(finalRec.status === 409 && finalRec.body.code === 'already-claimed', 'round ' + round + ': after the race the export should read claimed, got ' + finalRec.text);
      const allFiles = Object.values(readJson(EXPORTS_STORE, { exports: {} }).exports).filter((e) => e.originalId === ring.id);
      assert(allFiles.length === 1, 'round ' + round + ': exactly one export record expected');
      assert(revocationOf(file.id) && revocationOf(file.id).reason === 'file-claimed', 'round ' + round + ': the file should be revoked as claimed');
    }
    console.log('PASS: three rounds of 6 recoveries + 4 claims + 3 re-exports: one claim winner, one record, no second file');

    console.log('\nALL FILE EXPORT RECOVERY CHECKS PASSED (' + BACKEND + ')');
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
