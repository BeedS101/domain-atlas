// Manual end-to-end check for the HTTP polling fallback (task #68): proves
// the EXTENSION itself actually falls back from WebSocket to polling and
// still gets working multiplayer presence — not just that presence-server's
// polling routes work in isolation (see manual-presence-server.js STEPs
// 6-10 for that), but that connectPresence() in extension/viewer.js
// genuinely detects a WS-incapable server and switches transports on its
// own, end to end, through two real browser contexts.
//
// Uses presence-server's PRESENCE_DISABLE_WS=1 test hook to simulate the
// real-world case this was built for: a deployment (e.g. plain cPanel/PHP
// shared hosting, see presence-server/server.js's header comment and
// issuer-php/README.txt) that can only ever run the polling routes, never
// a persistent WebSocket process.
//
// IMPORTANT: extension/viewer.js's PRESENCE_URL/PRESENCE_HTTP_BASE are
// still hardcoded to localhost:8004 (see its own header comment — making
// that manifest-declared/per-domain is left as follow-up work), so this
// test's throwaway server must run on the REAL port 8004, not an isolated
// one. Stop any already-running presence-server on 8004 before running
// this — it needs exclusive use of that port for its duration, and hands
// it back (kills its own spawned instance) when done either way.
//
// Checks:
//   1. Visitor A enters the Lobby against a WS-disabled presence-server —
//      confirms this doesn't block world entry at all (graceful
//      degradation still holds even mid-fallback).
//   2. Visitor B enters the same Lobby — within a couple of polling
//      cycles, A and B see each other (getRemotePlayerCount() reaches 1
//      on both sides), proving the fallback actually engaged rather than
//      silently doing nothing.
//   3. B's own presence id (window.__atlasPresenceOwnId, which pollPresence()
//      sets exactly like the WS path does) matches the id A sees for its
//      one remote player — same cross-check manual-multiplayer-presence.js
//      does for the WS path, now for polling.
//   4. A renders standing on the FLOOR from B's side, not hovering at eye
//      height — regression check for a real bug where the broadcast `y`
//      was the sender's camera eye height instead of a floor-relative
//      value, so every remote character rendered floating near head
//      height. See getCharacterFloorY() in gltf-mini.js. currentLocalPose()
//      is shared code between the WS and polling transports, so this is
//      the same check as manual-multiplayer-presence.js's STEP 3, now for
//      polling.
//   5. A walks — B's rendered copy of A moves, proving the full pipeline
//      (poll sync -> reconcilePollRoster -> upsertRemotePlayer -> render
//      interpolation) works, not just that a request round-trips.
//   6. B leaves (closes its context, no graceful unload) — A's remote
//      count eventually drops back to 0 via the server's staleness sweep,
//      proving cleanup doesn't depend on a well-behaved client here either.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PRESENCE_PORT = 8004; // must match viewer.js's hardcoded PRESENCE_URL/PRESENCE_HTTP_BASE

async function projectPortals(frame) {
  return frame.evaluate(() => {
    return new Promise((resolve) => {
      const check = () => {
        if (window.__atlasScene && window.__atlasScene.portalMarkers.length) {
          const canvas = document.getElementById('scene');
          const originX = canvas.width / 2, originY = canvas.height / 2 + 40;
          const SCALE = 26, COS30 = Math.cos(Math.PI / 6), SIN30 = Math.sin(Math.PI / 6);
          resolve(window.__atlasScene.portalMarkers.map((m) => {
            const [x, , z] = m.position;
            return { sx: originX + (x - z) * COS30 * SCALE, sy: originY + (x + z) * SIN30 * SCALE, to: m.portal && m.portal.to };
          }));
        } else { requestAnimationFrame(check); }
      };
      check();
    });
  });
}

async function enterLobby(context, label) {
  const page = await context.newPage();
  await page.goto('http://localhost:8001', { waitUntil: 'load' });
  await page.locator('#domain-atlas-enter-btn').click();
  const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
  const frame = await frameHandle.contentFrame();
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), { timeout: 10000 });

  const portals = await projectPortals(frame);
  const toLobby = portals.find((p) => p.to === 'lobby');
  await frame.locator('#scene').click({ position: { x: toLobby.sx, y: toLobby.sy } });
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby'), { timeout: 10000 });
  await page.waitForTimeout(300);
  console.log('SETUP: ' + label + ' entered the Lobby');
  return { page, frame };
}

async function waitForCondition(frame, fn, description, timeoutMs = 12000) {
  const start = Date.now();
  for (;;) {
    const result = await frame.evaluate(fn);
    if (result) return result;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for: ' + description);
    await new Promise((r) => setTimeout(r, 150));
  }
}

