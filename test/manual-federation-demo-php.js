// PHP companion to test/manual-federation-demo.js — proves issuer-php's
// own send.php/relay.php/block.php/unblock.php port behaves identically
// to the Node version this new page (demo-domain-a/federation-demo.html)
// itself talks to, at the raw HTTP layer, following the same "two
// genuinely separate copies of issuer-php, each its own php -S instance"
// approach test/manual-federation-relay-php.js already established —
// federation is the one feature where a single PHP docroot's Host-header
// domain detection isn't enough, since the SIGNING KEY and every state
// file live at a fixed path relative to that one deployed copy (see that
// file's own comment for the full reasoning).
//
// Checks (same six as manual-federation-demo.js's Node version):
//   1. Alice joins the Post Office ONLY at Domain A, Bob ONLY at Domain B;
//      both register handles.
//   2. Alice sends through her own home domain (A) addressed to Bob's
//      home domain (B) — Domain A relays server-to-server, the relay
//      succeeds and hands back Domain B's own signed copy.
//   3. Bob's own direct mail check AT Domain B shows from.homeDomain ===
//      Domain A and from.handle === 'alice'.
//   4. The message independently verifies against Domain B's own
//      freshly-fetched published key.
//   5. Bob blocks Alice's key at Domain B — a retry is rejected, worded
//      no differently than "not a member here".
//   6. Bob removes the block — the identical send succeeds again
//      immediately.
//
// Not part of the permanent suite, same reasoning as every other
// manual-*.js script. Scratchpad-style: builds two throwaway copies of
// issuer-php under the OS temp dir at runtime and deletes them afterward
// — nothing here touches the real issuer-php/ tree.

