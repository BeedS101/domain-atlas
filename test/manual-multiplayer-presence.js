// Manual end-to-end check for presence/multiplayer (#66): two SEPARATE
// browser contexts (two independent "visitors") both enter the Lobby (the
// one gltf-mini-v1 world) and confirm they actually see and track each
// other through the real presence-server WebSocket — not a simulated or
// mocked connection, the genuine client<->server round trip.
//
// Requires presence-server/server.js running on its default port (8004)
// as well as the usual issuer-server on 8001 — this test does not start
// either itself (see manual-presence-server.js for an isolated protocol
// check that spins up its own throwaway instance).
//
// Checks:
//   1. Visitor A enters the Lobby alone — starts with zero remote players.
//   2. Visitor B enters the SAME Lobby — B immediately sees A in its
//      roster (getRemotePlayerCount() reaches 1), and A gets notified of
//      B joining too (both directions of the "welcome" + "joined" protocol
//      actually reach the browser, not just the server).
//   3. A renders standing on the FLOOR from B's side, not hovering at eye
//      height — regression check for a real bug where the broadcast `y`
//      was the sender's camera eye height instead of a floor-relative
//      value, so every remote character rendered floating near head
//      height. See getCharacterFloorY() in gltf-mini.js.
//   4. A walks (real WASD keydown/keyup) — B's gltf-mini renders A's
//      remote character moving: getRemotePlayerRenderState(idOfA) is
//      polled until it visibly diverges from the origin spawn default,
//      proving the move broadcast → upsertRemotePlayer → per-frame
//      interpolation pipeline works end to end, not just that a message
//      arrived.
//   5. B leaves (closes its context) — A's remote count drops back to 0,
//      proving disconnect cleanup reaches the OTHER client too.
//
// Not part of the permanent suite, same reasoning as the other
// manual-*.js scripts.

const { chromium } = require('playwright');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');

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

async function waitForCondition(frame, fn, description, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const result = await frame.evaluate(fn);
    if (result) return result;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for: ' + description);
    await new Promise((r) => setTimeout(r, 150));
  }
}

(async () => {
  const dirA = path.resolve(__dirname, '.chrome-profile-presence-a');
  const dirB = path.resolve(__dirname, '.chrome-profile-presence-b');
  const launchOpts = { headless: false, executablePath: '/opt/pw-browsers/chromium', args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox'] };

  const contextA = await chromium.launchPersistentContext(dirA, launchOpts);
  const contextB = await chromium.launchPersistentContext(dirB, launchOpts);

  try {
    const a = await enterLobby(contextA, 'Visitor A');

    console.log('STEP 1: A alone in the Lobby — zero remote players');
    const aRemoteAlone = await a.frame.evaluate(() => window.__atlasActive3D.getRemotePlayerCount());
    if (aRemoteAlone !== 0) throw new Error('Expected A to see 0 remote players before B joins, got: ' + aRemoteAlone);
    console.log('PASS: A starts with 0 remote players');

    const b = await enterLobby(contextB, 'Visitor B');

    console.log('STEP 2: B sees A, and A gets notified B joined — both directions of the protocol');
    await waitForCondition(b.frame, () => window.__atlasActive3D.getRemotePlayerCount() === 1, 'B to see exactly 1 remote player (A)');
    console.log('PASS: B sees A in its roster');
    await waitForCondition(a.frame, () => window.__atlasActive3D.getRemotePlayerCount() === 1, 'A to see exactly 1 remote player (B) after B joins');
    console.log('PASS: A was notified of B joining');

    const idOfAFromB = await b.frame.evaluate(() => window.__atlasActive3D.getRemotePlayerIds()[0]);
    const idOfAFromA = await a.frame.evaluate(() => window.__atlasPresenceOwnId);
    if (idOfAFromB !== idOfAFromA) throw new Error('The id B sees for its one remote player (' + idOfAFromB + ') should match A\'s own presence id (' + idOfAFromA + ')');
    console.log('PASS: B\'s remote-player id for A matches A\'s own presence connection id');

    console.log('STEP 3: A stands on the ground from B\'s point of view — not hovering at eye height');
    // Regression check for a real bug: currentLocalPose() in viewer.js used
    // to broadcast camera.pos[1] (eye height, ~1.6 units off the ground)
    // as a move's `y`, and upsertRemotePlayer places a remote character's
    // FEET directly at whatever y it receives — so every other visitor
    // rendered floating roughly at head height instead of standing on the
    // floor. Fixed by broadcasting getCharacterFloorY() (0 = standing,
    // matching how the local player's OWN character is placed) instead.
    // See gltf-mini.js's getCharacterFloorY() for the full explanation.
    const aFloorStateFromB = await b.frame.evaluate((id) => window.__atlasActive3D.getRemotePlayerRenderState(id), idOfAFromB);
    if (Math.abs(aFloorStateFromB.y) > 0.05) throw new Error('Expected A to render standing on the floor from B\'s side (y near 0), got y=' + aFloorStateFromB.y + ' — looks like the hovering-at-eye-height bug is back');
    console.log('PASS: A renders standing on the floor from B\'s side (y=' + aFloorStateFromB.y.toFixed(3) + '), not hovering at eye height');

    console.log('STEP 4: A walks — B\'s rendered copy of A actually moves (full move -> interpolate pipeline, not just message delivery)');
    const startState = await b.frame.evaluate((id) => window.__atlasActive3D.getRemotePlayerRenderState(id), idOfAFromB);
    await a.page.keyboard.down('KeyW');
    await a.page.waitForTimeout(700);
    await a.page.keyboard.up('KeyW');
    await b.page.waitForTimeout(500); // let A's move broadcasts arrive and B's interpolation catch up to the new network target
    const endState = await b.frame.evaluate((id) => window.__atlasActive3D.getRemotePlayerRenderState(id), idOfAFromB);
    const moved = Math.hypot(endState.x - startState.x, endState.z - startState.z);
    if (moved < 0.3) throw new Error('Expected B\'s rendered copy of A to have moved a meaningful distance after A walked forward, got: ' + moved.toFixed(3));
    console.log('PASS: B\'s rendered copy of A moved ' + moved.toFixed(2) + ' units — move broadcast + interpolation both working');

    console.log('STEP 5: B leaves — A\'s remote count drops back to 0');
    await contextB.close();
    await waitForCondition(a.frame, () => window.__atlasActive3D.getRemotePlayerCount() === 0, 'A to see 0 remote players after B disconnects', 6000);
    console.log('PASS: A correctly saw B leave');

    console.log('\nALL MULTIPLAYER PRESENCE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await contextA.close().catch(() => {});
    await contextB.close().catch(() => {});
  }
})();
