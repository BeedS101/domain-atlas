#!/usr/bin/env node
// Lays the Domain A Lobby's outdoor town into demo-domain-a/spatial/lobby/scene.json.
//
// Only the floor and the outdoor objects change: every line of the scene that
// is not an outdoor prop or /assets/town/ model (the building, its
// furniture, the portal gate, the crates, portal markers, interactables and
// anchors) is kept exactly as it is. The outdoor block is rebuilt from
// tools/lib/lobby-town-layout.js, so the script can be run again after editing
// the layout. Models are made by tools/make-town-assets.js.
//
// Usage: node tools/make-lobby-town-scene.js [--check]   (--check only verifies the file is up to date)

const fs = require('fs');
const path = require('path');
const { hash } = require('./lib/procedural');
const W = require('./lib/lobby-town-layout');

const REPO = path.resolve(__dirname, '..');
const SCENE = path.join(REPO, 'demo-domain-a', 'spatial', 'lobby', 'scene.json');

const num = (v) => String(Math.round(v * 1000) / 1000);
const T = (name) => '/assets/town/' + name + '.glb';
const O = (name) => '/assets/outdoor/' + name + '.glb';

// The outdoor kit props are used in their textured versions from assets/lobby/exterior/
// (tools/make-lobby-exterior-assets.js); trees, shrubs and pines come in two tints, chosen
// from the object's position so the choice is stable and nothing else about it changes.
const EXTERIOR_PROPS = ['treeSmall', 'shrub', 'benchOutdoor', 'lampPost', 'planterBox', 'welcomeSign'];
const TINT_B = { treeSmall: 0.45, shrub: 0.5, pine: 0.4 };
function modelFor(model, x, z) {
  const m = /^\/assets\/(outdoor|town)\/(\w+)\.glb$/.exec(model);
  if (!m) return model;
  let name = m[2];
  if (TINT_B[name] !== undefined && hash(Math.round(x * 10), Math.round(z * 10), 61) < TINT_B[name]) name += 'B';
  if (m[1] === 'outdoor') return EXTERIOR_PROPS.includes(m[2]) ? '/assets/lobby/exterior/' + name + '.glb' : model;
  return '/assets/town/' + name + '.glb';
}

function obj(rawModel, x, z, opts) {
  const o = opts || {};
  const model = modelFor(rawModel, x, z);
  const parts = ['"model": "' + model + '"', '"position": [' + [x, o.y || 0, z].map(num).join(', ') + ']', '"rotationY": ' + num(o.rot || 0)];
  if (o.scale !== undefined) parts.push('"scale": ' + num(o.scale));
  if (o.solid === false) parts.push('"solid": false');
  return { line: '    { ' + parts.join(', ') + ' },', x, z, model, solid: o.solid !== false };
}

