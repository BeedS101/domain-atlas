#!/usr/bin/env node
// Generates the Lobby's exterior material assets into
// demo-domain-a/assets/lobby/exterior/ and keeps the Lobby scene's wall lines
// pointing at them. Everything is procedural and deterministic: textures are
// drawn here, encoded as PNG and embedded in each GLB.
//
// Only materials change. Every model is a re-emission of a bundled one (the
// furniture wall segments, the outdoor kit) with its vertices untouched, so
// bounds, footprints and collisions are exactly those of the originals. Only
// what gltf-mini-v1 supports is used (docs/gltf-mini-materials.md).
//
//   wall, wallWindow, wallDoorway, wallDoorwayWide
//       the interior-textured wall segments (tools/make-lobby-interior-assets.js)
//       with the outer (-z) face given stucco over a stone plinth, a normal map,
//       and wood grain on the frames
//   treeSmall, treeSmallB, shrub, shrubB
//       bark and leaf textures; the variants differ only by a tint so a row of
//       trees does not repeat exactly
//   benchOutdoor, lampPost, planterBox, welcomeSign
//       wood grain, iron, concrete and soil textures; the lamp head glows faintly;
//       the sign carries its lettering
//
// Usage: node tools/make-lobby-exterior-assets.js [--scene] [--check]
//   (no flag)  write the models
//   --scene    also point the Lobby scene's walls at them (idempotent)
//   --check    verify the models and the scene walls are current, write nothing

const fs = require('fs');
const path = require('path');
const { makePngRgb } = require('./lib/png-rgb');
const { hash, mod, noise, clamp01, mixRgb, scaleRgb, FONT } = require('./lib/procedural');
const { buildMultiGlb } = require('./lib/glb-builder');
const { flattenGlb, projectTriangles } = require('./lib/glb-read');
const I = require('./make-lobby-interior-assets');

const REPO = path.resolve(__dirname, '..');
const OUTDOOR_DIR = path.join(REPO, 'demo-domain-a', 'assets', 'outdoor');
const OUT_DIR = path.join(REPO, 'demo-domain-a', 'assets', 'lobby', 'exterior');
const SCENE_PATH = path.join(REPO, 'demo-domain-a', 'spatial', 'lobby', 'scene.json');
const URL_DIR = '/assets/lobby/exterior/';

const { smoothstep, px, normalMap, encodeNormal, WALL_HEIGHT } = I;
const png = (bytes) => ({ bytes, mimeType: 'image/png' });
const REPEAT = { wrapS: 10497, wrapT: 10497 };
const CLAMP = { wrapS: 33071, wrapT: 33071 };
const q2 = (v) => Math.round(v / 2) * 2;
const px2 = (c) => px(c.map(q2));

// ---------- wall exterior: stucco over a stone plinth ----------
// One wall segment is 1.6 m wide and 2.06 m high (WALL_HEIGHT model units), so
// 256 x 320 pixels is the same scale on both axes. The image tiles seamlessly
// across segments.

const WALL_W = 256, WALL_H = 320;
const PLINTH = 0.2;               // plinth height as a fraction of the wall
const COURSE = 26, BLOCK = 64;    // plinth block height / width in pixels
const CORNICE = 0.035;

function plinthBlock(x, y) {
  const top = Math.round(WALL_H * (1 - PLINTH));
  const row = Math.floor((y - top) / COURSE);
  const off = (row % 2) * (BLOCK / 2);
  const sx = mod(x + off, WALL_W);
  const col = Math.floor(sx / BLOCK);
  const lx = sx % BLOCK, ly = (y - top) % COURSE;
  return { row, col, d: Math.min(lx, BLOCK - 1 - lx, ly, COURSE - 1 - ly), lx, ly };
}

