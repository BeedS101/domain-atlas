// previewModel() (Asset Viewer hover panel) with the optional material features
// of gltf-mini-v1. Needs a display (run under xvfb-run); WebGL is SwiftShader.
//
// previewModel() has its own light, so shaded surfaces are compared with the
// same quad rendered without the feature; unlit and emissive-on-black surfaces
// have exact expected colours. requestAnimationFrame is a manual queue.
//
// Covered: emissiveFactor, emissiveTexture, unlit, normalTexture (and the
// no-UV fallback), alphaMode MASK with alphaCutoff, and texture create/delete
// balance after dispose().

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { buildMultiGlb, makePng, quadSpec } = require(path.join(__dirname, '..', 'tools', 'lib', 'glb-builder'));

const REPO = path.resolve(__dirname, '..');
const SIZE = 320;

const html = `<!doctype html><html><body style="margin:0;background:#000">
<script>${fs.readFileSync(path.join(REPO, 'extension', 'gltf-mini.js'), 'utf8')}</script>
<script>
  window.__created = 0; window.__deleted = 0;
  const proto = WebGLRenderingContext.prototype;
  const origCreate = proto.createTexture, origDelete = proto.deleteTexture;
  proto.createTexture = function () { window.__created++; return origCreate.apply(this, arguments); };
  proto.deleteTexture = function (t) { if (t) window.__deleted++; return origDelete.apply(this, arguments); };
  const queue = [];
  window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
  window.cancelAnimationFrame = () => {};
  const step = () => { const q = queue.splice(0); q.forEach((cb) => cb(0)); };
  const toBuffer = (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; };
  window.__render = async (b64) => {
    const canvas = document.createElement('canvas');
    canvas.width = ${SIZE}; canvas.height = ${SIZE};
    document.body.appendChild(canvas);
    queue.length = 0;
    const preview = window.MiniGLTF.previewModel(canvas, toBuffer(b64), {});
    step();
    await new Promise((r) => setTimeout(r, 600));
    step();
    const gl = canvas.getContext('webgl');
    const px = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = '';
    for (let i = 0; i < px.length; i += 0x8000) s += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000));
    preview.dispose();
    canvas.remove();
    return btoa(s);
  };
  window.__counts = () => ({ created: window.__created, deleted: window.__deleted });
</script></body></html>`;

