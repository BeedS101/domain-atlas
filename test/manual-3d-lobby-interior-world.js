// The Domain A Lobby interior material pass in the normal world renderer
// (extension + issuer-server on an isolated copy of demo-domain-a with the real
// Lobby scene). The same scene with the bundled furniture models and without
// the floor and plaque ("original") is the reference.
//
//   1. The interior renders: a stone floor instead of the dark base floor, light
//      plaster walls, glowing screens and a readable (unlit) plaque. The original
//      shows the dark base floor, so the checks tell the two apart.
//   2. No z-fighting: the base floor never shows through the stone, even at a
//      grazing angle; rugs still draw red over the floor overlay.
//   3. The outdoor town and the building's exterior are unchanged (views from
//      the east and north sides match the original).
//   4. Crates still prompt when approached; an item drop still renders indoors.
//   5. Held-key walking still works: forward from the spawn is stopped by the
//      same wall as before.
//   6. GL textures: every image of every model in the scene is one live texture
//      (+ the shared fallback); none are left after destroy(), and none after
//      leaving the world.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sleep, trackTextures } = require('./portal-test-lib');

const REPO = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO, 'extension');
const tool = require(path.join(REPO, 'tools', 'make-lobby-interior-assets.js'));
const PORT = 8372;
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-interior-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-interior-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-interior-profile-'));
const SCENE_PATH = path.join(DOCROOT_DIR, 'spatial', 'lobby', 'scene.json');
const MAIN_MANIFEST_PATH = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');

function assert(cond, msg) { if (!cond) throw new Error(msg); }

// x, y, z, yaw, pitch
const VIEWS = {
  entrance: [3.2, 1.5, 4.9, 0, -0.05],
  centre: [0, 1.6, 0.4, -0.6, -0.12],
  floor: [0, 1.6, 2.4, 0, -0.95],
  grazing: [0, 0.3, 2.5, 0, -0.02],
  eastSide: [13, 1.6, -0.5, -Math.PI / 2, -0.05],
  northSide: [-2, 1.6, -12, Math.PI, -0.05]
};

// Counts the pixels of a colour class inside a region ([x0, y0, x1, y1] as fractions) of a screenshot.
// (The extension frame forbids eval, so the classes are fixed here.)
const countClass = (frame, b64, region, cls) => frame.evaluate(async ([b64, reg, cls]) => {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const x0 = Math.floor(img.width * reg[0]), y0 = Math.floor(img.height * reg[1]), w = Math.floor(img.width * (reg[2] - reg[0])), h = Math.floor(img.height * (reg[3] - reg[1]));
  const d = g.getImageData(x0, y0, w, h).data;
  const test = {
    darkBrown: (r, gr, b) => r >= 48 && r <= 68 && gr >= 38 && gr <= 56 && b >= 26 && b <= 42 && r - b >= 16 && r - b <= 32, // the base floor colour, as lit
    stone: (r, gr, b) => r > 140 && gr > 115 && b > 85 && r > b + 15 && r - b < 95 && r >= gr && gr >= b,
    plaster: (r, gr, b) => r > 150 && gr > 140 && b > 110 && r - b < 60 && Math.abs(r - gr) < 25,
    rugRed: (r, gr, b) => r > 190 && gr < 120 && b < 120,
    blueScreen: (r, gr, b) => b > r + 40 && b >= gr,
    gold: (r, gr, b) => r > 190 && gr > 150 && b < 140 && r - b > 60
  }[cls];
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (test(d[i], d[i + 1], d[i + 2])) n++;
  return { count: n, total: d.length / 4 };
}, [b64, region, cls]);

const diffRegion = (frame, a, b, region) => frame.evaluate(async ([a, b, reg]) => {
  const load = async (s) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + s; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
    return g.getImageData(Math.floor(img.width * reg[0]), Math.floor(img.height * reg[1]), Math.floor(img.width * (reg[2] - reg[0])), Math.floor(img.height * (reg[3] - reg[1]))).data;
  };
  const da = await load(a), db = await load(b);
  let n = 0;
  for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 24) n++;
  return n;
}, [a, b, region]);

