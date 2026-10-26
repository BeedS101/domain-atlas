// Data and walkability checks (no browser) for the Domain A Lobby's outdoor
// town, using the renderer's own placement and collision math on the real
// scene.json:
//
//   1. The playable floor is the expanded lot (40 x 40 m) and the scene is
//      what tools/make-lobby-town-scene.js produces from the layout.
//   2. Nothing that existed before moved: the building and everything inside it,
//      the portal marker and gate, crates (interactables), the reading nook
//      anchor, spawn, lighting and character scale are byte-for-byte the same.
//   3. The new models are valid, within a size budget, use only the supported
//      texture subset, and are exactly what tools/make-town-assets.js produces.
//   4. Walkability on a 0.1 m grid for a player-sized body: out of the entrance,
//      all the way round the building (without cutting through it), to every zone
//      and back; paths are wide enough; the boundary is sealed; there are no
//      narrow dead-end pockets; the areas reserved for later activities are empty.
//   5. Obstacles are where they should be: the river and the mine hill block,
//      ground, paving, the pier and the signpost do not.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');

const lib = require('./town-walk-lib');
const { REPO, DOMAIN_DIR, L, parseGlb, modelBounds, readScene, collision, makeGrid, flood, groups } = lib;
const LAY = require(path.join(REPO, 'tools', 'lib', 'lobby-town-layout.js'));
const sceneTool = require(path.join(REPO, 'tools', 'make-lobby-town-scene.js'));
const assets = require(path.join(REPO, 'tools', 'make-town-assets.js'));

const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
let checks = 0;
const pass = (msg) => { checks++; console.log('PASS: ' + msg); };

const scenePath = path.join(DOMAIN_DIR, 'spatial', 'lobby', 'scene.json');
const sceneText = fs.readFileSync(scenePath, 'utf8');
const scene = JSON.parse(sceneText);
const OUTDOOR = /\/assets\/(outdoor|town)\//;
const townObjects = scene.objects.filter((o) => OUTDOOR.test(o.model));
const interior = scene.objects.filter((o) => !OUTDOOR.test(o.model));

// ---- 1. floor and generated scene ----
{
  assert.deepStrictEqual(scene.floor, { size: [40, 40], center: [0, 3], color: '#3a2f22' });
  const limits = L.floorWalkLimits(scene.floor);
  assert(limits[0] * 2 >= 30 && limits[1] * 2 >= 30, 'at least 30 m each way');
  assert.strictEqual(scene.floor.size[0] * scene.floor.size[1], 1600);
  assert.strictEqual(sceneTool.render(sceneText), sceneText, 'scene.json must equal the generator output (run node tools/make-lobby-town-scene.js)');
  pass('the floor is 40 x 40 m (1600 m2, up from 14.4 x 17.4) and scene.json is exactly what tools/make-lobby-town-scene.js produces');
}

