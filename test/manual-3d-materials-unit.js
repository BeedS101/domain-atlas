// Data checks (no browser, no GL) for gltf-mini-v1's optional material
// features. extractPrimitives() describes what the GPU step will use:
//   - emissiveFactor / emissiveTexture (texCoord 0), added after lighting;
//   - normalTexture (tangent-space), only when the primitive has TEXCOORD_0 and
//     NORMAL, otherwise the model keeps its vertex normals;
//   - alphaMode MASK with alphaCutoff (OPAQUE and BLEND stay opaque);
//   - KHR_materials_unlit;
//   - the scene-level fog description (normalizeFog).
// Anything malformed or unsupported drops just that feature, with a warning,
// and never the model. Every bundled GLB still extracts exactly as before.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { buildMultiGlb, makePng, quadSpec } = require(path.join(__dirname, '..', 'tools', 'lib', 'glb-builder'));

const REPO = path.resolve(__dirname, '..');
const warnings = [];
const quietConsole = { log: console.log, warn: (m) => warnings.push(String(m)), error: console.error };
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(REPO, 'extension', 'gltf-mini.js'), 'utf8'), {
  window: sandbox.window, document: {}, console: quietConsole, Float32Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array,
  DataView, ArrayBuffer, TextDecoder, Math, Map, Set, Promise, Array, Object, Number, JSON,
  performance: { now: () => 0 }, navigator: {}, indexedDB: {}, isFinite, Infinity, Error, String, Date, RegExp
});
const L = sandbox.window.MiniGLTF.layout;

let checks = 0;
const plain = (v) => JSON.parse(JSON.stringify(v));
const eq = (actual, expected, msg) => assert.deepStrictEqual(plain(actual), expected, msg);
const pass = (msg) => { checks++; console.log('PASS: ' + msg); };
const extract = (glb) => {
  const { json, bin } = L.parseGLB(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));
  return L.extractPrimitives(json, bin);
};
const NEW_KEYS = ['emissive', 'emissiveTexture', 'normalTexture', 'normalScale', 'mask', 'alphaCutoff', 'unlit'];
const model = (material, geometry) => buildMultiGlb({ primitives: [{ ...quadSpec(), ...(geometry || {}), material }] });
const only = (glb) => { const r = extract(glb); assert.strictEqual(r.primitives.length, 1, 'the primitive must still be drawn'); return r.primitives[0]; };
const tex = (fill) => ({ bytes: makePng(4, 4, () => fill || [128, 128, 255, 255]), mimeType: 'image/png' });

// ---- emissiveFactor ----
{
  let p = only(model({ emissiveFactor: [0, 1, 0.5] }));
  eq(p.emissive, [0, 1, 0.5], 'emissiveFactor is kept');
  assert(!p.textureWarning, 'no warning for a valid factor');
  eq(only(model({ emissiveFactor: [2, -1, 0.25] })).emissive, [1, 0, 0.25], 'factor values are clamped to 0..1');
  assert.strictEqual(only(model({})).emissive, undefined, 'no factor: not emissive');
  assert.strictEqual(only(model({ emissiveFactor: [0, 0, 0] })).emissive, undefined, 'a black factor is not emissive');
  for (const [name, bad] of Object.entries({ 'two numbers': [1, 1], 'strings': ['1', '0', '0'], 'a number': 1, 'null entries': [null, 0, 0], 'four numbers': [1, 1, 1, 1] })) {
    warnings.length = 0;
    p = only(model({ emissiveFactor: bad }));
    assert.strictEqual(p.emissive, undefined, name + ': not emissive');
    assert(/emissiveFactor/.test(p.textureWarning || ''), name + ': warned');
    eq(p.color, [1, 1, 1, 1], name + ': flat colour kept');
  }
  pass('emissiveFactor: kept and clamped; absent, black or malformed factors leave the material non-emissive (malformed ones warn)');
}

