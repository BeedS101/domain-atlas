// Data checks (no browser) for the Domain A Lobby interior material pass, using
// the renderer's own parsing, bounds and collision math on the real files:
//
//   1. The interior models and the scene are exactly what
//      tools/make-lobby-interior-assets.js produces.
//   2. Geometry is untouched: every swapped model has the same bounds and the
//      same triangles per material as the bundled original, so collisions are
//      identical; the exterior face, window frames and glass of the wall models
//      keep their plain materials.
//   3. The new materials are what was intended: floor and wall normal maps, wood
//      grain, emissive screens and lamp shades, an unlit plaque; nothing else
//      uses material features.
//   4. Placement: the floor overlay stays inside the building, flat and below
//      the rugs, never solid; the plaque is decorative; every solid in the
//      scene collides exactly as with the original models.
//   5. Budget: embedded PNGs only, at most 1024 px and power-of-two, and the
//      whole set stays small.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { REPO, DOMAIN_DIR, L, parseGlb, modelBounds, readScene, collision } = require('./town-walk-lib');
const tool = require(path.join(REPO, 'tools', 'make-lobby-interior-assets.js'));
const LAY = require(path.join(REPO, 'tools', 'lib', 'lobby-town-layout.js'));
const { flattenGlb } = require(path.join(REPO, 'tools', 'lib', 'glb-read.js'));

const INTERIOR_DIR = path.join(DOMAIN_DIR, 'assets', 'lobby', 'interior');
const FURNITURE_DIR = path.join(DOMAIN_DIR, 'assets', 'furniture');
const scenePath = path.join(DOMAIN_DIR, 'spatial', 'lobby', 'scene.json');
const sceneText = fs.readFileSync(scenePath, 'utf8');
const scene = JSON.parse(sceneText);
let checks = 0;
const pass = (msg) => { checks++; console.log('PASS: ' + msg); };
const close = (a, b, tol, msg) => assert(a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol), msg + ': ' + JSON.stringify(a) + ' vs ' + JSON.stringify(b));

const generated = tool.allModels();
const extract = (file) => { const buf = fs.readFileSync(file); const g = parseGlb(buf); return { buf, json: g.json, bin: g.bin, ...L.extractPrimitives(g.json, g.bin) }; };

// ---- 1. generator output ----
{
  const files = fs.readdirSync(INTERIOR_DIR).filter((f) => f.endsWith('.glb')).sort();
  assert.deepStrictEqual(files, Object.keys(generated).map((n) => n + '.glb').sort(), 'the interior folder holds exactly the generated models');
  for (const [name, glb] of Object.entries(generated)) assert(fs.readFileSync(path.join(INTERIOR_DIR, name + '.glb')).equals(glb), name + '.glb must equal the generator output (run node tools/make-lobby-interior-assets.js)');
  assert.strictEqual(tool.sceneText(sceneText), sceneText, 'scene.json must point at the interior models (run node tools/make-lobby-interior-assets.js --scene)');
  assert.strictEqual(files.length, 17);
  pass('17 interior models and the scene are exactly what the generator produces');
}

