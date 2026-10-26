// Renderer placement/collision regression checks for extension/gltf-mini.js.
// Node only, no browser or WebGL: loads the renderer in a vm sandbox and
// drives its pure layout helpers (window.MiniGLTF.layout) with synthetic
// bounds, synthetic GLBs and the real demo Lobby scene.
//
// Covers:
//   1. Footprints come from the model's real bounds and the placement's
//      rotation (corner-origin models, rotated pieces), not a box centered
//      on the placement origin.
//   2. Which placed objects collide: rugs and overhead objects don't, things
//      resting on/in a solid (monitor on a desk, books on a shelf) are
//      covered by it, a floating object stays solid.
//   3. Tolerant scene.json parsing (missing/short position, zero scale) and
//      eye-height handling for ground-level anchors.
//   4. GLB loader robustness: interleaved/misaligned accessors, 8-bit
//      indices, missing accessor min/max, non-triangle primitives, scenes
//      with no scene node list.
//   5. The shipped Lobby: every object sits where it should (books inside
//      the bookcase on a shelf, TV on its cabinet, desk items on the desk),
//      nothing floats, spawn/anchor/portal points are reachable.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..');
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(REPO, 'extension', 'gltf-mini.js'), 'utf8'), {
  window: sandbox.window, document: {}, console, Float32Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array,
  DataView, ArrayBuffer, TextDecoder, Math, Map, Set, Promise, Array, Object, Number, JSON,
  performance: { now: () => 0 }, navigator: {}, indexedDB: {}, isFinite, Infinity, Error, String, Date
});
const L = sandbox.window.MiniGLTF.layout;

let checks = 0;
function pass(msg) { checks++; console.log('PASS: ' + msg); }
// Arrays from the vm sandbox have a different Array prototype, so compare by value.
function deq(a, b, msg) { assert.strictEqual(JSON.stringify(a), JSON.stringify(b), msg); }
function near(a, b, eps, msg) { assert(Math.abs(a - b) <= (eps || 1e-6), (msg || 'value') + ': expected ' + b + ', got ' + a); }

// ---------- 1. footprints ----------
{
  // A corner-origin model like the furniture kit: x 0..0.8, z -0.25..0.
  const bounds = { min: [0, 0, -0.25], max: [0.8, 0.31, 0], size: [0.8, 0.31, 0.25] };
  let fp = L.placedFootprint(bounds, L.normalizePlacement({ position: [3.2, 0, -3.65], rotationY: 0 }));
  near(fp.min[0], 3.2); near(fp.max[0], 4.0); near(fp.min[1], -3.9); near(fp.max[1], -3.65);
  pass('unrotated corner-origin footprint spans the model bounds, not a box centered on the origin');

  // Rotated 90 degrees about Y: local x runs toward world -z, local -z toward world +x
  // (x' = c*x + s*z, z' = -s*x + c*z), matching mat4RotateY and the scene editor.
  fp = L.placedFootprint(bounds, L.normalizePlacement({ position: [-4.15, 0, -2.2], rotationY: 90 }));
  near(fp.min[0], -4.4, 1e-5); near(fp.max[0], -4.15, 1e-5); near(fp.min[1], -3.0, 1e-5); near(fp.max[1], -2.2, 1e-5);
  pass('90 degree rotation swaps the footprint axes the same way the render matrix does');

  // The footprint must agree with the render matrix for every bounds corner.
  const pl = L.normalizePlacement({ position: [1.5, 0.2, -0.7], rotationY: 37, scale: 1.5 });
  const m = L.placementMatrix(pl);
  const f = L.placedFootprint(bounds, pl);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) {
    const wx = m[0] * x + m[4] * y + m[8] * z + m[12], wz = m[2] * x + m[6] * y + m[10] * z + m[14];
    minX = Math.min(minX, wx); maxX = Math.max(maxX, wx); minZ = Math.min(minZ, wz); maxZ = Math.max(maxZ, wz);
  }
  near(f.min[0], minX, 1e-4); near(f.max[0], maxX, 1e-4); near(f.min[1], minZ, 1e-4); near(f.max[1], maxZ, 1e-4);
  near(f.minY, 0.2, 1e-6); near(f.maxY, 0.2 + 0.31 * 1.5, 1e-5);
  pass('footprint AABB equals the transformed bounds corners for an arbitrary rotation and scale');

  // Oriented test: a point inside the AABB but outside the rotated box is clear.
  const rot45 = L.placedFootprint({ min: [-1, 0, -0.1], max: [1, 1, 0.1], size: [2, 1, 0.2] }, L.normalizePlacement({ position: [0, 0, 0], rotationY: 45 }));
  assert.strictEqual(L.footprintDepth(rot45, 0.7, 0.7, 0), 0, 'corner of the AABB, off the rotated slab');
  assert(L.footprintDepth(rot45, 0.5, -0.5, 0) > 0, 'on the rotated slab');
  pass('collision is against the oriented box, so a rotated piece does not block its AABB corners');

  assert.strictEqual(L.placedFootprint({ min: [Infinity, 0, 0], max: [-Infinity, 0, 0], size: [NaN, 0, 0] }, L.normalizePlacement({ position: [0, 0, 0] })), null);
  pass('a model with no usable bounds yields no footprint');
}

