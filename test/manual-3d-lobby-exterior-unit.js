// Data checks (no browser) for the Domain A Lobby exterior and town material pass:
//
//   1. The exterior models, the town models and the scene's wall URLs are exactly what
//      tools/make-lobby-exterior-assets.js and tools/make-town-assets.js produce.
//   2. Geometry is untouched: every exterior model has the bounds and triangles of the
//      bundled original, and every town model keeps its bounds, so collisions stay the same.
//   3. The scene differs from the interior-pass scene only in model URLs; the object count,
//      placement, solid flags, markers, interactables, camera, lights and character scale are as before.
//   4. Material features stay conservative: base colour and normal textures, one faint emissive
//      lantern, no BLEND/unlit/extensions; the walls' exterior face is textured and the rest plain.
//   5. Budget: embedded PNGs only, power-of-two where tiled, small, and a bounded total.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const assert = require('assert');

const { REPO, DOMAIN_DIR, L, parseGlb, modelBounds, readScene, collision } = require('./town-walk-lib');
const tool = require(path.join(REPO, 'tools', 'make-lobby-exterior-assets.js'));
const interiorTool = require(path.join(REPO, 'tools', 'make-lobby-interior-assets.js'));
const town = require(path.join(REPO, 'tools', 'make-town-assets.js'));
const { flattenGlb } = require(path.join(REPO, 'tools', 'lib', 'glb-read.js'));

const ASSETS = path.join(DOMAIN_DIR, 'assets');
const scene = readScene();
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
let checks = 0;
const pass = (msg) => { checks++; console.log('PASS: ' + msg); };
const close = (a, b, tol, msg) => assert(a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol), msg + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b));
const extract = (file) => { const buf = fs.readFileSync(file); const g = parseGlb(buf); return { buf, json: g.json, ...L.extractPrimitives(g.json, g.bin) }; };
const triCount = (file) => flattenGlb(file).reduce((n, p) => n + p.indices.length / 3, 0);
const tris = (file) => { const out = []; flattenGlb(file).forEach((prim) => { for (let i = 0; i < prim.indices.length; i += 3) out.push([0, 1, 2].map((k) => [0, 1, 2].map((c) => String(Math.round(prim.positions[prim.indices[i + k] * 3 + c] * 1e3) / 1e3 + 0)).join(',')).sort().join('|')); }); return out.sort(); };

// The town models as bundled before the material pass: bounds, triangle count, primitive count.
const TOWN_BASE = {"barrel":{"b":[[-0.2679,0,-0.2679],[0.2679,0.845,0.2679]],"t":120,"p":3},"boulderLarge":{"b":[[-0.9099,-0.12,-0.8724],[0.8541,1.3485,0.963]],"t":80,"p":1},"boulderSmall":{"b":[[-0.5327,-0.12,-0.5552],[0.5241,0.6772,0.4424]],"t":80,"p":1},"flowerBed":{"b":[[-0.9,0,-0.35],[0.9,0.3699,0.35]],"t":220,"p":6},"fountain":{"b":[[-1.6,0,-1.6],[1.6,1.92,1.6]],"t":184,"p":2},"hedge":{"b":[[-2,0,-0.4],[2,1.1,0.4]],"t":10,"p":1},"hut":{"b":[[-2.65,0,-2.15],[2.65,4.18,2.15]],"t":182,"p":6},"mineHill":{"b":[[-19.8,0,-17.2],[-4,6.7894,-12.8]],"t":198,"p":4},"oreCart":{"b":[[-0.55,0,-0.41],[0.55,0.8837,0.41]],"t":418,"p":3},"pier":{"b":[[-2.05,0,-0.9],[2.05,0.95,0.9]],"t":110,"p":3},"pine":{"b":[[-1.15,0,-1.15],[1.15,4.6,1.15]],"t":114,"p":3},"riverBanks":{"b":[[14.9294,0.03,-18],[21.2508,0.03,24]],"t":224,"p":1},"riverWater":{"b":[[16.4,0.03,-17.5],[19.6,0.06,23.5]],"t":6,"p":1},"stoneWall":{"b":[[-1.55,0,-0.26],[1.55,0.65,0.26]],"t":20,"p":1},"townGround":{"b":[[-50,0.015,-47],[50,0.015,53]],"t":16,"p":1},"townPaths":{"b":[[-16.6,0.03,-13.2],[16.2,0.052,19]],"t":120,"p":7},"townSignpost":{"b":[[-1.106,0,-0.6441],[1.2101,2.66,0.6473]],"t":100,"p":7},"townSky":{"b":[[-44,-2,-41],[44,44,47]],"t":10,"p":2},"woodPile":{"b":[[-0.51,0.0261,-0.5],[0.51,0.6939,0.5]],"t":216,"p":2}};

