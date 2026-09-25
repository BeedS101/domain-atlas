// Manual check for a follow-up to the reissue endpoint: POST
// /atlas/asset/reissue gained the ability to patch a non-fungible
// credential's `tradeScope`, not just its `properties` (see
// issuer-server/server.js's own comment on this route, and README.md's
// "Fixing a stale tradeScope on an already-issued credential" section for
// the operator-facing story this exists to serve).
//
// Why this needed building at all: tradeScope is baked into a credential's
// signed payload at mint time (mintAssetByClass's
// `catalogEntry.tradeScope || 'local'`), so tightening a catalog entry to
// tradeScope: 'bound' — as this project has now done twice, for
// atlas.badge/atlas.trinket.pin/atlas.trinket.charm and then
// atlas.wearable — never retroactively changes a credential of that class
// minted before the catalog said so. AtlasWallet.reverifyAll() only
// re-checks signatures, never re-derives asset fields, and until this
// change reissue could only patch `properties`, leaving no way at all to
// bring a stale credential's tradeScope in line short of discarding it.
//
// Run at the HTTP layer directly against BOTH backends, same "own isolated
// instance, no shared mutable state" reasoning manual-trading-catalog.js
// already uses for this same reason (nothing here needs the shared
// localhost:8001/:8002 instances, and every reason not to share them —
// this test revokes credentials, which would pollute anything else running
// against the same store).
//
// Uses atlas.trophy.chess as the "ordinary non-fungible, tradeScope: local
// by default" stand-in for a credential minted before some future
// tightening — not because chess trophies are expected to ever become
// bound, just because it's a convenient, already-existing non-fungible
// class nothing else in this test touches.
//
// Checks:
//   1. Node — reissuing with only `tradeScope: 'bound'` (no properties)
//      patches tradeScope and leaves existing properties untouched.
//   2. Node — reissuing the (now-bound) credential further with only
//      `properties` leaves the just-patched tradeScope alone — the two
//      patches are independent, neither clobbers the other.
//   3. Node — an invalid tradeScope value ('nonsense') is rejected with a
//      clear 400, nothing reissued.
//   4. Node — a request with neither `properties` nor `tradeScope` is
//      rejected with a clear 400.
//   5. Node — a fungible class (atlas.element.iron) cannot have its
//      tradeScope patched this way either, same restriction `properties`
//      patching already has.
//   6. PHP — the same tradeScope-patch behavior (steps 1 and 3) on an
//      independent issuer-php bundle, off its own ATLAS_ASSET_CATALOG.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const NODE_PORT = 8105; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const PHP_PORT = 8106;
const PHP_BASE = 'http://localhost:' + PHP_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-reissue-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-reissue-docroot-'));
const PHP_BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-reissue-php-'));

const OWNER = 'test-owner-public-key-reissue-tradescope-demo';

function postJson(base, urlPath, body) {
  return fetch(base + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

async function issueAsset(base, ownerPublicKey, assetClass, quantity) {
  const res = await postJson(base, '/atlas/asset/issue', { ownerPublicKey, assetClass, quantity });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ' at ' + base + ': ' + JSON.stringify(res.body));
  return res.body;
}

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
// envelope, the same one verifyEnvelope()/verify_envelope() checks on
// either backend.
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}

// /atlas/asset/reissue now requires a registered domain admin's signature
// on both backends (requireAdmin() / require_admin()) — one identity is
// seeded into each isolated instance's own admin roster file below, the
// same "plain operator-edited JSON" bootstrap a real domain operator would
// do by hand.
async function reissueAsAdmin(base, admin, payload) {
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  return postJson(base, '/atlas/asset/reissue', { payload, proof });
}

