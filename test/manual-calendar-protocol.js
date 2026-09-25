// Protocol-level check for the domain calendar feature (SPEC.md §12) —
// proves issuer-server/server.js's GET/POST /atlas/calendar (CALENDAR_FILE,
// readCalendarEvents/addCalendarEvent/updateCalendarEvent/removeCalendarEvent)
// behave correctly, WITHOUT going through a browser/extension at all. Same
// "HTTP layer directly" style as manual-world-drops-protocol.js, chosen for
// the same reason: a full Playwright UI journey (see manual-calendar-remote.js)
// proves viewer.js's own wiring, but the underlying protocol correctness is
// far faster and more precisely checked here.
//
// GET /atlas/calendar is a plain, unsigned, ungated fetch (§12.1 — "the
// same plain-HTTPS trust boundary the manifest and §7's catalog already
// rely on"); POST /atlas/calendar requires a signed admin proof envelope
// (requireAdmin(), issuer-server/server.js), the same as /atlas/revoke,
// /atlas/mail/send, and /atlas/asset/reissue.
//
// Requires domain A's issuer-server on 8001 AND domain B's on 8002 (same as
// every other cross-domain test in this suite) — this test does not start
// either itself. See README.md's "Serve the two demo domains locally"
// section for the exact two commands.
//
// Checks:
//   1. A domain-wide event (no worldId) is added, appears in GET
//      /atlas/calendar (no ?world=), and does NOT appear when a specific
//      world is requested instead — the two calendars stay separate, per
//      §3's "neither implies or overrides the other."
//   2. A per-world event (worldId set) appears under GET
//      /atlas/calendar?world={id} and NOT under the domain-wide read —
//      same isolation, other direction.
//   3. Events come back sorted soonest-first regardless of insertion order.
//   4. update and remove actions work, targeting the same event by id;
//      removing a second time 404s (already gone).
//   5. Domain A and Domain B's calendars are entirely independent stores —
//      an event added on A never shows up when fetching B, proving this
//      isn't a shared file by accident.
//
// Not part of the permanent suite, same reasoning as every other
// manual-*.js script.

const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

const DOMAIN_A_BASE = 'http://localhost:8001';
const DOMAIN_B_BASE = 'http://localhost:8002';
const ADMIN_KEYS_FILE = path.resolve(__dirname, '..', 'issuer-server', 'atlas-admin-keys-store.json');
const WORLD = 'calendar-protocol-test-world-' + Date.now(); // unique per run

function post(base, urlPath, body) {
  return fetch(base + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

function get(base, urlPath) {
  return fetch(base + urlPath).then(async (r) => ({ status: r.status, body: await r.json() }));
}

function assert(cond, message) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + message);
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

// Mirrors extension/wallet.js's signWithSelf() — a raw-ecdsa self-signed
// envelope, the same one verifyEnvelope() on the server checks.
async function signWithSelf(kp, publicKey, payload) {
  const data = new TextEncoder().encode(canonicalize(payload));
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, data));
  return { signerRole: 'raw-ecdsa', publicKey, signature: b64url(sig) };
}

// POST /atlas/calendar now requires a registered domain admin's signature
// (requireAdmin(), issuer-server/server.js) — seeds one directly into the
// admin roster file, the same "plain operator-edited JSON" bootstrap a
// real domain operator would do by hand.
function seedAdmin(publicKey) {
  fs.writeFileSync(ADMIN_KEYS_FILE, JSON.stringify({ keys: [{ publicKey, addedAt: new Date().toISOString() }] }, null, 2));
}

async function postAsAdmin(base, urlPath, admin, payload) {
  const proof = await signWithSelf(admin.kp, admin.publicKey, payload);
  return post(base, urlPath, { payload, proof });
}

