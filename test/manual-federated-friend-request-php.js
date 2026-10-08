// PHP-backend check for friend requests by handle (see
// manual-federated-friend-request.js for the full wallet journey on Node).
// A friend request is ordinary Post Office mail with a reserved subject
// (extension/wallet.js FRIEND_SUBJECT_MARKER, which starts with a NUL
// character), so the PHP issuer needs no new endpoint; what this proves is
// that issuer-php carries that subject and a JSON body across a relay
// intact, signs it so a wallet's verifyMailMessage() accepts it, and does it
// in both directions (the request, then the acceptance back).
//
// Two independent copies of issuer-php run on their own ports, as in
// manual-federation-relay-php.js.
//
// Checks:
//   1. Alice (member only at Domain A) sends a friend-request message to Bob
//      (member only at Domain B): relayed, stored with the exact subject and
//      body, and attributed to alice#Domain A.
//   2. Bob's mail check returns it with a signature that verifies against
//      Domain B's published key, NUL character and all.
//   3. Bob answers with an 'accepted' notice through his own Post Office,
//      addressed to Alice's home domain; Alice's mail check returns that too.
//   4. A recipient who has blocked the sender gets the same refusal as for
//      any other mail.
//
// Not part of the permanent suite, same as the other manual-*.js scripts.

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

// ---------- crypto + HTTP helpers — identical to manual-trade-submit-php.js's own ----------

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

async function issueAsset(base, ownerPublicKey, assetClass, quantity) {
  const res = await post(base, '/atlas/asset/issue', { ownerPublicKey, assetClass, quantity });
  if (res.status !== 200) throw new Error('Failed to issue ' + assetClass + ' at ' + base + ': ' + JSON.stringify(res.body));
  return res.body;
}

async function setHandle(base, identity, handle) {
  const payload = { handle };
  const proof = await signPayload(identity, payload);
  const res = await post(base, '/atlas/postoffice/handle', { payload, proof });
  if (res.status !== 200) throw new Error('Failed to set handle "' + handle + '" at ' + base + ': ' + JSON.stringify(res.body));
  return res.body;
}

// Mirrors extension/wallet.js's postOfficeSendRaw()'s payload shape — `to`
// gains a `domain` field only when it names somewhere other than the
// domain being sent through, exactly like normalizeSendTarget() in
// wallet.js's own send path.
async function sendMail(base, senderIdentity, toPublicKey, toDomain, subject, body) {
  const to = { publicKey: toPublicKey };
  if (toDomain) to.domain = toDomain;
  const payload = { to, subject, body };
  const proof = await signPayload(senderIdentity, payload);
  return post(base, '/atlas/postoffice/send', { payload, proof });
}

// ---------- PHP dev server lifecycle — two independent copies of issuer-php ----------

function startPhpServer(bundleDir, port) {
  // PHP_CLI_SERVER_WORKERS=4: `php -S` is single-worker (one request at a
  // time) by default. Federation is the first scenario in this whole suite
  // where that actually matters: Domain A's own /atlas/postoffice/send
  // handler blocks on ITS outbound call to Domain B's /relay, and Domain
  // B's /relay handler in turn blocks on ITS OWN outbound call back to
  // fetch Domain A's published key — a real reentrant two-way call, not
  // just "one domain calling another". With a single worker each, Domain
  // A's lone worker is still tied up waiting on Domain B when Domain B's
  // callback for A's key arrives, and neither side can make progress until
  // a 10s stream timeout eventually breaks the deadlock. A real deployment
  // (Apache, php-fpm, etc.) handles concurrent requests natively and never
  // hits this; multiple dev-server workers just reproduces that here.
  const proc = spawn('php', ['-S', 'localhost:' + port, 'test-router.php'], {
    cwd: bundleDir, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { PHP_CLI_SERVER_WORKERS: '4' })
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S on port ' + port + ' did not start in time')), 5000);
    proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(proc); } });
    proc.on('exit', (code) => reject(new Error('php -S on port ' + port + ' exited early with code ' + code)));
  });
}

const MARKER = '\u0000atlas.friend.v1';

