// Manual check for POST /atlas/asset/transfer — a direct, one-sided send
// of a held non-fungible credential to a named recipient's public key, no
// listing, no matching counter-offer, and no admin involved: just the
// holder's own signature authorizing exactly that one move. Built for the
// standalone business demo (demo-domain-a/business-demo.html), which
// issues a visitor a giftable coupon (atlas.demo.coupon) alongside a
// non-transferable badge (atlas.badge) and lets them try sending each to a
// second, page-local identity standing in for "a friend" — the same
// "second local keypair in one browser tab" demo device
// extension/wallet.js's own counterparty already uses for its own §5.2
// loss demo, just reused here for a real, domain-recognized transfer
// instead of a purely local one.
//
// Run at the HTTP layer directly against BOTH backends, same isolated-
// instance reasoning every other manual-*.js test in this project uses.
//
// Checks:
//   1. Node — transferring a giftable (non-bound) credential mints a fresh
//      one for the recipient with the exact same asset state, and revokes
//      the sender's old credential.
//   2. Node — the sender's old, now-revoked credential can't be
//      transferred again.
//   3. Node — a bound credential (atlas.badge) cannot be transferred at
//      all — rejected with a plain-English reason, and stays untouched.
//   4. Node — someone who doesn't actually hold the credential (a signer
//      whose key doesn't match credential.owner.publicKey) can't
//      transfer it.
//   5. Node — sending a credential to yourself is rejected.
//   6. Node — an intent whose signed recipientPublicKey doesn't match the
//      request's own recipientPublicKey is rejected before anything is
//      touched.
//   7. PHP — the same core behavior (successful transfer, bound rejection)
//      on an independent issuer-php bundle.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const NODE_PORT = 8124; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://localhost:' + NODE_PORT;
const PHP_PORT = 8125;
const PHP_BASE = 'http://localhost:' + PHP_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-transfer-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-transfer-docroot-'));
const PHP_BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-transfer-php-'));

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
async function transferAsSender(base, sender, credential, recipientPublicKey, payloadOverride) {
  const payload = payloadOverride || { credentialId: credential.id, recipientPublicKey, action: 'transfer' };
  const proof = await signWithSelf(sender.kp, sender.publicKey, payload);
  return postJson(base, '/atlas/asset/transfer', { credential, recipientPublicKey, intent: { payload, proof } });
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
    console.log('SETUP: minting a sender and a recipient identity');
    const sender = await genIdentity();
    const friend = await genIdentity();
    const stranger = await genIdentity();

    console.log('STEP 1: Node — transferring a giftable coupon mints a fresh credential for the recipient, preserving its asset state');
    const coupon = await issueAsset(NODE_BASE, sender.publicKey, 'atlas.demo.coupon', 1);
    const sent = await transferAsSender(NODE_BASE, sender, coupon, friend.publicKey);
    assert(sent.status === 200, 'expected the coupon transfer to succeed, got: ' + JSON.stringify(sent.body));
    assert(sent.body.credential.owner.publicKey === friend.publicKey, 'expected the new credential to belong to the recipient');
    assert(sent.body.credential.asset.class === 'atlas.demo.coupon', 'expected the transferred credential to keep its class');
    assert(sent.body.credential.asset.properties['com.example.discount'] === coupon.asset.properties['com.example.discount'], 'expected the exact per-instance properties to survive the transfer');
    assert(sent.body.credential.supersedes === coupon.id, 'expected the new credential to name the old one as superseded');
    console.log('PASS: a giftable coupon transfers to the recipient with its properties intact ->', coupon.id, '->', sent.body.credential.id);

    console.log('STEP 2: Node — the sender\'s old, now-revoked credential can\'t be transferred again');
    const again = await transferAsSender(NODE_BASE, sender, coupon, stranger.publicKey);
    assert(again.status === 400 && /already revoked/.test(again.body.error), 'expected the already-spent coupon to be rejected as revoked, got: ' + JSON.stringify(again.body));
    console.log('PASS: a spent transfer cannot be replayed');

    console.log('STEP 3: Node — a bound credential (the badge) cannot be transferred at all');
    const badge = await issueAsset(NODE_BASE, sender.publicKey, 'atlas.badge', 1);
    const badgeSend = await transferAsSender(NODE_BASE, sender, badge, friend.publicKey);
    assert(badgeSend.status === 400 && /bound to its owner and cannot be sent/.test(badgeSend.body.error), 'expected the bound badge to be rejected with a plain-English reason, got: ' + JSON.stringify(badgeSend.body));
    console.log('PASS: a bound badge stays put, rejected with:', badgeSend.body.error);

    console.log('STEP 4: Node — a signer who does not actually hold the credential cannot transfer it');
    const coupon2 = await issueAsset(NODE_BASE, sender.publicKey, 'atlas.demo.coupon', 1);
    const impostor = await transferAsSender(NODE_BASE, stranger, coupon2, friend.publicKey);
    assert(impostor.status === 400 && /does not belong to this signer/.test(impostor.body.error), 'expected a non-owner signer to be rejected, got: ' + JSON.stringify(impostor.body));
    console.log('PASS: only the actual holder\'s own signature authorizes a transfer');

    console.log('STEP 5: Node — sending a credential to yourself is rejected');
    const selfSend = await transferAsSender(NODE_BASE, sender, coupon2, sender.publicKey);
    assert(selfSend.status === 400 && /cannot transfer a credential to yourself/.test(selfSend.body.error), 'expected a self-transfer to be rejected, got: ' + JSON.stringify(selfSend.body));
    console.log('PASS: a self-transfer is rejected outright');

    console.log('STEP 6: Node — an intent that does not name the request\'s own recipient is rejected before anything is touched');
    const mismatched = await transferAsSender(NODE_BASE, sender, coupon2, friend.publicKey, { credentialId: coupon2.id, recipientPublicKey: stranger.publicKey, action: 'transfer' });
    assert(mismatched.status === 400 && /does not authorize transferring/.test(mismatched.body.error), 'expected a mismatched intent to be rejected, got: ' + JSON.stringify(mismatched.body));
    const stillGood = await transferAsSender(NODE_BASE, sender, coupon2, friend.publicKey);
    assert(stillGood.status === 200, 'expected the untouched coupon to still transfer normally afterward, got: ' + JSON.stringify(stillGood.body));
    console.log('PASS: a mismatched intent is rejected without spending the credential');

    console.log('STEP 7: PHP — the same core behavior (successful transfer, bound rejection) on an independent issuer-php bundle');
    const phpCoupon = await issueAsset(PHP_BASE, sender.publicKey, 'atlas.demo.coupon', 1);
    const phpSent = await transferAsSender(PHP_BASE, sender, phpCoupon, friend.publicKey);
    assert(phpSent.status === 200 && phpSent.body.credential.owner.publicKey === friend.publicKey, 'expected PHP transfer to also succeed, got: ' + JSON.stringify(phpSent.body));
    const phpBadge = await issueAsset(PHP_BASE, sender.publicKey, 'atlas.badge', 1);
    const phpBadgeSend = await transferAsSender(PHP_BASE, sender, phpBadge, friend.publicKey);
    assert(phpBadgeSend.status === 400 && /bound to its owner and cannot be sent/.test(phpBadgeSend.body.error), 'expected PHP to reject the bound badge the same way, got: ' + JSON.stringify(phpBadgeSend.body));
    console.log('PASS: PHP matches Node for both the successful transfer and the bound rejection');

    console.log('\nALL ASSET TRANSFER CHECKS PASSED');
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
