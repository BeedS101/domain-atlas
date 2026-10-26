// Browser regression for the gltf-mini-v1 renderer's placement, collision and
// camera handling, run against a throwaway copy of demo-domain-a (the Lobby is
// the only 3D demo world). The pure math is covered without a browser by
// manual-3d-layout-unit.js; this drives the real renderer through the real
// viewer.
//
// Checks:
//   1. Collision matches what is drawn: solid where furniture really is
//      (including rotated pieces), clear in the empty space the old
//      origin-centered boxes used to block, and the rug can be walked on.
//   2. Real walking (WASD): furniture stops the player, the rug does not, and
//      each of the four room edges does.
//   2b. The exterior: the player walks out through the entrance door, along the
//      path to the bench, around the yard and back inside; the closed centre
//      doorway and the yard edges stop the player.
//   3. A player who starts inside an object's box can walk out of it.
//   4. A ground-level anchor (SPEC.md section 3.5's [x, 0, z] shape) spawns at
//      eye height, not on the floor.
//   5. A scene object whose model is missing is drawn as a solid placeholder
//      and the rest of the world still loads.
//   6. A dropped item's model is centered on its pivot.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8199; // isolated — distinct from every other manual-*.js test's chosen port
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-collision-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-collision-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-collision-profile-'));
const LOBBY_SCENE_PATH = path.join(DOCROOT_DIR, 'spatial', 'lobby', 'scene.json');
const MAIN_MANIFEST_PATH = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');

function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(frame, fn, description, timeoutMs = 15000, arg) {
  const start = Date.now();
  for (;;) {
    if (await frame.evaluate(fn, arg)) return;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for: ' + description);
    await sleep(150);
  }
}
const cam = (frame) => frame.evaluate(() => { const c = window.__atlasActive3D.camera; return { x: c.pos[0], y: c.pos[1], z: c.pos[2] }; });
const blocked = (frame, x, z) => frame.evaluate(([px, pz]) => window.__atlasActive3D.isPositionBlocked(px, pz), [x, z]);
async function place(frame, x, z, yawDeg) {
  await frame.evaluate(([px, pz, yaw]) => { const c = window.__atlasActive3D.camera; c.pos[0] = px; c.pos[2] = pz; c.yaw = yaw * Math.PI / 180; c.pitch = 0; }, [x, z, yawDeg]);
}
// Holds a movement key until `done(camera)` is true or the time runs out, then releases it. Frame rate under a
// software GL stack can be low, so this polls the real camera position instead of assuming a distance per second.
async function hold(frame, code, done, timeoutMs = 20000) {
  // The renderer ignores movement keys while a text field has focus (the chat box can).
  await frame.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await frame.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keydown', { code: c })), code);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(120);
    if (done(await cam(frame))) break;
  }
  await frame.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keyup', { code: c })), code);
  await sleep(250);
  return cam(frame);
}
async function enterLobby(frame, anchorId) {
  await frame.evaluate((a) => loadManifest(currentManifestUrl, 'lobby', a), anchorId || null);
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby') && !!window.__atlasActive3D, null, { timeout: 20000 });
  await frame.evaluate(() => window.__atlasActive3D.ready);
  await sleep(500);
}

