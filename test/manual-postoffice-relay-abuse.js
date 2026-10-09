// Manual check for the Post Office federation relay abuse fix (SPEC.md
// §11.4, /atlas/postoffice/relay): a rolling-window per-relaying-domain
// rate limit that actually REJECTS once a domain floods past it (see
// RELAY_RATE_THRESHOLD/RELAY_RATE_WINDOW_MS and relayRateLimited()/
// recordRelayAttempt() in issuer-server/server.js), plus a hard
// per-recipient mailbox cap that prunes the oldest messages first (see
// MAILBOX_CAP in appendMail()) — defense in depth against unbounded mail
// storage for local sends too, not just relayed ones.
//
// Three isolated Domain A/B/C issuer-server instances, each its own
// process on its own port/state dir — same self-contained pattern as
// test/manual-bank-approval.js and test/manual-asset-history-php.js,
// rather than requiring a manually pre-started server. Domain B is the
// one recipient domain under test; Domain A and Domain C are two
// DIFFERENT relaying domains, to prove the rate limit is scoped per
// relaying domain rather than a single global trip-wire.
//
// Uses the demo defaults (ATLAS_RELAY_RATE_THRESHOLD=30,
// ATLAS_RELAY_RATE_WINDOW_MS=60000, ATLAS_MAILBOX_CAP=200).
//
// Checks:
//   1. Alice (member of Domain A) relays 30 messages to Bob (member of
//      Domain B) through Domain A — all 30 succeed.
//   2. The 31st relay attempt within the same window is rejected with a
//      429 and a clear error, and Domain B's own on-disk rate-limit log
//      for Domain A shows exactly 30 entries (the rejected attempt was
//      never recorded).
//   3. Meanwhile, Carol (member of Domain C, a different relaying domain)
//      relaying to Bob through Domain C succeeds — Domain A being at its
//      limit does not affect a different relaying domain at all.
//   4. A local (non-relayed) flood of 205 messages to a fresh Domain B
//      member's mailbox is never rate-limited (no relaying domain is
//      involved at all), but the mailbox itself is capped at 200 —
//      GET/mail-check for that recipient shows exactly 200 messages, the
//      oldest 5 pruned, newest kept, and the other recipient's own mail
//      (from steps 1-3) is completely untouched by that pruning.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const PORT_A = 8165;
const PORT_B = 8166;
const PORT_C = 8167;
const DOMAIN_A = 'localhost:' + PORT_A;
const DOMAIN_B = 'localhost:' + PORT_B;
const DOMAIN_C = 'localhost:' + PORT_C;
const BASE_A = 'http://' + DOMAIN_A;
const BASE_B = 'http://' + DOMAIN_B;
const BASE_C = 'http://' + DOMAIN_C;

const STATE_A = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-relay-abuse-a-'));
const STATE_B = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-relay-abuse-b-'));
const STATE_C = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-relay-abuse-c-'));
const DOCROOT_A = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-relay-abuse-docroot-a-'));
const DOCROOT_B = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-relay-abuse-docroot-b-'));
const DOCROOT_C = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-relay-abuse-docroot-c-'));
const RELAY_RATE_FILE_B = path.join(STATE_B, 'atlas-federation-relay-rate-store.json');

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
}

function startServer(port, domain, stateDir, docrootDir) {
  const proc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), ATLAS_DOMAIN: domain, ATLAS_STATE_DIR: stateDir, ATLAS_DOCROOT: docrootDir },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server on ' + domain + ' did not start in time')), 10000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(proc); } });
    proc.on('exit', (code) => reject(new Error('issuer-server on ' + domain + ' exited early with code ' + code)));
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
  console.log('SETUP: starting three isolated issuer-server instances — Domain A (' + DOMAIN_A + '), Domain B (' + DOMAIN_B + '), Domain C (' + DOMAIN_C + ')');
  const procA = await startServer(PORT_A, DOMAIN_A, STATE_A, DOCROOT_A);
  const procB = await startServer(PORT_B, DOMAIN_B, STATE_B, DOCROOT_B);
  const procC = await startServer(PORT_C, DOMAIN_C, STATE_C, DOCROOT_C);
  console.log('PASS: all three isolated instances are up');

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
    // one, see the ATLAS_ASSET_CATALOG issue handler) + 30 from Alice + 1
    // from Carol.
    assert(bobMail.length === 32, 'expected Bob to still have all 32 messages (1 welcome + 30 from Alice + 1 from Carol), got ' + bobMail.length);
    console.log('PASS: capping one mailbox never touches another recipient\'s own mail');

    console.log('\nALL POST OFFICE RELAY ABUSE-FIX CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    procA.kill();
    procB.kill();
    procC.kill();
    for (const dir of [STATE_A, STATE_B, STATE_C, DOCROOT_A, DOCROOT_B, DOCROOT_C]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
})();
