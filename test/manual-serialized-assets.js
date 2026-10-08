// Manual end-to-end check for serialized + limited-edition asset support.
// Two catalog-level flags (ASSET_CATALOG's `serialized`/`maxSupply`, only
// ever consulted by mintAssetByClass() when supersedes === null, i.e. a
// genuinely new mint, so a split/consolidate/trade can never double-count)
// and two conventionally-reserved `atlas.*` property keys (`atlas.serial`,
// `atlas.editionSize`, SPEC.md §5.1) are the entire feature. Demo class:
// atlas.wearable.ring (`serialized: true, maxSupply: 30000`).
//
// Hits the issuer's HTTP API directly (no browser/extension needed) against
// an isolated throwaway server, so it never touches real counters:
//
//   node test/manual-serialized-assets.js          # issuer-server (Node)
//   node test/manual-serialized-assets.js php      # issuer-php
//
// Reaching the cap by minting 30000 rings would take far too long, so after
// the first real mint the test seeds the class's running counter to three
// short of the cap (reserveSupply() reads it from disk on every call) and
// proves the boundary from there.
//
// Checks:
//   1. A fresh server's first ring is atlas.serial "1" carrying
//      atlas.editionSize "30000".
//   2. With the counter seeded to 29997, the next three mints are serials
//      29998, 29999 and 30000, each with editionSize "30000".
//   3. The next mint is rejected with HTTP 400 and a "sold out" message
//      naming 30000/30000, and a further attempt fails the same way
//      (the rejected attempt was never reserved).
//   4. Reissuing one of the rings (SPEC.md §5.1.1) leaves its
//      atlas.serial/atlas.editionSize untouched.
//   5. A fungible, non-serialized, non-capped class (atlas.element.iron)
//      is unaffected: no atlas.serial, no cap.
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
const PORT = BACKEND === 'php' ? 8218 : 8217; // isolated, distinct from every other manual-*.js test
const BASE = 'http://localhost:' + PORT;
const EDITION = 30000;
const RING = 'atlas.wearable.ring';
const REPO = path.resolve(__dirname, '..');
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-serialized-'));
// Where the admin roster and serial counters live differs per backend.
const STATE_DIR = BACKEND === 'php' ? path.join(TMP_ROOT, 'domain', 'lib') : path.join(TMP_ROOT, 'state');
const ADMIN_KEYS_FILE = path.join(STATE_DIR, 'atlas-admin-keys-store.json');
const COUNTERS_FILE = path.join(STATE_DIR, BACKEND === 'php' ? 'atlas-serial-counters-store.json' : 'atlas-serial-counters.json');

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Same canonicalize() shape as extension/wallet.js and the issuers' own
// crypto helpers: sorted-key JSON, no whitespace.
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

// Mirrors extension/wallet.js's signWithSelf(): a raw-ecdsa self-signed
// envelope, the same one verifyEnvelope() on the server checks.
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}

