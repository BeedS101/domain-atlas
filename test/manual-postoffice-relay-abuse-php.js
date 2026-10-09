// Manual check for the Post Office federation relay abuse fix, against the
// PHP port specifically — mirrors test/manual-postoffice-relay-abuse.js's
// own Node checks exactly (see that file for the full design rationale:
// relay_rate_limited()/record_relay_attempt() in issuer-php/lib/store.php,
// wired into atlas/postoffice/relay.php, plus append_mail()'s
// ATLAS_MAILBOX_CAP pruning).
//
// Three isolated PHP dev-server instances, each its own copy of the
// issuer-php bundle in its own temp dir, same "own isolated instance"
// reasoning every other manual-*-php.js test in this project uses. PHP has
// no ATLAS_DOMAIN env var to set (atlas_domain() reads the Host header
// instead, see lib/store.php's own comment) — fetching each instance as
// http://localhost:<its own port> already gives it the right domain
// identity for free.
//
// Uses the demo defaults (ATLAS_RELAY_RATE_THRESHOLD=30,
// ATLAS_RELAY_RATE_WINDOW_MS=60000, ATLAS_MAILBOX_CAP=200).
//
// Checks: identical to the Node version —
//   1. Alice (Domain A) relays 30 messages to Bob (Domain B) — all succeed.
//   2. The 31st is rejected with 429; Domain B's own on-disk relay-rate log
//      for Domain A shows exactly 30 entries.
//   3. Carol relaying through Domain C (a different relaying domain) to Bob
//      succeeds regardless — the limit is scoped per relaying domain.
//   4. A local (non-relayed) flood of 205 messages to a fresh Domain B
//      member is never rate-limited, but capped at 200 (oldest pruned).
//   5. Bob's own mail from steps 1-3 is untouched by that capping.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const PORT_A = 8168;
const PORT_B = 8169;
const PORT_C = 8170;
const DOMAIN_A = 'localhost:' + PORT_A;
const DOMAIN_B = 'localhost:' + PORT_B;
const DOMAIN_C = 'localhost:' + PORT_C;
const BASE_A = 'http://' + DOMAIN_A;
const BASE_B = 'http://' + DOMAIN_B;
const BASE_C = 'http://' + DOMAIN_C;

const BUNDLE_A = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-relay-abuse-php-a-'));
const BUNDLE_B = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-relay-abuse-php-b-'));
const BUNDLE_C = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-relay-abuse-php-c-'));
const RELAY_RATE_FILE_B = path.join(BUNDLE_B, 'lib', 'atlas-federation-relay-rate-store.json');

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}

function startPhpServer(port, bundleDir) {
  fs.cpSync(path.resolve(__dirname, '..', 'issuer-php'), bundleDir, { recursive: true });
  // PHP_CLI_SERVER_WORKERS=4 — same reasoning as test/manual-federation-
  // relay-php.js's own startPhpServer(): `php -S` is single-worker by
  // default, and this test needs real reentrant cross-domain calls (Domain
  // A's send blocks on its own outbound call to Domain B's relay, which in
  // turn blocks on ITS OWN outbound call back to fetch Domain A's
  // published key) — a lone worker on either side deadlocks against the
  // other for a full stream timeout. A real deployment (Apache, php-fpm)
  // handles concurrent requests natively and never hits this.
  const proc = spawn('php', ['-S', 'localhost:' + port, 'test-router.php'], {
    cwd: bundleDir, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { PHP_CLI_SERVER_WORKERS: '4' })
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S on port ' + port + ' did not start in time')), 5000);
    proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(proc); } });
    proc.on('exit', (code) => reject(new Error('php -S on port ' + port + ' exited early with code ' + code)));
  });
}

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
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
async function claimMembership(base, ownerPublicKey) {
  const res = await fetch(base + '/atlas/asset/issue', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerPublicKey, assetClass: 'atlas.postoffice.membership' })
  });
  if (!res.ok) throw new Error('claim failed against ' + base + ': ' + await res.text());
  return await res.json();
}
async function sendMail(base, identity, to, subject, body) {
  const payload = { to, subject, body };
  const proof = await signWithSelf(identity.kp, identity.publicKey, payload);
  return fetch(base + '/atlas/postoffice/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, proof })
  });
}
async function checkMail(base, identity, credential) {
  const payload = { action: 'mail-check', domain: new URL(base).host, credentialIds: [credential.id], issuedAt: new Date().toISOString(), nonce: b64url(webcrypto.getRandomValues(new Uint8Array(18))) };
  const proof = await signWithSelf(identity.kp, identity.publicKey, payload);
  const res = await fetch(base + '/atlas/mail/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ credentials: [credential], payload, proof })
  });
  if (!res.ok) throw new Error('mail check failed: ' + await res.text());
  return (await res.json()).messages;
}