// ---- emissiveTexture ----
{
  const t = tex([255, 255, 255, 255]);
  let p = only(model({ emissiveFactor: [1, 1, 1], emissiveTexture: t }));
  assert(p.emissiveTexture && p.emissiveTexture.mime === 'image/png' && p.emissiveTexture.bytes.length > 8, 'the emissive image is resolved');
  eq(p.emissive, [1, 1, 1], 'factor kept next to the texture');
  assert(!p.textureWarning, 'no warning');
  p = only(model({ emissiveTexture: t }));
  assert(p.emissive === undefined && p.emissiveTexture === undefined && !p.textureWarning, 'without a factor (glTF default 0,0,0) a texture adds no glow and is not decoded');
  // fall-backs: every case is non-emissive, warned, still drawn in its flat colour
  const base = { emissiveFactor: [1, 1, 1] };
  const cases = {
    'texCoord 1': [{ ...base, emissiveTexture: { ...t, texCoord: 1 } }, undefined],
    'wrong image magic': [{ ...base, emissiveTexture: { bytes: Buffer.from('not a png at all, just text'), mimeType: 'image/png' } }, undefined],
    'unsupported mime': [{ ...base, emissiveTexture: { bytes: t.bytes, mimeType: 'image/webp' } }, undefined],
    'no UVs on the primitive': [{ ...base, emissiveTexture: t }, { uvs: undefined }]
  };
  for (const [name, [material, geometry]] of Object.entries(cases)) {
    p = only(model(material, geometry));
    assert(p.emissive === undefined && p.emissiveTexture === undefined, name + ': falls back to the non-emissive material');
    assert(/emissiveTexture/.test(p.textureWarning || ''), name + ': warned (' + p.textureWarning + ')');
    eq(p.color, [1, 1, 1, 1], name + ': flat colour kept');
  }
  // a broken bufferView
  const glb = model({ ...base, emissiveTexture: t });
  const { json, bin } = L.parseGLB(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));
  json.bufferViews[json.images[0].bufferView].byteLength = 1e9;
  p = L.extractPrimitives(json, bin).primitives[0];
  assert(p.emissive === undefined && /outside the BIN/.test(p.textureWarning), 'an image outside the BIN chunk: non-emissive, warned');
  pass('emissiveTexture: resolved with its factor; ' + Object.keys(cases).length + ' kinds of unusable texture (and a broken bufferView) fall back to non-emissive with a warning');
}

// ---- normalTexture ----
{
  const t = tex([128, 128, 255, 255]);
  let p = only(model({ normalTexture: t }));
  assert(p.normalTexture && p.normalTexture.mime === 'image/png', 'the normal map is resolved');
  assert.strictEqual(p.normalScale, 1, 'default scale 1');
  assert(p.normals && p.uvs, 'the primitive keeps its vertex normals and UVs');
  assert.strictEqual(only(model({ normalTexture: { ...t, scale: 0.4 } })).normalScale, 0.4, 'scale is read');
  const cases = {
    'no TEXCOORD_0': [{ normalTexture: t }, { uvs: undefined }, /TEXCOORD_0/],
    'no NORMAL': [{ normalTexture: t }, { normals: undefined }, /no NORMAL/],
    'texCoord 1': [{ normalTexture: { ...t, texCoord: 1 } }, undefined, /TEXCOORD_1/],
    'wrong image magic': [{ normalTexture: { bytes: Buffer.alloc(40, 7), mimeType: 'image/png' } }, undefined, /does not match/]
  };
  for (const [name, [material, geometry, why]] of Object.entries(cases)) {
    const r = extract(model(material, geometry));
    assert.strictEqual(r.primitives.length, 1, name + ': the model is not rejected');
    p = r.primitives[0];
    assert(p.normalTexture === undefined && p.normalScale === undefined, name + ': no normal map (vertex normals are used)');
    assert(why.test(p.textureWarning || ''), name + ': warned (' + p.textureWarning + ')');
    eq(p.color, [1, 1, 1, 1], name + ': colour kept');
    assert(p.positions.length === 12, name + ': geometry intact');
  }
  pass('normalTexture: resolved with its scale; missing UVs/normals, texCoord 1 or a bad image keep the vertex normals (warned, model kept)');
}

// ---- alpha mode ----
{
  assert.strictEqual(only(model({ alphaMode: 'MASK' })).mask, true);
  assert.strictEqual(only(model({ alphaMode: 'MASK' })).alphaCutoff, 0.5, 'default cutoff 0.5');
  assert.strictEqual(only(model({ alphaMode: 'MASK', alphaCutoff: 0.3 })).alphaCutoff, 0.3);
  assert.strictEqual(only(model({ alphaMode: 'MASK', alphaCutoff: 0 })).alphaCutoff, 0);
  assert.strictEqual(only(model({ alphaMode: 'MASK', alphaCutoff: 3 })).alphaCutoff, 1, 'cutoff above 1 is clamped');
  for (const bad of [-1, 'x', null]) assert.strictEqual(only(model({ alphaMode: 'MASK', alphaCutoff: bad })).alphaCutoff, 0.5, 'an invalid cutoff falls back to 0.5 (' + bad + ')');
  for (const mode of [undefined, 'OPAQUE', 'BLEND', 'nonsense']) {
    warnings.length = 0;
    const p = only(model({ alphaMode: mode }));
    assert(p.mask === undefined && p.alphaCutoff === undefined, 'alphaMode ' + mode + ' stays opaque');
    assert(!p.textureWarning, 'alphaMode ' + mode + ' adds no warning');
  }
  pass('alphaMode: MASK with alphaCutoff (default 0.5, clamped, invalid values defaulted); OPAQUE, BLEND and unknown modes stay opaque without warnings');
}

