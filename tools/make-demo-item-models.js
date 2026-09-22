#!/usr/bin/env node
// Generates the compass/ring/trophy demo item models and thumbnails:
// simple, original low-poly shapes (cylinders, a torus, an octahedron
// gem) composed and baked directly into GLB files with plain Node — no
// modeling tool, no downloaded mesh data, replacing the previously-
// downloaded third-party models these classes used before.
//
// It reuses two techniques already proven out elsewhere in this project:
//  - GLB container assembly (buildGLB) matches
//    test/manual-3d-gltf-node-matrix.js's own helper exactly (12-byte
//    header + JSON chunk padded with spaces + BIN chunk padded with zero
//    bytes, per the GLB 2.0 spec).
//  - Flat shading via non-indexed, per-triangle-normal geometry: every
//    triangle gets its own 3 duplicated vertices and a normal computed
//    from the triangle itself (normalize(cross(b-a, c-a))) rather than a
//    shared/smoothed vertex normal. That sidesteps needing an analytical
//    normal formula for the curved primitives (cylinder/torus) — it's
//    correct for any shape as long as triangles are wound consistently
//    counter-clockwise as viewed from outside, and it matches the
//    faceted, low-poly look this project's other primitives already have.
//    gltf-mini.js's shader also has no UV/texture support at all (see its
//    own header comment) — only per-material baseColorFactor — so flat,
//    solid-colored faces are the ONLY kind of material this renderer can
//    show correctly anyway.
//
// Usage: node tools/make-demo-item-models.js
// Regenerates demo-domain-a/assets/{compass,ring,trophy}.{glb,png} in
// place. Requires Playwright + the sandboxed Chromium build for the
// thumbnail-rendering step (reuses gltf-mini.js's own previewModel(), the
// same renderer the wallet's Asset Viewer uses, so a thumbnail is always
// pixel-faithful to what the model actually looks like in-app).

const fs = require('fs');
const path = require('path');

const ASSETS_DIR = path.resolve(__dirname, '..', 'demo-domain-a', 'assets');

// ---------- vec3 helpers ----------

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}
function length(a) { return Math.hypot(a[0], a[1], a[2]); }
function normalize(a) {
  const len = length(a);
  return len > 0 ? [a[0] / len, a[1] / len, a[2] / len] : [0, 1, 0];
}

// ---------- part transform (scale -> rotateX -> rotateY -> rotateZ -> translate) ----------
//
// Deliberately does NOT transform precomputed normals — see the header
// comment above. Each primitive generator below returns triangles in its
// own local space; composePart() transforms the raw positions only, and
// the mesh builder recomputes each triangle's flat normal AFTER the
// transform, so this is correct even under non-uniform scale (which would
// otherwise need an inverse-transpose normal matrix) with zero extra math.

function makeTransform(opts) {
  opts = opts || {};
  const s = opts.scale || [1, 1, 1];
  const rx = ((opts.rotateX || 0) * Math.PI) / 180;
  const ry = ((opts.rotateY || 0) * Math.PI) / 180;
  const rz = ((opts.rotateZ || 0) * Math.PI) / 180;
  const t = opts.translate || [0, 0, 0];
  return function (p) {
    let x = p[0] * s[0], y = p[1] * s[1], z = p[2] * s[2];
    if (rx) { const c = Math.cos(rx), sn = Math.sin(rx); const y2 = y * c - z * sn, z2 = y * sn + z * c; y = y2; z = z2; }
    if (ry) { const c = Math.cos(ry), sn = Math.sin(ry); const x2 = x * c + z * sn, z2 = -x * sn + z * c; x = x2; z = z2; }
    if (rz) { const c = Math.cos(rz), sn = Math.sin(rz); const x2 = x * c - y * sn, y2 = x * sn + y * c; x = x2; y = y2; }
    return [x + t[0], y + t[1], z + t[2]];
  };
}

// ---------- mesh builder ----------
//
// Groups triangles by material color (one glTF primitive/material per
// group) into flat, non-indexed position/normal arrays. gltf-mini.js's
// extractPrimitives() falls back to gl.drawArrays() whenever a primitive
// has no `indices` (see its own comment: "indexCount: ... (prim.positions
// .length / 3)"), so non-indexed triangle soup is a fully supported,
// first-class shape for this renderer, not a workaround.
function createMeshBuilder() {
  const groups = new Map(); // "r,g,b,a" -> { color, positions:number[], normals:number[] }

  function groupFor(color) {
    const key = color.join(',');
    let g = groups.get(key);
    if (!g) { g = { color, positions: [], normals: [] }; groups.set(key, g); }
    return g;
  }

  function addTri(color, a, b, c) {
    const n = normalize(cross(sub(b, a), sub(c, a)));
    const g = groupFor(color);
    [a, b, c].forEach((p) => {
      g.positions.push(p[0], p[1], p[2]);
      g.normals.push(n[0], n[1], n[2]);
    });
  }

  // Adds one procedurally-generated part: `trisLocal` is an array of
  // [a,b,c] triangles (each a [x,y,z] point) in the primitive's own local
  // space, `color` is a [r,g,b,a] baseColorFactor, `transformOpts` places
  // it in the model's shared local space (see makeTransform above).
  function addPart(trisLocal, color, transformOpts) {
    const xf = makeTransform(transformOpts);
    trisLocal.forEach(([a, b, c]) => addTri(color, xf(a), xf(b), xf(c)));
  }

  return { addPart, groups };
}