// ---------- 2. which objects collide ----------
{
  const mk = (min, max, pos, rot) => ({ footprint: L.placedFootprint({ min, max, size: max.map((v, i) => v - min[i]) }, L.normalizePlacement({ position: pos, rotationY: rot || 0 })) });
  const desk = mk([0, 0, -0.4], [0.7, 0.38, 0], [0, 0, 0]);
  const monitor = mk([0, 0, -0.1], [0.4, 0.3, 0], [0.1, 0.38, -0.1]);
  const rug = mk([0, 0, -1], [1.5, 0.01, 0], [3, 0, 3]);
  const beam = mk([0, 0, -0.2], [2, 0.3, 0], [-3, 2.2, 0]);
  const chairUnderDesk = mk([0, 0, -0.3], [0.3, 0.6, 0], [0.2, 0, -0.1]);
  const floating = mk([0, 0, -0.1], [0.2, 0.2, 0], [5, 1.0, 5]);
  const solids = L.selectSolidItems([desk, monitor, rug, beam, chairUnderDesk, floating]);
  assert(solids.includes(desk), 'desk solid');
  assert(!solids.includes(monitor), 'monitor resting on the desk is covered by it');
  assert(!solids.includes(rug), 'rug is walked over');
  assert(!solids.includes(beam), 'overhead object is not an obstacle');
  assert(solids.includes(chairUnderDesk), 'a chair pushed under a desk still blocks');
  assert(solids.includes(floating), 'an elevated object with nothing under it stays solid');
  pass('rugs and overhead objects never collide; objects resting on a solid are covered by it; floor-level and floating ones stay solid');

  const shelf = mk([0, 0, -0.25], [0.8, 0.79, 0], [0, 0, 0]);
  const books = mk([0, 0, -0.1], [0.15, 0.1, 0], [0.3, 0.55, -0.1]);
  assert(!L.selectSolidItems([shelf, books]).includes(books), 'books inside the shelf envelope');
  pass('an object standing inside a shelf unit\'s envelope is covered by the shelf');
}

// ---------- 3. tolerant parsing, eye height, floor limits ----------
{
  let pl = L.normalizePlacement({ model: 'x.glb' });
  deq(pl.position, [0, 0, 0]); assert.strictEqual(pl.scale, 1);
  pl = L.normalizePlacement({ position: [1, 'bad'], rotationY: 'bad', scale: 0 });
  deq(pl.position, [1, 0, 0]); assert.strictEqual(pl.rotationYRad, 0); assert.strictEqual(pl.scale, 1);
  assert(L.placementMatrix(pl).every(Number.isFinite));
  pass('a missing, short or non-numeric position/rotation/scale falls back to defaults instead of throwing or producing NaN');

  assert.strictEqual(L.eyeHeightFrom(0), 1.6);
  assert.strictEqual(L.eyeHeightFrom(undefined), 1.6);
  assert.strictEqual(L.eyeHeightFrom(1.2), 1.2);
  assert.strictEqual(L.eyeHeightFrom(1.6), 1.6);
  pass('a ground-level camera/anchor y (SPEC.md section 3.5 example [4, 0, -2]) resolves to the default eye height; real eye heights are kept');

  const limits = L.floorWalkLimits({ size: [10, 9] });
  assert(limits[0] < 5 && limits[0] > 4.8 && limits[1] < 4.5 && limits[1] > 4.3);
  assert.strictEqual(L.floorOverrun(limits, 0, 0), 0);
  assert(L.floorOverrun(limits, 6, 0) > 1);
  assert.strictEqual(L.floorWalkLimits({}), null);
  assert.strictEqual(L.floorOverrun(null, 100, 100), 0);
  pass('floor walk limits keep the player on the floor and are absent when the floor has no usable size');
}