// ---- 2. geometry unchanged ----
{
  for (const name of tool.SWAPPED) {
    const orig = extract(path.join(FURNITURE_DIR, name + '.glb'));
    const now = extract(path.join(INTERIOR_DIR, name + '.glb'));
    close(now.bounds.min, orig.bounds.min, 1e-6, name + ' min bound');
    close(now.bounds.max, orig.bounds.max, 1e-6, name + ' max bound');
    const a = flattenGlb(path.join(FURNITURE_DIR, name + '.glb'));
    // the wall models' textured interior face is its own primitive, "plaster", split out of _defaultMat
    const b = flattenGlb(path.join(INTERIOR_DIR, name + '.glb')).map((p) => (p.material.name === 'plaster' ? { ...p, material: { ...p.material, name: '_defaultMat' } } : p));
    assert.deepStrictEqual([...new Set(b.map((p) => p.material.name))].sort(), a.map((p) => p.material.name).sort(), name + ' keeps its materials');
    const tris = (prims) => { const out = []; prims.forEach((prim) => { for (let i = 0; i < prim.indices.length; i += 3) out.push([0, 1, 2].map((k) => [0, 1, 2].map((c) => String(Math.round(prim.positions[prim.indices[i + k] * 3 + c] * 1e3) / 1e3 + 0)).join(',')).sort().join('|')); }); return out.sort(); };
    for (const p of a) {
      const q = b.filter((x) => x.material.name === p.material.name);
      const screenGlass = tool.SCREENS.includes(name) && p.material.name === 'metal'; // the display face is deliberately dark and emissive
      if (!screenGlass) q.forEach((x) => assert.deepStrictEqual(x.material.pbrMetallicRoughness.baseColorFactor, p.material.pbrMetallicRoughness.baseColorFactor, name + '/' + p.material.name + ' keeps its colour'));
      assert.deepStrictEqual(tris(q), tris([p]), name + '/' + p.material.name + ' keeps its triangles');
    }
  }
  // the exterior side and the frames of the walls stay plain
  for (const name of tool.WALLS) {
    const { json } = extract(path.join(INTERIOR_DIR, name + '.glb'));
    json.materials.forEach((m) => {
      const textured = !!(m.pbrMetallicRoughness.baseColorTexture || m.normalTexture);
      assert.strictEqual(textured, m.name === 'plaster', name + '/' + m.name + (m.name === 'plaster' ? ' (interior face) is textured' : ' stays untextured'));
    });
  }
  pass('all ' + tool.SWAPPED.length + ' swapped models keep their bounds, triangles and colours; wall exteriors, segment ends, frames and glass stay untextured');
}

// ---- 3. the materials ----
{
  const byMat = (name) => { const r = extract(path.join(INTERIOR_DIR, name + '.glb')); return r; };
  const floor = byMat('lobbyFloor');
  assert.strictEqual(floor.primitives.length, 1);
  assert(floor.primitives[0].baseColorTexture && floor.primitives[0].normalTexture, 'floor: base colour and normal map');
  assert(!floor.primitives[0].textureWarning, 'floor textures usable: ' + floor.primitives[0].textureWarning);
  for (const name of tool.WALLS) {
    const r = byMat(name);
    const tex = r.primitives.filter((p) => p.baseColorTexture);
    assert.strictEqual(tex.length, 1, name + ': exactly the interior face is textured');
    assert(tex[0].normalTexture, name + ': plaster normal map');
    r.primitives.forEach((p) => assert(!p.textureWarning, name + ': ' + p.textureWarning));
    assert(r.primitives.every((p) => !p.emissive && !p.mask && !p.unlit), name + ': no other features');
  }
  for (const name of tool.WOODEN) {
    const r = byMat(name);
    const tex = r.primitives.filter((p) => p.baseColorTexture);
    assert.strictEqual(tex.length, 1, name + ': the wood is textured');
    assert(tex[0].normalTexture, name + ': wood normal map');
    r.primitives.forEach((p) => assert(!p.textureWarning, name + ': ' + p.textureWarning));
    assert(r.primitives.every((p) => !p.emissive && !p.mask && !p.unlit), name + ': no other features');
  }
  for (const name of tool.SCREENS) {
    const r = byMat(name);
    const glowing = r.primitives.filter((p) => p.emissive);
    assert.strictEqual(glowing.length, 1, name + ': one emissive screen');
    assert(glowing[0].emissiveTexture, name + ': emissive display texture');
    assert(!glowing[0].textureWarning, name + ': ' + glowing[0].textureWarning);
    assert(glowing[0].emissive.every((v) => v <= 1) && Math.max(...glowing[0].color.slice(0, 3)) < 0.1, name + ': a dark base so the display carries the colour');
  }
  for (const name of tool.LAMPS) {
    const r = byMat(name);
    const glowing = r.primitives.filter((p) => p.emissive);
    assert.strictEqual(glowing.length, 1, name + ': only the shade glows');
    assert(glowing[0].emissive.every((v) => v > 0 && v <= 0.35), name + ': a faint glow, not a light source: ' + glowing[0].emissive);
    assert(!glowing[0].emissiveTexture && !glowing[0].baseColorTexture, name + ': no texture on the lamp shade');
  }
  const plaque = byMat('lobbyPlaque');
  assert(plaque.json.extensionsUsed && plaque.json.extensionsUsed.includes('KHR_materials_unlit'));
  assert.strictEqual(plaque.primitives.filter((p) => p.unlit).length, 1, 'only the lettering face is unlit');
  assert(plaque.primitives.every((p) => !p.emissive && !p.mask));
  // nothing else in the folder uses an extension, alpha mode or other texture slots
  for (const [name] of Object.entries(generated)) {
    const { json } = byMat(name);
    assert(!json.extensionsRequired, name + ' requires no extensions');
    if (name !== 'lobbyPlaque') (json.materials || []).forEach((m) => assert(!m.extensions, name + '/' + m.name + ' uses no material extension (the bundled lamp files list one in extensionsUsed but never apply it)'));
    (json.materials || []).forEach((m) => {
      assert(!m.occlusionTexture && !m.pbrMetallicRoughness.metallicRoughnessTexture, name + ': no occlusion / metallic-roughness texture');
      assert(!m.alphaMode || m.alphaMode === 'OPAQUE' || (m.alphaMode === 'BLEND' && m.name === 'glass'), name + ': no new alpha modes');
    });
  }
  pass('floor, walls and wood use normal maps; screens and lamp shades are emissive; the plaque is unlit; no other features or extensions');
}

