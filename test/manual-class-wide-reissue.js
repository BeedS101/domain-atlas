// Manual check for the class-wide patch mechanism: POST /atlas/admin/
// class-patch (SPEC.md §5.1.1's per-credential reissue, generalized to a
// whole non-fungible CLASS) plus /atlas/mail/check's own extension that
// applies it automatically to whichever holder checks in next.
//
// Why this needed building at all: reissue only ever acted on one named
// credential the operator already had in hand — fine for a one-off
// correction, useless for "everyone who has a Chess Trophy should now see
// X" without either reissuing each holder by hand or keeping a registry
// of who holds what (rejected earlier for growing forever, see the admin
// panel's own now-reverted asset-picker feature). The fix built here keeps
// no such registry: an operator sets a small, class-keyed patch once
// (atlas-class-patches-store.json — one entry per class ever touched, not
// one per item or holder), and each holder's own wallet re-presents its
// current credential on its NEXT ordinary /atlas/mail/check round trip —
// the same one that already delivers mail and revocations — at which
// point the server compares it against the live patch and, if it's stale,
// revokes-and-reissues it right there. Nothing is pushed, nothing is
// pre-computed for anyone who hasn't checked in yet, and the server never
// remembers who was holding what before that moment.
//
// Run at the HTTP layer directly against BOTH backends, same "own isolated
// instance, no shared mutable state" reasoning manual-reissue-tradescope.js
// already uses (this test revokes/reissues credentials, which would
// pollute anything else running against the shared demo instances).
//
// Checks:
//   1. Node — setting a properties patch for atlas.trophy.chess, then
//      checking in with a real, currently-held trophy (credentialIds AND
//      credentials both present, exactly what wallet.js now sends) gets
//      back a `superseded`/`class-patch` update carrying a NEW credential
//      with the patched fact applied and every other property untouched.
//   2. Node — checking in again with that same NEW (already-patched)
//      credential produces no further update — applying a patch is
//      idempotent, not a churn loop.
//   3. Node — a caller that only sends `credentialIds` (no `credentials`,
//      the pre-existing wire shape) never gets an auto-applied patch,
//      even though the credential IS stale — the new behavior is purely
//      additive, so anything speaking the old shape keeps working exactly
//      as it always did.
//   4. Node — a `credentials` entry that doesn't check out against this
//      domain's own signature (tampered field, or simply never actually
//      signed by it) is never acted on, whatever it claims — the server
//      keeps no registry of who holds what, so re-verifying what's
//      presented is the only thing standing between "real" and "made up."
//   5. Node — clearing a class's patch (`clear: true`) stops it from being
//      applied to a credential minted afterward.
//   6. Node — a fungible class (atlas.element.gold) cannot be class-patched
//      at all, same restriction single-credential reissue already has.
//   7. Node — no token and no proof is rejected 401, same as every other
//      admin action.
//   8. Node — GET.../admin/asset-classes (the class-patch form's own
//      dropdown source) lists a BOUND non-fungible class alongside a
//      tradeable one, unlike GET /atlas/trade/catalog which deliberately
//      excludes bound classes — and stays admin-gated itself.
//   9. PHP — the same core mechanism (steps 1, 6, and 8) on an independent
//      issuer-php bundle, off its own ATLAS_ASSET_CATALOG.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const NODE_PORT = 8119; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://localhost:' + NODE_PORT;
const PHP_PORT = 8120;
const PHP_BASE = 'http://localhost:' + PHP_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-class-patch-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-class-patch-docroot-'));
const PHP_BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-class-patch-php-'));

