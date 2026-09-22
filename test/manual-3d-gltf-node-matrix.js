// Regression test for a real bug: a glTF node's local transform is EITHER a
// raw 16-element `matrix` OR decomposed translation/rotation/scale — never
// both, per the glTF 2.0 spec — but gltf-mini.js's walkNode() only ever
// read the TRS form, silently treating any matrix-only node as identity.
// Exported files routinely bake exactly this kind of node (often an
// axis-correction rotation, the source tool's Z-up convention into this
// app's Y-up one) as a `matrix` rather than decomposed TRS — the practical
// symptom: a model that renders with the right shape and colors, just lying
// on its side instead of standing upright, because the axis-correction
// rotation baked into an ancestor node's `matrix` was silently dropped.
//
// Rather than committing a large third-party-licensed downloaded file as a
// fixture, this builds a tiny synthetic GLB entirely in-memory: a thin,
// tall "flag" quad (0.2 wide x 2.0 tall in its own local
// space) placed under a single node whose local transform is a `matrix`
// only (a 90-degree rotation about Z, no translation/rotation/scale fields
// at all) — chosen so a correct implementation renders it WIDE and SHORT
// (rotated) while the old bug would render it TALL and THIN (the matrix
// silently ignored, drawn in its raw unrotated local orientation). Both
// orientations share the exact same bounding-box diagonal (rotation
// preserves it), so previewModel()'s own auto-fit camera frames both
// identically — meaning a plain "is the rendered shape wider than it is
// tall" pixel-bounding-box check is a clean, camera-math-independent signal
// that doesn't depend on replicating gltf-mini.js's own projection/view
// matrices in this test.
//
// No HTTP server needed — the synthetic GLB is embedded as base64 and
// gltf-mini.js's own source is inlined directly into the test page, so
// everything runs from a single self-contained HTML string.
//
// Not part of the permanent suite (test/verify*.js) — same reasoning as the
// other manual-*3d*.js files: depends on the heavier WebGL/xvfb machinery
// those already use.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; }

// Builds a minimal, valid GLB (binary glTF container) around one JSON chunk
// and one BIN chunk, padding each to a 4-byte boundary per the GLB spec
// (spaces for JSON, zero bytes for BIN) — the same container format
// gltf-mini.js's own parseGLB() reads.
function buildGLB(json, binBuffer) {
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  while (jsonBuf.length % 4 !== 0) jsonBuf = Buffer.concat([jsonBuf, Buffer.from(' ')]);
  let binBuf = Buffer.from(binBuffer);
  while (binBuf.length % 4 !== 0) binBuf = Buffer.concat([binBuf, Buffer.from([0])]);

  const jsonChunk = Buffer.concat([u32(jsonBuf.length), Buffer.from('JSON', 'ascii'), jsonBuf]);
  const binChunk = Buffer.concat([u32(binBuf.length), Buffer.from('BIN\0', 'ascii'), binBuf]);
  const totalLength = 12 + jsonChunk.length + binChunk.length;
  const header = Buffer.concat([Buffer.from('glTF', 'ascii'), u32(2), u32(totalLength)]);
  return Buffer.concat([header, jsonChunk, binChunk]);
}

// A thin (X: -0.1..0.1), tall (Y: -1..1) flag, two triangles, no indices —
// drawn directly via drawArrays, so no SCALAR index accessor is needed.
function buildFlagGLB() {
  const verts = new Float32Array([
    -0.1, -1, 0, 0.1, -1, 0, 0.1, 1, 0, // triangle 1
    -0.1, -1, 0, 0.1, 1, 0, -0.1, 1, 0  // triangle 2
  ]);
  const bin = Buffer.from(verts.buffer);

  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    // The node under test: a `matrix`-only local transform (a 90-degree
    // rotation about Z, column-major per the glTF/mat4 convention this
    // file already uses elsewhere: [cos,sin,0,0, -sin,cos,0,0, 0,0,1,0,
    // 0,0,0,1], cos(90)=0/sin(90)=1) — deliberately NO translation/
    // rotation/scale fields, so a loader that only reads TRS treats this
    // as identity (the exact bug).
    nodes: [{ mesh: 0, matrix: [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{
      bufferView: 0, componentType: 5126, count: 6, type: 'VEC3',
      min: [-0.1, -1, 0], max: [0.1, 1, 0]
    }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length }]
  };

  return buildGLB(json, bin);
}

