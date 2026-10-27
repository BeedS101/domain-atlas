// Data checks (no browser) for the world-drop render guard in gltf-mini.js
// and its generic fallback model:
//
//   1. The drop policy: defaults, partial overrides, invalid values.
//   2. Image size is read from PNG and JPEG headers, without decoding.
//   3. Model cost: triangles, primitives, distinct textures and the largest
//      texture come from the parsed primitives, and each limit is enforced
//      one at a time; node-instancing is caught from the glTF JSON alone.
//   4. The bundled fallback model is tiny, one untextured material, a closed
//      shape with outward normals, and is exactly what the generator makes.
//   5. Existing bundled models fit the default limits.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { buildMultiGlb, makePng, quadSpec } = require(path.join(__dirname, '..', 'tools', 'lib', 'glb-builder'));
const fallbackTool = require(path.join(__dirname, '..', 'tools', 'make-drop-fallback-model.js'));

const REPO = path.resolve(__dirname, '..');
const warnings = [];
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(REPO, 'extension', 'gltf-mini.js'), 'utf8'), {
  window: sandbox.window, document: {}, console: { log: console.log, warn: (m) => warnings.push(String(m)), error: console.error },
  Float32Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, DataView, ArrayBuffer, TextDecoder, Math, Map, Set, Promise, Array, Object, Number, JSON,
  performance: { now: () => 0 }, navigator: {}, indexedDB: {}, isFinite, Infinity, Error, String, Date, RegExp
});
const L = sandbox.window.MiniGLTF.layout;

let checks = 0;
const pass = (msg) => { checks++; console.log('PASS: ' + msg); };
const plain = (v) => JSON.parse(JSON.stringify(v));
const extract = (glb) => {
  const { json, bin } = L.parseGLB(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));
  return { json, ...L.extractPrimitives(json, bin) };
};
const png = (w, h, fn) => ({ bytes: makePng(w, h, fn || (() => [200, 100, 50, 255])), mimeType: 'image/png' });
const quad = (material) => buildMultiGlb({ primitives: [{ ...quadSpec(), material }] });

// ---- 1. policy ----
const D = L.DEFAULT_DROP_POLICY;
assert.deepStrictEqual(plain(L.normalizeDropPolicy(undefined)), plain(D));
assert.deepStrictEqual(plain(L.normalizeDropPolicy(null)), plain(D));
assert.deepStrictEqual(plain(L.normalizeDropPolicy([1, 2])), plain(D), 'an array is not a policy');
assert.deepStrictEqual(plain(L.normalizeDropPolicy({ maxModelBytes: 500000 })), { ...plain(D), maxModelBytes: 500000 }, 'a partial policy overrides only what it names');
warnings.length = 0;
const bad = plain(L.normalizeDropPolicy({ maxTriangles: 0, maxTextureSize: 'big', maxTextures: -3, maxModelBytes: NaN, maxPrimitives: Infinity, unknownKnob: 5 }));
assert.deepStrictEqual(bad, plain(D), 'invalid values and unknown keys fall back to the defaults');
assert.strictEqual(warnings.length, 5, 'each ignored value is reported once: ' + warnings.length);
assert.strictEqual(L.normalizeDropPolicy({ maxTriangles: 1234.9 }).maxTriangles, 1234, 'numbers are floored');
assert.deepStrictEqual(plain(D), { maxModelBytes: 1000000, maxTriangles: 50000, maxTextureSize: 1024, maxTextures: 4, maxPrimitives: 32 }, 'the documented defaults');
pass('policy defaults are 1 MB / 50k triangles / 1024 px / 4 textures / 32 primitives; partial and invalid policies are handled');