(async () => {
  try {
    const admin = await genIdentity();
    seedAdmin(admin.publicKey);

    console.log('STEP 1: add a domain-wide event on Domain A');
    const domainEventRes = await postAsAdmin(DOMAIN_A_BASE, '/atlas/calendar', admin, {
      action: 'add',
      event: { title: 'Grand Opening', dateTime: '2027-01-15T18:00:00.000Z', notes: 'Domain-wide festival' }
    });
    assert(domainEventRes.status === 200 && domainEventRes.body.id, 'expected a successful add, got: ' + JSON.stringify(domainEventRes));
    const domainEventId = domainEventRes.body.id;
    assert(domainEventRes.body.worldId === null, 'a domain-wide event should have worldId: null, got: ' + JSON.stringify(domainEventRes.body));

    console.log('STEP 2: domain-wide read includes it, a world-scoped read of an unrelated world does not');
    const domainReadRes = await get(DOMAIN_A_BASE, '/atlas/calendar');
    assert(domainReadRes.status === 200 && domainReadRes.body.worldId === null, 'expected worldId: null echoed back, got: ' + JSON.stringify(domainReadRes.body));
    assert(domainReadRes.body.events.some((e) => e.id === domainEventId), 'expected the domain-wide event in the domain-wide read');
    const otherWorldReadRes = await get(DOMAIN_A_BASE, '/atlas/calendar?world=' + encodeURIComponent(WORLD));
    assert(!otherWorldReadRes.body.events.some((e) => e.id === domainEventId), 'the domain-wide event leaked into a world-scoped read');

    console.log('STEP 3: add two per-world events out of chronological order, confirm sorted soonest-first');
    const laterRes = await postAsAdmin(DOMAIN_A_BASE, '/atlas/calendar', admin, {
      action: 'add',
      worldId: WORLD,
      event: { title: 'Later Meetup', dateTime: '2027-03-01T12:00:00.000Z' }
    });
    const soonerRes = await postAsAdmin(DOMAIN_A_BASE, '/atlas/calendar', admin, {
      action: 'add',
      worldId: WORLD,
      event: { title: 'Sooner Meetup', dateTime: '2027-02-01T12:00:00.000Z' }
    });
    assert(laterRes.status === 200 && soonerRes.status === 200, 'expected both per-world adds to succeed');
    const worldReadRes = await get(DOMAIN_A_BASE, '/atlas/calendar?world=' + encodeURIComponent(WORLD));
    assert(worldReadRes.body.worldId === WORLD, 'expected worldId echoed back to equal ' + WORLD + ', got: ' + JSON.stringify(worldReadRes.body.worldId));
    const titles = worldReadRes.body.events.map((e) => e.title);
    assert(titles.indexOf('Sooner Meetup') < titles.indexOf('Later Meetup'), 'expected soonest-first ordering, got: ' + JSON.stringify(titles));
    assert(!worldReadRes.body.events.some((e) => e.id === domainEventId), 'the world-scoped read should not include the domain-wide event');
    const domainReadAfterRes = await get(DOMAIN_A_BASE, '/atlas/calendar');
    assert(!domainReadAfterRes.body.events.some((e) => e.title === 'Sooner Meetup' || e.title === 'Later Meetup'), 'per-world events leaked into the domain-wide read');

    console.log('STEP 4: update the domain-wide event, then remove it — removing it again 404s');
    const updateRes = await postAsAdmin(DOMAIN_A_BASE, '/atlas/calendar', admin, {
      action: 'update',
      event: { id: domainEventId, notes: 'Rescheduled, same day' }
    });
    assert(updateRes.status === 200 && updateRes.body.notes === 'Rescheduled, same day', 'expected the update to take, got: ' + JSON.stringify(updateRes.body));
    assert(updateRes.body.title === 'Grand Opening', 'update should not have touched fields it did not include');
    const removeRes = await postAsAdmin(DOMAIN_A_BASE, '/atlas/calendar', admin, { action: 'remove', id: domainEventId });
    assert(removeRes.status === 200 && removeRes.body.status === 'removed', 'expected a successful remove, got: ' + JSON.stringify(removeRes));
    const removeAgainRes = await postAsAdmin(DOMAIN_A_BASE, '/atlas/calendar', admin, { action: 'remove', id: domainEventId });
    assert(removeAgainRes.status === 404, 'expected 404 removing an already-gone event, got: ' + JSON.stringify(removeAgainRes));

    console.log('STEP 5: Domain A and Domain B calendars are independent stores');
    const bReadRes = await get(DOMAIN_B_BASE, '/atlas/calendar?world=' + encodeURIComponent(WORLD));
    assert(!bReadRes.body.events.some((e) => e.title === 'Sooner Meetup'), 'Domain A event leaked into Domain B — the store is not actually per-domain');

    console.log('ALL CHECKS PASSED');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