// ---------- primitive generators ----------
//
// All winding orders below were derived and numerically verified by hand
// (cross-product sign checks against the expected outward direction for
// several sample vertices/octants of each shape) before being written
// here — see the project notes for the worked examples. Every generator
// returns an array of [a,b,c] triangles in local space, ready for
// createMeshBuilder().addPart().

// A cylinder/cone/frustum: radius rb at y=-h/2, radius rt at y=+h/2, n
// sides around the Y axis. rb=0 or rt=0 degenerates one end to a point
// (a cone); rb===rt gives a straight cylinder. Caps are skipped
// automatically when the corresponding radius is 0 (a zero-area cap would
// just waste two degenerate triangles).
function cylinder(rb, rt, h, n, opts) {
  opts = opts || {};
  const capBottom = opts.capBottom !== false;
  const capTop = opts.capTop !== false;
  const tris = [];
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = ((i + 1) / n) * Math.PI * 2;
    const b0 = [rb * Math.cos(a0), -h / 2, rb * Math.sin(a0)];
    const b1 = [rb * Math.cos(a1), -h / 2, rb * Math.sin(a1)];
    const t0 = [rt * Math.cos(a0), h / 2, rt * Math.sin(a0)];
    const t1 = [rt * Math.cos(a1), h / 2, rt * Math.sin(a1)];
    // Side wall — two triangles per segment, wound so cross(edge1,edge2)
    // points radially outward (verified against a 4-segment square case).
    tris.push([b0, t1, b1]);
    tris.push([b0, t0, t1]);
    if (capBottom && rb > 0) tris.push([[0, -h / 2, 0], b0, b1]); // outward normal -Y
    if (capTop && rt > 0) tris.push([[0, h / 2, 0], t1, t0]); // outward normal +Y
  }
  return tris;
}

// An axis-aligned box, half-extents hx/hy/hz, centered on the origin.
function box(hx, hy, hz) {
  const tris = [];
  function quad(a, b, c, d) { tris.push([a, b, c]); tris.push([a, c, d]); }
  quad([hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], [hx, -hy, hz]); // +X
  quad([-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], [-hx, -hy, -hz]); // -X
  quad([-hx, hy, -hz], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz]); // +Y
  quad([-hx, -hy, hz], [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz]); // -Y
  quad([-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]); // +Z
  quad([hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]); // -Z
  return tris;
}

// A torus lying flat (hole/through-axis = Y, tube traces a circle of
// radius R in the XZ plane, tube radius r), M segments around the big
// circle, N around the tube's own cross-section.
function torus(R, r, M, N) {
  const tris = [];
  function P(u, v) {
    const ring = R + r * Math.cos(v);
    return [ring * Math.cos(u), r * Math.sin(v), ring * Math.sin(u)];
  }
  for (let i = 0; i < M; i++) {
    const u0 = (i / M) * Math.PI * 2, u1 = ((i + 1) / M) * Math.PI * 2;
    for (let j = 0; j < N; j++) {
      const v0 = (j / N) * Math.PI * 2, v1 = ((j + 1) / N) * Math.PI * 2;
      const p00 = P(u0, v0), p10 = P(u1, v0), p11 = P(u1, v1), p01 = P(u0, v1);
      // Wound so the normal trends toward the outward (u,v) direction —
      // verified numerically against the analytical torus normal
      // (cos v cos u, sin v, cos v sin u) for a sample quad.
      tris.push([p00, p11, p10]);
      tris.push([p00, p01, p11]);
    }
  }
  return tris;
}