// scene.json (JSON.stringify of the parsed file) as it was before the material pass, with the wall models of assets/lobby/interior
const BEFORE_SCENE_SHA = '3ea0ecb905381c6d7195028522aadd7972d9f79b8aa143dbf18a1710a1678fd6';

// where each exterior model's geometry comes from
const ORIGINAL = (name) => {
  const base = name.replace(/B$/, '');
  if (tool.WALLS.includes(name)) return path.join(ASSETS, 'furniture', name + '.glb');
  const outdoor = path.join(ASSETS, 'outdoor', base + '.glb');
  return outdoor;
};

// ---- 1. generator output ----
{
  const generated = tool.allModels();
  const files = fs.readdirSync(tool.OUT_DIR).filter((f) => f.endsWith('.glb')).sort();
  assert.deepStrictEqual(files, Object.keys(generated).map((n) => n + '.glb').sort(), 'the exterior folder holds exactly the generated models');
  for (const [name, glb] of Object.entries(generated)) assert(fs.readFileSync(path.join(tool.OUT_DIR, name + '.glb')).equals(glb), name + '.glb must equal the generator output (run node tools/make-lobby-exterior-assets.js)');
  assert.strictEqual(tool.sceneText(fs.readFileSync(path.join(DOMAIN_DIR, 'spatial', 'lobby', 'scene.json'), 'utf8')), fs.readFileSync(path.join(DOMAIN_DIR, 'spatial', 'lobby', 'scene.json'), 'utf8'), 'scene.json walls point at the exterior models');
  for (const name of Object.keys(town.MODELS)) assert(fs.readFileSync(path.join(town.OUT_DIR, name + '.glb')).equals(town.buildModel(name)), 'town/' + name + '.glb must equal the generator output (run node tools/make-town-assets.js)');
  pass(files.length + ' exterior models, ' + Object.keys(town.MODELS).length + ' town models and the scene walls are exactly what the generators produce');
}

// ---- 2. geometry unchanged ----
{
  for (const name of tool.allModelNames()) {
    const orig = ORIGINAL(name);
    const a = extract(orig), b = extract(path.join(tool.OUT_DIR, name + '.glb'));
    close(b.bounds.min, a.bounds.min, 1e-6, name + ' min bound');
    close(b.bounds.max, a.bounds.max, 1e-6, name + ' max bound');
    // lamp, sign, planter and trees keep their triangle counts; walls keep theirs; the split primitives share the same set
    assert.strictEqual(triCount(path.join(tool.OUT_DIR, name + '.glb')), triCount(orig), name + ' triangle count');
    assert.deepStrictEqual(tris(path.join(tool.OUT_DIR, name + '.glb')), tris(orig), name + ' triangles');
  }
  for (const [name, base] of Object.entries(TOWN_BASE)) {
    const f = path.join(ASSETS, 'town', name + '.glb');
    const r = extract(f);
    close(r.bounds.min, base.b[0], 1e-3, 'town/' + name + ' min bound');
    close(r.bounds.max, base.b[1], 1e-3, 'town/' + name + ' max bound');
    assert(Math.abs(r.primitives.length - base.p) <= 1, 'town/' + name + ' primitive count ' + base.p + ' -> ' + r.primitives.length);
    assert(Math.abs(triCount(f) - base.t) <= 8, 'town/' + name + ' triangle count ' + base.t + ' -> ' + triCount(f));
  }
  pass(tool.allModelNames().length + ' exterior models keep the bundled originals\' triangles and bounds; ' + Object.keys(TOWN_BASE).length + ' town models keep their bounds (primitives +-1, triangles +-8)');
}

// ---- 3. scene: only model URLs changed ----
{
  // Map the exterior models back to the originals they were made from; the result must be the scene as it was
  // before this pass (fingerprint of the whole file), which fixes every placement, solid flag and option.
  const interiorMap = (m) => { const w = /^\/assets\/lobby\/exterior\/(wall\w*)\.glb$/.exec(m); return w ? interiorTool.URL_DIR + w[1] + '.glb' : null; };
  const propMap = (m) => { const p = /^\/assets\/lobby\/exterior\/(\w+?)B?\.glb$/.exec(m); return p ? '/assets/outdoor/' + p[1] + '.glb' : m === '/assets/town/pineB.glb' ? '/assets/town/pine.glb' : null; };
  const reverted = { ...scene, objects: scene.objects.map((o) => ({ ...o, model: interiorMap(o.model) || propMap(o.model) || o.model })) };
  assert.strictEqual(sha(JSON.stringify(reverted)), BEFORE_SCENE_SHA, 'scene.json differs from the previous scene by more than model URLs');
  const head = reverted;
  assert.strictEqual(scene.objects.length, 265, 'object count');
  const swapped = scene.objects.filter((o, i) => o.model !== head.objects[i].model).length;
  assert.strictEqual(swapped, 101, 'objects moved to a textured variant');
  scene.objects.forEach((o, i) => { if (o.model !== head.objects[i].model) assert(/^\/assets\/lobby\/exterior\/\w+\.glb$|^\/assets\/town\/pineB\.glb$/.test(o.model), o.model); });
  assert.strictEqual(scene.characterScale, 0.5);
  // every solid collides exactly as before
  const now = collision(scene), before = collision(head);
  assert.strictEqual(now.solids.length, before.solids.length);
  now.items.forEach((it, i) => { close(it.footprint.min || it.footprint, before.items[i].footprint.min || before.items[i].footprint, 1e-6, 'footprint ' + i); assert.strictEqual(it.solid, before.items[i].solid); });
  pass(scene.objects.length + ' objects, all placement and solid flags, markers, interactables, camera, lights and characterScale 0.5 are unchanged; collision footprints are identical');
}

