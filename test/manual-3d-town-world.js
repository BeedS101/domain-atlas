// The Lobby's outdoor town in the normal world renderer (extension +
// issuer-server on an isolated copy of demo-domain-a, using the real Lobby
// scene). The pure data and walkability checks are in
// manual-3d-town-layout-unit.js; this drives the real renderer with the
// keyboard (the full tour takes several minutes under a software GL stack).
//
//   1. The playable area: the engine's own collision agrees with the layout
//      model on a grid across the whole lot, the floor edge and boundary stop
//      the player, and the character scale is still 0.5.
//   2. Real walking (held W, aimed at each waypoint): from the spawn out of the
//      entrance, all the way round the building on its four sides without
//      touching it, out to every zone (hut, mine, overlook, river, south-east
//      lawn, plaza, market) and back inside.
//   3. The Lobby interior is unchanged: the reading-nook anchor and the crates'
//      interaction points are where they were, the closed doorway and the
//      reception desk still block.
//   4. The textured portal gate still takes the player to the Plaza and back.
//   5. Leaving the Lobby frees every GL texture the town created; no page errors.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sleep, trackTextures } = require('./portal-test-lib');
const W = require('./town-walk-lib');
const LAY = require('../tools/lib/lobby-town-layout');

const REPO = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO, 'extension');
const PORT = 8361;
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-town-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-town-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-town-profile-'));
const MAIN_MANIFEST_PATH = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');

function assert(cond, msg) { if (!cond) throw new Error(msg); }
const B = LAY.BUILDING;
const distToBuilding = (x, z) => Math.hypot(Math.max(B.minX - x, 0, x - B.maxX), Math.max(B.minZ - z, 0, z - B.maxZ));

