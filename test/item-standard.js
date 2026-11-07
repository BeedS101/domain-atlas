#!/usr/bin/env node
// Item Standard v0.1 (docs/item-standard-v0.1.md): replays the shared vectors (docs/item-standard-v0.1.json)
// through the Node validator and the PHP validator and requires that
//   1. every case gives the expected result in each language,
//   2. the two languages agree on every case, including each error's key and each spec digest,
//   3. the demo ring, compass and pickaxe definitions are accepted and their invalid variants are refused,
//   4. the real Node and PHP catalogs lint clean: no existing class is claimed by the standard, none uses
//      its reserved keys, and the legacy effect keys they carry are listed.
// No server is started and nothing is written. Needs php on the PATH.
//   node test/item-standard.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const std = require('../issuer-server/item-standard');

const ROOT = path.resolve(__dirname, '..');
const vectors = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'item-standard-v0.1.json'), 'utf8'));

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('PASS: ' + msg);
  else { failures += 1; console.log('FAIL: ' + msg); }
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function patch(base, p) {
  const out = JSON.parse(JSON.stringify(base));
  for (const k of Object.keys(p || {})) { if (p[k] === null) delete out[k]; else out[k] = p[k]; }
  return out;
}
function detail(errors) { return errors.map((e) => e.code + '@' + e.key).sort(); }
function codes(errors) { return std.uniqueCodes(errors); }

function itemProps(c) {
  const spec = vectors.specs[c.deriveFrom || c.spec];
  const props = patch(c.derive && spec ? std.deriveItemProperties(spec) : (c.properties || {}), c.set);
  for (let i = 0; i < (c.pad || 0); i++) props['com.example.pad' + i] = 'x';
  return props;
}
function roller(name) {
  let n = 0;
  const tiers = ['common', 'uncommon', 'rare', 'legendary'];
  return () => {
    const i = n % 4;
    n += 1;
    const luck = name === 'ring-bad' ? i + 1 : Math.min(3, i + 1);
    return { 'atlas.rarity': tiers[i], 'atlas.avatar.stat.luck': String(luck) };
  };
}
function resolveCatalog(def) {
  const out = {};
  for (const cls of Object.keys(def.classes)) {
    const e = JSON.parse(JSON.stringify(def.classes[cls]));
    if (typeof e.itemSpec === 'string') e.itemSpec = vectors.specs[e.itemSpec];
    if (e.randomize) { e.randomizeProperties = roller(e.randomize); delete e.randomize; }
    out[cls] = e;
  }
  return out;
}
const sortErrors = (list) => list.slice().sort((a, b) => (a.class + '|' + a.code + '|' + a.key).localeCompare(b.class + '|' + b.code + '|' + b.key));

function runNode() {
  const res = { digests: [], specCases: [], itemCases: [], legacyCases: [], catalogs: {} };
  for (const d of vectors.digests) res.digests.push({ spec: d.spec, canonical: std.canonical(vectors.specs[d.spec]), sha256: std.itemSpecDigest(vectors.specs[d.spec]) });
  for (const c of vectors.specCases) {
    const spec = c.itemSpec !== undefined ? c.itemSpec : patch(vectors.specs[c.spec], c.specPatch);
    const r = std.validateItemSpec(spec, c.ctx);
    res.specCases.push({ name: c.name, ok: r.ok, codes: codes(r.errors), detail: detail(r.errors) });
  }
  for (const c of vectors.itemCases) {
    const spec = c.spec === null ? null : patch(vectors.specs[c.spec], c.specPatch);
    const r = std.validateItemProperties(spec, itemProps(c), c.ctx);
    res.itemCases.push({ name: c.name, applies: r.applies, codes: codes(r.errors), detail: detail(r.errors) });
  }
  for (const c of vectors.legacyCases) {
    const r = std.validateItemProperties(null, itemProps(c), c.ctx);
    res.legacyCases.push({ name: c.name, applies: r.applies, codes: codes(r.errors), detail: detail(r.errors) });
  }
  for (const name of Object.keys(vectors.catalogs)) {
    const r = std.lintCatalog(resolveCatalog(vectors.catalogs[name]));
    res.catalogs[name] = { checked: r.checked.slice().sort(), skipped: r.skipped, errors: sortErrors(r.errors), legacy: r.legacy };
  }
  return res;
}

