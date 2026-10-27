// The gltf-mini debug HUD (F3) in the real extension + issuer-server, on an
// isolated copy of demo-domain-a with generated test scenes.
//
//   1. F3 shows and hides the overlay (a real key press); hidden by default.
//   2. It never intercepts input: it is pointer-events:none, a mouse drag that
//      starts on top of it still turns the camera, held movement keys still
//      move the player, and F3 itself moves nothing.
//   3. FPS is a number that is produced from the renderer's frame counter.
//   4. Player and camera positions follow the player and the camera distance.
//   5. Resource counts match the real world: GL textures equal an independent
//      count of live GL textures, models/objects/drawables/drops match the scene;
//      they stay right entering, leaving and re-entering worlds, and the texture
//      count is 0 after the renderer is destroyed.
//   6. Feature indicators follow loaded content: each feature alone, all
//      together, and a scene using none; unusable textures and invalid fog do
//      not count.
//   7. Pixel parity: the canvas is identical before the HUD is ever shown and
//      after it is shown and hidden again; with it showing, everything outside
//      its box is identical too.
//   8. Statuses: entries appear, change nothing in the renderer or the picture
//      outside the box, and the section disappears when cleared.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildMultiGlb, makePng, quadSpec } = require(path.join(__dirname, '..', 'tools', 'lib', 'glb-builder'));
const { sleep, trackTextures } = require('./portal-test-lib');

const REPO = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO, 'extension');
const PORT = 8373;
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-hud-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-hud-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-hud-profile-'));
const SCENE_PATH = path.join(DOCROOT_DIR, 'spatial', 'lobby', 'scene.json');
const MAIN_MANIFEST_PATH = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');
const MODEL_DIR = path.join(DOCROOT_DIR, 'assets', 'hud-test');

function assert(cond, msg) { if (!cond) throw new Error(msg); }

const png = (w, h, fn) => ({ bytes: makePng(w, h, fn), mimeType: 'image/png' });
const solid = (rgba) => png(8, 8, () => rgba);
const quad = (material) => buildMultiGlb({ primitives: [{ ...quadSpec(), material }] });
const CORRUPT = { bytes: Buffer.concat([makePng(8, 8, () => [255, 255, 255, 255]).subarray(0, 40), Buffer.alloc(30, 0xff)]), mimeType: 'image/png' };

// Screenshot comparison inside the extension frame: the number of pixels differing at all, optionally outside a box.
const diffPixels = (frame, a, b, skipBox) => frame.evaluate(async ([a, b, box]) => {
  const load = async (s) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + s; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
    return { d: g.getImageData(0, 0, img.width, img.height).data, w: img.width };
  };
  const A = await load(a), B = await load(b);
  let n = 0;
  for (let i = 0; i < A.d.length; i += 4) {
    const x = (i / 4) % A.w, y = Math.floor(i / 4 / A.w);
    if (box && x >= box.x - 2 && x <= box.x + box.w + 2 && y >= box.y - 2 && y <= box.y + box.h + 2) continue;
    if (A.d[i] !== B.d[i] || A.d[i + 1] !== B.d[i + 1] || A.d[i + 2] !== B.d[i + 2]) n++;
  }
  return n;
}, [a, b, skipBox || null]);

