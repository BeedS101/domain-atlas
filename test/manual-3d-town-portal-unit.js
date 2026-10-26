// Data checks (no browser) for the Lobby's textured portal gate,
// demo-domain-a/assets/portals/townPortal.glb, and its placement in the Lobby
// scene:
//   - the GLB uses only the supported texture subset (embedded PNG through a
//     bufferView, TEXCOORD_0, opaque materials, no extensions, no URIs, no
//     local paths) and extracts as textured primitives;
//   - it is exactly what tools/make-town-portal-glb.js produces, with the
//     plaque text taken from the Lobby portal's manifest label;
//   - the Lobby scene still has the same portal marker, destination and
//     spawn, the gate adds no collision, and the portal's walk-in area and
//     the line from the spawn to it are free;
//   - the gate is the only object added to the Lobby scene's furniture.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..');
const GLB_PATH = path.join(REPO, 'demo-domain-a', 'assets', 'portals', 'townPortal.glb');
const SCENE = JSON.parse(fs.readFileSync(path.join(REPO, 'demo-domain-a', 'spatial', 'lobby', 'scene.json'), 'utf8'));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(REPO, 'demo-domain-a', '.well-known', 'spatial.json'), 'utf8'));

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(REPO, 'extension', 'gltf-mini.js'), 'utf8'), {
  window: sandbox.window, document: {}, console, Float32Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array,
  DataView, ArrayBuffer, TextDecoder, Math, Map, Set, Promise, Array, Object, Number, JSON,
  performance: { now: () => 0 }, navigator: {}, indexedDB: {}, isFinite, Infinity, Error, String, Date
});
const L = sandbox.window.MiniGLTF.layout;
const parse = (buf) => L.parseGLB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

let checks = 0;
const pass = (msg) => { checks++; console.log('PASS: ' + msg); };
const plain = (v) => JSON.parse(JSON.stringify(v));

const glb = fs.readFileSync(GLB_PATH);
const { json, bin } = parse(glb);

// ---- 1. glTF contents ----
{
  assert.strictEqual(json.asset.version, '2.0');
  assert(!json.extensionsUsed && !json.extensionsRequired && !json.extensions, 'no glTF extensions');
  assert.strictEqual(json.meshes.length, 1);
  assert(json.materials.length >= 4, 'several materials');
  json.materials.forEach((m, i) => {
    assert(!m.alphaMode || m.alphaMode === 'OPAQUE', 'material ' + i + ' is opaque');
    ['normalTexture', 'occlusionTexture', 'emissiveTexture'].forEach((k) => assert(!m[k], 'material ' + i + ' has no ' + k));
    assert(!m.emissiveFactor, 'material ' + i + ' has no emissive factor');
    assert(!m.extensions, 'material ' + i + ' has no extensions');
    const pbr = m.pbrMetallicRoughness;
    assert(pbr && pbr.baseColorTexture && (pbr.baseColorTexture.texCoord || 0) === 0, 'material ' + i + ' has a TEXCOORD_0 base-colour texture');
    assert(!pbr.metallicRoughnessTexture, 'no metallic-roughness texture');
  });
  json.images.forEach((img, i) => {
    assert(img.bufferView !== undefined && !img.uri, 'image ' + i + ' is embedded through a bufferView');
    assert.strictEqual(img.mimeType, 'image/png');
    const view = json.bufferViews[img.bufferView];
    const sig = Buffer.from(bin.slice(view.byteOffset, view.byteOffset + 8));
    assert.strictEqual(sig.toString('hex'), '89504e470d0a1a0a', 'image ' + i + ' has a PNG signature');
  });
  assert((json.buffers || []).every((b) => !b.uri), 'the only buffer is the GLB BIN chunk');
  // No local or absolute paths anywhere in the JSON chunk.
  const text = JSON.stringify(json);
  assert(!/[A-Za-z]:\\|\\\\|\/home\/|\/tmp\/|\/Users\/|file:|https?:/.test(text), 'no absolute or local paths in the glTF JSON');
  assert(glb.length < 400 * 1024, 'the whole gate stays small, got ' + glb.length);
  pass('townPortal.glb uses only embedded PNG base-colour textures on opaque materials: no extensions, URIs, extra maps or local paths (' + glb.length + ' bytes)');
}

// ---- 2. extraction ----
{
  const r = L.extractPrimitives(json, bin);
  assert(r.primitives.length >= 4);
  const unique = new Set();
  r.primitives.forEach((p, i) => {
    assert(p.baseColorTexture, 'primitive ' + i + ' resolves a texture');
    assert.strictEqual(p.baseColorTexture.mime, 'image/png');
    assert(!p.textureWarning, 'primitive ' + i + ' has no texture warning: ' + p.textureWarning);
    assert(p.uvs && p.uvs.length === (p.positions.length / 3) * 2, 'primitive ' + i + ' has one UV per vertex');
    assert(Array.from(p.uvs).every(Number.isFinite), 'finite UVs');
    assert(p.normals && p.normals.length === p.positions.length, 'normals present');
    unique.add(p.baseColorTexture.key);
  });
  // stone and reveal share one image + sampler; runes, plaque and surface have their own
  assert.strictEqual(unique.size, 4, 'four distinct GPU textures expected, got ' + unique.size);
  const b = r.bounds;
  const near = (a, e, m) => assert(Math.abs(a - e) < 1e-3, m + ': ' + a + ' vs ' + e);
  near(b.min[0], -0.95, 'min x'); near(b.max[0], 0.95, 'max x'); near(b.min[1], 0, 'min y'); near(b.max[1], 2.0, 'max y');
  near(b.min[2], -0.28, 'min z'); near(b.max[2], 0.28, 'max z');
  pass('extractPrimitives resolves every material to a PNG texture; 4 distinct textures, 1.9 x 2.0 x 0.56 m, base on y = 0');
}

