// Data checks (no browser, no GL) for gltf-mini-v1's base-colour texture
// support. extractPrimitives() describes what the GPU step will upload:
//   - TEXCOORD_0 is read (float and normalized 8/16-bit), and ignored when
//     malformed;
//   - material -> texture -> image resolves for images embedded in the BIN
//     chunk as PNG or JPEG, with the sampler (or the defaults);
//   - baseColorFactor is kept next to the texture so the shader can multiply;
//   - anything unsupported or malformed leaves the primitive in its flat
//     colour with a warning, never throwing;
//   - models without textures need no UVs, and every bundled GLB is still
//     described as an untextured model.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { JPEG_QUADS, quadrantPng, quadGlb, buildGlb, makePng, quadSpec } = require('./texture-test-lib');

const REPO = path.resolve(__dirname, '..');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(REPO, 'extension', 'gltf-mini.js'), 'utf8'), {
  window: sandbox.window, document: {}, console, Float32Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array,
  DataView, ArrayBuffer, TextDecoder, Math, Map, Set, Promise, Array, Object, Number, JSON,
  performance: { now: () => 0 }, navigator: {}, indexedDB: {}, isFinite, Infinity, Error, String, Date
});
const L = sandbox.window.MiniGLTF.layout;

let checks = 0;
// Objects built inside the vm context have a foreign prototype; compare by value.
const plain = (v) => JSON.parse(JSON.stringify(v));
const eq = (actual, expected, msg) => assert.deepStrictEqual(plain(actual), expected, msg);
const pass = (msg) => { checks++; console.log('PASS: ' + msg); };
const extract = (glb) => {
  const { json, bin } = L.parseGLB(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));
  return L.extractPrimitives(json, bin);
};
const only = (glb) => { const r = extract(glb); assert.strictEqual(r.primitives.length, 1, 'the primitive must still be drawn'); return r.primitives[0]; };
const png = quadrantPng();

// ---- TEXCOORD_0 ----
{
  const p = only(quadGlb({ texture: { bytes: png, mimeType: 'image/png' } }));
  eq(Array.from(p.uvs), [0, 1, 1, 1, 1, 0, 0, 0], 'TEXCOORD_0 is read as authored');
  assert(p.uvs instanceof Float32Array);
  pass('TEXCOORD_0 is read as authored (no flipping on the CPU side)');

  const u8 = only(quadGlb({ mutateJson: (j) => {
    // replace the float UV accessor with a normalized UNSIGNED_BYTE one over the same view bytes
    const a = j.accessors[2]; a.componentType = 5121; a.normalized = true;
    j.bufferViews[a.bufferView].byteLength = 8;
  }, texture: { bytes: png, mimeType: 'image/png' } }));
  assert(u8.uvs && u8.uvs.length === 8 && Array.from(u8.uvs).every((v) => v >= 0 && v <= 1), 'normalized 8-bit UVs are accepted');
  pass('normalized 8-bit TEXCOORD_0 is converted to floats');

  const wrongCount = only(quadGlb({ mutateJson: (j) => { j.accessors[2].count = 3; }, texture: { bytes: png, mimeType: 'image/png' } }));
  assert.strictEqual(wrongCount.uvs, null);
  assert(wrongCount.textureWarning && !wrongCount.baseColorTexture, 'a UV accessor with the wrong vertex count is ignored and the texture dropped');
  const vec3 = only(quadGlb({ mutateJson: (j) => { j.accessors[2].type = 'VEC3'; } }));
  assert.strictEqual(vec3.uvs, null);
  pass('a UV accessor with the wrong count or type is ignored rather than breaking the primitive');
}

