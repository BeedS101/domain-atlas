// The Gallery's textured portal gate (galleryPortal.glb) in the normal world
// renderer (extension + issuer-server on an isolated copy of demo-domain-b,
// using the real Gallery scene).
//
//   1. The Gallery still resolves portal 0 to "Back to the Neighbor Workshop"
//      (a same-domain portal, so the gate is orange); the gate's textures are
//      live on the GPU; the GLB is requested once; no point of the gate blocks.
//   2. From the front the gate renders: orange portal surface, warm stone,
//      lettering on a dark plaque.
//   3. `hideMarker` hides only the old ring and beacon; without it they draw.
//   4. The rest of the hall renders identically with and without the gate.
//   5. Real movement: holding forward from the front walks into the
//      activation area without snagging, and the portal travels to the
//      Workshop in the same domain.
//   6. Entering the Gallery again works and the gate is there; the 2D
//      Workshop does not leak any GL texture.
//   7. Destroying the world deletes every GL texture the gate created.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { sleep, grab: grabShot, countColours, diffImages, setCamera: setCam, trackTextures, walk } = require('./portal-test-lib');

const REPO = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO, 'extension');
const PORT = 8359;
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-gallery-gate-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-gallery-gate-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-gallery-gate-profile-'));
const SCENE_PATH = path.join(DOCROOT_DIR, 'spatial', 'gallery', 'scene.json');
const MAIN_MANIFEST_PATH = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');
const GATE = '/assets/portals/galleryPortal.glb';

function assert(cond, msg) { if (!cond) throw new Error(msg); }

