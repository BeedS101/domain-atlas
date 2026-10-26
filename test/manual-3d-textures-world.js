// Textured models in the normal world renderer (extension + issuer-server, no
// previewModel). A copy of demo-domain-a is served with its Lobby scene
// replaced by small test scenes; the synthetic GLBs are written at test time.
//
// Scenes (colours are classified by hue, so lighting does not matter):
//   A. The bundled textureTestBoard.glb: the four colour quadrants appear in
//      the right arrangement.
//   B. One textured quad placed twice: both instances are textured, and the
//      GLB is requested once (model cache); the GPU textures it created are
//      all deleted when the world is destroyed.
//   C. baseColorFactor multiplies the texture ([1,0,0,1] keeps only red).
//   D. A model whose image is corrupt, next to a flat model: the scene still
//      loads, the corrupt one keeps its flat colour, the flat one is unchanged.

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JPEG_QUADS, quadrantPng, quadGlb, buildGlb, quadSpec } = require('./texture-test-lib');

const REPO = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO, 'extension');
const PORT = 8357;
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-tex-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-tex-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-tex-profile-'));
const SCENE_PATH = path.join(DOCROOT_DIR, 'spatial', 'lobby', 'scene.json');
const MAIN_MANIFEST_PATH = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');
const TEX_DIR = path.join(DOCROOT_DIR, 'assets', 'texture-test');

function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hue classes for the four quadrant colours (flat floor/sky colours match none of them).
const CLASSES = {
  red: 'r > 120 && r > g + 80 && r > b + 80',
  green: 'g > 90 && g > r + 50 && g > b + 50',
  blue: 'b > 100 && b > r + 50 && b > g + 30',
  yellow: 'r > 120 && g > 100 && b < 80 && Math.abs(r - g) < 70',
  white: 'r > 170 && g > 170 && b > 170',
  orange: 'r > 150 && g > 60 && g < 170 && b < 60 && r > g + 40',
  cyan: 'g > 120 && b > 130 && r < 80'
};

async function analyse(page, frame, region) {
  const png = (await page.screenshot()).toString('base64');
  return frame.evaluate(async ([b64, classSrc, reg]) => {
    const classes = {};
    Object.keys(classSrc).forEach((k) => { classes[k] = new Function('r', 'g', 'b', 'return ' + classSrc[k] + ';'); });
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const x0 = Math.floor(img.width * reg[0]), y0 = Math.floor(img.height * reg[1]);
    const w = Math.floor(img.width * (reg[2] - reg[0])), h = Math.floor(img.height * (reg[3] - reg[1]));
    const d = g.getImageData(x0, y0, w, h).data;
    const out = {};
    Object.keys(classes).forEach((k) => { out[k] = { n: 0, sx: 0, sy: 0 }; });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        for (const k of Object.keys(classes)) if (classes[k](d[i], d[i + 1], d[i + 2])) { out[k].n++; out[k].sx += x; out[k].sy += y; }
      }
    }
    const res = {};
    Object.keys(out).forEach((k) => { res[k] = { n: out[k].n, x: out[k].n ? out[k].sx / out[k].n / w : null, y: out[k].n ? out[k].sy / out[k].n / h : null }; });
    return res;
  }, [png, CLASSES, region]);
}