// ---- embedded PNG / JPEG resolve ----
{
  const p = only(quadGlb({ texture: { bytes: png, mimeType: 'image/png' } }));
  assert(p.baseColorTexture, 'PNG baseColorTexture resolves');
  assert.strictEqual(p.baseColorTexture.mime, 'image/png');
  assert(Buffer.from(p.baseColorTexture.bytes).equals(png), 'the resolved bytes are exactly the embedded PNG');
  eq(p.baseColorTexture.sampler, { wrapS: 10497, wrapT: 10497, magFilter: null, minFilter: null }, 'defaults when no sampler is given: repeat, filters unset');
  assert.strictEqual(p.textureWarning, undefined);
  pass('embedded PNG resolves material -> texture -> image, with default sampler');

  const j = only(quadGlb({ texture: { bytes: JPEG_QUADS, mimeType: 'image/jpeg' } }));
  assert(j.baseColorTexture && j.baseColorTexture.mime === 'image/jpeg' && Buffer.from(j.baseColorTexture.bytes).equals(JPEG_QUADS));
  pass('embedded JPEG resolves');

  const s = only(quadGlb({ texture: { bytes: png, mimeType: 'image/png', sampler: { wrapS: 33071, wrapT: 33648, magFilter: 9728, minFilter: 9987 } } }));
  eq(s.baseColorTexture.sampler, { wrapS: 33071, wrapT: 33648, magFilter: 9728, minFilter: 9987 });
  const bad = only(quadGlb({ texture: { bytes: png, mimeType: 'image/png', sampler: { wrapS: 1234, wrapT: 5, magFilter: 7, minFilter: 8 } } }));
  eq(bad.baseColorTexture.sampler, { wrapS: 10497, wrapT: 10497, magFilter: null, minFilter: null }, 'unknown sampler values fall back to the defaults');
  pass('sampler wrap/filter modes are read (clamp, repeat, mirrored repeat); unknown values use defaults');

  const a = only(buildGlb({ ...quadSpec(), texture: { bytes: png, mimeType: 'image/png' } }));
  const b = only(buildGlb({ ...quadSpec(), texture: { bytes: png, mimeType: 'image/png' } }));
  assert.strictEqual(a.baseColorTexture.key, b.baseColorTexture.key);
  pass('textures carry a key (image + sampler) so primitives sharing an image share one upload');
}

// ---- baseColorFactor ----
{
  const flat = only(quadGlb({ baseColorFactor: [0.25, 0.5, 0.75, 1] }));
  eq(flat.color, [0.25, 0.5, 0.75, 1], 'baseColorFactor drives an untextured material');
  assert.strictEqual(flat.baseColorTexture, undefined);
  assert.strictEqual(flat.textureWarning, undefined);
  const tinted = only(quadGlb({ baseColorFactor: [0.5, 1, 0, 1], texture: { bytes: png, mimeType: 'image/png' } }));
  eq(tinted.color, [0.5, 1, 0, 1], 'the factor is kept next to the texture for the shader to multiply');
  assert(tinted.baseColorTexture);
  pass('baseColorFactor is read with and without a texture');
}

// ---- no textures, no UVs ----
{
  const spec = quadSpec(); delete spec.uvs;
  const p = only(buildGlb({ ...spec, baseColorFactor: [0.2, 0.4, 0.6, 1] }));
  assert.strictEqual(p.uvs, null);
  assert.strictEqual(p.baseColorTexture, undefined);
  assert.strictEqual(p.textureWarning, undefined, 'no warning for a model that never asked for a texture');
  eq(p.color, [0.2, 0.4, 0.6, 1]);
  const withUvsNoTexture = only(buildGlb({ ...quadSpec() }));
  assert(withUvsNoTexture.uvs && !withUvsNoTexture.baseColorTexture && !withUvsNoTexture.textureWarning);
  pass('models without textures do not need UVs and produce no texture warning');
}

