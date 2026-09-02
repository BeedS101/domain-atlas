// Manual protocol check for presence-server/server.js's Friends (#67) and
// Favorites (#61) extensions: publicKey on roster members, the signal
// relay (friend-request / friend-request-accepted / friend-request-declined),
// and the read-only /presence/status endpoint. Run in isolation from the
// extension, same reasoning as manual-presence-server.js — proves the
// protocol itself is correct (both the WebSocket 'signal' message and the
// polling /presence/poll/signal route, since Friends works identically
// over either transport) before trusting anything in the browser against
// it. See manual-presence-php.js's own signal/status checks for the PHP
// backend's equivalent (polling-only, no WS branch to test there).
//
// Checks:
//   1. join carries publicKey through to the OTHER member's roster (both
//      WS welcome/joined and poll join/sync responses).
//   2. A WS member sends a friend-request signal to another WS member —
//      delivered as an immediate push ('signal' message), not queued.
//   3. The recipient replies with friend-request-accepted — delivered back
//      the same way; confirms the relay works in both directions between
//      two WS members.
//   4. A signal with an unrecognized kind is silently refused (ok:false on
//      the poll route; no message pushed on the WS route) — the closed
//      vocabulary actually holds.
//   5. A signal aimed at an id NOT in the sender's room (wrong id, or
//      someone in a different room entirely) is refused the same way —
//      the relay can't be used to reach across rooms.
//   6. Poll-transport signal: a WS member signals a POLLING member — no
//      persistent connection to push down, so it must be queued and
//      picked up on the poll member's next /presence/poll/sync (the
//      `signals` field), not delivered immediately.
//   7. GET /presence/status returns the room's live count+roster (with
//      publicKey) WITHOUT creating a member — the room's size is
//      unchanged after the call, unlike join.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const path = require('path');

const PORT = 8096; // isolated port, distinct from every other manual-presence-*.js test's own port
const URL = 'ws://localhost:' + PORT + '/presence';
const HTTP_BASE = 'http://localhost:' + PORT;

function pollJoin(domain, world, name, publicKey) {
  return fetch(HTTP_BASE + '/presence/poll/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain, world, name, publicKey })
  }).then((r) => r.json());
}
function pollSync(id) {
  return fetch(HTTP_BASE + '/presence/poll/sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id })
  }).then((r) => r.json());
}
function pollSignal(id, to, kind, publicKey, name) {
  return fetch(HTTP_BASE + '/presence/poll/signal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, to, kind, publicKey, name })
  }).then((r) => r.json());
}
function getStatus(domain, world) {
  return fetch(HTTP_BASE + '/presence/status?domain=' + encodeURIComponent(domain) + '&world=' + encodeURIComponent(world))
    .then((r) => r.json());
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const queue = [];
    let waiter = null;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (waiter) { const w = waiter; waiter = null; w(msg); } else { queue.push(msg); }
    });
    ws.addEventListener('open', () => resolve({
      send: (obj) => ws.send(JSON.stringify(obj)),
      next: (timeoutMs = 2000) => queue.length
        ? Promise.resolve(queue.shift())
        : new Promise((res, rej) => { waiter = res; setTimeout(() => rej(new Error('timed out waiting for a message')), timeoutMs); }),
      // Proves NO message arrives within the window — used for STEP 4/5's
      // negative checks (an invalid kind or a wrong target must not relay).
      expectSilence: (windowMs = 400) => new Promise((res, rej) => {
        if (queue.length) { rej(new Error('expected silence, but a message was already queued: ' + JSON.stringify(queue[0]))); return; }
        waiter = (msg) => rej(new Error('expected silence, but got: ' + JSON.stringify(msg)));
        setTimeout(() => { waiter = null; res(); }, windowMs);
      }),
      close: () => ws.close()
    }));
    ws.addEventListener('error', reject);
  });
}

