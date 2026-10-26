// Shared helpers for the procedural asset generators (tools/make-*-glb.js):
// deterministic value noise, small colour helpers, a 5x7 pixel font and a mesh
// accumulator. Moved here unchanged from make-town-portal-glb.js.

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

// ---------- pixel font ----------

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

// ---------- mesh ----------

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

module.exports = { hash, mod, smooth, noise, clamp01, mix, mixRgb, scaleRgb, toPx, FONT, Mesh };
