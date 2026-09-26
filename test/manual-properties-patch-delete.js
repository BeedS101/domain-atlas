// Manual check for a follow-up to both properties-patching mechanisms
// (POST /atlas/asset/reissue and POST /atlas/admin/class-patch): a
// property can now actually be REMOVED, not just added or overwritten.
//
// Why this needed building at all: `properties` on both endpoints was
// always a merge onto whatever's already there — `{ ...existing,
// ...patch }` — which can only add a key or change its value. Setting a
// key to `null` didn't remove it, it just left the key sitting there with
// the literal value null, still present. There was no way at all to take
// a fact away once it had been set. The fix (mergeProperties()/
// merge_properties(), one shared function both endpoints now go through
// in each backend) adopts the standard JSON Merge Patch convention (RFC
// 7386): a key set to `null` in what you send is deleted from the result
// entirely. This is the one place where a patch on this project can now
// mean something other than "add or overwrite" — everywhere else null
// still would have made no sense as a real property value, so nothing
// that could be expressed before is lost.
//
// Run at the HTTP layer directly against BOTH backends, same "own
// isolated instance, no shared mutable state" reasoning test/manual-
// class-wide-reissue.js and manual-reissue-tradescope.js already use —
// this test revokes/reissues credentials, which would pollute anything
// else running against the shared demo instances.
//
// Checks:
//   1. Node — /atlas/asset/reissue: setting one property to null removes
//      it entirely from the reissued credential, while an untouched
//      property survives unchanged.
//   2. Node — /atlas/asset/reissue: deleting one property and setting
//      another in the SAME call does both at once correctly.
//   3. Node — /atlas/admin/class-patch: a class-wide patch that deletes a
//      property removes it from a real held credential's properties on
//      its next check-in (not just sets it to null).
//   4. Node — checking in again with the already-deleted credential
//      produces no further update — deleting a property is idempotent,
//      not a repeat-forever loop (the exact bug a naive "compare against
//      literal null" staleness check would have caused).
//   5. Node — a SECOND class-patch call that adds a different property
//      doesn't resurrect the one already being deleted: the stored patch
//      keeps deleting the first property AND applies the new one, both
//      at once, on a freshly-minted credential.
//   6. Node — clearing the class patch stops the deletion from applying
//      to a credential minted afterward.
//   7. PHP — the same core behavior (reissue-delete and class-patch-
//      delete) on an independent issuer-php bundle.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const NODE_PORT = 8122; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://localhost:' + NODE_PORT;
const PHP_PORT = 8123;
const PHP_BASE = 'http://localhost:' + PHP_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-props-delete-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-props-delete-docroot-'));
const PHP_BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-props-delete-php-'));

const OWNER = 'test-owner-public-key-properties-patch-delete-demo';