(async () => {
  console.log('SETUP: isolated copy of demo-domain-a');
  fs.cpSync(path.join(REPO, 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(MAIN_MANIFEST_PATH, 'utf8'));
  manifest.domain = DOMAIN;
  fs.writeFileSync(MAIN_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  const sceneNow = JSON.parse(fs.readFileSync(SCENE_PATH, 'utf8'));
  const sceneOriginal = {
    ...sceneNow,
    objects: sceneNow.objects.filter((o) => !tool.NEW_OBJECTS.some((n) => n.model === o.model)).map((o) => {
      const m = /^\/assets\/lobby\/interior\/(\w+)\.glb$/.exec(o.model);
      return m ? { ...o, model: '/assets/furniture/' + m[1] + '.glb' } : o;
    })
  };
  const writeScene = (scene) => fs.writeFileSync(SCENE_PATH, JSON.stringify(scene, null, 2));

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
    const pageErrors = [], warnings = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'warning' && /gltf-mini/.test(m.text())) warnings.push(m.text()); });
    await page.goto('http://' + DOMAIN, { waitUntil: 'load' });
    await page.locator('#domain-atlas-enter-btn').click();
    const frame = await (await page.waitForSelector('#domain-atlas-overlay', { timeout: 10000 })).contentFrame();
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 10000 });
    const tex = await trackTextures(frame);
    await frame.evaluate(() => { const s = document.createElement('style'); s.textContent = '#chatWidget, #previewer { display: none !important; }'; document.head.appendChild(s); });

    async function enter() {
      await tex.reset();
      warnings.length = 0;
      await frame.evaluate(() => loadManifest(currentManifestUrl, 'lobby', null));
      await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby') && !!window.__atlasActive3D, null, { timeout: 30000 });
      await frame.evaluate(() => window.__atlasActive3D.ready);
      await sleep(2500);
    }
    const shoot = async (name) => {
      const v = VIEWS[name];
      await frame.evaluate(([x, y, z, yaw, pitch]) => { const c = window.__atlasActive3D.camera; c.pos[0] = x; c.pos[1] = y; c.pos[2] = z; c.yaw = yaw; c.pitch = pitch; }, v);
      await sleep(600);
      return (await page.locator('#domain-atlas-overlay').screenshot()).toString('base64');
    };
    const frac = async (b64, region, cls) => { const r = await countClass(frame, b64, region, cls); return r.count / r.total; };
    const SHOTS = {};

    // The reference first: the original interior.
    writeScene(sceneOriginal);
    await enter();
    for (const n of Object.keys(VIEWS)) SHOTS['orig_' + n] = await shoot(n);
    const origFloorDark = await frac(SHOTS.orig_centre, [0, 0.62, 1, 1], 'darkBrown');
    assert(origFloorDark > 0.3, 'the original interior shows the dark base floor (sanity of the check), got ' + origFloorDark.toFixed(3));

    writeScene(sceneNow);
    await enter();
    for (const n of Object.keys(VIEWS)) SHOTS['now_' + n] = await shoot(n);
    assert(!warnings.some((w) => /could not use|not emissive|normalTexture|emissiveTexture/.test(w)), 'no texture warnings: ' + JSON.stringify(warnings));

    // ---------------------------------------------------------------- 1
    console.log('STEP 1: the interior renders');
    const floorDark = await frac(SHOTS.now_centre, [0, 0.62, 1, 1], 'darkBrown');
    const floorStone = await frac(SHOTS.now_centre, [0, 0.62, 1, 1], 'stone');
    assert(floorDark < 0.005, 'the dark base floor no longer shows, got ' + floorDark.toFixed(4));
    assert(floorStone > 0.4, 'most of the lower view is stone floor, got ' + floorStone.toFixed(3));
    const wallPlaster = await frac(SHOTS.now_entrance, [0.0, 0.46, 0.66, 0.62], 'plaster');
    assert(wallPlaster > 0.25, 'the back wall is light plaster, got ' + wallPlaster.toFixed(3));
    const tvBlue = await countClass(frame, SHOTS.now_entrance, [0.80, 0.62, 0.88, 0.70], 'blueScreen');
    const tvBlueOrig = await countClass(frame, SHOTS.orig_entrance, [0.80, 0.62, 0.88, 0.70], 'blueScreen');
    assert(tvBlue.count > 150 && tvBlueOrig.count < 20, 'the television shows its emissive display (' + tvBlue.count + ' blue pixels vs ' + tvBlueOrig.count + ' originally)');
    const plaque = await countClass(frame, SHOTS.now_entrance, [0.31, 0.46, 0.38, 0.56], 'gold');
    assert(plaque.count > 25, 'the plaque lettering is readable gold, got ' + plaque.count);
    console.log('PASS: stone floor (' + Math.round(floorStone * 100) + '% of the lower view, base floor ' + (floorDark * 100).toFixed(2) + '% vs ' + Math.round(origFloorDark * 100) + '% originally), plaster walls, TV display, plaque');

    // ---------------------------------------------------------------- 2
    console.log('STEP 2: no z-fighting on the floor or at the rugs');
    const grazingDark = await frac(SHOTS.now_grazing, [0, 0.5, 1, 1], 'darkBrown');
    assert(grazingDark < 0.005, 'the base floor does not show through at a grazing angle, got ' + grazingDark.toFixed(4));
    const rug = await frac(SHOTS.now_floor, [0.3, 0.3, 0.6, 0.55], 'rugRed');
    assert(rug > 0.9, 'the rug draws solid red over the floor overlay, got ' + rug.toFixed(3));
    const rugStone = await frac(SHOTS.now_floor, [0.3, 0.3, 0.6, 0.55], 'stone');
    assert(rugStone < 0.005, 'no stone speckles through the rug, got ' + rugStone.toFixed(4));
    console.log('PASS: base floor ' + (grazingDark * 100).toFixed(2) + '% at a grazing angle; rug ' + Math.round(rug * 100) + '% red with no stone through it');

    // ---------------------------------------------------------------- 3
    console.log('STEP 3: the exterior and the town are unchanged');
    if (process.env.DEBUG_SHOTS) for (const [k, v] of Object.entries(SHOTS)) fs.writeFileSync(path.join(process.env.DEBUG_SHOTS, k + '.png'), Buffer.from(v, 'base64'));
    for (const n of ['eastSide', 'northSide']) {
      const diff = await diffRegion(frame, SHOTS['orig_' + n], SHOTS['now_' + n], [0, 0.08, 1, 1]);
      assert(diff < 500, n + ' view differs from the original in ' + diff + ' pixels');
    }
    console.log('PASS: views of the east and north sides of the building match the original');

    // ---------------------------------------------------------------- 4
    console.log('STEP 4: crates still prompt; item drops still render indoors');
    await frame.evaluate(() => { const c = window.__atlasActive3D.camera; c.pos[0] = 0.3; c.pos[1] = 1.6; c.pos[2] = -0.2; });
    await sleep(800);
    const prompt = await frame.evaluate(() => window.__atlasActive3D.getInteractPrompt());
    assert(prompt && /crate/i.test(prompt), 'standing by a crate shows its prompt, got ' + JSON.stringify(prompt));
    await frame.evaluate(([x, y, z, yaw, pitch]) => { const c = window.__atlasActive3D.camera; c.pos[0] = x; c.pos[1] = y; c.pos[2] = z; c.yaw = yaw; c.pitch = pitch; }, [-2.2, 1.5, 4.7, 0, -0.42]);
    await sleep(600);
    const before = (await page.locator('#domain-atlas-overlay').screenshot()).toString('base64');
    const drop = { dropId: 'indoor1', position: [-2.2, 0, 2.2], radius: 0.9, model: 'http://' + DOMAIN + '/assets/trophy.glb', domain: DOMAIN, credential: { id: 'c1', issuer: { domain: DOMAIN }, asset: { class: 'test.trophy', name: 'Trophy' } } };
    await frame.evaluate((d) => window.__atlasActive3D.setItemDrops(d), [drop]);
    await frame.waitForFunction(() => window.__atlasActive3D.getItemDropRenderKind('indoor1') === 'model', null, { timeout: 10000 });
    await sleep(600);
    const after = (await page.locator('#domain-atlas-overlay').screenshot()).toString('base64');
    const changed = await diffRegion(frame, before, after, [0.3, 0.45, 0.7, 0.85]);
    assert(changed > 400, 'the dropped item is drawn on the stone floor, ' + changed + ' pixels changed');
    await frame.evaluate(() => window.__atlasActive3D.setItemDrops([]));
    console.log('PASS: "' + prompt + '" prompt by a crate; a dropped model draws indoors (' + changed + ' pixels)');

    // ---------------------------------------------------------------- 5
    console.log('STEP 5: walking into the wall stops at the same place as before');
    const stopAt = async (scene) => {
      writeScene(scene);
      await enter();
      await frame.evaluate(() => { const c = window.__atlasActive3D.camera; c.pos[0] = -2.9; c.pos[1] = 1.6; c.pos[2] = 3.4; c.yaw = 0; c.pitch = 0; });
      await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW' })));
      await sleep(7000);
      await frame.evaluate(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW' })));
      return frame.evaluate(() => { const p = window.__atlasActive3D.camera.pos; return [p[0], p[2]]; });
    };
    const stopOrig = await stopAt(sceneOriginal), stopNow = await stopAt(sceneNow);
    assert(Math.abs(stopOrig[0] - stopNow[0]) < 0.02 && Math.abs(stopOrig[1] - stopNow[1]) < 0.02, 'the player stops at the same spot: ' + JSON.stringify(stopOrig) + ' vs ' + JSON.stringify(stopNow));
    assert(stopNow[1] > -5.6 && stopNow[1] < 0.5, 'and it is a real stop at furniture or the wall, got z ' + stopNow[1]);
    console.log('PASS: forward from the same spot ends at [' + stopNow.map((v) => v.toFixed(2)) + '] with and without the new materials');

    // ---------------------------------------------------------------- 6
    console.log('STEP 6: GPU textures are counted and released');
    writeScene(sceneNow);
    await enter();
    const imagesOf = (url) => {
      const b = fs.readFileSync(path.join(DOCROOT_DIR, url.replace(/^\//, '')));
      return (JSON.parse(b.slice(20, 20 + b.readUInt32LE(12)).toString()).images || []).length;
    };
    const urls = [...new Set(sceneNow.objects.map((o) => o.model))];
    const expected = urls.reduce((n, u) => n + imagesOf(u), 0) + 1;
    const live = await tex.live();
    assert(live === expected, 'one live GL texture per image of each distinct model + the fallback: expected ' + expected + ', got ' + live);
    await frame.evaluate(() => loadManifest(currentManifestUrl, 'plaza', null));
    await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Plaza'), null, { timeout: 15000 });
    await sleep(1500);
    const afterLeaving = await tex.live();
    assert(afterLeaving === 0, 'leaving the Lobby releases every texture, got ' + afterLeaving);
    await enter();
    await frame.evaluate(() => window.__atlasActive3D.destroy());
    assert((await tex.live()) === 0, 'destroy() releases every texture');
    console.log('PASS: ' + expected + ' live textures in the Lobby; 0 after leaving it and after destroy()');

    assert(pageErrors.length === 0, 'no uncaught page errors: ' + pageErrors.join(' | '));
    console.log('\nALL LOBBY INTERIOR WORLD CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    serverProc.kill();
    for (const d of [DOCROOT_DIR, STATE_DIR, PROFILE_DIR]) fs.rmSync(d, { recursive: true, force: true });
  }
})();