// A regular octahedron (6 vertices on the axes at distance s, 8
// triangular faces) — used as a faceted gem. Non-uniform scale via
// composePart's transform stretches it into a pointed jewel shape.
function octahedron(s) {
  const Xp = [s, 0, 0], Xn = [-s, 0, 0];
  const Yp = [0, s, 0], Yn = [0, -s, 0];
  const Zp = [0, 0, s], Zn = [0, 0, -s];
  const tris = [];
  [1, -1].forEach((sx) => [1, -1].forEach((sy) => [1, -1].forEach((sz) => {
    const Xs = sx > 0 ? Xp : Xn, Ys = sy > 0 ? Yp : Yn, Zs = sz > 0 ? Zp : Zn;
    const negCount = [sx, sy, sz].filter((v) => v < 0).length;
    // Even parity keeps (Xs,Ys,Zs); odd parity swaps the last two to flip
    // the winding — each sign flip is a mirror, which reverses winding, so
    // the flip has to alternate with parity (verified for two sample
    // octants against the expected (sx,sy,sz) outward normal direction).
    tris.push(negCount % 2 === 0 ? [Xs, Ys, Zs] : [Xs, Zs, Ys]);
  })));
  return tris;
}

// ---------- GLB assembly ----------

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; }

// Matches test/manual-3d-gltf-node-matrix.js's own buildGLB() exactly —
// see that file for the byte-for-byte GLB 2.0 container layout this
// implements (12-byte header, JSON chunk padded with spaces, BIN chunk
// padded with zero bytes).
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

// Turns a mesh builder's color groups into a complete, single-node,
// single-mesh GLB: one primitive (and one material) per color group, all
// sharing one binary buffer. Every primitive is non-indexed (drawArrays)
// and carries POSITION + NORMAL only — no UVs, no textures, matching
// gltf-mini.js's own narrow supported subset exactly.
function buildGLBFromMesh(mesh) {
  const bufferChunks = [];
  let byteOffset = 0;
  const bufferViews = [];
  const accessors = [];
  const materials = [];
  const primitives = [];

  for (const g of mesh.groups.values()) {
    const positions = new Float32Array(g.positions);
    const normals = new Float32Array(g.normals);
    const vertexCount = positions.length / 3;

    const posBuf = Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength);
    const posMin = [Infinity, Infinity, Infinity];
    const posMax = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertexCount; i++) {
      for (let c = 0; c < 3; c++) {
        const v = positions[i * 3 + c];
        if (v < posMin[c]) posMin[c] = v;
        if (v > posMax[c]) posMax[c] = v;
      }
    }
    bufferChunks.push(posBuf);
    const posViewIndex = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: posBuf.length });
    byteOffset += posBuf.length; // always a multiple of 4 (12 bytes/vertex)
    const posAccessorIndex = accessors.length;
    accessors.push({
      bufferView: posViewIndex, componentType: 5126, count: vertexCount, type: 'VEC3',
      min: posMin, max: posMax
    });

    const normBuf = Buffer.from(normals.buffer, normals.byteOffset, normals.byteLength);
    bufferChunks.push(normBuf);
    const normViewIndex = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: normBuf.length });
    byteOffset += normBuf.length;
    const normAccessorIndex = accessors.length;
    accessors.push({ bufferView: normViewIndex, componentType: 5126, count: vertexCount, type: 'VEC3' });

    const materialIndex = materials.length;
    materials.push({
      name: 'color-' + materialIndex,
      pbrMetallicRoughness: { baseColorFactor: g.color, metallicFactor: 0.15, roughnessFactor: 0.55 }
    });

    primitives.push({
      attributes: { POSITION: posAccessorIndex, NORMAL: normAccessorIndex },
      material: materialIndex
    });
  }

  const bin = Buffer.concat(bufferChunks);
  const json = {
    asset: { version: '2.0', generator: 'domain-atlas make-demo-item-models.js (original, procedurally generated, license-free)' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives }],
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }]
  };
  return buildGLB(json, bin);
}

// ---------- item compositions ----------

const BRONZE = [0.72, 0.47, 0.22, 1];
const DARK_BRONZE = [0.42, 0.26, 0.12, 1];
const NEEDLE_RED = [0.82, 0.16, 0.11, 1];
const NEEDLE_CREAM = [0.92, 0.9, 0.84, 1];
const PIN_GRAY = [0.25, 0.25, 0.27, 1];
const GOLD = [0.95, 0.78, 0.25, 1];
const GEM_BLUE = [0.15, 0.45, 0.9, 1];
const TROPHY_BLACK = [0.09, 0.09, 0.1, 1];

function buildCompass() {
  const mesh = createMeshBuilder();
  // Case: a flat bronze disc.
  mesh.addPart(cylinder(1.0, 1.0, 0.22, 20), BRONZE, {});
  // Rim: a darker bezel ring set into the case's top edge.
  mesh.addPart(torus(0.93, 0.09, 20, 8), DARK_BRONZE, { translate: [0, 0.09, 0] });
  // Needle: two elongated, flattened diamonds (octahedra) meeting at the
  // center pin — red pointing one way, cream the other, the classic
  // compass-needle look.
  mesh.addPart(octahedron(1), NEEDLE_RED, { scale: [0.11, 0.045, 0.4], translate: [0, 0.15, 0.2] });
  mesh.addPart(octahedron(1), NEEDLE_CREAM, { scale: [0.11, 0.045, 0.4], translate: [0, 0.15, -0.2] });
  // Center pin covering the needle's seam.
  mesh.addPart(cylinder(0.06, 0.06, 0.06, 10), PIN_GRAY, { translate: [0, 0.15, 0] });
  return mesh;
}