// ---------- 4. GLB loader robustness ----------
function makeGlb(json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const jsonPad = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const binPad = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const total = 12 + 8 + jsonPad.length + 8 + binPad.length;
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonPad.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(binPad.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  const buf = Buffer.concat([header, jh, jsonPad, bh, binPad]);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
function parse(json, bin) { const { json: j, bin: b } = L.parseGLB(makeGlb(json, bin)); return L.extractPrimitives(j, b); }
{
  // Interleaved position(vec3)+normal(vec3), stride 24, 3 vertices, 8-bit indices.
  const verts = [[0, 0, 0], [2, 0, 0], [0, 3, 0]];
  const inter = Buffer.alloc(3 * 24);
  verts.forEach((v, i) => { v.forEach((c, k) => inter.writeFloatLE(c, i * 24 + k * 4)); [0, 0, 1].forEach((c, k) => inter.writeFloatLE(c, i * 24 + 12 + k * 4)); });
  const idx = Buffer.from([0, 1, 2, 0]); // 4 bytes keeps the following data aligned
  const bin = Buffer.concat([inter, idx]);
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, // no min/max on purpose
      { bufferView: 0, byteOffset: 12, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5121, count: 3, type: 'SCALAR' }
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 72, byteStride: 24 }, { buffer: 0, byteOffset: 72, byteLength: 3 }]
  };
  const r = parse(json, bin);
  assert.strictEqual(r.primitives.length, 1);
  const prim = r.primitives[0];
  deq(Array.from(prim.positions), [0, 0, 0, 2, 0, 0, 0, 3, 0]);
  deq(Array.from(prim.normals), [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  pass('interleaved (byteStride) accessors are read per element instead of reading neighbouring attributes as vertex data');
  assert(prim.indices instanceof Uint16Array && Array.from(prim.indices).join() === '0,1,2');
  pass('8-bit indices are widened so drawElements does not read them as 16-bit pairs');
  deq(r.bounds.min, [0, 0, 0]); deq(r.bounds.max, [2, 3, 0]);
  pass('bounds are measured from the vertices when the accessor has no min/max');

  // No scenes array: root nodes are the ones nobody lists as a child.
  const noScene = JSON.parse(JSON.stringify(json)); delete noScene.scene; delete noScene.scenes;
  assert.strictEqual(parse(noScene, bin).primitives.length, 1);
  pass('a GLB with no scene node list still renders its root nodes');

  // Non-triangle primitive is skipped; triangle one stays.
  const mixed = JSON.parse(JSON.stringify(json));
  mixed.meshes[0].primitives.push({ attributes: { POSITION: 0 }, mode: 1 });
  assert.strictEqual(parse(mixed, bin).primitives.length, 1);
  pass('line/point primitives are skipped rather than drawn as triangles');

  // Tightly packed positions starting at byte offset 2 (not a multiple of 4):
  // a Float32Array view over that range throws, so it must be read by element.
  const packed = Buffer.alloc(2 + 36);
  [0, 0, 0, 2, 0, 0, 0, 3, 0].forEach((c, i) => packed.writeFloatLE(c, 2 + i * 4));
  const misJson = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 2, byteLength: 36 }]
  };
  const misPrim = parse(misJson, packed).primitives[0];
  deq(Array.from(misPrim.positions), [0, 0, 0, 2, 0, 0, 0, 3, 0]);
  pass('a misaligned accessor offset is read correctly instead of throwing a RangeError');
}

