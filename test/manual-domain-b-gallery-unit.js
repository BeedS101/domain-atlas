// Data checks (no browser) for Domain B's second world, the Atlas Showcase
// Gallery, and the scene-owned character scale values of the two 3D demo
// scenes:
//   - Domain B's manifest has `workshop` and `gallery`; `workshop` stays the
//     default and stays 2D, and its Plaza portal and Post Office are intact;
//   - the Workshop and the Gallery portal to each other as same-domain
//     (kind "world") portals, and each portal has a marker in its scene;
//   - the Gallery is a gltf-mini-v1 scene whose every model resolves to a real
//     file under /assets/gallery/, with none of the old test-path leftovers;
//   - the Gallery declares characterScale 1.4 and the Lobby 0.5;
//   - the repo manifests keep their local demo addresses.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..');
const B = path.join(REPO, 'demo-domain-b');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
let checks = 0;
function pass(msg) { checks++; console.log('PASS: ' + msg); }

const manifest = readJson(path.join(B, '.well-known', 'spatial.json'));
const workshopScene = readJson(path.join(B, 'spatial', 'workshop', 'scene.json'));
const galleryPath = path.join(B, 'spatial', 'gallery', 'scene.json');
const gallery = readJson(galleryPath);
const world = (id) => manifest.worlds.find((w) => w.id === id);

// ---- manifest ----
assert.deepStrictEqual(manifest.worlds.map((w) => w.id).sort(), ['gallery', 'workshop'], 'Domain B should declare exactly the workshop and gallery worlds');
assert.strictEqual(manifest.defaultWorld, 'workshop', 'the Workshop must stay the default entry world');
assert.strictEqual(manifest.worlds[0].id, 'workshop', 'the Workshop stays first in the worlds list');
pass('Domain B declares workshop and gallery, and workshop is still defaultWorld');

const ws = world('workshop'), ga = world('gallery');
assert.strictEqual(ws.name, 'Neighbor Workshop');
assert.strictEqual(ws.entry.scene, '/spatial/workshop/scene.json');
assert.deepStrictEqual(ws.entry.renderer, ['procedural-v1']);
assert.strictEqual(ga.name, 'Atlas Showcase Gallery');
assert.strictEqual(ga.entry.scene, '/spatial/gallery/scene.json');
assert.deepStrictEqual(ga.entry.renderer, ['gltf-mini-v1']);
assert.strictEqual(gallery.format, 'gltf-mini-v1', 'the Gallery scene itself declares gltf-mini-v1');
pass('Workshop stays procedural-v1; Gallery is gltf-mini-v1 at /spatial/gallery/scene.json');

// ---- portals ----
assert.strictEqual(ws.portals[0].kind, 'domain', 'the Workshop keeps its cross-domain Plaza portal at index 0');
assert.strictEqual(ws.portals[0].to, 'localhost:8001');
assert.strictEqual(ws.portals[0].manifest, 'http://localhost:8001/.well-known/spatial.json');
const toGallery = ws.portals.findIndex((p) => p.kind === 'world' && p.to === 'gallery');
assert(toGallery > 0, 'the Workshop has a same-domain portal to the gallery');
assert(!ws.portals[toGallery].manifest, 'the Workshop-to-Gallery portal is same-domain: no manifest URL');
const toWorkshop = ga.portals.findIndex((p) => p.kind === 'world' && p.to === 'workshop');
assert(toWorkshop >= 0, 'the Gallery has a same-domain portal back to the workshop');
assert(!ga.portals[toWorkshop].manifest, 'the Gallery-to-Workshop portal is same-domain: no manifest URL');
assert.strictEqual(ga.portals.filter((p) => p.kind === 'domain').length, 0, 'the Gallery has no external-domain portal');
assert(workshopScene.portalMarkers.some((m) => m.portalIndex === toGallery), 'the Workshop scene has a marker for the Gallery portal');
assert(workshopScene.portalMarkers.some((m) => m.portalIndex === 0), 'the Workshop scene keeps its Plaza portal marker');
assert(gallery.portalMarkers.some((m) => m.portalIndex === toWorkshop), 'the Gallery scene has a marker for the Workshop portal');
[[workshopScene, ws], [gallery, ga]].forEach(([scene, w]) => scene.portalMarkers.forEach((m) => assert(w.portals[m.portalIndex], 'portalIndex ' + m.portalIndex + ' must exist in ' + w.id)));
pass('Workshop and Gallery portal to each other as same-domain world portals, each with a scene marker; the Plaza portal is kept');