// ---- 2. nothing that existed moved ----
{
  // Fingerprints of the Lobby as it was before the town: 110 non-outdoor objects (walls, furniture, portal gate, crates)
  // and the markers, interactables, anchors, spawn, lights and character scale.
  assert.strictEqual(interior.length, 110);
  assert.strictEqual(sha(JSON.stringify(interior)), '674311223f2f4bb4ff3991102d5ea4d3126583f125b17d4f946d0426d7aadbeb', 'building, furniture, portal gate and crates are unchanged');
  const fixed = { portalMarkers: scene.portalMarkers, interactables: scene.interactables, anchors: scene.anchors, camera: scene.camera, characterScale: scene.characterScale, ambientLight: scene.ambientLight, directionalLight: scene.directionalLight };
  assert.strictEqual(sha(JSON.stringify(fixed)), 'b39020f9be20dfe3e1e2ee161059739c22c35e522fa4a28e8d58be898a131aeb', 'markers, interactables, anchors, spawn, lights and character scale are unchanged');
  assert.strictEqual(scene.characterScale, 0.5);
  assert.deepStrictEqual(scene.portalMarkers, [{ position: [0, 0, 4.7], radius: 0.8, portalIndex: 0, hideMarker: true }]);
  assert.deepStrictEqual(scene.anchors, [{ id: 'reading-nook', position: [-3.9, 1.6, -0.8], label: 'Reading Nook' }]);
  assert.strictEqual(scene.interactables.length, 8);
  assert.deepStrictEqual(scene.camera, { start: [0, 1.6, 3.4], startYaw: 0 });
  const gate = scene.objects.filter((o) => o.model === '/assets/portals/townPortal.glb');
  assert.deepStrictEqual(gate, [{ model: '/assets/portals/townPortal.glb', position: [0, 0, 4.7], rotationY: 180, solid: false }]);
  assert.strictEqual(sha(fs.readFileSync(path.join(DOMAIN_DIR, 'assets', 'portals', 'townPortal.glb'))), 'f6ebca8dedb6c24e041bb6df65c9621635e5a3d8df863d3fed30ec3ccb7a0d6f', 'the textured portal gate is unchanged');
  const manifest = JSON.parse(fs.readFileSync(path.join(DOMAIN_DIR, '.well-known', 'spatial.json'), 'utf8'));
  const lobby = manifest.worlds.find((w) => w.id === 'lobby');
  assert.deepStrictEqual(lobby.portals, [{ kind: 'world', to: 'plaza', label: 'Back to the Plaza' }]);
  assert(/^localhost:\d+$/.test(manifest.domain), 'the manifest keeps its local demo address');
  pass('every pre-existing object, interactable, anchor, the portal marker and gate, spawn, lights and character scale 0.5 are unchanged (checked by fingerprint)');
}

