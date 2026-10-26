#!/usr/bin/env node
// Generates the models for the Domain A Lobby's outdoor town into
// demo-domain-a/assets/town/. Everything is original and procedural: the
// textures are drawn here, encoded as PNG and embedded in each GLB, so there
// are no external files and no absolute paths, and the output is deterministic.
//
// Two kinds of model:
//   - reusable, built around their own origin (hut, fountain, pier, hedge,
//     boulders, pines, barrel, cart, wood pile, flower bed, stone wall, signpost);
//   - landscape pieces drawn in world coordinates and placed at [0, 0, 0]
//     (ground, paths and paving, river banks, river water, mine hill, sky), whose
//     shapes come from tools/lib/lobby-town-layout.js.
//
// Textures are base colour only (the renderer's supported subset): grass, gravel,
// paving, flagstones, sand, water, planks, shingles, rock, leaves, signboard
// lettering and a sky with distant hills. Pieces that look fine as flat colour
// (pines, barrel, cart, wood pile, flowers) have none.
//
// Usage: node tools/make-town-assets.js [--only name[,name...]]

const fs = require('fs');
const path = require('path');
const { buildMultiGlb, makePng } = require('./lib/glb-builder');
const { hash, mod, noise, clamp01, mix, mixRgb, scaleRgb, toPx, FONT, Mesh } = require('./lib/procedural');
const portal = require('./make-town-portal-glb');
const W = require('./lib/lobby-town-layout');

const REPO = path.resolve(__dirname, '..');
const OUT_DIR = path.join('demo-domain-a', 'assets', 'town');

const REPEAT = { wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9987 };
const CLAMP = { wrapS: 33071, wrapT: 33071, magFilter: 9729, minFilter: 9987 };
const REPEAT_T = { wrapS: 33071, wrapT: 10497, magFilter: 9729, minFilter: 9987 };

// ---------- textures ----------

const memo = (fn) => { let v; return () => (v === undefined ? (v = fn()) : v); };
// Lattice noise whose period is the tile: `f` cells per metre, tile of tw x th metres.
const nz = (x, y, seed, tw, th, f) => noise(x * f, y * f, seed, Math.round(tw * f), Math.round(th * f));
const tile = (w, h, tw, th, fn) => makePng(w, h, (x, y) => toPx(fn((x + 0.5) / w * tw, (y + 0.5) / h * th)));

function grassAt(x, y) {
  const T = 8;
  const big = nz(x, y, 1, T, T, 0.5), mid = nz(x, y, 2, T, T, 2), fine = nz(x, y, 3, T, T, 8), fine2 = nz(x, y, 4, T, T, 16);
  let col = mixRgb([98, 142, 66], [128, 164, 78], big);
  col = scaleRgb(col, 0.9 + 0.2 * mid);
  if (fine > 0.78) col = scaleRgb(col, 1.12); else if (fine < 0.2) col = scaleRgb(col, 0.86);
  if (fine2 > 0.9) col = mixRgb(col, [196, 206, 110], 0.45);
  const dirt = nz(x, y, 5, T, T, 1);
  if (dirt > 0.82) col = mixRgb(col, [140, 120, 80], (dirt - 0.82) * 4);
  return col;
}
const grassTexture = memo(() => tile(256, 256, 8, 8, grassAt));

function gravelAt(x, y) {
  const T = 2;
  let col = mixRgb([196, 170, 128], [208, 184, 142], nz(x, y, 11, T, T, 1));
  const p = nz(x, y, 12, T, T, 24);
  if (p > 0.8) col = scaleRgb(col, 1.15); else if (p < 0.16) col = scaleRgb(col, 0.78);
  return scaleRgb(col, 0.92 + 0.16 * nz(x, y, 13, T, T, 10));
}
const gravelTexture = memo(() => tile(128, 128, 2, 2, gravelAt));

// Plaza paving: running-bond pavers 0.8 x 0.4, tile 1.6 x 1.6.
function plazaAt(x, y) {
  const row = Math.floor(y / 0.4), sh = (row % 2) * 0.4;
  const lx = mod(x - sh, 0.8), ly = mod(y, 0.4);
  const bid = hash(mod(Math.floor((x - sh) / 0.8), 2), mod(row, 4), 21);
  let col = mixRgb([176, 160, 138], [192, 174, 148], bid);
  col = scaleRgb(col, 0.93 + 0.14 * nz(x, y, 22, 1.6, 1.6, 10));
  const sp = nz(x, y, 23, 1.6, 1.6, 40);
  if (sp > 0.86) col = scaleRgb(col, 0.82);
  const joint = Math.min(lx, 0.8 - lx, ly, 0.4 - ly);
  if (joint < 0.012) return mixRgb([96, 84, 72], col, 0.2 + 0.2 * bid);
  if (ly > 0.4 - 0.02) col = scaleRgb(col, 1.08); else if (ly < 0.02) col = scaleRgb(col, 0.86);
  return col;
}
const plazaTexture = memo(() => tile(256, 256, 1.6, 1.6, plazaAt));

// Market flagstones: 0.9 m slabs in running bond, tile 1.8 x 1.8.
function flagAt(x, y) {
  const row = Math.floor(y / 0.9), sh = (row % 2) * 0.45;
  const lx = mod(x - sh, 0.9), ly = mod(y, 0.9);
  const sid = hash(mod(Math.floor((x - sh) / 0.9), 2), mod(row, 2), 25);
  let col = mixRgb([204, 182, 146], [188, 164, 128], sid);
  col = scaleRgb(col, 0.94 + 0.12 * nz(x, y, 26, 1.8, 1.8, 6));
  const crack = Math.abs(nz(x, y, 27, 1.8, 1.8, 5) - 0.5);
  if (crack < 0.008) col = scaleRgb(col, 0.85);
  const sp = nz(x, y, 28, 1.8, 1.8, 36);
  if (sp > 0.87) col = scaleRgb(col, 0.84); else if (sp < 0.1) col = scaleRgb(col, 1.08);
  const joint = Math.min(lx, 0.9 - lx, ly, 0.9 - ly);
  if (joint < 0.016) return mixRgb([118, 102, 84], col, 0.25);
  if (ly > 0.9 - 0.025) col = scaleRgb(col, 1.07); else if (ly < 0.025) col = scaleRgb(col, 0.88);
  return col;
}
const flagTexture = memo(() => tile(256, 256, 1.8, 1.8, flagAt));

function sandAt(x, y) {
  const T = 2;
  let col = mixRgb([214, 194, 148], [226, 208, 162], nz(x, y, 31, T, T, 1.5));
  const p = nz(x, y, 32, T, T, 28);
  if (p > 0.84) col = scaleRgb(col, 0.86); else if (p < 0.12) col = scaleRgb(col, 1.07);
  return scaleRgb(col, 0.95 + 0.1 * nz(x, y, 33, T, T, 8));
}
const sandTexture = memo(() => tile(128, 128, 2, 2, sandAt));

// Water: u across the river (0..1), v along it, 4 m per repeat.
const waterTexture = memo(() => makePng(64, 128, (x, y) => {
  const u = (x + 0.5) / 64, v = (y + 0.5) / 128;
  const flow = noise(u * 6, v * 8, 41, 0, 8);
  let col = mixRgb([58, 126, 160], [74, 148, 178], flow);
  const streak = noise(u * 10, v * 3, 42, 0, 3);
  if (streak > 0.66) col = mixRgb(col, [150, 206, 220], (streak - 0.66) * 2.2);
  col = mixRgb(col, [40, 98, 138], (1 - Math.abs(u - 0.5) * 2) * 0.4);
  const e = Math.min(u, 1 - u);
  if (e < 0.06) col = mixRgb(col, [228, 242, 240], clamp01((0.06 - e) / 0.06 * 0.9) * (0.5 + 0.5 * noise(u * 40, v * 40, 43, 0, 40)));
  return toPx(col);
}));

