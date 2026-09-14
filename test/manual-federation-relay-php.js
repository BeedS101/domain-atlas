// Companion to test/manual-federation-relay.js — the disclosed "lighter,
// protocol-level" PHP check for task #97 (SPEC.md §11.4, domain-to-domain
// Post Office federation), proving issuer-php's own send.php/relay.php port
// behaves the same way the Node version already does, WITHOUT a full
// Playwright/browser journey. Same "HTTP layer directly + Node's own
// crypto.webcrypto for real ECDSA P-256 signing" style as
// manual-trade-submit-php.js and manual-chat-php.js.
//
// Unlike every earlier PHP manual test, this one genuinely needs TWO
// independent "domains" at once — federation is the first PHP feature
// where that matters. issuer-php has no ATLAS_STATE_DIR-style override
// (unlike issuer-server/server.js): atlas_domain() reads the Host header,
// but every state file (private key, mail store, Post Office roster,
// federation blocklist) lives at a fixed path relative to that copy of the
// bundle. So two genuinely separate domains means two genuinely separate
// COPIES of issuer-php, each its own `php -S` instance on its own port,
// each growing its own keypair on first request — mirroring what
// manual-federation-relay.js gets for free from two already-running
// issuer-server processes.
//
// Checks:
//   1. Alice (member only at Domain A) sends to Bob (member only at Domain
//      B, resolved by handle) through her OWN home domain — Domain A
//      relays it server-to-server to Domain B, the relay succeeds.
//   2. Domain B's own mail store shows from.homeDomain === Domain A (not
//      Domain B mislabeling its own delivery domain), from.handle ===
//      'alice', body intact.
//   3. Relaying to a real public key that is NOT actually a member at the
//      named home domain is rejected with the same membership error
//      send.php/relay.php give a local sender.
//   4. Domain B's own operator federation-blocklist rejects a relay
//      attempt from a domain it names, with the same wording
//      issuer-server/server.js's port uses.
//   5. Removing the block restores normal relaying immediately — no
//      restart, no cache to clear (blocklist is a plain JSON file read
//      fresh on every request, same statelessness PHP already has to live
//      with).
//
// Not part of the permanent suite, same reasoning as every other
// manual-*.js scripts. Scratchpad-style: builds two throwaway copies of
// issuer-php under the OS temp dir at runtime and deletes them afterward —
// nothing here touches the real issuer-php/ tree.

