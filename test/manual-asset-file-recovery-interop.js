// Manual check that issuer-server (Node) and issuer-php read and finish each
// other's file export records (SPEC.md §13.5.1). Both keep the same three
// files for an export (the export store, the bearer registry, the public
// revocation list); an operator moving a domain from one backend to the
// other, or a bug in one writer, must not strand an export.
//
//   node test/manual-asset-file-recovery-interop.js
//
// For each stop point in an export, on each backend in turn: the source
// issuer is stopped dead at that step; its three state files are copied into
// the other issuer; that issuer reconciles the record through the recovery
// endpoint and returns the same file; its resulting files are copied back to
// the source, which then also returns that file and lets it be claimed (only
// the issuer that signed a file can claim it). A claimed receipt written by
// one backend is also read by the other.
//
// The claim records (SPEC.md §13.5.2) get the same treatment: the source is
// stopped dead at each step of a claim after the commit point; the other
// issuer finishes the half-finished claim through the export recovery
// endpoint; the state is copied back and the claimer's repeat claim at the
// source returns the stored credential byte for byte.
//
// Not part of the permanent suite, same reasoning as the other manual-*.js
// scripts.

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const REPO = path.resolve(__dirname, '..');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-recovery-interop-'));
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

function makeSide(name, port) {
  const root = path.join(TMP_ROOT, name);
  const isPhp = name === 'php';
  const docroot = isPhp ? path.join(root, 'domain') : path.join(root, 'docroot');
  const stateDir = isPhp ? path.join(docroot, 'lib') : path.join(root, 'state');
  fs.mkdirSync(root, { recursive: true });
  if (isPhp) {
    fs.cpSync(path.join(REPO, 'issuer-php'), docroot, { recursive: true });
    fs.mkdirSync(path.join(docroot, '.well-known'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'demo-domain-a', '.well-known', 'spatial.json'), path.join(docroot, '.well-known', 'spatial.json'));
  } else {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.cpSync(path.join(REPO, 'demo-domain-a'), docroot, { recursive: true });
  }
  const manifest = path.join(docroot, '.well-known', 'spatial.json');
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  m.fileTransfer = { classes: [RING] };
  fs.writeFileSync(manifest, JSON.stringify(m, null, 2));

  const side = {
    name, port, base: 'http://localhost:' + port, proc: null,
    files: {
      exports: path.join(stateDir, 'atlas-file-exports-store.json'),
      bearers: path.join(stateDir, 'atlas-bearer-store.json'),
      revocations: path.join(docroot, '.well-known', 'atlas-revocations.json'),
      claims: path.join(stateDir, 'atlas-file-claims-store.json')
    },
    start(extraEnv) {
      return new Promise((resolve, reject) => {
        let proc;
        if (isPhp) {
          proc = spawn('php', ['-S', 'localhost:' + port, 'test-router.php'], {
            cwd: docroot, detached: true, env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4', ...(extraEnv || {}) }, stdio: ['ignore', 'pipe', 'pipe']
          });
          const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
          proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); side.proc = proc; resolve(); } });
        } else {
          proc = spawn('node', ['issuer-server/server.js'], {
            cwd: REPO, detached: true,
            env: { ...process.env, PORT: String(port), ATLAS_DOMAIN: 'localhost:' + port, ATLAS_STATE_DIR: stateDir, ATLAS_DOCROOT: docroot, ...(extraEnv || {}) },
            stdio: ['ignore', 'pipe', 'pipe']
          });
          const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
          proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); side.proc = proc; resolve(); } });
        }
        proc.on('exit', () => { if (side.proc === proc) side.proc = null; });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (!side.proc) return resolve();
        const proc = side.proc;
        proc.once('exit', () => setTimeout(resolve, 50));
        try { process.kill(-proc.pid, 'SIGKILL'); } catch (err) { proc.kill('SIGKILL'); }
      });
    },
    async restart(extraEnv) { await side.stop(); await side.start(extraEnv); },
    async post(urlPath, body) {
      const res = await fetch(side.base + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const text = await res.text();
      let parsed = {};
      try { parsed = JSON.parse(text); } catch (err) { /* leave empty */ }
      return { status: res.status, body: parsed, text };
    },
    async mint(owner) {
      const r = await side.post('/atlas/asset/issue', { ownerPublicKey: owner.publicKey, assetClass: RING });
      assert(r.status === 200, side.name + ': mint failed ' + r.text);
      return r.body;
    },
    async exportCutOff(identity, credential) {
      const payload = { credentialId: credential.id, action: 'transfer-to-file' };
      try {
        const r = await side.post('/atlas/asset/transfer-to-file', { credential, intent: { payload, proof: await proofFor(identity, payload) } });
        return !(r.status === 200 && r.body && r.body.file);
      } catch (err) {
        return true;
      }
    },
    async recover(identity, credentialId) {
      const ch = await side.post('/atlas/asset/recover-file-export-challenge', { credentialId });
      const payload = { credentialId, action: 'recover-file-export', challenge: ch.body.challenge };
      return side.post('/atlas/asset/recover-file-export', { intent: { payload, proof: await proofFor(identity, payload) } });
    },
    async claim(identity, credential) {
      const payload = { credentialId: credential.id, newOwnerPublicKey: identity.publicKey, action: 'claim-from-file' };
      return side.post('/atlas/asset/claim-from-file', { credential, intent: { payload, proof: await proofFor(identity, payload) } });
    }
  };
  return side;
}
function copyState(from, to) {
  for (const key of Object.keys(from.files)) {
    if (fs.existsSync(from.files[key])) fs.copyFileSync(from.files[key], to.files[key]);
    else fs.rmSync(to.files[key], { force: true });
  }
}
function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