// Planks: boards 0.2 m wide running along u, tile 1 x 1.
function woodAt(x, y) {
  const row = Math.floor(y / 0.2), ly = mod(y, 0.2);
  const pid = hash(mod(row, 5), 0, 45);
  let col = mixRgb([150, 104, 64], [180, 130, 82], pid);
  col = scaleRgb(col, 0.88 + 0.24 * noise(x * 3, y * 40, 46, 3, 40));
  if (ly < 0.008 || ly > 0.192) col = scaleRgb(col, 0.55);
  else if (ly < 0.02) col = scaleRgb(col, 1.08);
  if (Math.abs(mod(x + pid * 0.7, 1) - 0.5) < 0.012 && ly > 0.05 && ly < 0.15) col = scaleRgb(col, 0.72); // end seam
  return col;
}
const woodTexture = memo(() => tile(128, 128, 1, 1, woodAt));

// Shingles: rows 0.15 high, 0.3 wide, alternate rows shifted, tile 0.6 x 0.6.
function shingleAt(x, y) {
  const row = Math.floor(y / 0.15), sh = (row % 2) * 0.15;
  const lx = mod(x - sh, 0.3), ly = mod(y, 0.15);
  const sid = hash(mod(Math.floor((x - sh) / 0.3), 2), mod(row, 4), 47);
  let col = mixRgb([150, 76, 54], [180, 100, 68], sid);
  col = scaleRgb(col, 0.9 + 0.2 * nz(x, y, 48, 0.6, 0.6, 20));
  if (lx < 0.01 || lx > 0.29) col = scaleRgb(col, 0.6);
  if (ly > 0.15 - 0.03) col = scaleRgb(col, 0.72); else if (ly < 0.02) col = scaleRgb(col, 1.1);
  return col;
}
const shingleTexture = memo(() => tile(128, 128, 0.6, 0.6, shingleAt));

function rockAt(x, y) {
  const T = 2;
  let col = mixRgb([132, 116, 100], [166, 148, 126], nz(x, y, 51, T, T, 2));
  col = scaleRgb(col, 0.86 + 0.28 * noise(x * 1, y * 9, 52, 2, 18));
  if (Math.abs(nz(x, y, 53, T, T, 6) - 0.5) < 0.012) col = scaleRgb(col, 0.72);
  const sp = nz(x, y, 54, T, T, 40);
  if (sp > 0.85) col = scaleRgb(col, 1.15); else if (sp < 0.12) col = scaleRgb(col, 0.8);
  return col;
}
const rockTexture = memo(() => tile(128, 128, 2, 2, rockAt));

function hedgeAt(x, y) {
  const T = 1;
  const a = nz(x, y, 61, T, T, 6), b = nz(x, y, 62, T, T, 18);
  let col = mixRgb([52, 96, 48], [86, 138, 60], a);
  col = scaleRgb(col, 0.82 + 0.36 * b);
  if (b < 0.18) col = scaleRgb(col, 0.65);
  if (b > 0.88) col = mixRgb(col, [150, 190, 90], 0.45);
  return col;
}
const hedgeTexture = memo(() => tile(128, 128, 1, 1, hedgeAt));

// The fountain pad: concentric rings of stone with spokes, u,v over the circle's bounding square.
const inlayTexture = memo(() => makePng(256, 256, (x, y) => {
  const dx = (x + 0.5) / 256 - 0.5, dy = (y + 0.5) / 256 - 0.5;
  const r = Math.hypot(dx, dy) * 2; // 0 centre .. 1 rim
  const a = Math.atan2(dy, dx);
  if (r > 1) return [0, 0, 0, 255];
  const band = Math.floor(r * 9);
  let col = mixRgb([170, 154, 132], [196, 178, 150], hash(band, 0, 55));
  col = scaleRgb(col, 0.93 + 0.14 * noise(dx * 40, dy * 40, 56, 0, 0));
  const ringLine = Math.abs(r * 9 - Math.round(r * 9));
  if (ringLine < 0.03) col = scaleRgb(col, 0.66);
  const spokes = 24 - 4 * Math.min(band, 3);
  const spoke = Math.abs(((a / (Math.PI * 2) * spokes) % 1 + 1) % 1 - 0.5);
  if (band % 2 === 1 && spoke < 0.03) col = scaleRgb(col, 0.7);
  if (r > 0.94) col = scaleRgb([150, 134, 112], 0.92 + 0.1 * r);
  return toPx(col);
}));

// Sign board: wood with a dark border and a line of lettering, 256 x 64.
function signTexture(label) {
  const Wd = 256, H = 64;
  const text = label.toUpperCase();
  for (const ch of text) if (!FONT[ch]) throw new Error('Sign font has no glyph for ' + JSON.stringify(ch));
  let scale = 0;
  for (let s = 6; s >= 1; s--) if ((text.length * 6 * s - s) <= Wd - 36 && 7 * s <= H - 18) { scale = s; break; }
  if (!scale) throw new Error('Sign label too long: ' + label);
  const tw = text.length * 6 * scale - scale, th = 7 * scale;
  const ox = Math.round((Wd - tw) / 2), oy = Math.round((H - th) / 2);
  const ink = new Uint8Array(Wd * H);
  for (let i = 0; i < text.length; i++) {
    const g = FONT[text[i]];
    for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) {
      if (g[gy][gx] !== '#') continue;
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) ink[(oy + gy * scale + sy) * Wd + ox + i * 6 * scale + gx * scale + sx] = 1;
    }
  }
  const at = (x, y) => (x < 0 || y < 0 || x >= Wd || y >= H ? 0 : ink[y * Wd + x]);
  return makePng(Wd, H, (x, y) => {
    let col = mixRgb([214, 176, 118], [226, 190, 132], noise(x / 22, y / 3, 57, 0, 0));
    col = scaleRgb(col, 0.95 + 0.1 * noise(x / 4, y / 2, 58, 0, 0));
    const edge = Math.min(x, y, Wd - 1 - x, H - 1 - y);
    if (edge < 3) col = [96, 64, 40];
    else if (edge < 5) col = scaleRgb(col, 0.82);
    if (at(x - 1, y - 1) && !at(x, y)) col = scaleRgb(col, 0.6);
    if (at(x, y)) col = [62, 40, 26];
    return toPx(col);
  });
}

// Sky for the four walls of the sky box: u runs round the horizon (periodic), v from the zenith (0) to the
// ground (1). The scene lights these faces by 0.939, so colours are divided by that.
const SKY_LIGHT = 0.939;
const skyColour = (c) => scaleRgb(c, 1 / SKY_LIGHT);
const skyTexture = memo(() => makePng(512, 128, (x, y) => {
  const u = (x + 0.5) / 512, v = (y + 0.5) / 128;
  const far = 0.83 - 0.035 * noise(u * 5, 0.3, 71, 5, 0) - 0.012 * noise(u * 17, 0.6, 72, 17, 0);
  const near = 0.885 - 0.025 * noise(u * 7, 1.3, 73, 7, 0) - 0.01 * noise(u * 23, 1.9, 74, 23, 0);
  let col;
  if (v < far) {
    const t = clamp01(v / far);
    col = mixRgb([104, 160, 222], [214, 232, 240], Math.pow(t, 1.7));
    const cloud = noise(u * 9, v * 26, 75, 9, 0) * 0.6 + noise(u * 22, v * 60, 76, 22, 0) * 0.4;
    if (v > 0.1 && v < far - 0.05 && cloud > 0.6) col = mixRgb(col, [250, 250, 248], clamp01((cloud - 0.6) * 3.2) * 0.85);
  } else if (v < near) {
    col = mixRgb([150, 180, 156], [128, 164, 134], clamp01((v - far) / (near - far)));
    col = scaleRgb(col, 0.96 + 0.08 * noise(u * 60, v * 60, 77, 60, 0));
  } else {
    col = mixRgb([92, 134, 84], [100, 142, 72], clamp01((v - near) / (1 - near)));
    col = scaleRgb(col, 0.94 + 0.12 * noise(u * 90, v * 90, 78, 90, 0));
  }
  return toPx(skyColour(col));
}));