function wallAlbedo() {
  const top = Math.round(WALL_H * (1 - PLINTH));
  const corn = Math.round(WALL_H * CORNICE);
  return makePngRgb(WALL_W, WALL_H, (x, y) => {
    const blotch = noise(x / 64, y / 64, 301, 4, 0) - 0.5;
    const grain = noise(x / 12, y / 12, 302, 22, 0) - 0.5;
    const streak = noise(x / 5, y / 90, 303, 51, 0) - 0.5;           // rain streaks running down
    if (y >= top - 2) {
      const b = plinthBlock(x, Math.max(y, top));
      const tone = 0.88 + 0.2 * hash(b.col, b.row, 311);
      let c = scaleRgb([112, 104, 94], tone * (1 + grain * 0.14 + blotch * 0.1));
      c = mixRgb(c, [78, 72, 66], clamp01((y - top) / (WALL_H - top)) * 0.4);  // darker toward the ground
      const mortar = smoothstep(2.5, 0.5, b.d);
      c = mixRgb(c, [168, 158, 142], mortar * 0.85);
      if (b.ly < 3) c = scaleRgb(c, 1.08);                              // lit upper edge of each course
      if (y < top) c = mixRgb(c, [190, 180, 164], 0.6);                 // the sill line where the plinth meets the stucco
      return px2(c);
    }
    let c = mixRgb([226, 211, 184], [214, 198, 170], clamp01(y / WALL_H * 1.3));
    c = scaleRgb(c, 1 + blotch * 0.06 + grain * 0.03 + streak * 0.05);
    const nearPlinth = clamp01((y - (top - 56)) / 56);
    c = mixRgb(c, [176, 160, 134], nearPlinth * 0.5 * (0.6 + noise(x / 20, 0, 304, 13, 0)));  // splash and damp above the plinth
    const seam = Math.min(x, WALL_W - 1 - x);
    if (seam < 2) c = scaleRgb(c, 0.9 + 0.05 * seam);                      // a faint joint between wall segments
    if (y < corn) c = mixRgb(c, [240, 230, 208], 0.5);                     // lighter cornice band
    else if (y < corn + 4) c = scaleRgb(c, 0.9 + 0.025 * (y - corn));     // the shadow it casts
    return px2(c);
  });
}

function wallNormalMap() {
  const S = 2;                          // normal map is half the albedo resolution
  const W2 = WALL_W / S, H2 = WALL_H / S;
  const top = Math.round(H2 * (1 - PLINTH));
  const corn = Math.round(H2 * CORNICE);
  const h = (x, y) => {
    if (y >= top) {
      const b = plinthBlock(x * S, Math.max(y * S, top * S));
      return 0.2 + 0.45 * smoothstep(1.5, 5, b.d) + 0.1 * (noise(x / 8, y / 8, 321, 16, 0) - 0.5);
    }
    let v = 0.55 + 0.05 * (noise(x / 14, y / 14, 323, 9, 0) - 0.5);
    if (y > top - 4) v += 0.28 * smoothstep(top - 4, top, y) - 0.1;       // the plinth steps out from the stucco
    if (y < corn) v += 0.12;
    return v;
  };
  return makePngRgbNormal(W2, H2, h, 4.5);
}

function makePngRgbNormal(w, hh, h, strength) {
  return makePngRgb(w, hh, (x, y) => {
    const nx = (h(mod(x - 1, w), y) - h(mod(x + 1, w), y)) * strength;
    const ny = (h(x, Math.min(hh - 1, y + 1)) - h(x, Math.max(0, y - 1))) * strength;
    return encodeNormal(nx, ny);
  });
}

// Exterior face: viewed from outside (looking toward +z) u grows to the viewer's
// right (-x) and v downward, so u x v points back into the wall, as for the interior face.
const wallOutsideUv = () => (p) => [1 - p[0], 1 - p[1] / WALL_HEIGHT];

// ---------- foliage, bark, iron, concrete, soil ----------

const leafTexture = () => makePngRgb(64, 64, (x, y) => {
  const a = noise(x / 8, y / 8, 401, 8, 8), b = noise(x / 3, y / 3, 402, 21, 21), c = noise(x / 16, y / 16, 403, 4, 4);
  let v = 0.84 + 0.22 * a + 0.1 * (b - 0.5) + 0.12 * (c - 0.5);
  if (b > 0.82) v += 0.1;
  else if (b < 0.18) v -= 0.1;
  return px([255 * v, 255 * v, 255 * v]);
});