async function verifyMailSignature(base, message) {
  const keyDoc = await fetch(base + '/.well-known/atlas-key.json').then((r) => r.json());
  const sentAt = new Date(message.sentAt).getTime();
  const key = keyDoc.keys.find((k) => sentAt >= new Date(k.validFrom).getTime() && (!k.validUntil || sentAt <= new Date(k.validUntil).getTime()));
  if (!key) return false;
  const payload = { id: message.id, credentialId: message.credentialId, subject: message.subject, body: message.body, ...(message.from ? { from: message.from } : {}), sentAt: message.sentAt };
  const publicKey = await subtle.importKey('raw', Buffer.from(key.publicKey, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  return subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, Buffer.from(message.signature, 'base64url'), new TextEncoder().encode(canonicalize(payload)));
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-friendreq-php-'));
  const bundleA = path.join(tmpRoot, 'domain-a');
  const bundleB = path.join(tmpRoot, 'domain-b');
  fs.cpSync(BUNDLE_DIR, bundleA, { recursive: true });
  fs.cpSync(BUNDLE_DIR, bundleB, { recursive: true });
  const readStore = (bundle) => JSON.parse(fs.readFileSync(path.join(bundle, 'lib', 'atlas-mail-store.json'), 'utf8')).messages;

  let procA, procB;
  try {
    [procA, procB] = await Promise.all([startPhpServer(bundleA, PORT_A), startPhpServer(bundleB, PORT_B)]);
    console.log('PASS: PHP dev servers up — Domain A on ' + PORT_A + ', Domain B on ' + PORT_B);

    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const aliceMembership = await issueAsset(BASE_A, alice.publicKey, 'atlas.postoffice.membership');
    const bobMembership = await issueAsset(BASE_B, bob.publicKey, 'atlas.postoffice.membership');
    await setHandle(BASE_A, alice, 'alice');
    await setHandle(BASE_B, bob, 'bob');
    console.log('SETUP: Alice is a member only at ' + DOMAIN_A + ', Bob only at ' + DOMAIN_B);

    console.log('STEP 1: Alice sends a friend request across the relay');
    const requestBody = JSON.stringify({ v: 1, type: 'request', note: 'hi from Alice' });
    const before = readStore(bundleB).length;
    const sent = await sendMail(BASE_A, alice, bob.publicKey, DOMAIN_B, MARKER, requestBody);
    if (sent.status !== 200 || !sent.body.id) throw new Error('Expected the relayed request to be accepted, got: ' + JSON.stringify(sent));
    const stored = readStore(bundleB);
    if (stored.length !== before + 1) throw new Error('Expected one new message at Domain B, went from ' + before + ' to ' + stored.length);
    const raw = stored[stored.length - 1];
    if (raw.subject !== MARKER) throw new Error('Subject did not survive intact: ' + JSON.stringify(raw.subject));
    if (raw.body !== requestBody) throw new Error('Body did not survive intact: ' + raw.body);
    if (raw.from.homeDomain !== DOMAIN_A || raw.from.handle !== 'alice' || raw.from.publicKey !== alice.publicKey) throw new Error('Wrong attribution: ' + JSON.stringify(raw.from));
    console.log('PASS: stored with the exact marker subject and body, attributed to alice#' + DOMAIN_A);

    console.log('STEP 2: Bob\'s mail check returns it, and the signature verifies');
    const check = await post(BASE_B, '/atlas/mail/check', { credentialIds: [bobMembership.id] });
    const delivered = (check.body.messages || []).find((m) => m.id === sent.body.id);
    if (!delivered) throw new Error('Mail check did not return the request: ' + JSON.stringify(check.body));
    if (delivered.subject !== MARKER) throw new Error('Subject changed in transit: ' + JSON.stringify(delivered.subject));
    if (!(await verifyMailSignature(BASE_B, delivered))) throw new Error('The wallet-side signature check would reject this message');
    console.log('PASS: delivered intact and verifiable');

    console.log('STEP 3: Bob\'s acceptance travels back the other way');
    const accepted = await sendMail(BASE_B, bob, alice.publicKey, DOMAIN_A, MARKER, JSON.stringify({ v: 1, type: 'accepted' }));
    if (accepted.status !== 200) throw new Error('Expected the acceptance to be relayed, got: ' + JSON.stringify(accepted));
    const aliceCheck = await post(BASE_A, '/atlas/mail/check', { credentialIds: [aliceMembership.id] });
    const back = (aliceCheck.body.messages || []).find((m) => m.id === accepted.body.id);
    if (!back || back.from.homeDomain !== DOMAIN_B || back.from.publicKey !== bob.publicKey) throw new Error('Alice did not get Bob\'s acceptance: ' + JSON.stringify(aliceCheck.body));
    if (!(await verifyMailSignature(BASE_A, back))) throw new Error('Signature on the acceptance does not verify');
    console.log('PASS: the acceptance reached Alice, attributed to bob#' + DOMAIN_B);

    console.log('STEP 4: a recipient who blocked the sender refuses a request like any other mail');
    const blockPayload = { blockedPublicKey: alice.publicKey };
    const blockProof = await signPayload(bob, blockPayload);
    const blockRes = await post(BASE_B, '/atlas/postoffice/block', { payload: blockPayload, proof: blockProof });
    if (blockRes.status !== 200) throw new Error('Block failed: ' + JSON.stringify(blockRes));
    const refused = await sendMail(BASE_A, alice, bob.publicKey, DOMAIN_B, MARKER, requestBody);
    if (refused.status < 400 || !/not accepting mail from you/.test(refused.body.error || '')) throw new Error('Expected the usual refusal, got: ' + JSON.stringify(refused));
    console.log('PASS: refused ->', refused.body.error);

    console.log('\nALL FRIEND-REQUEST PHP CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (procA) procA.kill();
    if (procB) procB.kill();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) {}
  }
})();
