// Manual end-to-end check for task #42 — serialized + limited-edition
// asset support. Two new catalog-level flags (ASSET_CATALOG's
// `serialized`/`maxSupply`, only ever consulted by mintAssetByClass()
// when supersedes === null, i.e. a genuinely new mint — see
// issuer-server/server.js's comment above SERIAL_COUNTERS_FILE for the
// full "why split/consolidate/trade can never double-count" reasoning)
// and two new conventionally-reserved `atlas.*` property keys
// (`atlas.serial`, `atlas.editionSize` — SPEC.md §5.1) are the entire
// feature; no schema/protocol change was needed. Demo class:
// atlas.wearable.ring (`serialized: true, maxSupply: 20` — raised from the
// original 5 alongside making the ring tradeable at the Trading Station,
// see issuer-server/server.js's own comment on the catalog entry).
//
// This hits the issuer's HTTP API directly (no browser/extension needed —
// serial/cap tracking is entirely server-side), the same way the PHP side
// of this feature gets independently verified via curl, so both ports are
// exercised through the same request shapes. Note this test EXHAUSTS the
// ring's entire remaining supply on whichever server it runs against (it
// mints all the way to the cap on purpose, to prove the boundary) — always
// run it against a freshly-reset atlas-serial-counters.json, same as any
// other manual-*.js script that depends on clean starting state.
//
// Checks:
//   1. Minting the ring twenty times in a row produces atlas.serial "1"
//      through "20", each carrying atlas.editionSize "20".
//   2. A 21st mint is rejected with HTTP 400 and a clear "sold out" message
//      — and does NOT advance the counter (a 22nd attempt fails the same
//      way, proving the rejected attempt was never reserved).
//   3. Reissuing one of the twenty (a legitimate, unrelated property
//      update — SPEC.md §5.1.1) does NOT touch its atlas.serial/
//      atlas.editionSize: reissue patches the existing asset.properties bag
//      in place rather than re-minting, so the serial fields simply pass
//      through untouched.
//   4. A fungible, non-serialized, non-capped class (atlas.element.iron)
//      is completely unaffected — no atlas.serial/atlas.editionSize
//      appears on it, and it can be minted well past 20 units, proving the
//      cap/serial logic is scoped to opted-in classes only, not global.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const http = require('http');
const path = require('path');
const fs = require('fs');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const ADMIN_KEYS_FILE = path.resolve(__dirname, '..', 'issuer-server', 'atlas-admin-keys-store.json');

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Same canonicalize() shape as extension/wallet.js and issuer-server/
// server.js's own crypto helpers — sorted-key JSON, no whitespace.
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

// Mirrors extension/wallet.js's signWithSelf() — a raw-ecdsa self-signed
// envelope, the same one verifyEnvelope() on the server checks.
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}

// /atlas/asset/reissue now requires a registered domain admin's signature
// (requireAdmin(), issuer-server/server.js) — seeds one directly into the
// admin roster file, the same "plain operator-edited JSON" bootstrap a
// real domain operator would do by hand.
function seedAdmin(publicKey) {
  fs.writeFileSync(ADMIN_KEYS_FILE, JSON.stringify({ keys: [{ publicKey, addedAt: new Date().toISOString() }] }, null, 2));
}

