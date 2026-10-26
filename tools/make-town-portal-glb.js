#!/usr/bin/env node
// Generates demo-domain-a/assets/portals/townPortal.glb: a low-poly stone
// travel gate for the Lobby's exit portal. Everything is original and made in
// this script: the textures are drawn procedurally, encoded as PNG and
// embedded in the GLB (no external files, no absolute paths), and the output
// is deterministic.
//
// Model space: metres, origin at the centre of the base, y up, the front of
// the gate faces +z (scene `rotationY` 0 faces +z). The gate is 1.9 wide and
// 2.0 tall; the walk-through opening is 1.0 wide and about 1.4 tall.
//
// Materials (all opaque, base-colour textures only, TEXCOORD_0):
//   stone      tileable masonry, repeat sampler
//   reveal     the same stone image tinted blue-grey for the inner faces
//   runes      pillar fronts: stone with a carved border and rune column
//   surface    the portal itself: oval swirl with rings and rune ticks
//   plaque     the destination label, drawn with a built-in 5x7 pixel font
//
// The plaque text is the Lobby portal's label from
// demo-domain-a/.well-known/spatial.json (world "lobby", portal 0), so the
// sign matches the destination. Override with --label "TEXT".
//
// Usage: node tools/make-town-portal-glb.js [--label "TEXT"]

const fs = require('fs');
const path = require('path');
const { buildMultiGlb, makePng } = require('./lib/glb-builder');

const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'demo-domain-a', 'assets', 'portals', 'townPortal.glb');

// ---------- deterministic noise ----------

