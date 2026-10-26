// Data checks (no browser) for the textured portal gates
// (demo-domain-a/assets/portals/townPortal.glb for the Lobby and
// demo-domain-b/assets/portals/galleryPortal.glb for the Gallery) and their
// placement in the scenes:
//   - the GLB uses only the supported texture subset (embedded PNG through a
//     bufferView, TEXCOORD_0, opaque materials, no extensions, no URIs, no
//     local paths) and extracts as textured primitives;
//   - each is exactly what tools/make-town-portal-glb.js produces, with the
//     plaque text taken from the portal's manifest label and the colour
//     taken from the viewer's portal scheme (same-domain = orange);
//   - the Lobby scene still has the same portal marker, destination and
//     spawn, the gate adds no collision, and the portal's walk-in area and
//     the line from the spawn to it are free;
//   - the Lobby gate is the only object added to the Lobby scene's furniture;
//     the Gallery gate replaces the old portal arch and nothing else.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..');
const gen = require(path.join(REPO, 'tools', 'make-town-portal-glb.js'));

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(REPO, 'extension', 'gltf-mini.js'), 'utf8'), {
  window: sandbox.window, document: {}, console, Float32Array, Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array,
  DataView, ArrayBuffer, TextDecoder, Math, Map, Set, Promise, Array, Object, Number, JSON,
  performance: { now: () => 0 }, navigator: {}, indexedDB: {}, isFinite, Infinity, Error, String, Date
});
const L = sandbox.window.MiniGLTF.layout;
const parse = (buf) => L.parseGLB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(REPO, ...p), 'utf8'));

let checks = 0;
const pass = (msg) => { checks++; console.log('PASS: ' + msg); };

// Per-gate expectations. The colour follows the viewer's portal scheme
// (extension/viewer.html portalPalette): same-domain destinations are orange.
const GATES = [
  {
    target: gen.TARGETS.find((t) => t.name === 'townPortal'), world: 'lobby',
    portals: [{ kind: 'world', to: 'plaza', label: 'Back to the Plaza' }],
    entry: { scene: '/spatial/lobby/scene.json', renderer: ['gltf-mini-v1'] },
    placed: { model: '/assets/portals/townPortal.glb', position: [0, 0, 4.7], rotationY: 180, solid: false },
    marker: { position: [0, 0, 4.7], radius: 0.8, portalIndex: 0, hideMarker: true },
    camera: { start: [0, 1.6, 3.4], startYaw: 0 },
    floor: { size: [40, 40], center: [0, 3], color: '#3a2f22' },
    characterScale: 0.5, objectCount: 263, interactables: 8,
    // gate footprint (world x, z extents incl. the approach) that must be walkable
    gateArea: { x: [-0.95, 0.95], z: [4.3, 5.05] }, approach: { x: 0, z: [3.4, 4.7] },
    grid: { x: [-7, 7], z: [-5.4, 11] }
  },
  {
    target: gen.TARGETS.find((t) => t.name === 'galleryPortal'), world: 'gallery',
    portals: [{ kind: 'world', to: 'workshop', label: 'Back to the Neighbor Workshop' }],
    entry: null,
    placed: { model: '/assets/portals/galleryPortal.glb', position: [0, 0, -15.8], rotationY: 0, scale: 3, solid: false },
    marker: { position: [0, 0, -16], radius: 2, portalIndex: 0, hideMarker: true },
    camera: { start: [0, 1.6, 14], startYaw: 0 },
    floor: { size: [46, 40], color: '#494237' },
    characterScale: 1.4, objectCount: 115, interactables: null,
    gateArea: { x: [-2.85, 2.85], z: [-16.6, -14.9] }, approach: { x: 0, z: [-14.9, -8] },
    grid: { x: [-23, 23], z: [-20, 20] }
  }
];