// ---- 3. models ----
{
  const dir = path.join(DOMAIN_DIR, 'assets', 'town');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.glb')).sort();
  assert.deepStrictEqual(files, Object.keys(assets.MODELS).map((n) => n + '.glb').sort(), 'the town folder holds exactly the generated models');
  const used = new Set(townObjects.map((o) => o.model).filter((m) => m.startsWith('/assets/town/')).map((m) => path.basename(m)));
  assert.deepStrictEqual([...used].sort(), files, 'every model is used by the scene and every used model exists');
  assert(files.length <= 25, 'a small, reusable set of models, got ' + files.length);
  let total = 0;
  files.forEach((f) => {
    const buf = fs.readFileSync(path.join(dir, f));
    total += buf.length;
    assert(buf.length < 200 * 1024, f + ' stays small, got ' + buf.length);
    assert(buf.equals(assets.buildModel(path.basename(f, '.glb'))), f + ' must equal the generator output');
    const { json, bin } = parseGlb(buf);
    assert.strictEqual(json.asset.version, '2.0');
    assert(!json.extensionsUsed && !json.extensionsRequired, f + ' uses no extensions');
    assert((json.buffers || []).every((b) => !b.uri), f + ' has no external buffers');
    assert(!/[A-Za-z]:\\|\\\\|\/home\/|\/tmp\/|\/Users\/|file:|https?:/.test(JSON.stringify(json)), f + ' has no local or absolute paths');
    (json.materials || []).forEach((m) => {
      assert(!m.alphaMode || m.alphaMode === 'OPAQUE', f + ': opaque materials only');
      ['normalTexture', 'occlusionTexture', 'emissiveTexture'].forEach((k) => assert(!m[k], f + ' has no ' + k));
      assert(!m.pbrMetallicRoughness.metallicRoughnessTexture, f + ' has no metallic-roughness texture');
    });
    (json.images || []).forEach((img, i) => {
      assert(img.bufferView !== undefined && !img.uri && img.mimeType === 'image/png', f + ' image ' + i + ' is an embedded PNG');
      const view = json.bufferViews[img.bufferView];
      const png = Buffer.from(bin.slice(view.byteOffset, view.byteOffset + view.byteLength));
      assert.strictEqual(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
      assert(w <= 512 && h <= 512, f + ' image ' + i + ' is ' + w + 'x' + h);
      assert((w & (w - 1)) === 0 && (h & (h - 1)) === 0, f + ' image ' + i + ' has power-of-two sides (' + w + 'x' + h + ')');
    });
    const r = L.extractPrimitives(json, bin);
    assert(r.primitives.length > 0, f + ' has geometry');
    r.primitives.forEach((p) => {
      assert(!p.textureWarning, f + ': ' + p.textureWarning);
      if (p.baseColorTexture) assert(p.uvs && p.uvs.length === (p.positions.length / 3) * 2 && Array.from(p.uvs).every(Number.isFinite), f + ' has finite UVs for its textured primitives');
    });
  });
  assert(total < 1.2 * 1024 * 1024, 'the whole set stays under 1.2 MB, got ' + total);
  assert(townObjects.length <= 200, 'a modest number of outdoor objects, got ' + townObjects.length);
  pass(files.length + ' new models (' + Math.round(total / 1024) + ' KB in all, each < 200 KB, textures <= 512 px): valid GLB 2.0, embedded PNG base-colour textures only, no extensions or paths, identical to the generator output');
  pass(townObjects.length + ' outdoor objects reusing ' + new Set(townObjects.map((o) => o.model)).size + ' models');
}

// ---- 4. walkability ----
const col = collision(scene);
const G3 = makeGrid(scene, L.PLAYER_RADIUS, 0.1);
const G45 = makeGrid(scene, L.PLAYER_RADIUS + 0.15, 0.1);
const inBuilding = (x, z) => x > LAY.BUILDING.minX - 0.05 && x < LAY.BUILDING.maxX + 0.05 && z > LAY.BUILDING.minZ - 0.05 && z < LAY.BUILDING.maxZ + 0.05;
{
  const start = LAY.ZONES.entrance.stand;
  const reach = flood(G3, start);
  assert(reach, 'the doorstep is walkable');
  // from the spawn, inside the Lobby, out through the entrance
  const fromSpawn = flood(G3, [0, 3.4]);
  assert(fromSpawn && fromSpawn[G3.idx(start[0], start[1])], 'the doorstep is reachable from the spawn inside');
  assert(fromSpawn[G3.idx(3.2, 5.55)] && fromSpawn[G3.idx(3.2, 5.9)], 'the walk from the spawn goes through the entrance doorway');
  // ... and every zone is reachable from the doorstep
  for (const [id, z] of Object.entries(LAY.ZONES)) assert(reach[G3.idx(z.stand[0], z.stand[1])], 'zone "' + id + '" (' + z.label + ') is reachable from the entrance at ' + JSON.stringify(z.stand));
  // ... and back inside from every zone (the walk is symmetric: check from each zone)
  for (const [id, z] of Object.entries(LAY.ZONES)) {
    const back = flood(G3, z.stand);
    assert(back && back[G3.idx(0, 3.4)], 'from zone "' + id + '" the player can walk back into the Lobby');
  }
  pass('from the spawn out through the entrance, and from every zone (' + Object.keys(LAY.ZONES).join(', ') + ') back inside');

  // the walk round the building, without cutting through it
  const outside = flood(G3, start, inBuilding);
  const corners = LAY.PERIMETER;
  corners.forEach((p) => assert(outside[G3.idx(p[0], p[1])], 'the walk-round point ' + JSON.stringify(p) + ' is reachable without entering the building'));
  // the north side has to be reachable going either way round: block the west and east halves in turn
  const eastOnly = flood(G3, start, (x, z) => inBuilding(x, z) || (x < -3 && z < 8.4 && z > -9.6 && x < -7.9));
  assert(eastOnly[G3.idx(0, -8)] && eastOnly[G3.idx(9.4, -8)], 'the north side is reachable by going round the east side alone');
  const westOnly = flood(G3, start, (x, z) => inBuilding(x, z) || (x > 7.9 && z < 8.4 && z > -9.6));
  assert(westOnly[G3.idx(0, -8)] && westOnly[G3.idx(-9.4, -8)], 'the north side is reachable by going round the west side alone');
  // clear strip on every side of the building: at least 1.2 m of walkable ground between the wall and anything solid
  const sides = [['north', (t) => [t, -5.6 - 1.4]], ['south', (t) => [t, 5.6 + 1.4]], ['west', (t) => [-7.2 - 1.4, t]], ['east', (t) => [7.2 + 1.4, t]]];
  sides.forEach(([name, at]) => {
    const lo = name === 'north' || name === 'south' ? -9 : -7.5, hi = name === 'north' || name === 'south' ? 9 : 7.5;
    let walkable = 0, total = 0;
    for (let t = lo; t <= hi; t += 0.1) { const p = at(t); total++; if (!col.blocked(p[0], p[1], 0.3)) walkable++; }
    assert(walkable / total > 0.9, 'a strip along the ' + name + ' wall is walkable (' + Math.round(100 * walkable / total) + '%)');
  });
  pass('all four sides of the building can be walked: the north, west and east sides are reached by going round either way without passing through the building');

  // paths: wide enough (a body 0.6 m wider than the player's still fits) along every footpath centre line
  let sampled = 0;
  // (the last 1.2 m of a spur is the approach to a hut, mine or pier, which is meant to be close to it)
  LAY.PATHS.forEach(([ax, az, bx, bz], pi) => {
    const len = Math.hypot(bx - ax, bz - az);
    const spurEnd = pi >= LAY.RING.length;
    for (let s = 0; s <= (spurEnd ? len - 1.2 : len); s += 0.1) {
      const x = ax + (bx - ax) * s / len, z = az + (bz - az) * s / len;
      assert(!col.blocked(x, z, 0.3 + 0.3), 'footpath centre line is at least 1.2 m wide of obstacles at ' + x.toFixed(1) + ', ' + z.toFixed(1));
      sampled++;
    }
  });
  // door to plaza lane
  for (let z = 5.0; z <= 9.5; z += 0.1) assert(!col.blocked(3.2, z, 0.3 + 0.2), 'the line from the entrance into the plaza is clear at z ' + z.toFixed(1));
  pass(sampled + ' sample points along every footpath keep 0.6 m clear on either side; the line from the entrance to the plaza is clear');

  // sealed boundary: the reachable ground stays inside the hedges and the river
  let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity, n = 0;
  for (let k = 0; k < G3.nx * G3.nz; k++) if (reach[k]) { const [x, z] = G3.at(k); n++; mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mnz = Math.min(mnz, z); mxz = Math.max(mxz, z); }
  assert(mnx > -19.0 && mxx < 16.2 && mnz > -16.0 && mxz < 22.0, 'reachable area stays inside the boundary: ' + JSON.stringify([mnx, mxx, mnz, mxz]));
  pass('the boundary (hedges, mine hill, river) is sealed: the reachable ground spans x ' + mnx.toFixed(1) + '..' + mxx.toFixed(1) + ', z ' + mnz.toFixed(1) + '..' + mxz.toFixed(1) + ' (' + Math.round(n / 100) + ' m2)');

  // narrow dead ends: ground that can only be entered through a gap narrower than the player plus 0.3 m
  const wide = flood(G45, start);
  const near = new Uint8Array(G3.nx * G3.nz);
  for (let j = 0; j < G3.nz; j++) for (let i = 0; i < G3.nx; i++) {
    if (!wide[j * G3.nx + i]) continue;
    for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) { const ni = i + di, nj = j + dj; if (ni >= 0 && nj >= 0 && ni < G3.nx && nj < G3.nz) near[nj * G3.nx + ni] = 1; }
  }
  const pockets = groups(G3, (k) => reach[k] && !near[k] && !inBuilding(...G3.at(k))).filter((c) => c.cells >= 50);
  assert.deepStrictEqual(pockets, [], 'no narrow pockets outdoors (>= 0.5 m2 only enterable through a gap < 0.9 m): ' + JSON.stringify(pockets));
  const stranded = groups(G3, (k) => !G3.cells[k] && !reach[k] && !inBuilding(...G3.at(k))).filter((c) => c.cells >= 20);
  assert.deepStrictEqual(stranded, [], 'no free ground cut off from the entrance outdoors: ' + JSON.stringify(stranded));
  pass('no narrow dead-end pockets outdoors, and no walkable ground that the entrance cannot reach');
}

