// gltf-mini-v1's optional material features in the normal world renderer
// (extension + issuer-server on an isolated copy of demo-domain-a). Small
// generated models stand in a replaced Lobby scene in front of the camera and
// exact pixel colours are measured (ambient-only lighting keeps the expected
// colours simple; `quad` models face the camera and fill part of the view).
//
//   1. emissiveFactor: added after lighting, so a surface stays bright with
//      the light switched off.
//   2. emissiveTexture: the texture colours the glow; an unusable texture, or
//      a texture with no factor, leaves the material non-emissive.
//   3. normalTexture: tilting the normals toward or away from the light
//      changes the shading; scale 0 changes nothing.
//   4. normal-map fallback: a model without UVs, or without normals, shades
//      exactly like the same model without the normal texture.
//   5. alpha MASK / alphaCutoff: cut-out pixels show what is behind (and write
//      no depth); OPAQUE ignores texture alpha.
//   6. fog: off when the scene has none or an invalid one; on with valid
//      settings (a linear fade), and applied to item drops.
//   7. unlit: shows the base colour with the light off; lit models do not.
//   8. old behaviour: flat and textured models shade by the same formula.
//   9. GPU textures: counted per image, shared images once, none left after destroy().

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildMultiGlb, makePng, quadSpec } = require(path.join(__dirname, '..', 'tools', 'lib', 'glb-builder'));
const { sleep, trackTextures } = require('./portal-test-lib');

const REPO = path.resolve(__dirname, '..');
const EXT_PATH = path.join(REPO, 'extension');
const PORT = 8363;
const DOMAIN = 'localhost:' + PORT;
const DOCROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-mat-docroot-'));
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-mat-state-'));
const PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-3d-mat-profile-'));
const SCENE_PATH = path.join(DOCROOT_DIR, 'spatial', 'lobby', 'scene.json');
const MAIN_MANIFEST_PATH = path.join(DOCROOT_DIR, '.well-known', 'spatial.json');
const MODEL_DIR = path.join(DOCROOT_DIR, 'assets', 'material-test');

function assert(cond, msg) { if (!cond) throw new Error(msg); }
const near = (got, want, tol, msg) => assert(got.length === want.length && got.every((v, i) => Math.abs(v - want[i]) <= tol), msg + ': got [' + got.map((v) => Math.round(v)) + '], expected [' + want.map((v) => Math.round(v)) + '] +-' + tol);

// ---- model fixtures ----
const quad = (material, geometry) => buildMultiGlb({ primitives: [{ ...quadSpec(), ...(geometry || {}), material }] });
// A 0.5 m cube with flat normals, for item drops (it looks the same from every side).
function cubeSpec() {
  const faces = [[[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]], [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
    [[1, 0, 0], [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]], [[-1, 0, 0], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
    [[0, 1, 0], [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]], [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]]];
  const positions = [], normals = [], indices = [];
  faces.forEach(([n, corners], f) => { corners.forEach((c) => { positions.push(c[0] * 0.25, c[1] * 0.25 + 0.25, c[2] * 0.25); normals.push(...n); }); indices.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3); });
  return { positions, normals, indices };
}
const png = (w, h, fn) => ({ bytes: makePng(w, h, fn), mimeType: 'image/png' });
const solid = (rgba) => png(8, 8, () => rgba);
const halves = (left, right) => png(16, 16, (x) => (x < 8 ? left : right)); // left half / right half
const bands = (a, b, c) => png(18, 6, (x) => (x < 6 ? a : x < 12 ? b : c));
const LIGHT_OFF = { ambient: 0.05, direction: [0, 0, 1] }; // faces turned toward the camera get only the 5% ambient
const FULL = { ambient: 1, direction: [0, 0, 1] }; // light = 1: colours come out as authored
const SLANT = { ambient: 0.2, direction: [-0.7071, 0, -0.7071] }; // light from the front right

