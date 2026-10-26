// Browser regression for Domain B's Atlas Showcase Gallery and for scenes
// owning the character scale, run against an isolated copy of demo-domain-b
// to which the Lobby (from demo-domain-a) is added as extra worlds in the copy
// only, so Lobby <-> Gallery switching can be exercised inside one domain.
//
// Checks:
//   1. Domain B opens in the Workshop (defaultWorld), a 2D world, with the
//      character-scale slider enabled.
//   2. Walking into the Workshop's portal enters the Gallery (gltf-mini-v1)
//      at character scale 1.4; the settings slider shows 1.4 and is locked.
//   3. A scale saved in the wallet does not override the Gallery's, and is not
//      erased.
//   4. Switching Lobby <-> Gallery applies 0.5 / 1.4 at once, including to an
//      open settings screen.
//   5. A scene with no characterScale uses the saved preference (slider
//      enabled), then 1.
//   6. The Gallery's portal returns to the Workshop, within the same domain.
//   6b. In first person at 1.4 the camera is not inside the scaled torso (the view
//      is not one flat colour).
//   7. characterScale never rescales the world: collision matches an unscaled
//      reference over a grid of points in both scenes, interactable ranges and
//      camera start/anchor positions are exactly the authored numbers.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO, 'extension');
const PORT = 8353;
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-b-gallery-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-b-gallery-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-b-gallery-profile-'));
const MANIFEST_PATH = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');

function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// Unscaled reference for collision: the renderer's own pure placement helpers, without any character scale.
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(EXT_PATH, 'gltf-mini.js'), 'utf8'), {
  window: sandbox.window, document: {}, console, Float32Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array,
  DataView, ArrayBuffer, TextDecoder, Math, Map, Set, Promise, Array, Object, Number, JSON,
  performance: { now: () => 0 }, navigator: {}, indexedDB: {}, isFinite, Infinity, Error, String, Date
});
const L = sandbox.window.MiniGLTF.layout;
const boundsCache = {};
function modelBounds(url) {
  if (!boundsCache[url]) {
    const file = [path.join(REPO, 'demo-domain-b'), path.join(REPO, 'demo-domain-a')].map((r) => path.join(r, url)).find((f) => fs.existsSync(f));
    assert(file, 'no file for ' + url);
    const buf = fs.readFileSync(file);
    const { json, bin } = L.parseGLB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    boundsCache[url] = L.extractPrimitives(json, bin).bounds;
  }
  return boundsCache[url];
}
function referenceBlocked(scene) {
  const items = scene.objects.map((o) => ({ solid: o.solid !== false && o.collision !== false, footprint: L.placedFootprint(modelBounds(o.model), L.normalizePlacement(o)) }));
  const solids = L.selectSolidItems(items);
  const limits = L.floorWalkLimits(scene.floor);
  return (x, z) => L.floorOverrun(limits, x, z) + solids.reduce((d, s) => d + L.footprintDepth(s.footprint, x, z, L.PLAYER_RADIUS), 0) > 0;
}

// Share of the central screen area taken by its single most common colour (colours bucketed by 16).
async function dominantColourShare(page, frame) {
  const png = (await page.screenshot()).toString('base64');
  return frame.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const x0 = Math.floor(img.width * 0.3), y0 = Math.floor(img.height * 0.3), w = Math.floor(img.width * 0.4), h = Math.floor(img.height * 0.3);
    const d = g.getImageData(x0, y0, w, h).data, counts = new Map();
    for (let i = 0; i < d.length; i += 4) { const k = (d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4); counts.set(k, (counts.get(k) || 0) + 1); }
    return Math.max(...counts.values()) / (d.length / 4);
  }, png);
}
const cam = (frame) => frame.evaluate(() => { const c = window.__atlasActive3D.camera; return { x: c.pos[0], y: c.pos[1], z: c.pos[2] }; });
async function waitWorld(frame, label) {
  await frame.waitForFunction((l) => document.getElementById('placeLabel').textContent.includes(l), label, { timeout: 40000 });
}
async function waitScene3D(frame, label) {
  await waitWorld(frame, label);
  await frame.waitForFunction(() => !!window.__atlasActive3D, null, { timeout: 40000 });
  await frame.evaluate(() => window.__atlasActive3D.ready);
  await sleep(400);
}
const goWorld = (frame, id) => frame.evaluate((w) => followPortal({ kind: 'world', to: w }), id);
const scaleInfo = (frame) => frame.evaluate(() => {
  const w = window.__atlasActive3D;
  return { scale: w.getCharacterScale(), owned: w.isCharacterScaleSceneOwned(), override: w.hasCharacterScaleOverride() };
});
const slider = (frame) => frame.evaluate(() => ({
  value: parseFloat(document.getElementById('characterScaleInput').value),
  label: document.getElementById('characterScaleValue').textContent,
  disabled: document.getElementById('characterScaleInput').disabled,
  noteShown: !document.getElementById('characterScaleNote').hidden
}));
const stored = (frame) => frame.evaluate(async () => (await chrome.storage.local.get('atlasCharacterScale')).atlasCharacterScale);
const setStored = (frame, v) => frame.evaluate(async (value) => {
  if (value === undefined) await chrome.storage.local.remove('atlasCharacterScale');
  else await chrome.storage.local.set({ atlasCharacterScale: value });
}, v);

