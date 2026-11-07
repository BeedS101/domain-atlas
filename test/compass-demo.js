#!/usr/bin/env node
// Bronze Compass demonstration, static checks: the standard compass class is the same in the Node and the PHP
// issuer catalog, conforms to Item Standard v0.1, leaves the older compass class alone, and is wired to the demo
// domain's plaza stall and lobby policy. Also covers the compass HUD's pure helpers. Needs php on the PATH.
//   node test/compass-demo.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const std = require('../extension/item-standard.js');
const fx = require('../extension/item-effects.js');
const hud = require('../extension/compass-hud.js');

const ROOT = path.resolve(__dirname, '..');
const CLASS = 'atlas.tool.bronze_compass';
let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log('PASS: ' + name);
  else { failures += 1; console.log('FAIL: ' + name + (detail ? ' ' + detail : '')); }
}

// The Node catalog entry, read out of server.js by brace matching (the file starts a server when loaded).
function nodeEntry(cls) {
  const src = fs.readFileSync(path.join(ROOT, 'issuer-server', 'server.js'), 'utf8');
  const start = src.indexOf("  '" + cls + "': {");
  if (start < 0) return null;
  let i = src.indexOf('{', start), depth = 0, end = i;
  for (; end < src.length; end += 1) {
    if (src[end] === '{') depth += 1;
    else if (src[end] === '}') { depth -= 1; if (!depth) break; }
  }
  return new Function('DOMAIN', 'return ' + src.slice(i, end + 1))('example.test');
}
function phpEntry(cls) {
  const out = execFileSync('php', ['-r', 'require "lib/store.php"; echo json_encode(ATLAS_ASSET_CATALOG[' + JSON.stringify(cls) + '] ?? null);'], { cwd: path.join(ROOT, 'issuer-php') }).toString();
  return JSON.parse(out);
}

const n = nodeEntry(CLASS);
const p = phpEntry(CLASS);
check('the class exists in the Node catalog', !!n);
check('the class exists in the PHP catalog', !!p);

if (n && p) {
  const pathOf = (url) => url.replace(/^https:\/\/example\.test/, '');
  check('both define the same name, trade scope, presentation and properties',
    n.name === p.name && n.tradeScope === p.tradeScope && n.presentation === p.presentation && n.fungible === p.fungible &&
    JSON.stringify(n.properties) === JSON.stringify(p.properties));
  check('both point at the same model and thumbnail', pathOf(n.model) === p.modelPath && pathOf(n.thumbnail) === p.thumbnailPath, pathOf(n.model) + ' ' + p.modelPath);
  check('both define the same itemSpec', JSON.stringify(n.itemSpec) === JSON.stringify(p.itemSpec));
  const spec = n.itemSpec;
  check('the itemSpec is a trinket-slot tool with only the compass capability',
    spec.category === 'tool' && spec.slot === 'trinket' && JSON.stringify(spec.capabilities) === '["atlas.cap.compass"]');
  check('the spec validates', std.validateItemSpec(spec).ok, JSON.stringify(std.validateItemSpec(spec).errors));
  const lint = std.lintCatalog({ [CLASS]: { name: n.name, modelPath: pathOf(n.model), fungible: n.fungible, presentation: n.presentation, properties: n.properties, itemSpec: n.itemSpec } });
  check('the catalog lint accepts the class as a definition and as signed', lint.checked.length === 1 && lint.errors.length === 0, JSON.stringify(lint.errors));
  check('the digest is stable and 64 hex characters', /^[0-9a-f]{64}$/.test(std.itemSpecDigest(spec)));
}

// The older Bronze Compass is still an ordinary credential in both catalogs.
const legacyNode = nodeEntry('atlas.wearable');
const legacyPhp = phpEntry('atlas.wearable');
check('the older Bronze Compass class is untouched and outside the standard',
  legacyNode && legacyPhp && legacyNode.name === 'Bronze Compass' && legacyPhp.name === 'Bronze Compass' && !legacyNode.itemSpec && !legacyPhp.itemSpec);

// Demo wiring.
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo-domain-a', '.well-known', 'spatial.json'), 'utf8'));
const lobby = manifest.worlds.find((w) => w.id === 'lobby');
const plaza = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo-domain-a', 'spatial', 'plaza', 'scene.json'), 'utf8'));
const stall = plaza.interactables.find((i) => i.label === 'Bronze Compass');
check('the plaza Compass Stall issues the standard compass once per user', stall && stall.class === CLASS && stall.action === 'issue' && stall.oncePerUser === true);
const ctx = fx.worldContext(manifest, lobby, manifest.domain);
check('the lobby enables exactly the compass capability and no stats or multipliers',
  JSON.stringify(ctx.effects.capabilities) === '["atlas.cap.compass"]' && !ctx.effects.stats.all && !ctx.effects.multipliers.all, JSON.stringify(ctx.effects));
check('the lobby admits the compass from its own issuer', fx.admission(ctx, CLASS, manifest.domain) === null);
check('the lobby does not admit it from another issuer', fx.admission(ctx, CLASS, 'other.example') === 'issuer-not-trusted');
const other = JSON.parse(fs.readFileSync(path.join(ROOT, 'demo-domain-b', '.well-known', 'spatial.json'), 'utf8'));
check('no world of the second demo domain enables item effects',
  !other.itemEffects && other.worlds.every((w) => !(w.policy && w.policy.itemEffects)));
check('no other world of the first demo domain enables the compass',
  manifest.worlds.filter((w) => w.id !== 'lobby').every((w) => !(w.policy && w.policy.itemEffects)));

// HUD helpers.
const dirs = [[[0, -1], 0, 'N'], [[1, -1], 45, 'NE'], [[1, 0], 90, 'E'], [[1, 1], 135, 'SE'], [[0, 1], 180, 'S'], [[-1, 1], 225, 'SW'], [[-1, 0], 270, 'W'], [[-1, -1], 315, 'NW']];
check('headings and points for the eight world directions', dirs.every(([d, deg, pt]) => Math.abs(hud.headingOf(d) - deg) < 1e-6 && hud.pointOf(hud.headingOf(d)) === pt));
check('points round to the nearest of eight', hud.pointOf(22.4) === 'N' && hud.pointOf(22.6) === 'NE' && hud.pointOf(359) === 'N' && hud.pointOf(337.6) === 'N' && hud.pointOf(337.4) === 'NW');
check('no heading for a zero or invalid vector', hud.headingOf([0, 0]) === null && hud.headingOf([NaN, 1]) === null && hud.headingOf(null) === null);
const east = hud.layout(90, 30);
const at = (l) => east.find((e) => e.label === l);
check('facing east puts E at the top and N to the left', Math.abs(at('E').x) < 1e-9 && at('E').y < -29.9 && at('N').x < -29.9 && Math.abs(at('N').y) < 1e-9);
check('the layout has all eight labels in order', JSON.stringify(east.map((e) => e.label)) === '["N","NE","E","SE","S","SW","W","NW"]');

console.log(failures ? '\nCOMPASS DEMO CHECKS FAILED (' + failures + ')' : '\nCOMPASS DEMO CHECKS PASSED');
process.exit(failures ? 1 : 0);