function postJson(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: 'localhost', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); } catch (err) { reject(err); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const OWNER = 'test-owner-public-key-serialized-assets-demo';

(async () => {
  try {
    console.log('STEP 1: minting the ring twenty times in a row');
    const held = [];
    for (let i = 1; i <= 20; i++) {
      const { status, body } = await postJson(8001, '/atlas/asset/issue', { ownerPublicKey: OWNER, assetClass: 'atlas.wearable.ring' });
      if (status !== 200) throw new Error(`Mint #${i} expected 200, got ${status}: ${JSON.stringify(body)}`);
      const serial = body.asset.properties['atlas.serial'];
      const editionSize = body.asset.properties['atlas.editionSize'];
      if (serial !== String(i)) throw new Error(`Mint #${i} expected atlas.serial "${i}", got ${JSON.stringify(serial)}`);
      if (editionSize !== '20') throw new Error(`Mint #${i} expected atlas.editionSize "20", got ${JSON.stringify(editionSize)}`);
      held.push(body);
      console.log(`  minted ${body.id} -> atlas.serial=${serial} atlas.editionSize=${editionSize}`);
    }
    console.log('PASS: twenty mints produced serials 1..20, each stamped with editionSize 20');

    console.log('STEP 2: a 21st mint is rejected — sold out');
    const sixth = await postJson(8001, '/atlas/asset/issue', { ownerPublicKey: OWNER, assetClass: 'atlas.wearable.ring' });
    if (sixth.status !== 400) throw new Error('Expected 21st mint to be rejected with 400, got: ' + sixth.status);
    if (!/sold out/i.test(sixth.body.error || '')) throw new Error('Expected a "sold out" error message, got: ' + JSON.stringify(sixth.body));
    console.log('  rejected as expected ->', sixth.body.error);
    const seventh = await postJson(8001, '/atlas/asset/issue', { ownerPublicKey: OWNER, assetClass: 'atlas.wearable.ring' });
    if (seventh.status !== 400) throw new Error('Expected 22nd mint to ALSO be rejected (counter must not have advanced on the failed 21st), got: ' + seventh.status);
    console.log('PASS: rejection does not advance the counter — repeatedly sold out, not off-by-one');

    console.log('STEP 3: reissuing one of the twenty leaves its serial/editionSize untouched');
    const target = held[2]; // serial "3"
    const admin = await genIdentity();
    seedAdmin(admin.publicKey);
    const reissuePayload = {
      credential: target,
      properties: { 'com.example.condition': 'slightly tarnished' }
    };
    const reissueProof = await signWithSelf(admin.kp, admin.publicKey, reissuePayload);
    const reissue = await postJson(8001, '/atlas/asset/reissue', { payload: reissuePayload, proof: reissueProof });
    if (reissue.status !== 200) throw new Error('Expected reissue to succeed, got: ' + reissue.status + ' ' + JSON.stringify(reissue.body));
    const newAsset = reissue.body.newCredential.asset;
    if (newAsset.properties['atlas.serial'] !== '3') throw new Error('Expected reissued credential to keep atlas.serial "3", got: ' + newAsset.properties['atlas.serial']);
    if (newAsset.properties['atlas.editionSize'] !== '20') throw new Error('Expected reissued credential to keep atlas.editionSize "20", got: ' + newAsset.properties['atlas.editionSize']);
    if (newAsset.properties['com.example.condition'] !== 'slightly tarnished') throw new Error('Expected the reissue\'s own property patch to also apply');
    console.log('PASS: reissue passed atlas.serial/atlas.editionSize through unchanged while applying its own patch ->', reissue.body.newCredential.id);

    console.log('STEP 4: an ordinary fungible class (atlas.element.iron) is unaffected — no serial, no cap');
    let ironTotal = 0;
    for (let i = 0; i < 3; i++) {
      const { status, body } = await postJson(8001, '/atlas/asset/issue', { ownerPublicKey: OWNER, assetClass: 'atlas.element.iron', quantity: 50 });
      if (status !== 200) throw new Error('Expected iron mint to succeed, got: ' + status + ' ' + JSON.stringify(body));
      if (body.asset.properties && ('atlas.serial' in body.asset.properties)) throw new Error('Iron should never carry atlas.serial — it is not a serialized class');
      ironTotal += body.quantity;
    }
    if (ironTotal !== 150) throw new Error('Expected 150 total iron minted (3 x 50, well past the ring\'s cap of 20), got: ' + ironTotal);
    console.log('PASS: minted 150 units of iron with no serial/cap interference — the feature is opt-in per class, not global');

    console.log('\nALL SERIALIZED/LIMITED-EDITION ASSET CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  }
})();
