#!/usr/bin/env node
// Generates demo-domain-a/assets/texture-test/textureTestBoard.glb: a small
// original upright board (1 x 1 x 0.1, standing on y = 0, front facing +z)
// with a 16x16 PNG embedded in the GLB, used to check base-colour texture
// support and UV orientation in gltf-mini.js.
//
// The image has four differently coloured quadrants (top-left red,
// top-right green, bottom-left blue, bottom-right yellow) and a white "L" in
// the top-left quadrant, so any flip or rotation of the UVs is obvious. Its
// sampler uses nearest magnification and clamp-to-edge so the pixels stay
// crisp. Both faces show the image the right way round.
//
// Usage: node tools/make-texture-test-glb.js

const fs = require('fs');
const path = require('path');
const { buildGlb, makePng } = require('./lib/glb-builder');

const RED = [220, 40, 40, 255], GREEN = [40, 190, 60, 255], BLUE = [50, 80, 230, 255], YELLOW = [240, 210, 40, 255], WHITE = [255, 255, 255, 255];
const png = makePng(16, 16, (x, y) => {
  // white "L": a vertical bar with a foot, inside the top-left quadrant
  if ((x === 2 || x === 3) && y >= 2 && y <= 5) return WHITE;
  if ((y === 5 || y === 4) && x >= 2 && x <= 5) return WHITE;
  if (y < 8) return x < 8 ? RED : GREEN;
  return x < 8 ? BLUE : YELLOW;
});

// Faces as [corner positions in order, normal, uv per corner]. Corner order is
// counter-clockwise seen from outside.
const W = 0.5, D = 0.05;
const faces = [
  { n: [0, 0, 1], p: [[-W, 0, D], [W, 0, D], [W, 1, D], [-W, 1, D]], uv: [[0, 1], [1, 1], [1, 0], [0, 0]] }, // front
  { n: [0, 0, -1], p: [[W, 0, -D], [-W, 0, -D], [-W, 1, -D], [W, 1, -D]], uv: [[0, 1], [1, 1], [1, 0], [0, 0]] }, // back, read from behind
  { n: [1, 0, 0], p: [[W, 0, D], [W, 0, -D], [W, 1, -D], [W, 1, D]], uv: [[1, 1], [1, 1], [1, 1], [1, 1]] }, // right edge: a flat colour
  { n: [-1, 0, 0], p: [[-W, 0, -D], [-W, 0, D], [-W, 1, D], [-W, 1, -D]], uv: [[0, 1], [0, 1], [0, 1], [0, 1]] },
  { n: [0, 1, 0], p: [[-W, 1, D], [W, 1, D], [W, 1, -D], [-W, 1, -D]], uv: [[0, 0], [0, 0], [0, 0], [0, 0]] },
  { n: [0, -1, 0], p: [[-W, 0, -D], [W, 0, -D], [W, 0, D], [-W, 0, D]], uv: [[0, 1], [0, 1], [0, 1], [0, 1]] }
];
const positions = [], normals = [], uvs = [], indices = [];
faces.forEach((f) => {
  const base = positions.length / 3;
  f.p.forEach((p, i) => { positions.push(...p); normals.push(...f.n); uvs.push(...f.uv[i]); });
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
});

const glb = buildGlb({
  positions, normals, uvs, indices,
  baseColorFactor: [1, 1, 1, 1],
  texture: { bytes: png, mimeType: 'image/png', sampler: { magFilter: 9728, minFilter: 9984, wrapS: 33071, wrapT: 33071 } }
});
const out = path.resolve(__dirname, '..', 'demo-domain-a', 'assets', 'texture-test', 'textureTestBoard.glb');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, glb);
console.log('wrote ' + out + ' (' + glb.length + ' bytes)');
