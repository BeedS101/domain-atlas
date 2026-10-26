// Shared helpers for the Lobby town tests: the renderer's own placement and
// collision math (extension/gltf-mini.js layout helpers, run in a vm without a
// browser) applied to the real scene.json, plus a grid walkability search.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
const DOMAIN_DIR = path.join(REPO, 'demo-domain-a');

function loadLayout() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(REPO, 'extension', 'gltf-mini.js'), 'utf8'), {
    window: sandbox.window, document: {}, console, Float32Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array,
    DataView, ArrayBuffer, TextDecoder, Math, Map, Set, Promise, Array, Object, Number, JSON,
    performance: { now: () => 0 }, navigator: {}, indexedDB: {}, isFinite, Infinity, Error, String, Date
  });
  return sandbox.window.MiniGLTF.layout;
}

const L = loadLayout();
const parseGlb = (buf) => L.parseGLB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

const boundsCache = {};
function modelBounds(url) {
  if (!boundsCache[url]) {
    const g = parseGlb(fs.readFileSync(path.join(DOMAIN_DIR, url.replace(/^\//, ''))));
    boundsCache[url] = L.extractPrimitives(g.json, g.bin).bounds;
  }
  return boundsCache[url];
}

function readScene() {
  return JSON.parse(fs.readFileSync(path.join(DOMAIN_DIR, 'spatial', 'lobby', 'scene.json'), 'utf8'));
}

// The solids the renderer collides with, and the floor limits, for a scene.
function collision(scene) {
  const items = scene.objects.map((o) => ({ solid: o.solid !== false && o.collision !== false, footprint: L.placedFootprint(modelBounds(o.model), L.normalizePlacement(o)), model: o.model }));
  const solids = L.selectSolidItems(items);
  const limits = L.floorWalkLimits(scene.floor);
  // blocked(x, z, radius): the same rule the renderer applies (a body of `radius` overlapping a solid or the floor edge)
  const blocked = (x, z, radius) => {
    let d = L.floorOverrun(limits, x, z);
    if (d > 0) return true;
    for (const s of solids) { d += L.footprintDepth(s.footprint, x, z, radius === undefined ? L.PLAYER_RADIUS : radius); if (d > 0) return true; }
    return false;
  };
  return { solids, limits, blocked, items };
}

// A walkability grid over the scene's floor.
function makeGrid(scene, radius, step) {
  const st = step || 0.1;
  const [fw, fd] = scene.floor.size, [cx, cz] = scene.floor.center;
  const g = { step: st, x0: cx - fw / 2, z0: cz - fd / 2, nx: Math.round(fw / st), nz: Math.round(fd / st) };
  const col = collision(scene);
  g.cells = new Uint8Array(g.nx * g.nz);
  for (let j = 0; j < g.nz; j++) for (let i = 0; i < g.nx; i++) g.cells[j * g.nx + i] = col.blocked(g.x0 + (i + 0.5) * st, g.z0 + (j + 0.5) * st, radius) ? 1 : 0;
  g.idx = (x, z) => Math.floor((z - g.z0) / st) * g.nx + Math.floor((x - g.x0) / st);
  g.at = (k) => [g.x0 + ((k % g.nx) + 0.5) * st, g.z0 + (Math.floor(k / g.nx) + 0.5) * st];
  return g;
}

// 8-connected flood fill over free cells from `start`; `skip(x, z)` excludes cells. Returns a Uint8Array mask, or null if the start is blocked.
function flood(g, start, skip) {
  const first = g.idx(start[0], start[1]);
  if (g.cells[first]) return null;
  const seen = new Uint8Array(g.nx * g.nz);
  const queue = [first]; seen[first] = 1;
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h], i = c % g.nx, j = (c - i) / g.nx;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= g.nx || nj >= g.nz) continue;
      const n = nj * g.nx + ni;
      if (seen[n] || g.cells[n]) continue;
      if (skip) { const [x, z] = g.at(n); if (skip(x, z)) continue; }
      seen[n] = 1; queue.push(n);
    }
  }
  return seen;
}

// 4-connected groups of cells selected by `pick`, each as { cells, x: [min, max], z: [min, max] }.
function groups(g, pick) {
  const seen = new Uint8Array(g.nx * g.nz), out = [];
  for (let k = 0; k < g.nx * g.nz; k++) {
    if (seen[k] || !pick(k)) continue;
    const queue = [k]; seen[k] = 1;
    let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
    for (let h = 0; h < queue.length; h++) {
      const c = queue[h], i = c % g.nx, j = (c - i) / g.nx;
      mnx = Math.min(mnx, i); mxx = Math.max(mxx, i); mnz = Math.min(mnz, j); mxz = Math.max(mxz, j);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const ni = i + di, nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= g.nx || nj >= g.nz) continue;
        const n = nj * g.nx + ni;
        if (!seen[n] && pick(n)) { seen[n] = 1; queue.push(n); }
      }
    }
    out.push({ cells: queue.length, x: [+(g.x0 + mnx * g.step).toFixed(1), +(g.x0 + (mxx + 1) * g.step).toFixed(1)], z: [+(g.z0 + mnz * g.step).toFixed(1), +(g.z0 + (mxz + 1) * g.step).toFixed(1)] });
  }
  return out.sort((a, b) => b.cells - a.cells);
}

// A walking route from `a` to `b` over a grid: breadth-first path, then pulled straight wherever a segment is
// clear for a body of `radius` (checked against the collision model every 5 cm). `avoid(x, z)` excludes cells.
function route(g, col, radius, a, b, avoid) {
  const start = g.idx(a[0], a[1]), goal = g.idx(b[0], b[1]);
  if (g.cells[start] || g.cells[goal]) return null;
  const prev = new Int32Array(g.nx * g.nz).fill(-1);
  prev[start] = start;
  const queue = [start];
  for (let h = 0; h < queue.length && prev[goal] < 0; h++) {
    const c = queue[h], i = c % g.nx, j = (c - i) / g.nx;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= g.nx || nj >= g.nz) continue;
      const n = nj * g.nx + ni;
      if (prev[n] >= 0 || g.cells[n]) continue;
      if (avoid) { const [x, z] = g.at(n); if (avoid(x, z)) continue; }
      prev[n] = c; queue.push(n);
    }
  }
  if (prev[goal] < 0) return null;
  const cells = [];
  for (let c = goal; c !== start; c = prev[c]) cells.push(g.at(c));
  cells.push(a);
  cells.reverse();
  cells[cells.length - 1] = b;
  const clear = (p, q) => {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    for (let t = 0; t <= len; t += 0.05) {
      const x = p[0] + (q[0] - p[0]) * t / (len || 1), z = p[1] + (q[1] - p[1]) * t / (len || 1);
      if (col.blocked(x, z, radius) || (avoid && avoid(x, z))) return false;
    }
    return true;
  };
  const out = [cells[0]];
  let at = 0;
  while (at < cells.length - 1) {
    let far = at + 1;
    for (let k = cells.length - 1; k > at + 1; k--) if (clear(cells[at], cells[k])) { far = k; break; }
    out.push(cells[far]); at = far;
  }
  return out;
}

module.exports = { route, REPO, DOMAIN_DIR, L, parseGlb, modelBounds, readScene, collision, makeGrid, flood, groups };