// ---------- geometry helpers ----------

const rgb = (r, g, b) => ({ baseColorFactor: [r / 255, g / 255, b / 255, 1] });
const textured = (bytes, sampler, tint) => ({ ...(tint ? { baseColorFactor: [...tint, 1] } : {}), texture: { bytes, mimeType: 'image/png', sampler: sampler || REPEAT } });

// Box with planar texture coordinates in metres divided by `tl` (a number or [tu, tv]).
// faces: subset of 'fbrlt' + 'u' (underside).
function box(mesh, [x0, y0, z0], [x1, y1, z1], tl, faces, swapTop) {
  const [tu, tv] = Array.isArray(tl) ? tl : [tl || 1, tl || 1];
  const f = faces || 'fbrlt';
  const U = (a) => a / tu, V = (b) => b / tv;
  if (f.includes('f')) mesh.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], [[U(x0), V(-y0)], [U(x1), V(-y0)], [U(x1), V(-y1)], [U(x0), V(-y1)]]);
  if (f.includes('b')) mesh.quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], [[U(x1), V(-y0)], [U(x0), V(-y0)], [U(x0), V(-y1)], [U(x1), V(-y1)]]);
  if (f.includes('r')) mesh.quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], [[U(z1), V(-y0)], [U(z0), V(-y0)], [U(z0), V(-y1)], [U(z1), V(-y1)]]);
  if (f.includes('l')) mesh.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], [[U(z0), V(-y0)], [U(z1), V(-y0)], [U(z1), V(-y1)], [U(z0), V(-y1)]]);
  if (f.includes('t')) {
    const t = [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]];
    mesh.quad(t, [0, 1, 0], t.map((p) => (swapTop ? [V(p[2]), U(p[0])] : [U(p[0]), V(p[2])])));
  }
  if (f.includes('u')) mesh.quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], [[U(x0), V(z0)], [U(x1), V(z0)], [U(x1), V(z1)], [U(x0), V(z1)]]);
}

// A horizontal convex polygon (list of [x, z]) at height y, texture coordinates = world metres / tl.
function flat(mesh, pts, y, tl) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cz = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const uv = (p) => [p[0] / tl, p[1] / tl];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    mesh.tri([[cx, y, cz], [a[0], y, a[1]], [b[0], y, b[1]]], [0, 1, 0], [uv([cx, cz]), uv(a), uv(b)]);
  }
}
const rectPts = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
// A strip along a -> b of the given width, extended by half a width at both ends.
function stripPts(ax, az, bx, bz, w) {
  const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz), ux = dx / len, uz = dz / len, h = w / 2;
  const sx = ax - ux * h, sz = az - uz * h, ex = bx + ux * h, ez = bz + uz * h;
  return [[sx - uz * h, sz + ux * h], [ex - uz * h, ez + ux * h], [ex + uz * h, ez - ux * h], [sx + uz * h, sz - ux * h]];
}
const circlePts = (cx, cz, r, n, a0) => Array.from({ length: n }, (_, i) => [cx + Math.cos((a0 || 0) + (i / n) * Math.PI * 2) * r, cz + Math.sin((a0 || 0) + (i / n) * Math.PI * 2) * r]);

// A flat-shaded triangle with its own face normal (pointing away from `awayFrom` when given).
function facet(mesh, a, b, c, uvFn, awayFrom) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const len = Math.hypot(...n) || 1; n = n.map((q) => q / len);
  if (awayFrom) {
    const mx = (a[0] + b[0] + c[0]) / 3 - awayFrom[0], my = (a[1] + b[1] + c[1]) / 3 - awayFrom[1], mz = (a[2] + b[2] + c[2]) / 3 - awayFrom[2];
    if (n[0] * mx + n[1] * my + n[2] * mz < 0) n = n.map((q) => -q);
  }
  mesh.tri([a, b, c], n, [uvFn(a, n), uvFn(b, n), uvFn(c, n)]);
  return n;
}
// Planar coordinates for rock: project along the dominant axis of the face normal.
const rockUv = (tl) => (p, n) => {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  if (ay >= ax && ay >= az) return [p[0] / tl, p[2] / tl];
  if (ax >= az) return [p[2] / tl, -p[1] / tl];
  return [p[0] / tl, -p[1] / tl];
};

// A regular prism along y with `n` sides: rings are [[y, radius], ...] joined by flat bands.
function lathe(mesh, rings, n, a0, opts) {
  const o = opts || {};
  const pt = (r, i, y) => [Math.cos(a0 + (i / n) * Math.PI * 2) * r, y, Math.sin(a0 + (i / n) * Math.PI * 2) * r];
  for (let k = 0; k + 1 < rings.length; k++) {
    for (let i = 0; i < n; i++) {
      const p0 = pt(rings[k][1], i, rings[k][0]), p1 = pt(rings[k][1], i + 1, rings[k][0]), p2 = pt(rings[k + 1][1], i + 1, rings[k + 1][0]), p3 = pt(rings[k + 1][1], i, rings[k + 1][0]);
      const mid = [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2, (p0[2] + p2[2]) / 2];
      const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], e2 = [p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]];
      let nn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const len = Math.hypot(...nn) || 1; nn = nn.map((q) => q / len);
      if (nn[0] * mid[0] + nn[2] * mid[2] < 0) nn = nn.map((q) => -q);
      const uvf = o.uv ? o.uv : () => [0, 0];
      mesh.quad([p0, p1, p2, p3], nn, [uvf(p0, nn, i, k), uvf(p1, nn, i + 1, k), uvf(p2, nn, i + 1, k + 1), uvf(p3, nn, i, k + 1)]);
    }
  }
  if (o.cap) {
    const top = rings[rings.length - 1], bot = rings[0];
    for (let i = 0; i < n; i++) {
      if (o.cap.includes('t')) mesh.tri([[0, top[0], 0], pt(top[1], i, top[0]), pt(top[1], i + 1, top[0])], [0, 1, 0], [[0.5, 0.5], [0.5, 0.5], [0.5, 0.5]]);
      if (o.cap.includes('b')) mesh.tri([[0, bot[0], 0], pt(bot[1], i + 1, bot[0]), pt(bot[1], i, bot[0])], [0, -1, 0], [[0.5, 0.5], [0.5, 0.5], [0.5, 0.5]]);
    }
  }
}

// ---------- landscape pieces (world coordinates) ----------

// Grass over the whole lot and a wide skirt beyond it, with a hole where the
// Lobby's own floor shows.
function buildGround() {
  const m = new Mesh();
  const h = W.HOLE, y = W.LAYER.grass, o = { x0: -50, x1: 50, z0: -47, z1: 53 };
  const tl = 8;
  const quads = [
    rectPts(o.x0, o.z0, o.x1, h.minZ), // north
    rectPts(o.x0, h.maxZ, o.x1, o.z1), // south
    rectPts(o.x0, h.minZ, h.minX, h.maxZ), // west
    rectPts(h.maxX, h.minZ, o.x1, h.maxZ) // east
  ];
  quads.forEach((q) => flat(m, q, y, tl));
  return [m.spec('grass', textured(grassTexture()))];
}