// ---- malformed or unsupported textures fail safely ----
{
  const png8 = { bytes: png, mimeType: 'image/png' };
  const cases = {
    'external image uri': (j) => { j.images[0] = { uri: 'tex.png' }; },
    'data: image uri': (j) => { j.images[0] = { uri: 'data:image/png;base64,AAAA' }; },
    'unsupported mime type': (j) => { j.images[0].mimeType = 'image/webp'; },
    'image bufferView outside the BIN chunk': (j) => { j.bufferViews[j.images[0].bufferView].byteLength = 1e7; },
    'image bufferView missing': (j) => { j.images[0].bufferView = 99; },
    'zero-length image': (j) => { j.bufferViews[j.images[0].bufferView].byteLength = 0; },
    'image bytes do not match the mime type': (j) => { j.images[0].mimeType = 'image/jpeg'; },
    'TEXCOORD_1': (j) => { j.materials[0].pbrMetallicRoughness.baseColorTexture.texCoord = 1; },
    'texture index out of range': (j) => { j.materials[0].pbrMetallicRoughness.baseColorTexture.index = 5; },
    'no textures array': (j) => { delete j.textures; },
    'texture without a source': (j) => { delete j.textures[0].source; },
    'image index out of range': (j) => { j.textures[0].source = 9; },
    'no images array': (j) => { delete j.images; },
    'oversized image': (j) => { j.bufferViews[j.images[0].bufferView].byteLength = 17 * 1024 * 1024; }
  };
  Object.entries(cases).forEach(([name, mutate]) => {
    let p;
    assert.doesNotThrow(() => { p = only(quadGlb({ texture: png8, mutateJson: mutate })); }, name + ' must not throw');
    assert.strictEqual(p.baseColorTexture, undefined, name + ': no texture is offered');
    assert(typeof p.textureWarning === 'string' && p.textureWarning.length > 0, name + ': a warning explains why');
    eq(Array.from(p.color), [1, 1, 1, 1], name + ': the flat colour is kept');
    assert(p.positions.length === 12 && p.indices.length === 6, name + ': geometry is intact');
  });
  const noUvs = quadSpec(); delete noUvs.uvs;
  const nu = only(buildGlb({ ...noUvs, texture: png8 }));
  assert(nu.textureWarning && !nu.baseColorTexture);
  // corrupt image data is only discovered by the decoder; extraction still offers it
  const corrupt = only(quadGlb({ texture: { bytes: Buffer.concat([png.slice(0, 8), Buffer.from('not really a png')]), mimeType: 'image/png' } }));
  assert(corrupt.baseColorTexture, 'a file with a valid signature but corrupt body is left to the image decoder (see manual-3d-textures.js)');
  pass('malformed or unsupported textures (' + (Object.keys(cases).length + 1) + ' cases) never throw and leave the primitive in its flat colour with a warning');
}

// ---- bundled models are untouched ----
{
  const dirs = [path.join(REPO, 'demo-domain-a', 'assets'), path.join(REPO, 'demo-domain-b', 'assets')];
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else if (f.endsWith('.glb')) files.push(f);
  });
  dirs.forEach(walk);
  assert(files.length > 100, 'expected the bundled models, found ' + files.length);
  // The only textured bundled models are the two deliberate ones.
  const textured = [];
  files.forEach((f) => {
    const buf = fs.readFileSync(f);
    const { json, bin } = L.parseGLB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (json.images && json.images.length) { textured.push(path.basename(f)); return; }
    const r = L.extractPrimitives(json, bin);
    assert(r.primitives.length > 0, path.basename(f) + ' still has geometry');
    r.primitives.forEach((p) => {
      assert(p.baseColorTexture === undefined, path.basename(f) + ' is untextured');
      assert.strictEqual(p.textureWarning, undefined, path.basename(f));
      assert(Array.isArray(p.color) && p.color.length === 4, path.basename(f) + ' keeps its flat colour');
    });
  });
  assert.deepStrictEqual(textured.sort(), ['galleryPortal.glb', 'textureTestBoard.glb', 'townPortal.glb'], 'only the deliberate models carry images');
  pass('all ' + (files.length - textured.length) + ' other bundled GLBs still extract as untextured models with their flat colours (textured: ' + textured.join(', ') + ')');
}

// ---- the repo's texture test model ----
{
  const f = path.join(REPO, 'demo-domain-a', 'assets', 'texture-test', 'textureTestBoard.glb');
  const buf = fs.readFileSync(f);
  const r = extract(buf);
  assert.strictEqual(r.primitives.length, 1);
  const p = r.primitives[0];
  assert(p.uvs && p.baseColorTexture && p.baseColorTexture.mime === 'image/png' && !p.textureWarning);
  eq(p.baseColorTexture.sampler, { wrapS: 33071, wrapT: 33071, magFilter: 9728, minFilter: 9984 });
  eq(Array.from(p.color), [1, 1, 1, 1]);
  assert(Math.abs(r.bounds.size[0] - 1) < 1e-6 && Math.abs(r.bounds.size[1] - 1) < 1e-6, 'a 1 x 1 board');
  assert(Math.abs(r.bounds.min[1]) < 1e-6, 'standing on y = 0');
  pass('textureTestBoard.glb: UVs, embedded PNG, sampler and a 1 x 1 board standing on the floor');
}

console.log('\nALL ' + checks + ' TEXTURE DATA CHECKS PASSED');