(async () => {
  console.log('SETUP: isolated copy of demo-domain-a with generated test models');
  fs.cpSync(path.join(REPO, 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(MAIN_MANIFEST_PATH, 'utf8'));
  manifest.domain = DOMAIN;
  fs.writeFileSync(MAIN_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  const lobbyScene = JSON.parse(fs.readFileSync(SCENE_PATH, 'utf8'));
  fs.mkdirSync(MODEL_DIR, { recursive: true });

  const MODELS = {
    plain: quad({}),
    emissive: quad({ emissiveFactor: [0, 1, 0] }),
    emissiveTex: quad({ emissiveFactor: [1, 1, 1], emissiveTexture: solid([255, 0, 0, 255]) }),
    emissiveBadTex: quad({ emissiveFactor: [1, 1, 1], emissiveTexture: CORRUPT }),
    normal: quad({ normalTexture: solid([128, 128, 255, 255]) }),
    normalBad: quad({ normalTexture: CORRUPT }),
    unlit: quad({ baseColorFactor: [0.8, 0.4, 0.2, 1], unlit: true }),
    mask: quad({ texture: png(8, 8, (x) => [255, 0, 0, x < 4 ? 30 : 255]), alphaMode: 'MASK', alphaCutoff: 0.5 }),
    blend: quad({ baseColorFactor: [1, 1, 0, 0.5], alphaMode: 'BLEND' }),
    textured: quad({ texture: solid([200, 100, 50, 255]) })
  };
  Object.entries(MODELS).forEach(([name, glb]) => fs.writeFileSync(path.join(MODEL_DIR, name + '.glb'), glb));
  const place = (name, x, z) => ({ model: '/assets/hud-test/' + name + '.glb', position: [x, 0, z], rotationY: 0, scale: 1, solid: false });
  const FOG = { color: '#c9d7d7', near: 5, far: 30 };
  const writeScene = (objects, extra) => fs.writeFileSync(SCENE_PATH, JSON.stringify({
    ...lobbyScene, objects, interactables: [], portalMarkers: [], anchors: [], camera: { start: [0, 1.6, 0], startYaw: 0 }, ...(extra || {})
  }, null, 2));
  const writeLobby = () => fs.writeFileSync(SCENE_PATH, JSON.stringify(lobbyScene, null, 2));

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
      viewport: { width: 1280, height: 720 },
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, '--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist']
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto('http://' + DOMAIN, { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frame = await (await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 })).contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });
    const tex = await trackTextures(frame);
    await frame.evaluate(() => { const s = document.createElement('style'); s.textContent = '#chatWidget, #previewerWidget { display: none !important; }'; document.head.appendChild(s); });

    const enter = async (worldId) => {
      await tex.reset();
      await frame.evaluate((w) => loadManifest(currentManifestUrl, w, null), worldId || 'lobby');
      await frame.waitForFunction((w) => document.getElementById('placeLabel').textContent.includes(w === 'lobby' ? 'Example Lobby' : 'Example') && !!window.__atlasActive3D, worldId || 'lobby', { timeout: 30000 });
      await frame.evaluate(() => window.__atlasActive3D.ready);
      await sleep(1500);
    };
    const info = () => frame.evaluate(() => window.__atlasActive3D.getDebugInfo());
    const hudText = () => frame.evaluate(() => { const e = document.getElementById('miniGltfHud'); return e ? e.textContent : null; });
    const hudBox = () => frame.evaluate(() => { const r = document.getElementById('miniGltfHud').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const shot = async () => (await page.locator('#domain-atlas-overlay').screenshot()).toString('base64');
    const pressF3 = async () => { await page.keyboard.press('F3'); await sleep(450); };
    const setCam = (x, y, z, yaw, pitch) => frame.evaluate(([x, y, z, yaw, pitch]) => { const c = window.__atlasActive3D.camera; c.pos[0] = x; c.pos[1] = y; c.pos[2] = z; c.yaw = yaw; c.pitch = pitch; }, [x, y, z, yaw, pitch]);
    const num = (text, label) => { const m = new RegExp('^' + label + '\\s+(-?[\\d.]+)', 'm').exec(text); return m ? parseFloat(m[1]) : null; };
    const featureLine = (text, label) => { const m = new RegExp('^' + label + '\\s+(ON( \\d+)?|OFF)\\s*$', 'm').exec(text); return m ? m[1] : null; };

    // ---------------------------------------------------------------- 1
    console.log('STEP 1: F3 shows and hides the HUD; it starts hidden');
    writeLobby();
    await enter('lobby');
    assert(await hudText() === null, 'the HUD does not exist until it is asked for');
    await frame.locator('#scene3d').click({ position: { x: 640, y: 400 } }); // focus the viewer frame
    await pressF3();
    let text = await hudText();
    assert(text && /PERFORMANCE/.test(text) && /gltf-mini-v1/.test(text), 'F3 shows the HUD, got ' + JSON.stringify(text));
    assert(/Scene\s+lobby/.test(text), 'it names the current world: ' + text);
    await pressF3();
    assert(await hudText() === null, 'F3 again removes it');
    await pressF3();
    assert(await hudText() !== null, 'and again shows it');
    console.log('PASS: hidden by default; a real F3 key press toggles it; it names the world');

    // ---------------------------------------------------------------- 2
    console.log('STEP 2: the HUD never intercepts mouse or keyboard scene controls');
    const style = await frame.evaluate(() => { const e = document.getElementById('miniGltfHud'); const cs = getComputedStyle(e); return { pe: cs.pointerEvents, pos: cs.position, font: cs.fontFamily }; });
    assert(style.pe === 'none' && style.pos === 'fixed' && /mono|Menlo|Consolas/i.test(style.font), 'fixed, pointer-events none, monospace: ' + JSON.stringify(style));
    const box = await hudBox();
    const hit = await frame.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e && e.id; }, [box.x + box.w / 2, box.y + box.h / 2]);
    assert(hit === 'scene3d', 'a point on the HUD hits the 3D canvas, got ' + hit);
    await setCam(0, 1.6, 0, 0, 0);
    const frameRect = await page.locator('#domain-atlas-overlay').boundingBox();
    const yaw0 = await frame.evaluate(() => window.__atlasActive3D.camera.yaw);
    await page.mouse.move(frameRect.x + box.x + box.w / 2, frameRect.y + box.y + box.h / 2);
    await page.mouse.down();
    await page.mouse.move(frameRect.x + box.x + box.w / 2 + 120, frameRect.y + box.y + box.h / 2, { steps: 6 });
    await page.mouse.up();
    const yaw1 = await frame.evaluate(() => window.__atlasActive3D.camera.yaw);
    assert(Math.abs(yaw1 - yaw0) > 0.3, 'dragging from on top of the HUD still turns the camera: ' + yaw0 + ' -> ' + yaw1);
    // held movement keys still move the player with the HUD showing
    await setCam(0, 1.6, 0, 0, 0);
    const before = await frame.evaluate(() => window.__atlasActive3D.camera.pos.slice());
    await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD' })));
    await sleep(900);
    await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD' })));
    const after = await frame.evaluate(() => window.__atlasActive3D.camera.pos.slice());
    assert(Math.abs(after[0] - before[0]) > 0.2, 'movement keys still work with the HUD showing: ' + before[0] + ' -> ' + after[0]);
    // F3 itself is not a movement or look input
    await setCam(0, 1.6, 0, 0, 0);
    await pressF3(); await pressF3();
    const afterF3 = await frame.evaluate(() => { const c = window.__atlasActive3D.camera; return [c.pos[0], c.pos[2], c.yaw]; });
    assert(Math.abs(afterF3[0]) < 1e-6 && Math.abs(afterF3[1]) < 1e-6 && Math.abs(afterF3[2]) < 1e-6, 'F3 moves nothing: ' + afterF3);
    assert(await frame.evaluate(() => document.activeElement === document.body || document.activeElement.id !== 'miniGltfHud'), 'the HUD never takes focus');
    assert(await hudText() !== null, 'still visible');
    console.log('PASS: pointer-events none; a drag over the HUD turns the camera; movement keys work; F3 moves nothing');

    // ---------------------------------------------------------------- 3
    console.log('STEP 3: FPS updates');
    const f1 = (await info()).frames;
    await sleep(1600);
    const f2 = (await info()).frames;
    text = await hudText();
    const fps = num(text, 'FPS'), frameMs = num(text, 'Frame time');
    assert(f2 > f1, 'the renderer frame counter advances: ' + f1 + ' -> ' + f2);
    assert(fps > 0 && fps < 500 && frameMs > 0, 'FPS and frame time are numbers: ' + fps + ', ' + frameMs);
    const measured = (f2 - f1) / 1.6;
    assert(fps / measured < 3 && measured / fps < 3, 'the shown FPS (' + fps + ') is about the rate measured from outside (' + measured.toFixed(1) + ')');
    console.log('PASS: FPS ' + fps.toFixed(1) + ' / ' + frameMs.toFixed(1) + ' ms shown; independent measure ' + measured.toFixed(1) + ' fps');

    // ---------------------------------------------------------------- 4
    console.log('STEP 4: player and camera positions update');
    await frame.evaluate(() => window.__atlasActive3D.setCameraDistance(0));
    await setCam(2.5, 1.6, -3.25, 0, 0); await sleep(700);
    text = await hudText();
    assert(/Player\s+2\.50, 0\.00, -3\.25/.test(text), 'player position shown: ' + text);
    assert(/Camera\s+2\.50, 1\.60, -3\.25/.test(text), 'first-person camera is at the player: ' + text);
    await setCam(-1.5, 1.6, 4, 0, 0);
    await frame.evaluate(() => window.__atlasActive3D.setCameraDistance(3)); await sleep(700);
    text = await hudText();
    const camLine = /Camera\s+(-?[\d.]+), (-?[\d.]+), (-?[\d.]+)/.exec(text);
    assert(/Player\s+-1\.50, 0\.00, 4\.00/.test(text), 'player moved: ' + text);
    assert(camLine && Math.abs(parseFloat(camLine[3]) - 7) < 0.05 && Math.abs(parseFloat(camLine[1]) + 1.5) < 0.05, 'the third-person camera sits behind the player (z 7): ' + camLine);
    await frame.evaluate(() => window.__atlasActive3D.setCameraDistance(0));
    console.log('PASS: player and camera positions follow the player and the camera distance');

    // ---------------------------------------------------------------- 5
    console.log('STEP 5: resource counts are accurate and survive entering/leaving worlds');
    const imagesOf = (url) => {
      const b = fs.readFileSync(path.join(DOCROOT_DIR, url.replace(/^\//, '')));
      return (JSON.parse(b.slice(20, 20 + b.readUInt32LE(12)).toString()).images || []).length;
    };
    const checkCounts = async (scene, label) => {
      const urls = [...new Set(scene.objects.map((o) => o.model))];
      const i = await info();
      const r = i.resources;
      const wantTextures = urls.reduce((n, u) => n + imagesOf(u), 0) + 1;
      assert(r.sceneModels === urls.length, label + ': models ' + r.sceneModels + ' vs ' + urls.length);
      assert(r.objects === scene.objects.length, label + ': objects ' + r.objects + ' vs ' + scene.objects.length);
      assert(r.textures === wantTextures, label + ': textures ' + r.textures + ' vs expected ' + wantTextures);
      assert(r.textures === await tex.live(), label + ': the HUD texture count ' + r.textures + ' equals the independent GL count ' + await tex.live());
      assert(r.drawables >= r.objects, label + ': at least one drawable per object, got ' + r.drawables);
      assert(r.cachedModels >= r.sceneModels, label + ': cache holds the scene models');
      assert(i.label === 'lobby', label + ': scene label ' + i.label);
      const t = await hudText();
      assert(new RegExp('GPU textures\\s+' + r.textures + '\\b').test(t) && new RegExp('Models\\s+' + r.sceneModels + '\\b').test(t), label + ': the text shows the same counts:\n' + t);
      return i;
    };
    await checkCounts(lobbyScene, 'real Lobby');
    const drop = { dropId: 'hud-drop', position: [-2.2, 0, 2.2], radius: 0.9, model: 'http://' + DOMAIN + '/assets/lobby/interior/desk.glb', domain: DOMAIN, credential: { id: 'c1', issuer: { domain: DOMAIN }, asset: { class: 'test.item', name: 'Item' } } };
    await frame.evaluate((d) => window.__atlasActive3D.setItemDrops([d]), drop);
    await frame.waitForFunction(() => window.__atlasActive3D.getItemDropRenderKind('hud-drop') === 'model', null, { timeout: 10000 });
    let i = await info();
    assert(i.resources.itemDrops === 1 && i.resources.dropModels === 1, 'a rendered drop is counted: ' + JSON.stringify(i.resources));
    assert(i.resources.textures === await tex.live(), 'the drop model texture is counted: HUD ' + i.resources.textures + ', GL ' + await tex.live());
    await frame.evaluate(() => window.__atlasActive3D.setItemDrops([]));
    await sleep(300);
    i = await info();
    assert(i.resources.itemDrops === 0 && i.resources.dropModels === 0, 'removing the drop clears the count: ' + JSON.stringify(i.resources));
    // leave to the 2D plaza: no 3D renderer
    await frame.evaluate(() => loadManifest(currentManifestUrl, 'plaza', null));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza') && !window.__atlasActive3D, null, { timeout: 20000 }).catch(() => {});
    await sleep(800);
    text = await hudText();
    assert(/no 3D world is loaded/.test(text), 'with no 3D world the HUD says so: ' + text);
    assert(await tex.live() === 0, 'no GL textures live after leaving: ' + await tex.live());
    // back in: counts are exact again, nothing carried over
    await enter('lobby');
    await checkCounts(lobbyScene, 'Lobby re-entered');
    // teardown
    // destroy() releases the models' textures on the next microtask turn, so read the count after a short wait
    const afterDestroy = await frame.evaluate(async () => { const r = window.__atlasActive3D; r.destroy(); await new Promise((res) => setTimeout(res, 50)); return r.getDebugInfo().resources.textures; });
    assert(afterDestroy === 0 && await tex.live() === 0, 'texture count after destroy: HUD ' + afterDestroy + ', GL ' + await tex.live());
    console.log('PASS: counts match the scene and the GL tracker; drops counted and cleared; leaving shows "no 3D world"; 0 textures after destroy()');

    // ---------------------------------------------------------------- 6
    console.log('STEP 6: feature indicators follow what is actually loaded');
    const FEATURES = [['Fog', 'fog'], ['Normal maps', 'normalMaps'], ['Emissive', 'emissive'], ['Alpha MASK', 'mask'], ['Unlit', 'unlit']];
    const expectOnly = async (label, on) => {
      const t = await hudText();
      FEATURES.forEach(([name, key]) => {
        const want = on[key];
        const got = featureLine(t, name);
        if (!want) assert(got === 'OFF', label + ': ' + name + ' must be OFF, got ' + got + '\n' + t);
        else assert(got && got.startsWith('ON') && (want === true || got === 'ON ' + want), label + ': ' + name + ' must be ON' + (want === true ? '' : ' ' + want) + ', got ' + got);
      });
      const f = (await info()).features;
      FEATURES.forEach(([, key]) => assert(!!f[key] === !!on[key], label + ': snapshot ' + key + ' = ' + f[key]));
    };
    const scenes = [
      ['a scene using none', [place('plain', -1, -4), place('textured', 1, -4), place('blend', 0, -6)], undefined, {}],
      ['emissive factor', [place('emissive', -1, -4), place('plain', 1, -4)], undefined, { emissive: 1 }],
      ['emissive texture', [place('emissiveTex', 0, -4)], undefined, { emissive: 1 }],
      ['normal map', [place('normal', -1, -4), place('normal', 1, -4), place('plain', 0, -6)], undefined, { normalMaps: 2 }],
      ['unlit', [place('unlit', 0, -4)], undefined, { unlit: 1 }],
      ['alpha MASK', [place('mask', 0, -4), place('textured', 1, -4)], undefined, { mask: 1 }],
      ['fog', [place('plain', 0, -4)], { fog: FOG }, { fog: true }],
      ['an invalid fog', [place('plain', 0, -4)], { fog: { color: 'nope', near: 5, far: 30 } }, {}],
      ['unusable emissive and normal textures', [place('emissiveBadTex', -1, -4), place('normalBad', 1, -4)], undefined, {}],
      ['everything together', [place('emissive', -2, -4), place('normal', -1, -4), place('unlit', 0, -4), place('mask', 1, -4), place('plain', 2, -4)], { fog: FOG }, { fog: true, emissive: 1, normalMaps: 1, unlit: 1, mask: 1 }]
    ];
    for (const [label, objects, extra, on] of scenes) {
      writeScene(objects, extra);
      await enter('lobby');
      const t = await hudText();
      assert(t, label + ': the HUD stays open across a world entry');
      await expectOnly(label, on);
      const r = (await info()).resources;
      assert(r.drawables === objects.length, label + ': one drawable per quad, got ' + r.drawables);
      assert(r.textures === await tex.live(), label + ': HUD textures ' + r.textures + ' vs GL ' + await tex.live());
    }
    console.log('PASS: each feature shows ON only when loaded content uses it (with a count), OFF otherwise; bad textures and bad fog do not count');

    // ---------------------------------------------------------------- 7 + 8
    console.log('STEP 7: pixel parity with the HUD hidden, and outside its box while shown');
    writeLobby();
    await enter('lobby');
    if (await hudText() !== null) await pressF3(); // hidden
    assert(await hudText() === null, 'hidden for the parity shots');
    await setCam(-2.0, 1.5, 1.4, -1.45, -0.12);
    await sleep(900);
    const hiddenShot = await shot();
    const hiddenAgain = await shot();
    const noise = await diffPixels(frame, hiddenShot, hiddenAgain);
    await pressF3();
    await sleep(500);
    const shownBox = await hudBox();
    const shownShot = await shot();
    const outside = await diffPixels(frame, hiddenShot, shownShot, shownBox);
    const inside = await diffPixels(frame, hiddenShot, shownShot) - outside;
    await pressF3();
    await sleep(500);
    const afterShot = await shot();
    const restored = await diffPixels(frame, hiddenShot, afterShot);
    assert(inside > 200, 'the HUD does draw something (' + inside + ' pixels in its box)');
    assert(noise === 0, 'the scene is static for this check (two shots differ in ' + noise + ' pixels)');
    assert(outside === 0, 'with the HUD shown, ' + outside + ' pixels outside its box differ');
    assert(restored === 0, 'after hiding it again the frame differs in ' + restored + ' pixels');
    console.log('PASS: hidden frames are identical before and after; shown, only the HUD box changes (' + inside + ' pixels)');

    console.log('STEP 8: status entries are display-only');
    await pressF3();
    await sleep(400);
    const infoBefore = await info();
    const shotBefore = await shot();
    await frame.evaluate(() => window.MiniGLTFHud.setDebugStatuses([{ label: 'Speed boost', value: 'ON' }, { label: 'Portal key', value: 'ACTIVE' }]));
    await sleep(500);
    text = await hudText();
    assert(/STATUS\nSpeed boost\s+ON\nPortal key\s+ACTIVE/.test(text), 'the entries are listed:\n' + text);
    const shotWith = await shot();
    const box2 = await hudBox();
    const infoWith = await info();
    const strip = (v) => JSON.stringify({ ...v, frames: 0 });
    assert(strip(infoBefore) === strip(infoWith), 'the renderer snapshot is unchanged by statuses:\n' + strip(infoBefore) + '\n' + strip(infoWith));
    assert(await diffPixels(frame, shotBefore, shotWith, box2) === 0, 'the picture outside the HUD box is unchanged by statuses');
    await frame.evaluate(() => window.MiniGLTFHud.setDebugStatuses([]));
    await sleep(500);
    text = await hudText();
    assert(!/STATUS/.test(text), 'clearing the entries hides the section');
    const posAfter = await frame.evaluate(() => window.__atlasActive3D.camera.pos.slice());
    assert(Math.abs(posAfter[0] + 2.0) < 1e-6 && Math.abs(posAfter[2] - 1.4) < 1e-6, 'nothing moved the player');
    console.log('PASS: entries appear and disappear without touching the renderer or the picture');

    assert(pageErrors.length === 0, 'no page errors: ' + pageErrors.join(' | '));
    console.log('\nALL HUD WORLD CHECKS PASSED');
  } finally {
    if (context) await context.close();
    serverProc.kill();
    for (const d of [DOCROOT_DIR, STATE_DIR, PROFILE_DIR]) fs.rmSync(d, { recursive: true, force: true });
  }
})().catch((e) => { console.error('FAILURE:', e); process.exit(1); });
