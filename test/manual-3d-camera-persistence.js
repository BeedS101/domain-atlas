// Browser regression for the 3D renderer's saved camera distance (the scroll-wheel
// zoom: 0 is first person, larger values pull back into the third-person follow
// view). The saved value lives in the extension's device-wide settings
// (chrome.storage.local, key atlasCameraDistance) and must:
//   1. default to first person (0) for a user who never scrolled;
//   2. be written after wheel zooming and restored on re-entering the scene,
//      through a portal and through a named anchor;
//   3. never move the player: camera.pos (character position / eye height) and
//      the scene's anchor coordinates are independent of it;
//   4. be clamped when the stored value is out of range or not a number.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8351;
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-camdist-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-camdist-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-camdist-profile-'));
const MAIN_MANIFEST_PATH = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');

function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, eps = 0.011) => Math.abs(a - b) < eps;

const cam = (frame) => frame.evaluate(() => { const c = window.__atlasActive3D.camera; return { x: c.pos[0], y: c.pos[1], z: c.pos[2] }; });
const distance = (frame) => frame.evaluate(() => window.__atlasActive3D.getCameraDistance());
const stored = (frame) => frame.evaluate(async () => (await chrome.storage.local.get('atlasCameraDistance')).atlasCameraDistance);
const setStored = (frame, v) => frame.evaluate(async (value) => {
  if (value === undefined) await chrome.storage.local.remove('atlasCameraDistance');
  else await chrome.storage.local.set({ atlasCameraDistance: value });
}, v);
const wheel = (frame, steps, deltaY) => frame.evaluate(([n, dy]) => {
  const canvas = document.getElementById('scene3d');
  for (let i = 0; i < n; i++) canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, cancelable: true, bubbles: true }));
}, [steps, deltaY]);
async function waitStored(frame, want, what) {
  const start = Date.now();
  for (;;) {
    const v = await stored(frame);
    if (typeof v === 'number' && near(v, want)) return v;
    if (Date.now() - start > 5000) throw new Error('Timed out waiting for the saved camera distance to be ' + want + ' (' + what + '), last saw ' + v);
    await sleep(100);
  }
}
async function enterLobby(frame, anchorId) {
  await frame.evaluate((a) => loadManifest(currentManifestUrl, 'lobby', a), anchorId || null);
  await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby') && !!window.__atlasActive3D, null, { timeout: 20000 });
  await frame.evaluate(() => window.__atlasActive3D.ready);
  await sleep(400);
}