// Gravel paths, paving, the market, the overlook terrace, the rock yard and the fountain pad.
function buildPaths() {
  const gravel = new Mesh(), plaza = new Mesh(), flag = new Mesh(), terrace = new Mesh(), quarry = new Mesh(), inlay = new Mesh();
  W.PATHS.forEach(([ax, az, bx, bz, w]) => flat(gravel, stripPts(ax, az, bx, bz, w), W.LAYER.path, 2));
  flat(quarry, rectPts(W.QUARRY.minX, W.QUARRY.minZ, W.QUARRY.maxX, W.QUARRY.maxZ), W.LAYER.path, 2);
  // two timber rails running out of the mine opening across the rock yard
  const rails = new Mesh();
  for (const rx of [W.MINE.entranceX - 0.65, W.MINE.entranceX + 0.65]) flat(rails, rectPts(rx - 0.07, W.MINE.maxZ + 0.01, rx + 0.07, W.MINE.maxZ + 3.4), W.LAYER.path + 0.006, 1);
  const P = W.PLAZA, S = W.STOOP, M = W.MARKET, T = W.TERRACE;
  flat(plaza, rectPts(P.minX, P.minZ, P.maxX, P.maxZ), W.LAYER.paving, 1.6);
  flat(plaza, rectPts(S.minX, S.minZ, S.maxX, S.maxZ), W.LAYER.paving, 1.6);
  flat(flag, rectPts(M.minX, M.minZ, M.maxX, M.maxZ), W.LAYER.paving, 1.8);
  flat(terrace, circlePts(T.cx, T.cz, T.r, 20, 0), W.LAYER.paving, 1.8);
  // fountain pad: a disc whose texture covers its bounding square
  const F = W.FOUNTAIN, R = F.r + 1.6, n = 32;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
    const p = (ang) => [F.cx + Math.cos(ang) * R, F.cz + Math.sin(ang) * R];
    const uvOf = (q) => [0.5 + (q[0] - F.cx) / (2 * R), 0.5 + (q[1] - F.cz) / (2 * R)];
    const pa = p(a), pb = p(b);
    inlay.tri([[F.cx, W.LAYER.inlay, F.cz], [pa[0], W.LAYER.inlay, pa[1]], [pb[0], W.LAYER.inlay, pb[1]]], [0, 1, 0], [[0.5, 0.5], uvOf(pa), uvOf(pb)]);
  }
  return [
    gravel.spec('gravelPath', textured(gravelTexture())),
    quarry.spec('rockYard', textured(gravelTexture(), REPEAT, [0.8, 0.82, 0.86])),
    rails.spec('mineRails', textured(woodTexture(), REPEAT, [0.7, 0.62, 0.55])),
    plaza.spec('plazaPaving', textured(plazaTexture())),
    flag.spec('marketFlagstones', textured(flagTexture())),
    terrace.spec('terraceFlagstones', textured(flagTexture(), REPEAT, [0.9, 1, 0.92])),
    inlay.spec('fountainPad', textured(inlayTexture(), CLAMP))
  ];
}

// Sand either side of the water with a lightly irregular outer edge.
function buildRiverBanks() {
  const m = new Mesh(), R = W.RIVER, y = W.LAYER.bank;
  const z0 = R.minZ - 0.5, z1 = R.maxZ + 0.5, step = 1.5;
  const edge = (side, k) => {
    const wob = (noise(k * 0.8, side * 7.3, 81, 0, 0) - 0.5) * 0.7;
    return side < 0 ? R.minX - 1.25 + wob : R.maxX + 1.4 + wob;
  };
  for (const side of [-1, 1]) {
    for (let z = z0, k = 0; z < z1 - 1e-6; z += step, k++) {
      const zb = Math.min(z + step, z1);
      const inner = side < 0 ? R.minX : R.maxX;
      const a = edge(side, k), b = edge(side, k + 1);
      flat(m, [[inner, z], [a, z], [b, zb], [inner, zb]], y, 2);
    }
  }
  return [m.spec('riverSand', textured(sandTexture()))];
}

// The water is a single solid piece: nobody walks into the river.
function buildRiverWater() {
  const m = new Mesh(), R = W.RIVER, y = W.LAYER.water;
  const len = R.maxZ - R.minZ;
  const q = [[R.minX, y, R.minZ], [R.maxX, y, R.minZ], [R.maxX, y, R.maxZ], [R.minX, y, R.maxZ]];
  m.quad(q, [0, 1, 0], [[0, 0], [1, 0], [1, len / 4], [0, len / 4]]);
  // the two edges, down to the bank
  const lip = W.LAYER.bank;
  m.quad([[R.minX, lip, R.minZ], [R.minX, lip, R.maxZ], [R.minX, y, R.maxZ], [R.minX, y, R.minZ]], [-1, 0, 0], [[0, 0], [0, len / 4], [0.02, len / 4], [0.02, 0]]);
  m.quad([[R.maxX, lip, R.maxZ], [R.maxX, lip, R.minZ], [R.maxX, y, R.minZ], [R.maxX, y, R.maxZ]], [1, 0, 0], [[0.98, len / 4], [0.98, 0], [1, 0], [1, len / 4]]);
  return [m.spec('water', textured(waterTexture(), REPEAT_T))];
}

