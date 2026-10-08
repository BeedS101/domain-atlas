// Manual end-to-end check for exporting a single asset to a claimable file
// and claiming it (SPEC.md §13.5): POST /atlas/asset/transfer-to-file,
// POST /atlas/asset/claim-from-file and GET /atlas/asset/file-status on an
// isolated issuer-server, HTTP layer only. The wallet screens that use
// these are covered by their own tests.
//
//   node test/manual-asset-file-transfer.js          # issuer-server (Node)
//   node test/manual-asset-file-transfer.js php      # issuer-php
//
// Checks:
//   1. With no `fileTransfer` in the manifest, an export is refused and
//      nothing is revoked.
//   2. Export refusals leave the original untouched: a fungible class, a
//      bound class, a class outside the manifest's `classes` list, an intent
//      signed by someone other than the owner, an intent for a different
//      credential, and a tampered credential.
//   3. A successful export revokes the owner's credential (reason
//      file-transferred), returns a credential owned by a discarded key with
//      the same signed asset (class, serial, edition, properties) and
//      `supersedes` pointing at the original, and file-status says claimable.
//   4. A stolen COPY of an ordinary wallet credential cannot be claimed: the
//      claim is refused as not-claimable and the real owner's credential is
//      still valid.
//   5. The file is claimed by one wallet: the new credential belongs to the
//      claimer, the file's credential is revoked (file-claimed), and a second
//      claim of the same file is refused as already-claimed.
//   6. Eight simultaneous claims of one file produce exactly one winner.
//   7. Six simultaneous exports of one credential produce exactly one file.
//   8. A claim signed by a key other than the new owner, a claim of a
//      tampered file, and a claim of another domain's credential are refused.
//   9. The exporter can claim their own file back, and the result is an
//      ordinary credential they can export again.
//
// Not part of the permanent suite, same reasoning as the other manual-*.js
// scripts.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const BACKEND = process.argv[2] === 'php' ? 'php' : 'node';
const PORT = BACKEND === 'php' ? 8220 : 8219; // isolated, distinct from every other manual-*.js test
const BASE = 'http://localhost:' + PORT;
const DOMAIN = 'localhost:' + PORT;
const REPO = path.resolve(__dirname, '..');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-file-transfer-'));
// issuer-php keeps its state in lib/ inside the bundle, which is also its docroot.
const DOCROOT = BACKEND === 'php' ? path.join(TMP_ROOT, 'domain') : path.join(TMP_ROOT, 'docroot');
const STATE_DIR = BACKEND === 'php' ? path.join(DOCROOT, 'lib') : path.join(TMP_ROOT, 'state');
const MANIFEST = path.join(DOCROOT, '.well-known', 'spatial.json');
const REVOCATIONS = path.join(DOCROOT, '.well-known', 'atlas-revocations.json');
const BEARER_STORE = path.join(STATE_DIR, 'atlas-bearer-store.json');
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
async function post(urlPath, body) {
  const res = await fetch(BASE + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function get(urlPath) {
  const res = await fetch(BASE + urlPath);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function mint(owner, assetClass, quantity) {
  const r = await post('/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass, ...(quantity ? { quantity } : {}) });
  assert(r.status === 200, 'mint of ' + assetClass + ' failed: ' + r.status + ' ' + JSON.stringify(r.body));
  return r.body;
}
async function exportToFile(identity, credential, intentOverrides) {
  const payload = { credentialId: credential.id, action: 'transfer-to-file', ...(intentOverrides || {}) };
  return post('/atlas/asset/transfer-to-file', { credential, intent: { payload, proof: await proofFor(identity, payload) } });
}
async function claim(identity, credential, newOwnerPublicKey) {
  const payload = { credentialId: credential.id, newOwnerPublicKey: newOwnerPublicKey || identity.publicKey, action: 'claim-from-file' };
  return post('/atlas/asset/claim-from-file', { credential, intent: { payload, proof: await proofFor(identity, payload) } });
}
function revocationOf(id) {
  return JSON.parse(fs.readFileSync(REVOCATIONS, 'utf8')).revoked.find((r) => r.id === id) || null;
}
function setManifest(extra) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  delete manifest.fileTransfer;
  Object.assign(manifest, extra);
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
}
function bearerCount() {
  return fs.existsSync(BEARER_STORE) ? Object.keys(JSON.parse(fs.readFileSync(BEARER_STORE, 'utf8')).bearers).length : 0;
}

(async () => {
  console.log('SETUP: isolated ' + BACKEND + ' issuer on port ' + PORT);
  let serverProc;
  if (BACKEND === 'php') {
    fs.cpSync(path.join(REPO, 'issuer-php'), DOCROOT, { recursive: true });
    fs.mkdirSync(path.join(DOCROOT, '.well-known'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'demo-domain-a', '.well-known', 'spatial.json'), MANIFEST);
    setManifest({});
    // Several workers so the simultaneous requests below genuinely overlap.
    serverProc = spawn('php', ['-S', 'localhost:' + PORT, 'test-router.php'], {
      cwd: DOCROOT, env: { ...process.env, PHP_CLI_SERVER_WORKERS: '8' }, stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
      serverProc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
      serverProc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
    });
  } else {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.cpSync(path.join(REPO, 'demo-domain-a'), DOCROOT, { recursive: true });
    setManifest({}); // starts without the opt-in
    serverProc = spawn('node', ['issuer-server/server.js'], {
      cwd: REPO,
      env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: DOCROOT },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
      serverProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
      serverProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
    });
  }

  try {
    const alice = await genIdentity();
    const bob = await genIdentity();
    const carol = await genIdentity();
    const mallory = await genIdentity();

    console.log('STEP 1: without the manifest opt-in an export is refused');
    const ring1 = await mint(alice, RING);
    const off = await exportToFile(alice, ring1);
    assert(off.status === 400 && off.body.code === 'not-enabled', 'expected 400 not-enabled, got ' + JSON.stringify(off));
    assert(!revocationOf(ring1.id), 'a refused export must not revoke anything');
    console.log('PASS: refused ->', off.body.error);

    setManifest({ fileTransfer: { classes: [RING] } });

    console.log('STEP 2: refusals leave the original untouched');
    const iron = await mint(alice, 'atlas.element.iron', 5);
    const badge = await mint(alice, 'atlas.badge');
    const cases = [
      ['fungible class', () => exportToFile(alice, iron), 'class-not-allowed'],
      ['class outside the manifest list', () => exportToFile(alice, badge), 'class-not-allowed'],
      ['intent signed by a non-owner', () => exportToFile(mallory, ring1), null],
      ['intent for a different credential', () => exportToFile(alice, ring1, { credentialId: 'urn:uuid:other' }), null],
      ['tampered credential', () => exportToFile(alice, { ...ring1, asset: { ...ring1.asset, name: 'Forged Ring' } }), null]
    ];
    for (const [label, run, code] of cases) {
      const r = await run();
      assert(r.status === 400, label + ': expected 400, got ' + r.status + ' ' + JSON.stringify(r.body));
      if (code) assert(r.body.code === code, label + ': expected code ' + code + ', got ' + JSON.stringify(r.body));
    }
    for (const c of [ring1, iron, badge]) assert(!revocationOf(c.id), 'a refused export revoked ' + c.id);
    assert(bearerCount() === 0, 'a refused export registered a file');
    setManifest({ fileTransfer: {} });
    const bound = await exportToFile(alice, badge);
    assert(bound.status === 400 && /bound/.test(bound.body.error), 'expected a bound asset to be refused, got ' + JSON.stringify(bound.body));
    setManifest({ fileTransfer: { classes: [RING] } });
    console.log('PASS: fungible, bound, off-list, wrong signer, wrong credential and tampered credential all refused');

    console.log('STEP 3: a successful export');
    const ex = await exportToFile(alice, ring1);
    assert(ex.status === 200 && ex.body.status === 'file-transferred', 'export failed: ' + JSON.stringify(ex));
    const file1 = ex.body.file;
    assert(file1.id !== ring1.id && file1.owner.publicKey !== alice.publicKey, 'the file must be a new credential owned by a different key');
    assert(file1.supersedes === ring1.id, 'file.supersedes should name the original');
    assert(JSON.stringify(file1.asset.properties['atlas.serial']) === JSON.stringify(ring1.asset.properties['atlas.serial']), 'serial must carry over');
    assert(file1.asset.properties['atlas.editionSize'] === ring1.asset.properties['atlas.editionSize'], 'edition size must carry over');
    assert(canonicalize(file1.asset) === canonicalize(ring1.asset), 'the signed asset must be unchanged');
    const rev = revocationOf(ring1.id);
    assert(rev && rev.reason === 'file-transferred', 'expected the original revoked as file-transferred, got ' + JSON.stringify(rev));
    const st = await get('/atlas/asset/file-status?id=' + encodeURIComponent(file1.id));
    assert(st.body.state === 'claimable' && st.body.claimable === true, 'expected claimable, got ' + JSON.stringify(st.body));
    assert(bearerCount() === 1, 'expected one registered file');
    console.log('PASS: original revoked, file is a new credential with the same signed asset, status claimable');

    console.log('STEP 4: a copied ordinary credential cannot be claimed');
    const ring2 = await mint(alice, RING);
    const stolen = await claim(mallory, ring2);
    assert(stolen.status === 400 && stolen.body.code === 'not-claimable', 'expected not-claimable, got ' + JSON.stringify(stolen));
    assert(!revocationOf(ring2.id), 'the real owner\'s credential must still be valid');
    const unk = await get('/atlas/asset/file-status?id=' + encodeURIComponent(ring2.id));
    assert(unk.body.state === 'unknown' && unk.body.claimable === false, 'a wallet credential must report unknown, got ' + JSON.stringify(unk.body));
    console.log('PASS: refused, original still valid, status unknown');

    console.log('STEP 5: the file is claimed once');
    const won = await claim(bob, file1);
    assert(won.status === 200 && won.body.status === 'claimed', 'claim failed: ' + JSON.stringify(won));
    assert(won.body.credential.owner.publicKey === bob.publicKey, 'the claimer must own the new credential');
    assert(canonicalize(won.body.credential.asset) === canonicalize(ring1.asset), 'the claimed asset must be unchanged');
    assert(revocationOf(file1.id) && revocationOf(file1.id).reason === 'file-claimed', 'the file must be revoked as file-claimed');
    assert((await get('/atlas/asset/file-status?id=' + encodeURIComponent(file1.id))).body.state === 'claimed', 'status should say claimed');
    const again = await claim(carol, file1);
    assert(again.status === 409 && again.body.code === 'already-claimed', 'expected a second claim to be already-claimed, got ' + JSON.stringify(again));
    assert(bearerCount() === 0, 'the registry entry must be consumed');
    console.log('PASS: first claim wins, second refused as already-claimed');

    console.log('STEP 6: eight simultaneous claims, one winner');
    const ring3 = await mint(alice, RING);
    const file3 = (await exportToFile(alice, ring3)).body.file;
    const claimers = await Promise.all(Array.from({ length: 8 }, () => genIdentity()));
    const results = await Promise.all(claimers.map((c) => claim(c, file3)));
    const winners = results.filter((r) => r.status === 200);
    assert(winners.length === 1, 'expected exactly one winner, got ' + winners.length + ': ' + JSON.stringify(results.map((r) => r.status)));
    assert(results.filter((r) => r.status !== 200).every((r) => r.status === 409), 'every loser should get 409, got ' + JSON.stringify(results.map((r) => r.status)));
    const claimedRevocations = JSON.parse(fs.readFileSync(REVOCATIONS, 'utf8')).revoked.filter((r) => r.reason === 'file-claimed' && r.id === file3.id);
    assert(claimedRevocations.length === 1, 'expected one file-claimed revocation for the file, got ' + claimedRevocations.length);
    console.log('PASS: 1 winner, 7 refused');

    console.log('STEP 7: simultaneous exports of one credential, one file (three rounds of twelve)');
    let file4 = null;
    for (let round = 1; round <= 3; round++) {
      const ringN = await mint(alice, RING);
      const before = bearerCount();
      const exports = await Promise.all(Array.from({ length: 12 }, () => exportToFile(alice, ringN)));
      const okExports = exports.filter((r) => r.status === 200);
      assert(okExports.length === 1, 'round ' + round + ': expected exactly one export to succeed, got ' + okExports.length + ': ' + JSON.stringify(exports.map((r) => r.status)));
      assert(bearerCount() === before + 1, 'round ' + round + ': expected exactly one new registered file, got ' + (bearerCount() - before));
      file4 = okExports[0].body.file;
    }
    console.log('PASS: each round produced 1 file and 11 refusals');

    console.log('STEP 8: malformed claims are refused');
    const wrongSigner = { credentialId: file4.id, newOwnerPublicKey: bob.publicKey, action: 'claim-from-file' };
    const r1 = await post('/atlas/asset/claim-from-file', { credential: file4, intent: { payload: wrongSigner, proof: await proofFor(mallory, wrongSigner) } });
    assert(r1.status === 400, 'a claim signed by a key other than the new owner must be refused, got ' + r1.status);
    const r2 = await claim(bob, { ...file4, asset: { ...file4.asset, name: 'Forged Ring' } });
    assert(r2.status === 400, 'a tampered file must be refused, got ' + r2.status);
    const r3 = await claim(bob, { ...file4, issuer: { ...file4.issuer, domain: 'other.example.com' } });
    assert(r3.status === 400 && r3.body.code === 'wrong-domain', 'another domain\'s credential must be refused, got ' + JSON.stringify(r3));
    assert((await get('/atlas/asset/file-status?id=' + encodeURIComponent(file4.id))).body.claimable === true, 'refused claims must leave the file claimable');
    console.log('PASS: wrong signer, tampered file and foreign domain refused; file still claimable');

    console.log('STEP 9: the exporter can claim their own file back, then export it again');
    const back = await claim(alice, file4);
    assert(back.status === 200 && back.body.credential.owner.publicKey === alice.publicKey, 'claim-back failed: ' + JSON.stringify(back));
    const reExport = await exportToFile(alice, back.body.credential);
    assert(reExport.status === 200, 'the reclaimed credential should be exportable again, got ' + JSON.stringify(reExport));
    console.log('PASS: reclaimed credential is an ordinary owned credential');

    console.log('\nALL ASSET FILE TRANSFER CHECKS PASSED (' + BACKEND + ')');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    serverProc.kill();
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (err) {}
    process.exit(process.exitCode || 0);
  }
})();