// ---- reserved areas ----
{
  const reach = flood(G3, LAY.ZONES.entrance.stand);
  for (const [id, z] of Object.entries(LAY.ZONES)) {
    if (!z.clear) continue;
    const [x0, z0, x1, z1] = z.clear;
    for (let x = x0; x <= x1 + 1e-9; x += 0.1) for (let zz = z0; zz <= z1 + 1e-9; zz += 0.1) {
      assert(!col.blocked(x, zz, 0.3), 'reserved area "' + id + '" is open ground at ' + x.toFixed(1) + ', ' + zz.toFixed(1));
      assert(reach[G3.idx(x, zz)], 'reserved area "' + id + '" is reachable at ' + x.toFixed(1) + ', ' + zz.toFixed(1));
    }
    const standIn = z.stand[0] >= x0 - 1 && z.stand[0] <= x1 + 1 && z.stand[1] >= z0 - 1 && z.stand[1] <= z1 + 1;
    assert(standIn, 'the standing spot of "' + id + '" is at its reserved area');
    // no solid object has its pivot inside the area (flat, walk-over scenery such as the pier is allowed)
    townObjects.forEach((o) => {
      if (o.solid === false || /townGround|townPaths|riverBanks|townSky|mineHill|riverWater/.test(o.model)) return;
      const [px, , pz] = o.position;
      if (px >= x0 && px <= x1 && pz >= z0 && pz <= z1) assert(false, 'object ' + o.model + ' at ' + o.position + ' stands in the reserved "' + id + '" area');
    });
  }
  pass('the seven areas reserved for later activities (' + Object.entries(LAY.ZONES).filter(([, z]) => z.clear).map(([k]) => k).join(', ') + ') are open, reachable and hold no objects');
}