(async () => {
  console.log('SETUP: isolated copy of demo-domain-b, plus the Lobby as extra worlds in the copy only');
  fs.cpSync(path.join(REPO, 'demo-domain-b'), DOCROOT_DIR, { recursive: true });
  const A = path.join(REPO, 'demo-domain-a');
  fs.cpSync(path.join(A, 'assets', 'furniture'), path.join(DOCROOT_DIR, 'assets', 'furniture'), { recursive: true });
  fs.cpSync(path.join(A, 'assets', 'outdoor'), path.join(DOCROOT_DIR, 'assets', 'outdoor'), { recursive: true });
  fs.cpSync(path.join(A, 'spatial', 'lobby'), path.join(DOCROOT_DIR, 'spatial', 'lobby'), { recursive: true });
  const lobbyScene = JSON.parse(fs.readFileSync(path.join(A, 'spatial', 'lobby', 'scene.json'), 'utf8'));
  const gallery = JSON.parse(fs.readFileSync(path.join(REPO, 'demo-domain-b', 'spatial', 'gallery', 'scene.json'), 'utf8'));
  const plain = JSON.parse(JSON.stringify(lobbyScene)); delete plain.characterScale;
  fs.mkdirSync(path.join(DOCROOT_DIR, 'spatial', 'lobby-plain'), { recursive: true });
  fs.writeFileSync(path.join(DOCROOT_DIR, 'spatial', 'lobby-plain', 'scene.json'), JSON.stringify(plain));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  manifest.domain = DOMAIN;
  const galleryWorld = manifest.worlds.find((w) => w.id === 'gallery');
  for (const [id, name, scene] of [['lobby', 'Test Lobby', '/spatial/lobby/scene.json'], ['lobby-plain', 'Test Lobby Plain', '/spatial/lobby-plain/scene.json']]) {
    manifest.worlds.push({ id, name, entry: { scene, renderer: ['gltf-mini-v1'] }, policy: galleryWorld.policy, profile: galleryWorld.profile, portals: [] });
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

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
    page.on('pageerror', (err) => console.log('PAGEERROR:', String(err)));
    await page.goto('http://' + DOMAIN, { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frameHandle = await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 });
    const frame = await frameHandle.contentFrame();

    console.log('STEP 1: Domain B opens in the 2D Workshop');
    await waitWorld(frame, 'Neighbor Workshop');
    assert(await frame.evaluate(() => currentManifest.defaultWorld === 'workshop'), 'Expected defaultWorld workshop');
    assert(await frame.evaluate(() => window.__atlasActive3D === null || window.__atlasActive3D === undefined), 'Expected no 3D scene in the Workshop');
    await frame.evaluate(() => openSettings());
    let s = await slider(frame);
    assert(!s.disabled && !s.noteShown, 'Expected the size slider enabled in a world with no scene scale, got ' + JSON.stringify(s));
    console.log('PASS: Workshop is the first world; slider is user-controlled there');

    console.log('STEP 2: the Workshop portal enters the Gallery at 1.4');
    const hb = await frame.evaluate(() => new Promise((resolve) => {
      const check = () => {
        const h = portalHitboxes.find((x) => x.marker.portal && x.marker.portal.to === 'gallery');
        if (h) return resolve({ sx: h.sx, sy: h.sy, kind: h.marker.portal.kind });
        requestAnimationFrame(check);
      };
      check();
    }));
    assert(hb.kind === 'world', 'Expected a same-domain (world) portal, got ' + hb.kind);
    await frame.locator('#scene').click({ position: { x: hb.sx, y: hb.sy } });
    await waitScene3D(frame, 'Atlas Showcase Gallery');
    let info = await scaleInfo(frame);
    assert(info.scale === 1.4 && info.owned === true && info.override === false, 'Expected the Gallery at 1.4, scene-owned, got ' + JSON.stringify(info));
    s = await slider(frame);
    assert(s.value === 1.4 && s.disabled && s.noteShown && s.label.startsWith('1.4'), 'Expected the slider to show 1.4 and be locked, got ' + JSON.stringify(s));
    const start = await cam(frame);
    assert(near(start.x, gallery.camera.start[0]) && near(start.y, gallery.camera.start[1]) && near(start.z, gallery.camera.start[2]), 'Expected the authored camera start at scale 1.4, got ' + JSON.stringify(start));
    console.log('PASS: Gallery entered through the portal, scale 1.4 owned by the scene, slider locked at 1.4');

    console.log('STEP 2b: first person at 1.4 is not filled by the character\'s own torso');
    await sleep(1500);
    const share = await dominantColourShare(page, frame);
    assert(share < 0.6, 'Expected a varied first-person view of the Gallery at scale 1.4, but one colour fills ' + (share * 100).toFixed(0) + '% of the centre (camera inside the body?)');
    console.log('PASS: first-person view is not one flat colour (most common colour ' + (share * 100).toFixed(0) + '% of the centre)');

    console.log('STEP 3: a saved wallet scale does not override the Gallery, and is kept');
    await frame.evaluate(() => AtlasWallet.setCharacterScale(0.8));
    assert(await stored(frame) === 0.8, 'Expected 0.8 saved in the wallet');
    await goWorld(frame, 'workshop'); await waitWorld(frame, 'Neighbor Workshop');
    await goWorld(frame, 'gallery'); await waitScene3D(frame, 'Atlas Showcase Gallery');
    info = await scaleInfo(frame);
    assert(info.scale === 1.4 && info.owned, 'Expected the Gallery to stay at 1.4 with 0.8 saved, got ' + JSON.stringify(info));
    assert(await frame.evaluate(() => { window.__atlasActive3D.setCharacterScale(2); return window.__atlasActive3D.getCharacterScale(); }) === 1.4, 'Expected the renderer to ignore a user scale change while the scene owns it');
    assert(await stored(frame) === 0.8, 'The saved preference must not be erased');
    console.log('PASS: scene value wins over the saved 0.8, which is left untouched');

    console.log('STEP 4: switching Lobby <-> Gallery applies 0.5 / 1.4 at once');
    await goWorld(frame, 'lobby'); await waitScene3D(frame, 'Test Lobby');
    await frame.evaluate(() => openSettings());
    info = await scaleInfo(frame);
    s = await slider(frame);
    assert(info.scale === 0.5 && info.owned && s.value === 0.5 && s.disabled, 'Expected the Lobby at 0.5 with a locked slider, got ' + JSON.stringify({ info, s }));
    await goWorld(frame, 'gallery'); await waitScene3D(frame, 'Atlas Showcase Gallery');
    info = await scaleInfo(frame);
    s = await slider(frame); // settings were not reopened
    assert(info.scale === 1.4 && s.value === 1.4 && s.disabled && s.noteShown, 'Expected 1.4 straight away, slider following without reopening settings, got ' + JSON.stringify({ info, s }));
    await goWorld(frame, 'lobby'); await waitScene3D(frame, 'Test Lobby');
    info = await scaleInfo(frame); s = await slider(frame);
    assert(info.scale === 0.5 && s.value === 0.5, 'Expected 0.5 straight away, got ' + JSON.stringify({ info, s }));
    console.log('PASS: Lobby 0.5 -> Gallery 1.4 -> Lobby 0.5, slider follows each switch');

    console.log('STEP 5: a scene without characterScale keeps the user-controlled behaviour');
    await goWorld(frame, 'lobby-plain'); await waitScene3D(frame, 'Test Lobby Plain');
    info = await scaleInfo(frame); s = await slider(frame);
    assert(near(info.scale, 0.8) && !info.owned && info.override && near(s.value, 0.8) && !s.disabled && !s.noteShown, 'Expected the saved 0.8 in a scene with none, slider enabled, got ' + JSON.stringify({ info, s }));
    await frame.evaluate(() => { const el = document.getElementById('characterScaleInput'); el.value = '1.2'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(200);
    assert(near(await frame.evaluate(() => window.__atlasActive3D.getCharacterScale()), 1.2) && await stored(frame) === 1.2, 'Expected the slider to change and save the user scale here');
    await goWorld(frame, 'gallery'); await waitScene3D(frame, 'Atlas Showcase Gallery');
    assert((await scaleInfo(frame)).scale === 1.4, 'Expected the Gallery to return to 1.4');
    await setStored(frame, undefined);
    await goWorld(frame, 'lobby-plain'); await waitScene3D(frame, 'Test Lobby Plain');
    info = await scaleInfo(frame);
    assert(info.scale === 1 && !info.owned && !info.override, 'Expected the fallback 1 with nothing saved, got ' + JSON.stringify(info));
    console.log('PASS: user scale applies and is adjustable where the scene declares none; fallback is 1');

    console.log('STEP 6: the Gallery portal returns to the Workshop, in the same domain');
    await goWorld(frame, 'gallery'); await waitScene3D(frame, 'Atlas Showcase Gallery');
    const marker = gallery.portalMarkers[0];
    const back = await frame.evaluate(() => ({ kind: currentManifest.worlds.find((w) => w.id === 'gallery').portals[0].kind, to: currentManifest.worlds.find((w) => w.id === 'gallery').portals[0].to }));
    assert(back.kind === 'world' && back.to === 'workshop', 'Expected the Gallery portal to be a world portal to the workshop, got ' + JSON.stringify(back));
    const manifestUrlBefore = await frame.evaluate(() => currentManifestUrl);
    await frame.evaluate(([x, z]) => { const c = window.__atlasActive3D.camera; c.pos[0] = x; c.pos[2] = z; }, [marker.position[0], marker.position[2] + 1.0]);
    await waitWorld(frame, 'Neighbor Workshop');
    assert(await frame.evaluate(() => currentManifestUrl) === manifestUrlBefore, 'Expected the same manifest (same-domain transition)');
    console.log('PASS: walking onto the Gallery portal returns to the Workshop without changing domain');

    console.log('STEP 7: characterScale does not rescale the world');
    for (const [id, label, scene, scale] of [['gallery', 'Atlas Showcase Gallery', gallery, 1.4], ['lobby', 'Test Lobby', lobbyScene, 0.5]]) {
      await goWorld(frame, id); await waitScene3D(frame, label);
      assert((await scaleInfo(frame)).scale === scale, 'Expected ' + id + ' at ' + scale);
      const blocked = referenceBlocked(scene);
      const pts = [];
      const [fw, fd] = scene.floor.size, c = scene.floor.center || [0, 0];
      for (let x = c[0] - fw / 2 - 0.5; x <= c[0] + fw / 2 + 0.5; x += 0.55) for (let z = c[1] - fd / 2 - 0.5; z <= c[1] + fd / 2 + 0.5; z += 0.55) pts.push([+x.toFixed(3), +z.toFixed(3)]);
      const got = await frame.evaluate((p) => p.map(([x, z]) => window.__atlasActive3D.isPositionBlocked(x, z)), pts);
      const diffs = pts.filter((p, i) => got[i] !== blocked(p[0], p[1]));
      assert(diffs.length === 0, id + ': collision differs from the unscaled reference at ' + diffs.length + ' of ' + pts.length + ' points, e.g. ' + JSON.stringify(diffs.slice(0, 3)));
      const nBlocked = got.filter(Boolean).length;
      assert(nBlocked > pts.length * 0.02 && nBlocked < pts.length, id + ': expected a mix of blocked and free points, got ' + nBlocked + '/' + pts.length);
      // Interaction range: the authored radius, regardless of the scale.
      const crate = scene.interactables[0];
      const inRange = (d) => frame.evaluate(async ([cx, cz, dist]) => {
        const w = window.__atlasActive3D; const camera = w.camera;
        camera.pos[0] = cx; camera.pos[2] = cz + dist;
        await new Promise((r) => setTimeout(r, 450));
        return w.getNearbyInteractMarkers().some((m) => m.position[0] === cx && m.position[2] === cz);
      }, [crate.position[0], crate.position[2], d]);
      const r = crate.radius || 1;
      assert(await inRange(r - 0.15) && !(await inRange(r + 0.15)), id + ': interaction radius ' + r + ' should be exact at scale ' + scale);
      // Portal marker position and radius are the authored numbers.
      const pm = scene.portalMarkers[0];
      const exposed = await frame.evaluate(() => (window.__atlasScene && window.__atlasScene.portalMarkers) || null);
      if (exposed && exposed[0]) assert(near(exposed[0].position[0], pm.position[0]) && near(exposed[0].position[2], pm.position[2]), id + ': portal marker moved');
      console.log('PASS: ' + id + ' at scale ' + scale + ' — collision matches the unscaled reference at ' + pts.length + ' points (' + nBlocked + ' blocked), interactable range exact');
    }
    await goWorld(frame, 'lobby'); await waitScene3D(frame, 'Test Lobby');
    const nook = lobbyScene.anchors.find((a) => a.id === 'reading-nook');
    await frame.evaluate((a) => loadManifest(currentManifestUrl, 'lobby', a), 'reading-nook');
    await waitScene3D(frame, 'Test Lobby');
    const at = await cam(frame);
    assert(near(at.x, nook.position[0], 0.011) && near(at.z, nook.position[2], 0.011) && near(at.y, 1.6, 0.011), 'Expected the Reading Nook anchor at its authored coordinates at scale 0.5, got ' + JSON.stringify(at));
    console.log('PASS: anchor spawn is the authored coordinate at scale 0.5');

    console.log('\nALL DOMAIN B GALLERY / SCENE CHARACTER SCALE BROWSER CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (context) await context.close().catch(() => {});
    serverProc.kill();
    for (const d of [DOCROOT_DIR, STATE_DIR, PROFILE_DIR]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (err) {} }
  }
})();
