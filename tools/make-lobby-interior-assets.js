#!/usr/bin/env node
// Generates the Lobby interior material assets into
// demo-domain-a/assets/lobby/interior/ and keeps the Lobby scene pointing at them.
// Everything is procedural and deterministic: the textures are drawn here,
// encoded as PNG and embedded in each GLB (no external files).
//
// What is made (all use only what the gltf-mini-v1 renderer supports, see
// docs/gltf-mini-materials.md):
//   lobbyFloor.glb          one stone-tile floor quad laid just above the scene
//                           floor inside the building (base colour + normal map)
//   wall*.glb               interior-only copies of the four wall models: the
//                           interior (+z) face gets a plaster texture with a baked
//                           baseboard and a normal map; the exterior face, the
//                           window frames and the bounds are untouched, so the
//                           building looks the same from outside and collides the same
//   desk, bookcase*, cabinetTelevision, tableCoffee, tableRound
//                           the same props with a wood-grain texture and normal
//                           map on their wood material (geometry unchanged)
//   computerScreen, televisionModern
//                           the screen glass gets an emissive display texture
//   lampRoundTable, lampSquareTable, lampRoundFloor
//                           a faint emissive glow on the lamp shade
//   lobbyPlaque.glb         a small unlit wall plaque
//
// Usage: node tools/make-lobby-interior-assets.js [--scene] [--check]
//   (no flag)  write the models
//   --scene    also point the Lobby scene.json at them (idempotent)
//   --check    verify the models and the scene are current, write nothing

const fs = require('fs');
const path = require('path');
const { buildMultiGlb, assembleGlb } = require('./lib/glb-builder');
const { makePngRgb } = require('./lib/png-rgb');
const { parseGlb, flattenGlb, projectTriangles } = require('./lib/glb-read');
const { hash, mod, noise, clamp01, mixRgb, scaleRgb, FONT, Mesh } = require('./lib/procedural');
const W = require('./lib/lobby-town-layout');

const REPO = path.resolve(__dirname, '..');
const FURNITURE_DIR = path.join(REPO, 'demo-domain-a', 'assets', 'furniture');
const OUT_DIR = path.join(REPO, 'demo-domain-a', 'assets', 'lobby', 'interior');
const SCENE_PATH = path.join(REPO, 'demo-domain-a', 'spatial', 'lobby', 'scene.json');
const URL_DIR = '/assets/lobby/interior/';

const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const px = (c) => [Math.round(Math.max(0, Math.min(255, c[0]))), Math.round(Math.max(0, Math.min(255, c[1]))), Math.round(Math.max(0, Math.min(255, c[2])))];

// Normal-map channels are stored in steps of 4: finer steps cost file size and are invisible here.
const q4 = (v) => Math.round(v / 4) * 4;
const encodeNormal = (nx, ny) => { const l = Math.hypot(nx, ny, 1); return px([q4((nx / l * 0.5 + 0.5) * 255), q4((ny / l * 0.5 + 0.5) * 255), q4((1 / l * 0.5 + 0.5) * 255)]); };

// A tangent-space normal map from a periodic height function h(x, y) over a
// size x size image. Green is "up" in the image (decreasing row), as in glTF.
function normalMap(size, h, strength) {
  return makePngRgb(size, size, (x, y) => {
    const nx = (h(mod(x - 1, size), y) - h(mod(x + 1, size), y)) * strength;
    const ny = (h(x, mod(y + 1, size)) - h(x, mod(y - 1, size))) * strength;
    return encodeNormal(nx, ny);
  });
}

// ---------- floor: warm flagstone, 0.8 m tiles in a running bond ----------
// The image covers 3.2 m x 3.2 m (4 x 4 tiles) and tiles seamlessly.

const FLOOR_METRES = 3.2;

function floorTile(S, T, x, y) {
  const row = Math.floor(y / T), off = (row % 2) * (T / 2);
  const sx = mod(x - off, S);
  const col = Math.floor(sx / T), lx = sx % T, ly = y % T;
  return { col, row, d: Math.min(lx, T - 1 - lx, ly, T - 1 - ly) };
}