function buildBlock() {
  const g = []; // groups of lines; a blank line goes between groups
  const group = (title, items) => g.push({ title, items });
  const free = { solid: false };

  group('landscape', [
    obj(T('townSky'), 0, 0, free), obj(T('townGround'), 0, 0, free), obj(T('townPaths'), 0, 0, free),
    obj(T('riverBanks'), 0, 0, free), obj(T('riverWater'), 0, 0), obj(T('mineHill'), 0, 0)
  ]);

  // boundary hedges: south and west run the full length, north from the mine hill to the river
  const hedges = [];
  for (let k = 0; k < 9; k++) hedges.push(obj(T('hedge'), -17.9 + 4 * k, 22.5));
  for (let k = 0; k < 9; k++) hedges.push(obj(T('hedge'), -19.5, -10.8 + 4 * k, { rot: 90 }));
  for (let k = 0; k < 5; k++) hedges.push(obj(T('hedge'), -2 + 4 * k, -16.5));
  group('boundary hedges', hedges);

  // trees outside the hedges and on the far river bank (not reachable)
  const far = [];
  const ring = (n, x0, z0, dx, dz, seed) => {
    for (let i = 0; i < n; i++) {
      const j = hash(i, seed, 7), k = hash(i, seed, 8);
      const x = x0 + dx * i + (j - 0.5) * 1.6, z = z0 + dz * i + (k - 0.5) * 1.6;
      if (hash(i, seed, 9) < 0.28) far.push(obj(O('treeSmall'), x, z, { scale: 1.5 + k * 0.7, rot: Math.round(j * 360), solid: false }));
      else far.push(obj(T('pine'), x, z, { scale: 1.0 + k * 0.5, rot: Math.round(j * 360), solid: false }));
    }
  };
  ring(13, -22, -21.5, 3.4, 0, 1); // north
  ring(14, -23.5, -17, 0, 3.1, 2); // west
  ring(14, -22, 26, 3.4, 0, 3); // south
  ring(13, 22.5, -19, 0, 3.4, 4); // beyond the river
  group('tree line', far);

  // front plaza
  const F = W.FOUNTAIN;
  group('plaza', [
    obj(T('fountain'), F.cx, F.cz),
    obj(T('townSignpost'), W.SIGNPOST.at[0], W.SIGNPOST.at[1], free),
    obj(O('welcomeSign'), 4.9, 6.585), obj(O('planterBox'), -1.45, 5.95), obj(O('planterBox'), 1.45, 5.95),
    obj(O('lampPost'), 4.3, 8.1), obj(O('lampPost'), -2.6, 16.6), obj(O('lampPost'), 9, 16.6), obj(O('lampPost'), 9, 8.4),
    obj(O('benchOutdoor'), 0.2, 12.4, { rot: 90 }), obj(O('benchOutdoor'), 6.2, 12.4, { rot: -90 }),
    obj(O('benchOutdoor'), 0.2, 16.9, { rot: 180 }), obj(O('benchOutdoor'), 6.2, 16.9, { rot: 180 }),
    obj(O('shrub'), 6.29, 6.4), obj(O('shrub'), -3.0, 6.2), obj(O('shrub'), -4.4, 16.8), obj(O('shrub'), 10.8, 16.8)
  ]);

  group('market square', [
    obj(O('lampPost'), -6.2, 9.6), obj(O('lampPost'), -6.2, 18.4), obj(O('lampPost'), -16.0, 18.4),
    obj(T('barrel'), -15.7, 10.0), obj(T('barrel'), -15.05, 10.5), obj(T('barrel'), -15.75, 10.95),
    obj(O('benchOutdoor'), -10.6, 18.6, { rot: 180 }), obj(O('benchOutdoor'), -13.0, 18.6, { rot: 180 }),
    obj(O('planterBox'), -9.2, 9.5), obj(O('planterBox'), -11.0, 9.5),
    obj(O('treeSmall'), -16.6, 21.0, { scale: 1.3 })
  ]);

  group('hut', [
    obj(T('hut'), W.HUT.cx, W.HUT.cz, { rot: W.HUT.rotationY }),
    obj(T('woodPile'), -14.8, -2.6), obj(T('barrel'), -12.0, 3.7), obj(T('barrel'), -12.5, 4.35),
    obj(T('flowerBed'), -11.3, -1.6, free),
    obj(O('treeSmall'), -16.2, -5.0, { scale: 1.7 }), obj(O('treeSmall'), -16.4, 7.4, { scale: 1.5 })
  ]);

  group('mine and rock yard', [
    obj(T('oreCart'), -8.4, -9.8), obj(T('barrel'), -4.4, -8.9),
    obj(O('lampPost'), -14.6, -12.3), obj(O('lampPost'), -8.6, -12.3),
    obj(T('boulderLarge'), -16.7, -11.2), obj(T('boulderLarge'), -6.9, -12.0, { scale: 1.2, rot: 40 }),
    obj(T('boulderSmall'), -15.6, -9.2, { rot: 70 }), obj(T('boulderSmall'), -4.3, -10.6, { rot: 20 }), obj(T('boulderSmall'), -14.9, -12.1, { rot: 130 })
  ]);

  const O2 = W.TERRACE;
  group('overlook', [
    obj(O('benchOutdoor'), 14.2, -11.4, { rot: 90 }), obj(O('benchOutdoor'), 14.2, -9.4, { rot: 90 }),
    obj(T('stoneWall'), 15.9, -10.4, { rot: 90 }),
    obj(O('treeSmall'), 11.0, -15.4, { scale: 2.0 }), obj(O('treeSmall'), 14.6, -15.4, { scale: 1.4 }), obj(O('treeSmall'), 8.2, -12.4, { scale: 1.5 }),
    obj(T('flowerBed'), 10.2, -8.9, free), obj(T('flowerBed'), 12.6, -7.7, free),
    obj(O('shrub'), 11.2, -6.6), obj(O('shrub'), 14.4, -7.4)
  ]);

  group('river bank', [
    obj(T('pier'), (W.PIER.minX + W.PIER.maxX) / 2, (W.PIER.minZ + W.PIER.maxZ) / 2, free),
    obj(T('boulderSmall'), 15.4, -2.6, { rot: 50 }), obj(T('boulderLarge'), 15.3, 9.4, { rot: 10 }), obj(T('boulderSmall'), 15.4, 11.6, { rot: 100 }),
    obj(T('stoneWall'), 15.9, 16.2, { rot: 90 })
  ]);

  group('south-east lawn', [
    obj(O('benchOutdoor'), 14.9, 17.6, { rot: 90 }),
    obj(O('treeSmall'), 8.6, 19.8, { scale: 1.6 }), obj(O('treeSmall'), 13.6, 21.0, { scale: 1.4 }),
    obj(T('flowerBed'), 10.8, 20.8, free), obj(T('flowerBed'), 12.0, 14.2, free)
  ]);

  // beds under the windows of the building
  group('building edge', [
    obj(T('flowerBed'), -4.8, -6.5, free), obj(T('flowerBed'), 3.2, -6.5, free),
    obj(T('flowerBed'), -7.9, 0.8, { rot: 90, solid: false }), obj(T('flowerBed'), -7.9, 4.0, { rot: 90, solid: false }),
    obj(T('flowerBed'), 7.9, 2.4, { rot: 90, solid: false }), obj(T('flowerBed'), 7.9, -4.0, { rot: 90, solid: false })
  ]);

  return g;
}

