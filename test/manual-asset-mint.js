// Manual check for POST /atlas/asset/mint — the admin-gated sibling of the
// ungated /atlas/asset/issue, built for demo-domain-a/warranty-demo.html:
// an authenticated operator minting a credential with its own explicit
// starting facts (a factory stamping a real serial number at manufacture
// time) instead of every unit of a class coming out identical. Run at the
// HTTP layer directly against BOTH backends, same isolated-instance
// reasoning every other manual-*.js test in this project uses.
//
// Checks:
//   1. Node — a non-admin request (no proof, no token) is rejected.
//   2. Node — an admin mint with a properties patch merges it onto the
//      catalog's own base properties, and the credential is genuinely
//      signed by this issuer.
//   3. Node — an unknown assetClass is rejected.
//   4. Node — a non-object properties value is rejected.
//   5. Node — fungible/non-fungible quantity rules match /atlas/asset/issue
//      (a positive integer required for fungible; 1 or omitted otherwise).
//   6. Node — the ordinary self-serve /atlas/asset/issue is completely
//      unaffected: minting the same class ungated still carries no
//      per-instance properties at all.
//   7. PHP — the same admin-mint-with-properties and non-admin-rejection
//      behavior on an independent issuer-php bundle.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { withAdminAuth } = require('./lib/admin-auth');
const { subtle } = webcrypto;

const NODE_PORT = 8140; // isolated — distinct from every other manual-*.js test's chosen port
const NODE_DOMAIN = 'localhost:' + NODE_PORT;
const NODE_BASE = 'http://localhost:' + NODE_PORT;
const PHP_PORT = 8141;
const PHP_BASE = 'http://localhost:' + PHP_PORT;

const NODE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mint-node-'));
const NODE_DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mint-docroot-'));
const PHP_BUNDLE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-mint-php-'));