(async () => {
  console.log('SETUP: copying demo-domain-a into an isolated docroot (with a ground-level anchor and a missing-model object added to that copy only)');
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(MAIN_MANIFEST_PATH, 'utf8'));
  manifest.domain = DOMAIN;
  fs.writeFileSync(MAIN_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  const scene = JSON.parse(fs.readFileSync(LOBBY_SCENE_PATH, 'utf8'));
  scene.anchors.push({ id: 'floor-anchor', position: [1.5, 0, 3.0], label: 'Ground-level anchor' });
  scene.objects.push({ model: '/assets/furniture/doesNotExist.glb', position: [-2.0, 0, 3.0], rotationY: 0 });
  fs.writeFileSync(LOBBY_SCENE_PATH, JSON.stringify(scene, null, 2));

  const serverProc = spawn('node', ['issuer-server/server.js'], {
    cwd: path.resolve(__dirname, '..'),
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
    await page.goto('http://' + DOMAIN, { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });

    console.log('STEP 5: a scene object whose model is missing is drawn as a solid placeholder; the rest of the world still loads');
    await enterLobby(frame);
    assert(await blocked(frame, -2.0, 3.0), 'Expected the placeholder crate for the missing model to be solid at its position');
    assert(await blocked(frame, -0.45, -4.84), 'Expected the rest of the Lobby (the reception desk) to have loaded normally');
    console.log('PASS: Lobby loads with the missing model replaced by a solid placeholder');

    console.log('STEP 6: a dropped furniture model is centered on its bounding-box middle (corner-origin models do not orbit a corner)');
    const dropModel = 'http://' + DOMAIN + '/assets/furniture/desk.glb';
    await frame.evaluate(([model, domain]) => window.__atlasActive3D.setItemDrops([{ dropId: 'pivot-test', position: [-3.5, 0, 3.0], radius: 0.9, model, domain, credential: { id: 'pivot-test-credential', issuer: { domain }, asset: { class: 'test.desk', name: 'Desk' } } }]), [dropModel, DOMAIN]);
    await waitFor(frame, () => window.__atlasActive3D.getItemDropRenderKind('pivot-test') === 'model', 'the dropped desk model to load', 3500);
    const pivot = await frame.evaluate(() => window.__atlasActive3D.getItemDropPivot('pivot-test'));
    const wantPivot = [0.357, 0.192, -0.184]; // desk.glb bounds x -0.01..0.724, y 0..0.384, z -0.38..0.012
    assert(pivot && wantPivot.every((v, i) => Math.abs(pivot[i] - v) < 0.01), 'Expected the drop pivot to be the model bounds center ' + JSON.stringify(wantPivot) + ', got ' + JSON.stringify(pivot));
    await frame.evaluate(() => window.__atlasActive3D.setItemDrops([]));
    console.log('PASS: drop pivot is the bounds center');

    console.log('STEP 1: collision matches what is drawn');
    const wantBlocked = [
      ['reception desk', -0.45, -4.84],
      ['second reception desk', 0.29, -4.84],
      ['west shelving (rotated 90, flush to the wall)', -6.95, -3.0],
      ['sofa far end (rotated 90), where an origin-centered box would not reach', 4.0, -0.6],
      ['TV cabinet (rotated -90) end', 7.0, -0.5],
      ['coffee table', 5.1, -0.2],
      ['waiting-corner sofa (rotated 180)', -4.9, 5.25],
      ['cafe table', 5.6, 4.1]
    ];
    for (const [name, x, z] of wantBlocked) assert(await blocked(frame, x, z), 'Expected ' + name + ' at (' + x + ', ' + z + ') to be solid');
    const wantClear = [
      ['open floor in front of the reception desk', -0.45, -3.8],
      ['gap between the reception desk and the lounge', 2.0, -4.0],
      ['centre rug', -0.4, 0.55],
      ['lounge rug away from the furniture on it', 4.6, 0.7],
      ['player spawn', 0, 3.4],
      ['entrance doorway', 3.2, 5.55],
      ['path in front of the entrance', 3.2, 7.5],
      ['lawn beside the path (grass patches are not solid)', 5.6, 9.5],
      ['portal marker', 0, 4.7],
      ['reading-nook anchor', -3.9, -0.8]
    ];
    for (const [name, x, z] of wantClear) assert(!(await blocked(frame, x, z)), 'Expected ' + name + ' at (' + x + ', ' + z + ') to be walkable');
    for (const [name, x, z] of [['centre doorway (closed door)', 0, 5.55], ['wall beside the entrance', 1.8, 5.55]]) {
      assert(await blocked(frame, x, z), 'Expected the ' + name + ' at (' + x + ', ' + z + ') to be solid');
    }
    for (const [name, x, z] of [['+x', 7.3, 0], ['-x', -7.3, 0], ['-z', 0, -5.7], ['+z', 3.0, 12.0], ['yard +x', 7.3, 8.5], ['yard -x', -7.3, 8.5]]) {
      assert(await blocked(frame, x, z), 'Expected beyond the ' + name + ' floor edge at (' + x + ', ' + z + ') to be blocked');
    }
    console.log('PASS: solid where furniture is, clear where it is not, rug walkable, floor edge limited');

    console.log('STEP 2: real walking — furniture stops the player, the rug and open floor do not');
    await place(frame, -0.45, -3.2, 0); // facing -z toward the reception desk, clear of every crate
    let end = await hold(frame, 'KeyW', () => false, 7000);
    assert(end.z > -4.34 - 0.02 && end.z < -3.2, 'Expected the desk to stop the player at about z=-4.34, got z=' + end.z);
    console.log('PASS: walking into the reception desk stops at its edge (z=' + end.z.toFixed(2) + ')');

    await place(frame, -0.4, 3.0, 0); // facing -z over the centre rug
    end = await hold(frame, 'KeyW', (c) => c.z <= 1.3, 20000);
    assert(end.z <= 1.4, 'Expected to walk across the rug (past z=1.65 onto it), got z=' + end.z);
    console.log('PASS: the rug does not block (reached z=' + end.z.toFixed(2) + ')');

    // Walls sit just inside the floor, so the player stops a body-radius short of the inner wall face.
    const edges = [
      ['+x', 3.0, 2.0, 90, (c) => c.x, (v) => v >= 6.5 && v <= 7.1],
      ['-x', -3.0, 2.0, -90, (c) => c.x, (v) => v <= -6.5 && v >= -7.1],
      ['-z', 3.4, -2.5, 0, (c) => c.z, (v) => v <= -5.0 && v >= -5.5],
      ['+z', -3.2, 2.0, 180, (c) => c.z, (v) => v >= 5.0 && v <= 5.5]
    ];
    for (const [name, x, z, yaw, pick, ok] of edges) {
      await place(frame, x, z, yaw);
      end = await hold(frame, 'KeyW', () => false, 14000);
      assert(ok(pick(end)), 'Expected the ' + name + ' room edge to stop the player inside the floor, got ' + JSON.stringify(end));
      console.log('PASS: the ' + name + ' edge stops the player (' + JSON.stringify({ x: +end.x.toFixed(2), z: +end.z.toFixed(2) }) + ')');
    }

    console.log('STEP 2b: out through the entrance, around the yard and back inside');
    await place(frame, 3.2, 3.5, 180); // facing +z at the entrance door
    end = await hold(frame, 'KeyW', (c) => c.z >= 9.8, 30000);
    assert(end.z >= 9.7 && end.z < 10.6 && Math.abs(end.x - 3.2) < 0.3, 'Expected to walk through the doorway and along the path up to the bench, got ' + JSON.stringify(end));
    assert((await frame.evaluate(() => document.getElementById('placeLabel').textContent)).includes('Example Lobby'), 'Expected to still be in the Lobby outdoors');
    console.log('PASS: walked out of the entrance and along the path (z=' + end.z.toFixed(2) + ')');
    end = await hold(frame, 'KeyW', () => false, 5000);
    assert(end.z < 10.6, 'Expected the outdoor bench to stop the player, got z=' + end.z);
    await place(frame, 3.2, 8.0, 0); // turn round and walk back inside
    end = await hold(frame, 'KeyW', (c) => c.z <= 4.0, 30000);
    assert(end.z <= 4.2 && Math.abs(end.x - 3.2) < 0.3, 'Expected to walk back in through the entrance, got ' + JSON.stringify(end));
    console.log('PASS: walked back inside through the entrance (z=' + end.z.toFixed(2) + ')');
    for (const [name, x, z, yaw, pick, ok] of [
      ['yard south edge', -1.0, 8.0, 180, (c) => c.z, (v) => v >= 11.4 && v <= 11.8],
      ['yard west edge', -1.0, 7.4, -90, (c) => c.x, (v) => v <= -6.7 && v >= -7.1],
      ['yard east edge', 5.5, 8.5, 90, (c) => c.x, (v) => v >= 6.7 && v <= 7.1]
    ]) {
      await place(frame, x, z, yaw);
      end = await hold(frame, 'KeyW', () => false, 14000);
      assert(ok(pick(end)), 'Expected the ' + name + ' to stop the player inside the floor, got ' + JSON.stringify(end));
      console.log('PASS: the ' + name + ' stops the player (' + JSON.stringify({ x: +end.x.toFixed(2), z: +end.z.toFixed(2) }) + ')');
    }

    console.log('STEP 3: a player inside an object\'s box can walk out');
    const crateCenter = [0.406, -0.906]; // cardboard crate at [0.3, 0, -0.8]
    await place(frame, crateCenter[0], crateCenter[1], 0);
    assert(await blocked(frame, crateCenter[0], crateCenter[1]), 'Expected the crate center to count as inside its box');
    end = await hold(frame, 'KeyW', (c) => c.z < crateCenter[1] - 1.0, 20000);
    assert(end.z < crateCenter[1] - 0.8, 'Expected to walk out of the crate\'s box, got z=' + end.z);
    console.log('PASS: walked out of a box the player started inside (z ' + crateCenter[1] + ' -> ' + end.z.toFixed(2) + ')');

    console.log('STEP 4: a ground-level anchor spawns at eye height');
    await enterLobby(frame, 'floor-anchor');
    const spawn = await cam(frame);
    assert(Math.abs(spawn.x - 1.5) < 0.01 && Math.abs(spawn.z - 3.0) < 0.01, 'Expected the camera at the anchor x/z (1.5, 3.0), got ' + JSON.stringify(spawn));
    assert(Math.abs(spawn.y - 1.6) < 0.01, 'Expected eye height 1.6 for an anchor declared at y=0, got y=' + spawn.y);
    console.log('PASS: anchor at y=0 spawns at eye height (y=' + spawn.y.toFixed(2) + ')');

    console.log('\nALL 3D COLLISION/LAYOUT BROWSER CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    serverProc.kill();
    for (const d of [DOCROOT_DIR, STATE_DIR, PROFILE_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (err) {} }
  }
})();
