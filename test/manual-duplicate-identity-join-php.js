// Manual check for task #137's PHP port — the same dedupe-by-publicKey
// guard added to presence-server/server.js's requestJoin()/addMember()
// split (see test/manual-duplicate-identity-join.js for the Node-side
// version of these same checks), mirrored into presence-php/ per this
// project's own "every presence feature gets both a Node and PHP
// implementation" convention (see presence-php/README.txt).
//
// presence-php is polling-only (no WebSocket at all — see that README's
// own "Why there's no WebSocket version of this" section), so every check
// here goes through the poll routes directly: /presence/poll/join,
// /join-status, /duplicate-response, /activity, /sync — there's no WS
// variant to also exercise the way the Node test does. Same "spin up an
// isolated throwaway PHP dev server, talk to it with raw fetch, no
// browser involved" shape as manual-presence-php.js.
//
// ACTIVITY_IDLE_MS and DUPLICATE_JOIN_COUNTDOWN_MS are shrunk way down via
// env override, same convention the Node test and PRESENCE_POLL_TIMEOUT_MS
// itself already use — presence-php/lib/store.php's own
// PRESENCE_ACTIVITY_IDLE_MS/PRESENCE_DUPLICATE_JOIN_COUNTDOWN_MS read the
// exact same ACTIVITY_IDLE_MS/DUPLICATE_JOIN_COUNTDOWN_MS env var names as
// the Node version, on purpose, so one env can drive both.
//
// Checks:
//   1. An existing member idle past ACTIVITY_IDLE_MS is silently replaced
//      by a second join under the same publicKey — immediate {id, roster}
//      for the newcomer (roster empty, the stale member is gone), no
//      {status:'pending'} at all.
//   2. An existing member who's been active recently is NOT replaced
//      immediately: the second /presence/poll/join returns
//      {status:'pending', challengeId, countdownMs}, and the existing
//      member's own next /presence/poll/sync drains a
//      'duplicate-join-request' signal for that same challengeId.
//   3. The existing member explicitly answers 'keep' via
//      /presence/poll/duplicate-response — the newcomer's /join-status
//      settles to {status:'denied'}, and the existing member is
//      completely undisturbed (its own next sync still works normally,
//      it is not evicted).
//   4. Same setup, but the existing member explicitly answers 'yield' —
//      the newcomer's /join-status settles to {status:'joined', id,
//      roster} (reusing the SAME id the pending /join response already
//      gave it), and the existing member's own next sync now 404s (it's
//      been evicted).
//   5. The countdown lapses with no response at all — because PHP has no
//      real timer (see lib/store.php's own comment on
//      presence_sweep_challenges()), this is resolved lazily by the next
//      request that happens to touch the store; polling /join-status
//      itself is enough to trigger that sweep. Newcomer wins by default,
//      exactly like an explicit yield.
//   6. An explicit activity ping (/presence/poll/activity — the wallet
//      activity stand-in, since wallet.js has no presence connection of
//      its own to test through here) resets the idle clock — a
//      recently-pinged member still gets challenged, not silently
//      replaced, even once enough time has passed since its ORIGINAL join
//      that it would otherwise have gone stale.
//   7. Two anonymous (no publicKey) joins in the same room never trigger
//      any of this — nothing to correlate them by, so both just join
//      normally side by side.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 8199; // isolated port, distinct from every other manual-presence-*.js / manual-*-php.js test's own port
const BASE = 'http://localhost:' + PORT;
const BUNDLE_DIR = path.resolve(__dirname, '..', 'presence-php');
const STORE_FILE = path.resolve(BUNDLE_DIR, 'presence', 'lib', 'atlas-presence-store.json');

const ACTIVITY_IDLE_MS = 500;
const DUPLICATE_JOIN_COUNTDOWN_MS = 600;