GATES.forEach((G) => {
  const T = G.target;
  const domainDir = path.join(REPO, T.domain);
  const GLB_PATH = path.join(REPO, T.out);
  const SCENE_PATH = (() => {
    const m = readJson(T.domain, '.well-known', 'spatial.json').worlds.find((w) => w.id === G.world);
    return path.join(domainDir, (m.entry && m.entry.scene || '/spatial/' + G.world + '/scene.json').replace(/^\//, ''));
  })();
  const SCENE = JSON.parse(fs.readFileSync(SCENE_PATH, 'utf8'));
  const MANIFEST = readJson(T.domain, '.well-known', 'spatial.json');
  const world = MANIFEST.worlds.find((w) => w.id === G.world);
  const tag = T.name + ': ';

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
    const text = JSON.stringify(json);
    assert(!/[A-Za-z]:\\|\\\\|\/home\/|\/tmp\/|\/Users\/|file:|https?:/.test(text), 'no absolute or local paths in the glTF JSON');
    assert(glb.length < 400 * 1024, 'the whole gate stays small, got ' + glb.length);
    pass(tag + 'uses only embedded PNG base-colour textures on opaque materials: no extensions, URIs, extra maps or local paths (' + glb.length + ' bytes)');
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
    assert.strictEqual(unique.size, 4, 'four distinct GPU textures expected, got ' + unique.size);
    const b = r.bounds;
    const near = (a, e, m) => assert(Math.abs(a - e) < 1e-3, m + ': ' + a + ' vs ' + e);
    near(b.min[0], -0.95, 'min x'); near(b.max[0], 0.95, 'max x'); near(b.min[1], 0, 'min y'); near(b.max[1], 2.0, 'max y');
    near(b.min[2], -0.28, 'min z'); near(b.max[2], 0.28, 'max z');
    pass(tag + 'extractPrimitives resolves every material to a PNG texture; 4 distinct textures, 1.9 x 2.0 x 0.56 m, base on y = 0');
  }

  // ---- 3. reproducible; label from the manifest; colour from the scheme ----
  {
    const label = gen.portalLabel(T);
    assert.strictEqual(label, world.portals[T.portal].label);
    assert.strictEqual(world.portals[T.portal].kind, 'world', 'a same-domain world portal');
    assert.strictEqual(T.palette, 'same-domain', 'same-domain portals use the orange palette');
    const rebuilt = gen.buildTarget(T);
    assert.strictEqual(rebuilt.label, label);
    assert(rebuilt.glb.equals(glb), T.name + '.glb must equal the generator output for ' + JSON.stringify(label));
    // The other palettes produce different artwork from the same geometry and label.
    ['cross-domain', 'key'].forEach((pal) => {
      const other = gen.buildTarget(T, { palette: pal }).glb;
      assert(!other.equals(glb), pal + ' palette differs');
      assert.strictEqual(parse(other).json.accessors.length, json.accessors.length, pal + ' palette keeps the geometry');
    });
    pass(tag + 'is exactly what tools/make-town-portal-glb.js produces for the manifest label "' + label + '" in the same-domain (orange) palette; blue and amber variants differ only in artwork');
  }

  // ---- 4. scene and manifest ----
  {
    assert.deepStrictEqual(world.portals, G.portals, 'portal destination unchanged');
    if (G.entry) assert.deepStrictEqual(world.entry, G.entry);
    assert.strictEqual(SCENE.portalMarkers.length, 1);
    assert.deepStrictEqual(SCENE.portalMarkers[0], G.marker, 'portal marker position, radius and index kept; ring and beacon hidden for the gate');
    assert.strictEqual(SCENE.characterScale, G.characterScale);
    assert.deepStrictEqual(SCENE.camera, G.camera);
    assert.deepStrictEqual(SCENE.floor, G.floor);
    if (G.interactables !== null) assert.strictEqual(SCENE.interactables.length, G.interactables, 'the interactables are untouched');
    const gates = SCENE.objects.filter((o) => o.model === G.placed.model);
    assert.strictEqual(gates.length, 1);
    assert.deepStrictEqual(gates[0], G.placed);
    assert.strictEqual(SCENE.objects.length, G.objectCount, 'object count');
    SCENE.objects.forEach((o) => assert(fs.existsSync(path.join(domainDir, o.model.replace(/^\//, ''))), 'model file exists: ' + o.model));
    if (G.world === 'gallery') {
      assert(!SCENE.objects.some((o) => o.model === '/assets/gallery/portal-arch.glb'), 'the old portal arch is no longer placed');
      assert(SCENE.objects.some((o) => o.model === '/assets/gallery/portal-frame.glb'), 'the decorative frame behind the gate stays');
    }
    pass(tag + 'portal marker, destination, spawn, floor and character scale are kept; the gate is placed once and non-solid');
  }

  // ---- 5. collision and reachability ----
  {
    const modelBounds = {};
    const bounds = (url) => {
      if (!modelBounds[url]) {
        const g = parse(fs.readFileSync(path.join(domainDir, url.replace(/^\//, ''))));
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
    const withoutGate = build(SCENE.objects.filter((o) => o.model !== G.placed.model));
    let compared = 0;
    for (let x = G.grid.x[0]; x <= G.grid.x[1]; x += 0.1) for (let z = G.grid.z[0]; z <= G.grid.z[1]; z += 0.1) {
      assert.strictEqual(withGate(x, z), withoutGate(x, z), 'collision differs at ' + x.toFixed(2) + ', ' + z.toFixed(2));
      compared++;
    }
    for (let x = G.gateArea.x[0]; x <= G.gateArea.x[1]; x += 0.05) for (let z = G.gateArea.z[0]; z <= G.gateArea.z[1]; z += 0.05) {
      // The Gallery's decorative frame sits behind the gate and is non-solid, so the
      // whole gate area must be free of every other solid too.
      assert.strictEqual(withGate(x, z), 0, 'gate area must be walkable at ' + x.toFixed(2) + ', ' + z.toFixed(2));
    }
    const a = G.approach;
    const lo = Math.min(a.z[0], a.z[1]), hi = Math.max(a.z[0], a.z[1]);
    for (let z = lo; z <= hi; z += 0.05) assert.strictEqual(withGate(a.x, z), 0, 'approach is clear at z ' + z.toFixed(2));
    pass(tag + 'adds no collision (' + compared + ' floor points identical); the frame, opening and the line from the spawn to the portal centre are walkable');
  }
});

console.log('\nALL ' + checks + ' TOWN PORTAL DATA CHECKS PASSED');
