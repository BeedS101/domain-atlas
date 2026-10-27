#!/usr/bin/env node
// Generates the generic world-drop fallback model, extension/models/drop-fallback.glb:
// a small faceted gem (8 triangles, flat amber, one material, no texture) that
// the renderer shows for a dropped item whose own model is over the drop
// render policy or cannot be loaded. Deterministic.
//
// Usage: node tools/make-drop-fallback-model.js [--check]
//   (no flag)  write the model
//   --check    verify the committed file is current, write nothing

const fs = require('fs');
const path = require('path');
const { buildMultiGlb } = require('./lib/glb-builder');

const OUT = path.join(__dirname, '..', 'extension', 'models', 'drop-fallback.glb');

function gemSpec() {
  const r = 0.25, cy = 0.25; // 0.5 m across, sitting on y = 0
  const top = [0, cy + r, 0], bottom = [0, cy - r, 0];
  const ring = [[r, cy, 0], [0, cy, r], [-r, cy, 0], [0, cy, -r]];
  const positions = [], normals = [], indices = [];
  const face = (a, b, c) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...n) || 1;
    n = n.map((x) => x / l);
    const base = positions.length / 3;
    [a, b, c].forEach((p) => { positions.push(...p.map((x) => Math.round(x * 1e4) / 1e4)); normals.push(...n.map((x) => Math.round(x * 1e4) / 1e4)); });
    indices.push(base, base + 1, base + 2);
  };
  for (let i = 0; i < 4; i++) {
    const a = ring[i], b = ring[(i + 1) % 4];
    face(top, b, a); // outward, counter-clockwise seen from outside
    face(bottom, a, b);
  }
  return { positions, normals, indices };
}

function build() {
  return buildMultiGlb({ primitives: [{ ...gemSpec(), material: { baseColorFactor: [0.95, 0.7, 0.2, 1], emissiveFactor: [0.3, 0.2, 0.05] } }] });
}

if (require.main === module) {
  const glb = build();
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(OUT) || !fs.readFileSync(OUT).equals(glb)) { console.error('extension/models/drop-fallback.glb is not current; run tools/make-drop-fallback-model.js'); process.exit(1); }
    console.log('drop fallback model is current (' + glb.length + ' bytes)');
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, glb);
    console.log('wrote ' + path.relative(process.cwd(), OUT) + ' (' + glb.length + ' bytes)');
  }
}
module.exports = { build, OUT };