const barkTexture = () => makePngRgb(64, 64, (x, y) => {
  const groove = noise(x / 3, y / 24, 411, 21, 3);
  const fine = noise(x / 2, y / 6, 412, 32, 11) - 0.5;
  let v = 0.9 + 0.14 * (noise(x / 8, y / 16, 413, 8, 4) - 0.5) + 0.12 * fine;
  if (groove < 0.3) v *= 0.7 + groove * 0.8;
  return px([255 * v, 255 * v, 255 * v]);
});

const ironTexture = () => makePngRgb(64, 64, (x, y) => {
  const m = noise(x / 10, y / 10, 421, 7, 7), f = noise(x / 2, y / 2, 422, 32, 32);
  let v = 0.9 + 0.14 * m + 0.06 * (f - 0.5);
  if (f > 0.9) v += 0.12;
  return px([255 * v, 255 * v, 255 * v]);
});

const concreteTexture = () => makePngRgb(64, 64, (x, y) => {
  const m = noise(x / 12, y / 12, 431, 5, 5), f = noise(x / 2, y / 2, 432, 32, 32);
  let v = 0.88 + 0.16 * m + 0.08 * (f - 0.5);
  if (f > 0.92) v *= 0.82;
  if (Math.abs(y - 32) < 1) v *= 0.8;                                   // a joint
  return px([255 * v, 255 * v, 255 * v]);
});

const soilTexture = () => makePngRgb(64, 64, (x, y) => {
  const m = noise(x / 6, y / 6, 441, 11, 11), f = noise(x / 2, y / 2, 442, 32, 32);
  const v = 0.78 + 0.3 * m + 0.2 * (f - 0.5);
  return px([255 * v, 255 * v, 255 * v]);
});

// "WELCOME" in dark paint on a cream board, 256 x 112.
function signImage(text) {
  const Wd = 256, H = 112;
  for (const ch of text) if (!FONT[ch]) throw new Error('Sign font has no glyph for ' + JSON.stringify(ch));
  let scale = 0;
  for (let s = 8; s >= 1; s--) if (text.length * 6 * s - s <= Wd - 32 && 7 * s <= H - 28) { scale = s; break; }
  const tw = text.length * 6 * scale - scale, th = 7 * scale;
  const ox = Math.round((Wd - tw) / 2), oy = Math.round((H - th) / 2);
  const ink = (x, y) => {
    const gx = x - ox, gy = y - oy;
    if (gx < 0 || gy < 0 || gx >= tw || gy >= th) return false;
    const col = Math.floor(gx / scale), row = Math.floor(gy / scale);
    if (col % 6 === 5) return false;
    return FONT[text[Math.floor(col / 6)]][row][col % 6] === '#';
  };
  return makePngRgb(Wd, H, (x, y) => {
    let c = mixRgb([226, 218, 196], [214, 204, 180], noise(x / 30, y / 4, 451, 9, 0));
    c = scaleRgb(c, 0.96 + 0.08 * noise(x / 3, y / 3, 452, 86, 38));
    const edge = Math.min(x, y, Wd - 1 - x, H - 1 - y);
    if (edge < 5) c = [128, 100, 70];
    else if (edge < 8) c = scaleRgb(c, 0.88);
    if (ink(x - 1, y - 1) && !ink(x, y)) c = scaleRgb(c, 0.7);
    if (ink(x, y)) c = [56, 40, 30];
    return px(c);
  });
}

// ---------- texture sets ----------

let cache = null;
function tex() {
  if (cache) return cache;
  cache = {
    wall: png(wallAlbedo()), wallN: png(wallNormalMap()),
    leaf: png(leafTexture()), bark: png(barkTexture()), iron: png(ironTexture()),
    concrete: png(concreteTexture()), soil: png(soilTexture()),
    sign: png(signImage('WELCOME'))
  };
  return cache;
}
const withSampler = (t, sampler) => ({ ...t, sampler: sampler || REPEAT });

// ---------- UVs ----------

// Planar projection of each triangle along the dominant axis of its normal; `tl` metres per image.
const planarUv = (tl) => (p, n) => {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  if (ay >= ax && ay >= az) return [p[0] / tl, p[2] / tl];
  if (ax >= az) return [p[2] / tl, -p[1] / tl];
  return [p[0] / tl, -p[1] / tl];
};
const dimmed = (base, k) => [base[0] * k[0], base[1] * k[1], base[2] * k[2], 1];
const TINTS = { A: [1, 1, 1], B: [1.16, 1.06, 0.8] };