function hash(ix, iy, seed) {
  let h = (Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const mod = (a, n) => ((a % n) + n) % n;
const smooth = (t) => t * t * (3 - 2 * t);
// Value noise on an integer lattice; `px`/`py` are the lattice periods (0 = not periodic).
function noise(x, y, seed, px, py) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = smooth(x - x0), fy = smooth(y - y0);
  const w = (ix, iy) => hash(px ? mod(ix, px) : ix, py ? mod(iy, py) : iy, seed);
  const a = w(x0, y0), b = w(x0 + 1, y0), c = w(x0, y0 + 1), d = w(x0 + 1, y0 + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const mix = (a, b, t) => a + (b - a) * t;
const mixRgb = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const scaleRgb = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const toPx = (c) => [Math.round(Math.max(0, Math.min(255, c[0]))), Math.round(Math.max(0, Math.min(255, c[1]))), Math.round(Math.max(0, Math.min(255, c[2]))), 255];

// ---------- stone ----------

// Running-bond masonry in metres. Courses are 0.25 high, blocks 0.5 wide,
// every other course shifted by half a block. The pattern repeats every
// 0.5 m horizontally and 1.0 m vertically, which is the stone tile.
const STONE_TILE_W = 0.5, STONE_TILE_H = 1.0;
function stoneAt(xm, ym) {
  const course = Math.floor(ym / 0.25);
  const shift = (mod(course, 2)) * 0.25;
  const lx = mod(xm - shift, 0.5);
  const ly = mod(ym, 0.25);
  const cid = mod(course, 4);
  const tint = 0.9 + 0.2 * hash(cid, 0, 11);
  const warm = hash(cid, 1, 12);
  let col = mixRgb([196, 168, 130], [206, 164, 118], warm);
  col = scaleRgb(col, tint);
  const n = noise(xm * 22, ym * 22, 5, 11, 22) * 0.6 + noise(xm * 60, ym * 60, 6, 30, 60) * 0.4;
  col = scaleRgb(col, 0.9 + 0.2 * n);
  // sparse chips and pits
  const pit = noise(xm * 90, ym * 90, 7, 45, 90);
  if (pit > 0.86) col = scaleRgb(col, 0.78);
  // mortar
  const jx = Math.min(lx, 0.5 - lx), jy = Math.min(ly, 0.25 - ly);
  const joint = Math.min(jx, jy);
  if (joint < 0.007) return mixRgb([92, 78, 64], col, 0.15 + 0.25 * n);
  // bevel: lit top and left edges, shaded bottom and right edges
  if (ly > 0.25 - 0.014) col = scaleRgb(col, 1.1);
  else if (ly < 0.014) col = scaleRgb(col, 0.84);
  if (lx < 0.012) col = scaleRgb(col, 1.05);
  else if (lx > 0.5 - 0.012) col = scaleRgb(col, 0.9);
  return col;
}

function stoneTexture() {
  const W = 128, H = 256;
  return makePng(W, H, (x, y) => toPx(stoneAt((x + 0.5) / W * STONE_TILE_W, (y + 0.5) / H * STONE_TILE_H)));
}

// ---------- carved pillar front ----------

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const t = clamp01(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}
function distToPolyline(px, py, pts, closed) {
  let d = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) d = Math.min(d, distToSegment(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  if (closed) d = Math.min(d, distToSegment(px, py, pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1]));
  return d;
}
const circle = (n, r) => Array.from({ length: n }, (_, i) => [Math.cos((i / n) * Math.PI * 2) * r, Math.sin((i / n) * Math.PI * 2) * r]);
// Rune strokes in a [-1, 1] box: [points, closed]
const RUNES = [
  [[circle(14, 0.8), true], [[[0, -0.2], [0, 0.2]], false]],
  [[[[0, -0.9], [0.8, 0.8], [-0.8, 0.8]], true], [[[0, -0.9], [0, 0.8]], false]],
  [[[[-0.7, -0.85], [0.7, -0.3], [-0.7, 0.3], [0.7, 0.85]], false]],
  [[[[0, -0.9], [0.8, 0], [0, 0.9], [-0.8, 0]], true], [[[-0.8, 0], [0.8, 0]], false]]
];

function pillarTexture() {
  const W = 64, H = 256;
  const PW = 0.35, PH = 1.43;
  const runeCenters = [52, 100, 148, 196].map((cy, i) => ({ cx: 32, cy, half: 15, strokes: RUNES[i] }));
  const carve = (x, y) => {
    let d = Infinity;
    // border groove
    const bx0 = 6, bx1 = W - 7, by0 = 6, by1 = H - 7;
    d = Math.min(d, distToPolyline(x, y, [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]], true) - 0.3);
    // end diamonds
    [[32, 20], [32, 236]].forEach(([cx, cy]) => { d = Math.min(d, distToPolyline(x, y, [[cx, cy - 7], [cx + 6, cy], [cx, cy + 7], [cx - 6, cy]], true)); });
    runeCenters.forEach((r) => r.strokes.forEach(([pts, closed]) => {
      const scaled = pts.map((p) => [r.cx + p[0] * r.half, r.cy + p[1] * r.half]);
      d = Math.min(d, distToPolyline(x, y, scaled, closed));
    }));
    return d;
  };
  return makePng(W, H, (x, y) => {
    const base = stoneAt((x + 0.5) / W * PW + 0.13, (y + 0.5) / H * PH + 0.31);
    const px = x + 0.5, py = y + 0.5;
    let col = base;
    const d = carve(px, py);
    if (d < 1.3) col = scaleRgb(base, 0.5);
    else if (carve(px - 1.6, py - 1.6) < 1.3) col = scaleRgb(base, 1.18);
    return toPx(col);
  });
}

// ---------- portal surface ----------

function surfaceTexture() {
  const S = 256;
  const ramp = [
    [0.0, [236, 252, 255]],
    [0.1, [150, 238, 255]],
    [0.32, [56, 190, 240]],
    [0.58, [48, 100, 226]],
    [0.8, [118, 62, 214]],
    [1.0, [36, 18, 96]]
  ];
  const rampAt = (t) => {
    for (let i = 0; i + 1 < ramp.length; i++) {
      if (t <= ramp[i + 1][0]) return mixRgb(ramp[i][1], ramp[i + 1][1], (t - ramp[i][0]) / (ramp[i + 1][0] - ramp[i][0]));
    }
    return ramp[ramp.length - 1][1];
  };
  return makePng(S, S, (x, y) => {
    const dx = ((x + 0.5) / S - 0.5) * 2, dy = ((y + 0.5) / S - 0.5) * 2;
    const r = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
    let t = clamp01(r);
    let col = rampAt(t);
    // spiral arms and fine rings
    const arms = Math.sin(th * 5 + r * 16) * 0.5 + 0.5;
    const rings = Math.sin(r * 46) * 0.5 + 0.5;
    col = scaleRgb(col, 0.82 + 0.2 * arms + 0.06 * rings);
    // soft swirl mottling
    col = scaleRgb(col, 0.92 + 0.16 * noise(dx * 6 + Math.cos(th * 3) * 2, dy * 6 + Math.sin(th * 3) * 2, 21, 0, 0));
    // rune ticks on a ring near the edge
    if (r > 0.74 && r < 0.84) {
      const slot = Math.floor(((th + Math.PI) / (Math.PI * 2)) * 16);
      const within = ((th + Math.PI) / (Math.PI * 2)) * 16 - slot;
      const tick = within > 0.42 && within < 0.58 && (hash(slot, 3, 31) > 0.35 || r > 0.78);
      if (tick) col = mixRgb(col, [220, 246, 255], 0.85);
    }
    // bright thin ring and dark outer edge
    if (Math.abs(r - 0.9) < 0.012) col = mixRgb(col, [200, 240, 255], 0.9);
    if (r > 0.94) col = mixRgb(col, [30, 14, 80], clamp01((r - 0.94) / 0.05));
    // stars
    const star = hash(x >> 1, y >> 1, 41);
    if (star > 0.985 && r > 0.18 && r < 0.9) col = mixRgb(col, [255, 255, 255], 0.8);
    // bright core
    if (r < 0.1) col = mixRgb(col, [255, 255, 255], (0.1 - r) / 0.1);
    return toPx(col);
  });
}

// ---------- destination plaque ----------

const FONT = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....']
};

function plaqueTexture(label) {
  const W = 512, H = 128;
  const text = label.toUpperCase();
  for (const ch of text) if (!FONT[ch]) throw new Error('Plaque font has no glyph for ' + JSON.stringify(ch) + ' in label ' + JSON.stringify(label));
  // Largest whole-pixel scale at which the text fits inside the plate margins.
  const maxWidth = W - 2 * 36;
  let scale = 8;
  const widthAt = (s) => text.length * 6 * s - s;
  while (scale > 1 && widthAt(scale) > maxWidth) scale--;
  if (widthAt(scale) > maxWidth) throw new Error('Label too long for the plaque: ' + label);
  const tw = widthAt(scale), th = 7 * scale;
  const ox = Math.round((W - tw) / 2), oy = Math.round((H - th) / 2);
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < text.length; i++) {
    const g = FONT[text[i]];
    for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) {
      if (g[gy][gx] !== '#') continue;
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
        ink[(oy + gy * scale + sy) * W + ox + i * 6 * scale + gx * scale + sx] = 1;
      }
    }
  }
  const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : ink[y * W + x]);
  return makePng(W, H, (x, y) => {
    // dark slate plate with a lit bevel and a thin inner border line
    const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
    let col = mixRgb([52, 46, 64], [70, 62, 84], noise(x / 9, y / 9, 51, 0, 0));
    col = scaleRgb(col, 0.95 + 0.1 * noise(x / 3, y / 3, 52, 0, 0));
    if (edge < 5) col = scaleRgb([150, 126, 84], edge < 2 ? 0.7 : 1);
    else if (edge === 9 || edge === 10) col = [150, 126, 84];
    if (at(x - Math.max(1, scale >> 1), y - Math.max(1, scale >> 1)) && !at(x, y)) col = [20, 16, 28];
    if (at(x, y)) col = mixRgb([246, 226, 168], [226, 196, 120], clamp01((y - oy) / th));
    return toPx(col);
  });
}