(async () => {
  console.log('SETUP: isolated copy of demo-domain-a with generated test models');
  fs.cpSync(path.join(REPO, 'demo-domain-a'), DOCROOT_DIR, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(MAIN_MANIFEST_PATH, 'utf8'));
  manifest.domain = DOMAIN;
  fs.writeFileSync(MAIN_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  const baseScene = JSON.parse(fs.readFileSync(SCENE_PATH, 'utf8'));
  fs.mkdirSync(MODEL_DIR, { recursive: true });

  const files = {};
  const model = (name, glb) => { files[name] = true; fs.writeFileSync(path.join(MODEL_DIR, name + '.glb'), glb); return name; };
  const NORMAL_MAP = halves([64, 128, 238, 255], [191, 128, 238, 255]); // tilt -x (left half) / +x (right half): n = (+-0.5, 0, 0.866)
  const CORRUPT = { bytes: Buffer.concat([makePng(8, 8, () => [255, 255, 255, 255]).subarray(0, 40), Buffer.alloc(30, 0xff)]), mimeType: 'image/png' };
  const SPEC = {
    white: model('white', quad({})),
    black: model('black', quad({ baseColorFactor: [0, 0, 0, 1] })),
    glowGreen: model('glow-green', quad({ emissiveFactor: [0, 1, 0] })),
    glowRedBlack: model('glow-red-black', quad({ baseColorFactor: [0, 0, 0, 1], emissiveFactor: [1, 0, 0] })),
    glowHalf: model('glow-half', quad({ baseColorFactor: [0, 0, 0, 1], emissiveFactor: [0.5, 0.5, 0.5] })),
    glowTex: model('glow-tex', quad({ baseColorFactor: [0, 0, 0, 1], emissiveFactor: [1, 1, 1], emissiveTexture: halves([255, 0, 0, 255], [0, 0, 255, 255]) })),
    glowTexHalf: model('glow-tex-half', quad({ baseColorFactor: [0, 0, 0, 1], emissiveFactor: [0.5, 0.5, 0.5], emissiveTexture: halves([255, 0, 0, 255], [0, 0, 255, 255]) })),
    glowTexCorrupt: model('glow-tex-corrupt', quad({ baseColorFactor: [0, 0, 0, 1], emissiveFactor: [1, 1, 1], emissiveTexture: CORRUPT })),
    glowTexNoFactor: model('glow-tex-nofactor', quad({ baseColorFactor: [0, 0, 0, 1], emissiveTexture: halves([255, 0, 0, 255], [0, 0, 255, 255]) })),
    glowTexNoUv: model('glow-tex-nouv', quad({ baseColorFactor: [0, 0, 0, 1], emissiveFactor: [1, 1, 1], emissiveTexture: halves([255, 0, 0, 255], [0, 0, 255, 255]) }, { uvs: undefined })),
    flat: model('flat', quad({})),
    mapped: model('mapped', quad({ normalTexture: NORMAL_MAP })),
    mappedScale0: model('mapped-scale0', quad({ normalTexture: { ...NORMAL_MAP, scale: 0 } })),
    mappedNoUv: model('mapped-nouv', quad({ normalTexture: NORMAL_MAP }, { uvs: undefined })),
    plainNoUv: model('plain-nouv', quad({}, { uvs: undefined })),
    mappedNoNormals: model('mapped-nonormals', quad({ normalTexture: NORMAL_MAP }, { normals: undefined })),
    plainNoNormals: model('plain-nonormals', quad({}, { normals: undefined })),
    maskBands: (cutoff, mode) => model('mask-' + String(cutoff).replace('.', '_') + '-' + mode, quad({ texture: bands([255, 0, 0, 30], [0, 255, 0, 120], [0, 0, 255, 220]), alphaMode: mode, ...(cutoff === undefined ? {} : { alphaCutoff: cutoff }) })),
    maskFactor: (alpha, mode) => model('maskf-' + String(alpha).replace('.', '_') + '-' + mode, quad({ baseColorFactor: [1, 1, 0, alpha], alphaMode: mode })),
    magenta: model('magenta', quad({ baseColorFactor: [1, 0, 1, 1] })),
    unlit: model('unlit', quad({ baseColorFactor: [0.8, 0.4, 0.2, 1], unlit: true })),
    unlitGlow: model('unlit-glow', quad({ baseColorFactor: [0.8, 0.4, 0.2, 1], unlit: true, emissiveFactor: [0, 1, 0] })),
    lit: model('lit', quad({ baseColorFactor: [0.8, 0.4, 0.2, 1] })),
    red: model('red', quad({ baseColorFactor: [1, 0, 0, 1] })),
    green: model('green', quad({ baseColorFactor: [0, 1, 0, 1] })),
    blue: model('blue', quad({ baseColorFactor: [0, 0, 1, 1] })),
    unlitCube: model('unlit-cube', buildMultiGlb({ primitives: [{ ...cubeSpec(), material: { baseColorFactor: [0, 1, 0, 1], unlit: true } }] })),
    threeImages: model('three-images', quad({ texture: solid([200, 200, 200, 255]), emissiveFactor: [1, 1, 1], emissiveTexture: solid([10, 10, 10, 255]), normalTexture: solid([128, 128, 255, 255]) })),
    sharedImage: model('shared-image', (() => { const t = solid([200, 200, 200, 255]); return quad({ texture: t, emissiveFactor: [1, 1, 1], emissiveTexture: t, normalTexture: t }); })()),
    texturedLit: model('textured-lit', quad({ texture: png(16, 16, (x, y) => (y < 8 ? (x < 8 ? [220, 40, 40, 255] : [40, 190, 60, 255]) : (x < 8 ? [50, 80, 230, 255] : [240, 210, 40, 255]))) }))
  };

  const placed = (name, x, z, scale, extra) => ({ model: '/assets/material-test/' + name + '.glb', position: [x, 0, z], rotationY: 0, scale: scale || 1, solid: false, ...(extra || {}) });
  const writeScene = ({ objects, light, fog }) => fs.writeFileSync(SCENE_PATH, JSON.stringify({
    ...baseScene, objects, interactables: [], portalMarkers: [], anchors: [], camera: { start: [0, 1.6, 0], startYaw: 0 },
    ambientLight: { intensity: (light || LIGHT_OFF).ambient }, directionalLight: { direction: (light || LIGHT_OFF).direction },
    ...(fog !== undefined ? { fog } : {})
  }, null, 2));

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
    await frame.evaluate(() => { const s = document.createElement('style'); s.textContent = '#chatWidget { display: none !important; }'; document.head.appendChild(s); }); // keep the sample points clear of the chat panel

    async function enter() {
      await tex.reset();
      warnings.length = 0;
      await frame.evaluate(() => loadManifest(currentManifestUrl, 'lobby', null));
      await frame.waitForFunction(() => document.getElementById('placeLabel').textContent.includes('Example Lobby') && !!window.__atlasActive3D, null, { timeout: 30000 });
      await frame.evaluate(() => window.__atlasActive3D.ready);
      await sleep(1500); // image decode + a few frames
    }
    // Screenshot pixel of a world point (camera at [0, 1.6, 0] looking down -z), averaged over a small patch.
    async function sample(points) {
      const rect = await frame.evaluate(() => { const c = document.getElementById('scene3d'); const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
      const pixels = points.map(([x, y, z]) => {
        const t = Math.tan(Math.PI / 6), aspect = rect.w / rect.h;
        return [rect.x + (0.5 + (x / -z) / (t * aspect) / 2) * rect.w, rect.y + (0.5 - ((y - 1.6) / -z) / t / 2) * rect.h];
      });
      const b64 = (await page.locator('#domain-atlas-overlay').screenshot()).toString('base64');
      return frame.evaluate(async ([b64, pixels]) => {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        return pixels.map(([px, py]) => {
          const d = g.getImageData(Math.round(px) - 2, Math.round(py) - 2, 5, 5).data;
          const sum = [0, 0, 0];
          for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
          return sum.map((v) => v / (d.length / 4));
        });
      }, [b64, pixels]);
    }
    const centre = (x, z, scale) => [x, scale / 2, z]; // the middle of a placed quad

    // ---------------------------------------------------------------- 1
    console.log('STEP 1: emissiveFactor is added after lighting, so it shows with the light off');
    writeScene({ objects: [placed(SPEC.white, -2.4, -5, 1.6), placed(SPEC.glowGreen, 0, -5, 1.6), placed(SPEC.glowRedBlack, 2.4, -5, 1.6), placed(SPEC.glowHalf, 0, -5, 1.6, { position: [0, 1.8, -5] })], light: LIGHT_OFF });
    await enter();
    let c = await sample([centre(-2.4, -5, 1.6), centre(0, -5, 1.6), centre(2.4, -5, 1.6), [0, 2.6, -5]]);
    near(c[0], [13, 13, 13], 4, 'a plain white quad only gets the 5% ambient');
    near(c[1], [13, 255, 13], 4, 'emissiveFactor [0,1,0] adds full green on top of the lit colour');
    near(c[2], [255, 0, 0], 4, 'an emissive-only red surface is full red');
    near(c[3], [128, 128, 128], 6, 'emissiveFactor [0.5,0.5,0.5] adds half');
    console.log('PASS: emissive surfaces stay visible with the light off; plain surfaces do not');

    // ---------------------------------------------------------------- 2
    console.log('STEP 2: emissiveTexture colours the glow; unusable ones are non-emissive');
    writeScene({
      objects: [placed(SPEC.glowTex, 0, -5, 1.6), placed(SPEC.glowTexHalf, 2.4, -5, 1.6), placed(SPEC.glowTexCorrupt, 4.8, -5, 1.6), placed(SPEC.glowTexNoFactor, 0, -5, 1.6, { position: [0, 1.8, -5] }), placed(SPEC.glowTexNoUv, 2.4, -5, 1.6, { position: [2.4, 1.8, -5] })],
      light: LIGHT_OFF
    });
    await enter();
    const left = (x, z) => [x - 0.4, 0.8, z], right = (x, z) => [x + 0.4, 0.8, z];
    c = await sample([left(0, -5), right(0, -5), left(2.4, -5), right(2.4, -5), centre(4.8, -5, 1.6), [0, 2.6, -5], [2.4, 2.6, -5]]);
    near(c[0], [255, 0, 0], 6, 'left half of the emissive texture is red');
    near(c[1], [0, 0, 255], 6, 'right half is blue');
    near(c[2], [128, 0, 0], 8, 'the factor scales the texture (half red)');
    near(c[3], [0, 0, 128], 8, 'the factor scales the texture (half blue)');
    near(c[4], [0, 0, 0], 4, 'a corrupt emissive image leaves the (black, lit) material non-emissive');
    near(c[5], [0, 0, 0], 4, 'a texture without an emissiveFactor (default 0,0,0) adds no glow');
    near(c[6], [0, 0, 0], 4, 'an emissive texture on a primitive without UVs leaves the material non-emissive');
    assert(warnings.some((w) => /emissiveTexture/.test(w)), 'a console warning names the unusable emissive texture; got ' + JSON.stringify(warnings));
    console.log('PASS: emissive texture x factor; corrupt, factor-less and UV-less textures fall back to non-emissive (warned)');

    // ---------------------------------------------------------------- 3
    console.log('STEP 3: a tangent-space normal map changes the shading');
    writeScene({ objects: [placed(SPEC.flat, -2.4, -5, 1.6), placed(SPEC.mapped, 0, -5, 1.6), placed(SPEC.mappedScale0, 2.4, -5, 1.6)], light: SLANT });
    await enter();
    c = await sample([left(-2.4, -5), left(0, -5), right(0, -5), centre(2.4, -5, 1.6)]);
    const flatLight = 0.2 + 0.7071 * 0.8; // 0.766
    near(c[0], [flatLight * 255, flatLight * 255, flatLight * 255], 5, 'the flat quad shades uniformly');
    const tiltAway = 0.2 + (-0.5 * 0.7071 + 0.866 * 0.7071) * 0.8, tiltToward = 0.2 + (0.5 * 0.7071 + 0.866 * 0.7071) * 0.8;
    near(c[1], [tiltAway * 255, tiltAway * 255, tiltAway * 255], 14, 'normals tilted away from the light are darker');
    near(c[2], [tiltToward * 255, tiltToward * 255, tiltToward * 255], 14, 'normals tilted toward the light are brighter');
    assert(c[1][0] + 40 < c[0][0] && c[0][0] + 25 < c[2][0], 'dark < flat < bright: ' + JSON.stringify(c.map((p) => Math.round(p[0]))));
    near(c[3], c[0], 4, 'normalTexture scale 0 shades like the flat quad');
    const mapShades = [c[0][0], c[1][0], c[2][0]];
    // a lone map with the default scale: nothing has set the scale uniform before it
    writeScene({ objects: [placed(SPEC.mapped, 0, -5, 1.6)], light: SLANT });
    await enter();
    c = await sample([left(0, -5), right(0, -5)]);
    assert(c[0][0] + 40 < c[1][0], 'a lone normal map at the default scale already shades the two halves differently: ' + JSON.stringify(c.map((p) => Math.round(p[0]))));
    console.log('PASS: normal map darkens (' + Math.round(mapShades[1]) + ') and brightens (' + Math.round(mapShades[2]) + ') around the flat shade (' + Math.round(mapShades[0]) + '); scale 0 changes nothing');

    // ---------------------------------------------------------------- 4
    console.log('STEP 4: without UVs or normals a model shades as if it had no normal map');
    writeScene({ objects: [placed(SPEC.plainNoUv, -3, -5, 1.4), placed(SPEC.mappedNoUv, -1, -5, 1.4), placed(SPEC.plainNoNormals, 1, -5, 1.4), placed(SPEC.mappedNoNormals, 3, -5, 1.4), placed(SPEC.flat, 0, -9, 1.4)], light: SLANT });
    await enter();
    c = await sample([centre(-3, -5, 1.4), centre(-1, -5, 1.4), centre(1, -5, 1.4), centre(3, -5, 1.4), centre(0, -9, 1.4)]);
    near(c[1], c[0], 1.5, 'no UVs: the normal texture changes nothing');
    near(c[3], c[2], 1.5, 'no normals: the normal texture changes nothing');
    near(c[0], c[4], 4, 'no UVs: shades like the plain model with normals');
    assert(c[2][0] < c[4][0] - 15, 'no normals: the fallback up-normal is what both normal-less quads use (' + Math.round(c[2][0]) + ' vs ' + Math.round(c[4][0]) + ')');
    assert(warnings.some((w) => /normalTexture/.test(w)), 'a console warning names the normal map that could not be used; got ' + JSON.stringify(warnings));
    console.log('PASS: the models still load and render; the normal map is dropped with a warning');

    // ---------------------------------------------------------------- 5
    console.log('STEP 5: alpha MASK cuts pixels out (and they write no depth); OPAQUE ignores alpha');
    const MAGENTA = [255, 0, 255], RED = [255, 0, 0], GREEN = [0, 255, 0], BLUE = [0, 0, 255], YELLOW = [255, 255, 0];
    // each masked quad is drawn BEFORE the magenta quad behind it: if cut-out pixels wrote depth they would hide it
    const maskScene = [
      ['m25', SPEC.maskBands(0.25, 'MASK'), -3.2], ['m50', SPEC.maskBands(0.5, 'MASK'), -1.0], ['m90', SPEC.maskBands(0.9, 'MASK'), 1.2], ['op', SPEC.maskBands(0.5, 'OPAQUE'), 3.4]
    ];
    const objects = [];
    maskScene.forEach(([, name, x]) => objects.push(placed(name, x, -5, 2)));
    maskScene.forEach(([, , x]) => objects.push(placed(SPEC.magenta, x, -6.5, 4.5)));
    writeScene({ objects, light: FULL });
    await enter();
    const bandPoints = (x) => [[x - 0.67, 1, -5], [x, 1, -5], [x + 0.67, 1, -5]];
    c = await sample([].concat(...maskScene.map(([, , x]) => bandPoints(x))));
    const expectBands = [
      [MAGENTA, GREEN, BLUE], // cutoff 0.25: alpha 30 (0.12) cut out, 120 (0.47) and 220 (0.86) kept
      [MAGENTA, MAGENTA, BLUE], // cutoff 0.5: only 220 kept
      [MAGENTA, MAGENTA, MAGENTA], // cutoff 0.9: everything cut out
      [RED, GREEN, BLUE] // OPAQUE: alpha ignored
    ];
    expectBands.forEach((row, i) => row.forEach((want, j) => near(c[i * 3 + j], want, 6, maskScene[i][0] + ' band ' + j)));
    console.log('PASS: alphaCutoff 0.25 / 0.5 / 0.9 keep the bands above it; cut-out pixels show the quad behind; OPAQUE shows every band');
    writeScene({
      objects: [placed(SPEC.maskFactor(0.3, 'MASK'), -2.4, -5, 1.6), placed(SPEC.maskFactor(0.8, 'MASK'), 0, -5, 1.6), placed(SPEC.maskFactor(0.3, 'OPAQUE'), 2.4, -5, 1.6), placed(SPEC.magenta, -2.4, -6.5, 3), placed(SPEC.magenta, 0, -6.5, 3), placed(SPEC.magenta, 2.4, -6.5, 3)],
      light: FULL
    });
    await enter();
    c = await sample([centre(-2.4, -5, 1.6), centre(0, -5, 1.6), centre(2.4, -5, 1.6)]);
    near(c[0], MAGENTA, 6, 'MASK with baseColorFactor alpha 0.3 is cut out');
    near(c[1], YELLOW, 6, 'MASK with baseColorFactor alpha 0.8 is kept, fully opaque');
    assert(c[2][0] > 249 && c[2][1] > 249 && c[2][2] < 40, 'OPAQUE does not cut the pixel out for a baseColorFactor alpha of 0.3 (it still draws yellow, as before): ' + JSON.stringify(c[2].map(Math.round)));
    console.log('PASS: baseColorFactor alpha is tested against the cutoff too');

    // ---------------------------------------------------------------- 6
    console.log('STEP 6: scene fog');
    const FOG = { color: '#ff00ff', near: 8, far: 20 };
    const fogObjects = [placed(SPEC.red, -1.6, -4, 1.6), placed(SPEC.green, 0.8, -14, 3), placed(SPEC.blue, 9, -30, 6)];
    const fogPoints = [centre(-1.6, -4, 1.6), centre(0.8, -14, 3), centre(9, -30, 6)];
    writeScene({ objects: fogObjects, light: FULL });
    await enter();
    assert((await frame.evaluate(() => window.__atlasActive3D.getSceneFog())) === null, 'no fog is active when the scene declares none');
    c = await sample(fogPoints);
    near(c[0], RED, 4, 'no fog: near quad'); near(c[1], GREEN, 4, 'no fog: middle quad'); near(c[2], BLUE, 4, 'no fog: far quad');
    console.log('PASS: fog is off by default (colours come out as authored at every distance)');
    for (const bad of [{ color: '#ff00ff', near: 20, far: 8 }, { color: 'magenta', near: 8, far: 20 }, { color: '#ff00ff', near: 8 }]) {
      writeScene({ objects: fogObjects, light: FULL, fog: bad });
      await enter();
      assert((await frame.evaluate(() => window.__atlasActive3D.getSceneFog())) === null, 'invalid fog ' + JSON.stringify(bad) + ' is ignored');
      assert(warnings.some((w) => /fog/.test(w)), 'invalid fog is warned about');
      c = await sample(fogPoints);
      near(c[2], BLUE, 4, 'invalid fog leaves the far quad alone');
    }
    console.log('PASS: invalid fog declarations are ignored with a warning and the scene renders normally');
    writeScene({ objects: fogObjects, light: FULL, fog: FOG });
    await enter();
    const active = await frame.evaluate(() => window.__atlasActive3D.getSceneFog());
    assert(active && active.near === 8 && active.far === 20 && active.color[0] === 1 && active.color[1] === 0, 'the valid fog is active: ' + JSON.stringify(active));
    c = await sample(fogPoints);
    const fade = (colour, x, y, z) => { const d = Math.hypot(x, y - 1.6, z), f = Math.min(1, Math.max(0, (d - FOG.near) / (FOG.far - FOG.near))); return colour.map((v, i) => v * (1 - f) + MAGENTA[i] * f); };
    near(c[0], RED, 4, 'inside `near` nothing is fogged');
    near(c[1], fade(GREEN, 0.8, 1.5, -14), 12, 'between near and far the colour is a linear blend with the fog colour');
    assert(c[1][0] > 60 && c[1][0] < 200 && c[1][1] > 60 && c[1][1] < 200, 'the middle quad really is a mix: ' + JSON.stringify(c[1].map(Math.round)));
    near(c[2], MAGENTA, 4, 'beyond `far` everything is the fog colour');
    console.log('PASS: fog fades linearly from near (' + FOG.near + ') to far (' + FOG.far + '), middle quad [' + c[1].map(Math.round) + ']');

    console.log('STEP 6b: item drops are fogged the same way');
    const dropUrl = 'http://' + DOMAIN + '/assets/material-test/' + SPEC.unlitCube + '.glb';
    const dropAt = (x, z) => ({ dropId: 'd' + x + '_' + z, position: [x, 0, z], radius: 0.9, model: dropUrl, domain: DOMAIN, credential: { id: 'c' + x + z, issuer: { domain: DOMAIN }, asset: { class: 'test.cube', name: 'Cube' } } });
    for (const withFog of [false, true]) {
      writeScene({ objects: [], light: FULL, ...(withFog ? { fog: { color: '#ff00ff', near: 5, far: 7 } } : {}) });
      await enter();
      await frame.evaluate((d) => window.__atlasActive3D.setItemDrops(d), [dropAt(0, -6)]);
      await frame.waitForFunction(() => window.__atlasActive3D.getItemDropRenderKind('d0_-6') === 'model', null, { timeout: 8000 });
      await sleep(500);
      c = await sample([[0, 0.15, -6]]); // the 0.5 m drop floats 0.15 m up, centred on its position
      if (withFog) near(c[0], [128, 128, 128], 30, 'the dropped item at 6 m is halfway into the fog (green mixed with magenta)');
      else near(c[0], [0, 255, 0], 12, 'without fog the dropped item is its own green');
    }
    console.log('PASS: item drops fade into the fog with the rest of the world');

    // ---------------------------------------------------------------- 7
    console.log('STEP 7: unlit materials ignore the light; lit ones do not');
    writeScene({ objects: [placed(SPEC.lit, -2.4, -5, 1.6), placed(SPEC.unlit, 0, -5, 1.6), placed(SPEC.unlitGlow, 2.4, -5, 1.6)], light: LIGHT_OFF });
    await enter();
    c = await sample([centre(-2.4, -5, 1.6), centre(0, -5, 1.6), centre(2.4, -5, 1.6)]);
    near(c[0], [10, 5, 3], 4, 'the lit quad is at the 5% ambient');
    near(c[1], [204, 102, 51], 4, 'the unlit quad shows its base colour as authored');
    near(c[2], [204, 102, 51], 4, 'emissive does not apply to an unlit material');
    console.log('PASS: KHR_materials_unlit shows the base colour with the light off; lit models stay dark');

    // ---------------------------------------------------------------- 8
    console.log('STEP 8: flat and textured models shade by the same formula as before');
    writeScene({ objects: [placed(SPEC.lit, -1.4, -5, 1.6), placed(SPEC.texturedLit, 1.4, -5, 1.6)], light: { ambient: 0.55, direction: [-0.45, -1, -0.35] } });
    await enter();
    const len = Math.hypot(0.45, 1, 0.35), light = 0.55 + (0.35 / len) * (1 - 0.55);
    c = await sample([centre(-1.4, -5, 1.6), [1.4 - 0.4, 1.2, -5], [1.4 + 0.4, 0.4, -5]]);
    near(c[0], [204 * light, 102 * light, 51 * light], 4, 'flat colour = baseColorFactor x light');
    near(c[1], [220 * light, 40 * light, 40 * light], 4, 'texture colour = texel x light (top-left quadrant)');
    near(c[2], [240 * light, 210 * light, 40 * light], 4, 'texture colour = texel x light (bottom-right quadrant)');
    console.log('PASS: light = ambient + diffuse x (1 - ambient); colour = (factor x texel) x light, unchanged');

    // ---------------------------------------------------------------- 9
    console.log('STEP 9: GPU textures are counted per image and released');
    writeScene({ objects: [placed(SPEC.threeImages, -1.5, -5, 1.6)], light: FULL });
    await enter();
    let live = await tex.live();
    assert(live === 4, 'a model with three different images has 3 textures + the shared fallback live, got ' + live);
    writeScene({ objects: [placed(SPEC.sharedImage, -1.5, -5, 1.6), placed(SPEC.sharedImage, 1.5, -5, 1.6)], light: FULL });
    await enter();
    live = await tex.live();
    assert(live === 2, 'one image used for all three slots (twice placed) is uploaded once: 1 texture + the fallback, got ' + live);
    writeScene({ objects: [placed(SPEC.glowTexCorrupt, 0, -5, 1.6), placed(SPEC.mappedNoUv, 2, -5, 1.6)], light: FULL });
    await enter();
    live = await tex.live();
    assert(live === 1, 'unusable textures create nothing: only the fallback is live, got ' + live);
    writeScene({ objects: [placed(SPEC.threeImages, -1.5, -5, 1.6), placed(SPEC.glowTex, 1.5, -5, 1.6)], light: FULL });
    await enter();
    assert((await tex.live()) === 5, 'three + two textures + the fallback');
    await frame.evaluate(() => window.__atlasActive3D.destroy());
    live = await tex.live();
    assert(live === 0, 'destroy() deletes every texture, emissive and normal included, got ' + live);
    console.log('PASS: 3 images -> 3 textures, a shared image -> 1, unusable images -> none; 0 live GL textures after destroy()');

    assert(pageErrors.length === 0, 'no uncaught page errors: ' + pageErrors.join(' | '));
    console.log('\nALL MATERIAL WORLD CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    if (context) await context.close();
    serverProc.kill();
    for (const d of [DOCROOT_DIR, STATE_DIR, PROFILE_DIR]) fs.rmSync(d, { recursive: true, force: true });
  }
})();
