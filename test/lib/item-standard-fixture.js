// Test classes for test/item-standard-issuer.js (fixture: test/fixtures/item-standard-issuer.json). The issuers
// ship no class with an itemSpec, so the test injects these into the running code: Node through a preload that
// edits server.js as it loads, PHP through a file the copied bundle's catalog merges in. Nothing on disk in the
// repository changes.
const fs = require('fs');
const path = require('path');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'item-standard-issuer.json'), 'utf8'));

// The classes for variant 1 (as signed first) or 2 (specs edited afterwards).
function classes(variant) {
  const out = JSON.parse(JSON.stringify(FIXTURE.classes));
  if (variant === 2) for (const [cls, patch] of Object.entries(FIXTURE.variant2)) Object.assign(out[cls], patch);
  return out;
}

// JavaScript source evaluating to the Node catalog entries (DOMAIN is in scope in server.js).
function nodeSnippet(variant) {
  const defs = classes(variant);
  const parts = [];
  for (const [cls, d] of Object.entries(defs)) {
    const entry = {
      name: d.name, model: '__MODEL__' + d.modelPath, fungible: d.fungible, presentation: d.presentation,
      properties: d.properties, itemSpec: d.itemSpec
    };
    if (d.serialized) entry.serialized = true;
    if (d.maxSupply) entry.maxSupply = d.maxSupply;
    let src = JSON.stringify(entry).replace(/"__MODEL__([^"]*)"/, '`https://${DOMAIN}$1`');
    if (d.randomize) src = src.replace(/}$/, ', "randomizeProperties": ROLLERS[' + JSON.stringify(d.randomize) + ']()}');
    parts.push(JSON.stringify(cls) + ': ' + src);
  }
  return '(() => {\n' +
    "const TIERS = ['common', 'uncommon', 'rare', 'legendary'];\n" +
    'const ROLLERS = {\n' +
    "  'ring-rolls': () => { let n = 0; return () => { const i = n % 4; n += 1; return { 'atlas.rarity': TIERS[i], 'atlas.avatar.stat.luck': String(Math.min(3, i + 1)) }; }; },\n" +
    "  'ring-flaky': () => { let n = 0; return () => { n += 1; return { 'atlas.rarity': 'common', 'atlas.avatar.stat.luck': n % 2 === 1 ? '9' : '2' }; }; }\n" +
    '};\n' +
    'return {\n' + parts.join(',\n') + '\n};\n})()';
}

// The classes that the Node server should treat as restricted-issuance (PHP reads the catalog flag instead).
function restrictedClasses() {
  return Object.keys(FIXTURE.classes).filter((c) => FIXTURE.classes[c].restrictedIssuance);
}

function phpValue(v, indent) {
  const pad = '  '.repeat(indent);
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  if (Array.isArray(v)) return '[' + v.map((x) => phpValue(x, indent + 1)).join(', ') + ']';
  const keys = Object.keys(v);
  if (!keys.length) return '[]';
  return '[\n' + keys.map((k) => pad + '  ' + phpValue(k, 0) + ' => ' + phpValue(v[k], indent + 1)).join(',\n') + '\n' + pad + ']';
}

// A PHP file returning the extra catalog entries.
function phpFile(variant) {
  const defs = classes(variant);
  const parts = [];
  for (const [cls, d] of Object.entries(defs)) {
    const entry = {
      name: d.name, modelPath: d.modelPath, fungible: d.fungible, presentation: d.presentation,
      properties: d.properties, itemSpec: d.itemSpec
    };
    if (d.serialized) entry.serialized = true;
    if (d.maxSupply) entry.maxSupply = d.maxSupply;
    if (d.restrictedIssuance) entry.restrictedIssuance = d.restrictedIssuance;
    let src = phpValue(entry, 2);
    if (d.randomize) src = src.replace(/\n    \]$/, ",\n      'randomizeProperties' => $rollers[" + phpValue(d.randomize, 0) + "]()\n    ]");
    parts.push('    ' + phpValue(cls, 0) + ' => ' + src);
  }
  return '<?php\n' +
    "// Test-only classes (test/lib/item-standard-fixture.js).\n" +
    "$tiers = ['common', 'uncommon', 'rare', 'legendary'];\n" +
    "// Each request is a fresh PHP process, so the call counter lives in a file next to this one.\n" +
    "function itemstd_next_roll($name) { $f = __DIR__ . '/itemstd-roll-' . $name . '.txt'; $n = (int) @file_get_contents($f); file_put_contents($f, (string) ($n + 1)); return $n + 1; }\n" +
    '$rollers = [\n' +
    "  'ring-rolls' => function () use ($tiers) { return function () use ($tiers) { $n = itemstd_next_roll('ring-rolls') - 1; $i = $n % 4; return ['atlas.rarity' => $tiers[$i], 'atlas.avatar.stat.luck' => (string) min(3, $i + 1)]; }; },\n" +
    "  'ring-flaky' => function () { return function () { $n = itemstd_next_roll('ring-flaky'); return ['atlas.rarity' => 'common', 'atlas.avatar.stat.luck' => $n % 2 === 1 ? '9' : '2']; }; },\n" +
    '];\n' +
    'return [\n' + parts.join(',\n') + '\n];\n';
}

module.exports = { FIXTURE, classes, nodeSnippet, phpFile, restrictedClasses };