// ---- 4. placement and collisions ----
{
  const floorObj = scene.objects.filter((o) => o.model === tool.URL_DIR + 'lobbyFloor.glb');
  assert.strictEqual(floorObj.length, 1);
  assert.deepStrictEqual(floorObj[0], { model: tool.URL_DIR + 'lobbyFloor.glb', position: [0, 0, 0], rotationY: 0, solid: false });
  const fb = modelBounds(tool.URL_DIR + 'lobbyFloor.glb');
  assert(fb.min[0] >= LAY.HOLE.minX - 1e-9 && fb.max[0] <= LAY.HOLE.maxX + 1e-9 && fb.min[2] >= LAY.HOLE.minZ - 1e-9 && fb.max[2] <= LAY.HOLE.maxZ + 1e-9, 'the floor overlay stays inside the building (the hole in the grass)');
  assert(fb.max[1] === fb.min[1], 'the floor overlay is flat');
  assert(fb.max[1] > 0 && fb.max[1] < 0.01, 'the floor overlay sits just above the scene floor, below the 1 cm rugs');
  const plaque = scene.objects.filter((o) => o.model === tool.URL_DIR + 'lobbyPlaque.glb');
  assert.strictEqual(plaque.length, 1);
  assert.strictEqual(plaque[0].solid, false);
  const pb = modelBounds(tool.URL_DIR + 'lobbyPlaque.glb');
  const z = plaque[0].position[2] + pb.min[2];
  assert(z >= -5.52 && z <= -5.45, 'the plaque hangs just in front of the north wall, got z ' + z);
  assert(plaque[0].position[1] > 1.0 && plaque[0].position[1] + pb.max[1] < 2.0, 'the plaque is above the furniture and below the wall top');
  // collisions: map the scene back to the bundled models; every footprint must match
  const original = { ...scene, objects: scene.objects.filter((o) => !tool.NEW_OBJECTS.some((n) => n.model === o.model)).map((o) => {
    const m = /^\/assets\/lobby\/interior\/(\w+)\.glb$/.exec(o.model);
    return m ? { ...o, model: '/assets/furniture/' + m[1] + '.glb' } : o;
  }) };
  const now = collision({ ...scene, objects: scene.objects.filter((o) => !tool.NEW_OBJECTS.some((n) => n.model === o.model)) });
  const before = collision(original);
  assert.strictEqual(now.items.length, before.items.length);
  now.items.forEach((it, i) => {
    assert.strictEqual(it.solid, before.items[i].solid, 'solid flag of object ' + i);
    const num = (o) => (typeof o === 'number' ? [o] : Array.isArray(o) ? o.flatMap(num) : Object.keys(o).sort().flatMap((k) => num(o[k])));
    close(num(it.footprint), num(before.items[i].footprint), 1e-6, 'footprint of object ' + i + ' (' + it.model + ')'); // float32 storage differs by about 1e-9
  });
  const withNew = collision(scene);
  assert.strictEqual(withNew.items.filter((it) => it.solid).length, now.items.filter((it) => it.solid).length, 'the new objects add no solids');
  assert.strictEqual(scene.characterScale, 0.5);
  assert.deepStrictEqual(scene.ambientLight, { intensity: 0.55 });
  assert.deepStrictEqual(scene.directionalLight, { direction: [-0.45, -1, -0.35] });
  pass('floor overlay: flat, inside the building, under the rugs, non-solid; plaque non-solid; every collision footprint equals the original models\'; lighting and characterScale 0.5 unchanged');
}