// ---- Workshop behaviour kept ----
assert(workshopScene.objects.some((o) => o.label === 'Post Office'), 'the Post Office object is still in the Workshop');
assert(workshopScene.interactables.some((i) => i.class === 'atlas.postoffice.membership' && i.oncePerUser), 'the Post Office membership interactable is intact');
assert.strictEqual(manifest.postOffice, true);
assert.strictEqual(workshopScene.format, 'procedural-v1');
assert.strictEqual(workshopScene.characterScale, undefined, 'the 2D Workshop declares no character scale');
pass('Workshop scene, Post Office and its interactable are unchanged');

// ---- Gallery assets ----
const GALLERY_DIR = path.join(B, 'assets', 'gallery');
const models = [...new Set(gallery.objects.map((o) => o.model))];
assert(models.length > 0 && gallery.objects.length > 0);
// The portal gate is the one model outside /assets/gallery/ (shared gate kit under /assets/portals/).
const PORTAL_GATE = '/assets/portals/galleryPortal.glb';
models.forEach((m) => {
  if (m === PORTAL_GATE) {
    assert.strictEqual(fs.readFileSync(path.join(B, m.replace(/^\//, ''))).slice(0, 4).toString(), 'glTF', m + ' is not a GLB');
    return;
  }
  assert(/^\/assets\/gallery\/[^/]+\.glb$/.test(m), 'Gallery model must be /assets/gallery/<file>.glb, got ' + m);
  assert(fs.existsSync(path.join(GALLERY_DIR, path.basename(m))), 'Gallery model file is missing: ' + m);
  assert.strictEqual(fs.readFileSync(path.join(GALLERY_DIR, path.basename(m))).slice(0, 4).toString(), 'glTF', m + ' is not a GLB');
});
const text = fs.readFileSync(galleryPath, 'utf8');
['/assets/workshop/', 'normalized', 'architecture-v', 'gallery-v'].forEach((bad) => assert(!text.includes(bad), 'Gallery scene still mentions ' + bad));
fs.readdirSync(GALLERY_DIR).forEach((f) => assert(f.endsWith('.glb'), 'unexpected file in assets/gallery: ' + f));
const stray = [];
(function walk(d) { fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { if (e.isDirectory()) { if (/^(gallery-v\d|normalized|architecture-v\d)/.test(e.name)) stray.push(path.join(d, e.name)); walk(path.join(d, e.name)); } }); })(B);
assert.deepStrictEqual(stray, [], 'old test asset folders must not be in the repo');
pass('all ' + gallery.objects.length + ' Gallery objects (' + models.length + ' models) resolve to GLBs under /assets/gallery/ (plus the /assets/portals/ gate); no old test paths or folders');

// ---- character scale owned by the scene ----
assert.strictEqual(gallery.characterScale, 1.4, 'the Gallery declares characterScale 1.4');
const lobby = readJson(path.join(REPO, 'demo-domain-a', 'spatial', 'lobby', 'scene.json'));
assert.strictEqual(lobby.characterScale, 0.5, 'the Lobby declares characterScale 0.5');
pass('Gallery characterScale 1.4, Lobby characterScale 0.5');

// ---- demo addresses stay local ----
[manifest, readJson(path.join(REPO, 'demo-domain-a', '.well-known', 'spatial.json'))].forEach((m) => {
  const s = JSON.stringify(m);
  assert(!/evtec\.co\.za|domain-atlas\.co\.za/.test(s), 'repo manifests must keep local demo addresses');
  assert(/^localhost:\d+$/.test(m.domain), 'manifest domain stays a localhost address, got ' + m.domain);
});
pass('repo manifests keep their localhost demo addresses');

console.log('\nALL ' + checks + ' DOMAIN B GALLERY DATA CHECKS PASSED');
