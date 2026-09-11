// Manual check for task #137 (the same identity being able to enter the
// same domain+world twice) — the dedupe-by-publicKey guard added to
// presence-server/server.js's requestJoin()/addMember() split, plus the
// duplicate-join challenge (notice + Leave-now/Keep-this-session-active +
// countdown) it creates when the existing holder of that identity looks
// genuinely active rather than abandoned.
//
// Same "spin up an isolated throwaway instance, talk to it with raw
// WebSocket + fetch, no browser involved" shape as manual-presence-server.js
// — this is a server-protocol check, not an extension/viewer.js one.
// ACTIVITY_IDLE_MS and DUPLICATE_JOIN_COUNTDOWN_MS are shrunk way down from
// the real 20-minute/60-second defaults via env override, same convention
// POLL_TIMEOUT_MS/POLL_SWEEP_INTERVAL_MS already use in that file.
//
// Checks:
//   1. An existing member idle past ACTIVITY_IDLE_MS is silently replaced
//      by a second join under the same publicKey — no challenge, no
//      notice, immediate 'welcome' for the newcomer and a plain 'left'
//      for whoever was there before.
//   2. An existing (WS) member who's been active recently is NOT replaced
//      immediately: the second join gets 'join-pending', the existing
//      member is pushed a 'duplicate-join-request' signal, and an
//      explicit 'Leave now' response (decision:'yield') lets the
//      newcomer's pending join complete ('welcome') while the existing
//      member is told 'duplicate-join-lost'.
//   3. Same setup, but the existing member explicitly answers 'Keep this
//      session active' (decision:'keep') — the newcomer is told
//      'join-denied' and the existing member is completely undisturbed.
//   4. Same setup, but the existing member never answers at all — once
//      DUPLICATE_JOIN_COUNTDOWN_MS elapses, the newcomer wins by default
//      (the confirmed design default), exactly like an explicit Leave.
//   5. An explicit activity ping (the 'activity' WS message / wallet
//      activity's stand-in, since a real wallet action has no presence
//      connection of its own to test through here) keeps a member "active"
//      past when it would otherwise have gone stale enough to skip the
//      challenge — proves the idle clock really does reset, not just
//      decay unconditionally from join time.
//   6. The polling-transport path end to end: an existing poll member gets
//      the notice via its next /presence/poll/sync signals drain, answers
//      via /presence/poll/duplicate-response, and a poll-transport
//      newcomer learns the outcome via /presence/poll/join-status rather
//      than a pushed message.
//   7. Two anonymous (no publicKey) joins in the same room never trigger
//      any of this — nothing to correlate them by, so both just join
//      normally side by side.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const path = require('path');

const PORT = 8098; // isolated port, distinct from manual-presence-server.js's 8099
const URL = 'ws://localhost:' + PORT + '/presence';
const HTTP_BASE = 'http://localhost:' + PORT;

const ACTIVITY_IDLE_MS = 500;
const DUPLICATE_JOIN_COUNTDOWN_MS = 600;

