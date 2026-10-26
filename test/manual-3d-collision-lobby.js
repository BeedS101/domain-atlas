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
//      the floor edge does.
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
    assert(await blocked(frame, -0.85, -3.6), 'Expected the rest of the Lobby (the desk) to have loaded normally');
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
      ['desk center', -0.86, -3.6],
      ['bookcase (rotated 90), where the old box did not reach', -4.28, -2.9],
      ['sofa far end (rotated 90), where the old box did not reach', 2.7, 0.3],
      ['TV cabinet right end', 3.9, -3.78],
      ['coffee table', 3.95, 1.35]
    ];
    for (const [name, x, z] of wantBlocked) assert(await blocked(frame, x, z), 'Expected ' + name + ' at (' + x + ', ' + z + ') to be solid');
    const wantClear = [
      ['empty floor left of the desk (old box blocked here)', -1.6, -3.4],
      ['rug away from the furniture on it (old box blocked here)', 3.9, 2.05],
      ['player spawn', 0, 2.4],
      ['portal marker', 0, 4.2]
    ];
    for (const [name, x, z] of wantClear) assert(!(await blocked(frame, x, z)), 'Expected ' + name + ' at (' + x + ', ' + z + ') to be walkable');
    assert(await blocked(frame, 5.5, 0), 'Expected beyond the +x floor edge to be blocked');
    assert(await blocked(frame, 0, -5), 'Expected beyond the -z floor edge to be blocked');
    console.log('PASS: solid where furniture is, clear where it is not, rug walkable, floor edge limited');

    console.log('STEP 2: real walking — furniture stops the player, the rug and open floor do not');
    await place(frame, -0.45, -2.2, 0); // facing -z toward the desk's right end, clear of the crate at [-1, 0, -2]
    let end = await hold(frame, 'KeyW', () => false, 6000);
    assert(end.z > -3.12 - 0.02 && end.z < -2.2, 'Expected the desk to stop the player at about z=-3.12, got z=' + end.z);
    console.log('PASS: walking into the desk stops at its edge (z=' + end.z.toFixed(2) + ')');

    await place(frame, 3.9, 3.2, 0); // facing -z over the rug, toward the coffee table
    end = await hold(frame, 'KeyW', (c) => c.z <= 2.0, 20000);
    assert(end.z <= 2.05, 'Expected to walk onto the rug (past z=2.13), got z=' + end.z);
    console.log('PASS: the rug does not block (reached z=' + end.z.toFixed(2) + ')');

    await place(frame, 2.8, 2.6, 90); // facing +x along open floor to the right wall
    end = await hold(frame, 'KeyW', () => false, 8000);
    assert(end.x <= 4.91 && end.x >= 4.5, 'Expected the floor edge to stop the player near x=4.9, got x=' + end.x);
    console.log('PASS: the floor edge stops the player (x=' + end.x.toFixed(2) + ')');

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