// ---- unlit ----
{
  assert.strictEqual(only(model({ unlit: true })).unlit, true, 'KHR_materials_unlit is read');
  assert.strictEqual(only(model({})).unlit, undefined, 'lit by default');
  const glb = model({});
  const { json, bin } = L.parseGLB(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));
  json.materials[0].extensions = { KHR_materials_unlit: {} }; // without extensionsUsed: still honoured
  assert.strictEqual(L.extractPrimitives(json, bin).primitives[0].unlit, true);
  pass('unlit: KHR_materials_unlit on the material; everything else stays lit');
}

// ---- features together, and texture sharing ----
{
  const shared = tex([200, 100, 50, 255]);
  const p = only(model({ texture: shared, emissiveFactor: [1, 0.5, 0], emissiveTexture: shared, normalTexture: shared, alphaMode: 'MASK', alphaCutoff: 0.25 }));
  assert(p.baseColorTexture && p.emissiveTexture && p.normalTexture && p.mask && p.emissive, 'all features together');
  assert.strictEqual(p.baseColorTexture.key, p.emissiveTexture.key, 'one image with one sampler has one key, so it is uploaded once');
  assert.strictEqual(p.baseColorTexture.key, p.normalTexture.key);
  pass('features combine on one primitive; a shared image has a shared texture key');
}

// ---- scene fog ----
{
  warnings.length = 0;
  const f = (v) => plain(L.normalizeFog(v));
  eq(f({ color: '#c9d7d7', near: 25, far: 60 }), { color: [0xc9 / 255, 0xd7 / 255, 0xd7 / 255], near: 25, far: 60 }, 'valid fog');
  eq(f({ color: '#fff', near: 0, far: 1 }), { color: [1, 1, 1], near: 0, far: 1 }, 'short hex colour, near 0');
  assert.strictEqual(f(undefined), null, 'no fog by default'); assert.strictEqual(f(null), null);
  assert.strictEqual(warnings.length, 0, 'an absent fog is silent');
  const bad = {
    'not an object': 'fog', 'array': [1, 2, 3], 'no colour': { near: 1, far: 2 }, 'colour without #': { color: 'c9d7d7', near: 1, far: 2 },
    'colour name': { color: 'red', near: 1, far: 2 }, 'colour wrong length': { color: '#c9d7', near: 1, far: 2 }, 'colour not a string': { color: 0xc9d7d7, near: 1, far: 2 },
    'near negative': { color: '#fff', near: -1, far: 2 }, 'near string': { color: '#fff', near: '1', far: 2 }, 'near NaN': { color: '#fff', near: NaN, far: 2 },
    'far equals near': { color: '#fff', near: 5, far: 5 }, 'far below near': { color: '#fff', near: 5, far: 4 }, 'far infinite': { color: '#fff', near: 5, far: Infinity },
    'missing far': { color: '#fff', near: 1 }
  };
  for (const [name, v] of Object.entries(bad)) {
    warnings.length = 0;
    assert.strictEqual(L.normalizeFog(v), null, name + ': fog is ignored');
    assert(warnings.length === 1 && /fog/.test(warnings[0]), name + ': one warning (' + warnings.join('|') + ')');
  }
  pass('fog: absent means off (silently); a valid fog is normalised; ' + Object.keys(bad).length + ' invalid declarations are ignored with a warning');
}

// ---- every bundled model is unchanged ----
{
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f); else if (f.endsWith('.glb')) files.push(f);
  });
  ['demo-domain-a', 'demo-domain-b'].forEach((d) => walk(path.join(REPO, d, 'assets')));
  // assets/lobby/interior and assets/lobby/exterior hold the Lobby's deliberate material-feature models (see manual-3d-lobby-interior-unit.js)
  const interiorDir = path.join('assets', 'lobby', 'interior') + path.sep;
  const exteriorDir = path.join('assets', 'lobby', 'exterior') + path.sep;
  files.splice(0, files.length, ...files.filter((f) => !f.includes(interiorDir) && !f.includes(exteriorDir)));
  assert(files.length > 100, 'expected the bundled models, found ' + files.length);
  let withBlend = 0;
  files.forEach((f) => {
    const buf = fs.readFileSync(f);
    const { json, bin } = L.parseGLB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if ((json.materials || []).some((m) => m.alphaMode === 'BLEND')) withBlend++;
    const r = L.extractPrimitives(json, bin);
    r.primitives.forEach((p) => {
      NEW_KEYS.forEach((k) => assert(p[k] === undefined, path.relative(REPO, f) + ' must not pick up "' + k + '"'));
      if (!p.baseColorTexture) assert(!p.textureWarning, path.relative(REPO, f) + ' must not start warning: ' + p.textureWarning);
    });
  });
  // the bundled models only list KHR_materials_unlit in extensionsUsed; none of their materials use it
  assert(withBlend > 0, 'the bundled set does include BLEND materials, which stay opaque');
  pass('all ' + files.length + ' bundled GLBs extract with none of the new fields and no new warnings (' + withBlend + ' with BLEND materials, still opaque)');
}

console.log('\nALL ' + checks + ' MATERIAL DATA CHECKS PASSED');
