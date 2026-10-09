// Manual, end-to-end check for recall-demo.html against issuer-php — same
// "real HTTP calls against PHP's built-in dev server, no mocking" pattern
// as manual-oracle-demo-php.js; this feature's own Node-side companion is
// manual-recall-demo.js. Not part of the permanent suite, same reasoning
// as the other manual-*.js scripts.
//
// Covers the same eight checks as the Node version, at the HTTP layer:
// mint, two resales, a full provenance trace, a class-wide recall, a
// tampered check-in silently ignored, a genuine check-in that lands the
// recall (and independently verifies), and a resale of the now-bound
// widget rejected.

const { spawn } = require('child_process');
const { webcrypto } = require('crypto');
const fs = require('fs');
const path = require('path');

const { subtle } = webcrypto;
const PORT = 8197; // isolated — distinct from every other manual-*.js/-php.js test's chosen port
const BASE = 'http://localhost:' + PORT;
const BUNDLE_DIR = path.resolve(__dirname, '..', 'issuer-php');
const WIDGET_CLASS = 'atlas.demo.supplychain.widget';

const GENERATED_FILES = [
  path.resolve(BUNDLE_DIR, 'lib', 'issuer-private-key.pem'),
  path.resolve(BUNDLE_DIR, '.well-known', 'atlas-key.json'),
  path.resolve(BUNDLE_DIR, '.well-known', 'atlas-revocations.json'),
  path.resolve(BUNDLE_DIR, 'lib', 'atlas-asset-history-store.json'),
  path.resolve(BUNDLE_DIR, 'lib', 'atlas-asset-updates-store.json'),
  path.resolve(BUNDLE_DIR, 'lib', 'atlas-class-patches-store.json'),
];
function cleanGeneratedFiles() {
  for (const f of GENERATED_FILES) { try { fs.unlinkSync(f); } catch (err) {} }
  try { fs.rmdirSync(path.resolve(BUNDLE_DIR, '.well-known')); } catch (err) {}
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}
async function genIdentity() {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rawPublic = await subtle.exportKey('raw', pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: b64url(rawPublic) };
}
async function signPayload(identity, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, data);
  return { signerRole: 'raw-ecdsa', publicKey: identity.publicKey, signature: b64url(sig) };
}
function post(urlPath, body) {
  return fetch(BASE + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
}
function get(urlPath) {
  return fetch(BASE + urlPath, { cache: 'no-store' }).then(async (r) => ({ status: r.status, body: await r.json() }));
}
function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}
async function mintWidget(ownerPublicKey) {
  return post('/atlas/asset/issue', { ownerPublicKey, assetClass: WIDGET_CLASS });
}
async function transferWidget(identity, credential, recipientPublicKey) {
  const payload = { credentialId: credential.id, recipientPublicKey, action: 'transfer' };
  const proof = await signPayload(identity, payload);
  return post('/atlas/asset/transfer', { credential, recipientPublicKey, intent: { payload, proof } });
}
async function issueRecall(reason) {
  return post('/atlas/demo/recall/issue', { assetClass: WIDGET_CLASS, reason });
}
async function checkIn(who, credential) {
  const payload = { action: 'mail-check', domain: new URL(BASE).host, credentialIds: [credential.id], issuedAt: new Date().toISOString(), nonce: b64url(webcrypto.getRandomValues(new Uint8Array(18))) };
  const proof = await signPayload(who, payload);
  return post('/atlas/mail/check', { credentials: [credential], payload, proof });
}
async function verifyAssetCredentialIndependently(credential) {
  const keyDoc = await fetch(BASE + '/.well-known/atlas-key.json', { cache: 'no-store' }).then((r) => r.json());
  const issuedAt = new Date(credential.issuedAt).getTime();
  const activeKey = (keyDoc.keys || []).find((k) => {
    const from = new Date(k.validFrom).getTime();
    const until = k.validUntil ? new Date(k.validUntil).getTime() : Infinity;
    return issuedAt >= from && issuedAt <= until;
  });
  if (!activeKey) return { valid: false, reason: 'no currently-valid key at issuedAt' };
  const payload = {
    id: credential.id, asset: credential.asset, owner: credential.owner,
    quantity: credential.quantity, supersedes: credential.supersedes, issuedAt: credential.issuedAt
  };
  const data = new TextEncoder().encode(canonicalize(payload));
  const publicKey = await subtle.importKey('raw', Buffer.from(activeKey.publicKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const sigBuf = Buffer.from(credential.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const sigOk = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sigBuf, data);
  return { valid: sigOk, reason: sigOk ? 'signature checks out' : "signature doesn't match" };
}

(async () => {
  console.log('SETUP: starting PHP\'s built-in dev server against issuer-php/test-router.php');
  cleanGeneratedFiles();
  const serverProc = spawn('php', ['-S', 'localhost:' + PORT, 'test-router.php'], { cwd: BUNDLE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
    serverProc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
  });
  console.log('PASS: PHP dev server up on port ' + PORT);

  try {
    console.log('STEP 1: mint a widget to a fresh Distributor identity');
    const distributor = await genIdentity();
    const mintRes = await mintWidget(distributor.publicKey);
    assert(mintRes.status === 200, 'mint failed: ' + JSON.stringify(mintRes.body));
    let widget = mintRes.body;
    assert(widget.asset.class === WIDGET_CLASS, 'unexpected widget class');
    assert(widget.asset.tradeScope !== 'bound', 'a freshly minted widget should not start out bound');
    console.log('PASS: widget', widget.id, 'minted to the Distributor');

    console.log('STEP 2: transfer Distributor -> Retailer -> Customer');
    const retailer = await genIdentity();
    const transfer1 = await transferWidget(distributor, widget, retailer.publicKey);
    assert(transfer1.status === 200, 'first transfer failed: ' + JSON.stringify(transfer1.body));
    widget = transfer1.body.credential;
    assert(widget.owner.publicKey === retailer.publicKey, 'widget should now belong to the Retailer');

    const customer = await genIdentity();
    const transfer2 = await transferWidget(retailer, widget, customer.publicKey);
    assert(transfer2.status === 200, 'second transfer failed: ' + JSON.stringify(transfer2.body));
    widget = transfer2.body.credential;
    assert(widget.owner.publicKey === customer.publicKey, 'widget should now belong to the Customer');
    console.log('PASS: widget', widget.id, 'now held by the Customer, after two resales');

    console.log('STEP 3: trace the widget\'s full provenance back to the original mint');
    const historyRes = await get('/atlas/asset/history?id=' + encodeURIComponent(widget.supersedes));
    assert(historyRes.status === 200, 'history lookup failed: ' + JSON.stringify(historyRes.body));
    const chain = historyRes.body.chain;
    assert(Array.isArray(chain) && chain.length === 2, 'expected a two-link chain (the original mint + the first transfer), got: ' + JSON.stringify(chain));
    assert(chain[0].owner.publicKey === distributor.publicKey, 'oldest link should be the Distributor\'s original mint');
    assert(chain[0].supersedes === null, 'the original mint should supersede nothing');
    assert(chain[1].owner.publicKey === retailer.publicKey, 'second link should be the Retailer\'s credential');
    console.log('PASS: chain of', chain.length, 'links, oldest-first, walks back to the original mint');

    console.log('STEP 4: the manufacturer issues a recall against the whole class');
    const recallRes = await issueRecall('battery-defect');
    assert(recallRes.status === 200, 'recall issuance failed: ' + JSON.stringify(recallRes.body));
    assert(recallRes.body.patch.tradeScope === 'bound', 'recall patch should set tradeScope to bound');
    assert(/fire risk/.test(recallRes.body.patch.properties['com.example.recallNotice']), 'unexpected recall notice text');
    console.log('PASS: class patch recorded —', recallRes.body.patch.properties['com.example.recallNotice']);

    console.log('STEP 5: a tampered copy of the still-stale Customer credential is silently ignored at check-in');
    const tampered = JSON.parse(JSON.stringify(widget));
    tampered.asset.properties = Object.assign({}, tampered.asset.properties, { 'com.example.batch': 'tampered-batch-99' });
    const tamperCheckin = await checkIn(customer, tampered);
    assert(tamperCheckin.status === 200, 'check-in call itself should not fail: ' + JSON.stringify(tamperCheckin.body));
    const tamperUpdate = (tamperCheckin.body.updates || []).find((u) => u.id === widget.id);
    assert(!tamperUpdate, 'a tampered credential should never get an update applied, got: ' + JSON.stringify(tamperUpdate));
    console.log('PASS: tampered check-in produced no update — the bad signature was caught, nothing trusted');

    console.log('STEP 6: the genuine, untouched credential picks up the recall on check-in');
    const realCheckin = await checkIn(customer, widget);
    assert(realCheckin.status === 200, 'real check-in failed: ' + JSON.stringify(realCheckin.body));
    const realUpdate = (realCheckin.body.updates || []).find((u) => u.id === widget.id);
    assert(realUpdate && realUpdate.newCredential, 'expected a real update for the genuine credential, got: ' + JSON.stringify(realCheckin.body));
    widget = realUpdate.newCredential;
    assert(widget.asset.tradeScope === 'bound', 'the reissued widget should now be bound');
    assert(/fire risk/.test(widget.asset.properties['com.example.recallNotice']), 'reissued widget should carry the recall notice');
    console.log('PASS: reissued as', widget.id, '— bound, carrying the recall notice');

    console.log('STEP 7: independently verify the reissued, recalled widget credential');
    const verdict = await verifyAssetCredentialIndependently(widget);
    assert(verdict.valid, 'expected the reissued widget to independently verify, got: ' + verdict.reason);
    console.log('PASS:', verdict.reason);

    console.log('STEP 8: reselling the now-bound widget is rejected');
    const stranger = await genIdentity();
    const resaleRes = await transferWidget(customer, widget, stranger.publicKey);
    assert(resaleRes.status === 400, 'expected the resale of a bound widget to be rejected, got status ' + resaleRes.status);
    assert(/bound to its owner/.test(resaleRes.body.error || ''), 'unexpected resale rejection text: ' + JSON.stringify(resaleRes.body));
    console.log('PASS: rejected ->', resaleRes.body.error);

    console.log('\nALL RECALL-DEMO CHECKS PASSED against a real PHP dev server.');
  } finally {
    serverProc.kill();
    cleanGeneratedFiles();
  }
})().catch((err) => {
  console.error('FAIL:', err.message);
  process.exitCode = 1;
});