// ---- 2. image sizes ----
const u8 = (b) => new Uint8Array(b);
assert.deepStrictEqual(plain(L.imageDimensions(u8(makePng(37, 21, () => [0, 0, 0, 255])), 'image/png')), { width: 37, height: 21 });
assert.deepStrictEqual(plain(L.imageDimensions(u8(makePng(4096, 2048, () => [9, 9, 9, 255])), 'image/png')), { width: 4096, height: 2048 }, 'a large image is measured from its header');
// a minimal JPEG: SOI, an APP0 segment, SOF0 (precision, height, width, ...), then junk
const jpeg = (w, h) => u8([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x4A, 0x46, 0xFF, 0xC0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xFF, 0xD9]);
assert.deepStrictEqual(plain(L.imageDimensions(jpeg(640, 480), 'image/jpeg')), { width: 640, height: 480 });
assert.deepStrictEqual(plain(L.imageDimensions(jpeg(3000, 2000), 'image/jpeg')), { width: 3000, height: 2000 });
assert.strictEqual(L.imageDimensions(u8([0x89, 0x50, 0x4E, 0x47]), 'image/png'), null, 'a truncated PNG header is unreadable');
assert.strictEqual(L.imageDimensions(u8([0xFF, 0xD8, 0xFF, 0xD9]), 'image/jpeg'), null, 'a JPEG with no frame header is unreadable');
assert.strictEqual(L.imageDimensions(u8(100), 'image/gif'), null);
pass('PNG and JPEG sizes come from the header without decoding; unreadable headers give null');

// ---- 3. model cost and limits ----
const plainModel = extract(quad({}));
let st = L.modelStats(plainModel.primitives, 1234);
assert.deepStrictEqual(plain(st), { bytes: 1234, triangles: 2, primitives: 1, textures: 0, maxTextureSize: 0 });
assert.strictEqual(L.dropPolicyViolation(st, D), null, 'a plain quad is within the defaults');
const tex = extract(quad({ texture: png(64, 32), emissiveFactor: [1, 1, 1], emissiveTexture: png(16, 16, () => [1, 2, 3, 255]), normalTexture: png(128, 8, () => [128, 128, 255, 255]) }));
st = L.modelStats(tex.primitives, 10);
assert.strictEqual(st.textures, 3, 'distinct embedded images are counted');
assert.strictEqual(st.maxTextureSize, 128, 'the largest side of any image');
const big = extract(quad({ texture: png(2048, 16) }));
assert.strictEqual(L.modelStats(big.primitives, 10).maxTextureSize, 2048);
const shared = (() => { const t = png(32, 32); return extract(quad({ texture: t, emissiveFactor: [1, 1, 1], emissiveTexture: t, normalTexture: t })); })();
assert.strictEqual(L.modelStats(shared.primitives, 10).textures, 1, 'one image used in three slots is one texture');
const one = (over) => ({ bytes: 100, triangles: 10, primitives: 1, textures: 1, maxTextureSize: 64, ...over });
const lim = { maxModelBytes: 1000, maxTriangles: 100, maxTextureSize: 128, maxTextures: 2, maxPrimitives: 3 };
assert.strictEqual(L.dropPolicyViolation(one({}), lim), null);
assert.strictEqual(L.dropPolicyViolation(one({ bytes: 1001 }), lim).reason, 'bytes');
assert.strictEqual(L.dropPolicyViolation(one({ triangles: 101 }), lim).reason, 'triangles');
assert.strictEqual(L.dropPolicyViolation(one({ primitives: 4 }), lim).reason, 'primitives');
assert.strictEqual(L.dropPolicyViolation(one({ textures: 3 }), lim).reason, 'textures');
assert.strictEqual(L.dropPolicyViolation(one({ maxTextureSize: 129 }), lim).reason, 'textureSize');
assert.strictEqual(L.dropPolicyViolation(one({ maxTextureSize: Infinity }), lim).reason, 'textureSize', 'an unreadable image size counts as too large');
assert.strictEqual(L.dropPolicyViolation(one({ bytes: 1000, triangles: 100, primitives: 3, textures: 2, maxTextureSize: 128 }), lim), null, 'exactly at every limit is allowed');
assert.strictEqual(L.dropPolicyViolation(undefined, lim), null, 'a model without stats (a placeholder) is not refused');
// node instancing: one small mesh placed by 5000 nodes
const inst = quad({});
const parsed = L.parseGLB(inst.buffer.slice(inst.byteOffset, inst.byteOffset + inst.byteLength)).json;
const instJson = JSON.parse(JSON.stringify(parsed));
instJson.nodes = Array.from({ length: 5000 }, () => ({ mesh: 0 }));
instJson.scenes = [{ nodes: instJson.nodes.map((_, i) => i) }];
const cost = L.estimateGltfCost(instJson);
assert.strictEqual(cost.primitives, 5000); assert.strictEqual(cost.triangles, 10000);
assert.strictEqual(L.dropPolicyViolation({ bytes: 1, triangles: cost.triangles, primitives: cost.primitives, textures: 0, maxTextureSize: 0 }, D).reason, 'primitives', 'an instanced model is refused from its JSON, before anything is read out of it');
assert.deepStrictEqual(plain(L.estimateGltfCost(parsed)), { triangles: 2, primitives: 1 });
pass('model cost is measured; every limit refuses on its own and allows exactly-at-limit; instancing is caught from the JSON');