function postJson(base, urlPath, body) {
  return fetch(base + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}
function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
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
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}
async function reissueAsAdmin(base, admin, payload) {
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  return postJson(base, '/atlas/asset/reissue', { payload, proof });
}
async function setClassPatchAsAdmin(base, admin, payload) {
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  return postJson(base, '/atlas/admin/class-patch', { payload, proof });
}
// Exactly the shape extension/wallet.js's checkAllMail() sends: both the
// bare id AND this wallet's own current copy of the credential.
function checkMail(base, credential) {
  return postJson(base, '/atlas/mail/check', { credentialIds: [credential.id], credentials: [credential] });
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

  console.log('SETUP: seeding one admin identity into both isolated instances\' own admin rosters');
  const admin = await genIdentity();
  fs.writeFileSync(path.join(NODE_STATE_DIR, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
  fs.writeFileSync(path.join(PHP_BUNDLE_DIR, 'lib', 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
  console.log('PASS: admin identity seeded into both rosters');

  try {
    console.log('STEP 1: Node — reissue: setting a property to null removes it entirely, an untouched property survives');
    const trophy1 = await issueAsset(NODE_BASE, OWNER, 'atlas.trophy.chess', 1);
    assert('com.example.awardedFor' in trophy1.asset.properties, 'expected a freshly-minted trophy to carry com.example.awardedFor');
    const originalRarity = trophy1.asset.properties['atlas.rarity'];
    const deleted = await reissueAsAdmin(NODE_BASE, admin, { credential: trophy1, properties: { 'com.example.awardedFor': null } });
    assert(deleted.status === 200, 'expected the delete-via-reissue to succeed, got: ' + JSON.stringify(deleted));
    const deletedProps = deleted.body.newCredential.asset.properties;
    assert(!('com.example.awardedFor' in deletedProps), 'expected the property to be entirely absent, not just null, got: ' + JSON.stringify(deletedProps));
    assert(deletedProps['atlas.rarity'] === originalRarity, 'expected an untouched property to survive the deletion unchanged');
    console.log('PASS: reissue with a null property genuinely removes the key ->', trophy1.id, '->', deleted.body.newCredential.id);

    console.log('STEP 2: Node — reissue: deleting one property and setting another in the same call does both at once');
    const combo = await reissueAsAdmin(NODE_BASE, admin, { credential: deleted.body.newCredential, properties: { 'atlas.rarity': null, 'com.example.material': 'gold-plated' } });
    assert(combo.status === 200, 'expected the combined delete+set reissue to succeed, got: ' + JSON.stringify(combo));
    const comboProps = combo.body.newCredential.asset.properties;
    assert(!('atlas.rarity' in comboProps), 'expected atlas.rarity to be removed, got: ' + JSON.stringify(comboProps));
    assert(comboProps['com.example.material'] === 'gold-plated', 'expected com.example.material to be set, got: ' + JSON.stringify(comboProps));
    console.log('PASS: a single patch can delete one property and set another at the same time');

    console.log('STEP 3: Node — a class-wide patch that deletes a property removes it from a real held credential on its next check-in');
    const trophy2 = await issueAsset(NODE_BASE, OWNER, 'atlas.trophy.chess', 1);
    assert('atlas.rarity' in trophy2.asset.properties, 'expected a freshly-minted trophy to carry atlas.rarity');
    const classDelete = await setClassPatchAsAdmin(NODE_BASE, admin, { assetClass: 'atlas.trophy.chess', properties: { 'atlas.rarity': null } });
    assert(classDelete.status === 200, 'expected setting the delete class patch to succeed, got: ' + JSON.stringify(classDelete));
    const checkRes = await checkMail(NODE_BASE, trophy2);
    assert(checkRes.status === 200 && checkRes.body.updates.length === 1, 'expected exactly one update, got: ' + JSON.stringify(checkRes.body));
    const newProps = checkRes.body.updates[0].newCredential.asset.properties;
    assert(!('atlas.rarity' in newProps), 'expected atlas.rarity to be entirely gone after the class patch applied, got: ' + JSON.stringify(newProps));
    assert('com.example.awardedFor' in newProps, 'expected an untouched property to survive the class-wide deletion');
    console.log('PASS: a class-wide delete patch removes the property from a real holder\'s credential, not just nulls it');

    console.log('STEP 4: Node — checking in again with the already-deleted credential produces no further update');
    const recheckRes = await checkMail(NODE_BASE, checkRes.body.updates[0].newCredential);
    assert(recheckRes.status === 200 && recheckRes.body.updates.length === 0, 'expected no further update once the property is already gone, got: ' + JSON.stringify(recheckRes.body.updates));
    console.log('PASS: a deleted property is idempotent — it does not reissue forever');

    console.log('STEP 5: Node — a second class-patch call that adds a different property keeps deleting the first one too');
    const classAddToo = await setClassPatchAsAdmin(NODE_BASE, admin, { assetClass: 'atlas.trophy.chess', properties: { 'com.example.material': 'obsidian' } });
    assert(classAddToo.status === 200 && classAddToo.body.patch.properties['atlas.rarity'] === null, 'expected the stored patch to still carry the earlier delete instruction, got: ' + JSON.stringify(classAddToo.body));
    const trophy3 = await issueAsset(NODE_BASE, OWNER, 'atlas.trophy.chess', 1);
    const bothCheck = await checkMail(NODE_BASE, trophy3);
    assert(bothCheck.status === 200 && bothCheck.body.updates.length === 1, 'expected one update applying both the delete and the new fact, got: ' + JSON.stringify(bothCheck.body));
    const bothProps = bothCheck.body.updates[0].newCredential.asset.properties;
    assert(!('atlas.rarity' in bothProps) && bothProps['com.example.material'] === 'obsidian', 'expected both the deletion and the new fact to apply together, got: ' + JSON.stringify(bothProps));
    console.log('PASS: stacking a new class-patch call preserves an earlier delete instruction alongside a new fact');

    console.log('STEP 6: Node — clearing the class patch stops the deletion from applying to a credential minted afterward');
    const cleared = await setClassPatchAsAdmin(NODE_BASE, admin, { assetClass: 'atlas.trophy.chess', clear: true });
    assert(cleared.status === 200 && cleared.body.patch === null, 'expected clearing to succeed, got: ' + JSON.stringify(cleared));
    const trophy4 = await issueAsset(NODE_BASE, OWNER, 'atlas.trophy.chess', 1);
    const afterClear = await checkMail(NODE_BASE, trophy4);
    assert(afterClear.status === 200 && afterClear.body.updates.length === 0, 'expected no deletion once the class patch was cleared, got: ' + JSON.stringify(afterClear.body.updates));
    console.log('PASS: a cleared class patch no longer deletes anything');

    console.log('STEP 7: PHP — the same core delete behavior on an independent issuer-php bundle');
    const phpTrophy = await issueAsset(PHP_BASE, OWNER, 'atlas.trophy.chess', 1);
    const phpDeleted = await reissueAsAdmin(PHP_BASE, admin, { credential: phpTrophy, properties: { 'com.example.awardedFor': null } });
    assert(phpDeleted.status === 200 && !('com.example.awardedFor' in phpDeleted.body.newCredential.asset.properties), 'expected PHP reissue-delete to also remove the key entirely, got: ' + JSON.stringify(phpDeleted.body));
    const phpClassDelete = await setClassPatchAsAdmin(PHP_BASE, admin, { assetClass: 'atlas.trophy.chess', properties: { 'atlas.rarity': null } });
    assert(phpClassDelete.status === 200, 'expected setting the PHP delete class patch to succeed, got: ' + JSON.stringify(phpClassDelete));
    const phpTrophy2 = await issueAsset(PHP_BASE, OWNER, 'atlas.trophy.chess', 1);
    const phpCheck = await checkMail(PHP_BASE, phpTrophy2);
    assert(phpCheck.status === 200 && phpCheck.body.updates.length === 1 && !('atlas.rarity' in phpCheck.body.updates[0].newCredential.asset.properties), 'expected PHP class-patch delete to match Node, got: ' + JSON.stringify(phpCheck.body));
    console.log('PASS: PHP matches Node for both reissue-delete and class-patch-delete');

    console.log('\nALL PROPERTIES-PATCH DELETE CHECKS PASSED');
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