// ---- 3. reproducible, label from the manifest ----
{
  const gen = require(path.join(REPO, 'tools', 'make-town-portal-glb.js'));
  const { buildMultiGlb } = require(path.join(REPO, 'tools', 'lib', 'glb-builder.js'));
  const label = gen.lobbyPortalLabel();
  const lobby = MANIFEST.worlds.find((w) => w.id === 'lobby');
  assert.strictEqual(label, lobby.portals[0].label);
  const rebuilt = buildMultiGlb({ name: 'townPortal', primitives: gen.buildGeometry(label) });
  assert(rebuilt.equals(glb), 'townPortal.glb must equal the generator output for the Lobby portal label ' + JSON.stringify(label));
  pass('townPortal.glb is exactly what tools/make-town-portal-glb.js produces for the Lobby portal label ("' + label + '")');
}

// ---- 4. Lobby scene and manifest ----
{
  const lobby = MANIFEST.worlds.find((w) => w.id === 'lobby');
  assert.deepStrictEqual(lobby.portals, [{ kind: 'world', to: 'plaza', label: 'Back to the Plaza' }], 'Lobby portal destination unchanged');
  assert.deepStrictEqual(lobby.entry, { scene: '/spatial/lobby/scene.json', renderer: ['gltf-mini-v1'] });
  assert.strictEqual(SCENE.portalMarkers.length, 1);
  const m = SCENE.portalMarkers[0];
  assert.deepStrictEqual([m.position, m.radius, m.portalIndex], [[0, 0, 4.7], 0.8, 0], 'portal marker position, radius and index unchanged');
  assert.strictEqual(m.hideMarker, true, 'the placeholder ring and beacon are hidden for the gate');
  assert.strictEqual(SCENE.characterScale, 0.5);
  assert.deepStrictEqual(SCENE.camera, { start: [0, 1.6, 3.4], startYaw: 0 });
  assert.deepStrictEqual(SCENE.floor, { size: [14.4, 17.4], center: [0, 3.1], color: '#3a2f22' });
  assert.strictEqual(SCENE.interactables.length, 8, 'the Lobby crates are untouched');
  const gates = SCENE.objects.filter((o) => o.model === '/assets/portals/townPortal.glb');
  assert.strictEqual(gates.length, 1);
  assert.deepStrictEqual(gates[0], { model: '/assets/portals/townPortal.glb', position: [0, 0, 4.7], rotationY: 180, solid: false });
  assert.strictEqual(SCENE.objects.length - 1, 145, 'every other object is still there');
  const modelFile = (url) => path.join(REPO, 'demo-domain-a', url.replace(/^\//, ''));
  SCENE.objects.forEach((o) => assert(fs.existsSync(modelFile(o.model)), 'model file exists: ' + o.model));
  pass('Lobby portal marker (index 0, [0,0,4.7], r 0.8), destination, spawn, floor, character scale and crates are unchanged; the gate is the one added object');
}

// ---- 5. collision and reachability ----
{
  const modelBounds = {};
  const bounds = (url) => {
    if (!modelBounds[url]) {
      const b = fs.readFileSync(path.join(REPO, 'demo-domain-a', url.replace(/^\//, '')));
      const g = parse(b);
      modelBounds[url] = L.extractPrimitives(g.json, g.bin).bounds;
    }
    return modelBounds[url];
  };
  const build = (objects) => {
    const items = objects.map((o) => ({ solid: o.solid !== false && o.collision !== false, footprint: L.placedFootprint(bounds(o.model), L.normalizePlacement(o)) }));
    const solids = L.selectSolidItems(items);
    const limits = L.floorWalkLimits(SCENE.floor);
    return (x, z) => L.floorOverrun(limits, x, z) + solids.reduce((d, s) => d + L.footprintDepth(s.footprint, x, z, L.PLAYER_RADIUS), 0);
  };
  const withGate = build(SCENE.objects);
  const withoutGate = build(SCENE.objects.filter((o) => o.model !== '/assets/portals/townPortal.glb'));
  // The gate must not change collision anywhere on the floor.
  let compared = 0;
  for (let x = -7; x <= 7; x += 0.1) for (let z = -5.4; z <= 11; z += 0.1) {
    assert.strictEqual(withGate(x, z), withoutGate(x, z), 'collision differs at ' + x.toFixed(2) + ', ' + z.toFixed(2));
    compared++;
  }
  // The whole gate area (frame, opening, plinth) and the approach are free.
  for (let x = -0.95; x <= 0.95; x += 0.05) for (let z = 4.3; z <= 5.05; z += 0.05) {
    assert.strictEqual(withGate(x, z), 0, 'gate area must be walkable at ' + x.toFixed(2) + ', ' + z.toFixed(2));
  }
  for (let z = 3.4; z <= 4.7; z += 0.05) assert.strictEqual(withGate(0, z), 0, 'approach from the spawn is clear at z ' + z.toFixed(2));
  pass('the gate adds no collision (' + compared + ' floor points identical); the frame, opening and the line from the spawn to the portal centre are walkable');
}

console.log('\nALL ' + checks + ' TOWN PORTAL DATA CHECKS PASSED');