function post(pathName, body) {
  return fetch(HTTP_BASE + pathName, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}
function pollJoin(domain, world, name, publicKey) { return post('/presence/poll/join', { domain, world, name, publicKey }); }
function pollJoinStatus(challengeId) { return post('/presence/poll/join-status', { challengeId }); }
function pollDuplicateResponse(id, challengeId, decision) { return post('/presence/poll/duplicate-response', { id, challengeId, decision }); }
function pollActivity(id) { return post('/presence/poll/activity', { id }); }
function pollSync(id, pos) { return post('/presence/poll/sync', Object.assign({ id }, pos || {})); }

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const queue = [];
    let waiter = null;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (waiter) { const w = waiter; waiter = null; w(msg); }
      else queue.push(msg);
    });
    ws.addEventListener('open', () => resolve({
      ws,
      send: (obj) => ws.send(JSON.stringify(obj)),
      next: (timeoutMs = 3000) => new Promise((res, rej) => {
        if (queue.length) { res(queue.shift()); return; }
        const timer = setTimeout(() => rej(new Error('Timed out waiting for a message')), timeoutMs);
        waiter = (msg) => { clearTimeout(timer); res(msg); };
      })
    }));
    ws.addEventListener('error', (e) => reject(new Error('WebSocket error: ' + (e.message || e))));
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  console.log('SETUP: starting presence-server on an isolated port with shrunk activity/countdown timers');
  const serverProc = spawn(process.execPath, [path.resolve(__dirname, '..', 'presence-server', 'server.js')], {
    env: {
      ...process.env, PORT: String(PORT),
      ACTIVITY_IDLE_MS: String(ACTIVITY_IDLE_MS),
      DUPLICATE_JOIN_COUNTDOWN_MS: String(DUPLICATE_JOIN_COUNTDOWN_MS)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('presence-server did not start in time')), 5000);
    serverProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('presence-server exited early with code ' + code)));
  });
  console.log('PASS: server up on port', PORT);

  try {
    console.log('STEP 1: a stale existing member (idle past ACTIVITY_IDLE_MS) is silently replaced, no challenge');
    const a1 = await connect();
    a1.send({ type: 'join', domain: 'd1', world: 'w1', name: 'A1', publicKey: 'PK1' });
    const welcomeA1 = await a1.next();
    if (welcomeA1.type !== 'welcome') throw new Error('Expected welcome for A1, got: ' + JSON.stringify(welcomeA1));
    await sleep(ACTIVITY_IDLE_MS + 150); // cross the idle threshold with zero activity
    // A stale eviction is deliberately SILENT — broadcast() (used by the
    // removeMember() this path reuses) always excludes the connId that
    // triggered the event, same as any normal leave, and there's no third
    // party in this room yet to be told either. A1 gets nothing at all,
    // same as an abandoned tab that just quietly stops mattering.
    let a1SawAnything = false;
    a1.ws.addEventListener('message', () => { a1SawAnything = true; });
    const b1 = await connect();
    b1.send({ type: 'join', domain: 'd1', world: 'w1', name: 'B1', publicKey: 'PK1' });
    const welcomeB1 = await b1.next();
    if (welcomeB1.type !== 'welcome') throw new Error('Expected B1 to join immediately with no challenge, got: ' + JSON.stringify(welcomeB1));
    if (welcomeB1.roster.length !== 0) throw new Error('Expected B1\'s roster to be empty — A1 should already be gone, got: ' + JSON.stringify(welcomeB1.roster));
    await sleep(150);
    if (a1SawAnything) throw new Error('Expected A1 to receive nothing at all — a stale eviction is silent to the evicted party');
    console.log('PASS: stale identity silently replaced, newcomer welcomed immediately with an empty roster, A1 told nothing');

    console.log('STEP 2: an ACTIVE existing member gets a notice; explicit "Leave now" lets the newcomer in');
    const a2 = await connect();
    a2.send({ type: 'join', domain: 'd1', world: 'w2', name: 'A2', publicKey: 'PK2' });
    const welcomeA2 = await a2.next();
    const idA2 = welcomeA2.id;
    const b2 = await connect();
    b2.send({ type: 'join', domain: 'd1', world: 'w2', name: 'B2', publicKey: 'PK2' }); // immediately — A2 is clearly still active
    const pendingB2 = await b2.next();
    if (pendingB2.type !== 'join-pending') throw new Error('Expected B2 to be told join-pending, got: ' + JSON.stringify(pendingB2));
    const noticeA2 = await a2.next();
    if (noticeA2.type !== 'signal' || noticeA2.kind !== 'duplicate-join-request' || noticeA2.challengeId !== pendingB2.challengeId) {
      throw new Error('Expected A2 to receive a duplicate-join-request signal for the same challenge, got: ' + JSON.stringify(noticeA2));
    }
    console.log('PASS: active existing member notified, newcomer told to wait, same challengeId on both sides');

    a2.send({ type: 'duplicate-join-response', challengeId: noticeA2.challengeId, decision: 'yield' });
    const [lostA2, welcomeB2] = await Promise.all([a2.next(), b2.next()]);
    if (lostA2.type !== 'signal' || lostA2.kind !== 'duplicate-join-lost') throw new Error('Expected A2 to be told duplicate-join-lost, got: ' + JSON.stringify(lostA2));
    if (welcomeB2.type !== 'welcome') throw new Error('Expected B2 to finally be welcomed after A2 yielded, got: ' + JSON.stringify(welcomeB2));
    if (welcomeB2.id === idA2) throw new Error('Expected B2 to get its OWN connId, distinct from A2\'s old one, got the same: ' + welcomeB2.id);
    console.log('PASS: explicit "Leave now" evicted A2 (with notice) and completed B2\'s pending join');

    console.log('STEP 3: an ACTIVE existing member explicitly chooses "Keep this session active" — newcomer denied');
    const a3 = await connect();
    a3.send({ type: 'join', domain: 'd1', world: 'w3', name: 'A3', publicKey: 'PK3' });
    await a3.next();
    const b3 = await connect();
    b3.send({ type: 'join', domain: 'd1', world: 'w3', name: 'B3', publicKey: 'PK3' });
    const pendingB3 = await b3.next();
    const noticeA3 = await a3.next();
    a3.send({ type: 'duplicate-join-response', challengeId: noticeA3.challengeId, decision: 'keep' });
    const deniedB3 = await b3.next();
    if (deniedB3.type !== 'join-denied') throw new Error('Expected B3 to be denied after A3 chose Keep, got: ' + JSON.stringify(deniedB3));
    // A3 should see nothing further — still fully present, undisturbed.
    let a3SawAnythingElse = false;
    a3.ws.addEventListener('message', () => { a3SawAnythingElse = true; });
    await sleep(200);
    if (a3SawAnythingElse) throw new Error('A3 should not receive anything further after choosing Keep');
    console.log('PASS: "Keep this session active" denied the newcomer and left the existing member untouched');

    console.log('STEP 4: the countdown lapses with no response at all — newcomer wins by default');
    const a4 = await connect();
    a4.send({ type: 'join', domain: 'd1', world: 'w4', name: 'A4', publicKey: 'PK4' });
    await a4.next();
    const b4 = await connect();
    b4.send({ type: 'join', domain: 'd1', world: 'w4', name: 'B4', publicKey: 'PK4' });
    await b4.next(); // join-pending
    await a4.next(); // duplicate-join-request — deliberately never answered
    const [lostA4, welcomeB4] = await Promise.all([
      a4.next(DUPLICATE_JOIN_COUNTDOWN_MS + 1500),
      b4.next(DUPLICATE_JOIN_COUNTDOWN_MS + 1500)
    ]);
    if (lostA4.type !== 'signal' || lostA4.kind !== 'duplicate-join-lost') throw new Error('Expected A4 to eventually be told duplicate-join-lost on timeout, got: ' + JSON.stringify(lostA4));
    if (welcomeB4.type !== 'welcome') throw new Error('Expected B4 to be welcomed once the countdown lapsed unanswered, got: ' + JSON.stringify(welcomeB4));
    console.log('PASS: silent countdown timeout resolved in the newcomer\'s favor, exactly like an explicit Leave');

    console.log('STEP 5: an explicit activity ping resets the idle clock — a recently-pinged member still gets challenged, not silently replaced');
    const joinA5 = await pollJoin('d1', 'w5', 'A5', 'PK5');
    await sleep(ACTIVITY_IDLE_MS - 150); // most of the way to stale...
    await pollActivity(joinA5.body.id); // ...but a ping resets the clock right before it would have gone stale
    await sleep(ACTIVITY_IDLE_MS - 150); // now well past ACTIVITY_IDLE_MS since JOIN, but well within it since the ping
    const joinB5 = await pollJoin('d1', 'w5', 'B5', 'PK5');
    if (joinB5.body.status !== 'pending') throw new Error('Expected the activity ping to keep A5 "active" (challenge, not silent replace), got: ' + JSON.stringify(joinB5.body));
    console.log('PASS: activity ping correctly kept the existing member out of the stale/silent-replace path');
    // Clean up: let A5 yield so this challenge doesn't linger into later steps.
    await pollDuplicateResponse(joinA5.body.id, joinB5.body.challengeId, 'yield');

    console.log('STEP 6: full polling-transport path — notice via /sync signals, response via /duplicate-response, outcome via /join-status');
    const joinA6 = await pollJoin('d1', 'w6', 'A6', 'PK6');
    const joinB6 = await pollJoin('d1', 'w6', 'B6', 'PK6'); // A6 just joined, clearly active -> pending
    if (joinB6.body.status !== 'pending') throw new Error('Expected B6 to be pending, got: ' + JSON.stringify(joinB6.body));
    const syncA6 = await pollSync(joinA6.body.id, { x: 0, y: 0, z: 0, yaw: 0 });
    const noticeSignal = (syncA6.body.signals || []).find((s) => s.kind === 'duplicate-join-request');
    if (!noticeSignal || noticeSignal.challengeId !== joinB6.body.challengeId) throw new Error('Expected A6\'s next sync to drain the duplicate-join-request signal, got: ' + JSON.stringify(syncA6.body));
    console.log('PASS: existing poll member received the notice via its own next /sync');
    await pollDuplicateResponse(joinA6.body.id, joinB6.body.challengeId, 'yield');
    let statusB6 = await pollJoinStatus(joinB6.body.challengeId);
    for (let i = 0; i < 10 && statusB6.body.status === 'pending'; i++) { await sleep(50); statusB6 = await pollJoinStatus(joinB6.body.challengeId); }
    if (statusB6.body.status !== 'joined') throw new Error('Expected B6\'s join-status to report joined after A6 yielded, got: ' + JSON.stringify(statusB6.body));
    console.log('PASS: newcomer learned the outcome via /presence/poll/join-status, fully polling end to end');

    console.log('STEP 7: two anonymous (no publicKey) visitors never trigger any of this — both just join normally');
    const anon1 = await connect();
    anon1.send({ type: 'join', domain: 'd1', world: 'w7', name: 'Anon1' });
    const welcomeAnon1 = await anon1.next();
    if (welcomeAnon1.type !== 'welcome') throw new Error('Expected the first anonymous visitor to join normally, got: ' + JSON.stringify(welcomeAnon1));
    const anon2 = await connect();
    anon2.send({ type: 'join', domain: 'd1', world: 'w7', name: 'Anon2' });
    const [joinedAnon2ToAnon1, welcomeAnon2] = await Promise.all([anon1.next(), anon2.next()]);
    if (welcomeAnon2.type !== 'welcome') throw new Error('Expected the second anonymous visitor to also join normally (no dedupe possible with no publicKey), got: ' + JSON.stringify(welcomeAnon2));
    if (joinedAnon2ToAnon1.type !== 'joined') throw new Error('Expected the first anonymous visitor to just see a normal "joined" event, got: ' + JSON.stringify(joinedAnon2ToAnon1));
    console.log('PASS: anonymous visitors are never deduped against each other');

    console.log('\nALL DUPLICATE-IDENTITY JOIN (#137) CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    serverProc.kill();
  }
})();