function post(urlPath, body) {
  return fetch(BASE + urlPath, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}
function pollJoin(domain, world, name, publicKey) { return post('/presence/poll/join', { domain, world, name, publicKey }); }
function pollJoinStatus(challengeId) { return post('/presence/poll/join-status', { challengeId }); }
function pollDuplicateResponse(id, challengeId, decision) { return post('/presence/poll/duplicate-response', { id, challengeId, decision }); }
function pollActivity(id) { return post('/presence/poll/activity', { id }); }
function pollSync(id, pos) { return post('/presence/poll/sync', Object.assign({ id }, pos || {})); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// The countdown is resolved lazily (any store touch can trigger the
// sweep) rather than by a real timer — see lib/store.php's own comment.
// This polls /join-status, which itself touches the store on every call,
// until the sweep has had a chance to fire.
async function waitForJoinStatus(challengeId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let status = await pollJoinStatus(challengeId);
  while (status.body.status === 'pending' && Date.now() < deadline) {
    await sleep(40);
    status = await pollJoinStatus(challengeId);
  }
  return status;
}

(async () => {
  console.log('SETUP: starting PHP\'s built-in dev server against presence-php/test-router.php, with shrunk activity/countdown timers');
  try { fs.unlinkSync(STORE_FILE); } catch (err) {} // start from a clean store, same reasoning as manual-presence-php.js
  const serverProc = spawn('php', ['-S', 'localhost:' + PORT, 'test-router.php'], {
    cwd: BUNDLE_DIR,
    env: { ...process.env, ACTIVITY_IDLE_MS: String(ACTIVITY_IDLE_MS), DUPLICATE_JOIN_COUNTDOWN_MS: String(DUPLICATE_JOIN_COUNTDOWN_MS) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('php -S did not start in time')), 5000);
    serverProc.stderr.on('data', (d) => { if (d.toString().includes('started')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('php -S exited early with code ' + code)));
  });
  console.log('PASS: PHP dev server up on port ' + PORT);

  try {
    console.log('STEP 1: a stale existing member (idle past ACTIVITY_IDLE_MS) is silently replaced, no challenge');
    const joinA1 = await pollJoin('d1', 'w1', 'A1', 'PK1');
    if (joinA1.body.status === 'pending') throw new Error('Expected A1\'s own join to be immediate, got: ' + JSON.stringify(joinA1.body));
    await sleep(ACTIVITY_IDLE_MS + 150); // cross the idle threshold with zero activity
    const joinB1 = await pollJoin('d1', 'w1', 'B1', 'PK1');
    if (joinB1.body.status === 'pending') throw new Error('Expected B1 to join immediately with no challenge, got: ' + JSON.stringify(joinB1.body));
    if (!joinB1.body.id || joinB1.body.roster.length !== 0) throw new Error('Expected B1\'s roster to be empty — A1 should already be gone, got: ' + JSON.stringify(joinB1.body));
    console.log('PASS: stale identity silently replaced, newcomer joined immediately with an empty roster');

    console.log('STEP 2: an ACTIVE existing member is not replaced immediately — newcomer told pending, existing member notified via its next sync');
    const joinA2 = await pollJoin('d1', 'w2', 'A2', 'PK2');
    const idA2 = joinA2.body.id;
    const joinB2 = await pollJoin('d1', 'w2', 'B2', 'PK2'); // immediately — A2 is clearly still active
    if (joinB2.body.status !== 'pending' || !joinB2.body.challengeId) throw new Error('Expected B2 to be told pending, got: ' + JSON.stringify(joinB2.body));
    const syncA2 = await pollSync(idA2, { x: 0, y: 0, z: 0, yaw: 0 });
    const noticeA2 = (syncA2.body.signals || []).find((s) => s.kind === 'duplicate-join-request');
    if (!noticeA2 || noticeA2.challengeId !== joinB2.body.challengeId) throw new Error('Expected A2\'s next sync to drain a duplicate-join-request signal for the same challenge, got: ' + JSON.stringify(syncA2.body));
    console.log('PASS: active existing member notified via its own next sync, newcomer told pending with a matching challengeId');

    console.log('STEP 3: the existing member explicitly answers "keep" — newcomer denied, existing member undisturbed');
    const resp2 = await pollDuplicateResponse(idA2, joinB2.body.challengeId, 'keep');
    if (resp2.status !== 200 || resp2.body.ok !== true) throw new Error('Expected duplicate-response to return {ok:true}, got: ' + JSON.stringify(resp2));
    const status2 = await pollJoinStatus(joinB2.body.challengeId);
    if (status2.body.status !== 'denied') throw new Error('Expected B2\'s join-status to be denied after A2 chose keep, got: ' + JSON.stringify(status2.body));
    const syncA2Again = await pollSync(idA2);
    if (syncA2Again.status !== 200) throw new Error('Expected A2 to still be able to sync normally after choosing keep, got status ' + syncA2Again.status);
    console.log('PASS: "keep" denied the newcomer and left the existing member fully present');

    console.log('STEP 4: the existing member explicitly answers "yield" — newcomer joins (reusing its original id), existing member evicted');
    const joinA3 = await pollJoin('d1', 'w3', 'A3', 'PK3');
    const idA3 = joinA3.body.id;
    const joinB3 = await pollJoin('d1', 'w3', 'B3', 'PK3');
    if (joinB3.body.status !== 'pending') throw new Error('Expected B3 to be pending, got: ' + JSON.stringify(joinB3.body));
    const idB3 = joinB3.body.id;
    await pollDuplicateResponse(idA3, joinB3.body.challengeId, 'yield');
    const status3 = await pollJoinStatus(joinB3.body.challengeId);
    if (status3.body.status !== 'joined' || status3.body.id !== idB3) throw new Error('Expected B3\'s join-status to report joined with its original id, got: ' + JSON.stringify(status3.body));
    const syncA3After = await pollSync(idA3);
    if (syncA3After.status !== 404) throw new Error('Expected A3 to be evicted (404 on its own next sync) after yielding, got status ' + syncA3After.status);
    console.log('PASS: "yield" evicted the existing member and completed the newcomer\'s pending join under its original id');

    console.log('STEP 5: the countdown lapses with no response at all — newcomer wins by default via the lazy sweep');
    const joinA4 = await pollJoin('d1', 'w4', 'A4', 'PK4');
    const joinB4 = await pollJoin('d1', 'w4', 'B4', 'PK4');
    if (joinB4.body.status !== 'pending') throw new Error('Expected B4 to be pending, got: ' + JSON.stringify(joinB4.body));
    // Deliberately never answer — just wait out the countdown, polling
    // join-status (itself a store touch) until the lazy sweep resolves it.
    const status4 = await waitForJoinStatus(joinB4.body.challengeId, DUPLICATE_JOIN_COUNTDOWN_MS + 2000);
    if (status4.body.status !== 'joined') throw new Error('Expected B4 to win by default once the countdown lapsed unanswered, got: ' + JSON.stringify(status4.body));
    const syncA4After = await pollSync(joinA4.body.id);
    if (syncA4After.status !== 404) throw new Error('Expected A4 to have been evicted by the timeout, got status ' + syncA4After.status);
    console.log('PASS: silent countdown timeout resolved in the newcomer\'s favor, exactly like an explicit yield');

    console.log('STEP 6: an explicit activity ping resets the idle clock — a recently-pinged member still gets challenged, not silently replaced');
    const joinA5 = await pollJoin('d1', 'w5', 'A5', 'PK5');
    await sleep(ACTIVITY_IDLE_MS - 150); // most of the way to stale...
    const ping5 = await pollActivity(joinA5.body.id); // ...but a ping resets the clock right before it would have gone stale
    if (ping5.status !== 200 || ping5.body.ok !== true) throw new Error('Expected activity ping to return {ok:true}, got: ' + JSON.stringify(ping5));
    await sleep(ACTIVITY_IDLE_MS - 150); // now well past ACTIVITY_IDLE_MS since JOIN, but well within it since the ping
    const joinB5 = await pollJoin('d1', 'w5', 'B5', 'PK5');
    if (joinB5.body.status !== 'pending') throw new Error('Expected the activity ping to keep A5 "active" (challenge, not silent replace), got: ' + JSON.stringify(joinB5.body));
    console.log('PASS: activity ping correctly kept the existing member out of the stale/silent-replace path');
    // Clean up: let A5 yield so this challenge doesn't linger into later steps.
    await pollDuplicateResponse(joinA5.body.id, joinB5.body.challengeId, 'yield');

    console.log('STEP 7: two anonymous (no publicKey) visitors never trigger any of this — both just join normally');
    const joinAnon1 = await pollJoin('d1', 'w6', 'Anon1', null);
    if (joinAnon1.body.status === 'pending') throw new Error('Expected the first anonymous visitor to join normally, got: ' + JSON.stringify(joinAnon1.body));
    const joinAnon2 = await pollJoin('d1', 'w6', 'Anon2', null);
    if (joinAnon2.body.status === 'pending' || joinAnon2.body.roster.length !== 1) throw new Error('Expected the second anonymous visitor to also join normally (no dedupe possible with no publicKey), got: ' + JSON.stringify(joinAnon2.body));
    console.log('PASS: anonymous visitors are never deduped against each other');

    console.log('\nALL DUPLICATE-IDENTITY JOIN (#137) PHP CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    serverProc.kill();
    try { fs.unlinkSync(STORE_FILE); } catch (err) {}
  }
})();