(async () => {
  const node = makeSide('node', 8235);
  const php = makeSide('php', 8236);
  await node.start();
  await php.start();
  try {
    const alice = await genIdentity();
    const bob = await genIdentity();
    const points = [
      ['export:prepared', 'prepared'],
      ['export:original-revoked-fact', 'prepared'],
      ['export:original-revoked', 'original-revoked'],
      ['export:bearer-registered', 'original-revoked'],
      ['export:pending', 'pending']
    ];
    for (const [source, target] of [[node, php], [php, node]]) {
      console.log('STEP: records written by ' + source.name + ' are finished by ' + target.name + ' and back');
      for (const [point, expectedState] of points) {
        const ring = await source.mint(alice);
        await source.restart({ ATLAS_TEST_CRASH_AT: point });
        assert(await source.exportCutOff(alice, ring), point + ': the export should have been cut off');
        await source.stop();
        const written = readJson(source.files.exports, { exports: {} }).exports[ring.id];
        assert(written && written.state === expectedState, source.name + ' wrote the wrong state at ' + point + ': ' + (written && written.state));

        copyState(source, target);
        await target.restart();
        const viaTarget = await target.recover(alice, ring.id);
        assert(viaTarget.status === 200 && viaTarget.body.status === 'pending', point + ': ' + target.name + ' should finish ' + source.name + '\'s record, got ' + viaTarget.text);
        assert(canonicalize(viaTarget.body.file) === canonicalize(written.file), point + ': ' + target.name + ' must return exactly the file ' + source.name + ' minted');
        const afterTarget = readJson(target.files.exports, { exports: {} }).exports[ring.id];
        assert(afterTarget.state === 'pending' && afterTarget.exportId === written.exportId, point + ': unexpected record after ' + target.name + ': ' + JSON.stringify(afterTarget && afterTarget.state));
        assert(readJson(target.files.revocations, { revoked: [] }).revoked.some((r) => r.id === ring.id && r.reason === 'file-transferred'), point + ': the original should be revoked');
        assert(Object.prototype.hasOwnProperty.call(readJson(target.files.bearers, { bearers: {} }).bearers, written.fileId), point + ': the file should be listed');

        copyState(target, source);
        await source.restart();
        const backAtSource = await source.recover(alice, ring.id);
        assert(backAtSource.status === 200 && canonicalize(backAtSource.body.file) === canonicalize(written.file), point + ': ' + source.name + ' should return the same file after ' + target.name + ' touched the record, got ' + backAtSource.text);
        const claimed = await source.claim(bob, backAtSource.body.file);
        assert(claimed.status === 200, point + ': the file should be claimable at ' + source.name + ', got ' + claimed.text);
        console.log('  PASS: ' + source.name + ' stopped at ' + point + ' -> ' + target.name + ' finished it -> ' + source.name + ' claimed it');
      }

      console.log('STEP: claim records written by ' + source.name + ' are finished by ' + target.name + ' and back');
      for (const point of ['claim:committed', 'claim:bearer-taken', 'claim:revoked', 'claim:claimed']) {
        const ring = await source.mint(alice);
        await source.restart();
        const exportPayload = { credentialId: ring.id, action: 'transfer-to-file' };
        const exp = await source.post('/atlas/asset/transfer-to-file', { credential: ring, intent: { payload: exportPayload, proof: await proofFor(alice, exportPayload) } });
        assert(exp.status === 200 && exp.body.file, point + ': export failed ' + exp.text);
        const file = exp.body.file;
        await source.restart({ ATLAS_TEST_CRASH_AT: point });
        let cut = true;
        try { const r = await source.claim(bob, file); cut = !(r.status === 200 && r.body.credential); } catch (err) { cut = true; }
        assert(cut, point + ': the claim should have been cut off');
        await source.stop();
        const record = readJson(source.files.claims, { claims: {} }).claims[file.id];
        assert(record && record.minted && record.claimantPublicKey === bob.publicKey, source.name + ' should have committed a claim record by ' + point);
        const expectedState = point === 'claim:claimed' ? 'claimed' : 'committed';
        assert(record.state === expectedState, source.name + ' wrote state ' + record.state + ' at ' + point);

        copyState(source, target);
        await target.restart();
        const seen = await target.recover(alice, ring.id);
        assert(seen.status === 409 && seen.body.code === 'already-claimed', point + ': ' + target.name + ' should report the file claimed, got ' + seen.text);
        const finished = readJson(target.files.claims, { claims: {} }).claims[file.id];
        assert(finished && finished.state === 'claimed' && finished.claimId === record.claimId && finished.mintedId === record.mintedId, point + ': ' + target.name + ' should have finished the record');
        assert(canonicalize(finished.minted) === canonicalize(record.minted), point + ': ' + target.name + ' must keep the stored credential unchanged');
        assert(!Object.prototype.hasOwnProperty.call(readJson(target.files.bearers, { bearers: {} }).bearers, file.id), point + ': the file should be out of the registry');
        assert(readJson(target.files.revocations, { revoked: [] }).revoked.some((r) => r.id === file.id), point + ': the file should be revoked');

        copyState(target, source);
        await source.restart();
        const again = await source.claim(bob, file);
        assert(again.status === 200 && canonicalize(again.body.credential) === canonicalize(record.minted), point + ': the claimer should get the stored credential back at ' + source.name + ', got ' + again.text);
        const stranger = await source.claim(alice, file);
        assert(stranger.status === 409 && !stranger.text.includes(record.mintedId), point + ': another key must be refused with nothing disclosed');
        console.log('  PASS: ' + source.name + ' stopped at ' + point + ' -> ' + target.name + ' finished it -> ' + source.name + ' returned the same credential');
      }

      // A receipt written by the source (after a claim) is read by the target.
      const ring = await source.mint(alice);
      await source.restart();
      const exported = await source.post('/atlas/asset/transfer-to-file', await (async () => {
        const payload = { credentialId: ring.id, action: 'transfer-to-file' };
        return { credential: ring, intent: { payload, proof: await proofFor(alice, payload) } };
      })());
      assert(exported.status === 200, 'export failed: ' + exported.text);
      assert((await source.claim(bob, exported.body.file)).status === 200, 'claim failed');
      const receipt = readJson(source.files.exports, { exports: {} }).exports[ring.id];
      assert(receipt.state === 'claimed' && receipt.file === undefined && receipt.original === undefined && receipt.claimCredentialId, source.name + ' should have written a compact claimed receipt');
      await source.stop();
      copyState(source, target);
      await target.restart();
      const seen = await target.recover(alice, ring.id);
      assert(seen.status === 409 && seen.body.code === 'already-claimed' && seen.body.receipt.exportId === receipt.exportId, target.name + ' should read ' + source.name + '\'s receipt, got ' + seen.text);
      console.log('  PASS: ' + source.name + '\'s claimed receipt read by ' + target.name);
    }
    console.log('\nALL FILE EXPORT RECOVERY INTEROP CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await node.stop();
    await php.stop();
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (err) { /* ignore */ }
    process.exit(process.exitCode || 0);
  }
})();