function postJson(base, urlPath, body) {
  return fetch(base + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}
function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
async function issueAsset(base, ownerPublicKey, assetClass, quantity) {
  const res = await postJson(base, '/atlas/asset/issue', { ownerPublicKey, assetClass, ...(quantity !== undefined ? { quantity } : {}) });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ' at ' + base + ': ' + JSON.stringify(res.body));
  return res.body;
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
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}
async function adminMint(base, admin, mintPayload) {
  mintPayload = withAdminAuth(mintPayload, base, '/atlas/asset/mint');
  const proof = await signWithSelf(admin.kp, admin.publicKey, mintPayload);
  return postJson(base, '/atlas/asset/mint', { payload: mintPayload, proof });
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
    console.log('SETUP: minting a holder identity; registering a Node admin');
    const holder = await genIdentity();
    const admin = await genIdentity();
    fs.writeFileSync(path.join(NODE_STATE_DIR, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));

    console.log('STEP 1: Node — a non-admin request is rejected');
    const noAuth = await postJson(NODE_BASE, '/atlas/asset/mint', { payload: { ownerPublicKey: holder.publicKey, assetClass: 'atlas.demo.warranty.certificate' } });
    assert(noAuth.status === 401, 'expected a 401 with no admin proof, got: ' + JSON.stringify(noAuth.body));
    console.log('PASS: minting with no admin proof is rejected —', noAuth.body.error);

    console.log('STEP 2: Node — an admin mint with a properties patch merges onto the catalog defaults and is genuinely signed by this issuer');
    const mintPayload = { ownerPublicKey: holder.publicKey, assetClass: 'atlas.demo.warranty.certificate', properties: { 'com.example.serialNumber': 'SN-0001' } };
    const minted = await adminMint(NODE_BASE, admin, mintPayload);
    assert(minted.status === 200, 'expected the admin mint to succeed, got: ' + JSON.stringify(minted.body));
    assert(minted.body.asset.properties['com.example.serialNumber'] === 'SN-0001', 'expected the serial number property to be set, got: ' + JSON.stringify(minted.body.asset));
    assert(minted.body.owner.publicKey === holder.publicKey, 'expected the credential to be owned by the requested owner');
    const verifyPayload = { id: minted.body.id, asset: minted.body.asset, owner: minted.body.owner, quantity: minted.body.quantity, supersedes: minted.body.supersedes, issuedAt: minted.body.issuedAt };
    const nodeKeyDoc = await fetch(NODE_BASE + '/.well-known/atlas-key.json').then((r) => r.json());
    const issuerKey = await subtle.importKey('raw', Buffer.from(nodeKeyDoc.keys[0].publicKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    const sigOk = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, issuerKey, Buffer.from(minted.body.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'), new TextEncoder().encode(canonicalize(verifyPayload)));
    assert(sigOk, 'expected the admin-minted credential to carry a genuine issuer signature');
    console.log('PASS: admin mint carries the requested serial number and a real issuer signature —', minted.body.id);

    console.log('STEP 3: Node — an unknown assetClass is rejected');
    const badClass = await adminMint(NODE_BASE, admin, { ownerPublicKey: holder.publicKey, assetClass: 'atlas.does.not.exist' });
    assert(badClass.status === 400 && /Unknown assetClass/.test(badClass.body.error), 'expected an unknown-class rejection, got: ' + JSON.stringify(badClass.body));
    console.log('PASS: an unknown assetClass is rejected —', badClass.body.error);

    console.log('STEP 4: Node — a non-object properties value is rejected');
    const badProps = await adminMint(NODE_BASE, admin, { ownerPublicKey: holder.publicKey, assetClass: 'atlas.demo.warranty.certificate', properties: 'not-an-object' });
    assert(badProps.status === 400 && /must be a patch object/.test(badProps.body.error), 'expected a bad-properties rejection, got: ' + JSON.stringify(badProps.body));
    console.log('PASS: a non-object properties value is rejected —', badProps.body.error);

    console.log('STEP 5: Node — fungible/non-fungible quantity rules match /atlas/asset/issue');
    const badQty = await adminMint(NODE_BASE, admin, { ownerPublicKey: holder.publicKey, assetClass: 'atlas.demo.warranty.certificate', quantity: 3 });
    assert(badQty.status === 400 && /quantity must be 1/.test(badQty.body.error), 'expected a non-fungible quantity rejection, got: ' + JSON.stringify(badQty.body));
    const goodFungible = await adminMint(NODE_BASE, admin, { ownerPublicKey: holder.publicKey, assetClass: 'atlas.credit.balance', quantity: 5, properties: { 'com.example.grantReason': 'test' } });
    assert(goodFungible.status === 200 && goodFungible.body.quantity === 5 && goodFungible.body.asset.properties['com.example.grantReason'] === 'test', 'expected a fungible admin mint with a quantity and a properties patch to succeed, got: ' + JSON.stringify(goodFungible.body));
    console.log('PASS: quantity rules match issue, and a fungible class also accepts a properties patch');

    console.log('STEP 6: Node — the ordinary self-serve /atlas/asset/issue is completely unaffected');
    const selfMinted = await issueAsset(NODE_BASE, holder.publicKey, 'atlas.demo.warranty.certificate');
    assert(selfMinted.asset.properties === undefined, 'expected a self-serve mint to carry no per-instance properties at all, got: ' + JSON.stringify(selfMinted.asset));
    console.log('PASS: /atlas/asset/issue is unaffected by the new endpoint existing');

    console.log('STEP 7: PHP — the same admin-mint-with-properties and non-admin-rejection behavior on an independent issuer-php bundle');
    fs.writeFileSync(path.join(PHP_BUNDLE_DIR, 'lib', 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }, null, 2));
    const phpHolder = await genIdentity();
    const phpNoAuth = await postJson(PHP_BASE, '/atlas/asset/mint', { payload: { ownerPublicKey: phpHolder.publicKey, assetClass: 'atlas.demo.warranty.certificate' } });
    assert(phpNoAuth.status === 401, 'expected PHP to reject a non-admin mint too, got: ' + JSON.stringify(phpNoAuth.body));
    const phpMinted = await adminMint(PHP_BASE, admin, { ownerPublicKey: phpHolder.publicKey, assetClass: 'atlas.demo.warranty.certificate', properties: { 'com.example.serialNumber': 'SN-PHP-0001' } });
    assert(phpMinted.status === 200 && phpMinted.body.asset.properties['com.example.serialNumber'] === 'SN-PHP-0001', 'expected PHP to accept the admin mint with the serial number, got: ' + JSON.stringify(phpMinted.body));
    console.log('PASS: PHP matches Node for admin-gating and the properties patch —', phpMinted.body.id);

    console.log('\nALL ASSET MINT CHECKS PASSED');
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