const OWNER = 'test-owner-public-key-class-wide-reissue-demo';

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
// Mirrors extension/wallet.js's signWithSelf() — a raw-ecdsa self-signed
// envelope, the same one verifyEnvelope()/verify_envelope() checks on
// either backend.
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}
async function setClassPatchAsAdmin(base, admin, payload) {
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  return postJson(base, '/atlas/admin/class-patch', { payload, proof });
}
// Session-token login (same nonce/sign/start flow the admin panel itself
// uses) — needed for asset-classes below since the admin panel calls it
// with {token}, never a fresh {payload, proof} over an empty payload.
async function login(base, admin) {
  const nonce = (await fetch(base + '/atlas/admin/session/nonce').then((r) => r.json())).nonce;
  const payload = { nonce };
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  const res = await postJson(base, '/atlas/admin/session/start', { payload, proof });
  if (res.status !== 200) throw new Error('login failed at ' + base + ': ' + JSON.stringify(res));
  return res.body.token;
}
// Exactly the shape extension/wallet.js's checkAllMail() now sends: both
// the bare ids AND this wallet's own current copy of each credential.
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
    console.log('STEP 1: Node — a class-wide properties patch is picked up automatically by a real check-in');
    const trophy = await issueAsset(NODE_BASE, OWNER, 'atlas.trophy.chess', 1);
    const originalRarity = trophy.asset.properties['atlas.rarity'];
    const patchRes = await setClassPatchAsAdmin(NODE_BASE, admin, { assetClass: 'atlas.trophy.chess', properties: { 'com.example.awardedFor': 'Season 2 Champion' } });
    assert(patchRes.status === 200, 'expected setting the class patch to succeed, got: ' + JSON.stringify(patchRes));
    const checkRes = await checkMail(NODE_BASE, trophy);
    assert(checkRes.status === 200, 'expected 200 from mail/check, got: ' + JSON.stringify(checkRes));
    assert(checkRes.body.updates.length === 1, 'expected exactly one update, got: ' + JSON.stringify(checkRes.body.updates));
    const update = checkRes.body.updates[0];
    assert(update.id === trophy.id && update.status === 'superseded' && update.reason === 'class-patch', 'expected a class-patch supersession for the old id, got: ' + JSON.stringify(update));
    assert(update.newCredential.asset.properties['com.example.awardedFor'] === 'Season 2 Champion', 'expected the new credential to carry the patched fact, got: ' + JSON.stringify(update.newCredential.asset.properties));
    assert(update.newCredential.asset.properties['atlas.rarity'] === originalRarity, 'expected an untouched property to survive the patch unchanged');
    console.log('PASS: checking in with a held trophy auto-applies the class patch ->', trophy.id, '->', update.newCredential.id);

    console.log('STEP 2: Node — checking in again with the already-patched credential produces no further update');
    const recheckRes = await checkMail(NODE_BASE, update.newCredential);
    assert(recheckRes.status === 200 && recheckRes.body.updates.length === 0, 'expected no further update once the credential already matches the patch, got: ' + JSON.stringify(recheckRes.body.updates));
    console.log('PASS: applying a class patch is idempotent, not a repeat-forever loop');

    console.log('STEP 3: Node — a caller that only sends credentialIds (the old wire shape) never gets an auto-applied patch');
    const anotherTrophy = await issueAsset(NODE_BASE, OWNER, 'atlas.trophy.chess', 1);
    const idsOnlyRes = await postJson(NODE_BASE, '/atlas/mail/check', { credentialIds: [anotherTrophy.id] });
    assert(idsOnlyRes.status === 200 && idsOnlyRes.body.updates.length === 0, 'expected no update when the caller never presented the credential itself, got: ' + JSON.stringify(idsOnlyRes.body.updates));
    console.log('PASS: the new behavior is purely additive — a bare-ids caller sees exactly the old behavior');

    console.log('STEP 4: Node — a credential that does not check out against this domain\'s own signature is never acted on');
    const tampered = { ...anotherTrophy, asset: { ...anotherTrophy.asset, properties: { ...anotherTrophy.asset.properties, 'com.example.awardedFor': 'not what was actually signed' } } };
    const tamperedRes = await checkMail(NODE_BASE, tampered);
    assert(tamperedRes.status === 200 && tamperedRes.body.updates.length === 0, 'expected a tampered credential to be silently ignored, not acted on, got: ' + JSON.stringify(tamperedRes.body.updates));
    // The untouched, genuinely-signed credential should still be exactly as
    // stale as before — proving the tampered attempt didn't cause it to
    // get skipped/marked handled by accident.
    const stillStaleRes = await checkMail(NODE_BASE, anotherTrophy);
    assert(stillStaleRes.status === 200 && stillStaleRes.body.updates.length === 1, 'expected the real credential to still be patchable after the tampered attempt, got: ' + JSON.stringify(stillStaleRes.body.updates));
    console.log('PASS: only a credential that genuinely verifies against this domain\'s key is ever acted on');

    console.log('STEP 5: Node — clearing a class\'s patch stops it applying to a credential minted afterward');
    const clearRes = await setClassPatchAsAdmin(NODE_BASE, admin, { assetClass: 'atlas.trophy.chess', clear: true });
    assert(clearRes.status === 200 && clearRes.body.patch === null, 'expected clearing to succeed and report patch: null, got: ' + JSON.stringify(clearRes));
    const freshTrophy = await issueAsset(NODE_BASE, OWNER, 'atlas.trophy.chess', 1);
    const afterClearRes = await checkMail(NODE_BASE, freshTrophy);
    assert(afterClearRes.status === 200 && afterClearRes.body.updates.length === 0, 'expected no auto-patch once the class patch was cleared, got: ' + JSON.stringify(afterClearRes.body.updates));
    console.log('PASS: a cleared class patch stops correcting future check-ins');

    console.log('STEP 6: Node — a fungible class cannot be class-patched at all');
    const fungibleAttempt = await setClassPatchAsAdmin(NODE_BASE, admin, { assetClass: 'atlas.element.gold', properties: { 'com.example.form': 'coin' } });
    assert(fungibleAttempt.status === 400 && /non-fungible/i.test(fungibleAttempt.body.error || ''), 'expected a non-fungible-rejection 400, got: ' + JSON.stringify(fungibleAttempt));
    console.log('PASS: fungible classes rejected for a class patch, same as single-credential reissue ->', fungibleAttempt.body.error);

    console.log('STEP 7: Node — no token and no proof is rejected 401');
    const unauthed = await postJson(NODE_BASE, '/atlas/admin/class-patch', { payload: { assetClass: 'atlas.trophy.chess', properties: { x: 1 } } });
    assert(unauthed.status === 401, 'expected 401 with no auth, got: ' + JSON.stringify(unauthed));
    console.log('PASS: unauthenticated request rejected ->', unauthed.body.error);

    console.log('STEP 8: Node — the class-patch dropdown source (GET.../admin/asset-classes) lists every non-fungible class, bound or not, never a fungible one');
    const nodeToken = await login(NODE_BASE, admin);
    const classesRes = await postJson(NODE_BASE, '/atlas/admin/asset-classes', { token: nodeToken });
    assert(classesRes.status === 200, 'expected asset-classes to succeed, got: ' + JSON.stringify(classesRes));
    const classNames = classesRes.body.classes.map((c) => c.class);
    assert(classNames.includes('atlas.wearable.ring'), 'expected the tradeable ring class to be listed');
    assert(classNames.includes('atlas.wearable'), 'expected a BOUND class (the Bronze Compass) to be listed too — the whole point, unlike the public trade catalog which excludes it');
    assert(!classNames.includes('atlas.element.gold'), 'expected a fungible class to never be offered as a class-patch target');
    const wearableEntry = classesRes.body.classes.find((c) => c.class === 'atlas.wearable');
    assert(wearableEntry.tradeScope === 'bound', 'expected the bound class\'s own tradeScope to be reported, got: ' + JSON.stringify(wearableEntry));
    const classesUnauthed = await postJson(NODE_BASE, '/atlas/admin/asset-classes', {});
    assert(classesUnauthed.status === 401, 'expected asset-classes to be admin-gated same as every other admin action, got: ' + JSON.stringify(classesUnauthed));
    console.log('PASS: asset-classes lists bound and tradeable non-fungible classes alike, never fungible, and stays admin-gated');

    console.log('STEP 9: PHP — the same core mechanism on an independent issuer-php bundle');
    const phpTrophy = await issueAsset(PHP_BASE, OWNER, 'atlas.trophy.chess', 1);
    const phpPatchRes = await setClassPatchAsAdmin(PHP_BASE, admin, { assetClass: 'atlas.trophy.chess', properties: { 'com.example.awardedFor': 'Season 2 Champion' } });
    assert(phpPatchRes.status === 200, 'expected setting the PHP class patch to succeed, got: ' + JSON.stringify(phpPatchRes));
    const phpCheckRes = await checkMail(PHP_BASE, phpTrophy);
    assert(phpCheckRes.status === 200 && phpCheckRes.body.updates.length === 1, 'expected exactly one PHP update, got: ' + JSON.stringify(phpCheckRes.body));
    const phpUpdate = phpCheckRes.body.updates[0];
    assert(phpUpdate.reason === 'class-patch' && phpUpdate.newCredential.asset.properties['com.example.awardedFor'] === 'Season 2 Champion', 'expected PHP to apply the class patch the same way Node does, got: ' + JSON.stringify(phpUpdate));
    const phpFungibleAttempt = await setClassPatchAsAdmin(PHP_BASE, admin, { assetClass: 'atlas.element.gold', properties: { 'com.example.form': 'coin' } });
    assert(phpFungibleAttempt.status === 400, 'expected PHP to also reject a fungible class with 400, got: ' + phpFungibleAttempt.status);
    const phpToken = await login(PHP_BASE, admin);
    const phpClassesRes = await postJson(PHP_BASE, '/atlas/admin/asset-classes', { token: phpToken });
    const phpClassNames = phpClassesRes.body.classes.map((c) => c.class);
    assert(phpClassesRes.status === 200 && phpClassNames.includes('atlas.wearable') && !phpClassNames.includes('atlas.element.gold'), 'expected PHP asset-classes to also list bound classes and exclude fungible ones, got: ' + JSON.stringify(phpClassesRes.body));
    console.log('PASS: PHP matches Node for the auto-applied class patch, the fungible-class rejection, and the asset-classes listing');

    console.log('\nALL CLASS-WIDE REISSUE CHECKS PASSED');
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
