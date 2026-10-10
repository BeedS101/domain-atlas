// Manual check for the anonymous visit counter on issuer-server/server.js:
// POST /atlas/visit (public — a wallet announces "I entered this world")
// and POST /atlas/admin/visits (admin-gated — the per-day, per-world counts
// the admin panel's Visits section aggregates). HTTP layer only; what the
// wallet and the panel do with these is covered by
// manual-visit-counter-wallet.js and manual-visit-counter-panel.js.
//
// ATLAS_DOCROOT points at an isolated copy of demo-domain-a (which declares
// the five worlds plaza/arena/market/museum/lobby) and ATLAS_STATE_DIR at a
// throwaway directory, so nothing here touches the real project.
//
// Checks:
//   1. With no visits yet, the admin read returns an empty `days` object
//      and the server's own UTC date as `today`.
//   2. Recording visits to two declared worlds is reflected exactly in
//      today's bucket.
//   3. A world the manifest doesn't declare, a missing/non-string world, and
//      a malformed body are all rejected with 400 and change nothing — the
//      endpoint is unauthenticated, so it must not be able to invent counters.
//   4. The admin read refuses no auth and a non-admin key (401) and accepts a
//      registered admin's signature.
//   5. What's stored is only {YYYY-MM-DD: {worldId: integer}} — nothing
//      identifying.
//   6. A bucket older than the retention window is dropped on the next
//      write; a recent one is kept.
//   7. Many simultaneous visits all count.
//
// Not part of the permanent suite, same reasoning as the other manual-*.js
// scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');
const { withAdminAuth } = require('./lib/admin-auth');
const { subtle } = webcrypto;

const PORT = 8208; // isolated — distinct from every other manual-*.js test's chosen port
const DOMAIN = 'localhost:' + PORT;
const BASE = 'http://' + DOMAIN;
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-visits-state-'));
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-visits-docroot-'));
const VISITS_FILE = path.join(STATE_DIR, 'atlas-visits-store.json');

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
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
async function signWithSelf(identity, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey: identity.publicKey, signature: b64url(sig) };
}
function post(urlPath, rawBody) {
  return fetch(BASE + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody || {})
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
}
async function adminRead(identity) {
  const payload = withAdminAuth({ action: 'visits' }, BASE, '/atlas/admin/visits');
  const proof = await signWithSelf(identity, payload);
  return post('/atlas/admin/visits', { payload, proof });
}
function utcDay(offsetDays) {
  return new Date(Date.now() + (offsetDays || 0) * 86400000).toISOString().slice(0, 10);
}

