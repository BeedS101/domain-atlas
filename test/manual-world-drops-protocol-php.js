// Companion to test/manual-world-drops-protocol.js — proves issuer-php's
// own port of task #250 (World Drops, SPEC.md §5.5) behaves the same way
// the Node version does, WITHOUT a full Playwright/browser journey. Same
// "HTTP layer directly + Node's own crypto.webcrypto for real ECDSA P-256
// signing" style as manual-federation-relay-php.js/manual-trade-submit-php.js,
// and same reason this needs TWO independent throwaway copies of
// issuer-php: cross-domain drops are the first PHP world-drops scenario
// where that matters, same as federation was for Post Office.
//
// Checks (mirroring manual-world-drops-protocol.js's own four):
//   1. Same-domain drop + list + claim by a different identity.
//   2. A 'bound' asset (atlas.membership) cannot be dropped.
//   3. Cross-domain: Domain-A-issued item dropped into a world hosted by
//      Domain B — Domain B verifies it against Domain A's own published
//      key (verify_foreign_asset_credential), and claiming it relays the
//      actual mint+revoke back to Domain A.
//   4. Two concurrent claims of the same drop resolve to exactly one
//      winner (remove_world_drop()'s flock-guarded reservation).
//
// Not part of the permanent suite, same reasoning as every other
// manual-*.js script.

const { spawn } = require('child_process');
const { webcrypto } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { subtle } = webcrypto;
const BUNDLE_DIR = path.resolve(__dirname, '..', 'issuer-php');
const PORT_A = 8101; // isolated port, distinct from every other manual-*-php.js test's own port
const PORT_B = 8102;
const DOMAIN_A = 'localhost:' + PORT_A;
const DOMAIN_B = 'localhost:' + PORT_B;
const BASE_A = 'http://' + DOMAIN_A;
const BASE_B = 'http://' + DOMAIN_B;
const WORLD = 'protocol-test-world';
const CROSS_WORLD = 'protocol-test-world-crossdomain';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

async function generateIdentity() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rawPublic = await subtle.exportKey('raw', pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: b64url(rawPublic) };
}

async function signPayload(identity, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, data);
  return { signerRole: 'raw-ecdsa', publicKey: identity.publicKey, signature: b64url(sig) };
}

