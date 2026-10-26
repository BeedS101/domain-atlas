// Browser checks for the Lobby's textured portal gate (townPortal.glb) through
// previewModel(). Needs a display (run under xvfb-run); WebGL is SwiftShader.
//
//   1. The GLB loads and its embedded textures render: stone, the portal
//      surface (blue/violet/cyan), the plaque (dark plate, gold lettering).
//   2. Orientation: the plaque text correlates with its own image the right
//      way round and not mirrored, flipped or rotated; the portal opening is
//      where the geometry puts it.
//   3. No page errors or texture warnings, and every GL texture created is
//      deleted on dispose().
//
// requestAnimationFrame is a manual queue so the preview stays at one frame of
// its slow auto-rotation (face-on) when the pixels are read.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..');
const GLB = fs.readFileSync(path.join(REPO, 'demo-domain-a', 'assets', 'portals', 'townPortal.glb'));
const SIZE = 640;

function embeddedImage(materialName) {
  const jsonLen = GLB.readUInt32LE(12);
  const json = JSON.parse(GLB.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  const mat = json.materials.find((m) => m.name === materialName);
  const tex = json.textures[mat.pbrMetallicRoughness.baseColorTexture.index];
  const view = json.bufferViews[json.images[tex.source].bufferView];
  return GLB.subarray(binStart + view.byteOffset, binStart + view.byteOffset + view.byteLength);
}

const html = `<!doctype html><html><body style="margin:0;background:#000">
<script>${fs.readFileSync(path.join(REPO, 'extension', 'gltf-mini.js'), 'utf8')}</script>
<script>
  window.__created = 0; window.__deleted = 0; window.__warnings = [];
  const proto = WebGLRenderingContext.prototype;
  const oc = proto.createTexture, od = proto.deleteTexture;
  proto.createTexture = function () { window.__created++; return oc.apply(this, arguments); };
  proto.deleteTexture = function (t) { if (t) window.__deleted++; return od.apply(this, arguments); };
  const ow = console.warn;
  console.warn = function () { window.__warnings.push(Array.prototype.join.call(arguments, ' ')); return ow.apply(console, arguments); };
  const queue = [];
  window.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
  window.cancelAnimationFrame = () => {};
  const step = () => { queue.splice(0).forEach((cb) => cb(0)); };
  const toBuffer = (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; };

  window.__render = async (glbB64, plaqueB64) => {
    const canvas = document.createElement('canvas');
    canvas.width = ${SIZE}; canvas.height = ${SIZE};
    document.body.appendChild(canvas);
    const preview = window.MiniGLTF.previewModel(canvas, toBuffer(glbB64), {});
    step();
    await new Promise((r) => setTimeout(r, 1500));
    step();
    const gl = canvas.getContext('webgl');
    const W = canvas.width, H = canvas.height;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // flip to top-down rows
    const rows = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) rows.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    preview.dispose();
    canvas.remove();

    // bounding box of everything drawn
    let minX = W, maxX = -1, minY = H, maxY = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (rows[(y * W + x) * 4 + 3] > 200) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    const box = { minX, maxX, minY, maxY };
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    const rgb = (fx, fy) => { const x = Math.round(minX + fx * (bw - 1)), y = Math.round(minY + fy * (bh - 1)); const i = (y * W + x) * 4; return [rows[i], rows[i + 1], rows[i + 2]]; };

    // Plaque: the dark slate plate inside its gold border. Located from the
    // render itself (plate-coloured pixels around where the plaque should be),
    // then the plate image is resampled to that rectangle for comparison.
    const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const ex0 = Math.round(minX + (0.5 - 0.7 / 1.9) * bw), ex1 = Math.round(minX + (0.5 + 0.7 / 1.9) * bw);
    const ey0 = Math.round(minY + (1 - 1.92 / 2) * bh), ey1 = Math.round(minY + (1 - 1.5 / 2) * bh);
    const isPlate = (x, y) => { const i = (y * W + x) * 4; const l = lum(rows, i); return l > 28 && l < 75 && Math.abs(rows[i + 2] - rows[i]) < 24; };
    const colCount = new Array(ex1 - ex0 + 1).fill(0), rowCount = new Array(ey1 - ey0 + 1).fill(0);
    for (let y = ey0; y <= ey1; y++) for (let x = ex0; x <= ex1; x++) if (isPlate(x, y)) { colCount[x - ex0]++; rowCount[y - ey0]++; }
    const span = (counts) => {
      const thr = 0.35 * Math.max(...counts);
      let lo = counts.findIndex((c) => c >= thr), hi = counts.length - 1 - [...counts].reverse().findIndex((c) => c >= thr);
      return [lo, hi];
    };
    const [cx0, cx1] = span(colCount), [cy0, cy1] = span(rowCount);
    const px0 = ex0 + cx0, px1 = ex0 + cx1, py0 = ey0 + cy0, py1 = ey0 + cy1;
    const rw = px1 - px0 + 1, rh = py1 - py0 + 1;
    const img = await createImageBitmap(new Blob([toBuffer(plaqueB64)], { type: 'image/png' }));
    // The lettering is compared as a coarse grid of ink density over the
    // text's own bounding box (7 glyph rows x 51 columns): tolerant of a pixel
    // or two of misregistration, but a mirrored, flipped or rotated line of
    // text produces a clearly different grid.
    const inkGrid = (data, w, h, shrink) => {
      const l = new Float64Array(w * h);
      for (let i = 0; i < w * h; i++) l[i] = lum(data, i * 4);
      const x0 = Math.floor(w * shrink), x1 = Math.ceil(w * (1 - shrink)), y0 = Math.floor(h * shrink), y1 = Math.ceil(h * (1 - shrink));
      const vals = [];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) vals.push(l[y * w + x]);
      vals.sort((a, b) => a - b);
      const lo = vals[Math.floor(vals.length * 0.1)], hi = vals[Math.floor(vals.length * 0.995)];
      const thr = lo + 0.5 * (hi - lo);
      let bx0 = w, bx1 = -1, by0 = h, by1 = -1;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (l[y * w + x] > thr) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); }
      const COLS = 51, ROWS = 7;
      const grid = new Float64Array(COLS * ROWS), cnt = new Float64Array(COLS * ROWS);
      for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
        const gc = Math.min(COLS - 1, Math.floor((x - bx0) / (bx1 - bx0 + 1) * COLS)), gr = Math.min(ROWS - 1, Math.floor((y - by0) / (by1 - by0 + 1) * ROWS));
        grid[gr * COLS + gc] += l[y * w + x] > thr ? 1 : 0; cnt[gr * COLS + gc]++;
      }
      for (let i = 0; i < grid.length; i++) grid[i] /= cnt[i] || 1;
      return { grid, COLS, ROWS, bbox: [bx0, by0, bx1, by1] };
    };
    const rc = document.createElement('canvas'); rc.width = 512 - 24; rc.height = 128 - 24;
    rc.getContext('2d').drawImage(img, 12, 12, 512 - 24, 128 - 24, 0, 0, 512 - 24, 128 - 24);
    const tmpl = inkGrid(rc.getContext('2d').getImageData(0, 0, 512 - 24, 128 - 24).data, 512 - 24, 128 - 24, 0.06);
    const rendered = new Uint8ClampedArray(rw * rh * 4);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) { const i = ((py0 + y) * W + px0 + x) * 4; rendered.set(rows.subarray(i, i + 4), (y * rw + x) * 4); }
    const rend = inkGrid(rendered, rw, rh, 0.06);
    const transform = (g, mx, my) => {
      const out = new Float64Array(g.length);
      for (let r = 0; r < tmpl.ROWS; r++) for (let c = 0; c < tmpl.COLS; c++) out[r * tmpl.COLS + c] = g[(my < 0 ? tmpl.ROWS - 1 - r : r) * tmpl.COLS + (mx < 0 ? tmpl.COLS - 1 - c : c)];
      return out;
    };
    const ncc = (a, b) => {
      let n = a.length, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; sab += a[i] * b[i]; }
      return (sab - sa * sb / n) / Math.sqrt((saa - sa * sa / n) * (sbb - sb * sb / n) || 1);
    };
    const best = {};
    for (const [name, mx, my] of [['normal', 1, 1], ['mirrored', -1, 1], ['flipped', 1, -1], ['rotated', -1, -1]]) best[name] = ncc(transform(tmpl.grid, mx, my), rend.grid);
    best.plate = [rw, rh];
    return { box, best, samples: {
      portalCentre: rgb(0.5, 0.52), portalUpper: rgb(0.5, 0.36), portalLeft: rgb(0.38, 0.6), portalRight: rgb(0.62, 0.6),
      lintel: rgb(0.5, 0.05), base: rgb(0.5, 0.985)
    } };
  };
  window.__counts = () => ({ created: window.__created, deleted: window.__deleted, warnings: window.__warnings.slice() });
</script></body></html>`;

(async () => {
  const browser = await chromium.launch({
    headless: false,
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist']
  });
  try {
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setContent(html);

    const r = await page.evaluate(([g, p]) => window.__render(g, p), [GLB.toString('base64'), embeddedImage('plaque').toString('base64')]);
    const w = r.box.maxX - r.box.minX + 1, h = r.box.maxY - r.box.minY + 1;
    console.log('rendered gate box', JSON.stringify(r.box), 'samples', JSON.stringify(r.samples), 'plaque grid correlation', JSON.stringify(r.best));

    // ---- 1. textures render ----
    assert(w > 250 && h > 250, 'the gate is drawn, got ' + w + 'x' + h);
    const s = r.samples;
    const isBlueViolet = (c) => c[2] > 90 && c[2] > c[0] + 15 && c[2] > c[1] - 5;
    ['portalCentre', 'portalUpper', 'portalLeft', 'portalRight'].forEach((k) => assert(isBlueViolet(s[k]), k + ' must be the blue/violet/cyan portal texture, got ' + s[k]));
    const isStone = (c) => c[0] > 70 && c[0] >= c[1] && c[1] >= c[2] && c[0] - c[2] > 25;
    ['lintel', 'base'].forEach((k) => assert(isStone(s[k]), k + ' must be warm stone, got ' + s[k]));
    console.log('PASS: embedded textures render: stone on the frame, blue/violet portal surface in the opening');

    // ---- 2. orientation ----
    assert(r.best.normal > 0.7, 'plaque lettering should match its image, correlation ' + r.best.normal);
    ['mirrored', 'flipped', 'rotated'].forEach((k) => assert(r.best.normal > r.best[k] + 0.15, 'plaque matches the upright image (' + r.best.normal.toFixed(2) + ') clearly better than the ' + k + ' one (' + r.best[k].toFixed(2) + ')'));
    console.log('PASS: the plaque is upright and unmirrored (ink correlation ' + r.best.normal.toFixed(2) + ' vs mirrored ' + r.best.mirrored.toFixed(2) + ', flipped ' + r.best.flipped.toFixed(2) + ')');

    // ---- 3. clean ----
    const c = await page.evaluate(() => window.__counts());
    assert(errors.length === 0, 'no page errors: ' + errors.join(' | '));
    assert(!c.warnings.some((m) => /texture|image/i.test(m)), 'no texture warnings: ' + c.warnings.join(' | '));
    assert(c.created > 0 && c.created === c.deleted, 'GL textures created (' + c.created + ') and deleted (' + c.deleted + ') balance');
    console.log('PASS: no page errors or texture warnings; ' + c.created + ' GL textures created, all deleted on dispose()');

    console.log('\nALL TOWN PORTAL PREVIEW CHECKS PASSED');
  } catch (err) {
    console.error('FAILURE:', err);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