// ---- 5. obstacles and ground ----
{
  const mine = LAY.MINE, R = LAY.RIVER;
  assert(col.blocked(mine.entranceX, mine.maxZ - 0.5), 'the mine front is solid (the opening is only a recess)');
  assert(col.blocked((mine.minX + mine.maxX) / 2, (mine.minZ + mine.maxZ) / 2), 'the mine hill is solid');
  assert(!col.blocked(mine.entranceX, mine.maxZ + 1.0), 'the rock yard in front of the mine is open');
  for (let z = -16; z <= 22; z += 0.5) assert(col.blocked((R.minX + R.maxX) / 2, z), 'the river blocks along its whole length at z ' + z);
  assert(!col.blocked(15.0, 3.7) && !col.blocked(16.0, 3.7), 'the pier and the bank up to the water are walkable');
  assert(col.blocked(16.4, 3.7), 'the water edge stops the player');
  // flat ground and signs never block
  const nonSolid = ['townGround', 'townPaths', 'riverBanks', 'townSky', 'townSignpost', 'pier', 'flowerBed'];
  scene.objects.filter((o) => nonSolid.some((n) => o.model.endsWith('/' + n + '.glb'))).forEach((o) => assert(o.solid === false, o.model + ' is flagged non-solid'));
  scene.objects.filter((o) => /townGround|townPaths|riverBanks|townSky/.test(o.model)).forEach((o) => {
    const b = modelBounds(o.model);
    if (!/townSky/.test(o.model)) assert(b.max[1] < 0.06, o.model + ' is a flat ground layer');
  });
  const water = modelBounds('/assets/town/riverWater.glb');
  assert(water.max[1] >= 0.05, 'the water is above the renderer\'s floor-covering height (' + water.max[1] + '), so it is an obstacle');
  // trees and rocks outside the playable area do nothing
  const far = townObjects.filter((o) => o.solid === false && /\/pine\.glb|treeSmall/.test(o.model));
  assert(far.length >= 30, 'a tree line outside the boundary');
  far.forEach((o) => { const [x, , z] = o.position; assert(x < -20.5 || x > 20.5 || z < -17.5 || z > 23.5, 'non-solid tree ' + o.position + ' is outside the lot'); });
  pass('the mine hill and river block; the rock yard, pier and bank are open; ground layers, the sky box, the signpost, the pier, flower beds and the tree line outside the lot never block');
}

console.log('\nALL ' + checks + ' TOWN LAYOUT DATA CHECKS PASSED');