// ---------- 5. the shipped Lobby ----------
{
  const lobbyDir = path.join(REPO, 'demo-domain-a');
  const scene = JSON.parse(fs.readFileSync(path.join(lobbyDir, 'spatial', 'lobby', 'scene.json'), 'utf8'));
  const modelCache = new Map();
  function modelFor(url) {
    if (!modelCache.has(url)) {
      const buf = fs.readFileSync(path.join(lobbyDir, url));
      const { json, bin } = L.parseGLB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      modelCache.set(url, L.extractPrimitives(json, bin));
    }
    return modelCache.get(url);
  }
  const items = scene.objects.map((o) => {
    const pl = L.normalizePlacement(o);
    return { name: path.basename(o.model, '.glb'), obj: o, footprint: L.placedFootprint(modelFor(o.model).bounds, pl) };
  });
  const byName = (n) => items.filter((i) => i.name === n);
  const inside = (inner, outer, tol) => inner.min[0] >= outer.min[0] - tol && inner.max[0] <= outer.max[0] + tol && inner.min[1] >= outer.min[1] - tol && inner.max[1] <= outer.max[1] + tol;
  const centerInside = (inner, outer) => inner.cx >= outer.min[0] && inner.cx <= outer.max[0] && inner.cz >= outer.min[1] && inner.cz <= outer.max[1];

  // Books sit on the 0.55 shelf board of the bookcase, fully inside it.
  const bookcase = byName('bookcaseClosedWide')[0].footprint;
  const SHELF_BOARD_TOPS = [0.07, 0.31, 0.55];
  byName('books').forEach((b) => {
    assert(inside(b.footprint, bookcase, 0.005), 'books footprint ' + JSON.stringify(b.footprint.min) + JSON.stringify(b.footprint.max) + ' must be inside the bookcase ' + JSON.stringify(bookcase.min) + JSON.stringify(bookcase.max));
    assert(SHELF_BOARD_TOPS.some((y) => Math.abs(b.footprint.minY - y) < 0.01), 'books rest on a shelf board, got y ' + b.footprint.minY);
    assert(b.footprint.maxY <= bookcase.maxY, 'books stay inside the bookcase height');
  });
  pass('Lobby books stand on a shelf board inside the bookcase (no longer floating beside it)');

  const cabinet = byName('cabinetTelevision')[0].footprint, tv = byName('televisionModern')[0].footprint;
  assert(inside(tv, cabinet, 0.005), 'TV footprint must be on the cabinet');
  near(tv.minY, cabinet.maxY, 0.01, 'TV base sits on the cabinet top');
  pass('Lobby TV sits on its cabinet');

  const desk = byName('desk')[0].footprint;
  ['computerScreen', 'computerKeyboard', 'lampRoundTable'].forEach((n) => {
    const f = byName(n)[0].footprint;
    assert(inside(f, desk, 0.005), n + ' must be fully on the desk top');
    near(f.minY, desk.maxY, 0.01, n + ' base sits on the desk top');
  });
  const kb = byName('computerKeyboard')[0].footprint, lamp = byName('lampRoundTable')[0].footprint;
  assert(kb.max[0] < lamp.min[0] || lamp.max[0] < kb.min[0] || kb.max[1] < lamp.min[1] || lamp.max[1] < kb.min[1], 'keyboard and lamp must not overlap');
  pass('Lobby desk items sit fully on the desk top and do not overlap each other');

  // Nothing floats: every elevated object rests on something whose vertical span contains its base.
  items.forEach((it) => {
    if (it.footprint.minY <= 0.05) return;
    const supported = items.some((s) => s !== it && centerInside(it.footprint, s.footprint) && it.footprint.minY >= s.footprint.minY && it.footprint.minY <= s.footprint.maxY + 0.02);
    assert(supported, it.name + ' at y ' + it.footprint.minY + ' is floating');
  });
  pass('no Lobby object floats above the floor without support');

  // Everything is inside the floor.
  const [fw, fd] = scene.floor.size;
  items.forEach((it) => assert(it.footprint.min[0] >= -fw / 2 && it.footprint.max[0] <= fw / 2 && it.footprint.min[1] >= -fd / 2 && it.footprint.max[1] <= fd / 2, it.name + ' is off the floor'));
  pass('every Lobby object is on the floor');

  // Collision set: rug walked over, supported items not separate solids, crates/furniture solid.
  const solids = L.selectSolidItems(items);
  const rug = items.find((i) => i.name === 'rugRectangle');
  assert(!solids.includes(rug), 'rug must not block');
  ['televisionModern', 'computerScreen', 'computerKeyboard', 'lampRoundTable', 'books'].forEach((n) => byName(n).forEach((i) => assert(!solids.includes(i), n + ' is covered by its support')));
  ['desk', 'cabinetTelevision', 'bookcaseClosedWide', 'loungeSofaCorner', 'tableCoffee', 'cardboardBoxClosed'].forEach((n) => byName(n).forEach((i) => assert(solids.includes(i), n + ' must be solid')));
  pass('Lobby collision set: furniture and crates solid, rug walkable, supported items covered by their support');

  // Reachability: spawn, portal markers must not be inside a solid; an anchor may overlap slightly (escape rule) but never deeply.
  const depthAt = (x, z) => solids.reduce((d, s) => d + L.footprintDepth(s.footprint, x, z, L.PLAYER_RADIUS), 0);
  const start = scene.camera.start;
  assert.strictEqual(depthAt(start[0], start[2]), 0, 'camera.start must be free');
  (scene.portalMarkers || []).forEach((m) => assert.strictEqual(depthAt(m.position[0], m.position[2]), 0, 'portal marker ' + m.portalIndex + ' must be reachable'));
  (scene.anchors || []).forEach((a) => assert(depthAt(a.position[0], a.position[2]) < 0.25, 'anchor ' + a.id + ' must not spawn deep inside furniture'));
  pass('Lobby spawn and portal markers are reachable, anchors never start deep inside a solid');
}

console.log('\nALL ' + checks + ' 3D LAYOUT CHECKS PASSED');
