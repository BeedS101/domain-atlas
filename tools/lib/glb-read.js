// Minimal GLB reader for the asset generators: parses the container and flattens
// the node graph of the bundled furniture models into world-space triangle
// lists, one per material, so a generator can re-emit them with
// tools/lib/glb-builder.js (buildMultiGlb) under different materials.
// Supports the subset the bundled models use: float POSITION/NORMAL, optional
// TEXCOORD_0, 16/32-bit indices, node translation/rotation/scale/matrix.

const fs = require('fs');

function parseGlb(buf) {
  if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB');
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen;
  const bin = binStart < buf.length ? buf.slice(binStart + 8, binStart + 8 + buf.readUInt32LE(binStart)) : Buffer.alloc(0);
  return { json, bin };
}

function accessor(json, bin, index) {
  const a = json.accessors[index];
  const view = json.bufferViews[a.bufferView];
  const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const Type = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array, 5121: Uint8Array }[a.componentType];
  const start = (view.byteOffset || 0) + (a.byteOffset || 0);
  const stride = view.byteStride;
  if (stride && stride !== width * Type.BYTES_PER_ELEMENT) throw new Error('interleaved accessors are not supported');
  const copy = bin.buffer.slice(bin.byteOffset + start, bin.byteOffset + start + a.count * width * Type.BYTES_PER_ELEMENT);
  return { data: new Type(copy), width, count: a.count };
}

// Column-major 4x4 helpers.
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function nodeMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const t = node.translation || [0, 0, 0], q = node.rotation || [0, 0, 0, 1], s = node.scale || [1, 1, 1];
  const [x, y, z, w] = q;
  const r = [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1
  ];
  for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) r[c * 4 + k] *= s[c];
  r[12] = t[0]; r[13] = t[1]; r[14] = t[2];
  return r;
}

// Returns [{ material: <glTF material object>, materialIndex, positions, normals, indices }]
// in model space (node transforms applied). Triangles of one material from
// different nodes are merged.
function flattenGlb(file) {
  const { json, bin } = parseGlb(typeof file === 'string' ? fs.readFileSync(file) : file);
  const byMaterial = new Map();
  function visit(nodeIndex, parent) {
    const node = json.nodes[nodeIndex];
    const m = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const prim of json.meshes[node.mesh].primitives) {
        if (prim.mode !== undefined && prim.mode !== 4) throw new Error('only triangle primitives are supported');
        const pos = accessor(json, bin, prim.attributes.POSITION).data;
        const nor = prim.attributes.NORMAL !== undefined ? accessor(json, bin, prim.attributes.NORMAL).data : null;
        const idx = prim.indices !== undefined ? accessor(json, bin, prim.indices).data : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
        let acc = byMaterial.get(prim.material);
        if (!acc) { acc = { materialIndex: prim.material, material: json.materials[prim.material], positions: [], normals: [], indices: [] }; byMaterial.set(prim.material, acc); }
        const base = acc.positions.length / 3;
        for (let i = 0; i < pos.length; i += 3) {
          const x = pos[i], y = pos[i + 1], z = pos[i + 2];
          acc.positions.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
          if (nor) {
            const nx = nor[i], ny = nor[i + 1], nz = nor[i + 2];
            const ox = m[0] * nx + m[4] * ny + m[8] * nz, oy = m[1] * nx + m[5] * ny + m[9] * nz, oz = m[2] * nx + m[6] * ny + m[10] * nz;
            const l = Math.hypot(ox, oy, oz) || 1;
            acc.normals.push(ox / l, oy / l, oz / l);
          } else acc.normals.push(0, 1, 0);
        }
        for (let i = 0; i < idx.length; i++) acc.indices.push(base + idx[i]);
      }
    }
    (node.children || []).forEach((c) => visit(c, m));
  }
  (json.scenes[json.scene || 0].nodes).forEach((n) => visit(n, identity()));
  return [...byMaterial.values()];
}

// Splits a flattened primitive into per-triangle vertices, calling
// `uvFor(point, faceNormal, triangle)` for each corner so every triangle can be
// projected on its own plane. Returns { positions, normals, uvs, indices }.
function projectTriangles(prim, uvFor) {
  const positions = [], normals = [], uvs = [], indices = [];
  for (let t = 0; t < prim.indices.length; t += 3) {
    const corners = [0, 1, 2].map((k) => {
      const i = prim.indices[t + k];
      return { p: [prim.positions[i * 3], prim.positions[i * 3 + 1], prim.positions[i * 3 + 2]], n: [prim.normals[i * 3], prim.normals[i * 3 + 1], prim.normals[i * 3 + 2]] };
    });
    const e1 = corners[1].p.map((v, c) => v - corners[0].p[c]), e2 = corners[2].p.map((v, c) => v - corners[0].p[c]);
    const f = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const fl = Math.hypot(...f) || 1;
    const faceNormal = f.map((v) => v / fl);
    const tri = { points: corners.map((c) => c.p), normals: corners.map((c) => c.n), faceNormal };
    const base = positions.length / 3;
    corners.forEach((c) => {
      positions.push(...c.p); normals.push(...c.n);
      uvs.push(...uvFor(c.p, faceNormal, tri));
    });
    indices.push(base, base + 1, base + 2);
  }
  return { positions, normals, uvs, indices };
}

module.exports = { parseGlb, flattenGlb, projectTriangles };
