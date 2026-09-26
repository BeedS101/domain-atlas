// Manual check for POST /atlas/asset/redeem — a holder voiding their own
// credential, no recipient involved at all: the plainest possible
// revocation request, authorized by nothing but the holder's own signature
// over exactly that intent. Same envelope shape as /atlas/asset/transfer
// (test/manual-asset-transfer.js), minus the recipient field, and
// deliberately allowed on a BOUND credential too (unlike transfer) — giving
// up your own membership card needs no recipient to reason about, only
// transferring it to someone else does.
//
// Run at the HTTP layer directly against BOTH backends, same isolated-
// instance reasoning every other manual-*.js test in this project uses.
//
// Checks:
//   1. Node — redeeming a giftable (non-bound) credential revokes it.
//   2. Node — the now-revoked credential can't be redeemed again.
//   3. Node — a bound credential (atlas.badge) CAN be redeemed by its own
//      holder, unlike a transfer of the same credential.
//   4. Node — someone who doesn't actually hold the credential (a signer
//      whose key doesn't match credential.owner.publicKey) can't redeem it.
//   5. Node — a fungible balance is rejected (non-fungible only for now,
//      same scope /atlas/asset/transfer already carries).
//   6. Node — a mismatched intent (wrong credentialId or wrong action) is
//      rejected before anything is touched.
//   7. Node — a redeemed credential's own JSON is what business-demo.html's
//      independent-verify step would see: revoked, per
//      GET /.well-known/atlas-revocations.json.
//   8. PHP — the same core behavior (successful redeem, replay rejection,
//      bound credential redeemable) on an independent issuer-php bundle.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const NODE_PORT = 8127; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://localhost:' + NODE_PORT;
const PHP_PORT = 8128;
const PHP_BASE = 'http://localhost:' + PHP_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-redeem-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-redeem-docroot-'));
const PHP_BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-redeem-php-'));

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
async function redeemAsHolder(base, holder, credential, payloadOverride) {
  const payload = payloadOverride || { credentialId: credential.id, action: 'redeem' };
  const proof = await signWithSelf(holder.kp, holder.publicKey, payload);
  return postJson(base, '/atlas/asset/redeem', { credential, intent: { payload, proof } });
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
    console.log('SETUP: minting a holder and a stranger identity');
    const holder = await genIdentity();
    const stranger = await genIdentity();

    console.log('STEP 1: Node — redeeming a giftable coupon revokes it');
    const coupon = await issueAsset(NODE_BASE, holder.publicKey, 'atlas.demo.coupon', 1);
    const redeemed = await redeemAsHolder(NODE_BASE, holder, coupon);
    assert(redeemed.status === 200, 'expected the coupon redeem to succeed, got: ' + JSON.stringify(redeemed.body));
    assert(redeemed.body.status === 'redeemed' && redeemed.body.id === coupon.id, 'expected a redeemed status naming the coupon\'s own id');
    console.log('PASS: a giftable coupon is redeemed ->', coupon.id);

    console.log('STEP 2: Node — the now-revoked coupon can\'t be redeemed again');
    const again = await redeemAsHolder(NODE_BASE, holder, coupon);
    assert(again.status === 400 && /already revoked/.test(again.body.error), 'expected the already-redeemed coupon to be rejected as revoked, got: ' + JSON.stringify(again.body));
    console.log('PASS: a redeemed credential cannot be redeemed twice');

    console.log('STEP 3: Node — a bound credential (the badge) CAN be redeemed by its own holder, unlike a transfer');
    const badge = await issueAsset(NODE_BASE, holder.publicKey, 'atlas.badge', 1);
    const badgeRedeemed = await redeemAsHolder(NODE_BASE, holder, badge);
    assert(badgeRedeemed.status === 200 && badgeRedeemed.body.status === 'redeemed', 'expected a bound badge to be redeemable by its own holder, got: ' + JSON.stringify(badgeRedeemed.body));
    console.log('PASS: a bound badge can be given up by its own holder');

    console.log('STEP 4: Node — a signer who does not actually hold the credential cannot redeem it');
    const coupon2 = await issueAsset(NODE_BASE, holder.publicKey, 'atlas.demo.coupon', 1);
    const impostor = await redeemAsHolder(NODE_BASE, stranger, coupon2);
    assert(impostor.status === 400 && /does not belong to this signer/.test(impostor.body.error), 'expected a non-owner signer to be rejected, got: ' + JSON.stringify(impostor.body));
    console.log('PASS: only the actual holder\'s own signature authorizes a redeem');

    console.log('STEP 5: Node — a fungible balance is rejected (non-fungible only for now)');
    const gold = await issueAsset(NODE_BASE, holder.publicKey, 'atlas.element.gold', 5);
    const goldRedeem = await redeemAsHolder(NODE_BASE, holder, gold);
    assert(goldRedeem.status === 400 && /fungible/.test(goldRedeem.body.error), 'expected a fungible balance to be rejected, got: ' + JSON.stringify(goldRedeem.body));
    console.log('PASS: a fungible balance is rejected with:', goldRedeem.body.error);

    console.log('STEP 6: Node — a mismatched intent is rejected before anything is touched');
    const mismatched = await redeemAsHolder(NODE_BASE, holder, coupon2, { credentialId: coupon2.id, action: 'transfer' });
    assert(mismatched.status === 400 && /does not authorize redeeming/.test(mismatched.body.error), 'expected a mismatched intent to be rejected, got: ' + JSON.stringify(mismatched.body));
    const stillGood = await redeemAsHolder(NODE_BASE, holder, coupon2);
    assert(stillGood.status === 200, 'expected the untouched coupon to still redeem normally afterward, got: ' + JSON.stringify(stillGood.body));
    console.log('PASS: a mismatched intent is rejected without spending the credential');

    console.log('STEP 7: Node — the redeemed credential shows up on the public revocation list, same file business-demo.html\'s verify step reads');
    const revDoc = await fetch(NODE_BASE + '/.well-known/atlas-revocations.json').then((r) => r.json());
    const revokedIds = (revDoc.revoked || []).map((r) => r.id);
    assert(revokedIds.includes(coupon.id) && revokedIds.includes(badge.id) && revokedIds.includes(coupon2.id), 'expected every redeemed credential to appear on the public revocation list');
    console.log('PASS: redeemed credentials are on the same public list independent verification already checks');

    console.log('STEP 8: PHP — the same core behavior (successful redeem, replay rejection, bound credential redeemable) on an independent issuer-php bundle');
    const phpCoupon = await issueAsset(PHP_BASE, holder.publicKey, 'atlas.demo.coupon', 1);
    const phpRedeemed = await redeemAsHolder(PHP_BASE, holder, phpCoupon);
    assert(phpRedeemed.status === 200 && phpRedeemed.body.status === 'redeemed', 'expected PHP redeem to also succeed, got: ' + JSON.stringify(phpRedeemed.body));
    const phpAgain = await redeemAsHolder(PHP_BASE, holder, phpCoupon);
    assert(phpAgain.status === 400 && /already revoked/.test(phpAgain.body.error), 'expected PHP to reject a replayed redeem the same way, got: ' + JSON.stringify(phpAgain.body));
    const phpBadge = await issueAsset(PHP_BASE, holder.publicKey, 'atlas.badge', 1);
    const phpBadgeRedeemed = await redeemAsHolder(PHP_BASE, holder, phpBadge);
    assert(phpBadgeRedeemed.status === 200 && phpBadgeRedeemed.body.status === 'redeemed', 'expected PHP to also allow a bound badge to be redeemed by its own holder, got: ' + JSON.stringify(phpBadgeRedeemed.body));
    console.log('PASS: PHP matches Node for the successful redeem, the replay rejection, and the bound-credential case');

    console.log('\nALL ASSET REDEEM CHECKS PASSED');
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