// ---------- models ----------

function wallModel(name) {
  const t = tex(), w = I.textures();
  return I.retextured(name + '.glb', {
    _defaultMat: { name: 'plaster', where: (n) => n[2] > 0.5, uv: () => I.wallUv, material: { texture: withSampler(w.wall, I.LIGHT_REPEAT), normalTexture: { ...withSampler(w.wallN, I.LIGHT_REPEAT), scale: 0.5 } } },
    metalDark: { name: 'stucco', where: (n) => n[2] < -0.5, uv: wallOutsideUv, material: { baseColorFactor: [1, 1, 1, 1], texture: withSampler(t.wall), normalTexture: { ...withSampler(t.wallN), scale: 0.6 } } },
    wood: { uv: () => I.woodUv, material: { texture: withSampler(w.wood, I.LIGHT_REPEAT) } }
  });
}

// Each foliage/trunk material of the outdoor kit models, with a tint per variant.
function treeModel(variant) {
  const t = tex(), k = TINTS[variant];
  const mat = (src, tint, tex1, tl) => ({ uv: () => planarUv(tl), material: { baseColorFactor: dimmed(src, tint), texture: withSampler(tex1) } });
  return I.retextured('treeSmall.glb', {
    'mat-0': mat([0.39, 0.24, 0.12], [1, 1, 1], t.bark, 0.5),
    'mat-1': mat([0.16, 0.38, 0.12], k, t.leaf, 0.7),
    'mat-2': mat([0.24, 0.48, 0.18], k, t.leaf, 0.7)
  }, OUTDOOR_DIR);
}

function shrubModel(variant) {
  const t = tex(), k = TINTS[variant];
  const mat = (src) => ({ uv: () => planarUv(0.5), material: { baseColorFactor: dimmed(src, k), texture: withSampler(t.leaf) } });
  return I.retextured('shrub.glb', { 'mat-0': mat([0.16, 0.38, 0.12]), 'mat-1': mat([0.24, 0.48, 0.18]) }, OUTDOOR_DIR);
}

function benchModel() {
  const t = tex(), w = I.textures();
  return I.retextured('benchOutdoor.glb', {
    'mat-0': { uv: () => I.woodUv, material: { baseColorFactor: [0.5, 0.31, 0.16, 1], texture: withSampler(w.wood, I.LIGHT_REPEAT) } },
    'mat-1': { uv: () => planarUv(0.5), material: { texture: withSampler(t.iron) } }
  }, OUTDOOR_DIR);
}

// The lamp keeps its two primitives: the dark iron pole (with the upper part of the shade) and the warm lantern,
// which is the bulb plus the shade's triangles above 2 m, glowing faintly.
function lampModel() {
  const t = tex();
  const [pole, bulb] = flattenGlb(path.join(OUTDOOR_DIR, 'lampPost.glb'));
  const shade = { positions: bulb.positions.slice(), normals: bulb.normals.slice(), indices: bulb.indices.slice() };
  const iron = { positions: pole.positions, normals: pole.normals, indices: [] };
  for (let k = 0; k < pole.indices.length; k += 3) {
    const tri = [0, 1, 2].map((q) => pole.indices[k + q]);
    const y = tri.reduce((sum, v) => sum + pole.positions[v * 3 + 1], 0) / 3;
    if (y > 2.02) {
      const base = shade.positions.length / 3;
      tri.forEach((v) => { shade.positions.push(pole.positions[v * 3], pole.positions[v * 3 + 1], pole.positions[v * 3 + 2]); shade.normals.push(pole.normals[v * 3], pole.normals[v * 3 + 1], pole.normals[v * 3 + 2]); });
      shade.indices.push(base, base + 1, base + 2);
    } else iron.indices.push(...tri);
  }
  const ironSpec = { name: 'iron', material: { baseColorFactor: [0.18, 0.2, 0.22, 1], texture: withSampler(t.iron) }, ...projectTriangles(iron, planarUv(0.5)) };
  const lantern = { name: 'lantern', material: { baseColorFactor: [0.62, 0.5, 0.3, 1], emissiveFactor: [0.4, 0.3, 0.1] }, ...projectTriangles(shade, () => [0, 0]) };
  return buildMultiGlb({ name: 'lampPost', primitives: [ironSpec, lantern] });
}

