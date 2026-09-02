// Manual check for presence-php's hand-written polling routes (task #68's
// PHP port of presence-server/server.js's /presence/poll/* — see
// presence-php/README.txt for what this is and why it exists: a
// deployable backend for real domains on plain PHP/Apache shared hosting
// that can't run a persistent WebSocket process at all).
//
// Run in isolation from the extension, same reasoning as
// manual-presence-server.js — proves the actual PHP request/response
// shapes are correct before trusting anything in the browser against it.
// Spins up PHP's own built-in dev server (`php -S`) against
// presence-php/test-router.php, which mimics presence/.htaccess's clean-URL
// rewrite closely enough to exercise the exact same /presence/poll/join,
// /sync, /leave paths the real Apache deployment and extension/viewer.js's
// pollPresence() both use.
//
// Checks:
//   1. join -> {id, roster:[]} for the first visitor into a room.
//   2. A second visitor joining the SAME room sees the first in its
//      roster; a CORS OPTIONS preflight on the same route succeeds too
//      (real cross-origin calls need this, unlike same-origin curl).
//   3. sync with no position (a bare heartbeat) still returns the current
//      roster and doesn't error.
//   4. sync WITH a position updates it — the OTHER visitor's next sync
//      reflects the new coordinates (poll -> poll interop, both directions;
//      no push exists on this backend, so this is the pull side both ways).
//   5. A visitor in a DIFFERENT room (different world) never sees the
//      first two's roster — proves room isolation, same as the Node
//      version's STEP 4.
//   6. An explicit leave removes a visitor from the room — the other
//      visitor's next sync roster no longer includes them.
//   7. sync against an unknown/expired id returns 404 with an
//      "unknown or expired presence id" error, matching what
//      extension/viewer.js's pollPresence() is written to treat as
//      "this session is gone, nothing to reconcile" rather than a crash.
//   8. A visitor that just stops syncing (no explicit leave) is swept out
//      by the next request that touches its room, once
//      PRESENCE_POLL_TIMEOUT_MS has passed — same staleness-cleanup
//      guarantee presence-server.js's own sweep gives, just triggered
//      lazily per-request instead of on a background timer (PHP has none).
//      Uses a real file edit to fake an old lastSeen instead of actually
//      waiting out the real 15s timeout.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 8098; // isolated port, distinct from presence-server.js's own manual-presence-server.js test (8099)
const BASE = 'http://localhost:' + PORT;
const BUNDLE_DIR = path.resolve(__dirname, '..', 'presence-php');
const STORE_FILE = path.resolve(BUNDLE_DIR, 'presence', 'lib', 'atlas-presence-store.json');

