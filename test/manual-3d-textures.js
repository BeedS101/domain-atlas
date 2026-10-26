// Browser checks for gltf-mini-v1 base-colour textures through previewModel().
// Needs a display (run under xvfb-run); WebGL is SwiftShader.
//
// previewModel() lights the model, so absolute pixel values depend on the
// shading. Every textured render is therefore compared against an untextured
// render of the same quad with the equivalent flat colour: same geometry,
// same camera, same light, so the pixels must agree.
//
// requestAnimationFrame is replaced by a manual queue so the preview's
// auto-rotation stays at one frame (0.006 rad) when the pixels are read.
//
// Covered: PNG and JPEG quadrants, glTF UV orientation (asymmetric "L" on the
// bundled test board), baseColorFactor x texture, clamp vs repeat, a
// non-power-of-two image, malformed images falling back to the flat colour,
// untextured models (with and without UVs) rendering as before, and texture
// create/delete balance after dispose().

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JPEG_QUADS, QUADRANTS, quadrantPng, quadGlb, buildGlb, makePng, quadSpec } = require('./texture-test-lib');

const REPO = path.resolve(__dirname, '..');
const SIZE = 320;

const html = `<!doctype html><html><body style="margin:0;background:#000">
<script>${fs.readFileSync(path.join(REPO, 'extension', 'gltf-mini.js'), 'utf8')}</script>
<script>
  window.__created = 0; window.__deleted = 0; window.__warnings = [];
  const proto = WebGLRenderingContext.prototype;
  const origCreate = proto.createTexture, origDelete = proto.deleteTexture;
  proto.createTexture = function () { window.__created++; return origCreate.apply(this, arguments); };
  proto.deleteTexture = function (t) { if (t) window.__deleted++; return origDelete.apply(this, arguments); };
  const origWarn = console.warn;
  console.warn = function () { window.__warnings.push(Array.prototype.join.call(arguments, ' ')); return origWarn.apply(console, arguments); };

  const queue = [];
  window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
  window.cancelAnimationFrame = () => {};
  const step = () => { const q = queue.splice(0); q.forEach((cb) => cb(0)); };
  const toBuffer = (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; };

  // Renders one model and returns its pixels (base64 RGBA, GL row order, bottom row first).
  window.__render = async (b64, settleMs) => {
    const canvas = document.createElement('canvas');
    canvas.width = ${SIZE}; canvas.height = ${SIZE};
    document.body.appendChild(canvas);
    queue.length = 0;
    const preview = window.MiniGLTF.previewModel(canvas, toBuffer(b64), {});
    step();
    await new Promise((r) => setTimeout(r, settleMs));
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
  window.__warningCount = () => window.__warnings.length;
</script></body></html>`;

