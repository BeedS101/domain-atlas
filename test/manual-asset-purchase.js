// Manual check for POST /atlas/asset/purchase and POST /atlas/asset/fulfill
// (SPEC.md §5.8/§5.9) — spending part of a fungible balance to acquire a
// fresh asset of a different class, atomically, and the admin-gated
// close that confirms it was handed over. Deliberately generic: the
// purchasable classes used below (atlas.demo.cafeteria.*) are just one
// example a catalog entry opts into with its own `purchase` field — the
// endpoint itself never sees "cafeteria" anywhere.
//
// Run at the HTTP layer directly against BOTH backends, same isolated-
// instance reasoning every other manual-*.js test in this project uses.
//
// Checks:
//   1. Node — buying a sandwich (price 5) out of a 10-credit balance debits
//      exactly 5 and mints a receipt, atomically, in one call.
//   2. Node — buying juice (price 2) out of the 5-credit remainder leaves 3.
//   3. Node — buying the snack (price 3) out of the exact 3-credit
//      remainder leaves no balance credential at all (spent to zero).
//   4. Node — insufficient balance is rejected before anything is touched.
//   5. Node — presenting the wrong currency class is rejected.
//   6. Node — a class with no `purchase` field (atlas.badge) cannot be
//      bought at all.
//   7. Node — a non-fungible purchase can only ever be quantity 1.
//   8. Node — a mismatched intent is rejected without touching the balance.
//   9. Node — fulfilling a genuine receipt succeeds and shows up on the
//      public revocation list; fulfilling it again is rejected.
//  10. Node — fulfill is admin-gated: a non-admin signer is rejected.
//  11. PHP — the same core behavior (atomic purchase, fulfill, replay
//      rejection) on an independent issuer-php bundle.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const NODE_PORT = 8131; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://localhost:' + NODE_PORT;
const PHP_PORT = 8132;
const PHP_BASE = 'http://localhost:' + PHP_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-purchase-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-purchase-docroot-'));
const PHP_BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-purchase-php-'));

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
async function purchase(base, buyer, credential, purchasedClass, quantity, payloadOverride) {
  const payload = payloadOverride || { credentialId: credential.id, purchasedClass, quantity, action: 'purchase' };
  const proof = await signWithSelf(buyer.kp, buyer.publicKey, payload);
  return postJson(base, '/atlas/asset/purchase', { credential, purchasedClass, quantity, intent: { payload, proof } });
}
async function fulfillAsAdmin(base, admin, credential) {
  const payload = { credential };
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  return postJson(base, '/atlas/asset/fulfill', { payload, proof });
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
    console.log('SETUP: minting a buyer, an admin, and a stranger identity; registering the admin on the Node roster');
    const buyer = await genIdentity();
    const admin = await genIdentity();
    const stranger = await genIdentity();
    fs.writeFileSync(path.join(NODE_STATE_DIR, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));

    console.log('STEP 1: Node — buying a sandwich (price 5) out of a 10-credit balance debits exactly 5 and mints a receipt atomically');
    let balance = await issueAsset(NODE_BASE, buyer.publicKey, 'atlas.credit.balance', 10);
    let res = await purchase(NODE_BASE, buyer, balance, 'atlas.demo.cafeteria.sandwich', 1);
    assert(res.status === 200, 'expected the sandwich purchase to succeed, got: ' + JSON.stringify(res.body));
    assert(res.body.balance && res.body.balance.quantity === 5, 'expected a 5-credit remainder, got: ' + JSON.stringify(res.body.balance));
    assert(res.body.purchased.asset.class === 'atlas.demo.cafeteria.sandwich' && res.body.purchased.owner.publicKey === buyer.publicKey, 'expected a sandwich receipt owned by the buyer');
    const sandwichReceipt = res.body.purchased;
    balance = res.body.balance;
    console.log('PASS: 10 -> 5 credits, sandwich receipt minted ->', sandwichReceipt.id);

    console.log('STEP 2: Node — buying juice (price 2) out of the 5-credit remainder leaves 3');
    res = await purchase(NODE_BASE, buyer, balance, 'atlas.demo.cafeteria.juice', 1);
    assert(res.status === 200 && res.body.balance.quantity === 3, 'expected a 3-credit remainder, got: ' + JSON.stringify(res.body));
    balance = res.body.balance;
    console.log('PASS: 5 -> 3 credits');

    console.log('STEP 3: Node — buying the snack (price 3) out of the exact 3-credit remainder spends it to zero, no balance credential left');
    res = await purchase(NODE_BASE, buyer, balance, 'atlas.demo.cafeteria.snack', 1);
    assert(res.status === 200 && res.body.balance === null, 'expected no remainder balance when spent to exactly zero, got: ' + JSON.stringify(res.body.balance));
    const snackReceipt = res.body.purchased;
    console.log('PASS: 3 -> 0 credits, balance is null, snack receipt minted ->', snackReceipt.id);

    console.log('STEP 4: Node — insufficient balance is rejected (nothing left to spend)');
    const freshOneCredit = await issueAsset(NODE_BASE, buyer.publicKey, 'atlas.credit.balance', 1);
    res = await purchase(NODE_BASE, buyer, freshOneCredit, 'atlas.demo.cafeteria.sandwich', 1);
    assert(res.status === 400 && /insufficient/.test(res.body.error), 'expected an insufficient-balance rejection, got: ' + JSON.stringify(res.body));
    console.log('PASS: insufficient balance rejected with:', res.body.error);

    console.log('STEP 5: Node — presenting the wrong currency class is rejected');
    const gold = await issueAsset(NODE_BASE, buyer.publicKey, 'atlas.element.gold', 50);
    res = await purchase(NODE_BASE, buyer, gold, 'atlas.demo.cafeteria.sandwich', 1);
    assert(res.status === 400 && /wrong class to pay with/.test(res.body.error), 'expected a wrong-currency rejection, got: ' + JSON.stringify(res.body));
    console.log('PASS: wrong currency class rejected with:', res.body.error);

    console.log('STEP 6: Node — a class with no `purchase` field cannot be bought at all');
    const bigBalance = await issueAsset(NODE_BASE, buyer.publicKey, 'atlas.credit.balance', 1000);
    res = await purchase(NODE_BASE, buyer, bigBalance, 'atlas.badge', 1);
    assert(res.status === 400 && /not for sale/.test(res.body.error), 'expected a not-for-sale rejection, got: ' + JSON.stringify(res.body));
    console.log('PASS: a non-purchasable class rejected with:', res.body.error);

    console.log('STEP 7: Node — a non-fungible purchase can only ever be quantity 1');
    res = await purchase(NODE_BASE, buyer, bigBalance, 'atlas.demo.cafeteria.sandwich', 3);
    assert(res.status === 400 && /quantity 1/.test(res.body.error), 'expected a quantity-1-only rejection, got: ' + JSON.stringify(res.body));
    console.log('PASS: a non-fungible purchase at quantity 3 rejected with:', res.body.error);

    console.log('STEP 8: Node — a mismatched intent is rejected without touching the balance');
    res = await purchase(NODE_BASE, buyer, bigBalance, 'atlas.demo.cafeteria.sandwich', 1, { credentialId: bigBalance.id, purchasedClass: 'atlas.demo.cafeteria.juice', quantity: 1, action: 'purchase' });
    assert(res.status === 400 && /does not authorize/.test(res.body.error), 'expected a mismatched-intent rejection, got: ' + JSON.stringify(res.body));
    const stillGood = await purchase(NODE_BASE, buyer, bigBalance, 'atlas.demo.cafeteria.sandwich', 1);
    assert(stillGood.status === 200 && stillGood.body.balance.quantity === 995, 'expected the untouched balance to still spend normally afterward, got: ' + JSON.stringify(stillGood.body));
    console.log('PASS: a mismatched intent is rejected without spending the presented balance');

    console.log('STEP 9: Node — fulfilling a genuine receipt succeeds and shows up on the public revocation list; fulfilling it again is rejected');
    const fulfilled = await fulfillAsAdmin(NODE_BASE, admin, sandwichReceipt);
    assert(fulfilled.status === 200 && fulfilled.body.status === 'fulfilled' && fulfilled.body.id === sandwichReceipt.id, 'expected the sandwich receipt to be fulfilled, got: ' + JSON.stringify(fulfilled.body));
    const revDoc = await fetch(NODE_BASE + '/.well-known/atlas-revocations.json').then((r) => r.json());
    assert((revDoc.revoked || []).some((r) => r.id === sandwichReceipt.id), 'expected the fulfilled receipt to appear on the public revocation list');
    const fulfilledAgain = await fulfillAsAdmin(NODE_BASE, admin, sandwichReceipt);
    assert(fulfilledAgain.status === 400 && /already revoked or already fulfilled/.test(fulfilledAgain.body.error), 'expected a second fulfill attempt to be rejected, got: ' + JSON.stringify(fulfilledAgain.body));
    console.log('PASS: fulfillment revokes the receipt (visible on the public list) and cannot be repeated');

    console.log('STEP 10: Node — fulfill is admin-gated: a non-admin signer is rejected');
    const notAdmin = await fulfillAsAdmin(NODE_BASE, stranger, snackReceipt);
    assert(notAdmin.status === 401, 'expected a non-admin fulfill attempt to be rejected with 401, got: ' + JSON.stringify(notAdmin));
    console.log('PASS: a non-admin signer cannot fulfill anything');

    console.log('STEP 11: PHP — the same core behavior (atomic purchase, fulfill, replay rejection) on an independent issuer-php bundle');
    fs.writeFileSync(path.join(PHP_BUNDLE_DIR, 'lib', 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
    const phpBalance = await issueAsset(PHP_BASE, buyer.publicKey, 'atlas.credit.balance', 5);
    const phpPurchase = await purchase(PHP_BASE, buyer, phpBalance, 'atlas.demo.cafeteria.juice', 1);
    assert(phpPurchase.status === 200 && phpPurchase.body.balance.quantity === 3, 'expected PHP purchase to debit the same way, got: ' + JSON.stringify(phpPurchase.body));
    const phpFulfilled = await fulfillAsAdmin(PHP_BASE, admin, phpPurchase.body.purchased);
    assert(phpFulfilled.status === 200 && phpFulfilled.body.status === 'fulfilled', 'expected PHP fulfill to also succeed, got: ' + JSON.stringify(phpFulfilled.body));
    const phpFulfilledAgain = await fulfillAsAdmin(PHP_BASE, admin, phpPurchase.body.purchased);
    assert(phpFulfilledAgain.status === 400 && /already revoked or already fulfilled/.test(phpFulfilledAgain.body.error), 'expected PHP to reject a repeated fulfill the same way, got: ' + JSON.stringify(phpFulfilledAgain.body));
    console.log('PASS: PHP matches Node for the atomic purchase, the fulfill, and the replay rejection');

    console.log('\nALL ASSET PURCHASE/FULFILL CHECKS PASSED');
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