// ---------- geometry ----------

class Mesh {
  constructor() { this.positions = []; this.normals = []; this.uvs = []; this.indices = []; }
  // Corners in counter-clockwise order seen from outside; uv per corner.
  quad(c, n, uv) {
    const base = this.positions.length / 3;
    for (let i = 0; i < 4; i++) { this.positions.push(...c[i]); this.normals.push(...n); this.uvs.push(...uv[i]); }
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  tri(c, n, uv) {
    const base = this.positions.length / 3;
    for (let i = 0; i < 3; i++) { this.positions.push(...c[i]); this.normals.push(...n); this.uvs.push(...uv[i]); }
    this.indices.push(base, base + 1, base + 2);
  }
  spec(name, material) { return { name, material, positions: this.positions, normals: this.normals, uvs: this.uvs, indices: this.indices }; }
}

// Stone UVs follow metre coordinates so courses line up across pieces.
const stoneUv = (a, b) => [a / STONE_TILE_W, b / STONE_TILE_H];

// Box faces (no bottom). faces: subset of 'fbrlt' (front +z, back -z, right +x, left -x, top +y).
function addBox(mesh, min, max, faces) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const f = faces || 'fbrlt';
  if (f.includes('f')) mesh.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], [stoneUv(x0, -y0), stoneUv(x1, -y0), stoneUv(x1, -y1), stoneUv(x0, -y1)]);
  if (f.includes('b')) mesh.quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], [stoneUv(x1 + 0.2, -y0), stoneUv(x0 + 0.2, -y0), stoneUv(x0 + 0.2, -y1), stoneUv(x1 + 0.2, -y1)]);
  if (f.includes('r')) mesh.quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], [stoneUv(z1, -y0), stoneUv(z0, -y0), stoneUv(z0, -y1), stoneUv(z1, -y1)]);
  if (f.includes('l')) mesh.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], [stoneUv(z0, -y0), stoneUv(z1, -y0), stoneUv(z1, -y1), stoneUv(z0, -y1)]);
  if (f.includes('t')) mesh.quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], [stoneUv(x0, z1), stoneUv(x1, z1), stoneUv(x1, z0), stoneUv(x0, z0)]);
}