class Shot {
  constructor(b64) {
    this.px = Buffer.from(b64, 'base64');
    let minX = SIZE, maxX = -1, minY = SIZE, maxY = -1;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (this.px[(y * SIZE + x) * 4 + 3] > 200) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    assert(maxX > minX && maxY > minY, 'something must be drawn');
    this.box = { minX, maxX, minY, maxY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }
  // fx, fy in 0..1 across the drawn shape, fy = 0 at the top.
  at(fx, fy) {
    const x = Math.round(this.box.minX + fx * (this.box.w - 1));
    const glY = Math.round(this.box.maxY - fy * (this.box.h - 1)); // GL rows run bottom-up; the drawn box is measured in GL rows
    const i = (glY * SIZE + x) * 4;
    return [this.px[i], this.px[i + 1], this.px[i + 2]];
  }
}

const near = (a, b, tol, msg) => {
  for (let i = 0; i < 3; i++) assert(Math.abs(a[i] - b[i]) <= tol, `${msg}: got [${a}] expected [${b}] (tolerance ${tol})`);
};
const dominant = (c) => c.indexOf(Math.max(...c));

// Centres of the four quadrants of a quad's face.
const QUAD_POINTS = { tl: [0.25, 0.25], tr: [0.75, 0.25], bl: [0.25, 0.75], br: [0.75, 0.75] };
const flatQuad = (rgb) => buildGlb({ ...quadSpec(), baseColorFactor: [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1] });

(async () => {
  const browser = await chromium.launch({
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist']
  });
  let failed = false;
  try {
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.setContent(html);

    const render = async (glb, settleMs) => new Shot(await page.evaluate(([b, s]) => window.__render(b, s), [glb.toString('base64'), settleMs === undefined ? 700 : settleMs]));
    const warnings = () => page.evaluate(() => window.__warningCount());

    // Flat reference colours as shaded by this renderer.
    const flatRef = {};
    for (const k of Object.keys(QUADRANTS)) flatRef[k] = (await render(flatQuad(QUADRANTS[k]), 50)).at(0.5, 0.5);

    // ---- 1. PNG ----
    {
      const s = await render(quadGlb({ texture: { bytes: quadrantPng(), mimeType: 'image/png' } }));
      for (const k of Object.keys(QUAD_POINTS)) near(s.at(...QUAD_POINTS[k]), flatRef[k], 6, 'PNG quadrant ' + k);
      console.log('PASS: embedded PNG samples each quadrant in the right place (top of the image at the top of the quad)');
    }

    // ---- 2. JPEG ----
    {
      const s = await render(quadGlb({ texture: { bytes: JPEG_QUADS, mimeType: 'image/jpeg' } }));
      for (const k of Object.keys(QUAD_POINTS)) near(s.at(...QUAD_POINTS[k]), flatRef[k], 16, 'JPEG quadrant ' + k);
      console.log('PASS: embedded JPEG decodes and samples each quadrant in the right place');
    }

    // ---- 3. texture x baseColorFactor ----
    {
      const factor = [0.5, 1, 0.25, 1];
      const s = await render(quadGlb({ baseColorFactor: factor, texture: { bytes: quadrantPng(), mimeType: 'image/png' } }));
      for (const k of Object.keys(QUAD_POINTS)) {
        const q = QUADRANTS[k];
        const expected = (await render(flatQuad([q[0] * factor[0], q[1] * factor[1], q[2] * factor[2]]), 50)).at(0.5, 0.5);
        near(s.at(...QUAD_POINTS[k]), expected, 7, 'factor x texture, quadrant ' + k);
      }
      console.log('PASS: baseColorFactor multiplies the sampled texture colour');
    }

    // ---- 4. untextured models ----
    {
      const red = [200, 60, 30];
      const withUvs = await render(flatQuad(red), 50);
      const noUvs = await render(buildGlb({ positions: quadSpec().positions, normals: quadSpec().normals, indices: quadSpec().indices, baseColorFactor: [200 / 255, 60 / 255, 30 / 255, 1] }), 50);
      near(withUvs.at(0.5, 0.5), noUvs.at(0.5, 0.5), 1, 'UVs without a texture change nothing');
      for (const fp of [[0.1, 0.1], [0.9, 0.9], [0.5, 0.5]]) near(noUvs.at(...fp), withUvs.at(...fp), 1, 'flat colour is uniform');
      assert(dominant(noUvs.at(0.5, 0.5)) === 0, 'flat red stays red');
      console.log('PASS: untextured models render their flat colour, with or without TEXCOORD_0');
    }

    // ---- 5. glTF UV orientation on the bundled test board ----
    {
      const board = fs.readFileSync(path.join(REPO, 'demo-domain-a', 'assets', 'texture-test', 'textureTestBoard.glb'));
      const s = await render(board);
      // Colour quadrants of the 16x16 image.
      assert.strictEqual(dominant(s.at(0.75, 0.25)), 1, 'top-right is green');
      assert.strictEqual(dominant(s.at(0.25, 0.75)), 2, 'bottom-left is blue');
      const br = s.at(0.75, 0.75);
      assert(br[0] > 100 && br[1] > 100 && br[2] < br[0] / 2, 'bottom-right is yellow: ' + br);
      // Texel (x, y) of the image sits at ((x + 0.5) / 16, (y + 0.5) / 16) of the face, top-left origin.
      const texel = (x, y) => s.at((x + 0.5) / 16, (y + 0.5) / 16);
      const isWhite = (c) => c[0] > 150 && c[1] > 150 && c[2] > 150;
      const isRed = (c) => c[0] > 100 && c[1] < c[0] / 2 && c[2] < c[0] / 2;
      assert(isRed(texel(0, 0)) && isRed(texel(6, 1)), 'red field of the top-left quadrant');
      assert(isWhite(texel(2, 2)) && isWhite(texel(3, 3)), 'the L stem is on the left, starting near the top');
      assert(isWhite(texel(2, 4)) && isWhite(texel(5, 5)), 'the L foot runs along the bottom to the right');
      assert(isRed(texel(5, 2)) && isRed(texel(4, 3)), 'the inside of the L is red: not mirrored, not upside down');
      console.log('PASS: the asymmetric test board is upright and unmirrored (glTF UV origin handled correctly)');
    }

    // ---- 6. clamp vs repeat ----
    {
      const uvs = [0, 2, 2, 2, 2, 0, 0, 0];
      const rep = await render(quadGlb({ uvs, texture: { bytes: quadrantPng(), mimeType: 'image/png', sampler: { wrapS: 10497, wrapT: 10497, magFilter: 9728, minFilter: 9728 } } }));
      const clamp = await render(quadGlb({ uvs, texture: { bytes: quadrantPng(), mimeType: 'image/png', sampler: { wrapS: 33071, wrapT: 33071, magFilter: 9728, minFilter: 9728 } } }));
      // (0.625, 0.125): u = 1.25, v = 0.25 -> repeat wraps to the red quadrant; clamp holds the right-hand edge (green).
      assert.strictEqual(dominant(rep.at(0.625, 0.125)), 0, 'repeat wraps back to the red quadrant');
      assert.strictEqual(dominant(clamp.at(0.625, 0.125)), 1, 'clamp-to-edge holds the edge colour');
      console.log('PASS: sampler wrap modes (repeat, clamp-to-edge) are honoured');
    }

    // ---- 7. non-power-of-two image ----
    {
      const npot = makePng(12, 10, (x, y) => QUADRANTS[(y < 5 ? 't' : 'b') + (x < 6 ? 'l' : 'r')]);
      const s = await render(quadGlb({ texture: { bytes: npot, mimeType: 'image/png' } }));
      for (const k of Object.keys(QUAD_POINTS)) near(s.at(...QUAD_POINTS[k]), flatRef[k], 8, 'NPOT quadrant ' + k);
      console.log('PASS: a 12 x 10 image (non-power-of-two, default repeat sampler) renders correctly');
    }

    // ---- 8. malformed images fall back to the flat colour ----
    {
      const factor = [0.9, 0.3, 0.2, 1];
      const expected = (await render(flatQuad([229.5, 76.5, 51]), 50)).at(0.5, 0.5);
      const before = await warnings();
      const png = quadrantPng();
      const corrupt = Buffer.concat([png.subarray(0, 40), Buffer.alloc(20, 0xff)]); // valid signature + IHDR, broken data
      const s1 = await render(quadGlb({ baseColorFactor: factor, texture: { bytes: corrupt, mimeType: 'image/png' } }));
      near(s1.at(0.25, 0.25), expected, 3, 'corrupt PNG keeps the flat colour');
      near(s1.at(0.75, 0.75), expected, 3, 'corrupt PNG keeps the flat colour everywhere');
      const s2 = await render(quadGlb({ baseColorFactor: factor, texture: { bytes: Buffer.alloc(30, 7), mimeType: 'image/png' } }));
      near(s2.at(0.5, 0.5), expected, 3, 'garbage bytes keep the flat colour');
      const s3 = await render(quadGlb({ baseColorFactor: factor, texture: { bytes: quadrantPng(), mimeType: 'image/webp' } }));
      near(s3.at(0.5, 0.5), expected, 3, 'unsupported MIME keeps the flat colour');
      assert((await warnings()) > before, 'a console warning is logged');
      console.log('PASS: corrupt, garbage and unsupported images leave the flat colour (with a console warning) and do not break rendering');
    }

    // ---- 9. no GPU texture leaks, no page errors ----
    {
      const c = await page.evaluate(() => window.__counts());
      assert(c.created > 0 && c.created === c.deleted, `textures created (${c.created}) and deleted (${c.deleted}) must balance after dispose()`);
      assert.deepStrictEqual(pageErrors, [], 'no uncaught page errors');
      console.log(`PASS: every GL texture created (${c.created}) was deleted on dispose(); no page errors`);
    }

    console.log('\nALL TEXTURE PREVIEW CHECKS PASSED');
  } catch (err) {
    failed = true;
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
  if (failed) process.exit(1);
})();