(async () => {
  console.log('SETUP: starting three isolated issuer-php dev servers — Domain A (' + DOMAIN_A + '), Domain B (' + DOMAIN_B + '), Domain C (' + DOMAIN_C + ')');
  const procA = await startPhpServer(PORT_A, BUNDLE_A);
  const procB = await startPhpServer(PORT_B, BUNDLE_B);
  const procC = await startPhpServer(PORT_C, BUNDLE_C);
  console.log('PASS: all three isolated PHP instances are up');

  try {
    console.log('STEP 0: Alice joins Domain A, Bob joins Domain B, Carol joins Domain C, Dave and a fresh recipient join Domain B');
    const alice = await genIdentity();
    const bob = await genIdentity();
    const carol = await genIdentity();
    const dave = await genIdentity();
    const eve = await genIdentity();
    await claimMembership(BASE_A, alice.publicKey);
    const bobCred = await claimMembership(BASE_B, bob.publicKey);
    await claimMembership(BASE_C, carol.publicKey);
    await claimMembership(BASE_B, dave.publicKey);
    const eveCred = await claimMembership(BASE_B, eve.publicKey);
    console.log('PASS: all identities hold their memberships');

    console.log('STEP 1: Alice relays 30 messages to Bob through Domain A — all should succeed');
    for (let i = 0; i < 30; i++) {
      const res = await sendMail(BASE_A, alice, { publicKey: bob.publicKey, domain: DOMAIN_B }, 'Relay ' + i, 'flood message ' + i);
      assert(res.ok, 'expected relay #' + i + ' to succeed, got ' + res.status + ': ' + await res.text());
    }
    console.log('PASS: 30 relayed messages from Domain A all succeeded');

    console.log('STEP 2: the 31st relay attempt within the same window is rejected with 429, and Domain B\'s own rate-limit log for Domain A shows exactly 30 entries');
    const res31 = await sendMail(BASE_A, alice, { publicKey: bob.publicKey, domain: DOMAIN_B }, 'Relay 30', 'one too many');
    assert(res31.status === 429, 'expected the 31st relay to be rejected with 429, got ' + res31.status);
    const body31 = await res31.json();
    assert(/too many relayed messages/.test(body31.error || ''), 'expected a rate-limit error message, got: ' + JSON.stringify(body31));
    const rateDoc = JSON.parse(fs.readFileSync(RELAY_RATE_FILE_B, 'utf8'));
    const loggedForA = rateDoc.domains[DOMAIN_A] || [];
    assert(loggedForA.length === 30, 'expected exactly 30 logged relay attempts for ' + DOMAIN_A + ', got ' + loggedForA.length);
    console.log('PASS: 31st relay rejected with 429, and the rejected attempt was never recorded (log still shows 30)');

    console.log('STEP 3: Carol relaying through Domain C (a DIFFERENT relaying domain) to Bob succeeds — Domain A being maxed out does not affect Domain C');
    const resC = await sendMail(BASE_C, carol, { publicKey: bob.publicKey, domain: DOMAIN_B }, 'From Carol', 'a different relaying domain entirely');
    assert(resC.ok, 'expected Carol\'s relay through Domain C to succeed, got ' + resC.status + ': ' + await resC.text());
    const loggedForC = JSON.parse(fs.readFileSync(RELAY_RATE_FILE_B, 'utf8')).domains[DOMAIN_C] || [];
    assert(loggedForC.length === 1, 'expected exactly 1 logged relay attempt for ' + DOMAIN_C + ', got ' + loggedForC.length);
    console.log('PASS: the rate limit is scoped per relaying domain, not a single global trip-wire');

    console.log('STEP 4: a local (non-relayed) flood of 205 messages to a fresh Domain B member is never rate-limited, but capped at 200 — oldest pruned, newest kept');
    for (let i = 0; i < 205; i++) {
      const res = await sendMail(BASE_B, dave, { publicKey: eve.publicKey }, 'cap ' + i, 'local flood message ' + i);
      assert(res.ok, 'expected local send #' + i + ' to succeed (no relaying domain is involved, so no rate limit applies), got ' + res.status + ': ' + await res.text());
    }
    const eveMail = await checkMail(BASE_B, eve, eveCred);
    assert(eveMail.length === 200, 'expected exactly 200 messages in Eve\'s capped mailbox, got ' + eveMail.length);
    const subjects = eveMail.map((m) => m.subject);
    assert(!subjects.includes('cap 0') && !subjects.includes('cap 4'), 'expected the oldest 5 messages (cap 0..cap 4) to have been pruned, got subjects starting: ' + subjects.slice(0, 3));
    assert(subjects.includes('cap 5') && subjects.includes('cap 204'), 'expected the newest messages (cap 5..cap 204) to still be present');
    console.log('PASS: Eve\'s mailbox holds exactly 200 messages, oldest 5 pruned, newest 200 kept');

    console.log('STEP 5: Bob\'s own mail (from the relayed steps above) is completely untouched by Eve\'s mailbox being capped');
    const bobMail = await checkMail(BASE_B, bob, bobCred);
    // 1 auto-sent welcome message (claiming a Post Office membership queues
    // one, see atlas/asset/issue.php) + 30 from Alice + 1 from Carol.
    assert(bobMail.length === 32, 'expected Bob to still have all 32 messages (1 welcome + 30 from Alice + 1 from Carol), got ' + bobMail.length);
    console.log('PASS: capping one mailbox never touches another recipient\'s own mail');

    console.log('\nALL PHP POST OFFICE RELAY ABUSE-FIX CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    procA.kill();
    procB.kill();
    procC.kill();
    for (const dir of [BUNDLE_A, BUNDLE_B, BUNDLE_C]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
})();