(async () => {
  const glb = buildFlagGLB();
  const glbBase64 = glb.toString('base64');
  const gltfMiniSrc = fs.readFileSync(path.join(__dirname, '..', 'extension', 'gltf-mini.js'), 'utf8');

  const html = `<!doctype html><html><body style="margin:0;">
    <canvas id="c" width="300" height="300"></canvas>
    <script>${gltfMiniSrc}</script>
    <script>
      function base64ToBuffer(b64) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
      }
      window.__runPreview = function (b64) {
        const canvas = document.getElementById('c');
        const buffer = base64ToBuffer(b64);
        window.MiniGLTF.previewModel(canvas, buffer, {});
        // Resolve on the FIRST rendered frame, before previewModel's own
        // slow auto-rotate (0.006 rad/frame) has moved the model enough to
        // matter — this keeps the flag's bounding box in this test purely
        // a function of the node transform under test, not incidental
        // camera-relative spin.
        return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
          const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
          const w = canvas.width, h = canvas.height;
          const pixels = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          // Background is cleared to alpha 0 (previewModel's gl.clearColor(0,0,0,0));
          // every drawn triangle pixel has alpha 255 (or a partial value only at
          // an antialiased edge) — alpha alone cleanly separates "flag" from
          // "background" regardless of the flag's actual shaded color.
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, litCount = 0;
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const a = pixels[(y * w + x) * 4 + 3];
              if (a > 20) {
                litCount++;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }
          resolve({ litCount, width: maxX - minX, height: maxY - minY });
        })));
      };
    </script>
  </body></html>`;

  const browser = await chromium.launch({
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist']
  });
  try {
    const page = await browser.newPage({ viewport: { width: 320, height: 320 } });
    page.on('pageerror', (err) => console.log('PAGEERROR:', String(err)));
    await page.setContent(html);

    console.log('STEP 1: render a synthetic "flag" GLB whose only node uses a `matrix` (90deg rotation about Z), no translation/rotation/scale fields');
    const result = await page.evaluate((b64) => window.__runPreview(b64), glbBase64);
    console.log('  rendered pixel bounds:', JSON.stringify(result));
    if (result.litCount < 50) throw new Error('Expected a visibly rendered shape (enough lit pixels to measure), got only ' + result.litCount + ' — the model may have failed to render at all');

    console.log('STEP 2: the flag is authored 0.2 wide x 2.0 tall in its own local space — a correct `matrix` node transform (this fix) rotates it 90deg, so it should render WIDER than it is TALL. The old bug (matrix silently ignored) would render it in its raw local orientation instead: TALL and THIN.');
    if (result.width <= result.height) {
      throw new Error(
        'Expected the rendered flag to be wider than tall (width=' + result.width + ', height=' + result.height + ') proving the node\'s `matrix` rotation was applied. ' +
        'Got the opposite (or equal) — this is the exact regression this test exists to catch: walkNode() ignoring `node.matrix` and treating the node as identity, ' +
        'leaving the flag in its raw unrotated (tall) local orientation, same as the real trophy.glb rendering sideways instead of upright.'
      );
    }
    // A healthy margin, not just width > height by one pixel — the true
    // geometric ratio is 10:1 (2.0 / 0.2) before any perspective/pitch
    // foreshortening, so a real pass should be dramatically wider, not
    // marginally so.
    if (result.width < result.height * 2) {
      throw new Error('Expected a dramatically wider-than-tall shape (roughly 10:1 before perspective foreshortening), got width=' + result.width + ' height=' + result.height + ' — narrower a margin than expected for a correct 90deg rotation');
    }
    console.log('PASS: rendered wide and short (width=' + result.width + ', height=' + result.height + ') — the `matrix`-only node\'s rotation was applied correctly');

    console.log('\nALL GLTF NODE-MATRIX CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