function floorAlbedo() {
  const S = 1024, T = 256, G = 4;
  return makePngRgb(S, S, (x, y) => {
    const { col, row, d } = floorTile(S, T, x, y);
    const tone = 0.95 + 0.08 * hash(col, row, 3);
    const warm = hash(col, row, 4) - 0.5;
    let c = [202 * tone + warm * 8, 180 * tone + warm * 4, 148 * tone - warm * 6];
    const m = noise(x / 64, y / 64, 11, 16, 16) - 0.5;
    const f = noise(x / 16, y / 16, 12, 64, 64) - 0.5;
    c = scaleRgb(c, (1 + m * 0.09 + f * 0.05) * (0.955 + 0.045 * smoothstep(G, G + 22, d)));
    const grout = smoothstep(G + 1.5, G - 1.5, d);
    return px(mixRgb(c, scaleRgb([164, 143, 118], 1 + f * 0.12), grout));
  });
}

function floorNormal() {
  const S = 512, T = 128, G = 2;
  const h = (x, y) => {
    const { d } = floorTile(S, T, mod(x, S), mod(y, S));
    return smoothstep(G, G + 7, d) + 0.10 * (noise(x / 8, y / 8, 21, 64, 64) - 0.5);
  };
  return normalMap(S, h, 3.2);
}

// ---------- walls: plaster with a baked walnut baseboard ----------
// The image covers one wall segment (1 unit of the model = 1.6 m wide) and the
// full wall height (1.2895 units = 2.06 m). Seamless across segments.

const WALL_HEIGHT = 1.28953171;
const BASEBOARD = 0.058; // fraction of the wall height (about 12 cm)

function wallAlbedo() {
  const S = 512, base = Math.round(S * BASEBOARD);
  return makePngRgb(S, S, (x, y) => {
    const t = y / S;
    const m = noise(x / 128, y / 128, 31, 4, 0) - 0.5;
    const f = noise(x / 32, y / 32, 32, 16, 0) - 0.5;
    const streak = noise(x / 256, y / 5, 33, 2, 0) - 0.5;
    if (y >= S - base) {
      const by = y - (S - base);
      const grain = noise(x / 128, y / 3, 34, 4, 0) - 0.5;
      let c = scaleRgb([122, 88, 60], 1 + grain * 0.2 + f * 0.05);
      if (by < 3) c = mixRgb(c, [168, 128, 92], 0.55 - by * 0.15);
      return px(c);
    }
    let c = mixRgb([255, 242, 216], [246, 224, 190], Math.pow(t, 1.5));
    c = scaleRgb(c, 1 + m * 0.05 + f * 0.03 + streak * 0.025);
    if (y >= S - base - 3) c = scaleRgb(c, 0.9 + 0.03 * (S - base - y)); // shadow line above the baseboard
    return px(c);
  });
}

function wallNormal() {
  const S = 256, base = Math.round(S * BASEBOARD);
  const h = (x, y) => 0.25 * smoothstep(S - base - 0.5, S - base + 1.5, y) // the board stands proud of the plaster
    + 0.14 * (noise(x / 16, y / 16, 36, 16, 0) - 0.5);
  return makePngRgb(S, S, (x, y) => {
    const nx = (h(mod(x - 1, S), y) - h(mod(x + 1, S), y)) * 4;
    const ny = (h(x, Math.min(S - 1, y + 1)) - h(x, Math.max(0, y - 1))) * 4;
    return encodeNormal(nx, ny);
  });
}

// ---------- wood grain, 128 px per 0.4 m, near-white so the model's own wood colour shows ----------

const WOOD_METRES = 0.4;

const grain = (x, y) => {
  const w = noise(x / 32, y / 32, 41, 4, 4) - 0.5;
  return 0.6 * noise(x / 64 + w * 0.6, y / 2, 42, 2, 64) + 0.4 * noise(x / 32 + w * 0.4, y, 43, 4, 128);
};
const woodAlbedo = () => makePngRgb(128, 128, (x, y) => { const v = 255 * (0.86 + 0.2 * grain(x, y)); return px([v, v, v]); });
const woodNormal = () => normalMap(128, grain, 2.2);

// ---------- screen: a small emissive desktop ----------