class Shot {
  constructor(b64, box) {
    this.px = Buffer.from(b64, 'base64');
    if (box) { this.box = box; return; }
    let minX = SIZE, maxX = -1, minY = SIZE, maxY = -1;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      if (this.px[(y * SIZE + x) * 4 + 3] > 200) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    assert(maxX > minX && maxY > minY, 'something must be drawn');
    this.box = { minX, maxX, minY, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }
  // fx, fy in 0..1 across the drawn quad, fy = 0 at the top; returns [r, g, b, a].
  at(fx, fy) {
    const x = Math.round(this.box.minX + fx * (this.box.w - 1));
    const glY = Math.round(this.box.maxY - fy * (this.box.h - 1));
    const i = (glY * SIZE + x) * 4;
    return [this.px[i], this.px[i + 1], this.px[i + 2], this.px[i + 3]];
  }
}
const near = (a, b, tol, msg) => { for (let i = 0; i < 3; i++) assert(Math.abs(a[i] - b[i]) <= tol, `${msg}: got [${a.slice(0, 3)}] expected [${b}] (tolerance ${tol})`); };
const quad = (material, geometry) => buildMultiGlb({ primitives: [{ ...quadSpec(), ...(geometry || {}), material }] });
const png = (w, h, fn) => ({ bytes: makePng(w, h, fn), mimeType: 'image/png' });
const halves = (l, r) => png(16, 16, (x) => (x < 8 ? l : r));

(async () => {
  const browser = await chromium.launch({ headless: false, executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  let failed = false;
  try {
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.setContent(html);
    const render = async (glb, box) => new Shot(await page.evaluate((b) => window.__render(b), glb.toString('base64')), box);

    const plain = await render(quad({}));
    const box = plain.box; // the quad outline, used for models that cut pixels out

    // 1. emissiveFactor on a black material: exactly the emissive colour.
    near((await render(quad({ baseColorFactor: [0, 0, 0, 1], emissiveFactor: [0, 1, 0] }))).at(0.5, 0.5), [0, 255, 0], 3, 'emissiveFactor');
    near((await render(quad({ baseColorFactor: [0, 0, 0, 1], emissiveFactor: [0.5, 0.5, 0.5] }))).at(0.5, 0.5), [128, 128, 128], 4, 'half emissive');
    console.log('PASS: emissiveFactor adds its colour');

    // 2. emissiveTexture: halves red/blue; a corrupt texture leaves the black material black.
    const et = await render(quad({ baseColorFactor: [0, 0, 0, 1], emissiveFactor: [1, 1, 1], emissiveTexture: halves([255, 0, 0, 255], [0, 0, 255, 255]) }));
    near(et.at(0.25, 0.5), [255, 0, 0], 4, 'emissive texture left'); near(et.at(0.75, 0.5), [0, 0, 255], 4, 'emissive texture right');
    const corrupt = { bytes: Buffer.alloc(30, 7), mimeType: 'image/png' };
    near((await render(quad({ baseColorFactor: [0, 0, 0, 1], emissiveFactor: [1, 1, 1], emissiveTexture: corrupt }))).at(0.5, 0.5), [0, 0, 0], 2, 'corrupt emissive texture');
    console.log('PASS: emissiveTexture colours the glow; a corrupt one is non-emissive');

    // 3. unlit: base colour as authored.
    near((await render(quad({ baseColorFactor: [0.8, 0.4, 0.2, 1], unlit: true }))).at(0.5, 0.5), [204, 102, 51], 3, 'unlit');
    near((await render(quad({ baseColorFactor: [0.8, 0.4, 0.2, 1], unlit: true, emissiveFactor: [0, 1, 0] }))).at(0.5, 0.5), [204, 102, 51], 3, 'unlit ignores emissive');
    console.log('PASS: unlit shows the base colour (emissive ignored)');

    // 4. normalTexture: left half tilts one way, right half the other; no UVs -> as if without it.
    const map = halves([64, 128, 238, 255], [191, 128, 238, 255]);
    const mapped = await render(quad({ normalTexture: map }));
    const l = mapped.at(0.25, 0.5), r = mapped.at(0.75, 0.5), f = plain.at(0.5, 0.5);
    assert(Math.abs(l[0] - r[0]) > 15, `the two halves shade differently: ${l} vs ${r}`);
    assert(Math.min(l[0], r[0]) < f[0] && Math.max(l[0], r[0]) !== f[0], `the plain shade ${f} lies between or beside the mapped shades`);
    const noUv = await render(quad({ normalTexture: map }, { uvs: undefined }));
    const noUvPlain = await render(quad({}, { uvs: undefined }));
    near(noUv.at(0.5, 0.5), noUvPlain.at(0.5, 0.5), 1, 'normal map without UVs');
    console.log('PASS: normal map changes the shading; without UVs it is ignored');

    // 5. MASK: bands alpha 30 / 120 / 220 (x < 1/3, middle, right); cutoff 0.25 keeps the last two.
    const bands = png(18, 6, (x) => (x < 6 ? [255, 0, 0, 30] : x < 12 ? [0, 255, 0, 120] : [0, 0, 255, 220]));
    const masked = await render(quad({ texture: bands, alphaMode: 'MASK', alphaCutoff: 0.25 }), box);
    assert(masked.at(0.1, 0.5)[3] < 20, 'the low-alpha band is cut out: ' + masked.at(0.1, 0.5));
    assert(masked.at(0.5, 0.5)[3] > 240 && masked.at(0.5, 0.5)[1] > masked.at(0.5, 0.5)[0], 'the middle band is kept: ' + masked.at(0.5, 0.5));
    assert(masked.at(0.9, 0.5)[3] > 240 && masked.at(0.9, 0.5)[2] > masked.at(0.9, 0.5)[0], 'the high-alpha band is kept: ' + masked.at(0.9, 0.5));
    const opaque = await render(quad({ texture: bands, alphaMode: 'OPAQUE' }), box);
    assert(opaque.at(0.1, 0.5)[3] > 240 && opaque.at(0.1, 0.5)[0] > opaque.at(0.1, 0.5)[2], 'OPAQUE keeps every band: ' + opaque.at(0.1, 0.5));
    console.log('PASS: MASK cuts out pixels under alphaCutoff; OPAQUE keeps them');

    // 6. every texture created is deleted again after dispose().
    const counts = await page.evaluate(() => window.__counts());
    assert(counts.created > 0 && counts.created === counts.deleted, 'created and deleted GL textures balance: ' + JSON.stringify(counts));
    console.log('PASS: GL textures balance after dispose() (' + counts.created + ' created, ' + counts.deleted + ' deleted)');

    assert(pageErrors.length === 0, 'no uncaught page errors: ' + pageErrors.join(' | '));
    console.log('\nALL MATERIAL PREVIEW CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    failed = true;
  } finally {
    await browser.close();
  }
  if (failed) process.exit(1);
})();