(async () => {
  console.log('SETUP: starting an isolated issuer-server instance on port ' + NODE_PORT);
  const nodeProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(NODE_PORT),
      ATLAS_DOMAIN: NODE_DOMAIN,
      ATLAS_STATE_DIR: NODE_STATE_DIR,
      ATLAS_DOCROOT: NODE_DOCROOT_DIR
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    nodeProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    nodeProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-server up on port ' + NODE_PORT);

  console.log('SETUP: copying issuer-php into an isolated bundle dir and starting its own dev server on port ' + PHP_PORT);
  fs.cpSync(path.resolve(__dirname, '..', 'issuer-php'), PHP_BUNDLE_DIR, { recursive: true });
  const phpProc = spawn('php', ['-S', 'localhost:' + PHP_PORT, 'test-router.php'], { cwd: PHP_BUNDLE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
    phpProc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
    phpProc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
  });
  console.log('PASS: isolated issuer-php dev server up on port ' + PHP_PORT);

  const NODE_BASE = 'http://localhost:' + NODE_PORT;

  console.log('SETUP: seeding one admin identity into both isolated instances\' own admin rosters');
  const admin = await genIdentity();
  fs.writeFileSync(path.join(NODE_STATE_DIR, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
  fs.writeFileSync(path.join(PHP_BUNDLE_DIR, 'lib', 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
  console.log('PASS: admin identity seeded into both rosters');

  try {
    console.log('STEP 1: Node — reissuing with only tradeScope patches it, leaving existing properties untouched');
    const trophy = await issueAsset(NODE_BASE, OWNER, 'atlas.trophy.chess', 1);
    if (trophy.asset.tradeScope !== undefined && trophy.asset.tradeScope !== 'local') {
      throw new Error('Expected a freshly-minted trophy to start tradeScope-unset/local, got: ' + JSON.stringify(trophy.asset.tradeScope));
    }
    const originalAwardedFor = trophy.asset.properties['com.example.awardedFor'];
    const bound = await reissueAsAdmin(NODE_BASE, admin, { credential: trophy, tradeScope: 'bound' });
    if (bound.status !== 200) throw new Error('Expected the tradeScope-only reissue to succeed, got: ' + bound.status + ' ' + JSON.stringify(bound.body));
    const boundAsset = bound.body.newCredential.asset;
    if (boundAsset.tradeScope !== 'bound') throw new Error('Expected the reissued credential to carry tradeScope "bound", got: ' + JSON.stringify(boundAsset.tradeScope));
    if (boundAsset.properties['com.example.awardedFor'] !== originalAwardedFor) throw new Error('Expected the tradeScope-only patch to leave existing properties untouched');
    console.log('PASS: tradeScope patched to "bound" via reissue, properties carried through unchanged ->', bound.body.newCredential.id);

    console.log('STEP 2: Node — reissuing the now-bound credential further with only properties leaves its tradeScope alone');
    const rePropped = await reissueAsAdmin(NODE_BASE, admin, { credential: bound.body.newCredential, properties: { 'com.example.awardedFor': 'Reissue-tradeScope test' } });
    if (rePropped.status !== 200) throw new Error('Expected the properties-only reissue to succeed, got: ' + rePropped.status + ' ' + JSON.stringify(rePropped.body));
    const repropAsset = rePropped.body.newCredential.asset;
    if (repropAsset.tradeScope !== 'bound') throw new Error('Expected tradeScope to remain "bound" after a properties-only reissue, got: ' + JSON.stringify(repropAsset.tradeScope));
    if (repropAsset.properties['com.example.awardedFor'] !== 'Reissue-tradeScope test') throw new Error('Expected the properties-only patch to actually apply');
    console.log('PASS: a later properties-only reissue left the already-patched tradeScope alone — the two patches are independent');

    console.log('STEP 3: Node — an invalid tradeScope value is rejected, nothing reissued');
    const anotherTrophy = await issueAsset(NODE_BASE, OWNER, 'atlas.trophy.chess', 1);
    const badScope = await reissueAsAdmin(NODE_BASE, admin, { credential: anotherTrophy, tradeScope: 'nonsense' });
    if (badScope.status !== 400 || !/local.*bound|bound.*local/i.test(badScope.body.error || '')) {
      throw new Error('Expected a clear 400 naming the valid tradeScope values, got: ' + JSON.stringify(badScope));
    }
    console.log('PASS: invalid tradeScope rejected ->', badScope.body.error);

    console.log('STEP 4: Node — neither properties nor tradeScope given is rejected');
    const neither = await reissueAsAdmin(NODE_BASE, admin, { credential: anotherTrophy });
    if (neither.status !== 400) throw new Error('Expected a 400 when neither properties nor tradeScope is given, got: ' + neither.status + ' ' + JSON.stringify(neither.body));
    console.log('PASS: reissue with no patch at all rejected ->', neither.body.error);

    console.log('STEP 5: Node — a fungible class cannot have its tradeScope patched either');
    const iron = await issueAsset(NODE_BASE, OWNER, 'atlas.element.iron', 10);
    const fungibleAttempt = await reissueAsAdmin(NODE_BASE, admin, { credential: iron, tradeScope: 'bound' });
    if (fungibleAttempt.status !== 400 || !/non-fungible/i.test(fungibleAttempt.body.error || '')) {
      throw new Error('Expected a fungible-rejection 400, got: ' + JSON.stringify(fungibleAttempt));
    }
    console.log('PASS: fungible credential rejected for a tradeScope patch, same as it already is for properties ->', fungibleAttempt.body.error);

    console.log('STEP 6: PHP — the same tradeScope-patch behavior on an independent issuer-php bundle');
    const phpTrophy = await issueAsset(PHP_BASE, OWNER, 'atlas.trophy.chess', 1);
    const phpBound = await reissueAsAdmin(PHP_BASE, admin, { credential: phpTrophy, tradeScope: 'bound' });
    if (phpBound.status !== 200) throw new Error('Expected PHP tradeScope-only reissue to succeed, got: ' + phpBound.status + ' ' + JSON.stringify(phpBound.body));
    if (phpBound.body.newCredential.asset.tradeScope !== 'bound') throw new Error('Expected PHP reissued credential to carry tradeScope "bound", got: ' + JSON.stringify(phpBound.body.newCredential.asset.tradeScope));
    const phpBadScope = await reissueAsAdmin(PHP_BASE, admin, { credential: phpTrophy, tradeScope: 'nonsense' });
    if (phpBadScope.status !== 400) throw new Error('Expected PHP to also reject an invalid tradeScope with 400, got: ' + phpBadScope.status);
    console.log('PASS: PHP matches Node for both the successful tradeScope patch and the invalid-value rejection');

    console.log('\nALL REISSUE TRADESCOPE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    nodeProc.kill();
    phpProc.kill();
    try { fs.rmSync(NODE_STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(NODE_DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(PHP_BUNDLE_DIR, { recursive: true, force: true }); } catch (err) {}
  }
})();