(async () => {
  console.log('SETUP: isolated copy of demo-domain-a');
  fs.cpSync(path.join(REPO, 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(MAIN_MANIFEST_PATH, 'utf8'));
  manifest.domain = DOMAIN;
  fs.writeFileSync(MAIN_MANIFEST_PATH, JSON.stringify(manifest, null, 2));

  const scene = W.readScene();
  const col = W.collision(scene);
  const grid = W.makeGrid(scene, 0.45, 0.1); // walking margin so the aimed player does not graze a corner
  const portalClear = (x, z) => Math.hypot(x, z - 4.7) < 1.1; // keep routes out of the gate's activation area

  const serverProc = spawn('node', ['issuer-server/server.js'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(PORT), ATLAS_DOMAIN: DOMAIN, ATLAS_STATE_DIR: STATE_DIR, ATLAS_DOCROOT: DOCROOT_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('issuer-server did not start in time')), 10000);
    serverProc.stdout.on('data', (d) => { if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); } });
    serverProc.on('exit', (code) => reject(new Error('issuer-server exited early with code ' + code)));
  });

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist']
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    const warnings = [];
    page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });

    await page.goto('http://' + DOMAIN, { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });

    const tex = await trackTextures(frame);
    const place = () => frame.evaluate(() => document.getElementById('placeLabel').textContent);
    const cam = () => frame.evaluate(() => { const c = window.__atlasActive3D.camera; return { x: c.pos[0], y: c.pos[1], z: c.pos[2], yaw: c.yaw }; });
    const setPos = (x, z, yawDeg) => frame.evaluate(([px, pz, yaw]) => { const c = window.__atlasActive3D.camera; c.pos[0] = px; c.pos[2] = pz; c.yaw = yaw * Math.PI / 180; c.pitch = 0; }, [x, z, yawDeg]);
    const key = (type) => frame.evaluate((t) => window.dispatchEvent(new KeyboardEvent(t, { code: 'KeyW' })), type);

    await tex.reset();
    await frame.evaluate(() => loadManifest(currentManifestUrl, 'lobby', null));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby') && !!window.__atlasActive3D, null, { timeout: 30000 });
    await frame.evaluate(() => window.__atlasActive3D.ready);
    await sleep(1500);
    await frame.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });

    // Walks with W held, re-aiming the camera at the next waypoint on every poll. Fails if the player stops
    // making progress (a snag), and records where the player went.
    const trace = [];
    async function walkTo(waypoints, label) {
      await key('keydown');
      try {
        for (const [wx, wz] of waypoints) {
          let last = await cam(), lastMoveAt = Date.now(), iterations = 0;
          for (;;) {
            const c = await cam();
            const dx = wx - c.x, dz = wz - c.z, d = Math.hypot(dx, dz);
            if (d < 0.3) break;
            await frame.evaluate((yaw) => { window.__atlasActive3D.camera.yaw = yaw; }, Math.atan2(dx, -dz));
            await sleep(30);
            const n = await cam();
            trace.push([n.x, n.z]);
            if (Math.hypot(n.x - last.x, n.z - last.z) > 0.03) { last = n; lastMoveAt = Date.now(); }
            assert(Date.now() - lastMoveAt < 2500, label + ': the player stopped at (' + n.x.toFixed(2) + ', ' + n.z.toFixed(2) + ') on the way to (' + wx.toFixed(1) + ', ' + wz.toFixed(1) + ')');
            assert(++iterations < 1500, label + ': did not reach (' + wx.toFixed(1) + ', ' + wz.toFixed(1) + ') in time');
          }
        }
      } finally { await key('keyup'); }
      await sleep(150);
    }
    // The route starts from where the player actually is, not from where the last leg was aimed.
    const planned = async (from, to) => {
      const c0 = await cam();
      const r = W.route(grid, col, 0.65, [c0.x, c0.z], to, portalClear) || W.route(grid, col, 0.65, from, to, portalClear);
      assert(r, 'a walking route exists from ' + JSON.stringify(from) + ' to ' + JSON.stringify(to));
      return r.slice(1);
    };

    console.log('STEP 1: the playable area');
    const info = await frame.evaluate(() => {
      const w = window.__atlasActive3D;
      return { scale: w.getCharacterScale(), cam: [...w.camera.pos] };
    });
    assert(info.scale === 0.5, 'character scale stays 0.5, got ' + info.scale);
    assert(Math.abs(info.cam[0]) < 0.01 && Math.abs(info.cam[2] - 3.4) < 0.01, 'spawn is unchanged: ' + JSON.stringify(info.cam));
    // the engine and the layout model agree on every point of a 0.5 m grid over the lot and a margin beyond it
    const pts = [];
    for (let x = -21; x <= 21; x += 0.5) for (let z = -18; z <= 24; z += 0.5) pts.push([x, z]);
    const engine = await frame.evaluate((p) => p.map(([x, z]) => window.__atlasActive3D.isPositionBlocked(x, z)), pts);
    const mismatches = pts.filter((p, i) => engine[i] !== col.blocked(p[0], p[1], 0.3));
    assert(mismatches.length === 0, 'engine collision differs from the layout model at ' + mismatches.length + ' of ' + pts.length + ' points, first: ' + JSON.stringify(mismatches.slice(0, 5)));
    const open = engine.filter((b) => !b).length;
    for (const [x, z] of [[20.3, 0], [-20.3, 0], [0, -17.3], [3, 23.3]]) assert(await frame.evaluate(([px, pz]) => window.__atlasActive3D.isPositionBlocked(px, pz), [x, z]), 'beyond the floor edge at (' + x + ', ' + z + ') is blocked');
    console.log('PASS: the engine agrees with the layout model at all ' + pts.length + ' sampled points (' + open + ' open); the lot edges block; scale 0.5; spawn unchanged');

    console.log('STEP 2: real walking');
    await setPos(0, 3.4, 0);
    const t0 = Date.now();
    await walkTo(await planned([0, 3.4], LAY.ZONES.entrance.stand), 'spawn to the doorstep');
    let c = await cam();
    assert(c.z > 5.8 && Math.abs(c.x - 3.2) < 0.6, 'out of the entrance, at ' + JSON.stringify(c));
    assert((await place()).includes('Example Lobby'), 'still in the Lobby after walking out');
    console.log('PASS: walked from the spawn out through the entrance door to (' + c.x.toFixed(1) + ', ' + c.z.toFixed(1) + ')');

    // One continuous tour: the loop round the building is walked leg by leg (west side, north, east, south), with a
    // detour out to each zone on the way, then back to the door and inside.
    const tour = [
      { id: 'hut', via: [[-9.4, 7.5], [-9.4, 0.8]] },
      { id: 'mine', via: [[-9.4, -8]] },
      { id: 'overlook', via: [[0, -8], [9.4, -8]] },
      { id: 'river', via: [[9.4, 0]] },
      { id: 'lawn', via: [[9.4, 7.5]] },
      { id: 'plaza', via: [] },
      { id: 'market', via: [] }
    ];
    const loopStart = trace.length;
    let here = LAY.ZONES.entrance.stand;
    for (const leg of tour) {
      const z = LAY.ZONES[leg.id];
      for (const next of leg.via.concat([z.stand])) {
        await walkTo(await planned(here, next), leg.id === 'hut' && next !== z.stand ? 'round the building' : 'to ' + leg.id);
        here = next;
      }
      c = await cam();
      assert(Math.hypot(c.x - z.stand[0], c.z - z.stand[1]) < 0.6, 'arrived at ' + z.label + ' ' + JSON.stringify(z.stand) + ', at ' + JSON.stringify(c));
      console.log('PASS: walked to ' + z.label + ' (' + c.x.toFixed(1) + ', ' + c.z.toFixed(1) + ')');
    }
    await walkTo(await planned(here, LAY.ZONES.entrance.stand), 'back to the entrance');
    const loop = trace.slice(loopStart);
    const nearest = Math.min(...loop.map(([x, z]) => distToBuilding(x, z)));
    assert(nearest > 0.3, 'the tour never touches the building walls (closest ' + nearest.toFixed(2) + ' m)');
    const sidesSeen = {
      north: loop.some(([x, z]) => z < B.minZ - 1 && Math.abs(x) < 6), south: loop.some(([x, z]) => z > B.maxZ + 1 && x < -5),
      west: loop.some(([x, z]) => x < B.minX - 1 && Math.abs(z) < 4), east: loop.some(([x, z]) => x > B.maxX + 1 && Math.abs(z) < 4)
    };
    assert(Object.values(sidesSeen).every(Boolean), 'the walk passed along all four sides: ' + JSON.stringify(sidesSeen));
    console.log('PASS: walked all the way round the building (north, east, south and west sides) and out to every zone: hut, mine, overlook, river, lawn, plaza and market');
    await walkTo(await planned(LAY.ZONES.entrance.stand, [0.5, 3.4]), 'back inside');
    c = await cam();
    assert(c.z < 5.0 && (await place()).includes('Example Lobby'), 'back inside the Lobby, at ' + JSON.stringify(c));
    console.log('PASS: walked back in through the entrance (' + Math.round((Date.now() - t0) / 1000) + ' s of walking in all, ' + trace.length + ' position samples)');

    console.log('STEP 3: the interior is unchanged');
    for (const [name, x, z] of [['reception desk', -0.45, -4.84], ['closed centre doorway', 0, 5.55], ['wall beside the entrance', 1.8, 5.55]]) {
      assert(await frame.evaluate(([px, pz]) => window.__atlasActive3D.isPositionBlocked(px, pz), [x, z]), name + ' still blocks');
    }
    for (const [name, x, z] of [['spawn', 0, 3.4], ['entrance doorway', 3.2, 5.55], ['reading-nook anchor', -3.9, -0.8]]) {
      assert(!(await frame.evaluate(([px, pz]) => window.__atlasActive3D.isPositionBlocked(px, pz), [x, z])), name + ' is still walkable');
    }
    const sceneData = await frame.evaluate(async () => (await (await fetch(new URL('/spatial/lobby/scene.json', currentManifestUrl))).json()));
    assert(sceneData.anchors.some((a) => a.id && JSON.stringify(a.position) === JSON.stringify(scene.anchors.find((b) => b.id === a.id).position)), 'anchors are as in the scene file');
    assert(sceneData.interactables.length === 8, 'the 8 interactables are still there');
    console.log('PASS: walls, desk, doorway, spawn, reading-nook anchor and the 8 interactables are as before');

    console.log('STEP 4: the portal gate still travels');
    await setPos(0, 3.4, 180);
    await sleep(400);
    assert((await place()).includes('Example Lobby'), 'still in the Lobby before walking into the gate');
    await key('keydown');
    const start = Date.now();
    while (Date.now() - start < 30000 && (await place()).includes('Example Lobby')) await sleep(120);
    await key('keyup');
    assert((await place()).includes('Example Plaza'), 'walking into the gate travels to the Plaza, place is ' + (await place()));
    await frame.evaluate(() => followPortal({ kind: 'world', to: 'lobby' }));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby') && !!window.__atlasActive3D, null, { timeout: 30000 });
    await frame.evaluate(() => window.__atlasActive3D.ready);
    await sleep(1500);
    const back = await frame.evaluate(() => ({ kind: window.__atlasActive3D.getPortalTriggerKind(0), scale: window.__atlasActive3D.getCharacterScale(), cam: [...window.__atlasActive3D.camera.pos] }));
    assert(back.kind === 'same-domain' && back.scale === 0.5 && Math.abs(back.cam[2] - 3.4) < 0.01, 'back in the Lobby at its spawn: ' + JSON.stringify(back));
    console.log('PASS: the gate took the player to the Plaza and back to the Lobby spawn');

    console.log('STEP 5: cleanup');
    await frame.evaluate(() => window.__atlasActive3D.destroy());
    assert((await tex.live()) === 0, 'expected 0 live GL textures after destroy(), got ' + (await tex.live()));
    assert(!warnings.some((m) => /texture|image/i.test(m)), 'no texture warnings: ' + warnings.join(' | '));
    assert(pageErrors.length === 0, 'no uncaught page errors: ' + pageErrors.join(' | '));
    console.log('PASS: 0 live GL textures after destroy(); no page errors');
    console.log('\nALL TOWN WORLD CHECKS PASSED');
  } catch (e) {
    console.error('FAILURE:', e);
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    serverProc.kill();
    fs.rmSync(DOCROOT_DIR, { recursive: true, force: true });
    fs.rmSync(STATE_DIR, { recursive: true, force: true });
    fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  }
})();