(async () => {
  console.log('SETUP: starting a WS-disabled presence-server on the real port ' + PRESENCE_PORT + ' (simulating a polling-only host)');
  const serverProc = spawn(process.execPath, [path.resolve(__dirname, '..', 'presence-server', 'server.js')], {
    // Shrunk staleness timers, same reasoning as manual-presence-server.js's
    // env overrides — makes STEP 5's cleanup-without-a-leave-call check
    // worth actually waiting out instead of using the real 8s/4s defaults.
    env: { ...process.env, PORT: String(PRESENCE_PORT), PRESENCE_DISABLE_WS: '1', POLL_TIMEOUT_MS: '2500', POLL_SWEEP_INTERVAL_MS: '500' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('presence-server did not start in time')), 5000);
    serverProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('presence-server exited early with code ' + code + ' — is port ' + PRESENCE_PORT + ' already in use by another instance?')));
  });
  console.log('PASS: WS-disabled server up on port ' + PRESENCE_PORT);

  const dirA = path.resolve(__dirname, '.chrome-profile-presence-poll-a');
  const dirB = path.resolve(__dirname, '.chrome-profile-presence-poll-b');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };

  const contextA = await chromium.launchPersistentContext(dirA, launchOpts);
  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);

  try {
    console.log('STEP 1: A enters the Lobby against a WS-disabled presence-server — world entry is never blocked, fallback or not');
    const a = await enterLobby(contextA, 'Visitor A');
    console.log('PASS: A is in the Lobby with a WS-incapable presence-server running');

    const b = await enterLobby(contextB, 'Visitor B');

    console.log('STEP 2: within a couple of polling cycles, A and B see each other — proves the fallback actually engaged');
    await waitForCondition(b.frame, () => window.__atlasActive3D.getRemotePlayerCount() === 1, 'B to see exactly 1 remote player (A) via polling');
    console.log('PASS: B sees A in its roster via the polling fallback');
    await waitForCondition(a.frame, () => window.__atlasActive3D.getRemotePlayerCount() === 1, 'A to see exactly 1 remote player (B) via polling');
    console.log('PASS: A sees B in its roster via the polling fallback');

    const idOfAFromB = await b.frame.evaluate(() => window.__atlasActive3D.getRemotePlayerIds()[0]);
    const idOfAFromA = await a.frame.evaluate(() => window.__atlasPresenceOwnId);
    if (idOfAFromB !== idOfAFromA) throw new Error('The id B sees for its one remote player (' + idOfAFromB + ') should match A\'s own polling presence id (' + idOfAFromA + ')');
    console.log('PASS: B\'s remote-player id for A matches A\'s own presence connection id (pollPresence sets window.__atlasPresenceOwnId same as the WS path)');

    console.log('STEP 3: A stands on the ground from B\'s point of view — not hovering at eye height (polling path)');
    // Same regression check as manual-multiplayer-presence.js's own STEP 3
    // — currentLocalPose() is shared code between the WS and polling
    // transports, so a broadcast-eye-height-instead-of-floor-height bug
    // would show up identically here. See getCharacterFloorY() in
    // gltf-mini.js for the full explanation.
    const aFloorStateFromB = await b.frame.evaluate((id) => window.__atlasActive3D.getRemotePlayerRenderState(id), idOfAFromB);
    if (Math.abs(aFloorStateFromB.y) > 0.05) throw new Error('Expected A to render standing on the floor from B\'s side (y near 0), got y=' + aFloorStateFromB.y + ' — looks like the hovering-at-eye-height bug is back');
    console.log('PASS: A renders standing on the floor from B\'s side (y=' + aFloorStateFromB.y.toFixed(3) + '), not hovering at eye height, via polling too');

    console.log('STEP 4: A walks — B\'s rendered copy of A actually moves via the poll -> reconcile -> render pipeline');
    const startState = await b.frame.evaluate((id) => window.__atlasActive3D.getRemotePlayerRenderState(id), idOfAFromB);
    await a.page.keyboard.down('KeyW');
    await a.page.waitForTimeout(2200); // long enough to span at least one 2s poll cycle in both directions
    await a.page.keyboard.up('KeyW');
    await b.page.waitForTimeout(2200); // let B's next poll pick up A's latest position and interpolation catch up
    const endState = await b.frame.evaluate((id) => window.__atlasActive3D.getRemotePlayerRenderState(id), idOfAFromB);
    const moved = Math.hypot(endState.x - startState.x, endState.z - startState.z);
    if (moved < 0.3) throw new Error('Expected B\'s rendered copy of A to have moved a meaningful distance after A walked forward, got: ' + moved.toFixed(3));
    console.log('PASS: B\'s rendered copy of A moved ' + moved.toFixed(2) + ' units via polling — full fallback pipeline confirmed working');

    console.log('STEP 5: B leaves (context closed, no graceful unload) — A\'s remote count eventually drops back to 0 via the staleness sweep');
    await contextB.close();
    await waitForCondition(a.frame, () => window.__atlasActive3D.getRemotePlayerCount() === 0, 'A to see 0 remote players after B is swept out as stale', 8000);
    console.log('PASS: A correctly saw B leave, cleaned up by the server\'s staleness sweep rather than an explicit leave call');

    console.log('\nALL PRESENCE POLLING FALLBACK CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close().catch(() => {});
    await contextB.close().catch(() => {});
    serverProc.kill();
  }
})();
