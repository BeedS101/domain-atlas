// Companion to test/manual-calendar-protocol.js — proves issuer-php's own
// port of the domain calendar feature (SPEC.md §12, atlas/calendar.php,
// lib/store.php's atlas_calendar_file()/read_calendar_events()/
// add_calendar_event()/update_calendar_event()/remove_calendar_event())
// behaves the same way the Node version does, WITHOUT a full Playwright/
// browser journey. Same "HTTP layer directly" style as
// manual-world-drops-protocol-php.js, and same reason this needs TWO
// independent throwaway copies of issuer-php: proving Domain A's and
// Domain B's calendar stores are genuinely independent needs two real,
// separately-rooted instances, not two state files under one bundle.
//
// No signing anywhere in this test, same as its Node counterpart: GET
// /atlas/calendar is a plain, unsigned, ungated fetch (§12.1), and POST
// /atlas/calendar is domain-operator-authenticated with no visitor
// signature (§12.2), the same demo-level trust atlas/mail/send.php
// already uses.
//
// Checks (mirroring manual-calendar-protocol.js's own five):
//   1. A domain-wide event is added and isolated from a world-scoped read.
//   2. A per-world event is isolated from the domain-wide read.
//   3. Events come back sorted soonest-first regardless of insertion order.
//   4. update and remove work by id; removing a second time 404s.
//   5. Domain A and Domain B's calendars are entirely independent stores.
//
// Not part of the permanent suite, same reasoning as every other
// manual-*.js script.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUNDLE_DIR = path.resolve(__dirname, '..', 'issuer-php');
const PORT_A = 8111; // isolated port, distinct from every other manual-*-php.js test's own port
const PORT_B = 8112;
const BASE_A = 'http://localhost:' + PORT_A;
const BASE_B = 'http://localhost:' + PORT_B;
const WORLD = 'calendar-protocol-test-world';

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

function startPhpServer(bundleDir, port) {
  const proc = spawn('php', ['-S', 'localhost:' + port, 'test-router.php'], {
    cwd: bundleDir, stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S on port ' + port + ' did not start in time')), 5000);
    proc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(proc); } });
    proc.on('exit', (code) => reject(new Error('php -S on port ' + port + ' exited early with code ' + code)));
  });
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-calendar-php-'));
  const bundleA = path.join(tmpRoot, 'domain-a');
  const bundleB = path.join(tmpRoot, 'domain-b');
  console.log('SETUP: copying issuer-php into two independent throwaway bundles');
  fs.cpSync(BUNDLE_DIR, bundleA, { recursive: true });
  fs.cpSync(BUNDLE_DIR, bundleB, { recursive: true });

  let procA, procB;
  try {
    [procA, procB] = await Promise.all([startPhpServer(bundleA, PORT_A), startPhpServer(bundleB, PORT_B)]);
    console.log('PASS: PHP dev servers up — Domain A on ' + PORT_A + ', Domain B on ' + PORT_B);

    console.log('STEP 1: add a domain-wide event on Domain A');
    const domainEventRes = await post(BASE_A, '/atlas/calendar', {
      action: 'add',
      event: { title: 'Grand Opening', dateTime: '2027-01-15T18:00:00.000Z', notes: 'Domain-wide festival' }
    });
    assert(domainEventRes.status === 200 && domainEventRes.body.id, 'expected a successful add, got: ' + JSON.stringify(domainEventRes));
    const domainEventId = domainEventRes.body.id;
    assert(domainEventRes.body.worldId === null, 'a domain-wide event should have worldId: null, got: ' + JSON.stringify(domainEventRes.body));

    console.log('STEP 2: domain-wide read includes it, a world-scoped read of an unrelated world does not');
    const domainReadRes = await get(BASE_A, '/atlas/calendar');
    assert(domainReadRes.status === 200 && domainReadRes.body.worldId === null, 'expected worldId: null echoed back, got: ' + JSON.stringify(domainReadRes.body));
    assert(domainReadRes.body.events.some((e) => e.id === domainEventId), 'expected the domain-wide event in the domain-wide read');
    const otherWorldReadRes = await get(BASE_A, '/atlas/calendar?world=' + encodeURIComponent(WORLD));
    assert(!otherWorldReadRes.body.events.some((e) => e.id === domainEventId), 'the domain-wide event leaked into a world-scoped read');

    console.log('STEP 3: add two per-world events out of chronological order, confirm sorted soonest-first');
    const laterRes = await post(BASE_A, '/atlas/calendar', { action: 'add', worldId: WORLD, event: { title: 'Later Meetup', dateTime: '2027-03-01T12:00:00.000Z' } });
    const soonerRes = await post(BASE_A, '/atlas/calendar', { action: 'add', worldId: WORLD, event: { title: 'Sooner Meetup', dateTime: '2027-02-01T12:00:00.000Z' } });
    assert(laterRes.status === 200 && soonerRes.status === 200, 'expected both per-world adds to succeed');
    const worldReadRes = await get(BASE_A, '/atlas/calendar?world=' + encodeURIComponent(WORLD));
    assert(worldReadRes.body.worldId === WORLD, 'expected worldId echoed back to equal ' + WORLD + ', got: ' + JSON.stringify(worldReadRes.body.worldId));
    const titles = worldReadRes.body.events.map((e) => e.title);
    assert(titles.indexOf('Sooner Meetup') < titles.indexOf('Later Meetup'), 'expected soonest-first ordering, got: ' + JSON.stringify(titles));
    assert(!worldReadRes.body.events.some((e) => e.id === domainEventId), 'the world-scoped read should not include the domain-wide event');

    console.log('STEP 4: update the domain-wide event, then remove it — removing it again 404s');
    const updateRes = await post(BASE_A, '/atlas/calendar', { action: 'update', event: { id: domainEventId, notes: 'Rescheduled, same day' } });
    assert(updateRes.status === 200 && updateRes.body.notes === 'Rescheduled, same day', 'expected the update to take, got: ' + JSON.stringify(updateRes.body));
    assert(updateRes.body.title === 'Grand Opening', 'update should not have touched fields it did not include');
    const removeRes = await post(BASE_A, '/atlas/calendar', { action: 'remove', id: domainEventId });
    assert(removeRes.status === 200 && removeRes.body.status === 'removed', 'expected a successful remove, got: ' + JSON.stringify(removeRes));
    const removeAgainRes = await post(BASE_A, '/atlas/calendar', { action: 'remove', id: domainEventId });
    assert(removeAgainRes.status === 404, 'expected 404 removing an already-gone event, got: ' + JSON.stringify(removeAgainRes));

    console.log('STEP 5: Domain A and Domain B calendars are independent stores');
    const bReadRes = await get(BASE_B, '/atlas/calendar?world=' + encodeURIComponent(WORLD));
    assert(!bReadRes.body.events.some((e) => e.title === 'Sooner Meetup'), 'Domain A event leaked into Domain B — the store is not actually per-domain');

    console.log('\nALL CALENDAR PHP PROTOCOL CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (procA) procA.kill();
    if (procB) procB.kill();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) {}
  }
})();
