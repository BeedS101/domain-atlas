// Manual check for presence-server/server.js's hand-rolled WebSocket
// protocol (task #66) — run in isolation from the extension so the hardest
// new piece (a from-scratch RFC 6455 implementation, framing included) is
// proven correct before anything in the browser depends on it.
//
// Uses Node's own built-in WebSocket client (global since Node 20ish) —
// zero npm dependencies, matching the server's own convention.
//
// Checks:
//   1. join -> welcome with an empty roster (first client into a room).
//   2. A second client joining the SAME room: gets a welcome whose roster
//      already contains client 1, and client 1 receives a 'joined' event.
//   3. move -> the OTHER client in the room receives 'moved' with the
//      right coordinates; the sender does NOT get its own move echoed back.
//   4. A client in a DIFFERENT room (different world id) never sees any of
//      the above — proves room isolation.
//   5. Closing a connection makes the other client in its room receive
//      'left' for that connection's id.
//   6-9 (task #68): the HTTP polling fallback shares the exact same rooms
//      as the WebSocket path, not a parallel system —
//        6. a polling client joining the SAME room a WS client is already
//           in sees that WS client in its roster, AND the WS client gets a
//           real 'joined' push for the polling client (mixed transport,
//           both directions).
//        7. the polling client syncing a position push-notifies the WS
//           client with 'moved' (poll -> ws).
//        8. the WS client moving is picked up by the polling client's next
//           /sync roster (ws -> poll — polling has no push, so it pulls).
//        9. an explicit /presence/poll/leave notifies the WS client with
//           'left', same as a WS disconnect would.
//   10. (task #68) a polling client that stops syncing entirely (no
//       explicit leave — e.g. the tab was just closed) is swept out by the
//       server's staleness timer and the WS client still gets 'left' —
//       proves cleanup doesn't depend on a well-behaved client. Uses env
//       overrides to shrink the real 8s/4s timeout/sweep defaults down to
//       something worth actually waiting out in a test.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { spawn } = require('child_process');
const path = require('path');

const PORT = 8099; // isolated port so this doesn't collide with a real dev instance on 8004
const URL = 'ws://localhost:' + PORT + '/presence';
const HTTP_BASE = 'http://localhost:' + PORT;

function pollJoin(domain, world, name) {
  return fetch(HTTP_BASE + '/presence/poll/join', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain, world, name })
  }).then((r) => r.json());
}
function pollSync(id, pos) {
  return fetch(HTTP_BASE + '/presence/poll/sync', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ id }, pos || {}))
  }).then((r) => r.json());
}
function pollLeave(id) {
  return fetch(HTTP_BASE + '/presence/poll/leave', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  }).then((r) => r.json());
}

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