function planterModel() {
  const t = tex(), w = I.textures();
  return I.retextured('planterBox.glb', {
    'mat-0': { uv: () => planarUv(0.6), material: { texture: withSampler(t.concrete) } },
    'mat-1': { uv: () => planarUv(0.4), material: { baseColorFactor: [0.3, 0.2, 0.12, 1], texture: withSampler(t.soil) } },
    'mat-2': { uv: () => planarUv(0.4), material: { texture: withSampler(t.leaf) } }
  }, OUTDOOR_DIR);
}

// The sign's board and posts get wood grain; its blank face plate gets the lettering.
function signModel() {
  const t = tex(), w = I.textures();
  const lettering = (prim) => {
    const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (let i = 0; i < prim.positions.length; i += 3) for (let k = 0; k < 2; k++) { lo[k] = Math.min(lo[k], prim.positions[i + k]); hi[k] = Math.max(hi[k], prim.positions[i + k]); }
    return (p) => [(p[0] - lo[0]) / (hi[0] - lo[0]), 1 - (p[1] - lo[1]) / (hi[1] - lo[1])];
  };
  return I.retextured('welcomeSign.glb', {
    'mat-0': { uv: () => I.woodUv, material: { baseColorFactor: [0.5, 0.31, 0.16, 1], texture: withSampler(w.wood, I.LIGHT_REPEAT) } },
    'mat-1': { uv: () => I.woodUv, material: { baseColorFactor: [0.3, 0.17, 0.09, 1], texture: withSampler(w.wood, I.LIGHT_REPEAT) } },
    'mat-2': { name: 'lettering', where: (n, c) => c[2] > 0.075, uv: lettering, material: { baseColorFactor: [1, 1, 1, 1], texture: withSampler(t.sign, CLAMP) } }
  }, OUTDOOR_DIR);
}

const WALLS = I.WALLS;
const TREES = { treeSmall: 'A', treeSmallB: 'B' };
const SHRUBS = { shrub: 'A', shrubB: 'B' };

function allModels() {
  const out = {};
  WALLS.forEach((n) => { out[n] = wallModel(n); });
  Object.entries(TREES).forEach(([n, v]) => { out[n] = treeModel(v); });
  Object.entries(SHRUBS).forEach(([n, v]) => { out[n] = shrubModel(v); });
  out.benchOutdoor = benchModel();
  out.lampPost = lampModel();
  out.planterBox = planterModel();
  out.welcomeSign = signModel();
  return out;
}

// ---------- the scene's walls ----------

// The interior generator points the walls at assets/lobby/interior/; this moves them on to the exterior versions.
function sceneText(text) {
  let out = text;
  for (const name of WALLS) out = out.split('"' + I.URL_DIR + name + '.glb"').join('"' + URL_DIR + name + '.glb"');
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const models = allModels();
  let stale = 0;
  for (const [name, glb] of Object.entries(models)) {
    const file = path.join(OUT_DIR, name + '.glb');
    const current = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (check) { if (!current || !current.equals(glb)) { console.error('stale: ' + path.relative(REPO, file)); stale++; } continue; }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(file, glb);
    console.log('wrote ' + path.relative(REPO, file) + ' (' + (glb.length / 1024).toFixed(1) + ' KB)');
  }
  if (check || args.includes('--scene')) {
    const text = fs.readFileSync(SCENE_PATH, 'utf8');
    const next = sceneText(text);
    if (check) { if (next !== text) { console.error('stale: ' + path.relative(REPO, SCENE_PATH)); stale++; } }
    else if (next !== text) { fs.writeFileSync(SCENE_PATH, next); console.log('updated ' + path.relative(REPO, SCENE_PATH)); }
  }
  if (check) { if (stale) process.exit(1); console.log('lobby exterior assets and scene walls are current'); }
}

if (require.main === module) main();
const allModelNames = () => Object.keys(allModels());

module.exports = { WALLS, TREES, SHRUBS, URL_DIR, OUT_DIR, allModels, allModelNames, sceneText };
