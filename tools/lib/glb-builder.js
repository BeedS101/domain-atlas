// Small GLB 2.0 writer used by the texture asset generators and the texture
// tests. buildGlb() builds one mesh with POSITION, optional NORMAL/TEXCOORD_0,
// one material, and an optional PNG/JPEG embedded in the BIN chunk through a
// bufferView. buildMultiGlb() builds one mesh with several primitives, each
// with its own material and optional embedded texture. `mutateJson(json)`
// lets a test damage the glTF on purpose.

const zlib = require('zlib');

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function be32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }
const pad4 = (buf, fill) => (buf.length % 4 === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4), fill)]));

function assembleGlb(json, bin) {
  const jsonBuf = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const binBuf = pad4(Buffer.from(bin), 0);
  const jsonChunk = Buffer.concat([u32(jsonBuf.length), Buffer.from('JSON', 'ascii'), jsonBuf]);
  const binChunk = Buffer.concat([u32(binBuf.length), Buffer.from('BIN\0', 'ascii'), binBuf]);
  return Buffer.concat([Buffer.from('glTF', 'ascii'), u32(2), u32(12 + jsonChunk.length + binChunk.length), jsonChunk, binChunk]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 8-bit RGBA PNG; pixel(x, y) returns [r, g, b, a] (y = 0 is the top row).
function makePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const p = pixel(x, y);
      for (let c = 0; c < 4; c++) raw[y * (width * 4 + 1) + 1 + x * 4 + c] = p[c];
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    return Buffer.concat([be32(data.length), body, be32(crc32(body))]);
  };
  const ihdr = Buffer.concat([be32(width), be32(height), Buffer.from([8, 6, 0, 0, 0])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// spec: { positions, normals?, uvs?, indices?, baseColorFactor?,
//         texture?: { bytes, mimeType, sampler?, texCoord? }, mutateJson? }
function buildGlb(spec) {
  const parts = [];
  const bufferViews = [], accessors = [];
  let offset = 0;
  function addView(data, target) {
    const raw = data.buffer ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: raw.length, ...(target ? { target } : {}) });
    const padded = pad4(raw, 0);
    parts.push(padded); offset += padded.length;
    return bufferViews.length - 1;
  }
  function addAccessor(typed, type, componentType, extra) {
    const view = addView(typed, 34962);
    accessors.push({ bufferView: view, componentType, count: typed.length / ({ VEC2: 2, VEC3: 3, SCALAR: 1 }[type]), type, ...(extra || {}) });
    return accessors.length - 1;
  }
  const positions = Float32Array.from(spec.positions);
  const mins = [Infinity, Infinity, Infinity], maxs = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { mins[k] = Math.min(mins[k], positions[i + k]); maxs[k] = Math.max(maxs[k], positions[i + k]); }
  const attributes = { POSITION: addAccessor(positions, 'VEC3', 5126, { min: mins, max: maxs }) };
  if (spec.normals) attributes.NORMAL = addAccessor(Float32Array.from(spec.normals), 'VEC3', 5126);
  if (spec.uvs) attributes.TEXCOORD_0 = addAccessor(Float32Array.from(spec.uvs), 'VEC2', 5126);
  const primitive = { attributes, material: 0 };
  if (spec.indices) {
    const idx = Uint16Array.from(spec.indices);
    const view = addView(idx, 34963);
    accessors.push({ bufferView: view, componentType: 5123, count: idx.length, type: 'SCALAR' });
    primitive.indices = accessors.length - 1;
  }
  const pbr = { baseColorFactor: spec.baseColorFactor || [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 };
  const json = {
    asset: { version: '2.0', generator: 'domain-atlas glb-builder' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [primitive] }],
    materials: [{ pbrMetallicRoughness: pbr, doubleSided: true }],
    accessors, bufferViews
  };
  if (spec.texture) {
    const t = spec.texture;
    const imageView = addView(t.bytes);
    json.images = [{ bufferView: imageView, mimeType: t.mimeType }];
    json.textures = [{ source: 0, ...(t.sampler ? { sampler: 0 } : {}) }];
    if (t.sampler) json.samplers = [t.sampler];
    pbr.baseColorTexture = { index: 0, ...(t.texCoord !== undefined ? { texCoord: t.texCoord } : {}) };
  }
  json.buffers = [{ byteLength: offset }];
  if (spec.mutateJson) spec.mutateJson(json);
  return assembleGlb(json, Buffer.concat(parts));
}

// spec: { name?, primitives: [{ positions, normals?, uvs?, indices?,
//   material: { baseColorFactor?, texture?: { bytes, mimeType, sampler? } } }] }
// A texture whose `bytes` Buffer (and sampler values) match an earlier one
// reuses that image and sampler instead of embedding another copy.
function buildMultiGlb(spec) {
  const parts = [];
  const bufferViews = [], accessors = [], images = [], samplers = [], textures = [], materials = [], primitives = [];
  let offset = 0;
  function addView(data, target) {
    const raw = data.buffer ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: raw.length, ...(target ? { target } : {}) });
    const padded = pad4(raw, 0);
    parts.push(padded); offset += padded.length;
    return bufferViews.length - 1;
  }
  function addAccessor(typed, type, componentType, extra) {
    const view = addView(typed, 34962);
    accessors.push({ bufferView: view, componentType, count: typed.length / ({ VEC2: 2, VEC3: 3, SCALAR: 1 }[type]), type, ...(extra || {}) });
    return accessors.length - 1;
  }
  const imageOf = new Map();
  const samplerKeys = new Map();
  const textureKeys = new Map();
  function textureIndex(t) {
    let img = imageOf.get(t.bytes);
    if (img === undefined) {
      images.push({ bufferView: addView(t.bytes), mimeType: t.mimeType });
      img = images.length - 1;
      imageOf.set(t.bytes, img);
    }
    let smp;
    if (t.sampler) {
      const sk = JSON.stringify(t.sampler);
      smp = samplerKeys.get(sk);
      if (smp === undefined) { samplers.push(t.sampler); smp = samplers.length - 1; samplerKeys.set(sk, smp); }
    }
    const tk = img + ':' + smp;
    let tex = textureKeys.get(tk);
    if (tex === undefined) {
      textures.push({ source: img, ...(smp !== undefined ? { sampler: smp } : {}) });
      tex = textures.length - 1;
      textureKeys.set(tk, tex);
    }
    return tex;
  }
  spec.primitives.forEach((p) => {
    const positions = Float32Array.from(p.positions);
    const mins = [Infinity, Infinity, Infinity], maxs = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { mins[k] = Math.min(mins[k], positions[i + k]); maxs[k] = Math.max(maxs[k], positions[i + k]); }
    const attributes = { POSITION: addAccessor(positions, 'VEC3', 5126, { min: mins, max: maxs }) };
    if (p.normals) attributes.NORMAL = addAccessor(Float32Array.from(p.normals), 'VEC3', 5126);
    if (p.uvs) attributes.TEXCOORD_0 = addAccessor(Float32Array.from(p.uvs), 'VEC2', 5126);
    const prim = { attributes, material: materials.length };
    if (p.indices) {
      const idx = Uint16Array.from(p.indices);
      const view = addView(idx, 34963);
      accessors.push({ bufferView: view, componentType: 5123, count: idx.length, type: 'SCALAR' });
      prim.indices = accessors.length - 1;
    }
    const pbr = { baseColorFactor: (p.material && p.material.baseColorFactor) || [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 };
    if (p.material && p.material.texture) pbr.baseColorTexture = { index: textureIndex(p.material.texture) };
    materials.push({ ...(p.name ? { name: p.name } : {}), pbrMetallicRoughness: pbr, doubleSided: true });
    primitives.push(prim);
  });
  const json = {
    asset: { version: '2.0', generator: 'domain-atlas glb-builder' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: spec.name || 'model', mesh: 0 }],
    meshes: [{ primitives }],
    materials, accessors, bufferViews, buffers: [{ byteLength: offset }]
  };
  if (images.length) { json.images = images; json.textures = textures; }
  if (samplers.length) json.samplers = samplers;
  return assembleGlb(json, Buffer.concat(parts));
}

// A flat vertical quad, 1 wide x 1 tall, standing on y = 0 and facing +z, with
// the image upright across it (glTF UV (0,0) = top-left of the image).
function quadSpec() {
  return {
    positions: [-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 1, 1, 1, 1, 0, 0, 0],
    indices: [0, 1, 2, 0, 2, 3]
  };
}

module.exports = { buildGlb, buildMultiGlb, makePng, assembleGlb, quadSpec, crc32 };