function buildRing() {
  const mesh = createMeshBuilder();
  // Band: a flat gold torus.
  mesh.addPart(torus(0.55, 0.14, 18, 10), GOLD, {});
  // Gem: a tall, pointed blue octahedron set on top of the band.
  mesh.addPart(octahedron(1), GEM_BLUE, { scale: [0.18, 0.24, 0.18], translate: [0.55, 0.2, 0] });
  return mesh;
}

function buildTrophy() {
  const mesh = createMeshBuilder();
  // Stacked bottom-up: a near-black base, a thin gold stem, and a gold
  // cup that flares outward toward its open top — then the whole stack is
  // re-centered on Y so it floats/spins in place like the other dropped
  // items (see gltf-mini.js's itemDropEntries spin/bob animation, which
  // rotates every model around its own local origin).
  const baseH = 0.16, stemH = 0.5, cupH = 0.5;
  const baseY = baseH / 2;
  const stemY = baseH + stemH / 2;
  const cupY = baseH + stemH + cupH / 2;
  const totalH = baseH + stemH + cupH;
  const centerY = totalH / 2;

  mesh.addPart(cylinder(0.5, 0.44, baseH, 14), TROPHY_BLACK, { translate: [0, baseY - centerY, 0] });
  mesh.addPart(cylinder(0.11, 0.09, stemH, 10), GOLD, { translate: [0, stemY - centerY, 0] });
  mesh.addPart(cylinder(0.28, 0.5, cupH, 14, { capTop: false }), GOLD, { translate: [0, cupY - centerY, 0] });
  return mesh;
}

// ---------- thumbnail rendering (Playwright + gltf-mini.js's own previewModel) ----------

async function renderThumbnail(glbBuffer, outPngPath) {
  const { chromium } = require('playwright');
  const gltfMiniSrc = fs.readFileSync(path.resolve(__dirname, '..', 'extension', 'gltf-mini.js'), 'utf8');
  const html = `<!doctype html><html><head><style>
    html, body { margin: 0; background: transparent; }
    canvas { display: block; background: transparent; }
  </style></head><body>
    <canvas id="c" width="256" height="256"></canvas>
    <script>${gltfMiniSrc}</script>
    <script>
      function base64ToBuffer(b64) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
      }
      // Renders and lets previewModel's own slow auto-rotate (0.006
      // rad/frame) turn the model into a nicer 3/4 view (~28 degrees)
      // before the screenshot, instead of the flat head-on angle frame 0
      // would give.
      window.__renderThumbnail = function (b64, frames) {
        const canvas = document.getElementById('c');
        window.MiniGLTF.previewModel(canvas, base64ToBuffer(b64), {});
        return new Promise((resolve) => {
          let n = 0;
          function step() { n++; if (n >= frames) resolve(); else requestAnimationFrame(step); }
          requestAnimationFrame(step);
        });
      };
    </script>
  </body></html>`;

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try {
    const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
    await page.setContent(html, { waitUntil: 'load' });
    const glbBase64 = glbBuffer.toString('base64');
    await page.evaluate(([b64, frames]) => window.__renderThumbnail(b64, frames), [glbBase64, 80]);
    await page.locator('#c').screenshot({ path: outPngPath, omitBackground: true });
  } finally {
    await browser.close();
  }
}

// ---------- main ----------

async function main() {
  const items = [
    { name: 'compass', mesh: buildCompass() },
    { name: 'ring', mesh: buildRing() },
    { name: 'trophy', mesh: buildTrophy() }
  ];

  for (const item of items) {
    const glb = buildGLBFromMesh(item.mesh);
    const glbPath = path.join(ASSETS_DIR, item.name + '.glb');
    fs.writeFileSync(glbPath, glb);
    console.log(item.name + '.glb: ' + glb.length + ' bytes (' + item.mesh.groups.size + ' material group(s))');
  }

  for (const item of items) {
    const glbPath = path.join(ASSETS_DIR, item.name + '.glb');
    const pngPath = path.join(ASSETS_DIR, item.name + '.png');
    await renderThumbnail(fs.readFileSync(glbPath), pngPath);
    console.log(item.name + '.png: ' + fs.statSync(pngPath).size + ' bytes');
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}

module.exports = { buildCompass, buildRing, buildTrophy, buildGLBFromMesh, cylinder, box, torus, octahedron };