const GROUPS = buildBlock();
const OBJECTS = [].concat(...GROUPS.map((x) => x.items));

function render(text) {
  const lines = text.split('\n');
  const isOutdoor = (l) => /"model": "\/assets\/(outdoor|town)\//.test(l) || /"model": "\/assets\/lobby\/exterior\/(treeSmall|shrub|benchOutdoor|lampPost|planterBox|welcomeSign)/.test(l);
  const first = lines.findIndex(isOutdoor);
  if (first < 0) throw new Error('no outdoor block found in the Lobby scene');
  const kept = lines.filter((l) => !isOutdoor(l));
  const block = [];
  GROUPS.forEach((x, i) => { if (i) block.push(''); x.items.forEach((o) => block.push(o.line)); });
  // blank lines that only separated the old outdoor lines would double up
  const before = kept.slice(0, first), after = kept.slice(first);
  while (before.length && before[before.length - 1] === '') before.pop();
  while (after.length && after[0] === '') after.shift();
  const out = before.concat([''], block, [''], after);
  const f = W.FLOOR;
  const floorLine = '  "floor": { "size": [' + f.size.map(num).join(', ') + '], "center": [' + f.center.map(num).join(', ') + '], "color": "' + f.color + '" },';
  const fi = out.findIndex((l) => /^  "floor":/.test(l));
  out[fi] = floorLine;
  return out.join('\n');
}

if (require.main === module) {
  const current = fs.readFileSync(SCENE, 'utf8');
  const next = render(current);
  JSON.parse(next); // must stay valid
  if (process.argv.includes('--check')) {
    if (next !== current) { console.error('The Lobby scene is not up to date with the town layout; run node tools/make-lobby-town-scene.js'); process.exit(1); }
    console.log('Lobby scene matches the town layout (' + OBJECTS.length + ' outdoor objects)');
  } else {
    fs.writeFileSync(SCENE, next);
    console.log('wrote ' + path.relative(REPO, SCENE) + ': ' + OBJECTS.length + ' outdoor objects in ' + GROUPS.length + ' groups');
  }
}

module.exports = { GROUPS, OBJECTS, render };
