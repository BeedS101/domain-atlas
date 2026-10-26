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
//   5. The shipped Lobby: larger floor, every object sits where it should
//      (books on a shelf, TV on its cabinet, monitor and keyboard on the
//      desk and facing the chair, lamp clear of them), nothing floats or
//      overlaps, and the spawn, anchors, portal, crates and all four room
//      edges are reachable by the real collision rules.

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

  const openDoor = Object.assign(mk([0, 0, -0.1], [1, 1.29, 0], [4, 0, 4]), { solid: false });
  assert(!L.selectSolidItems([openDoor]).includes(openDoor), 'solid:false opts an object out of collision');
  pass('an object marked solid:false (a doorway whose bounding box is mostly opening) gets no collision box');
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
  // An off-center floor (scene.json floor.center) is bounded around its own center.
  const offset = L.floorWalkLimits({ size: [10, 20], center: [0, 5] });
  assert.strictEqual(L.floorOverrun(offset, 0, 14), 0);
  assert(L.floorOverrun(offset, 0, 15) > 0.05);
  assert(L.floorOverrun(offset, 0, -4.8) === 0 && L.floorOverrun(offset, 0, -5.5) > 0.3);
  assert.strictEqual(L.floorOverrun(L.floorWalkLimits({ size: [10, 9], center: ['x', 1] }), 0, 4), 0);
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
    return { name: path.basename(o.model, '.glb'), obj: o, solid: o.solid !== false, footprint: L.placedFootprint(modelFor(o.model).bounds, pl) };
  });
  const byName = (n) => items.filter((i) => i.name === n);
  const inside = (inner, outer, tol) => inner.min[0] >= outer.min[0] - tol && inner.max[0] <= outer.max[0] + tol && inner.min[1] >= outer.min[1] - tol && inner.max[1] <= outer.max[1] + tol;
  const centerInside = (inner, outer) => inner.cx >= outer.min[0] && inner.cx <= outer.max[0] && inner.cz >= outer.min[1] && inner.cz <= outer.max[1];

  const byPrefix = (p) => items.filter((i) => i.name.startsWith(p));

  // The room is larger than the original 10 x 9 Lobby.
  const [fw, fd] = scene.floor.size;
  const FC = L.floorCenter(scene.floor);
  assert(fw > 10 && fd > 9, 'the Lobby floor should be larger than the original 10 x 9, got ' + fw + ' x ' + fd);
  pass('Lobby floor is larger than the original 10 x 9 (' + fw + ' x ' + fd + ')');

  // Books sit on a shelf board inside a bookcase, or on a side table top.
  const bookHosts = [...byPrefix('bookcase'), ...byName('sideTable')];
  const SHELF_BOARD_TOPS = [0.07, 0.31, 0.55];
  const books = byName('books');
  assert(books.length > 0, 'the Lobby should have books');
  books.forEach((b) => {
    const host = bookHosts.find((c) => inside(b.footprint, c.footprint, 0.005));
    assert(host, 'books footprint ' + JSON.stringify(b.footprint.min) + JSON.stringify(b.footprint.max) + ' must be inside a bookcase or on a side table');
    if (host.name === 'sideTable') near(b.footprint.minY, host.footprint.maxY, 0.01, 'books rest on the table top');
    else assert(SHELF_BOARD_TOPS.some((y) => Math.abs(b.footprint.minY - y) < 0.01), 'books rest on a shelf board, got y ' + b.footprint.minY);
    assert(b.footprint.maxY <= host.footprint.maxY + 0.3, 'books stay within reach of their support');
  });
  pass('Lobby books stand on a shelf board or a table top (no longer floating beside the bookcase)');

  const cabinet = byName('cabinetTelevision')[0].footprint, tv = byName('televisionModern')[0].footprint;
  assert(inside(tv, cabinet, 0.005), 'TV footprint must be on the cabinet');
  near(tv.minY, cabinet.maxY, 0.01, 'TV base sits on the cabinet top');
  pass('Lobby TV sits on its cabinet');

  // Reception desk: screen, keyboard and chair agree on which way is "front". Every kit model faces local +z,
  // so a model's front direction in the world is (sin r, cos r) in the renderer's rotation convention.
  const front = (it) => { const r = (it.obj.rotationY || 0) * Math.PI / 180; return [Math.sin(r), Math.cos(r)]; };
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const toward = (from, to) => [to.footprint.cx - from.footprint.cx, to.footprint.cz - from.footprint.cz];
  const screen = byName('computerScreen')[0], keyboard = byName('computerKeyboard')[0];
  const deskTops = byName('desk');
  const deskOf = (it) => deskTops.find((d) => inside(it.footprint, d.footprint, 0.005));
  [screen, keyboard, ...byName('lampRoundTable'), ...byName('laptop'), ...byName('radio')].forEach((it) => {
    const d = deskOf(it);
    assert(d, it.name + ' must be fully on a desk top');
    near(it.footprint.minY, d.footprint.maxY, 0.01, it.name + ' base sits on the desk top');
  });
  assert(deskOf(screen) === deskOf(keyboard), 'the monitor and its keyboard share a desk');
  const chair = byName('chairDesk').map((c) => ({ c, d: Math.hypot(...toward(screen, c)) })).sort((x, y) => x.d - y.d)[0].c;
  near(dot(front(screen), front(keyboard)), 1, 1e-6, 'screen and keyboard face the same way');
  assert(dot(front(screen), toward(screen, chair)) > 0.9 * Math.hypot(...toward(screen, chair)), 'the monitor faces the chair side of the desk');
  assert(dot(front(chair), front(screen)) < -0.99, 'the seated person (looking along the chair front) looks straight at the screen face');
  const toKeyboard = toward(screen, keyboard);
  assert(dot(front(screen), toKeyboard) > 0.05, 'the keyboard is on the chair side of the monitor, in front of it');
  assert(Math.hypot(...toward(keyboard, chair)) < Math.hypot(...toward(screen, chair)), 'the keyboard sits between the chair and the monitor');
  assert(Math.abs(dot([-front(screen)[1], front(screen)[0]], toKeyboard)) < 0.1, 'the keyboard is centered in front of the monitor');
  const deskItems = items.filter((i) => ['computerScreen', 'computerKeyboard', 'lampRoundTable', 'laptop', 'radio'].includes(i.name) && deskOf(i) === deskOf(screen));
  for (let i = 0; i < deskItems.length; i++) for (let j = i + 1; j < deskItems.length; j++) {
    const A = deskItems[i].footprint, B = deskItems[j].footprint;
    assert(A.max[0] <= B.min[0] + 1e-6 || B.max[0] <= A.min[0] + 1e-6 || A.max[1] <= B.min[1] + 1e-6 || B.max[1] <= A.min[1] + 1e-6, deskItems[i].name + ' and ' + deskItems[j].name + ' overlap on the desk');
  }
  pass('Lobby screen and keyboard face the chair, keyboard in front of the monitor, desk items (lamp included) do not overlap');

  // ---- exterior ----
  // The outdoor town (ground, paths, river, hedges, fountain, hut, mine) is covered by manual-3d-town-layout-unit.js;
  // this checks the outdoor-kit props that are still placed and the building's entrance.
  const outdoor = items.filter((i) => i.obj.model.startsWith('/assets/outdoor/'));
  const outCount = (n) => outdoor.filter((i) => i.name === n).length;
  ['shrub', 'treeSmall', 'benchOutdoor', 'lampPost', 'welcomeSign', 'planterBox'].forEach((n) => assert(outCount(n) > 0, 'the exterior should use ' + n));
  assert.strictEqual(outCount('welcomeSign'), 1);
  assert(outCount('lampPost') >= 4 && outCount('benchOutdoor') >= 4, 'lit, furnished public spaces');
  outdoor.forEach((i) => assert(i.obj.scale === undefined || i.obj.scale >= 1 || i.name === 'treeSmall', i.name + ' keeps its native size or larger'));
  const buildingSouth = Math.max(...items.filter((i) => i.name.startsWith('wall')).map((i) => i.footprint.max[1]));
  outdoor.forEach((i) => assert(i.obj.position[1] === 0, i.name + ' stands on the ground'));
  outdoor.forEach((it) => assert(it.footprint.minY >= -0.07, it.name + ' is buried below the floor (' + it.footprint.minY + ')'));
  const door = items.find((i) => i.name === 'wallDoorwayWide');
  assert(door && door.solid === false && door.footprint.max[1] >= buildingSouth - 0.001, 'the exterior door is an open, collision-free piece of the south wall');
  const doorX = door.footprint.cx;
  const nearDoor = (n) => Math.hypot(outdoor.find((i) => i.name === n).footprint.cx - doorX, outdoor.find((i) => i.name === n).footprint.cz - buildingSouth);
  assert(nearDoor('welcomeSign') < 3, 'the welcome sign stands by the entrance');
  pass('exterior: outdoor-kit props stand on the ground, the welcome sign is by the open door');

  // Nothing floats: every elevated object rests on something whose vertical span contains its base.
  items.forEach((it) => {
    if (it.footprint.minY <= 0.05) return;
    const supported = items.some((s) => s !== it && centerInside(it.footprint, s.footprint) && it.footprint.minY >= s.footprint.minY && it.footprint.minY <= s.footprint.maxY + 0.02);
    assert(supported, it.name + ' at y ' + it.footprint.minY + ' is floating');
  });
  pass('no Lobby object floats above the floor without support');

  // Everything is inside the floor (the thicker window pieces overshoot by under a millimetre).
  // The sky box, the ground skirt and the non-solid tree line outside the hedges deliberately extend past it.
  const beyondFloor = (it) => /townSky|townGround|riverBanks/.test(it.obj.model) || (it.obj.solid === false && /pine|treeSmall/.test(it.obj.model));
  // town pieces (river ends, mine hill, hedges) may run up to 0.6 m past the floor edge, where the floor limit already stops the player
  const tol = (it) => (it.obj.model.startsWith('/assets/town/') ? 0.6 : 0.002);
  items.filter((it) => !beyondFloor(it)).forEach((it) => assert(it.footprint.min[0] >= FC[0] - fw / 2 - tol(it) && it.footprint.max[0] <= FC[0] + fw / 2 + tol(it) && it.footprint.min[1] >= FC[1] - fd / 2 - tol(it) && it.footprint.max[1] <= FC[1] + fd / 2 + tol(it), it.name + ' is off the floor'));
  pass('every Lobby object is on the floor');

  // Collision set: rug walked over, supported items not separate solids, crates/furniture solid.
  const solids = L.selectSolidItems(items);
  byName('rugRectangle').forEach((r) => assert(!solids.includes(r), 'rug must not block'));
  ['televisionModern', 'computerScreen', 'computerKeyboard', 'lampRoundTable', 'books'].forEach((n) => byName(n).forEach((i) => assert(!solids.includes(i), n + ' is covered by its support')));
  ['desk', 'chairDesk', 'cabinetTelevision', 'bookcaseClosedWide', 'bookcaseOpen', 'loungeSofa', 'loungeChair', 'tableCoffee', 'tableRound', 'cardboardBoxClosed', 'wall'].forEach((n) => {
    assert(byName(n).length > 0, 'the Lobby should contain ' + n);
    byName(n).forEach((i) => assert(solids.includes(i), n + ' must be solid'));
  });
  pass('Lobby collision set: furniture, walls and crates solid, rugs walkable, supported items covered by their support');

  // Solid furniture does not interpenetrate (wall pieces butt against each other on purpose).
  for (let i = 0; i < solids.length; i++) for (let j = i + 1; j < solids.length; j++) {
    const A = solids[i], B = solids[j];
    if (A.name.startsWith('wall') && B.name.startsWith('wall')) continue;
    if (A.name === 'hedge' || B.name === 'hedge') continue; // hedges meet at the lot corners and trees stand against them
    if (/mineHill|riverWater/.test(A.obj.model + B.obj.model)) continue; // landscape pieces are one big box with props standing in front
    const ox = Math.min(A.footprint.max[0], B.footprint.max[0]) - Math.max(A.footprint.min[0], B.footprint.min[0]);
    const oz = Math.min(A.footprint.max[1], B.footprint.max[1]) - Math.max(A.footprint.min[1], B.footprint.min[1]);
    assert(!(ox > 0.01 && oz > 0.01), A.name + ' overlaps ' + B.name + ' by ' + ox.toFixed(2) + ' x ' + oz.toFixed(2));
  }
  pass('no two solid Lobby objects overlap');

  // Reachability on a 0.1 grid with the real player radius, floor limits and solids.
  const limits = L.floorWalkLimits(scene.floor);
  const depthAt = (x, z) => L.floorOverrun(limits, x, z) + solids.reduce((d, s) => d + L.footprintDepth(s.footprint, x, z, L.PLAYER_RADIUS), 0);
  const start = scene.camera.start;
  assert.strictEqual(depthAt(start[0], start[2]), 0, 'camera.start must be free');
  (scene.portalMarkers || []).forEach((m) => assert.strictEqual(depthAt(m.position[0], m.position[2]), 0, 'portal marker ' + m.portalIndex + ' must be free'));
  (scene.anchors || []).forEach((a) => assert.strictEqual(depthAt(a.position[0], a.position[2]), 0, 'anchor ' + a.id + ' must be free'));
  const STEP = 0.1;
  const nx = Math.round(fw / STEP), nz = Math.round(fd / STEP);
  const gx = (i) => FC[0] - fw / 2 + i * STEP, gz = (j) => FC[1] - fd / 2 + j * STEP;
  const seen = Array.from({ length: nx + 1 }, () => new Uint8Array(nz + 1));
  const si = Math.round((start[0] - FC[0] + fw / 2) / STEP), sj = Math.round((start[2] - FC[1] + fd / 2) / STEP);
  const queue = [[si, sj]]; seen[si][sj] = 1;
  while (queue.length) {
    const [i, j] = queue.pop();
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni > nx || nj > nz || seen[ni][nj] || depthAt(gx(ni), gz(nj)) !== 0) continue;
      seen[ni][nj] = 1; queue.push([ni, nj]);
    }
  }
  const reachable = (x, z, radius) => { for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) if (seen[i][j] && Math.hypot(gx(i) - x, gz(j) - z) <= radius) return true; return false; };
  (scene.portalMarkers || []).forEach((m) => assert(reachable(m.position[0], m.position[2], 0.2), 'portal ' + m.portalIndex + ' must be reachable from the spawn'));
  (scene.anchors || []).forEach((a) => assert(reachable(a.position[0], a.position[2], 0.2), 'anchor ' + a.id + ' must be reachable from the spawn'));
  (scene.interactables || []).forEach((m) => assert(reachable(m.position[0], m.position[2], 1.2), 'crate ' + m.class + ' must be reachable from the spawn'));
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, cells = 0;
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) if (seen[i][j]) { cells++; minX = Math.min(minX, gx(i)); maxX = Math.max(maxX, gx(i)); minZ = Math.min(minZ, gz(j)); maxZ = Math.max(maxZ, gz(j)); }
  assert(minX < FC[0] - fw / 2 + 2.0 && maxX > FC[0] + fw / 2 - 4.5 && minZ < FC[1] - fd / 2 + 2.0 && maxZ > FC[1] + fd / 2 - 2.0, 'the player can walk to all four edges of the lot (the hedges and the river stop the walk a little short), got x ' + minX + '..' + maxX + ' z ' + minZ + '..' + maxZ);
  assert(cells * STEP * STEP > 0.55 * fw * fd, 'at least 55% of the floor stays walkable, got ' + (100 * cells * STEP * STEP / (fw * fd)).toFixed(0) + '%');
  pass('Lobby portal, anchors and every crate are reachable from the spawn; all four edges can be walked to; ' + (100 * cells * STEP * STEP / (fw * fd)).toFixed(0) + '% of the floor is walkable');

  // ---- exterior reachability and bounds ----
  const free = (x, z) => depthAt(x, z) === 0;
  for (let z = buildingSouth - 0.4; z <= 9.5; z += 0.2) assert(free(doorX, z), 'the doorway and the line into the plaza is clear at z ' + z.toFixed(1));
  assert(!free(0, buildingSouth - 0.05), 'the centre (portal) doorway stays closed off');
  const walkable = (i) => i.solid !== false;
  outdoor.filter(walkable).forEach((i) => assert(reachable(i.footprint.cx, i.footprint.cz, Math.max(i.footprint.hx, i.footprint.hz) + 0.9), i.name + ' at (' + i.footprint.cx.toFixed(1) + ', ' + i.footprint.cz.toFixed(1) + ') can be walked up to'));
  [[-6, 7], [6, 8], [-12, 14], [7.4, 12.4], [0, 9]].forEach(([x, z]) => assert(reachable(x, z, 0.2), 'outdoor point (' + x + ', ' + z + ') is reachable'));
  const outdoorCells = (() => { let n = 0; for (let i = 0; i <= nx; i++) for (let j = 0; j <= nz; j++) if (seen[i][j] && gz(j) > buildingSouth) n++; return n; })();
  assert(outdoorCells * STEP * STEP > 0.4 * fw * (FC[1] + fd / 2 - buildingSouth), 'most of the ground south of the building is walkable');
  assert(maxZ <= FC[1] + fd / 2 - 0.1 + 1e-9 && maxZ > FC[1] + fd / 2 - 2, 'the town is bounded by the south hedge and reaches it');
  pass('exterior: the doorway and the line into the plaza are clear, the centre doorway is closed off, every solid prop can be walked up to, and the town is bounded');

  // Loot markers match their crate objects by exact position.
  (scene.interactables || []).forEach((m) => assert(byName('cardboardBoxClosed').some((c) => c.obj.position[0] === m.position[0] && c.obj.position[2] === m.position[2]), 'interactable ' + m.class + ' has no crate object at its position'));
  pass('every interactable sits exactly on a crate object');
}

console.log('\nALL ' + checks + ' 3D LAYOUT CHECKS PASSED');
