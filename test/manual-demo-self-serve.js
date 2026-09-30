// Manual check for the self-serve /atlas/demo/* routes added so a solo
// visitor to warranty-demo.html, cafeteria-demo.html, login-demo.html, and
// clawback-demo.html can finish those pages without a real admin login —
// the live site (evtec.co.za) has no way for an ordinary visitor to become
// an admin, so those pages previously asked a visitor to do something they
// simply couldn't do. Each new route does exactly what its admin-gated
// sibling does (POST /atlas/asset/mint, /atlas/asset/reissue,
// /atlas/asset/fulfill, /atlas/revoke, /atlas/suspend, /atlas/unsuspend,
// /atlas/clawback respectively), minus the auth, but hardcoded to touch
// only its own page's own toy class — this test's main job is proving
// that class-scoping actually holds, on both backends.
//
// Run at the HTTP layer directly against BOTH backends, same isolated-
// instance reasoning every other manual-*.js test in this project uses.
//
// Checks:
//   1. Node — POST /atlas/demo/warranty/mint succeeds with no auth at all,
//      applies the given properties patch, and is genuinely signed by this
//      issuer.
//   2. Node — the same route rejects a non-object properties value.
//   3. Node — POST /atlas/demo/warranty/stamp-sale merges the sale
//      properties onto the minted certificate (keeping the serial number
//      already there) and revokes the superseded credential.
//   4. Node — the same route rejects a credential whose class isn't
//      atlas.demo.warranty.certificate.
//   5. Node — POST /atlas/demo/cafeteria/fulfill succeeds for one of its
//      three allowed classes and genuinely revokes it.
//   6. Node — the same route rejects a credential outside that three-class
//      allow-list.
//   7. Node — POST /atlas/demo/login/revoke succeeds for
//      atlas.demo.login.badge and genuinely revokes it.
//   8. Node — the same route rejects a credential outside that one class.
//   9. Node — regression: the real admin-gated siblings still reject an
//      unauthenticated request exactly as before — adding the self-serve
//      routes didn't loosen them.
//  10. PHP — the same mint+stamp-sale, cafeteria class-scoping, and login
//      class-scoping behavior on an independent issuer-php bundle.
//  11. Node — POST /atlas/demo/clawback/suspend succeeds with no auth, and
//      a real /atlas/asset/transfer attempt against that exact credential
//      is genuinely rejected as suspended — proving the freeze holds, not
//      just that the endpoint returned ok.
//  12. Node — the same suspend route rejects a credential outside
//      atlas.demo.clawback.token.
//  13. Node — POST /atlas/demo/clawback/unsuspend lifts the freeze, and the
//      identical transfer blocked in step 11 now succeeds for real.
//  14. Node — POST /atlas/demo/clawback/clawback reissues a stolen token
//      straight to a chosen recipient, genuinely signed, revokes the old
//      one, and rejects toPublicKey already matching the current owner.
//  15. Node — regression: the real admin-gated /atlas/suspend,
//      /atlas/unsuspend, and /atlas/clawback still reject an
//      unauthenticated request exactly as before.
//  16. PHP — the same suspend/block/unsuspend/retry and clawback behavior
//      on the independent issuer-php bundle.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const NODE_PORT = 8143; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://localhost:' + NODE_PORT;
const PHP_PORT = 8144;
const PHP_BASE = 'http://localhost:' + PHP_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-demo-self-serve-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-demo-self-serve-docroot-'));
const PHP_BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-demo-self-serve-php-'));

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
function postJson(base, urlPath, body) {
  return fetch(base + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}
function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function genIdentity() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { kp, publicKey: b64url(raw) };
}
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
async function signWithSelf(identity, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.kp.privateKey, data);
  return { signerRole: 'raw-ecdsa', publicKey: identity.publicKey, signature: b64url(new Uint8Array(sig)) };
}
async function transferAsset(base, sender, credential, recipientPublicKey) {
  const payload = { credentialId: credential.id, recipientPublicKey, action: 'transfer' };
  const proof = await signWithSelf(sender, payload);
  return postJson(base, '/atlas/asset/transfer', { credential, recipientPublicKey, intent: { payload, proof } });
}
async function issueAsset(base, ownerPublicKey, assetClass, quantity) {
  const res = await postJson(base, '/atlas/asset/issue', { ownerPublicKey, assetClass, ...(quantity !== undefined ? { quantity } : {}) });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ' at ' + base + ': ' + JSON.stringify(res.body));
  return res.body;
}
async function verifyGenuineSignature(base, credential) {
  const keyDoc = await fetch(base + '/.well-known/atlas-key.json').then((r) => r.json());
  const issuerKey = await subtle.importKey('raw', Buffer.from(keyDoc.keys[0].publicKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const payload = { id: credential.id, asset: credential.asset, owner: credential.owner, quantity: credential.quantity, supersedes: credential.supersedes, issuedAt: credential.issuedAt };
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, issuerKey, Buffer.from(credential.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'), new TextEncoder().encode(canonicalize(payload)));
}
async function isRevoked(base, credentialId) {
  const revDoc = await fetch(base + '/.well-known/atlas-revocations.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ revoked: [] }));
  return (revDoc.revoked || []).some((r) => r.id === credentialId);
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

  try {
    console.log('SETUP: minting a holder identity');
    const holder = await genIdentity();

    console.log('STEP 1: Node — /atlas/demo/warranty/mint succeeds with no auth, applies the properties patch, genuinely signed');
    const minted = await postJson(NODE_BASE, '/atlas/demo/warranty/mint', { ownerPublicKey: holder.publicKey, properties: { 'com.example.serialNumber': 'SN-0001' } });
    assert(minted.status === 200, 'expected the self-serve mint to succeed, got: ' + JSON.stringify(minted.body));
    assert(minted.body.asset.class === 'atlas.demo.warranty.certificate', 'expected the minted class to be the warranty certificate, got: ' + JSON.stringify(minted.body.asset));
    assert(minted.body.asset.properties['com.example.serialNumber'] === 'SN-0001', 'expected the serial number property to be set, got: ' + JSON.stringify(minted.body.asset));
    assert(await verifyGenuineSignature(NODE_BASE, minted.body), 'expected the self-serve-minted certificate to carry a genuine issuer signature');
    console.log('PASS: self-serve warranty mint works with no admin login —', minted.body.id);

    console.log('STEP 2: Node — /atlas/demo/warranty/mint rejects a non-object properties value');
    const badProps = await postJson(NODE_BASE, '/atlas/demo/warranty/mint', { ownerPublicKey: holder.publicKey, properties: 'not-an-object' });
    assert(badProps.status === 400 && /patch object/.test(badProps.body.error), 'expected a bad-properties rejection, got: ' + JSON.stringify(badProps.body));
    console.log('PASS: a non-object properties value is rejected —', badProps.body.error);

    console.log('STEP 3: Node — /atlas/demo/warranty/stamp-sale merges the sale properties, keeps the serial number, and revokes the old credential');
    const stamped = await postJson(NODE_BASE, '/atlas/demo/warranty/stamp-sale', {
      credential: minted.body,
      properties: { 'com.example.saleDate': '2026-01-01', 'com.example.warrantyMonths': 24, 'com.example.retailer': 'Example Retailer' }
    });
    assert(stamped.status === 200, 'expected the self-serve stamp-sale to succeed, got: ' + JSON.stringify(stamped.body));
    const newCert = stamped.body.newCredential;
    assert(newCert.asset.properties['com.example.serialNumber'] === 'SN-0001', 'expected the serial number to survive the merge, got: ' + JSON.stringify(newCert.asset));
    assert(newCert.asset.properties['com.example.retailer'] === 'Example Retailer', 'expected the retailer property to be set, got: ' + JSON.stringify(newCert.asset));
    assert(await verifyGenuineSignature(NODE_BASE, newCert), 'expected the stamped certificate to carry a genuine issuer signature');
    assert(await isRevoked(NODE_BASE, minted.body.id), 'expected the pre-stamp credential to be revoked as superseded');
    console.log('PASS: self-serve stamp-sale merges properties and revokes the superseded credential —', newCert.id);

    console.log('STEP 4: Node — /atlas/demo/warranty/stamp-sale rejects a credential of the wrong class');
    const badgeCred = await issueAsset(NODE_BASE, holder.publicKey, 'atlas.demo.login.badge');
    const wrongClassStamp = await postJson(NODE_BASE, '/atlas/demo/warranty/stamp-sale', { credential: badgeCred, properties: { 'com.example.saleDate': '2026-01-01' } });
    assert(wrongClassStamp.status === 400 && /only stamps/.test(wrongClassStamp.body.error), 'expected a wrong-class rejection, got: ' + JSON.stringify(wrongClassStamp.body));
    console.log('PASS: stamping a non-warranty credential is rejected —', wrongClassStamp.body.error);

    console.log('STEP 5: Node — /atlas/demo/cafeteria/fulfill succeeds for an allowed class and genuinely revokes it');
    const sandwich = await issueAsset(NODE_BASE, holder.publicKey, 'atlas.demo.cafeteria.sandwich');
    const fulfilled = await postJson(NODE_BASE, '/atlas/demo/cafeteria/fulfill', { credential: sandwich });
    assert(fulfilled.status === 200 && fulfilled.body.status === 'fulfilled', 'expected the self-serve fulfill to succeed, got: ' + JSON.stringify(fulfilled.body));
    assert(await isRevoked(NODE_BASE, sandwich.id), 'expected the fulfilled receipt to be revoked');
    console.log('PASS: self-serve cafeteria fulfill works with no admin login —', sandwich.id);

    console.log('STEP 6: Node — /atlas/demo/cafeteria/fulfill rejects a credential outside its three-class allow-list');
    const outOfScope = await issueAsset(NODE_BASE, holder.publicKey, 'atlas.demo.warranty.certificate');
    const wrongClassFulfill = await postJson(NODE_BASE, '/atlas/demo/cafeteria/fulfill', { credential: outOfScope });
    assert(wrongClassFulfill.status === 400 && /only fulfills/.test(wrongClassFulfill.body.error), 'expected an out-of-scope rejection, got: ' + JSON.stringify(wrongClassFulfill.body));
    console.log('PASS: fulfilling an out-of-scope class is rejected —', wrongClassFulfill.body.error);

    console.log('STEP 7: Node — /atlas/demo/login/revoke succeeds for atlas.demo.login.badge and genuinely revokes it');
    const badgeToRevoke = await issueAsset(NODE_BASE, holder.publicKey, 'atlas.demo.login.badge');
    const revoked = await postJson(NODE_BASE, '/atlas/demo/login/revoke', { credential: badgeToRevoke });
    assert(revoked.status === 200 && revoked.body.ok === true, 'expected the self-serve revoke to succeed, got: ' + JSON.stringify(revoked.body));
    assert(await isRevoked(NODE_BASE, badgeToRevoke.id), 'expected the login badge to actually be revoked');
    console.log('PASS: self-serve login revoke works with no admin login —', badgeToRevoke.id);

    console.log('STEP 8: Node — /atlas/demo/login/revoke rejects a credential outside atlas.demo.login.badge');
    const wrongClassRevoke = await postJson(NODE_BASE, '/atlas/demo/login/revoke', { credential: outOfScope });
    assert(wrongClassRevoke.status === 400 && /only revokes/.test(wrongClassRevoke.body.error), 'expected an out-of-scope rejection, got: ' + JSON.stringify(wrongClassRevoke.body));
    console.log('PASS: revoking an out-of-scope class is rejected —', wrongClassRevoke.body.error);

    console.log('STEP 9: Node — regression: the real admin-gated siblings still reject an unauthenticated request');
    const realMint = await postJson(NODE_BASE, '/atlas/asset/mint', { payload: { ownerPublicKey: holder.publicKey, assetClass: 'atlas.demo.warranty.certificate' } });
    const realReissue = await postJson(NODE_BASE, '/atlas/asset/reissue', { payload: { credential: minted.body, properties: {} } });
    const realFulfill = await postJson(NODE_BASE, '/atlas/asset/fulfill', { payload: { credential: sandwich } });
    const realRevoke = await postJson(NODE_BASE, '/atlas/revoke', { payload: { id: badgeToRevoke.id } });
    assert([realMint.status, realReissue.status, realFulfill.status, realRevoke.status].every((s) => s === 401), 'expected every real admin-gated route to still reject with no auth, got: ' + JSON.stringify([realMint.status, realReissue.status, realFulfill.status, realRevoke.status]));
    console.log('PASS: the real admin-gated routes are unaffected — still 401 with no admin proof');

    console.log('STEP 10: PHP — the same self-serve mint+stamp-sale, cafeteria class-scoping, and login class-scoping behavior');
    const phpHolder = await genIdentity();
    const phpMinted = await postJson(PHP_BASE, '/atlas/demo/warranty/mint', { ownerPublicKey: phpHolder.publicKey, properties: { 'com.example.serialNumber': 'SN-PHP-0001' } });
    assert(phpMinted.status === 200 && phpMinted.body.asset.properties['com.example.serialNumber'] === 'SN-PHP-0001', 'expected PHP self-serve mint to succeed, got: ' + JSON.stringify(phpMinted.body));
    const phpStamped = await postJson(PHP_BASE, '/atlas/demo/warranty/stamp-sale', { credential: phpMinted.body, properties: { 'com.example.saleDate': '2026-01-01', 'com.example.retailer': 'PHP Retailer' } });
    assert(phpStamped.status === 200 && phpStamped.body.newCredential.asset.properties['com.example.serialNumber'] === 'SN-PHP-0001', 'expected PHP stamp-sale to merge properties, got: ' + JSON.stringify(phpStamped.body));
    const phpSandwich = await issueAsset(PHP_BASE, phpHolder.publicKey, 'atlas.demo.cafeteria.sandwich');
    const phpFulfilled = await postJson(PHP_BASE, '/atlas/demo/cafeteria/fulfill', { credential: phpSandwich });
    assert(phpFulfilled.status === 200 && phpFulfilled.body.status === 'fulfilled', 'expected PHP self-serve fulfill to succeed, got: ' + JSON.stringify(phpFulfilled.body));
    const phpOutOfScope = await issueAsset(PHP_BASE, phpHolder.publicKey, 'atlas.demo.warranty.certificate');
    const phpWrongFulfill = await postJson(PHP_BASE, '/atlas/demo/cafeteria/fulfill', { credential: phpOutOfScope });
    assert(phpWrongFulfill.status === 400, 'expected PHP to reject an out-of-scope fulfill too, got: ' + JSON.stringify(phpWrongFulfill.body));
    const phpBadge = await issueAsset(PHP_BASE, phpHolder.publicKey, 'atlas.demo.login.badge');
    const phpRevoked = await postJson(PHP_BASE, '/atlas/demo/login/revoke', { credential: phpBadge });
    assert(phpRevoked.status === 200 && phpRevoked.body.ok === true, 'expected PHP self-serve revoke to succeed, got: ' + JSON.stringify(phpRevoked.body));
    const phpWrongRevoke = await postJson(PHP_BASE, '/atlas/demo/login/revoke', { credential: phpOutOfScope });
    assert(phpWrongRevoke.status === 400, 'expected PHP to reject an out-of-scope revoke too, got: ' + JSON.stringify(phpWrongRevoke.body));
    console.log('PASS: PHP matches Node across all four self-serve demo routes');

    console.log('STEP 11: Node — /atlas/demo/clawback/suspend succeeds with no auth, and a real transfer attempt against it is genuinely blocked');
    const owner = await genIdentity();
    const buyer = await genIdentity();
    let token = await issueAsset(NODE_BASE, owner.publicKey, 'atlas.demo.clawback.token');
    const suspended = await postJson(NODE_BASE, '/atlas/demo/clawback/suspend', { credential: token });
    assert(suspended.status === 200 && suspended.body.ok === true, 'expected the self-serve suspend to succeed, got: ' + JSON.stringify(suspended.body));
    const blockedSale = await transferAsset(NODE_BASE, owner, token, buyer.publicKey);
    assert(blockedSale.status === 400 && /suspended pending review/.test(blockedSale.body.error), 'expected the transfer to be genuinely blocked by the suspension, got: ' + JSON.stringify(blockedSale.body));
    console.log('PASS: suspending with no admin login actually freezes the credential —', token.id);

    console.log('STEP 12: Node — /atlas/demo/clawback/suspend rejects a credential outside atlas.demo.clawback.token');
    const wrongClassSuspend = await postJson(NODE_BASE, '/atlas/demo/clawback/suspend', { credential: outOfScope });
    assert(wrongClassSuspend.status === 400 && /only suspends/.test(wrongClassSuspend.body.error), 'expected an out-of-scope rejection, got: ' + JSON.stringify(wrongClassSuspend.body));
    console.log('PASS: suspending an out-of-scope class is rejected —', wrongClassSuspend.body.error);

    console.log('STEP 13: Node — /atlas/demo/clawback/unsuspend lifts the freeze, and the same blocked sale now succeeds for real');
    const unsuspended = await postJson(NODE_BASE, '/atlas/demo/clawback/unsuspend', { credential: token });
    assert(unsuspended.status === 200 && unsuspended.body.ok === true && unsuspended.body.wasSuspended === true, 'expected the self-serve unsuspend to succeed and report it lifted something, got: ' + JSON.stringify(unsuspended.body));
    const retriedSale = await transferAsset(NODE_BASE, owner, token, buyer.publicKey);
    assert(retriedSale.status === 200, 'expected the identical transfer to succeed once unsuspended, got: ' + JSON.stringify(retriedSale.body));
    console.log('PASS: unsuspending with no admin login genuinely lifts the freeze —', retriedSale.body.credential.id);

    console.log('STEP 14: Node — /atlas/demo/clawback/clawback reissues a stolen token to its rightful owner, revokes the old one, and rejects a no-op target');
    const victim = await genIdentity();
    const thief = await genIdentity();
    let stolen = await issueAsset(NODE_BASE, victim.publicKey, 'atlas.demo.clawback.token');
    const theftTransfer = await transferAsset(NODE_BASE, victim, stolen, thief.publicKey);
    assert(theftTransfer.status === 200, 'expected the simulated theft transfer to succeed, got: ' + JSON.stringify(theftTransfer.body));
    stolen = theftTransfer.body.credential;
    const noopClawback = await postJson(NODE_BASE, '/atlas/demo/clawback/clawback', { credential: stolen, toPublicKey: thief.publicKey });
    assert(noopClawback.status === 400 && /nothing to claw back/.test(noopClawback.body.error), 'expected clawing back to the current owner to be rejected, got: ' + JSON.stringify(noopClawback.body));
    const clawedBack = await postJson(NODE_BASE, '/atlas/demo/clawback/clawback', { credential: stolen, toPublicKey: victim.publicKey });
    assert(clawedBack.status === 200, 'expected the self-serve clawback to succeed, got: ' + JSON.stringify(clawedBack.body));
    assert(clawedBack.body.newCredential.owner.publicKey === victim.publicKey, 'expected the new credential to belong to the victim, got: ' + JSON.stringify(clawedBack.body.newCredential.owner));
    assert(await verifyGenuineSignature(NODE_BASE, clawedBack.body.newCredential), 'expected the clawed-back credential to carry a genuine issuer signature');
    assert(await isRevoked(NODE_BASE, stolen.id), 'expected the stolen credential to be revoked after clawback');
    console.log('PASS: self-serve clawback returns a stolen token straight to its owner —', clawedBack.body.newCredential.id);

    console.log('STEP 15: Node — regression: the real admin-gated /atlas/suspend, /atlas/unsuspend, and /atlas/clawback still reject an unauthenticated request');
    const realSuspend = await postJson(NODE_BASE, '/atlas/suspend', { payload: { id: token.id, reason: 'test' } });
    const realUnsuspend = await postJson(NODE_BASE, '/atlas/unsuspend', { payload: { id: token.id } });
    const realClawback = await postJson(NODE_BASE, '/atlas/clawback', { payload: { credential: token, toPublicKey: buyer.publicKey } });
    assert([realSuspend.status, realUnsuspend.status, realClawback.status].every((s) => s === 401), 'expected every real admin-gated suspend/unsuspend/clawback route to still reject with no auth, got: ' + JSON.stringify([realSuspend.status, realUnsuspend.status, realClawback.status]));
    console.log('PASS: the real admin-gated suspend/unsuspend/clawback routes are unaffected — still 401 with no admin proof');

    console.log('STEP 16: PHP — the same suspend/block/unsuspend/retry and clawback behavior on the independent issuer-php bundle');
    const phpOwner = await genIdentity();
    const phpBuyer = await genIdentity();
    let phpToken = await issueAsset(PHP_BASE, phpOwner.publicKey, 'atlas.demo.clawback.token');
    const phpSuspended = await postJson(PHP_BASE, '/atlas/demo/clawback/suspend', { credential: phpToken });
    assert(phpSuspended.status === 200 && phpSuspended.body.ok === true, 'expected PHP self-serve suspend to succeed, got: ' + JSON.stringify(phpSuspended.body));
    const phpBlockedSale = await transferAsset(PHP_BASE, phpOwner, phpToken, phpBuyer.publicKey);
    assert(phpBlockedSale.status === 400 && /suspended pending review/.test(phpBlockedSale.body.error), 'expected PHP to genuinely block the suspended transfer too, got: ' + JSON.stringify(phpBlockedSale.body));
    const phpUnsuspended = await postJson(PHP_BASE, '/atlas/demo/clawback/unsuspend', { credential: phpToken });
    assert(phpUnsuspended.status === 200 && phpUnsuspended.body.wasSuspended === true, 'expected PHP self-serve unsuspend to succeed, got: ' + JSON.stringify(phpUnsuspended.body));
    const phpRetriedSale = await transferAsset(PHP_BASE, phpOwner, phpToken, phpBuyer.publicKey);
    assert(phpRetriedSale.status === 200, 'expected PHP to allow the retried transfer once unsuspended, got: ' + JSON.stringify(phpRetriedSale.body));
    const phpVictim = await genIdentity();
    const phpThief = await genIdentity();
    let phpStolen = await issueAsset(PHP_BASE, phpVictim.publicKey, 'atlas.demo.clawback.token');
    const phpTheftTransfer = await transferAsset(PHP_BASE, phpVictim, phpStolen, phpThief.publicKey);
    assert(phpTheftTransfer.status === 200, 'expected the PHP simulated theft transfer to succeed, got: ' + JSON.stringify(phpTheftTransfer.body));
    phpStolen = phpTheftTransfer.body.credential;
    const phpClawedBack = await postJson(PHP_BASE, '/atlas/demo/clawback/clawback', { credential: phpStolen, toPublicKey: phpVictim.publicKey });
    assert(phpClawedBack.status === 200 && phpClawedBack.body.newCredential.owner.publicKey === phpVictim.publicKey, 'expected PHP self-serve clawback to succeed, got: ' + JSON.stringify(phpClawedBack.body));
    assert(await isRevoked(PHP_BASE, phpStolen.id), 'expected PHP to revoke the stolen credential after clawback');
    console.log('PASS: PHP matches Node across suspend, unsuspend, and clawback self-serve routes');

    console.log('\nALL DEMO SELF-SERVE CHECKS PASSED');
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