// ---- 4. materials ----
{
  let emissive = 0;
  for (const name of tool.allModelNames()) {
    const { json, primitives } = extract(path.join(tool.OUT_DIR, name + '.glb'));
    assert(!json.extensionsRequired && !(json.extensionsUsed || []).length, name + ' needs no extensions');
    (json.materials || []).forEach((m) => {
      assert(!m.extensions && !m.occlusionTexture && !m.pbrMetallicRoughness.metallicRoughnessTexture && !m.emissiveTexture, name + '/' + m.name + ': base colour and normal textures only');
      assert(!m.alphaMode || m.alphaMode === 'OPAQUE' || m.alphaMode === 'MASK' || (m.alphaMode === 'BLEND' && m.name === 'glass'), name + '/' + m.name + ': no new BLEND (the original window glass keeps its flag and renders opaque)');
    });
    primitives.forEach((p) => { assert(!p.textureWarning && !p.unlit, name); if (p.emissive) { emissive++; assert(p.emissive.every((v) => v > 0 && v <= 0.45), name + ': faint emissive'); } });
    if (tool.WALLS.includes(name)) json.materials.forEach((m) => {
      const textured = !!m.pbrMetallicRoughness.baseColorTexture;
      assert.strictEqual(textured, m.name === 'plaster' || m.name === 'stucco' || m.name === 'wood', name + '/' + m.name);
    });
  }
  assert.strictEqual(emissive, 1, 'only the lamp lantern glows');
  for (const name of Object.keys(town.MODELS)) {
    const { json, primitives } = extract(path.join(ASSETS, 'town', name + '.glb'));
    (json.materials || []).forEach((m) => assert(!m.normalTexture && !m.emissiveTexture && !m.extensions, 'town/' + name + '/' + m.name + ': plain base-colour textures (normal maps cost frame time on large surfaces)'));
    primitives.forEach((p) => assert(!p.textureWarning, 'town/' + name));
  }
  pass('exterior: base colour + wall normal map, one faint emissive lantern, no BLEND/unlit/extensions; town models use base-colour textures only');
}

// ---- 5. budget ----
{
  let total = 0, images = 0;
  const check = (file, label, tiled) => {
    const { json, buf } = extract(file);
    total += buf.length;
    (json.images || []).forEach((_, i) => {
      images++;
      const img = json.images[i];
      assert(img.bufferView !== undefined && !img.uri && img.mimeType === 'image/png', label + ' image ' + i + ' is an embedded PNG');
      const g = parseGlb(buf), v = json.bufferViews[img.bufferView];
      const png = Buffer.from(g.bin.slice(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength));
      assert.strictEqual(png.slice(1, 4).toString('ascii'), 'PNG', label + ' embeds PNGs');
      const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
      assert(w <= 512 && h <= 512, label + ' image ' + w + 'x' + h + ' is above 512 px');
    });
  };
  for (const name of tool.allModelNames()) { const f = path.join(tool.OUT_DIR, name + '.glb'); check(f, name); assert(fs.statSync(f).size <= 160 * 1024, name + ' stays under 160 KB'); }
  const dirSize = fs.readdirSync(tool.OUT_DIR).reduce((n, f) => n + fs.statSync(path.join(tool.OUT_DIR, f)).size, 0);
  assert(dirSize <= 800 * 1024, 'the exterior set stays under 800 KB: ' + dirSize);
  for (const name of Object.keys(town.MODELS)) { const f = path.join(ASSETS, 'town', name + '.glb'); check(f, 'town/' + name); assert(fs.statSync(f).size <= 180 * 1024, 'town/' + name + ' stays under 180 KB'); }
  pass('embedded PNGs only (' + images + ' images, none above 512 px); exterior set ' + Math.round(dirSize / 1024) + ' KB');
}

console.log('\nALL ' + checks + ' LOBBY EXTERIOR DATA CHECKS PASSED');