const { spawn } = require('child_process');
const { webcrypto } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { subtle } = webcrypto;
const BUNDLE_DIR = path.resolve(__dirname, '..', 'issuer-php');
const PORT_A = 8187; // isolated port, distinct from every other manual-*-php.js test's own port
const PORT_B = 8188;
const DOMAIN_A = 'localhost:' + PORT_A;
const DOMAIN_B = 'localhost:' + PORT_B;
const BASE_A = 'http://' + DOMAIN_A;
const BASE_B = 'http://' + DOMAIN_B;

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
  return fetch(base + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(async (r) => ({ status: r.status, ok: r.ok, body: await r.json().catch(() => ({})) }));
}
async function issueAsset(base, ownerPublicKey, assetClass) {
  const res = await post(base, '/atlas/asset/issue', { ownerPublicKey, assetClass, quantity: 1 });
  if (!res.ok) throw new Error('Failed to issue ' + assetClass + ' at ' + base + ': ' + JSON.stringify(res.body));
  return res.body;
}
async function setHandle(base, identity, handle) {
  const payload = { handle };
  const proof = await signPayload(identity, payload);
  const res = await post(base, '/atlas/postoffice/handle', { payload, proof });
  if (!res.ok) throw new Error('Failed to set handle "' + handle + '" at ' + base + ': ' + JSON.stringify(res.body));
  return res.body;
}
async function sendMail(base, senderIdentity, toPublicKey, toDomain, subject, body) {
  const to = { publicKey: toPublicKey };
  if (toDomain) to.domain = toDomain;
  const payload = { to, subject, body };
  const proof = await signPayload(senderIdentity, payload);
  return post(base, '/atlas/postoffice/send', { payload, proof });
}
async function checkMail(base, identity, credential) {
  const payload = { action: 'mail-check', domain: new URL(base).host, credentialIds: [credential.id], issuedAt: new Date().toISOString(), nonce: b64url(webcrypto.getRandomValues(new Uint8Array(18))) };
  const proof = await signPayload(identity, payload);
  return post(base, '/atlas/mail/check', { credentials: [credential], payload, proof });
}
async function blockSender(base, identity, blockedPublicKey) {
  const payload = { blockedPublicKey };
  const proof = await signPayload(identity, payload);
  return post(base, '/atlas/postoffice/block', { payload, proof });
}
async function unblockSender(base, identity, blockedPublicKey) {
  const payload = { blockedPublicKey };
  const proof = await signPayload(identity, payload);
  return post(base, '/atlas/postoffice/unblock', { payload, proof });
}
async function verifyMailIndependently(base, message) {
  const keyDoc = await fetch(base + '/.well-known/atlas-key.json', { cache: 'no-store' }).then((r) => r.json());
  const sentAt = new Date(message.sentAt).getTime();
  const activeKey = (keyDoc.keys || []).find((k) => {
    const from = new Date(k.validFrom).getTime();
    const until = k.validUntil ? new Date(k.validUntil).getTime() : Infinity;
    return sentAt >= from && sentAt <= until;
  });
  if (!activeKey) return { valid: false, reason: 'no currently-valid key at sentAt' };
  const payload = { id: message.id, credentialId: message.credentialId, subject: message.subject, body: message.body, ...(message.from ? { from: message.from } : {}), sentAt: message.sentAt };
  const data = new TextEncoder().encode(canonicalize(payload));
  const publicKey = await subtle.importKey('raw', Buffer.from(activeKey.publicKey.replace(/-/g, '+').replace(/_/g, '/'), 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const sigBuf = Buffer.from(message.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const sigOk = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sigBuf, data);
  return { valid: sigOk, reason: sigOk ? 'signature checks out' : "signature doesn't match" };
}

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}

// Same PHP_CLI_SERVER_WORKERS=4 reasoning as manual-federation-relay-php.js:
// Domain A's own /atlas/postoffice/send blocks on its outbound call to
// Domain B's /relay, and Domain B's /relay in turn blocks on ITS OWN
// outbound call back to fetch Domain A's published key — a real reentrant
// two-way call that deadlocks under php -S's default single worker.
function startPhpServer(bundleDir, port) {
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-federation-demo-php-'));
  const bundleA = path.join(tmpRoot, 'domain-a');
  const bundleB = path.join(tmpRoot, 'domain-b');
  console.log('SETUP: copying issuer-php into two independent throwaway bundles (each grows its own keypair + state on first request)');
  fs.cpSync(BUNDLE_DIR, bundleA, { recursive: true });
  fs.cpSync(BUNDLE_DIR, bundleB, { recursive: true });

  let procA, procB;
  try {
    [procA, procB] = await Promise.all([startPhpServer(bundleA, PORT_A), startPhpServer(bundleB, PORT_B)]);
    console.log('PASS: PHP dev servers up — Domain A on ' + PORT_A + ', Domain B on ' + PORT_B);

    const alice = await generateIdentity();
    const bob = await generateIdentity();

    console.log('STEP 1: Alice joins the Post Office ONLY at Domain A, Bob ONLY at Domain B; both register handles');
    const aliceMembership = await issueAsset(BASE_A, alice.publicKey, 'atlas.postoffice.membership');
    const bobMembership = await issueAsset(BASE_B, bob.publicKey, 'atlas.postoffice.membership');
    await setHandle(BASE_A, alice, 'alice');
    await setHandle(BASE_B, bob, 'bob');
    console.log('PASS: Alice is a member only at ' + DOMAIN_A + ', Bob only at ' + DOMAIN_B);

    console.log('STEP 2: Alice sends through her own home domain (A), addressed to bob#' + DOMAIN_B);
    const sendRes = await sendMail(BASE_A, alice, bob.publicKey, DOMAIN_B, 'Hello from ' + DOMAIN_A, 'A real cross-domain message (PHP).');
    assert(sendRes.ok && sendRes.body.id, 'expected a successful relayed send, got: ' + JSON.stringify(sendRes.body));
    assert(sendRes.body.from && sendRes.body.from.homeDomain === DOMAIN_A, 'expected the relay response itself to already show from.homeDomain, got: ' + JSON.stringify(sendRes.body));
    console.log('PASS: Domain A relayed the message to Domain B without Alice ever joining Domain B');

    console.log('STEP 3: Bob checks his own mail DIRECTLY at Domain B, never routed through Domain A');
    const checkRes = await checkMail(BASE_B, bob, bobMembership);
    assert(checkRes.ok, 'mail check failed: ' + JSON.stringify(checkRes.body));
    const message = (checkRes.body.messages || []).find((m) => m.id === sendRes.body.id);
    assert(message, 'expected to find the relayed message in Bob\'s own mail check at Domain B');
    assert(message.from.publicKey === alice.publicKey, 'expected from.publicKey to be Alice\'s real key');
    assert(message.from.handle === 'alice', 'expected from.handle "alice", got: ' + message.from.handle);
    assert(message.from.homeDomain === DOMAIN_A, 'expected from.homeDomain to be ' + DOMAIN_A + ', got: ' + message.from.homeDomain);
    console.log('PASS: Domain B\'s own mail check correctly attributes the message to alice#' + DOMAIN_A);

    console.log('STEP 4: the message independently verifies against Domain B\'s own freshly-fetched published key');
    const verdict = await verifyMailIndependently(BASE_B, message);
    assert(verdict.valid, 'expected the message to independently verify, got: ' + verdict.reason);
    console.log('PASS:', verdict.reason);

    console.log('STEP 5: Bob blocks Alice\'s key at Domain B — a retry through the identical path is rejected');
    const blockRes = await blockSender(BASE_B, bob, alice.publicKey);
    assert(blockRes.ok, 'block failed: ' + JSON.stringify(blockRes.body));
    const blockedSend = await sendMail(BASE_A, alice, bob.publicKey, DOMAIN_B, 'Are you there?', 'trying again after the block');
    assert(!blockedSend.ok, 'expected the send to be rejected after Bob blocked Alice');
    assert(/not accepting mail from you/.test(blockedSend.body.error || ''), 'expected the same wording a plain non-member rejection uses, got: ' + JSON.stringify(blockedSend.body));
    console.log('PASS: rejected exactly like a plain "not a member" case ->', blockedSend.body.error);

    console.log('STEP 6: Bob removes the block — the identical send succeeds again immediately');
    const unblockRes = await unblockSender(BASE_B, bob, alice.publicKey);
    assert(unblockRes.ok, 'unblock failed: ' + JSON.stringify(unblockRes.body));
    const resend = await sendMail(BASE_A, alice, bob.publicKey, DOMAIN_B, 'One more try', 'should go through again now');
    assert(resend.ok && resend.body.id, 'expected the resend to succeed immediately after unblocking, got: ' + JSON.stringify(resend.body));
    console.log('PASS: delivered again immediately, no restart, nothing to clear');

    console.log('\nALL FEDERATION-DEMO PHP CHECKS PASSED against two real, independent issuer-php instances.');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (procA) procA.kill();
    if (procB) procB.kill();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) {}
  }
})();