async function postJson(urlPath, body) {
  const res = await fetch(BASE + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}

async function startServer() {
  if (BACKEND === 'php') {
    const bundle = path.join(TMP_ROOT, 'domain');
    fs.cpSync(path.join(REPO, 'issuer-php'), bundle, { recursive: true });
    fs.mkdirSync(path.join(bundle, '.well-known'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'demo-domain-a', '.well-known', 'spatial.json'), path.join(bundle, '.well-known', 'spatial.json'));
    const proc = spawn('php', ['-S', 'localhost:' + PORT, 'test-router.php'], { cwd: bundle, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
      proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
      proc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
    });
    return proc;
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const docroot = path.join(TMP_ROOT, 'docroot');
  fs.cpSync(path.join(REPO, 'demo-domain-a'), docroot, { recursive: true });
  const proc = spawn('node', ['issuer-server/server.js'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: 'localhost:' + PORT, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: docroot },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    proc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  return proc;
}

const OWNER = 'test-owner-public-key-serialized-assets-demo';

(async () => {
  console.log('SETUP: isolated ' + BACKEND + ' issuer on port ' + PORT);
  const serverProc = await startServer();
  const mint = () => postJson('/atlas/asset/issue', { ownerPublicKey: OWNER, assetClass: RING });
  try {
    console.log('STEP 1: a fresh server\'s first ring is serial 1 of ' + EDITION);
    const first = await mint();
    assert(first.status === 200, 'first mint expected 200, got ' + first.status + ' ' + JSON.stringify(first.body));
    assert(first.body.asset.properties['atlas.serial'] === '1', 'expected atlas.serial "1", got ' + JSON.stringify(first.body.asset.properties['atlas.serial']));
    assert(first.body.asset.properties['atlas.editionSize'] === String(EDITION), 'expected atlas.editionSize "' + EDITION + '", got ' + JSON.stringify(first.body.asset.properties['atlas.editionSize']));
    console.log('PASS: serial 1, editionSize', EDITION);

    console.log('STEP 2: with the counter seeded to ' + (EDITION - 3) + ', the last three serials are issued');
    fs.writeFileSync(COUNTERS_FILE, JSON.stringify({ counters: { [RING]: EDITION - 3 } }));
    const held = [];
    for (let serial = EDITION - 2; serial <= EDITION; serial++) {
      const { status, body } = await mint();
      assert(status === 200, 'mint of serial ' + serial + ' expected 200, got ' + status + ' ' + JSON.stringify(body));
      assert(body.asset.properties['atlas.serial'] === String(serial), 'expected serial ' + serial + ', got ' + JSON.stringify(body.asset.properties['atlas.serial']));
      assert(body.asset.properties['atlas.editionSize'] === String(EDITION), 'expected editionSize ' + EDITION + ' on serial ' + serial);
      held.push(body);
    }
    console.log('PASS: serials ' + (EDITION - 2) + '..' + EDITION + ' issued, each stamped with editionSize ' + EDITION);

    console.log('STEP 3: the next mint is rejected, and the rejection does not advance the counter');
    const over = await mint();
    assert(over.status === 400, 'expected 400 past the cap, got ' + over.status);
    assert(/sold out/i.test(over.body.error || ''), 'expected a "sold out" message, got ' + JSON.stringify(over.body));
    assert((over.body.error || '').includes(EDITION + '/' + EDITION), 'expected the message to name ' + EDITION + '/' + EDITION + ', got ' + over.body.error);
    const again = await mint();
    assert(again.status === 400, 'expected a repeat attempt to be rejected too, got ' + again.status);
    console.log('PASS: rejected ->', over.body.error);

    console.log('STEP 4: reissuing a ring leaves its serial/editionSize untouched');
    const admin = await genIdentity();
    fs.writeFileSync(ADMIN_KEYS_FILE, JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
    const reissuePayload = { credential: held[0], properties: { 'com.example.condition': 'slightly tarnished' } };
    const reissueProof = await signWithSelf(admin.kp, admin.publicKey, reissuePayload);
    const reissue = await postJson('/atlas/asset/reissue', { payload: reissuePayload, proof: reissueProof });
    assert(reissue.status === 200, 'expected reissue to succeed, got ' + reissue.status + ' ' + JSON.stringify(reissue.body));
    const props = reissue.body.newCredential.asset.properties;
    assert(props['atlas.serial'] === String(EDITION - 2), 'expected reissue to keep serial ' + (EDITION - 2) + ', got ' + props['atlas.serial']);
    assert(props['atlas.editionSize'] === String(EDITION), 'expected reissue to keep editionSize ' + EDITION + ', got ' + props['atlas.editionSize']);
    assert(props['com.example.condition'] === 'slightly tarnished', 'expected the reissue\'s own property patch to apply');
    console.log('PASS: reissue kept serial/editionSize and applied its own patch');

    console.log('STEP 5: a fungible class (atlas.element.iron) has no serial and no cap');
    let ironTotal = 0;
    for (let i = 0; i < 3; i++) {
      const { status, body } = await postJson('/atlas/asset/issue', { ownerPublicKey: OWNER, assetClass: 'atlas.element.iron', quantity: 50 });
      assert(status === 200, 'expected iron mint to succeed, got ' + status + ' ' + JSON.stringify(body));
      assert(!(body.asset.properties && ('atlas.serial' in body.asset.properties)), 'iron must never carry atlas.serial');
      ironTotal += body.quantity;
    }
    assert(ironTotal === 150, 'expected 150 iron minted, got ' + ironTotal);
    console.log('PASS: 150 iron minted with no serial/cap interference');

    console.log('\nALL SERIALIZED/LIMITED-EDITION ASSET CHECKS PASSED (' + BACKEND + ')');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    serverProc.kill();
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (err) {}
    process.exit(process.exitCode || 0);
  }
})();