(async () => {
  console.log('SETUP: isolated copy of demo-domain-b');
  fs.cpSync(path.join(REPO, 'demo-domain-b'), DOCROOT_DIR, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(MAIN_MANIFEST_PATH, 'utf8'));
  manifest.domain = DOMAIN;
  fs.writeFileSync(MAIN_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  const repoScene = JSON.parse(fs.readFileSync(SCENE_PATH, 'utf8'));
  const writeScene = (mutate) => {
    const s = JSON.parse(JSON.stringify(repoScene));
    if (mutate) mutate(s);
    fs.writeFileSync(SCENE_PATH, JSON.stringify(s, null, 2));
  };
  const withoutGate = (s) => { s.objects = s.objects.filter((o) => o.model !== GATE); };

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
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    const warnings = [];
    page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()); });

    await page.goto('http://' + DOMAIN, { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Neighbor Workshop'), null, { timeout: 15000 });

    const tex = await trackTextures(frame);
    const live = tex.live;
    const place = () => frame.evaluate(() => document.getElementById('placeLabel').textContent);

    async function enterGallery() {
      await tex.reset();
      await frame.evaluate(() => loadManifest(currentManifestUrl, 'gallery', null));
      await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Atlas Showcase Gallery') && !!window.__atlasActive3D, null, { timeout: 60000 });
      await frame.evaluate(() => window.__atlasActive3D.ready);
      await sleep(2000); // image decode + a few frames
    }
    const setCamera = (...a) => setCam(frame, ...a);
    const grab = () => grabShot(page);
    const count = (b64, region) => countColours(frame, b64, region);
    const diff = (a, b, region) => diffImages(frame, a, b, region);

    // In the hall, 6.5 m in front of the gate, looking at it (yaw 0 looks down -z).
    const FRONT = [0, 1.6, -9.5, 0, -0.05];
    const CENTRE = [0.2, 0.15, 0.8, 0.85];

    console.log('STEP 1: the real Gallery scene with the gate');
    writeScene();
    requests.length = 0;
    await enterGallery();
    const info = await frame.evaluate(async () => {
      const w = window.__atlasActive3D;
      const manifest = await (await fetch(currentManifestUrl)).json();
      const gallery = manifest.worlds.find((x) => x.id === 'gallery');
      const scene = await (await fetch(new URL(gallery.entry.scene, currentManifestUrl).href)).json();
      return { kind: w.getPortalTriggerKind(0), scale: w.getCharacterScale(), markers: scene.portalMarkers, portals: gallery.portals };
    });
    assert(info.markers.length === 1 && info.kind === 'same-domain', 'portal 0 is a same-domain portal, got ' + JSON.stringify(info));
    assert(info.scale === 1.4, 'character scale stays 1.4, got ' + info.scale);
    assert(JSON.stringify(info.markers[0].position) === '[0,0,-16]' && info.markers[0].portalIndex === 0 && JSON.stringify(info.portals) === JSON.stringify([{ kind: 'world', to: 'workshop', label: 'Back to the Neighbor Workshop' }]), 'portal 0 keeps its position and destination: ' + JSON.stringify(info));
    const gateRequests = requests.filter((u) => u.endsWith(GATE)).length;
    assert(gateRequests === 1, 'the gate GLB is requested once, got ' + gateRequests);
    const during = await live();
    assert(during === 5, 'expected 5 live GL textures (fallback + stone, runes, plaque, portal surface), got ' + during);
    const blocked = await frame.evaluate(() => {
      const w = window.__atlasActive3D; const bad = [];
      for (let x = -2.8; x <= 2.801; x += 0.2) for (let z = -16.6; z <= -14.9; z += 0.1) if (w.isPositionBlocked(x, z)) bad.push([+x.toFixed(2), +z.toFixed(2)]);
      return bad;
    });
    assert(blocked.length === 0, 'no point of the gate (frame, opening, plinth) blocks movement, blocked: ' + JSON.stringify(blocked));
    console.log('PASS: portal 0 is still "Back to the Neighbor Workshop" at [0,0,-16] (same-domain), scale 1.4; the gate GLB is fetched once with 5 live textures; the gate blocks nothing');

    console.log('STEP 2: from the front the gate renders with its textures');
    await setCamera(...FRONT);
    await sleep(1200);
    const frontShot = await grab();
    const gc = await count(frontShot, CENTRE);
    assert(gc.portal > 3000, 'orange portal surface visible, got ' + gc.portal);
    assert(gc.stone > 6000, 'stone frame visible, got ' + gc.stone);
    console.log('PASS: portal surface (' + gc.portal + ' px) and stone (' + gc.stone + ' px) render in the world');

    console.log('STEP 3: hideMarker hides only the placeholder ring and beacon');
    writeScene((s) => { s.portalMarkers[0].hideMarker = false; });
    await enterGallery();
    await setCamera(...FRONT);
    await sleep(1200);
    const shownShot = await grab();
    const markerDiff = await diff(frontShot, shownShot, CENTRE);
    assert(markerDiff > 800, 'without hideMarker the ring/beacon draw over the gate area, differing pixels: ' + markerDiff);
    console.log('PASS: hideMarker true removes the old marker visual (' + markerDiff + ' px differ with it on); the trigger still exists (see step 5)');

    console.log('STEP 4: the rest of the hall renders the same with and without the gate');
    writeScene(withoutGate);
    await enterGallery();
    await setCamera(0, 1.6, -9.5, Math.PI, 0); // looking back up the hall, gate behind
    await sleep(1200);
    const hallWithout = await grab();
    writeScene();
    await enterGallery();
    await setCamera(0, 1.6, -9.5, Math.PI, 0);
    await sleep(1200);
    const hallWith = await grab();
    const hallDiff = await diff(hallWith, hallWithout, [0, 0.1, 1, 0.65]);
    assert(hallDiff < 60, 'untextured Gallery objects must render identically, differing pixels: ' + hallDiff);
    console.log('PASS: view down the hall is identical (' + hallDiff + ' differing pixels) with the gate present');

    console.log('STEP 5: walking in from the front reaches the activation area and travels');
    await setCamera(0, 1.6, -9.5, 0, 0);
    await sleep(500);
    assert((await place()).includes('Atlas Showcase Gallery'), 'still in the Gallery before walking');
    const pts = await walk(frame, 'KeyW', async () => !(await place()).includes('Atlas Showcase Gallery'), 40000);
    assert((await place()).includes('Neighbor Workshop'), 'walking into the gate travels to the Workshop, place is ' + (await place()));
    const last = pts[pts.length - 1];
    assert(last && last[1] < -13.5 && last[1] > -17.3 && Math.abs(last[0]) < 0.3, 'the player walked through the activation area (within 2 m of z -16) without drifting, last sample ' + JSON.stringify(last));
    for (let i = 1; i < pts.length; i++) assert(pts[i][1] <= pts[i - 1][1] + 0.01, 'no backward jolt (snag) while walking in: ' + JSON.stringify([pts[i - 1], pts[i]]));
    const sameDomain = await frame.evaluate((d) => currentManifest.domain === d, DOMAIN);
    assert(sameDomain, 'the transition stays in the same domain');
    console.log('PASS: held forward from z -9.5 to z ' + last[1].toFixed(2) + ' without snagging; portal 0 took the player to the Workshop in the same domain');

    console.log('STEP 6: entering the Gallery again');
    await sleep(500);
    assert((await live()) === 0, 'the 2D Workshop holds no gate textures, live: ' + (await live()));
    await enterGallery();
    const again = await frame.evaluate(() => ({ kind: window.__atlasActive3D.getPortalTriggerKind(0), cam: [...window.__atlasActive3D.camera.pos] }));
    assert(again.kind === 'same-domain' && Math.abs(again.cam[2] - 14) < 0.01, 'back in the Gallery at its spawn: ' + JSON.stringify(again));
    await setCamera(...FRONT);
    await sleep(1200);
    const gc2 = await count(await grab(), CENTRE);
    assert(gc2.portal > 3000, 'the gate renders again after returning, got ' + JSON.stringify(gc2));
    console.log('PASS: Gallery re-entered at its spawn with the gate rendering again');

    console.log('STEP 7: destroying the world frees the gate\'s GPU textures');
    assert((await live()) === 5, 'expected 5 live textures after re-entering, got ' + (await live()));
    await frame.evaluate(() => window.__atlasActive3D.destroy());
    assert((await live()) === 0, 'expected 0 live GL textures after destroy(), got ' + (await live()));
    console.log('PASS: 0 live GL textures after destroy()');

    assert(!warnings.some((m) => /texture|image/i.test(m)), 'no texture warnings: ' + warnings.join(' | '));
    assert(pageErrors.length === 0, 'no uncaught page errors: ' + pageErrors.join(' | '));
    console.log('\nALL GALLERY PORTAL WORLD CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    serverProc.kill();
    for (const d of [DOCROOT_DIR, STATE_DIR, PROFILE_DIR]) fs.rmSync(d, { recursive: true, force: true });
  }
})();