(async () => {
  console.log('SETUP: isolated copy of demo-domain-a');
  fs.cpSync(path.resolve(__dirname, '..', 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(MAIN_MANIFEST_PATH, 'utf8'));
  manifest.domain = DOMAIN;
  fs.writeFileSync(MAIN_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  const scene = JSON.parse(fs.readFileSync(path.join(DOCROOT_DIR, 'spatial', 'lobby', 'scene.json'), 'utf8'));
  const nook = scene.anchors.find((a) => a.id === 'reading-nook');
  assert(nook, 'Expected the Lobby to declare the reading-nook anchor');

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

    console.log('STEP 1: a user who never changed it gets first person');
    assert(await stored(frame) === undefined, 'Expected no saved camera distance on a fresh profile');
    assert(await frame.evaluate(() => AtlasWallet.getCameraDistance()) === 0, 'Expected the wallet default to be 0');
    await enterLobby(frame);
    assert(await distance(frame) === 0, 'Expected first person (distance 0) by default, got ' + await distance(frame));
    const defaultPos = await cam(frame);
    assert(near(defaultPos.x, scene.camera.start[0]) && near(defaultPos.y, scene.camera.start[1]) && near(defaultPos.z, scene.camera.start[2]), 'Expected the scene start ' + JSON.stringify(scene.camera.start) + ', got ' + JSON.stringify(defaultPos));
    console.log('PASS: default is first person at the scene start');

    console.log('STEP 2: wheel zoom is saved');
    await wheel(frame, 3, 100);
    assert(near(await distance(frame), 1.2), 'Expected three wheel steps to give 1.2, got ' + await distance(frame));
    await waitStored(frame, 1.2, 'after wheel zoom');
    console.log('PASS: saved atlasCameraDistance = ' + await stored(frame));

    console.log('STEP 3: restored on re-entering the scene without moving the player');
    await enterLobby(frame);
    assert(near(await distance(frame), 1.2), 'Expected the saved distance 1.2 after re-entry, got ' + await distance(frame));
    let pos = await cam(frame);
    assert(near(pos.x, scene.camera.start[0]) && near(pos.y, scene.camera.start[1]) && near(pos.z, scene.camera.start[2]), 'Expected the player still at the scene start with the zoom restored, got ' + JSON.stringify(pos));
    console.log('PASS: zoom restored, player position and eye height unchanged');

    console.log('STEP 4: a named anchor keeps its own coordinates while the zoom is restored');
    await enterLobby(frame, 'reading-nook');
    pos = await cam(frame);
    assert(near(pos.x, nook.position[0]) && near(pos.z, nook.position[2]) && near(pos.y, 1.6), 'Expected the camera at the nook anchor ' + JSON.stringify(nook.position) + ', got ' + JSON.stringify(pos));
    assert(near(await distance(frame), 1.2), 'Expected zoom 1.2 at the anchor too, got ' + await distance(frame));
    console.log('PASS: anchor coordinates untouched, zoom restored');

    console.log('STEP 5: scrolling right before a portal hop is still saved, and restored on the way back');
    await wheel(frame, 2, 100); // 1.2 -> 2.0
    await frame.evaluate(() => { const c = window.__atlasActive3D.camera; c.pos[0] = 0; c.pos[2] = 4.4; });
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 15000 });
    await waitStored(frame, 2.0, 'after the portal hop');
    await enterLobby(frame);
    assert(near(await distance(frame), 2.0), 'Expected 2.0 after coming back from the portal, got ' + await distance(frame));
    console.log('PASS: portal round trip keeps the zoom');

    console.log('STEP 6: zooming back to first person is saved too');
    await wheel(frame, 10, -100);
    assert(await distance(frame) === 0, 'Expected the wheel to stop at 0, got ' + await distance(frame));
    await waitStored(frame, 0, 'after zooming back in');
    await enterLobby(frame);
    assert(await distance(frame) === 0, 'Expected first person after re-entry, got ' + await distance(frame));
    console.log('PASS: first person restored');

    console.log('STEP 7: out-of-range and invalid stored values are clamped');
    await setStored(frame, 99);
    await enterLobby(frame);
    const max = await frame.evaluate(() => window.__atlasActive3D.getMaxCameraDistance());
    assert(await distance(frame) === max, 'Expected 99 to clamp to ' + max + ', got ' + await distance(frame));
    await setStored(frame, -3);
    await enterLobby(frame);
    assert(await distance(frame) === 0, 'Expected -3 to clamp to 0, got ' + await distance(frame));
    await setStored(frame, 'far away');
    await enterLobby(frame);
    assert(await distance(frame) === 0, 'Expected a non-number to fall back to 0, got ' + await distance(frame));
    console.log('PASS: stored value clamped to 0..' + max);

    console.log('STEP 8: the wallet setter and getter agree');
    const roundTrip = await frame.evaluate(async () => AtlasWallet.setCameraDistance(2.4).then(() => AtlasWallet.getCameraDistance()));
    assert(near(roundTrip, 2.4), 'Expected the wallet setter/getter round trip to give 2.4, got ' + roundTrip);
    console.log('PASS: wallet setter/getter round trip');

    console.log('\nALL CAMERA DISTANCE PERSISTENCE CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    serverProc.kill();
    for (const d of [DOCROOT_DIR, STATE_DIR, PROFILE_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (err) {} }
  }
})();