function screenImage() {
  const W2 = 256, H2 = 128;
  return makePngRgb(W2, H2, (x, y) => {
    let c = mixRgb([10, 24, 44], [22, 58, 92], clamp01(x / W2 * 0.5 + (1 - y / H2) * 0.5));
    if (y < 12) c = [34, 78, 120];
    const inRect = (x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
    const edge = (x0, y0, x1, y1) => inRect(x0, y0, x1, y1) && !inRect(x0 + 1, y0 + 1, x1 - 1, y1 - 1);
    if (inRect(14, 24, 150, 108)) c = [28, 44, 66];
    if (inRect(14, 24, 150, 32)) c = [50, 100, 150];
    if (edge(14, 24, 150, 108)) c = [70, 130, 180];
    for (let i = 0; i < 6; i++) {
      const len = 50 + Math.floor(hash(i, 0, 51) * 70);
      if (inRect(22, 40 + i * 10, 22 + len, 43 + i * 10)) c = [120, 170, 210];
    }
    if (inRect(160, 24, 242, 64)) c = [24, 70, 70];
    if (edge(160, 24, 242, 64)) c = [80, 190, 170];
    for (let i = 0; i < 5; i++) {
      const bh = 8 + Math.floor(hash(i, 1, 52) * 22);
      if (inRect(170 + i * 14, 58 - bh, 178 + i * 14, 58)) c = [110, 220, 190];
    }
    return px(c);
  });
}

// ---------- plaque: gold lettering on walnut (drawn unlit) ----------

function plaqueImage(text) {
  const Wp = 256, Hp = 64, scale = 7, cols = text.length * 6 - 1;
  const x0 = Math.floor((Wp - cols * scale) / 2), y0 = Math.floor((Hp - 7 * scale) / 2);
  for (const ch of text) if (!FONT[ch]) throw new Error('Plaque font has no glyph for ' + JSON.stringify(ch));
  return makePngRgb(Wp, Hp, (x, y) => {
    let c = scaleRgb([74, 52, 36], 1 + (noise(x / 64, y / 2, 61, 4, 32) - 0.5) * 0.25);
    const inset = Math.min(x, Wp - 1 - x, y, Hp - 1 - y);
    if (inset >= 3 && inset < 5) c = [190, 152, 84];
    const gx = Math.floor((x - x0) / scale), gy = Math.floor((y - y0) / scale);
    if (gx >= 0 && gy >= 0 && gy < 7 && gx < cols && gx % 6 !== 5) {
      const glyph = FONT[text[Math.floor(gx / 6)]];
      if (glyph[gy][gx % 6] === '#') c = [238, 200, 116];
    }
    return px(c);
  });
}

// ---------- model builders ----------

const png = (bytes) => ({ bytes, mimeType: 'image/png' });
const LIGHT_REPEAT = { wrapS: 10497, wrapT: 10497 };

// Texture sets are built once; the same Buffer is reused so a model embeds each image once.
let cache = null;
function textures() {
  if (cache) return cache;
  cache = {
    floor: png(floorAlbedo()), floorN: png(floorNormal()),
    wall: png(wallAlbedo()), wallN: png(wallNormal()),
    wood: png(woodAlbedo()), woodN: png(woodNormal()),
    screen: png(screenImage()),
    plaque: png(plaqueImage('LOBBY'))
  };
  return cache;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

// Wall interior face: u along the segment (one image per model unit), v down the wall.
// Only the faces turned toward +z (the room) are textured: the segment ends and
// door reveals stay as they were, so the building looks the same from outside.
function wallUv(p) {
  return [p[0], 1 - p[1] / WALL_HEIGHT];
}

// Wood: project each triangle on its own plane with the grain along the longest
// direction of the piece, without mirroring (u x v points against the surface normal).
function woodUv(p, _faceNormal, tri) {
  const n = unit(tri.normals[0].map((v, i) => v + tri.normals[1][i] + tri.normals[2][i]));
  const ext = [0, 1, 2].map((c) => Math.max(...tri.points.map((q) => q[c])) - Math.min(...tri.points.map((q) => q[c])));
  const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let best = -1, bestExt = -1;
  axes.forEach((a, i) => { if (Math.abs(dot(a, n)) < 0.7 && ext[i] > bestExt) { best = i; bestExt = ext[i]; } });
  if (best < 0) best = [0, 1, 2].sort((i, j) => Math.abs(n[i]) - Math.abs(n[j]))[0];
  const a = unit(axes[best].map((v, i) => v - n[i] * dot(axes[best], n)));
  const v = cross(n.map((c) => -c), a);
  return [dot(a, p) / WOOD_METRES, dot(v, p) / WOOD_METRES];
}

// Screen glass quad: image across the quad's bounds, upright.
function screenUvFor(prim) {
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (let i = 0; i < prim.positions.length; i += 3) for (let k = 0; k < 2; k++) { lo[k] = Math.min(lo[k], prim.positions[i + k]); hi[k] = Math.max(hi[k], prim.positions[i + k]); }
  return (p) => [(p[0] - lo[0]) / (hi[0] - lo[0]), 1 - (p[1] - lo[1]) / (hi[1] - lo[1])];
}

// Re-emits a bundled model: every material is kept as it was, and the materials
// named in `rules` get UVs and the extra material fields. A rule with `where`
// (a test on the triangle's unit normal and its centre point) textures only those triangles, as a
// new primitive called `rule.name`; the rest keep the original material untouched.
// A material may have a list of rules: each takes its triangles from what the
// earlier ones left. `srcDir` is where the bundled model lives.
function retextured(file, rules, srcDir) {
  const prims = flattenGlb(path.join(srcDir || FURNITURE_DIR, file));
  const specs = [];
  for (const p of prims) {
    const src = p.material;
    const material = { baseColorFactor: (src.pbrMetallicRoughness && src.pbrMetallicRoughness.baseColorFactor) || [1, 1, 1, 1] };
    if (src.alphaMode) material.alphaMode = src.alphaMode;
    const list = [].concat(rules[src.name] || []);
    if (!list.length) { specs.push({ name: src.name, material, positions: p.positions, normals: p.normals, indices: p.indices }); continue; }
    let rest = p;
    const done = [];
    for (const rule of list) {
      if (!rest) break;
      let textured = rest;
      if (rule.where) {
        const pick = [], other = [];
        for (let t = 0; t < rest.indices.length; t += 3) {
          const n = [0, 1, 2].map((c) => [0, 1, 2].reduce((sum, k) => sum + rest.normals[rest.indices[t + k] * 3 + c], 0));
          const centre = [0, 1, 2].map((c) => [0, 1, 2].reduce((sum, k) => sum + rest.positions[rest.indices[t + k] * 3 + c], 0) / 3);
          (rule.where(unit(n), centre) ? pick : other).push(rest.indices[t], rest.indices[t + 1], rest.indices[t + 2]);
        }
        textured = { ...rest, indices: pick };
        rest = other.length ? { ...rest, indices: other } : null;
      } else rest = null;
      if (textured.indices.length) done.push({ rule, textured });
    }
    if (rest) specs.push({ name: src.name, material, positions: rest.positions, normals: rest.normals, indices: rest.indices });
    for (const { rule, textured } of done) specs.push({ name: rule.name || src.name, material: { ...material, ...rule.material }, ...projectTriangles(textured, rule.uv(textured)) });
  }
  return buildMultiGlb({ name: path.basename(file, '.glb'), primitives: specs });
}

function wallModel(file) {
  const t = textures();
  return retextured(file, {
    _defaultMat: { name: 'plaster', where: (n) => n[2] > 0.5, uv: () => wallUv, material: { texture: { ...t.wall, sampler: LIGHT_REPEAT }, normalTexture: { ...t.wallN, sampler: LIGHT_REPEAT, scale: 0.5 } } }
  });
}

function woodModel(file) {
  const t = textures();
  return retextured(file, {
    wood: { uv: () => woodUv, material: { texture: { ...t.wood, sampler: LIGHT_REPEAT }, normalTexture: { ...t.woodN, sampler: LIGHT_REPEAT, scale: 0.5 } } }
  });
}

function screenModel(file) {
  const t = textures();
  return retextured(file, {
    metal: { uv: (prim) => screenUvFor(prim), material: { baseColorFactor: [0.03, 0.04, 0.06, 1], emissiveFactor: [0.9, 0.9, 0.9], emissiveTexture: { ...t.screen, sampler: { wrapS: 33071, wrapT: 33071 } } } }
  });
}

// The lamp shade keeps its model; only its material gains a soft emissive colour.
function lampModel(file) {
  const { json, bin } = parseGlb(fs.readFileSync(path.join(FURNITURE_DIR, file)));
  const shade = json.materials.find((m) => m.name === 'lamp');
  if (!shade) throw new Error(file + ' has no lamp material');
  shade.emissiveFactor = [0.28, 0.22, 0.08];
  return assembleGlb(json, bin);
}

function floorModel() {
  const t = textures();
  const x = W.HOLE.maxX, z = W.HOLE.maxZ, y = 0.004; // under the rugs (1 cm) and above the scene floor
  const m = new Mesh();
  const corners = [[-x, y, -z], [-x, y, z], [x, y, z], [x, y, -z]];
  m.quad(corners, [0, 1, 0], corners.map((c) => [c[0] / FLOOR_METRES, c[2] / FLOOR_METRES]));
  return buildMultiGlb({ name: 'lobbyFloor', primitives: [m.spec('floor', { texture: { ...t.floor, sampler: LIGHT_REPEAT }, normalTexture: { ...t.floorN, sampler: LIGHT_REPEAT, scale: 0.4 } })] });
}

function plaqueModel() {
  const t = textures();
  const w = 0.45, h = 0.26, d = 0.02;
  const frame = new Mesh();
  const wall = (c, n) => frame.quad(c, n, c.map(() => [0, 0]));
  wall([[-w, 0, d], [w, 0, d], [w, h, d], [-w, h, d]], [0, 0, 1]);
  wall([[-w, h, d], [w, h, d], [w, h, 0], [-w, h, 0]], [0, 1, 0]);
  wall([[-w, 0, 0], [w, 0, 0], [w, 0, d], [-w, 0, d]], [0, -1, 0]);
  wall([[-w, 0, 0], [-w, 0, d], [-w, h, d], [-w, h, 0]], [-1, 0, 0]);
  wall([[w, 0, d], [w, 0, 0], [w, h, 0], [w, h, d]], [1, 0, 0]);
  const face = new Mesh(), iw = w - 0.03, ih = h - 0.03, z = d + 0.001;
  face.quad([[-iw, 0.03, z], [iw, 0.03, z], [iw, ih, z], [-iw, ih, z]], [0, 0, 1], [[0, 1], [1, 1], [1, 0], [0, 0]]);
  return buildMultiGlb({
    name: 'lobbyPlaque',
    primitives: [frame.spec('frame', { baseColorFactor: [0.27, 0.19, 0.12, 1] }), face.spec('face', { texture: { ...t.plaque, sampler: { wrapS: 33071, wrapT: 33071 } }, unlit: true })]
  });
}

// ---------- the model list and the scene ----------

const WALLS = ['wall', 'wallWindow', 'wallDoorway', 'wallDoorwayWide'];
const WOODEN = ['desk', 'bookcaseClosedWide', 'bookcaseOpen', 'cabinetTelevision', 'tableCoffee', 'tableRound'];
const SCREENS = ['computerScreen', 'televisionModern'];
const LAMPS = ['lampRoundTable', 'lampSquareTable', 'lampRoundFloor'];

function allModels() {
  const out = {};
  out.lobbyFloor = floorModel();
  out.lobbyPlaque = plaqueModel();
  WALLS.forEach((n) => { out[n] = wallModel(n + '.glb'); });
  WOODEN.forEach((n) => { out[n] = woodModel(n + '.glb'); });
  SCREENS.forEach((n) => { out[n] = screenModel(n + '.glb'); });
  LAMPS.forEach((n) => { out[n] = lampModel(n + '.glb'); });
  return out;
}

// The bundled furniture models the Lobby scene swaps for their interior versions.
const SWAPPED = [...WALLS, ...WOODEN, ...SCREENS, ...LAMPS];

// New objects (the floor sits among the interior pieces, the plaque on the north wall).
const NEW_OBJECTS = [
  { model: URL_DIR + 'lobbyFloor.glb', position: [0, 0, 0], rotationY: 0, solid: false },
  { model: URL_DIR + 'lobbyPlaque.glb', position: [-0.4, 1.3, -5.51], rotationY: 0, solid: false }
];
const objectLine = (o) => '    { ' + Object.entries(o).map(([k, v]) => '"' + k + '": ' + (Array.isArray(v) ? JSON.stringify(v).replace(/,/g, ', ') : JSON.stringify(v))).join(', ') + ' },';

// Rewrites the scene text: swapped models point at the interior versions and the
// two new objects follow the last interior rug. Returns the new text.
function sceneText(text) {
  let out = text;
  for (const name of SWAPPED) out = out.split('"/assets/furniture/' + name + '.glb"').join('"' + URL_DIR + name + '.glb"');
  const lines = out.split('\n');
  const have = (o) => lines.some((l) => l.includes('"model": "' + o.model + '"'));
  const anchor = lines.findIndex((l) => l.includes('"/assets/furniture/rugRectangle.glb"') && l.includes('"scale": 2.4'));
  if (anchor < 0) throw new Error('scene.json: the last interior rug was not found');
  const missing = NEW_OBJECTS.filter((o) => !have(o));
  lines.splice(anchor + 1, 0, ...missing.map((o) => objectLine({ model: o.model, position: o.position, rotationY: o.rotationY, solid: o.solid })));
  return lines.join('\n');
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
  if (check) { if (stale) process.exit(1); console.log('lobby interior assets and scene are current'); }
}

if (require.main === module) main();
module.exports = { SWAPPED, WALLS, WOODEN, SCREENS, LAMPS, NEW_OBJECTS, URL_DIR, allModels, sceneText, retextured, textures, wallUv, woodUv, WALL_HEIGHT, LIGHT_REPEAT, encodeNormal, normalMap, smoothstep, px };