(async () => {
  console.log('SETUP: starting presence-server on an isolated port');
  const serverProc = spawn(process.execPath, [path.resolve(__dirname, '..', 'presence-server', 'server.js')], {
    // POLL_TIMEOUT_MS/POLL_SWEEP_INTERVAL_MS shrunk way down from the real
    // 8000/4000 defaults so STEP 10's staleness-sweep check is worth
    // actually waiting out; still comfortably longer than the near-instant
    // HTTP calls STEPs 6-9 make, so it can't fire early and evict someone
    // still "there".
    env: { ...process.env, PORT: String(PORT), POLL_TIMEOUT_MS: '1500', POLL_SWEEP_INTERVAL_MS: '250' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('presence-server did not start in time')), 5000);
    serverProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('presence-server exited early with code ' + code)));
  });
  console.log('PASS: server up on port', PORT);

  try {
    console.log('STEP 1: first client joins an empty room, gets an empty roster');
    const a = await connect();
    a.send({ type: 'join', domain: 'localhost:8001', world: 'lobby', name: 'Alice' });
    const welcomeA = await a.next();
    if (welcomeA.type !== 'welcome') throw new Error('Expected welcome, got: ' + JSON.stringify(welcomeA));
    if (welcomeA.roster.length !== 0) throw new Error('Expected an empty roster for the first joiner, got: ' + JSON.stringify(welcomeA.roster));
    const idA = welcomeA.id;
    console.log('PASS: client A welcomed with empty roster, id=' + idA);

    console.log('STEP 2: second client joins the SAME room — sees A in its roster, A gets a "joined" event');
    const b = await connect();
    b.send({ type: 'join', domain: 'localhost:8001', world: 'lobby', name: 'Bob' });
    const welcomeB = await b.next();
    if (welcomeB.roster.length !== 1 || welcomeB.roster[0].id !== idA || welcomeB.roster[0].name !== 'Alice') {
      throw new Error('Expected B\'s roster to contain exactly A, got: ' + JSON.stringify(welcomeB.roster));
    }
    const idB = welcomeB.id;
    const joinedEvent = await a.next();
    if (joinedEvent.type !== 'joined' || joinedEvent.id !== idB || joinedEvent.name !== 'Bob') {
      throw new Error('Expected A to see a "joined" event for B, got: ' + JSON.stringify(joinedEvent));
    }
    console.log('PASS: B sees A in its roster, A got notified of B joining');

    console.log('STEP 3: A moves — B receives "moved" with the right coordinates, A does not echo its own move');
    a.send({ type: 'move', x: 1.5, y: 0, z: -2.25, yaw: 0.7 });
    const movedEvent = await b.next();
    if (movedEvent.type !== 'moved' || movedEvent.id !== idA) throw new Error('Expected B to receive a "moved" event for A, got: ' + JSON.stringify(movedEvent));
    if (movedEvent.x !== 1.5 || movedEvent.z !== -2.25 || movedEvent.yaw !== 0.7) throw new Error('Moved coordinates did not round-trip: ' + JSON.stringify(movedEvent));
    let echoedToSelf = false;
    a.ws.addEventListener('message', () => { echoedToSelf = true; });
    await new Promise((r) => setTimeout(r, 200));
    if (echoedToSelf) throw new Error('A should not receive its own move broadcast back');
    console.log('PASS: move broadcast correct, no self-echo');

    console.log('STEP 4: a client in a DIFFERENT room (different world) is isolated — never sees A or B\'s traffic');
    const c = await connect();
    c.send({ type: 'join', domain: 'localhost:8001', world: 'plaza', name: 'Carol' });
    const welcomeC = await c.next();
    if (welcomeC.roster.length !== 0) throw new Error('Expected C (different room) to see an empty roster, got: ' + JSON.stringify(welcomeC.roster));
    a.send({ type: 'move', x: 9, y: 0, z: 9, yaw: 0 });
    let cSawTraffic = false;
    c.ws.addEventListener('message', () => { cSawTraffic = true; });
    await new Promise((r) => setTimeout(r, 250));
    if (cSawTraffic) throw new Error('C should never receive traffic from a different room (lobby vs plaza)');
    console.log('PASS: rooms are isolated by domain+world');

    console.log('STEP 5: closing a connection notifies the other member of its room with "left"');
    b.ws.close();
    const leftEvent = await a.next();
    if (leftEvent.type !== 'left' || leftEvent.id !== idB) throw new Error('Expected A to receive "left" for B, got: ' + JSON.stringify(leftEvent));
    console.log('PASS: disconnect correctly broadcast as "left"');

    console.log('STEP 6 (#68): a polling client joins the SAME room a WS client (A) is already in — mixed transport, both directions');
    const joinD = await pollJoin('localhost:8001', 'lobby', 'Dave');
    const idD = joinD.id;
    if (!joinD.roster.some((m) => m.id === idA && m.name === 'Alice')) {
      throw new Error('Expected the polling client\'s join roster to include WS client A, got: ' + JSON.stringify(joinD.roster));
    }
    const joinedEventForD = await a.next();
    if (joinedEventForD.type !== 'joined' || joinedEventForD.id !== idD || joinedEventForD.name !== 'Dave') {
      throw new Error('Expected WS client A to get a real "joined" push for the polling client, got: ' + JSON.stringify(joinedEventForD));
    }
    console.log('PASS: the polling client sees WS client A in its roster, and A gets pushed a real "joined" event for it');

    console.log('STEP 7 (#68): the polling client syncing a position push-notifies the WS client (poll -> ws)');
    await pollSync(idD, { x: 5, y: 0, z: 5, yaw: 1.2 });
    const movedFromD = await a.next();
    if (movedFromD.type !== 'moved' || movedFromD.id !== idD || movedFromD.x !== 5 || movedFromD.z !== 5 || movedFromD.yaw !== 1.2) {
      throw new Error('Expected A to be pushed a "moved" event for the polling client\'s sync, got: ' + JSON.stringify(movedFromD));
    }
    console.log('PASS: a polling sync push-notifies WS members exactly like a WS move would');

    console.log('STEP 8 (#68): the WS client moving is picked up by the polling client\'s next /sync roster (ws -> poll, the pull side)');
    a.send({ type: 'move', x: -3, y: 0, z: -3, yaw: 2.0 });
    await new Promise((r) => setTimeout(r, 150)); // let the move land server-side before polling for it
    const syncAfterAMoved = await pollSync(idD);
    const aInRoster = syncAfterAMoved.roster.find((m) => m.id === idA);
    if (!aInRoster || aInRoster.x !== -3 || aInRoster.z !== -3 || aInRoster.yaw !== 2.0) {
      throw new Error('Expected the polling client\'s roster to reflect A\'s new position, got: ' + JSON.stringify(aInRoster));
    }
    console.log('PASS: a polling client\'s roster reflects a WS member\'s latest position');

    console.log('STEP 9 (#68): an explicit poll leave notifies the WS client with "left", same as a WS disconnect would');
    await pollLeave(idD);
    const leftEventForD = await a.next();
    if (leftEventForD.type !== 'left' || leftEventForD.id !== idD) throw new Error('Expected A to receive "left" for the polling client, got: ' + JSON.stringify(leftEventForD));
    console.log('PASS: explicit poll leave broadcasts "left" correctly');

    console.log('STEP 10 (#68): a polling client that just stops syncing (no explicit leave) is swept out by the staleness timer');
    const joinE = await pollJoin('localhost:8001', 'lobby', 'Erin');
    const idE = joinE.id;
    await a.next(); // consume E's "joined" push — not what this step is checking
    const leftEventForE = await a.next(6000); // POLL_TIMEOUT_MS(1500) + POLL_SWEEP_INTERVAL_MS(250), both shrunk via env for this test, plus margin
    if (leftEventForE.type !== 'left' || leftEventForE.id !== idE) throw new Error('Expected A to eventually receive "left" for the abandoned polling client, got: ' + JSON.stringify(leftEventForE));
    console.log('PASS: an abandoned polling client is swept out on its own — cleanup doesn\'t depend on a well-behaved client');

    a.ws.close();
    c.ws.close();

    console.log('\nALL PRESENCE SERVER CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    serverProc.kill();
  }
})();