function post(urlPath, body) {
  return fetch(BASE + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

(async () => {
  console.log('SETUP: starting PHP\'s built-in dev server against presence-php/test-router.php');
  try { fs.unlinkSync(STORE_FILE); } catch (err) {} // start from a clean store, same reasoning as the WS test's isolated port
  const serverProc = spawn('php', ['-S', 'localhost:' + PORT, 'test-router.php'], { cwd: BUNDLE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
    serverProc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
  });
  console.log('PASS: PHP dev server up on port ' + PORT);

  try {
    console.log('STEP 1: first visitor joins an empty room, gets an empty roster');
    const joinA = await post('/presence/poll/join', { domain: 'example.com', world: 'lobby', name: 'Alice' });
    if (joinA.status !== 200 || !joinA.body.id || joinA.body.roster.length !== 0) {
      throw new Error('Expected a 200 with an empty roster for the first joiner, got: ' + JSON.stringify(joinA));
    }
    const idA = joinA.body.id;
    console.log('PASS: Alice welcomed with empty roster, id=' + idA);

    console.log('STEP 2: a second visitor joining the SAME room sees Alice; CORS preflight on the route succeeds');
    const preflight = await fetch(BASE + '/presence/poll/join', { method: 'OPTIONS' });
    if (preflight.status !== 204 || preflight.headers.get('access-control-allow-origin') !== '*') {
      throw new Error('Expected a 204 CORS preflight with Access-Control-Allow-Origin: *, got status ' + preflight.status + ', ACAO=' + preflight.headers.get('access-control-allow-origin'));
    }
    const joinB = await post('/presence/poll/join', { domain: 'example.com', world: 'lobby', name: 'Bob' });
    if (joinB.status !== 200 || joinB.body.roster.length !== 1 || joinB.body.roster[0].id !== idA || joinB.body.roster[0].name !== 'Alice') {
      throw new Error('Expected Bob\'s roster to contain exactly Alice, got: ' + JSON.stringify(joinB.body));
    }
    const idB = joinB.body.id;
    console.log('PASS: Bob sees Alice in his roster, and the CORS preflight this required in a real browser succeeded');

    console.log('STEP 3: a bare heartbeat sync (no position) still returns the roster without erroring');
    const bareSync = await post('/presence/poll/sync', { id: idA });
    if (bareSync.status !== 200 || bareSync.body.roster.length !== 1 || bareSync.body.roster[0].id !== idB) {
      throw new Error('Expected Alice\'s bare sync to return a roster containing Bob, got: ' + JSON.stringify(bareSync));
    }
    console.log('PASS: bare heartbeat sync works, roster correct');

    console.log('STEP 4: syncing WITH a position updates it — the other visitor\'s next sync reflects it (poll <-> poll interop)');
    await post('/presence/poll/sync', { id: idA, x: 4.5, y: 0, z: -2.5, yaw: 1.1 });
    const syncFromB = await post('/presence/poll/sync', { id: idB });
    const aInRosterFromB = syncFromB.body.roster.find((m) => m.id === idA);
    if (!aInRosterFromB || aInRosterFromB.x !== 4.5 || aInRosterFromB.z !== -2.5 || aInRosterFromB.yaw !== 1.1) {
      throw new Error('Expected Bob\'s roster to reflect Alice\'s new position, got: ' + JSON.stringify(aInRosterFromB));
    }
    console.log('PASS: a position sent in one sync shows up in the other visitor\'s next sync roster');

    console.log('STEP 5: a visitor in a DIFFERENT room (different world) never sees Alice or Bob\'s roster — room isolation');
    const joinC = await post('/presence/poll/join', { domain: 'example.com', world: 'plaza', name: 'Carol' });
    if (joinC.status !== 200 || joinC.body.roster.length !== 0) {
      throw new Error('Expected Carol (different room) to see an empty roster, got: ' + JSON.stringify(joinC.body));
    }
    console.log('PASS: rooms are isolated by domain+world, same as presence-server.js');

    console.log('STEP 6: an explicit leave removes a visitor — the other visitor\'s next sync no longer includes them');
    const leaveB = await post('/presence/poll/leave', { id: idB });
    if (leaveB.status !== 200 || leaveB.body.ok !== true) throw new Error('Expected leave to return {ok:true}, got: ' + JSON.stringify(leaveB));
    const syncAfterLeave = await post('/presence/poll/sync', { id: idA });
    if (syncAfterLeave.body.roster.length !== 0) throw new Error('Expected Alice\'s roster to be empty after Bob left, got: ' + JSON.stringify(syncAfterLeave.body));
    console.log('PASS: explicit leave removes the visitor from the room\'s roster');

    console.log('STEP 7: syncing against an unknown/expired id returns 404 with a clear error, not a crash');
    const syncUnknown = await post('/presence/poll/sync', { id: 'not-a-real-id' });
    if (syncUnknown.status !== 404 || !syncUnknown.body.error) throw new Error('Expected a 404 with an error message for an unknown id, got: ' + JSON.stringify(syncUnknown));
    console.log('PASS: an unknown id gets a clean 404, matching what pollPresence() in viewer.js expects');

    console.log('STEP 8: a visitor that stops syncing entirely is swept out once the staleness timeout has passed');
    const joinD = await post('/presence/poll/join', { domain: 'example.com', world: 'lobby', name: 'Dave' });
    const idD = joinD.body.id;
    // Confirm Dave really is there first, before faking him stale.
    const syncBeforeSweep = await post('/presence/poll/sync', { id: idA });
    if (!syncBeforeSweep.body.roster.some((m) => m.id === idD)) throw new Error('Expected Dave to be in Alice\'s roster right after joining');
    // Fake an old lastSeen directly in the store file rather than actually
    // waiting out the real 15-second PRESENCE_POLL_TIMEOUT_MS.
    const doc = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    for (const roomKey of Object.keys(doc.rooms)) {
      if (doc.rooms[roomKey][idD]) doc.rooms[roomKey][idD].lastSeen = Date.now() - 60000; // 60s ago — comfortably past the 15s timeout
    }
    fs.writeFileSync(STORE_FILE, JSON.stringify(doc));
    const syncAfterSweep = await post('/presence/poll/sync', { id: idA }); // touching the room triggers the lazy sweep
    if (syncAfterSweep.body.roster.some((m) => m.id === idD)) throw new Error('Expected Dave to be swept out as stale, but he\'s still in the roster: ' + JSON.stringify(syncAfterSweep.body));
    console.log('PASS: an abandoned visitor is swept out on the next request that touches their room, no explicit leave required');

    console.log('\nALL PRESENCE-PHP CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    serverProc.kill();
    try { fs.unlinkSync(STORE_FILE); } catch (err) {}
  }
})();