const { spawn } = require('child_process');
const { webcrypto } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { subtle } = webcrypto;
const BUNDLE_DIR = path.resolve(__dirname, '..', 'issuer-php');
const PORT_A = 8099; // isolated port, distinct from every other manual-*-php.js test's own port
const PORT_B = 8100;
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

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-federation-php-'));
  const bundleA = path.join(tmpRoot, 'domain-a');
  const bundleB = path.join(tmpRoot, 'domain-b');
  console.log('SETUP: copying issuer-php into two independent throwaway bundles (each grows its own keypair + state on first request)');
  fs.cpSync(BUNDLE_DIR, bundleA, { recursive: true });
  fs.cpSync(BUNDLE_DIR, bundleB, { recursive: true });
  const MAIL_STORE_B_PATH = path.join(bundleB, 'lib', 'atlas-mail-store.json');
  const BLOCKLIST_B_PATH = path.join(bundleB, 'lib', 'atlas-federation-blocklist.json');
  // issuer-php's append_mail() (lib/store.php) wraps the array as
  // {messages: [...]}, not a bare array like the Node relay test's own
  // MAIL_STORE_B_PATH — same data, different on-disk envelope.
  function readMailStoreB() {
    return JSON.parse(fs.readFileSync(MAIL_STORE_B_PATH, 'utf8')).messages;
  }

  let procA, procB;
  try {
    [procA, procB] = await Promise.all([startPhpServer(bundleA, PORT_A), startPhpServer(bundleB, PORT_B)]);
    console.log('PASS: PHP dev servers up — Domain A on ' + PORT_A + ', Domain B on ' + PORT_B);

    const alice = await generateIdentity();
    const bob = await generateIdentity();

    console.log('STEP 0: Alice joins the Post Office ONLY at Domain A, Bob ONLY at Domain B; both register handles');
    await issueAsset(BASE_A, alice.publicKey, 'atlas.postoffice.membership');
    await issueAsset(BASE_B, bob.publicKey, 'atlas.postoffice.membership');
    await setHandle(BASE_A, alice, 'alice');
    await setHandle(BASE_B, bob, 'bob');
    console.log('PASS: Alice is a member only at ' + DOMAIN_A + ', Bob only at ' + DOMAIN_B);

    console.log('STEP 1: Alice resolves bob#' + DOMAIN_B + ' and sends through HER OWN home domain (' + DOMAIN_A + '), addressed to Bob\'s home domain');
    const resolved = await post(BASE_A, '/atlas/postoffice/resolve', { handle: 'bob' });
    // Note: resolve.php only ever looks at ITS OWN roster — a real client
    // resolves against the TARGET domain directly (AtlasWallet.resolvePostOfficeHandle(DOMAIN_B, 'bob')
    // posts to Domain B, not Domain A). Mirrored here against BASE_B for that reason.
    const resolvedAtB = await post(BASE_B, '/atlas/postoffice/resolve', { handle: 'bob' });
    if (resolvedAtB.status !== 200 || resolvedAtB.body.publicKey !== bob.publicKey) {
      throw new Error('Expected resolving bob#' + DOMAIN_B + ' against Domain B to return Bob\'s real key, got: ' + JSON.stringify(resolvedAtB.body));
    }
    let beforeCount = readMailStoreB().length;
    const sendResult = await sendMail(BASE_A, alice, bob.publicKey, DOMAIN_B, 'Cross-domain hello (PHP)', 'This message was relayed from ' + DOMAIN_A + ' to ' + DOMAIN_B + ' via issuer-php.');
    if (sendResult.status !== 200 || !sendResult.body.id) throw new Error('Expected a successful relayed send, got: ' + JSON.stringify(sendResult));
    console.log('PASS: relay succeeded — Domain A accepted the send and relayed it to Domain B without Alice ever joining Domain B');

    console.log('STEP 2: Domain B\'s OWN on-disk mail store shows from.homeDomain as Alice\'s REAL home domain');
    const storeAfterSend = readMailStoreB();
    if (storeAfterSend.length !== beforeCount + 1) throw new Error('Expected exactly 1 new message on Domain B\'s own store, went from ' + beforeCount + ' to ' + storeAfterSend.length);
    const raw = storeAfterSend[storeAfterSend.length - 1];
    if (raw.from.publicKey !== alice.publicKey) throw new Error('Expected from.publicKey to be Alice\'s real key, got: ' + raw.from.publicKey);
    if (raw.from.handle !== 'alice') throw new Error('Expected from.handle "alice", got: ' + raw.from.handle);
    if (raw.from.homeDomain !== DOMAIN_A) throw new Error('Expected from.homeDomain to be ' + DOMAIN_A + ', got: ' + raw.from.homeDomain);
    if (raw.body !== 'This message was relayed from ' + DOMAIN_A + ' to ' + DOMAIN_B + ' via issuer-php.') throw new Error('Body did not survive the relay unchanged: ' + raw.body);
    console.log('PASS: Domain B\'s own stored copy correctly attributes the message to alice#' + DOMAIN_A);

    console.log('STEP 3: sending to a real public key that is NOT actually a member of the named home domain is rejected clearly');
    const nonMemberSend = await sendMail(BASE_A, alice, alice.publicKey, DOMAIN_B, 'Should fail', 'nobody home'); // Alice's own key, but she's not a member of Domain B
    if (nonMemberSend.status !== 400 || !/does not hold a valid Global Mail membership/.test(nonMemberSend.body.error || '')) {
      throw new Error('Expected a "recipient does not hold a valid membership" rejection, got: ' + JSON.stringify(nonMemberSend));
    }
    console.log('PASS: relaying to someone who isn\'t actually a member at the named home domain is rejected ->', nonMemberSend.body.error);

    console.log('STEP 4: Domain B\'s own operator federation-blocklist rejects a relay attempt from a domain it names');
    fs.writeFileSync(BLOCKLIST_B_PATH, JSON.stringify({ blocked: [DOMAIN_A] }, null, 2));
    const blockedSend = await sendMail(BASE_A, alice, bob.publicKey, DOMAIN_B, 'Should be blocked', 'blocked domain test');
    if (blockedSend.status < 400 || !/not accepting relayed mail from/.test(blockedSend.body.error || '')) {
      throw new Error('Expected a blocklist rejection, got: ' + JSON.stringify(blockedSend));
    }
    console.log('PASS: Domain B\'s operator blocklist rejected the relay attempt from ' + DOMAIN_A + ' ->', blockedSend.body.error);

    console.log('STEP 5: removing the block restores normal relaying immediately (plain JSON file, read fresh every request — no restart or cache to clear)');
    fs.unlinkSync(BLOCKLIST_B_PATH);
    const afterUnblockCountBefore = readMailStoreB().length;
    const afterUnblock = await sendMail(BASE_A, alice, bob.publicKey, DOMAIN_B, 'Unblocked now', 'should go through again');
    if (afterUnblock.status !== 200 || !afterUnblock.body.id) throw new Error('Expected relaying to succeed again after removing the block, got: ' + JSON.stringify(afterUnblock));
    const afterUnblockStore = readMailStoreB();
    if (afterUnblockStore.length !== afterUnblockCountBefore + 1 || afterUnblockStore[afterUnblockStore.length - 1].subject !== 'Unblocked now') {
      throw new Error('Expected the post-unblock message to actually land: ' + JSON.stringify(afterUnblockStore[afterUnblockStore.length - 1]));
    }
    console.log('PASS: relaying works again immediately after the operator removes the block');

    console.log('\nALL FEDERATION-RELAY PHP CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (procA) procA.kill();
    if (procB) procB.kill();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) {}
  }
})();