// ---- 5. budget ----
{
  let total = 0, images = 0;
  for (const name of Object.keys(generated)) {
    const buf = fs.readFileSync(path.join(INTERIOR_DIR, name + '.glb'));
    total += buf.length;
    const { json, bin } = parseGlb(buf);
    assert(!/[A-Za-z]:\\|\\\\|\/home\/|\/tmp\/|\/Users\/|file:|https?:/.test(JSON.stringify(json)), name + ' has no local or absolute paths');
    assert((json.buffers || []).every((b) => !b.uri), name + ' has no external buffers');
    (json.images || []).forEach((img, i) => {
      assert(img.bufferView !== undefined && !img.uri && img.mimeType === 'image/png', name + ' image ' + i + ' is an embedded PNG');
      const v = json.bufferViews[img.bufferView];
      const png = Buffer.from(bin.slice(v.byteOffset, v.byteOffset + v.byteLength));
      const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
      assert(w <= 1024 && h <= 1024, name + ' image ' + i + ' is ' + w + 'x' + h);
      assert((w & (w - 1)) === 0 && (h & (h - 1)) === 0, name + ' image ' + i + ' has power-of-two sides');
      images++;
    });
  }
  assert(total < 1.5 * 1024 * 1024, 'the interior set stays under 1.5 MB, got ' + total);
  const maxPixels = (name) => Math.max(...(parseGlb(fs.readFileSync(path.join(INTERIOR_DIR, name + '.glb'))).json.images || []).map((_, i) => { const g = parseGlb(fs.readFileSync(path.join(INTERIOR_DIR, name + '.glb'))); const v = g.json.bufferViews[g.json.images[i].bufferView]; const png = Buffer.from(g.bin.slice(v.byteOffset, v.byteOffset + v.byteLength)); return png.readUInt32BE(16) * png.readUInt32BE(20); }));
  assert.strictEqual(maxPixels('lobbyFloor'), 1024 * 1024, 'only the floor uses a 1024 px texture');
  assert(tool.WALLS.every((n) => maxPixels(n) <= 512 * 512) && tool.WOODEN.every((n) => maxPixels(n) <= 128 * 128), 'walls at most 512 px, wood 128 px');
  pass('embedded PNGs only (' + images + ' images, none above 1024 px, power-of-two); the whole set is ' + Math.round(total / 1024) + ' KB');
}

console.log('\nALL ' + checks + ' LOBBY INTERIOR DATA CHECKS PASSED');