function post(base, urlPath, body) {
  return fetch(base + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

function get(base, urlPath) {
  return fetch(base + urlPath).then(async (r) => ({ status: r.status, body: await r.json() }));
}

async function issueAsset(base, ownerPublicKey, assetClass, quantity) {
  const res = await post(base, '/atlas/asset/issue', { ownerPublicKey, assetClass, quantity });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ' at ' + base + ': ' + JSON.stringify(res.body));
  return res.body;
}

async function dropItem(base, identity, credential, world, position) {
  const payload = { action: 'drop', credentialId: credential.id, world, droppedAt: new Date().toISOString() };
  const proof = await signPayload(identity, payload);
  return post(base, '/atlas/world/drop', { credential, world, position, intent: { payload, proof } });
}

async function claimDrop(base, identity, dropId) {
  const payload = { action: 'claim', dropId, claimedAt: new Date().toISOString() };
  const proof = await signPayload(identity, payload);
  return post(base, '/atlas/world/drops/claim', { dropId, intent: { payload, proof } });
}

function startPhpServer(bundleDir, port) {
  // PHP_CLI_SERVER_WORKERS=4 — same reasoning as manual-federation-relay-php.js:
  // a cross-domain claim has Domain B's relay-claim call block on reaching
  // Domain A, which in turn blocks fetching Domain B's key back — a real
  // reentrant two-way call that a single-worker dev server can deadlock on.
  const proc = spawn('php', ['-S', 'localhost:' + port, 'test-router.php'], {
    cwd: bundleDir, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { PHP_CLI_SERVER_WORKERS: '4' })
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S on port ' + port + ' did not start in time')), 5000);
    proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(proc); } });
    proc.on('exit', (code) => reject(new Error('php -S on port ' + port + ' exited early with code ' + code)));
  });
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-world-drops-php-'));
  const bundleA = path.join(tmpRoot, 'domain-a');
  const bundleB = path.join(tmpRoot, 'domain-b');
  console.log('SETUP: copying issuer-php into two independent throwaway bundles');
  fs.cpSync(BUNDLE_DIR, bundleA, { recursive: true });
  fs.cpSync(BUNDLE_DIR, bundleB, { recursive: true });

  let procA, procB;
  try {
    [procA, procB] = await Promise.all([startPhpServer(bundleA, PORT_A), startPhpServer(bundleB, PORT_B)]);
    console.log('PASS: PHP dev servers up — Domain A on ' + PORT_A + ', Domain B on ' + PORT_B);

    const alice = await generateIdentity();
    const bob = await generateIdentity();

    console.log('STEP 1: Alice drops a Bronze Compass (same-domain) into a world hosted by Domain A; Bob picks it up');
    const compass = await issueAsset(BASE_A, alice.publicKey, 'atlas.wearable', 1);
    const dropRes = await dropItem(BASE_A, alice, compass, WORLD, [1, 0, 1]);
    if (dropRes.status !== 200 || !dropRes.body.dropId) throw new Error('Expected a successful drop, got: ' + JSON.stringify(dropRes));
    const dropId = dropRes.body.dropId;

    const listRes = await get(BASE_A, '/atlas/world/drops?world=' + encodeURIComponent(WORLD));
    if (listRes.status !== 200 || !listRes.body.drops.some((d) => d.dropId === dropId)) {
      throw new Error('Expected the drop to appear in the shared list, got: ' + JSON.stringify(listRes.body));
    }

    const claimRes = await claimDrop(BASE_A, bob, dropId);
    if (claimRes.status !== 200 || claimRes.body.status !== 'claimed') throw new Error('Expected Bob\'s claim to succeed, got: ' + JSON.stringify(claimRes));
    if (claimRes.body.credential.owner.publicKey !== bob.publicKey) throw new Error('Expected the claimed credential to name Bob as owner');

    const listAfterClaim = await get(BASE_A, '/atlas/world/drops?world=' + encodeURIComponent(WORLD));
    if (listAfterClaim.body.drops.some((d) => d.dropId === dropId)) throw new Error('Expected the drop to be gone from the list after being claimed');
    console.log('PASS: same-domain drop -> shared list -> claim by a different identity works');

    console.log('STEP 2: a bound credential (atlas.membership) cannot be dropped');
    const membership = await issueAsset(BASE_A, alice.publicKey, 'atlas.membership', 1);
    const boundDrop = await dropItem(BASE_A, alice, membership, WORLD, [0, 0, 0]);
    if (boundDrop.status !== 400 || !/bound to its owner/.test(boundDrop.body.error || '')) {
      throw new Error('Expected a bound-asset rejection, got: ' + JSON.stringify(boundDrop));
    }
    console.log('PASS: dropping a bound credential is rejected ->', boundDrop.body.error);

    console.log('STEP 3 (cross-domain): Alice drops a Domain-A-issued compass into a world hosted by Domain B; Bob claims it, relayed back to Domain A');
    const compassA2 = await issueAsset(BASE_A, alice.publicKey, 'atlas.wearable', 1);
    const crossDrop = await dropItem(BASE_B, alice, compassA2, CROSS_WORLD, [2, 0, 2]);
    if (crossDrop.status !== 200 || !crossDrop.body.dropId) {
      throw new Error('Expected Domain B to accept a drop of a Domain-A-issued credential (verify_foreign_asset_credential), got: ' + JSON.stringify(crossDrop));
    }
    const crossDropId = crossDrop.body.dropId;

    const crossList = await get(BASE_B, '/atlas/world/drops?world=' + encodeURIComponent(CROSS_WORLD));
    if (!crossList.body.drops.some((d) => d.dropId === crossDropId)) throw new Error('Expected the cross-domain drop to appear in Domain B\'s own list');

    const crossClaim = await claimDrop(BASE_B, bob, crossDropId);
    if (crossClaim.status !== 200 || crossClaim.body.status !== 'claimed') {
      throw new Error('Expected the cross-domain claim (relayed to Domain A) to succeed, got: ' + JSON.stringify(crossClaim));
    }
    if (crossClaim.body.credential.owner.publicKey !== bob.publicKey) throw new Error('Expected the relayed claim to name Bob as owner');
    if (crossClaim.body.credential.issuer.domain !== DOMAIN_A) throw new Error('Expected the relay-claimed credential to still be issued by Domain A, got: ' + crossClaim.body.credential.issuer.domain);
    console.log('PASS: cross-domain drop + relay-claim both work through issuer-php');

    console.log('STEP 4: two concurrent claims of the same drop — only one may win');
    const race = await issueAsset(BASE_A, alice.publicKey, 'atlas.trinket.pin', 1);
    const raceDrop = await dropItem(BASE_A, alice, race, WORLD, [3, 0, 3]);
    const raceDropId = raceDrop.body.dropId;
    const carol = await generateIdentity();
    const [claimBob, claimCarol] = await Promise.all([claimDrop(BASE_A, bob, raceDropId), claimDrop(BASE_A, carol, raceDropId)]);
    const successes = [claimBob, claimCarol].filter((r) => r.status === 200);
    const failures = [claimBob, claimCarol].filter((r) => r.status === 404);
    if (successes.length !== 1 || failures.length !== 1) {
      throw new Error('Expected exactly one winner and one "already gone" rejection, got: ' + JSON.stringify([claimBob, claimCarol]));
    }
    console.log('PASS: concurrent double-claim is resolved to exactly one winner ->', failures[0].body.error);

    console.log('\nALL WORLD-DROPS PHP PROTOCOL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (procA) procA.kill();
    if (procB) procB.kill();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) {}
  }
})();
