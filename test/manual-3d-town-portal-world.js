// The Lobby's textured portal gate in the normal world renderer (extension +
// issuer-server on an isolated copy of demo-domain-a, using the real Lobby
// scene).
//
//   1. The Lobby still resolves portal 0 to "Back to the Plaza" and the gate's
//      textures are live on the GPU; the GLB is requested once; no gate point
//      is blocked.
//   2. From the front, the gate renders: blue/violet portal surface, warm
//      stone, gold plaque lettering.
//   3. `hideMarker` hides only the old ring and beacon; without it they draw.
//   4. Objects that are not near the gate render identically with and without
//      it (view from the spawn).
//   5. Real movement: holding forward from the front walks straight into the
//      activation area without snagging, and the portal travels to the Plaza.
//   6. Return travel: entering the Lobby again works and the gate is there.
//   7. Destroying the world deletes every GL texture the gate created.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO, 'extension');
const PORT = 8358;
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-gate-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-gate-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-gate-profile-'));
const SCENE_PATH = path.join(DOCROOT_DIR, 'spatial', 'lobby', 'scene.json');
const MAIN_MANIFEST_PATH = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');
const GATE = '/assets/portals/townPortal.glb';

function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('SETUP: isolated copy of demo-domain-a');
  fs.cpSync(path.join(REPO, 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
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
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });

    await frame.evaluate(() => {
      window.__live = new Set();
      const proto = WebGLRenderingContext.prototype;
      const create = proto.createTexture, del = proto.deleteTexture;
      proto.createTexture = function () { const t = create.apply(this, arguments); if (t) window.__live.add(t); return t; };
      proto.deleteTexture = function (t) { window.__live.delete(t); return del.apply(this, arguments); };
    });
    const live = () => frame.evaluate(() => window.__live.size);
    const place = () => frame.evaluate(() => document.getElementById('placeLabel').textContent);

    async function enterLobby() {
      await frame.evaluate(() => window.__live.clear());
      await frame.evaluate(() => loadManifest(currentManifestUrl, 'lobby', null));
      await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby') && !!window.__atlasActive3D, null, { timeout: 30000 });
      await frame.evaluate(() => window.__atlasActive3D.ready);
      await sleep(1500); // image decode + a few frames
    }
    const setCamera = (x, y, z, yaw, pitch) => frame.evaluate(([x, y, z, yaw, pitch]) => {
      const c = window.__atlasActive3D.camera; c.pos[0] = x; c.pos[1] = y; c.pos[2] = z; c.yaw = yaw; c.pitch = pitch;
    }, [x, y, z, yaw, pitch]);
    const grab = async () => (await page.locator('#domain-atlas-overlay').screenshot()).toString('base64');

    // Counts portal-surface (blue/violet/cyan), stone and gold-lettering pixels in a region of a screenshot.
    const count = (b64, tests, region) => frame.evaluate(async ([b64, tests, reg]) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const x0 = Math.floor(img.width * reg[0]), y0 = Math.floor(img.height * reg[1]), w = Math.floor(img.width * (reg[2] - reg[0])), h = Math.floor(img.height * (reg[3] - reg[1]));
      const d = g.getImageData(x0, y0, w, h).data;
      const fns = {
        portal: (r, g, b) => b > 110 && b > r + 30 && b > g - 20,
        stone: (r, g, b) => r > 110 && r > g + 8 && g > b + 8,
        gold: (r, g, b) => r > 150 && g > 120 && b < 130 && r > b + 45
      };
      const out = { portal: 0, stone: 0, gold: 0 };
      for (let i = 0; i < d.length; i += 4) for (const k of Object.keys(fns)) if (fns[k](d[i], d[i + 1], d[i + 2])) out[k]++;
      return out;
    }, [b64, null, region]);
    // Number of differing pixels between two screenshots, ignoring the page header and chat/HUD panels (outer rim of the frame).
    const diff = (a, b, region) => frame.evaluate(async ([a, b, reg]) => {
      const load = async (s) => { const img = new Image(); await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + s; }); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(Math.floor(img.width * reg[0]), Math.floor(img.height * reg[1]), Math.floor(img.width * (reg[2] - reg[0])), Math.floor(img.height * (reg[3] - reg[1]))).data; };
      const da = await load(a), db = await load(b);
      let n = 0;
      for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 24) n++;
      return n;
    }, [a, b, region]);

    const FRONT = [0, 1.6, 2.0, Math.PI, -0.05]; // standing in the room, facing the gate
    const CENTRE = [0.2, 0.15, 0.8, 0.85];
    const TESTS = null; // colour classes live in count()

    console.log('STEP 1: the real Lobby scene with the gate');
    writeScene();
    requests.length = 0;
    await enterLobby();
    const info = await frame.evaluate(async () => {
      const w = window.__atlasActive3D;
      const manifest = await (await fetch(currentManifestUrl)).json();
      const lobby = manifest.worlds.find((x) => x.id === 'lobby');
      const scene = await (await fetch(lobby.entry.scene.startsWith('http') ? lobby.entry.scene : new URL(lobby.entry.scene, currentManifestUrl).href)).json();
      return { kind: w.getPortalTriggerKind(0), scale: w.getCharacterScale(), markers: scene.portalMarkers, portals: lobby.portals };
    });
    assert(info.markers.length === 1 && info.kind === 'same-domain', 'portal 0 is a same-domain portal, got ' + JSON.stringify(info));
    assert(info.scale === 0.5, 'character scale stays 0.5, got ' + info.scale);
    assert(JSON.stringify(info.markers[0].position) === '[0,0,4.7]' && info.markers[0].portalIndex === 0 && JSON.stringify(info.portals) === JSON.stringify([{ kind: 'world', to: 'plaza', label: 'Back to the Plaza' }]), 'portal 0 keeps its position and destination: ' + JSON.stringify(info));
    const gateRequests = requests.filter((u) => u.endsWith(GATE)).length;
    assert(gateRequests === 1, 'the gate GLB is requested once, got ' + gateRequests);
    const during = await live();
    assert(during === 5, 'expected 5 live GL textures (fallback + stone, runes, plaque, portal surface), got ' + during);
    const blocked = await frame.evaluate(() => {
      const w = window.__atlasActive3D; const bad = [];
      for (let x = -0.9; x <= 0.9001; x += 0.1) for (let z = 4.4; z <= 5.0; z += 0.1) if (w.isPositionBlocked(x, z)) bad.push([+x.toFixed(2), +z.toFixed(2)]);
      return bad;
    });
    assert(blocked.length === 0, 'no point of the gate (frame, opening, plinth) blocks movement, blocked: ' + JSON.stringify(blocked));
    console.log('PASS: portal 0 is still "Back to the Plaza" at [0,0,4.7] (same-domain), scale 0.5; the gate GLB is fetched once with 5 live textures; the gate blocks nothing');

    console.log('STEP 2: from the front the gate renders with its textures');
    await setCamera(...FRONT);
    await sleep(1200);
    const frontShot = await grab();
    const gc = await count(frontShot, TESTS, CENTRE);
    assert(gc.portal > 8000, 'blue/violet portal surface visible, got ' + gc.portal);
    assert(gc.stone > 8000, 'stone frame visible, got ' + gc.stone);
    assert(gc.gold > 300, 'gold plaque lettering visible, got ' + gc.gold);
    console.log('PASS: portal surface (' + gc.portal + ' px), stone (' + gc.stone + ' px) and plaque lettering (' + gc.gold + ' px) render in the world');

    console.log('STEP 3: hideMarker hides only the placeholder ring and beacon');
    writeScene((s) => { s.portalMarkers[0].hideMarker = false; });
    await enterLobby();
    await setCamera(...FRONT);
    await sleep(1200);
    const shownShot = await grab();
    const markerDiff = await diff(frontShot, shownShot, CENTRE);
    assert(markerDiff > 1500, 'without hideMarker the ring/beacon draw over the gate area, differing pixels: ' + markerDiff);
    writeScene((s) => { withoutGate(s); s.portalMarkers[0].hideMarker = false; });
    await enterLobby();
    await setCamera(...FRONT);
    await sleep(1200);
    const oldLook = await grab();
    writeScene(withoutGate);
    await enterLobby();
    await setCamera(...FRONT);
    await sleep(1200);
    const hiddenOnly = await grab();
    assert(await diff(oldLook, hiddenOnly, CENTRE) > 1500, 'the old ring and beacon are visible in the scene without the gate unless hidden');
    console.log('PASS: hideMarker true removes the old marker visual (' + markerDiff + ' px differ with it on); the trigger still exists (see step 5)');

    console.log('STEP 4: the rest of the Lobby renders the same with and without the gate');
    await setCamera(0, 1.6, 3.4, 0, 0); // the spawn, looking into the room, gate behind
    await sleep(1200);
    const roomWithout = await grab();
    writeScene();
    await enterLobby();
    await setCamera(0, 1.6, 3.4, 0, 0);
    await sleep(1200);
    const roomWith = await grab();
    const roomDiff = await diff(roomWith, roomWithout, [0, 0.1, 1, 0.65]);
    assert(roomDiff < 60, 'untextured Lobby objects must render identically, differing pixels: ' + roomDiff);
    console.log('PASS: view from the spawn is identical (' + roomDiff + ' differing pixels) with the gate present');

    console.log('STEP 5: walking in from the front reaches the activation area and travels');
    await setCamera(0, 1.6, 3.4, Math.PI, 0);
    await sleep(500);
    assert((await place()).includes('Example Lobby'), 'still in the Lobby before walking');
    await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })));
    const trail = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 30000 && (await place()).includes('Example Lobby')) {
      trail.push(await frame.evaluate(() => { const p = window.__atlasActive3D && window.__atlasActive3D.camera.pos; return p ? [p[0], p[2]] : null; }).catch(() => null));
      await sleep(150);
    }
    await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' }))).catch(() => {});
    assert((await place()).includes('Example Plaza'), 'walking into the gate travels to the Plaza, place is ' + (await place()));
    const pts = trail.filter(Boolean);
    const last = pts[pts.length - 1];
    // The scene swap takes a moment, during which the held key keeps walking the player on.
    assert(last && last[1] > 3.85 && last[1] < 5.3 && Math.abs(last[0]) < 0.3, 'the player walked through the activation area (from z 3.9) without drifting, last sample ' + JSON.stringify(last));
    for (let i = 1; i < pts.length; i++) assert(pts[i][1] >= pts[i - 1][1] - 0.01, 'no backward jolt (snag) while walking in: ' + JSON.stringify([pts[i - 1], pts[i]]));
    console.log('PASS: held forward from z 3.4 to z ' + last[1].toFixed(2) + ' without snagging; portal 0 took the player to the Plaza');

    console.log('STEP 6: return travel');
    await frame.evaluate(() => followPortal({ kind: 'world', to: 'lobby' }));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby') && !!window.__atlasActive3D, null, { timeout: 30000 });
    await frame.evaluate(() => window.__atlasActive3D.ready);
    await sleep(1500);
    const again = await frame.evaluate(() => ({ kind: window.__atlasActive3D.getPortalTriggerKind(0), cam: [...window.__atlasActive3D.camera.pos] }));
    assert(again.kind === 'same-domain' && Math.abs(again.cam[2] - 3.4) < 0.01, 'back in the Lobby at its spawn: ' + JSON.stringify(again));
    await setCamera(...FRONT);
    await sleep(1200);
    const gc2 = await count(await grab(), TESTS, CENTRE);
    assert(gc2.portal > 8000 && gc2.gold > 300, 'the gate renders again after returning, got ' + JSON.stringify(gc2));
    console.log('PASS: Lobby re-entered at the spawn with the gate rendering again');

    console.log('STEP 7: destroying the world frees the gate\'s GPU textures');
    assert((await live()) === 5, 'expected 5 live textures after re-entering, got ' + (await live()));
    await frame.evaluate(() => window.__atlasActive3D.destroy());
    assert((await live()) === 0, 'expected 0 live GL textures after destroy(), got ' + (await live()));
    console.log('PASS: 0 live GL textures after destroy()');

    assert(!warnings.some((m) => /texture|image/i.test(m)), 'no texture warnings: ' + warnings.join(' | '));
    assert(pageErrors.length === 0, 'no uncaught page errors: ' + pageErrors.join(' | '));
    console.log('\nALL TOWN PORTAL WORLD CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    serverProc.kill();
    for (const d of [DOCROOT_DIR, STATE_DIR, PROFILE_DIR]) fs.rmSync(d, { recursive: true, force: true });
  }
})();