// Opening profile (shared by the surface, the inner faces and the filler wedges).
const OPEN_HALF = 0.5, OPEN_BOTTOM = 0.07, SHOULDER_Y = 1.2, OPEN_TOP = 1.5, TOP_HALF = 0.3;
const PILLAR_OUT = 0.85, PILLAR_Z = 0.18;

function buildGeometry(label) {
  const stone = new Mesh(), reveal = new Mesh(), runes = new Mesh(), surface = new Mesh(), plaque = new Mesh(), plaqueFrame = stone;

  // plinth and pillar bases
  addBox(stone, [-0.95, 0, -0.28], [0.95, 0.07, 0.28], 'fbrlt');
  for (const sx of [-1, 1]) {
    const xa = Math.min(sx * 0.47, sx * 0.88), xb = Math.max(sx * 0.47, sx * 0.88);
    addBox(stone, [xa, 0.07, -0.21], [xb, 0.2, 0.21], 'fbrlt');
    addBox(stone, [xa, 1.36, -0.21], [xb, OPEN_TOP, 0.21], 'fbrlt');
  }
  // pillar shafts: front carved, rest stone, inner face is reveal
  for (const sx of [-1, 1]) {
    const xa = Math.min(sx * 0.5, sx * PILLAR_OUT), xb = Math.max(sx * 0.5, sx * PILLAR_OUT);
    addBox(stone, [xa, 0.2, -PILLAR_Z], [xb, 1.36, PILLAR_Z], sx > 0 ? 'brt' : 'blt');
    // carved front face (the shaft part between base and capital)
    const v = (y) => 1 - (y - 0.2) / (1.36 - 0.2);
    runes.quad([[xa, 0.2, PILLAR_Z], [xb, 0.2, PILLAR_Z], [xb, 1.36, PILLAR_Z], [xa, 1.36, PILLAR_Z]], [0, 0, 1], [[0, v(0.2)], [1, v(0.2)], [1, v(1.36)], [0, v(1.36)]]);
    // inner face of the opening
    const nx = -sx;
    const inner = sx * 0.5;
    const y0 = OPEN_BOTTOM, y1 = SHOULDER_Y;
    if (sx > 0) reveal.quad([[inner, y0, PILLAR_Z], [inner, y0, -PILLAR_Z], [inner, y1, -PILLAR_Z], [inner, y1, PILLAR_Z]], [nx, 0, 0], [stoneUv(PILLAR_Z, -y0), stoneUv(-PILLAR_Z, -y0), stoneUv(-PILLAR_Z, -y1), stoneUv(PILLAR_Z, -y1)]);
    else reveal.quad([[inner, y0, -PILLAR_Z], [inner, y0, PILLAR_Z], [inner, y1, PILLAR_Z], [inner, y1, -PILLAR_Z]], [nx, 0, 0], [stoneUv(-PILLAR_Z, -y0), stoneUv(PILLAR_Z, -y0), stoneUv(PILLAR_Z, -y1), stoneUv(-PILLAR_Z, -y1)]);
    // chamfer filler: triangle (inner, SHOULDER) (inner, TOP) (TOP_HALF, TOP) extruded across the pillar depth
    const p0 = [sx * OPEN_HALF, SHOULDER_Y], p1 = [sx * OPEN_HALF, OPEN_TOP], p2 = [sx * TOP_HALF, OPEN_TOP];
    const front = sx > 0 ? [[p0[0], p0[1], PILLAR_Z], [p2[0], p2[1], PILLAR_Z], [p1[0], p1[1], PILLAR_Z]] : [[p0[0], p0[1], PILLAR_Z], [p1[0], p1[1], PILLAR_Z], [p2[0], p2[1], PILLAR_Z]];
    stone.tri(front, [0, 0, 1], front.map((p) => stoneUv(p[0], -p[1])));
    const back = front.map((p) => [p[0], p[1], -PILLAR_Z]).reverse();
    stone.tri(back, [0, 0, -1], back.map((p) => stoneUv(p[0] + 0.2, -p[1])));
    // sloped inner face of the filler, facing down and toward the opening
    const sdx = Math.abs(p2[0] - p0[0]), sdy = p2[1] - p0[1];
    const slen = Math.hypot(sdx, sdy);
    const slopeN = [-sx * sdy / slen, -sdx / slen, 0];
    const sloped = sx > 0
      ? [[p0[0], p0[1], PILLAR_Z], [p0[0], p0[1], -PILLAR_Z], [p2[0], p2[1], -PILLAR_Z], [p2[0], p2[1], PILLAR_Z]]
      : [[p0[0], p0[1], -PILLAR_Z], [p0[0], p0[1], PILLAR_Z], [p2[0], p2[1], PILLAR_Z], [p2[0], p2[1], -PILLAR_Z]];
    reveal.quad(sloped, slopeN, sloped.map((p) => stoneUv(p[2], -p[1])));
  }
  // lintel underside between the chamfers
  reveal.quad([[-TOP_HALF, OPEN_TOP, -PILLAR_Z], [TOP_HALF, OPEN_TOP, -PILLAR_Z], [TOP_HALF, OPEN_TOP, PILLAR_Z], [-TOP_HALF, OPEN_TOP, PILLAR_Z]], [0, -1, 0],
    [stoneUv(-TOP_HALF, -PILLAR_Z), stoneUv(TOP_HALF, -PILLAR_Z), stoneUv(TOP_HALF, PILLAR_Z), stoneUv(-TOP_HALF, PILLAR_Z)]);
  // lintel and cap
  addBox(stone, [-0.88, OPEN_TOP, -0.2], [0.88, 1.92, 0.2], 'fbrlt');
  addBox(stone, [-0.95, 1.92, -0.25], [0.95, 2.0, 0.25], 'fbrlt');
  // plaque: thin stone frame, then the label quad just proud of it
  addBox(plaqueFrame, [-0.68, 1.54, 0.2], [0.68, 1.88, 0.225], 'frlt');
  plaque.quad([[-0.64, 1.56, 0.226], [0.64, 1.56, 0.226], [0.64, 1.86, 0.226], [-0.64, 1.86, 0.226]], [0, 0, 1], [[0, 1], [1, 1], [1, 0], [0, 0]]);
  // portal surface: the opening polygon at z = 0, mapped as an oval swirl
  const poly = [[-OPEN_HALF, OPEN_BOTTOM], [OPEN_HALF, OPEN_BOTTOM], [OPEN_HALF, SHOULDER_Y], [TOP_HALF, OPEN_TOP], [-TOP_HALF, OPEN_TOP], [-OPEN_HALF, SHOULDER_Y]];
  const cy = (OPEN_BOTTOM + OPEN_TOP) / 2, halfH = (OPEN_TOP - OPEN_BOTTOM) / 2;
  const sUv = (x, y) => [0.5 + (x / OPEN_HALF) * 0.5, 0.5 - ((y - cy) / halfH) * 0.5];
  const ctr = [0, cy];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    surface.tri([[ctr[0], ctr[1], 0], [a[0], a[1], 0], [b[0], b[1], 0]], [0, 0, 1], [sUv(...ctr), sUv(...a), sUv(...b)]);
  }

  const REPEAT = { wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9987 };
  const CLAMP = { wrapS: 33071, wrapT: 33071, magFilter: 9729, minFilter: 9987 };
  const stoneBytes = stoneTexture();
  return [
    stone.spec('stone', { texture: { bytes: stoneBytes, mimeType: 'image/png', sampler: REPEAT } }),
    reveal.spec('reveal', { baseColorFactor: [0.62, 0.66, 0.9, 1], texture: { bytes: stoneBytes, mimeType: 'image/png', sampler: REPEAT } }),
    runes.spec('pillarRunes', { texture: { bytes: pillarTexture(), mimeType: 'image/png', sampler: CLAMP } }),
    plaque.spec('plaque', { texture: { bytes: plaqueTexture(label), mimeType: 'image/png', sampler: CLAMP } }),
    surface.spec('portalSurface', { texture: { bytes: surfaceTexture(), mimeType: 'image/png', sampler: CLAMP } })
  ];
}

function lobbyPortalLabel() {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'demo-domain-a', '.well-known', 'spatial.json'), 'utf8'));
  const lobby = manifest.worlds.find((w) => w.id === 'lobby');
  if (!lobby || !lobby.portals || !lobby.portals[0] || !lobby.portals[0].label) throw new Error('Lobby portal 0 has no label in the manifest');
  return lobby.portals[0].label;
}

if (require.main === module) {
  const argIdx = process.argv.indexOf('--label');
  const label = argIdx > 0 ? process.argv[argIdx + 1] : lobbyPortalLabel();
  const glb = buildMultiGlb({ name: 'townPortal', primitives: buildGeometry(label) });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, glb);
  console.log('wrote ' + OUT + ' (' + glb.length + ' bytes), plaque: ' + JSON.stringify(label));
}

module.exports = { buildGeometry, lobbyPortalLabel, plaqueTexture, surfaceTexture, stoneTexture, pillarTexture };