(async () => {
  console.log('SETUP: starting an isolated issuer-server on port ' + PORT);
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
  const admin = await genIdentity();
  const outsider = await genIdentity();
  fs.writeFileSync(path.join(STATE_DIR, 'atlas-admin-keys-store.json'), JSON.stringify({ keys: [{ publicKey: admin.publicKey, addedAt: new Date().toISOString() }] }));
  const proc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: DOCROOT_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    proc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    proc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });
  console.log('PASS: issuer-server up');

  try {
    console.log('STEP 1: with no visits yet the admin read is empty and carries the server\'s own UTC date');
    const empty = await adminRead(admin);
    assert(empty.status === 200, 'expected 200, got ' + JSON.stringify(empty));
    assert(empty.body.today === utcDay(0), 'expected today to be the UTC date ' + utcDay(0) + ', got ' + empty.body.today);
    assert(empty.body.days && typeof empty.body.days === 'object' && !Array.isArray(empty.body.days) && Object.keys(empty.body.days).length === 0, 'expected an empty days object, got ' + JSON.stringify(empty.body.days));
    assert(empty.body.retentionDays === 90, 'expected the retention window to be reported, got ' + empty.body.retentionDays);
    console.log('PASS: empty days object, today =', empty.body.today);

    console.log('STEP 2: visits to two declared worlds land in today\'s bucket exactly');
    for (let i = 0; i < 3; i++) {
      const r = await post('/atlas/visit', { world: 'plaza' });
      assert(r.status === 200 && r.body.recorded === true, 'plaza visit failed: ' + JSON.stringify(r));
    }
    for (let i = 0; i < 2; i++) {
      const r = await post('/atlas/visit', { world: 'lobby' });
      assert(r.status === 200, 'lobby visit failed: ' + JSON.stringify(r));
    }
    const after = await adminRead(admin);
    const today = after.body.days[utcDay(0)];
    assert(today && today.plaza === 3 && today.lobby === 2 && Object.keys(today).length === 2, 'expected {plaza:3, lobby:2}, got ' + JSON.stringify(after.body.days));
    console.log('PASS: today ->', JSON.stringify(today));

    console.log('STEP 3: an undeclared world, a missing/non-string world and a malformed body are rejected and change nothing');
    const bad = [
      ['undeclared world', { world: 'not-a-real-world' }],
      ['missing world', {}],
      ['numeric world', { world: 5 }],
      ['object world', { world: { id: 'plaza' } }],
      ['malformed JSON', '{not json']
    ];
    for (const [label, body] of bad) {
      const r = await post('/atlas/visit', body);
      assert(r.status === 400, label + ': expected 400, got ' + JSON.stringify(r));
    }
    const unchanged = await adminRead(admin);
    assert(JSON.stringify(unchanged.body.days[utcDay(0)]) === JSON.stringify({ plaza: 3, lobby: 2 }), 'rejected visits must not change any count, got ' + JSON.stringify(unchanged.body.days));
    console.log('PASS: five bad requests rejected with 400, counts untouched');

    console.log('STEP 4: the admin read refuses no auth and a non-admin key, and accepts a registered admin');
    const noAuth = await post('/atlas/admin/visits', {});
    assert(noAuth.status === 401, 'expected 401 with no auth, got ' + JSON.stringify(noAuth));
    const outsiderRead = await adminRead(outsider);
    assert(outsiderRead.status === 401, 'expected 401 for a key that isn\'t on the admin roster, got ' + JSON.stringify(outsiderRead));
    console.log('PASS: 401 without auth, 401 for a non-admin key');

    console.log('STEP 5: what\'s stored is only {YYYY-MM-DD: {worldId: integer}} — nothing identifying');
    const stored = JSON.parse(fs.readFileSync(VISITS_FILE, 'utf8'));
    assert(Object.keys(stored).length === 1 && stored.days, 'expected the file to hold only a `days` object, got keys ' + Object.keys(stored));
    for (const [day, worlds] of Object.entries(stored.days)) {
      assert(/^\d{4}-\d{2}-\d{2}$/.test(day), 'bucket key is not a bare date: ' + day);
      for (const [world, count] of Object.entries(worlds)) {
        assert(typeof world === 'string' && Number.isInteger(count), 'unexpected entry ' + world + ' -> ' + JSON.stringify(count));
      }
    }
    console.log('PASS: only dates, world ids and integer counts on disk');

    console.log('STEP 6: a bucket past the retention window is dropped on the next write; a recent one is kept');
    const seeded = { days: { [utcDay(-200)]: { plaza: 99 }, [utcDay(-10)]: { arena: 4 }, ...stored.days } };
    fs.writeFileSync(VISITS_FILE, JSON.stringify(seeded, null, 2));
    await post('/atlas/visit', { world: 'market' });
    const pruned = (await adminRead(admin)).body.days;
    assert(!(utcDay(-200) in pruned), 'expected the 200-day-old bucket to be pruned, got ' + Object.keys(pruned));
    assert(pruned[utcDay(-10)] && pruned[utcDay(-10)].arena === 4, 'expected the 10-day-old bucket to survive, got ' + JSON.stringify(pruned));
    console.log('PASS: old bucket pruned, recent bucket kept');

    console.log('STEP 7: thirty simultaneous visits all count');
    const before = (await adminRead(admin)).body.days[utcDay(0)].museum || 0;
    const results = await Promise.all(Array.from({ length: 30 }, () => post('/atlas/visit', { world: 'museum' })));
    assert(results.every((r) => r.status === 200), 'expected every simultaneous visit to be accepted');
    const final = (await adminRead(admin)).body.days[utcDay(0)].museum;
    assert(final - before === 30, 'expected 30 more museum visits, got ' + (final - before));
    console.log('PASS: 30 simultaneous visits -> +30');

    console.log('\nALL VISIT COUNTER (NODE) CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    proc.kill();
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (err) {}
    try { fs.rmSync(DOCROOT_DIR, { recursive: true, force: true }); } catch (err) {}
    process.exit(process.exitCode || 0);
  }
})();