// The real Node catalog: ASSET_CATALOG is a literal inside server.js (which listens on require), so the
// literal is evaluated on its own with unknown identifiers stubbed, plus the generated element entries.
function realNodeCatalog() {
  const lines = fs.readFileSync(path.join(ROOT, 'issuer-server', 'server.js'), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('const ASSET_CATALOG = {'));
  let end = -1;
  for (let i = start; i < lines.length; i++) if (lines[i] === '};') { end = i; break; }
  if (start < 0 || end < 0) throw new Error('ASSET_CATALOG literal not found in issuer-server/server.js');
  const literal = lines.slice(start, end + 1).join('\n').replace(/^const ASSET_CATALOG = /, '').replace(/;$/, '');
  const sandbox = new Proxy({}, {
    has: () => true,
    get: (t, k) => (k === Symbol.unscopables ? undefined : (k in t ? t[k] : (k === 'DOMAIN' ? 'example.com' : () => ({}))))
  });
  const catalog = vm.runInContext('(' + literal + ')', vm.createContext(sandbox));
  Object.assign(catalog, require('../issuer-server/elements-catalog')('example.com'));
  return catalog;
}

function runPhp(mode) {
  const r = spawnSync('php', [path.join(__dirname, 'item-standard-runner.php'), mode], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('php runner failed (' + mode + '): ' + (r.stderr || r.stdout));
  const out = JSON.parse(r.stdout);
  for (const c of Object.values(out.catalogs || {})) c.errors = sortErrors(c.errors);
  return out;
}

function verify(label, res) {
  console.log('STEP: ' + label + ' against the vectors');
  check(vectors.digests.every((d, i) => res.digests[i].sha256 === d.sha256 && res.digests[i].canonical === d.canonical), label + ': every spec digest and canonical form matches');
  vectors.specCases.forEach((c, i) => {
    const r = res.specCases[i];
    check(same(r.codes, c.errors) && r.ok === (c.errors.length === 0), label + ' spec: ' + c.name + (same(r.codes, c.errors) ? '' : ' (got ' + JSON.stringify(r.codes) + ')'));
  });
  vectors.itemCases.forEach((c, i) => {
    const r = res.itemCases[i];
    check(r.applies === c.applies && same(r.codes, c.errors), label + ' item: ' + c.name + (same(r.codes, c.errors) ? '' : ' (got ' + JSON.stringify(r.codes) + ')'));
  });
  vectors.legacyCases.forEach((c, i) => {
    const r = res.legacyCases[i];
    check(r.applies === false && r.codes.length === 0, label + ' outside the standard: ' + c.name);
  });
  for (const name of Object.keys(vectors.catalogs)) {
    const want = vectors.catalogs[name].expect;
    const got = res.catalogs[name];
    check(same(got.checked, want.checked) && got.skipped === want.skipped && same(got.errors, sortErrors(want.errors)) && same(got.legacy, want.legacy), label + ' catalog lint: ' + name + (same(got.errors, sortErrors(want.errors)) ? '' : ' (got ' + JSON.stringify(got.errors) + ')'));
  }
}

console.log('SETUP: ' + vectors.specCases.length + ' spec cases, ' + vectors.itemCases.length + ' item cases, ' + vectors.legacyCases.length + ' outside-the-standard cases, ' + Object.keys(vectors.catalogs).length + ' catalogs');
const node = runNode();
verify('Node', node);
const php = runPhp('vectors');
verify('PHP', php);

console.log('STEP: Node and PHP agree on every case');
check(same(node.digests, php.digests), 'digests and canonical forms are identical');
check(same(node.specCases, php.specCases), 'spec cases: same result, error codes and keys');
check(same(node.itemCases, php.itemCases), 'item cases: same result, error codes and keys');
check(same(node.legacyCases, php.legacyCases), 'outside-the-standard cases: same result');
check(same(node.catalogs, php.catalogs), 'catalog lint: same result');

console.log('STEP: the real catalogs are untouched by the standard');
const realNode = std.lintCatalog(realNodeCatalog());
const realPhp = runPhp('lint-real');
for (const [label, r] of [['Node', realNode], ['PHP', realPhp]]) {
  check(r.errors.length === 0, label + ' catalog: no class uses a reserved key without an itemSpec' + (r.errors.length ? ' ' + JSON.stringify(r.errors.slice(0, 5)) : ''));
  check(r.checked.length === 0, label + ' catalog: no class claims the standard yet (' + r.skipped + ' classes outside it)');
  const legacy = Object.keys(r.legacy).sort();
  console.log('INFO: ' + label + ' catalog legacy effect keys on ' + legacy.length + ' classes: ' + legacy.map((c) => c + ' [' + r.legacy[c].map((k) => k.replace('atlas.avatar.', '')).join(', ') + ']').join('; '));
}
check(realNode.skipped > 100 && realPhp.skipped >= realNode.skipped, 'both catalogs were read in full (Node ' + realNode.skipped + ' classes, PHP ' + realPhp.skipped + ')');
check(same(Object.keys(realNode.legacy).sort(), Object.keys(realPhp.legacy).sort().filter((c) => c in realNode.legacy)), 'legacy classes shared by both catalogs agree');

console.log(failures ? '\nITEM STANDARD CHECKS FAILED (' + failures + ')' : '\nITEM STANDARD CHECKS PASSED');
process.exit(failures ? 1 : 0);