// ---- 4. the fallback model ----
const fbPath = path.join(REPO, 'extension', 'models', 'drop-fallback.glb');
const fbBytes = fs.readFileSync(fbPath);
assert(fbBytes.equals(fallbackTool.build()), 'the file is exactly what tools/make-drop-fallback-model.js produces');
assert(fbBytes.length < 10 * 1024, 'the fallback is tiny: ' + fbBytes.length + ' bytes');
const fb = extract(fbBytes);
const fbStats = L.modelStats(fb.primitives, fbBytes.length);
assert.strictEqual(fb.json.materials.length, 1, 'one material');
assert.strictEqual(fbStats.textures, 0, 'no texture, so no GPU texture');
assert(fbStats.triangles <= 20 && fbStats.primitives === 1, 'very few triangles: ' + fbStats.triangles);
assert.strictEqual(L.dropPolicyViolation(fbStats, D), null, 'it satisfies the default policy itself');
const centre = [(fb.bounds.min[0] + fb.bounds.max[0]) / 2, (fb.bounds.min[1] + fb.bounds.max[1]) / 2, (fb.bounds.min[2] + fb.bounds.max[2]) / 2];
const prim = fb.primitives[0];
for (let i = 0; i < prim.positions.length; i += 3) {
  const out = [prim.positions[i] - centre[0], prim.positions[i + 1] - centre[1], prim.positions[i + 2] - centre[2]];
  const n = [prim.normals[i], prim.normals[i + 1], prim.normals[i + 2]];
  assert(out[0] * n[0] + out[1] * n[1] + out[2] * n[2] > 0, 'every normal points away from the middle (vertex ' + i / 3 + ')');
}
assert(fb.bounds.size.every((v) => v > 0.4 && v < 0.6), 'about half a metre across: ' + fb.bounds.size);
pass('the fallback is ' + fbBytes.length + ' bytes, 1 material, no texture, ' + fbStats.triangles + ' triangles, outward normals, current with its generator');

// ---- 5. bundled models fit the defaults ----
const dirs = ['demo-domain-a/assets', 'demo-domain-b/assets'];
let measured = 0;
dirs.forEach((d) => fs.readdirSync(path.join(REPO, d)).filter((f) => f.endsWith('.glb')).forEach((f) => {
  const b = fs.readFileSync(path.join(REPO, d, f));
  const m = extract(b);
  const why = L.dropPolicyViolation(L.modelStats(m.primitives, b.length), D);
  assert.strictEqual(why, null, d + '/' + f + ' should fit the default drop policy, got ' + JSON.stringify(why));
  measured++;
}));
assert(measured >= 4);
pass(measured + ' item models bundled with the demo domains fit the default limits');

console.log('\nALL ' + checks + ' DROP GUARD UNIT CHECKS PASSED');