(async () => {
  console.log('SETUP: starting presence-server on an isolated port');
  const serverProc = spawn(process.execPath, [path.resolve(__dirname, '..', 'presence-server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('presence-server did not start in time')), 5000);
    serverProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('presence-server exited early with code ' + code)));
  });
  console.log('PASS: server up on port', PORT);

  try {
    console.log('STEP 1: publicKey travels through to the roster, both transports');
    const a = await connect();
    a.send({ type: 'join', domain: 'evtec.co.za', world: 'lobby', name: 'Alice', publicKey: 'pk-alice' });
    const welcomeA = await a.next();
    const idA = welcomeA.id;

    const b = await connect();
    b.send({ type: 'join', domain: 'evtec.co.za', world: 'lobby', name: 'Bob', publicKey: 'pk-bob' });
    const welcomeB = await b.next();
    const idB = welcomeB.id;
    if (welcomeB.roster[0].publicKey !== 'pk-alice') throw new Error('Expected Bob\'s roster to show Alice\'s publicKey, got: ' + JSON.stringify(welcomeB.roster));
    const joinedMsgForA = await a.next(); // A gets pushed Bob's 'joined' event
    if (joinedMsgForA.publicKey !== 'pk-bob') throw new Error('Expected the joined push to carry Bob\'s publicKey, got: ' + JSON.stringify(joinedMsgForA));
    console.log('PASS: publicKey shows up on both the welcome roster and the joined push (WS)');

    const joinPoll = await pollJoin('evtec.co.za', 'lobby', 'Carol', 'pk-carol');
    const idC = joinPoll.id;
    if (!joinPoll.roster.some((m) => m.publicKey === 'pk-alice') || !joinPoll.roster.some((m) => m.publicKey === 'pk-bob')) {
      throw new Error('Expected Carol\'s poll-join roster to show both WS members\' publicKeys, got: ' + JSON.stringify(joinPoll.roster));
    }
    // Carol's poll-join also broadcasts 'joined' to both WS members (Alice,
    // Bob) — drain those now so STEPs 2-3's next() calls see the signal
    // messages they're actually waiting for, not this unrelated push.
    await a.next();
    await b.next();
    console.log('PASS: publicKey shows up in a poll join roster too, mixed transport');

    console.log('STEP 2: Bob sends a friend-request to Alice — delivered as an immediate WS push');
    b.send({ type: 'signal', to: idA, kind: 'friend-request', publicKey: 'pk-bob', name: 'Bob' });
    const sig1 = await a.next();
    if (sig1.type !== 'signal' || sig1.from !== idB || sig1.kind !== 'friend-request' || sig1.publicKey !== 'pk-bob') {
      throw new Error('Expected Alice to receive Bob\'s friend-request signal, got: ' + JSON.stringify(sig1));
    }
    console.log('PASS: friend-request relayed immediately, WS -> WS');

    console.log('STEP 3: Alice replies with friend-request-accepted — relayed back the other direction');
    a.send({ type: 'signal', to: idB, kind: 'friend-request-accepted', publicKey: 'pk-alice', name: 'Alice' });
    const sig2 = await b.next();
    if (sig2.type !== 'signal' || sig2.from !== idA || sig2.kind !== 'friend-request-accepted' || sig2.publicKey !== 'pk-alice') {
      throw new Error('Expected Bob to receive Alice\'s friend-request-accepted signal, got: ' + JSON.stringify(sig2));
    }
    console.log('PASS: friend-request-accepted relayed back correctly');

    console.log('STEP 4: an unrecognized signal kind is silently refused, not relayed');
    b.send({ type: 'signal', to: idA, kind: 'not-a-real-kind', publicKey: 'pk-bob', name: 'Bob' });
    await a.expectSilence();
    console.log('PASS: bogus kind produced no relay at all');

    console.log('STEP 5: a signal aimed at someone NOT in the sender\'s room is refused (rooms stay isolated)');
    const joinD = await pollJoin('evtec.co.za', 'plaza', 'Dave', 'pk-dave'); // different world = different room
    const signalToWrongRoom = await pollSignal(idC, joinD.id, 'friend-request', 'pk-carol', 'Carol');
    if (signalToWrongRoom.ok !== false) throw new Error('Expected a signal aimed at a different room to be refused, got: ' + JSON.stringify(signalToWrongRoom));
    console.log('PASS: a target outside the sender\'s own room is refused, same as an unknown id');

    console.log('STEP 6: WS -> poll signal is queued, not lost — picked up on the poll member\'s next sync');
    b.send({ type: 'signal', to: idC, kind: 'friend-request', publicKey: 'pk-bob', name: 'Bob' });
    await new Promise((r) => setTimeout(r, 150)); // let the relay land server-side
    const syncC = await pollSync(idC);
    if (!syncC.signals || syncC.signals.length !== 1 || syncC.signals[0].kind !== 'friend-request' || syncC.signals[0].from !== idB) {
      throw new Error('Expected Carol\'s next sync to carry Bob\'s queued friend-request, got: ' + JSON.stringify(syncC));
    }
    const syncCAgain = await pollSync(idC);
    if ((syncCAgain.signals || []).length !== 0) throw new Error('Expected the signal to be drained after the first sync picked it up, got: ' + JSON.stringify(syncCAgain));
    console.log('PASS: a signal aimed at a polling member queues and drains exactly once, WS -> poll');

    console.log('STEP 7: GET /presence/status reports the room without creating a member');
    const statusBefore = await getStatus('evtec.co.za', 'lobby');
    if (statusBefore.count !== 3) throw new Error('Expected 3 in the lobby (Alice, Bob, Carol), got: ' + JSON.stringify(statusBefore));
    if (!statusBefore.roster.some((m) => m.publicKey === 'pk-alice') || !statusBefore.roster.some((m) => m.publicKey === 'pk-carol')) {
      throw new Error('Expected the status roster to include everyone\'s publicKey, got: ' + JSON.stringify(statusBefore.roster));
    }
    const statusAgain = await getStatus('evtec.co.za', 'lobby');
    if (statusAgain.count !== statusBefore.count) throw new Error('Calling /presence/status twice changed the room\'s count — it must be read-only, got ' + statusBefore.count + ' then ' + statusAgain.count);
    const statusEmpty = await getStatus('evtec.co.za', 'nonexistent-world');
    if (statusEmpty.count !== 0 || statusEmpty.roster.length !== 0) throw new Error('Expected a room that has never existed to report {count:0, roster:[]}, got: ' + JSON.stringify(statusEmpty));
    console.log('PASS: /presence/status reports the live roster twice in a row without creating anything');

    console.log('\nALL PRESENCE SIGNAL/STATUS CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    serverProc.kill();
  }
})();