// A sky box: four walls with distant hills and a flat-coloured top, lit uniformly.
function buildSky() {
  const m = new Mesh(), top = new Mesh();
  const H = 44, y0 = -2, y1 = 44;
  const c = [[-H, -H + 3], [H, -H + 3], [H, H + 3], [-H, H + 3]]; // centred on the lot
  const walls = [
    [[c[0][0], c[0][1]], [c[1][0], c[1][1]]],
    [[c[1][0], c[1][1]], [c[2][0], c[2][1]]],
    [[c[2][0], c[2][1]], [c[3][0], c[3][1]]],
    [[c[3][0], c[3][1]], [c[0][0], c[0][1]]]
  ];
  walls.forEach(([a, b]) => m.quad([[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]], [0, 1, 0], [[0, 1], [1, 1], [1, 0], [0, 0]]));
  top.quad([[-H, y1, -H + 3], [H, y1, -H + 3], [H, y1, H + 3], [-H, y1, H + 3]], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  return [m.spec('skyWalls', textured(skyTexture(), CLAMP)), top.spec('skyTop', { baseColorFactor: [...skyColour([104, 160, 222]).map((v) => v / 255), 1] })];
}

// The rocky hill along the north-west edge, with a timbered mine front. One
// solid piece; the opening is only a dark recess.
function buildMine() {
  const M = W.MINE, rock = new Mesh(), turf = new Mesh(), wood = new Mesh(), dark = new Mesh();
  const ex0 = M.entranceX - M.entranceW / 2, ex1 = M.entranceX + M.entranceW / 2;
  const xs = [M.minX, -18.7, -17.6, -16.5, -15.4, -14.3, -13.2, ex0, ex1, -9.4, -8.3, -7.2, -6.1, -5.0, M.maxX];
  const zs = [M.maxZ, -14.0, -15.4, M.minZ]; // front row first
  const rowF = [0.62, 0.85, 1.1, 1.0];
  const hgt = zs.map((z, j) => xs.map((x, i) => {
    const edge = clamp01(Math.min(x - M.minX, M.maxX - x) / 2.5);
    const ridge = (3.4 + 2.0 * noise(x * 0.28, 3.3, 91, 0, 0) + 2.2 * Math.exp(-Math.pow((x + 8.8) / 3.0, 2))) * (0.6 + 0.4 * edge);
    let h = ridge * rowF[j] + (noise(x * 0.9 + j * 3.1, j * 1.7 + 0.2, 92, 0, 0) - 0.5) * 1.2;
    h = Math.max(1.3, h);
    if (j === 0 && x >= -13.3 && x <= -9.3) h = Math.max(h, 3.6);
    if (j === 0 && (x === ex0 || x === ex1)) h = 3.6;
    return h;
  }));
  const V = (i, j) => [xs[i], hgt[j][i], zs[j] + (j === 0 ? 0 : 0)];
  const rockU = rockUv(2), turfU = rockUv(8);
  // top surface: grass on gentle slopes, rock on steep ones
  for (let j = 0; j + 1 < zs.length; j++) for (let i = 0; i + 1 < xs.length; i++) {
    const a = V(i, j), b = V(i + 1, j), c = V(i + 1, j + 1), d = V(i, j + 1);
    for (const tri of [[a, b, c], [a, c, d]]) {
      const ux = tri[1][0] - tri[0][0], uy = tri[1][1] - tri[0][1], uz = tri[1][2] - tri[0][2], vx = tri[2][0] - tri[0][0], vy = tri[2][1] - tri[0][1], vz = tri[2][2] - tri[0][2];
      let ny = uz * vx - ux * vz; const nl = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) || 1;
      ny = Math.abs(ny) / nl;
      if (ny > 0.66) facet(turf, tri[0], tri[1], tri[2], turfU, [tri[0][0], -50, tri[0][2]]);
      else facet(rock, tri[0], tri[1], tri[2], rockU, [tri[0][0], -50, tri[0][2]]);
    }
  }
  const wall = (p0, p1, h0, h1, nrm) => { // vertical strip between two ground points, with top heights h0, h1
    const q = [[p0[0], 0, p0[1]], [p1[0], 0, p1[1]], [p1[0], h1, p1[1]], [p0[0], h0, p0[1]]];
    const uv = (p) => (Math.abs(nrm[0]) > 0.5 ? [p[2] / 2, -p[1] / 2] : [p[0] / 2, -p[1] / 2]);
    rock.quad(q, nrm, q.map(uv));
  };
  const front = zs[0], back = zs[zs.length - 1];
  for (let i = 0; i + 1 < xs.length; i++) {
    if (xs[i] === ex0) continue; // the opening
    wall([xs[i], front - 0.02], [xs[i + 1], front - 0.02], hgt[0][i], hgt[0][i + 1], [0, 0, 1]);
    wall([xs[i], back], [xs[i + 1], back], hgt[3][i], hgt[3][i + 1], [0, 0, -1]);
  }
  for (let j = 0; j + 1 < zs.length; j++) {
    wall([M.minX, zs[j]], [M.minX, zs[j + 1]], hgt[j][0], hgt[j + 1][0], [-1, 0, 0]);
    wall([M.maxX, zs[j]], [M.maxX, zs[j + 1]], hgt[j][xs.length - 1], hgt[j + 1][xs.length - 1], [1, 0, 0]);
  }
  // above the opening
  {
    const q = [[ex0, M.entranceH, front - 0.02], [ex1, M.entranceH, front - 0.02], [ex1, hgt[0][xs.indexOf(ex1)], front - 0.02], [ex0, hgt[0][xs.indexOf(ex0)], front - 0.02]];
    rock.quad(q, [0, 0, 1], q.map((p) => [p[0] / 2, -p[1] / 2]));
  }
  // the recess: dark walls, ceiling and back
  const depth = 0.9, zb = front - depth, yh = M.entranceH;
  dark.quad([[ex0, 0.03, zb], [ex1, 0.03, zb], [ex1, yh, zb], [ex0, yh, zb]], [0, 0, 1], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  dark.quad([[ex0, 0.03, front], [ex0, 0.03, zb], [ex0, yh, zb], [ex0, yh, front]], [1, 0, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  dark.quad([[ex1, 0.03, zb], [ex1, 0.03, front], [ex1, yh, front], [ex1, yh, zb]], [-1, 0, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  dark.quad([[ex0, yh, front], [ex1, yh, front], [ex1, yh, zb], [ex0, yh, zb]], [0, -1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  dark.quad([[ex0, 0.03, front], [ex1, 0.03, front], [ex1, 0.03, zb], [ex0, 0.03, zb]], [0, 1, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  // timber frame: posts, lintel and two cross braces, flush with the face
  const t = 0.3, fz0 = front - 0.2, fz1 = front;
  box(wood, [ex0 - t, 0, fz0], [ex0, yh + 0.35, fz1], 1);
  box(wood, [ex1, 0, fz0], [ex1 + t, yh + 0.35, fz1], 1);
  box(wood, [ex0 - t - 0.15, yh, fz0], [ex1 + t + 0.15, yh + 0.35, fz1], 1);
  box(wood, [ex0, yh - 0.45, fz0 - 0.0], [ex0 + 0.45, yh, fz1], 1, 'fl');
  box(wood, [ex1 - 0.45, yh - 0.45, fz0], [ex1, yh, fz1], 1, 'fr');
  return [
    rock.spec('rock', textured(rockTexture())),
    turf.spec('turf', textured(grassTexture())),
    wood.spec('timber', textured(woodTexture())),
    dark.spec('mineDark', rgb(26, 21, 19))
  ];
}

// ---------- reusable models (own origin, base on y = 0, front toward +z) ----------

const STONE = () => textured(portal.stoneTexture());
const STONE_TILE = [portal.STONE_TILE_W, portal.STONE_TILE_H];

// A quad with a computed normal that points away from `away`; texture coordinates from `uvFn`.
function quadN(mesh, pts, uvFn, away) {
  const a = pts[0], b = pts[1], c = pts[2];
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const len = Math.hypot(...n) || 1; n = n.map((q) => q / len);
  if (away) {
    const m = pts.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4, s[2] + p[2] / 4], [0, 0, 0]);
    if (n[0] * (m[0] - away[0]) + n[1] * (m[1] - away[1]) + n[2] * (m[2] - away[2]) < 0) n = n.map((q) => -q);
  }
  mesh.quad(pts, n, pts.map((p, i) => uvFn(p, i, n)));
}

function buildHut() {
  const stone = new Mesh(), wood = new Mesh(), roof = new Mesh(), dark = new Mesh(), glass = new Mesh(), door = new Mesh();
  const hx = 2.2, hz = 1.8, th = 0.15, y0 = 0.28, y1 = 2.15;
  box(stone, [-hx - 0.06, 0, -hz - 0.06], [hx + 0.06, y0, hz + 0.06], STONE_TILE);
  // walls: back, sides, front with the door opening
  box(wood, [-hx, y0, -hz], [hx, y1, -hz + th], 1);
  box(wood, [-hx, y0, -hz + th], [-hx + th, y1, hz - th], 1);
  box(wood, [hx - th, y0, -hz + th], [hx, y1, hz - th], 1);
  box(wood, [-hx, y0, hz - th], [-0.55, y1, hz], 1);
  box(wood, [0.55, y0, hz - th], [hx, y1, hz], 1);
  box(wood, [-0.55, 1.95, hz - th], [0.55, y1, hz], 1);
  // the doorway: a dark recess with a frame and a stone step
  dark.quad([[-0.55, y0, hz - 0.35], [0.55, y0, hz - 0.35], [0.55, 1.95, hz - 0.35], [-0.55, 1.95, hz - 0.35]], [0, 0, 1], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  dark.quad([[-0.55, y0, hz - th], [-0.55, y0, hz - 0.35], [-0.55, 1.95, hz - 0.35], [-0.55, 1.95, hz - th]], [1, 0, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  dark.quad([[0.55, y0, hz - 0.35], [0.55, y0, hz - th], [0.55, 1.95, hz - th], [0.55, 1.95, hz - 0.35]], [-1, 0, 0], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  box(door, [-0.72, y0, hz], [-0.55, 2.2, hz + 0.05], 1, 'frt');
  box(door, [0.55, y0, hz], [0.72, 2.2, hz + 0.05], 1, 'flt');
  box(door, [-0.72, 1.95, hz], [0.72, 2.2, hz + 0.06], 1, 'frlt');
  box(stone, [-0.85, 0, hz], [0.85, 0.16, hz + 0.32], STONE_TILE, 'fbrlt');
  // windows (decals on the wall): front left, both sides
  const win = (cx, y, ax, nrm) => { // ax: 'x' window on a front-facing wall, 'z' on a side wall
    const wdt = 0.34, hgt = 0.3, e = nrm * 0.012;
    const p = (a, b) => (ax === 'x' ? [cx + a, y + b, hz + e] : [e + (nrm > 0 ? hx : -hx), y + b, cx + a]);
    const q = [p(-wdt, -hgt), p(wdt, -hgt), p(wdt, hgt), p(-wdt, hgt)];
    glass.quad(q, ax === 'x' ? [0, 0, 1] : [nrm, 0, 0], [[0, 1], [1, 1], [1, 0], [0, 0]]);
    const bar = (x0, y0b, x1, y1b) => {
      const a = ax === 'x' ? [[cx + x0, y + y0b, hz + e * 2], [cx + x1, y + y0b, hz + e * 2], [cx + x1, y + y1b, hz + e * 2], [cx + x0, y + y1b, hz + e * 2]]
        : [[nrm * (hx + 0.024), y + y0b, cx + x0], [nrm * (hx + 0.024), y + y0b, cx + x1], [nrm * (hx + 0.024), y + y1b, cx + x1], [nrm * (hx + 0.024), y + y1b, cx + x0]];
      door.quad(a, ax === 'x' ? [0, 0, 1] : [nrm, 0, 0], [[0, 0.1], [1, 0.1], [1, 0.2], [0, 0.2]]);
    };
    bar(-wdt - 0.06, -hgt - 0.06, wdt + 0.06, -hgt); bar(-wdt - 0.06, hgt, wdt + 0.06, hgt + 0.06);
    bar(-wdt - 0.06, -hgt, -wdt, hgt); bar(wdt, -hgt, wdt + 0.06, hgt); bar(-0.025, -hgt, 0.025, hgt);
  };
  win(-1.45, 1.35, 'x', 1); win(0, 1.35, 'z', 1); win(0, 1.35, 'z', -1);
  // gable roof along x
  const rx = 2.6, eave = 2.15, ridge = 3.35, ez = 2.15;
  for (const s of [1, -1]) {
    const pts = [[-rx, eave, s * ez], [rx, eave, s * ez], [rx, ridge, 0], [-rx, ridge, 0]];
    quadN(roof, pts, (p) => [p[0] / 0.6, (Math.hypot(p[1] - eave, p[2] - s * ez)) / 0.6], [0, 0, 0]);
    // the slope's underside, so the eaves have thickness
    const under = [[-rx, eave - 0.06, s * ez], [rx, eave - 0.06, s * ez], [rx, ridge - 0.06, 0], [-rx, ridge - 0.06, 0]];
    quadN(wood, under, (p) => [p[0], -p[1]], [0, 9, 0]);
  }
  box(wood, [-rx - 0.05, ridge - 0.08, -0.09], [rx + 0.05, ridge + 0.05, 0.09], 1);
  for (const s of [1, -1]) { // gable ends
    const x = s * hx;
    wood.tri([[x, y1, -hz], [x, y1, hz], [x, 3.2, 0]], [s, 0, 0], [[-hz, -y1], [hz, -y1], [0, -3.2]]);
  }
  // chimney
  box(stone, [1.0, 2.0, -1.0], [1.5, 4.05, -0.55], STONE_TILE);
  box(stone, [0.95, 4.05, -1.05], [1.55, 4.18, -0.5], STONE_TILE);
  return [
    stone.spec('stone', STONE()),
    wood.spec('planks', textured(woodTexture())),
    roof.spec('shingles', textured(shingleTexture())),
    door.spec('trim', textured(woodTexture(), REPEAT, [0.62, 0.5, 0.42])),
    dark.spec('doorway', rgb(30, 24, 22)),
    glass.spec('glass', rgb(70, 92, 112))
  ];
}

const octagon = (apothem, y) => circlePts(0, 0, apothem / Math.cos(Math.PI / 8), 8, Math.PI / 8).map((p) => [p[0], y, p[1]]);

function buildFountain() {
  const stone = new Mesh(), water = new Mesh();
  const outer = octagon(1.6, 0), inner = octagon(1.3, 0);
  const H = 0.55;
  const ring = (pts, h, inward) => {
    let s = 0;
    for (let i = 0; i < 8; i++) {
      const a = pts[i], b = pts[(i + 1) % 8], len = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const nx = (a[0] + b[0]) / 2, nz2 = (a[2] + b[2]) / 2, nl = Math.hypot(nx, nz2);
      const n = [(inward ? -1 : 1) * nx / nl, 0, (inward ? -1 : 1) * nz2 / nl];
      const u0 = s / STONE_TILE[0], u1 = (s + len) / STONE_TILE[0];
      stone.quad([[a[0], 0, a[2]], [b[0], 0, b[2]], [b[0], h, b[2]], [a[0], h, a[2]]], n, [[u0, 0], [u1, 0], [u1, -h / STONE_TILE[1]], [u0, -h / STONE_TILE[1]]]);
      s += len;
    }
  };
  ring(outer, H, false); ring(inner, H, true);
  for (let i = 0; i < 8; i++) { // rim
    const a = outer[i], b = outer[(i + 1) % 8], c = inner[(i + 1) % 8], d = inner[i];
    stone.quad([[a[0], H, a[2]], [b[0], H, b[2]], [c[0], H, c[2]], [d[0], H, d[2]]], [0, 1, 0], [a, b, c, d].map((p) => [p[0] / STONE_TILE[0], p[2] / STONE_TILE[1]]));
  }
  // a stone bed under the water
  const bed = inner.map((p) => [p[0], 0.06, p[2]]);
  for (let i = 0; i < 8; i++) stone.tri([[0, 0.06, 0], bed[i], bed[(i + 1) % 8]], [0, 1, 0], [[0, 0], [bed[i][0] / STONE_TILE[0], bed[i][2] / STONE_TILE[1]], [bed[(i + 1) % 8][0] / STONE_TILE[0], bed[(i + 1) % 8][2] / STONE_TILE[1]]]);
  const wUv = (p) => [0.5 + p[0] / 3, 0.5 + p[2] / 3];
  const surface = (pts, y) => { for (let i = 0; i < 8; i++) water.tri([[0, y, 0], [pts[i][0], y, pts[i][2]], [pts[(i + 1) % 8][0], y, pts[(i + 1) % 8][2]]], [0, 1, 0], [[0.5, 0.5], wUv(pts[i]), wUv(pts[(i + 1) % 8])]); };
  surface(inner, 0.42);
  const stoneUvL = (p, n, i, k) => [i * 0.55, -p[1]];
  lathe(stone, [[0.06, 0.4], [0.45, 0.32], [1.1, 0.24], [1.28, 0.3]], 8, Math.PI / 8, { uv: stoneUvL });
  lathe(stone, [[1.2, 0.34], [1.38, 0.78], [1.52, 0.86]], 8, Math.PI / 8, { uv: stoneUvL });
  const bowl = octagon(0.74, 1.46).map((p) => [p[0], 1.44, p[2]]);
  surface(bowl, 1.44);
  lathe(stone, [[1.5, 0.16], [1.7, 0.1], [1.92, 0.0]], 8, Math.PI / 8, { uv: stoneUvL });
  return [stone.spec('stone', STONE()), water.spec('water', textured(waterTexture(), REPEAT))];
}

function buildPier() {
  const deck = new Mesh(), sides = new Mesh(), posts = new Mesh();
  const hx = (W.PIER.maxX - W.PIER.minX) / 2, hz = (W.PIER.maxZ - W.PIER.minZ) / 2;
  box(deck, [-hx, 0, -hz], [hx, 0.09, hz], [1, 1], 't', true);
  box(sides, [-hx, 0, -hz], [hx, 0.09, hz], 1, 'fbrl');
  for (const x of [-hx + 0.1, -hx / 3, hx / 3, hx - 0.1]) for (const z of [-hz + 0.08, hz - 0.08]) {
    box(posts, [x - 0.07, 0.09, z - 0.07], [x + 0.07, 0.72, z + 0.07], 1);
  }
  // two taller mooring posts at the tip
  for (const z of [-hz + 0.2, hz - 0.2]) box(posts, [hx - 0.3, 0.09, z - 0.08], [hx - 0.14, 0.95, z + 0.08], 1);
  return [deck.spec('decking', textured(woodTexture())), sides.spec('edge', textured(woodTexture(), REPEAT, [0.72, 0.66, 0.6])), posts.spec('posts', textured(woodTexture(), REPEAT, [0.68, 0.6, 0.55]))];
}

function buildHedge() {
  const m = new Mesh();
  const L = 4.0, hb = 0.4, ht = 0.28, hgt = 1.1;
  const uv = (p) => [p[0], -p[1]];
  for (const s of [1, -1]) {
    const q = [[-L / 2, 0, s * hb], [L / 2, 0, s * hb], [L / 2, hgt, s * ht], [-L / 2, hgt, s * ht]];
    quadN(m, q, uv, [0, 0.4, 0]);
  }
  for (const s of [1, -1]) {
    const q = [[s * L / 2, 0, -hb], [s * L / 2, 0, hb], [s * L / 2, hgt, ht], [s * L / 2, hgt, -ht]];
    quadN(m, q, (p) => [p[2], -p[1]], [0, 0.4, 0]);
  }
  m.quad([[-L / 2, hgt, ht], [L / 2, hgt, ht], [L / 2, hgt, -ht], [-L / 2, hgt, -ht]], [0, 1, 0], [[0, 0], [4, 0], [4, 0.56], [0, 0.56]]);
  return [m.spec('leaves', textured(hedgeTexture()))];
}

// A faceted rock: an icosphere with noisy radii, flattened and sunk onto y = 0.
function blob(mesh, radius, seed, squash, sink) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((v) => { const l = Math.hypot(...v); return v.map((q) => q / l); });
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const cache = new Map();
  const mid = (a, b) => {
    const k = a < b ? a + ':' + b : b + ':' + a;
    if (!cache.has(k)) { const m = verts[a].map((q, i) => (q + verts[b][i]) / 2); const l = Math.hypot(...m); verts.push(m.map((q) => q / l)); cache.set(k, verts.length - 1); }
    return cache.get(k);
  };
  const next = [];
  faces.forEach(([a, b, c]) => { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); });
  faces = next;
  const pts = verts.map((v) => {
    const r = radius * (0.8 + 0.4 * noise(v[0] * 2 + seed, v[1] * 2 + v[2] * 1.7, seed, 0, 0));
    return [v[0] * r, v[1] * r * squash, v[2] * r];
  });
  const minY = Math.min(...pts.map((p) => p[1]));
  pts.forEach((p) => { p[1] += -minY - sink; });
  const uv = rockUv(2);
  faces.forEach(([a, b, c]) => facet(mesh, pts[a], pts[b], pts[c], uv, [0, radius * 0.3, 0]));
}
const buildBoulder = (radius, seed) => () => { const m = new Mesh(); blob(m, radius, seed, 0.78, 0.12); return [m.spec('rock', textured(rockTexture()))]; };

function buildPine() {
  const trunk = new Mesh(), a = new Mesh(), b = new Mesh();
  lathe(trunk, [[0, 0.15], [0.7, 0.11]], 6, 0, { cap: 't' });
  [[0.5, 1.15, 1.9, a], [1.3, 0.95, 2.8, b], [2.2, 0.72, 3.8, a], [3.1, 0.46, 4.6, b]].forEach(([y0, r, y1, mesh]) => lathe(mesh, [[y0, r], [y1, 0]], 8, 0, { cap: 'b' }));
  return [trunk.spec('trunk', rgb(98, 68, 46)), a.spec('needlesA', rgb(46, 94, 62)), b.spec('needlesB', rgb(56, 108, 70))];
}

function buildBarrel() {
  const body = new Mesh(), hoop = new Mesh(), lid = new Mesh();
  lathe(body, [[0, 0.22], [0.2, 0.27], [0.42, 0.29], [0.64, 0.27], [0.84, 0.22]], 8, Math.PI / 8, {});
  lathe(hoop, [[0.16, 0.268], [0.2, 0.275]], 8, Math.PI / 8, {});
  lathe(hoop, [[0.64, 0.27], [0.68, 0.272]], 8, Math.PI / 8, {});
  lathe(lid, [[0.84, 0.22], [0.845, 0.0]], 8, Math.PI / 8, { cap: 't' });
  return [body.spec('staves', rgb(150, 104, 62)), hoop.spec('hoops', rgb(70, 62, 58)), lid.spec('lid', rgb(124, 86, 54))];
}

function buildOreCart() {
  const wood = new Mesh(), iron = new Mesh(), ore = new Mesh();
  box(wood, [-0.55, 0.28, -0.32], [0.55, 0.36, 0.32], 1);
  box(wood, [-0.55, 0.36, -0.32], [0.55, 0.72, -0.26], 1);
  box(wood, [-0.55, 0.36, 0.26], [0.55, 0.72, 0.32], 1);
  box(wood, [-0.55, 0.36, -0.26], [-0.49, 0.72, 0.26], 1);
  box(wood, [0.49, 0.36, -0.26], [0.55, 0.72, 0.26], 1);
  for (const x of [-0.34, 0.34]) for (const z of [-0.37, 0.37]) {
    const w = new Mesh();
    lathe(w, [[-0.04, 0.2], [0.04, 0.2]], 8, 0, { cap: 'tb' });
    // wheel axis along z: rotate the y-lathe into place by swapping axes
    for (let i = 0; i < w.positions.length; i += 3) {
      const px = w.positions[i], py = w.positions[i + 1], pz = w.positions[i + 2];
      w.positions[i] = x + px; w.positions[i + 1] = 0.2 + pz; w.positions[i + 2] = z + py;
      const nx = w.normals[i], ny = w.normals[i + 1], nz2 = w.normals[i + 2];
      w.normals[i] = nx; w.normals[i + 1] = nz2; w.normals[i + 2] = ny;
    }
    const base = iron.positions.length / 3;
    iron.positions.push(...w.positions); iron.normals.push(...w.normals); iron.uvs.push(...w.uvs); iron.indices.push(...w.indices.map((q) => q + base));
  }
  blob(ore, 0.17, 5, 0.8, 0); blob(ore, 0.14, 6, 0.8, 0); blob(ore, 0.12, 7, 0.8, 0);
  const sh = [[-0.22, 0.0], [0.14, 0.06], [0.0, -0.08]];
  const moved = new Mesh();
  const n = ore.positions.length / 3 / 3;
  for (let k = 0; k < 3; k++) {
    for (let i = k * n; i < (k + 1) * n; i++) {
      moved.positions.push(ore.positions[i * 3] + sh[k][0], ore.positions[i * 3 + 1] + 0.62, ore.positions[i * 3 + 2] + sh[k][1]);
      moved.normals.push(ore.normals[i * 3], ore.normals[i * 3 + 1], ore.normals[i * 3 + 2]);
    }
  }
  moved.indices = ore.indices.slice();
  return [wood.spec('wood', textured(woodTexture(), REPEAT, [0.8, 0.7, 0.62])), iron.spec('iron', rgb(64, 60, 62)), moved.spec('ore', rgb(120, 112, 108))];
}

function buildWoodPile() {
  const bark = new Mesh(), ends = new Mesh();
  const rows = [[4, 0.13, -0.39], [3, 0.36, -0.26], [2, 0.59, -0.13]];
  rows.forEach(([count, y, x0]) => {
    for (let i = 0; i < count; i++) {
      const x = x0 + i * 0.26, w = new Mesh();
      lathe(w, [[-0.5, 0.12], [0.5, 0.12]], 6, 0, { cap: 'tb' });
      // axis y -> z; the round ends become the end faces
      for (let k = 0; k < w.positions.length; k += 3) {
        const px = w.positions[k], py = w.positions[k + 1], pz = w.positions[k + 2];
        w.positions[k] = x + px; w.positions[k + 1] = y + pz; w.positions[k + 2] = py;
        const ny = w.normals[k + 1], nz2 = w.normals[k + 2];
        w.normals[k + 1] = nz2; w.normals[k + 2] = ny;
      }
      // sides are bark, the cap triangles (normals along z) are the cut ends
      for (let t = 0; t < w.indices.length; t += 3) {
        const a = w.indices[t];
        const target = Math.abs(w.normals[a * 3 + 2]) > 0.99 ? ends : bark;
        const base = target.positions.length / 3;
        for (let q = 0; q < 3; q++) {
          const v = w.indices[t + q];
          target.positions.push(w.positions[v * 3], w.positions[v * 3 + 1], w.positions[v * 3 + 2]);
          target.normals.push(w.normals[v * 3], w.normals[v * 3 + 1], w.normals[v * 3 + 2]);
        }
        target.indices.push(base, base + 1, base + 2);
      }
    }
  });
  return [bark.spec('bark', rgb(112, 78, 50)), ends.spec('cutEnds', rgb(196, 156, 104))];
}

function buildFlowerBed() {
  const soil = new Mesh(), leaf = new Mesh();
  box(soil, [-0.9, 0, -0.35], [0.9, 0.12, 0.35], 1);
  box(leaf, [-0.82, 0.12, -0.27], [0.82, 0.2, 0.27], 1, 'fbrlt');
  const cols = [[226, 112, 140], [238, 200, 70], [240, 240, 230], [150, 110, 200]];
  const flowers = cols.map(() => new Mesh());
  for (let i = 0; i < 20; i++) {
    const x = -0.76 + hash(i, 1, 99) * 1.52, z = -0.21 + hash(i, 2, 99) * 0.42, h = 0.2 + hash(i, 3, 99) * 0.1;
    box(flowers[i % 4], [x - 0.04, h, z - 0.04], [x + 0.04, h + 0.08, z + 0.04], 1);
  }
  return [soil.spec('soil', rgb(88, 62, 44)), leaf.spec('foliage', rgb(70, 124, 62))].concat(flowers.map((f, i) => f.spec('bloom' + i, rgb(...cols[i]))));
}

function buildStoneWall() {
  const m = new Mesh();
  box(m, [-1.5, 0, -0.2], [1.5, 0.55, 0.2], STONE_TILE);
  box(m, [-1.55, 0.55, -0.26], [1.55, 0.65, 0.26], STONE_TILE);
  return [m.spec('stone', STONE())];
}

// One post with an arrow board per zone, each tilted toward the zone it names (at most 35 degrees off the
// east-west line so the lettering stays readable from the plaza).
function buildSignpost() {
  const post = new Mesh();
  const wood = new Mesh();
  box(post, [-0.07, 0, -0.07], [0.07, 2.55, 0.07], 1);
  box(post, [-0.1, 2.55, -0.1], [0.1, 2.62, 0.1], 1);
  box(post, [-0.18, 0, -0.18], [0.18, 0.1, 0.18], 1);
  const [sx, sz] = W.SIGNPOST.at;
  const boards = W.SIGNPOST.boards.map((b, k) => {
    const dx = b.to[0] - sx, dz = b.to[1] - sz;
    const side = dx >= 0 ? 1 : -1;
    const phi = Math.max(-35, Math.min(35, Math.atan2(-dz, Math.abs(dx)) * 180 / Math.PI)) * Math.PI / 180;
    const r = [Math.cos(phi), 0, -side * Math.sin(phi)]; // viewer's right along the board
    const n = [-r[2], 0, r[0]]; // front face, toward +z
    const y = 1.0 + k * 0.34;
    const u0 = side > 0 ? -0.15 : -1.05, u1 = side > 0 ? 1.05 : 0.15, tip = side > 0 ? 1.23 : -1.23;
    const off = 0.1; // boards stand proud of the post so the lettering is never hidden by it
    const P = (u, v, w) => [r[0] * u + n[0] * (w + off), y + v, r[2] * u + n[2] * (w + off)];
    const face = new Mesh();
    const t = 0.025, h = 0.3;
    face.quad([P(u0, 0, t), P(u1, 0, t), P(u1, h, t), P(u0, h, t)], n, [[0, 1], [1, 1], [1, 0], [0, 0]]);
    const tipEdge = side > 0 ? [P(u1, 0, t), P(tip, h / 2, t), P(u1, h, t)] : [P(u0, h, t), P(tip, h / 2, t), P(u0, 0, t)];
    face.tri(tipEdge, n, tipEdge.map(() => [side > 0 ? 0.99 : 0.01, 0.5]));
    const back = n.map((q) => -q);
    wood.quad([P(u1, 0, -t), P(u0, 0, -t), P(u0, h, -t), P(u1, h, -t)], back, [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]);
    const tipBack = side > 0 ? [P(u1, h, -t), P(tip, h / 2, -t), P(u1, 0, -t)] : [P(u0, 0, -t), P(tip, h / 2, -t), P(u0, h, -t)];
    wood.tri(tipBack, back, tipBack.map(() => [0.5, 0.5]));
    // edges: top, bottom and the two tip edges, as thin strips
    const strip = (a0, a1, nn) => wood.quad([[a0[0] + n[0] * t, a0[1], a0[2] + n[2] * t], [a1[0] + n[0] * t, a1[1], a1[2] + n[2] * t], [a1[0] - n[0] * t, a1[1], a1[2] - n[2] * t], [a0[0] - n[0] * t, a0[1], a0[2] - n[2] * t]], nn, [[0.5, 0.5], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]]);
    const base0 = P(u0, 0, 0), base1 = P(u1, 0, 0), top0 = P(u0, h, 0), top1 = P(u1, h, 0), tipP = P(tip, h / 2, 0);
    strip(base0, base1, [0, -1, 0]); strip(top0, top1, [0, 1, 0]);
    if (side > 0) { strip(base1, tipP, [0, -1, 0]); strip(tipP, top1, [0, 1, 0]); } else { strip(tipP, base0, [0, -1, 0]); strip(top0, tipP, [0, 1, 0]); }
    return face.spec('sign' + b.label, textured(signTexture(b.label), CLAMP));
  });
  return [post.spec('post', textured(woodTexture(), REPEAT, [0.62, 0.52, 0.46])), wood.spec('boardEdges', textured(woodTexture(), REPEAT, [0.85, 0.75, 0.65]))].concat(boards);
}

// ---------- registry and CLI ----------

const MODELS = {
  townGround: buildGround, townPaths: buildPaths, riverBanks: buildRiverBanks, riverWater: buildRiverWater, townSky: buildSky,
  mineHill: buildMine, hut: buildHut, fountain: buildFountain, pier: buildPier, hedge: buildHedge,
  boulderLarge: buildBoulder(0.9, 3), boulderSmall: buildBoulder(0.5, 9), pine: buildPine, barrel: buildBarrel, oreCart: buildOreCart,
  woodPile: buildWoodPile, flowerBed: buildFlowerBed, stoneWall: buildStoneWall, townSignpost: buildSignpost
};

function buildModel(name) {
  return buildMultiGlb({ name, primitives: MODELS[name]() });
}

if (require.main === module) {
  const only = process.argv.indexOf('--only') > 0 ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null;
  const names = Object.keys(MODELS).filter((n) => !only || only.includes(n));
  if (only) only.forEach((n) => { if (!MODELS[n]) throw new Error('Unknown model ' + n + '; known: ' + Object.keys(MODELS).join(', ')); });
  fs.mkdirSync(path.join(REPO, OUT_DIR), { recursive: true });
  names.forEach((n) => {
    const glb = buildModel(n);
    fs.writeFileSync(path.join(REPO, OUT_DIR, n + '.glb'), glb);
    console.log('wrote ' + path.join(OUT_DIR, n + '.glb') + ' (' + glb.length + ' bytes)');
  });
}

module.exports = { MODELS, OUT_DIR, buildModel };