(async () => {
  console.log('SETUP: isolated copy of demo-domain-a with test scenes');
  fs.cpSync(path.join(REPO, 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(MAIN_MANIFEST_PATH, 'utf8'));
  manifest.domain = DOMAIN;
  fs.writeFileSync(MAIN_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  const baseScene = JSON.parse(fs.readFileSync(SCENE_PATH, 'utf8'));

  const png = quadrantPng();
  fs.writeFileSync(path.join(TEX_DIR, 'quad.glb'), quadGlb({ texture: { bytes: png, mimeType: 'image/png' } }));
  fs.writeFileSync(path.join(TEX_DIR, 'quad-red.glb'), quadGlb({ baseColorFactor: [1, 0, 0, 1], texture: { bytes: png, mimeType: 'image/png' } }));
  fs.writeFileSync(path.join(TEX_DIR, 'quad-jpeg.glb'), quadGlb({ texture: { bytes: JPEG_QUADS, mimeType: 'image/jpeg' } }));
  const corrupt = Buffer.concat([png.subarray(0, 40), Buffer.alloc(20, 0xff)]);
  fs.writeFileSync(path.join(TEX_DIR, 'quad-corrupt.glb'), quadGlb({ baseColorFactor: [1, 0.55, 0, 1], texture: { bytes: corrupt, mimeType: 'image/png' } }));
  fs.writeFileSync(path.join(TEX_DIR, 'quad-flat.glb'), buildGlb({ ...quadSpec(), uvs: undefined, baseColorFactor: [0.1, 0.8, 0.9, 1] }));

  const writeScene = (objects) => fs.writeFileSync(SCENE_PATH, JSON.stringify({
    ...baseScene, objects, interactables: [], portalMarkers: [], anchors: [], camera: { start: [0, 1.6, 0], startYaw: 0 }
  }, null, 2));
  const obj = (name, x, scale) => ({ model: '/assets/texture-test/' + name, position: [x, 0, -3], rotationY: 0, scale, solid: false });

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

    // Live GL textures in the overlay frame, tracked from here on.
    await frame.evaluate(() => {
      window.__live = new Set();
      const proto = WebGLRenderingContext.prototype;
      const create = proto.createTexture, del = proto.deleteTexture;
      proto.createTexture = function () { const t = create.apply(this, arguments); if (t) window.__live.add(t); return t; };
      proto.deleteTexture = function (t) { window.__live.delete(t); return del.apply(this, arguments); };
    });
    const live = () => frame.evaluate(() => window.__live.size);

    async function enter() {
      await frame.evaluate(() => window.__live.clear());
      await frame.evaluate(() => loadManifest(currentManifestUrl, 'lobby', null));
      await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby') && !!window.__atlasActive3D, null, { timeout: 30000 });
      await frame.evaluate(() => window.__atlasActive3D.ready);
      await sleep(1500); // image decode + a few frames
    }
    const CENTRE = [0.15, 0.15, 0.85, 0.85];

    console.log('STEP 1 (scene A): the bundled test board shows its four colour quadrants in the right places');
    writeScene([obj('textureTestBoard.glb', 0, 2)]);
    await enter();
    let a = await analyse(page, frame, CENTRE);
    for (const k of ['red', 'green', 'blue', 'yellow', 'white']) assert(a[k].n > 150, `expected ${k} pixels on the board, found ${a[k].n}`);
    assert(a.red.x < a.green.x && a.red.y < a.blue.y, `red (top-left) must be left of green and above blue: ${JSON.stringify(a)}`);
    assert(a.blue.x < a.yellow.x && a.green.y < a.yellow.y, `yellow (bottom-right) must be right of blue and below green: ${JSON.stringify(a)}`);
    assert(a.white.x < a.green.x && a.white.y < a.blue.y, 'the white L sits in the top-left quadrant');
    console.log('PASS: textured board renders in the world renderer, upright (red top-left, green top-right, blue bottom-left, yellow bottom-right)');

    console.log('STEP 2 (scene B): one textured GLB placed twice');
    writeScene([obj('quad.glb', -1.0, 1.5), obj('quad.glb', 1.0, 1.5)]);
    requests.length = 0;
    await enter();
    const fetches = requests.filter((u) => u.endsWith('/assets/texture-test/quad.glb')).length;
    assert(fetches === 1, 'expected the GLB to be requested once for two instances, got ' + fetches);
    for (const [name, region] of [['left', [0.1, 0.15, 0.5, 0.85]], ['right', [0.5, 0.15, 0.9, 0.85]]]) {
      a = await analyse(page, frame, region);
      for (const k of ['red', 'green', 'blue', 'yellow']) assert(a[k].n > 100, `${name} instance: expected ${k} pixels, found ${a[k].n}`);
      assert(a.red.x < a.green.x && a.red.y < a.blue.y && a.blue.x < a.yellow.x, `${name} instance quadrants misplaced: ${JSON.stringify(a)}`);
    }
    const during = await live();
    assert(during >= 2, 'expected the fallback texture and the model texture to be live, got ' + during);
    console.log(`PASS: both instances are textured from a single request (${during} live GL textures)`);

    console.log('STEP 3: destroying the world deletes every GPU texture it created');
    await frame.evaluate(() => window.__atlasActive3D.destroy());
    const after = await live();
    assert(after === 0, `expected 0 live textures after destroy(), got ${after}`);
    console.log('PASS: 0 live GL textures after the world is destroyed');

    console.log('STEP 4 (scene C): baseColorFactor [1,0,0,1] keeps only the red component of the texture');
    writeScene([obj('quad-red.glb', 0, 2)]);
    await enter();
    a = await analyse(page, frame, CENTRE);
    assert(a.red.n > 1000, 'expected red pixels, found ' + a.red.n);
    assert(a.green.n < 20 && a.blue.n < 20 && a.white.n < 20, `green/blue/white must be gone: ${JSON.stringify(a)}`);
    console.log('PASS: texture x baseColorFactor in the world renderer');

    console.log('STEP 5: an embedded JPEG renders');
    writeScene([obj('quad-jpeg.glb', 0, 2)]);
    await enter();
    a = await analyse(page, frame, CENTRE);
    for (const k of ['red', 'green', 'blue', 'yellow']) assert(a[k].n > 500, `JPEG: expected ${k} pixels, found ${a[k].n}`);
    assert(a.red.x < a.green.x && a.red.y < a.blue.y, 'JPEG quadrants in the right places');
    console.log('PASS: JPEG-textured model renders');

    console.log('STEP 6 (scene D): corrupt image next to a flat model, with an untextured model that has no UVs');
    warnings.length = 0;
    writeScene([obj('quad-corrupt.glb', -1.0, 1.5), obj('quad-flat.glb', 1.0, 1.5)]);
    await enter();
    const shot = await analyse(page, frame, [0, 0, 1, 1]);
    const counts = { orange: shot.orange.n, orangeX: shot.orange.x, cyan: shot.cyan.n, cyanX: shot.cyan.x };
    assert(counts.orange > 1000 && counts.cyan > 1000, 'both models must be visible in their flat colours: ' + JSON.stringify(counts));
    assert(counts.orangeX < counts.cyanX, 'corrupt-image model (left) keeps its flat factor colour, flat model (right) unchanged: ' + JSON.stringify(counts));
    assert(warnings.some((w) => /texture|image/i.test(w)), 'a console warning names the unusable image; got ' + JSON.stringify(warnings));
    console.log('PASS: the scene loads, the corrupt image falls back to the flat colour (warned), the flat model is unchanged');

    assert(pageErrors.length === 0, 'no uncaught page errors: ' + pageErrors.join(' | '));
    console.log('\nALL TEXTURE WORLD CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    serverProc.kill();
    for (const d of [DOCROOT_DIR, STATE_DIR, PROFILE_DIR]) fs.rmSync(d, { recursive: true, force: true });
  }
})();
