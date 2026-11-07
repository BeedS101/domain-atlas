#!/usr/bin/env node
// Item effects (extension/item-effects.js): which effects of standard items a world lets apply. Pure logic, no
// browser and no server.
//   node test/item-effects.js
//
// Covers: policy.itemEffects normalisation; the manifest-level default with the world's own value winning
// outright (SPEC.md section 3.4.1), including false and an empty object; the accepted-classes and
// trusted-issuers filters; the reason given for every withheld effect; that legacy items are never gated;
// hat and shoe alias handling; and the capability interface.
const path = require('path');
const fx = require(path.join('..', 'extension', 'item-effects.js'));

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('PASS: ' + msg);
  else { failures += 1; console.log('FAIL: ' + msg); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const DIGEST = 'a'.repeat(64);
function standard(slot, props, cls) {
  return {
    class: cls || 'atlas.wearable.ring.example', name: 'Test ' + slot, fungible: false,
    properties: Object.assign({ 'atlas.item.standard': '0.1', 'atlas.item.category': 'equipment', 'atlas.avatar.slot': slot, 'atlas.item.specDigest': DIGEST }, props)
  };
}
const item = (asset, extra) => Object.assign({ asset, issuerDomain: 'issuer.example.com', slot: asset.properties['atlas.avatar.slot'], assetId: 'urn:test:1', verdict: 'verified' }, extra || {});
const world = (policy, manifest) => fx.worldContext(manifest || { domain: 'issuer.example.com' }, { id: 'w', name: 'W', policy }, 'issuer.example.com');
const active = (report) => report.effects.filter((e) => e.active).map((e) => e.kind + ':' + e.id);
const withheld = (report) => Object.fromEntries(report.effects.filter((e) => !e.active).map((e) => [e.kind + ':' + e.id, e.reason]));

console.log('STEP: policy.itemEffects normalisation');
check(fx.normalizePolicy(undefined) === null && fx.normalizePolicy(false) === null && fx.normalizePolicy(true) === null && fx.normalizePolicy('all') === null && fx.normalizePolicy([]) === null, 'absent, false, true, a string and an array all mean nothing is enabled');
check(same(fx.normalizePolicy({}), { stats: [], multipliers: [], capabilities: [] }), 'an empty object is a policy that enables nothing');
check(same(fx.normalizePolicy({ stats: 'all', multipliers: 'all' }).stats, fx.STAT_IDS) && same(fx.normalizePolicy({ multipliers: 'all' }).multipliers, ['speed', 'jump', 'interactRange']), "'all' expands for stats and multipliers");
check(same(fx.normalizePolicy({ capabilities: 'all' }).capabilities, []), "capabilities are never 'all': they must be listed");
check(same(fx.normalizePolicy({ stats: ['luck', 'luck', 'nope', 7] }).stats, ['luck']), 'unknown and repeated stat ids are dropped');
check(same(fx.normalizePolicy({ capabilities: ['atlas.cap.mine', 'example.com.cap.teleport', 'BAD ID', 'atlas.cap.mine'] }).capabilities, ['atlas.cap.mine', 'example.com.cap.teleport']), 'capability ids are kept when well formed, third-party ones included');
check(fx.normalizePolicy({ stats: Array.from({ length: 100 }, () => 'luck') }).stats.length === 1 && fx.normalizePolicy({ capabilities: Array.from({ length: 100 }, (_, i) => 'a.cap.c' + i) }).capabilities.length === 32, 'lists are bounded');

console.log('STEP: manifest default and per-world override (section 3.4.1)');
const manifest = { domain: 'issuer.example.com', itemEffects: { stats: ['luck'] } };
const pick = (w) => fx.effectivePolicy(manifest, w);
check(same(pick({ policy: {} }), { stats: ['luck'] }), 'a world with no itemEffects falls back to the manifest default');
check(same(pick({}), { stats: ['luck'] }), 'a world with no policy at all falls back too');
check(pick({ policy: { itemEffects: false } }) === false, "a world's own false wins over the default");
check(same(pick({ policy: { itemEffects: {} } }), {}), "a world's own empty object wins over the default");
check(same(pick({ policy: { itemEffects: { multipliers: ['speed'] } } }), { multipliers: ['speed'] }), "a world's own object replaces the default rather than merging with it");
check(fx.effectivePolicy({ domain: 'x' }, { policy: {} }) === undefined, 'with neither declared there is no policy');
check(world({ itemEffects: false }, manifest).effects === null && world({}, manifest).effects.stats.join() === 'luck', 'the context reflects the same precedence');

console.log('STEP: accepted classes and trusted issuers');
const ring = standard('ring', { 'atlas.avatar.stat.luck': '2' });
const open = { itemEffects: { stats: ['luck'] } };
check(active(fx.evaluate(item(ring), world(open))).join() === 'stat:luck', 'no filters declared: the item is admitted');
check(active(fx.evaluate(item(ring), world({ ...open, acceptedItemClasses: ['atlas.wearable.*'] }))).join() === 'stat:luck', 'a class family pattern admits its members');
check(withheld(fx.evaluate(item(ring), world({ ...open, acceptedItemClasses: ['atlas.tool.*'] })))['stat:luck'] === 'class-not-accepted', 'a class the world does not accept is withheld');
check(withheld(fx.evaluate(item(ring), world({ ...open, acceptedItemClasses: [] })))['stat:luck'] === 'class-not-accepted', 'a declared empty class list admits nothing');
check(active(fx.evaluate(item(ring), world(open, { domain: 'issuer.example.com', acceptedItemClasses: ['atlas.wearable.ring.example'] }))).join() === 'stat:luck', 'the manifest-level accepted classes apply to a world that declares none');
check(withheld(fx.evaluate(item(ring), world({ ...open, acceptedItemClasses: ['atlas.wearable.ring.exampl'] })))['stat:luck'] === 'class-not-accepted', 'a class without the wildcard matches exactly, not by prefix');
check(active(fx.evaluate(item(ring), world({ ...open, trustedIssuers: 'any' }))).length === 1, "trustedIssuers 'any' admits");
check(active(fx.evaluate(item(ring), world({ ...open, trustedIssuers: 'self' }))).length === 1, "trustedIssuers 'self' admits the world's own domain");
check(withheld(fx.evaluate(item(ring, { issuerDomain: 'other.example.net' }), world({ ...open, trustedIssuers: 'self' })))['stat:luck'] === 'issuer-not-trusted', "trustedIssuers 'self' refuses another domain");
check(active(fx.evaluate(item(ring, { issuerDomain: 'other.example.net' }), world({ ...open, trustedIssuers: ['other.example.net'] }))).length === 1, 'a listed issuer is admitted');
check(withheld(fx.evaluate(item(ring), world({ ...open, trustedIssuers: ['other.example.net'] })))['stat:luck'] === 'issuer-not-trusted', 'an unlisted issuer is refused');
check(withheld(fx.evaluate(item(ring), world({ ...open, trustedIssuers: 5 })))['stat:luck'] === 'issuer-not-trusted', 'an unrecognised trustedIssuers value refuses');

console.log('STEP: what is enabled, per effect');
const boots = standard('shoes', { 'atlas.avatar.stat.agility': '4', 'atlas.avatar.stat.luck': '1', 'atlas.avatar.speedMultiplier': '1.2', 'atlas.avatar.jumpMultiplier': '1.1' }, 'atlas.wearable.boots.example');
let report = fx.evaluate(item(boots), world({ itemEffects: { stats: ['agility'], multipliers: ['speed'] } }));
check(same(active(report), ['stat:agility', 'multiplier:speed']), 'only the listed stat and multiplier apply');
check(withheld(report)['stat:luck'] === 'effect-not-enabled' && withheld(report)['multiplier:jump'] === 'effect-not-enabled', 'the rest are withheld as not enabled');
report = fx.evaluate(item(boots), world({}));
check(report.effects.every((e) => !e.active && e.reason === 'world-effects-off'), 'a world with no itemEffects withholds everything as unsupported');
report = fx.evaluate(item(boots), null);
check(report.effects.every((e) => !e.active && e.reason === 'no-world'), 'with no world nothing applies');
report = fx.evaluate(item(boots, { verdict: 'unverified' }), world({ itemEffects: { stats: 'all', multipliers: 'all' } }));
check(report.verdict === 'unverified' && report.effects.every((e) => !e.active && e.reason === 'item-unverified'), 'an item that could not be verified applies nothing');
report = fx.evaluate(item(boots, { verdict: 'invalid' }), world({ itemEffects: { stats: 'all', multipliers: 'all' } }));
check(report.effects.every((e) => !e.active && e.reason === 'item-invalid'), 'an item that fails its spec applies nothing');
check(fx.evaluate(item(boots, { verdict: 'whatever' }), world({ itemEffects: { stats: 'all' } })).verdict === 'unverified', 'an unknown verdict is treated as unverified');

console.log('STEP: values are clamped as the wallet clamps them');
const wild = standard('ring', { 'atlas.avatar.stat.luck': '9999', 'atlas.avatar.stat.charisma': '-9999', 'atlas.avatar.speedMultiplier': 99, 'atlas.avatar.jumpMultiplier': '0.01', 'atlas.avatar.stat.focus': 'abc' });
report = fx.evaluate(item(wild), world({ itemEffects: { stats: 'all', multipliers: 'all' } }));
const val = (kind, id) => report.effects.find((e) => e.kind === kind && e.id === id);
check(val('stat', 'luck').value === 500 && val('stat', 'charisma').value === -100 && !val('stat', 'focus'), 'stat bonuses are limited to -100..500 and unreadable ones are ignored');
check(val('multiplier', 'speed').value === 3 && val('multiplier', 'jump').value === 0.25, 'multipliers are limited to 0.25..3');

console.log('STEP: hats and shoes use their alias keys');
const hat = standard('hat', { 'atlas.avatar.hatColor': '#112233', 'atlas.avatar.speedMultiplier': '1.3', 'atlas.avatar.hatJumpMultiplier': '1.4', 'atlas.avatar.jumpMultiplier': '2' }, 'atlas.avatar.hat.example');
report = fx.evaluate(item(hat), world({ itemEffects: { multipliers: ['speed', 'jump'] } }));
let eff = fx.effectiveAsset(hat, report, 'hat');
check(eff.properties['atlas.avatar.hatSpeedMultiplier'] === 1.3 && eff.properties['atlas.avatar.speedMultiplier'] === undefined, "a hat's generic speed multiplier is folded into the hat key");
check(eff.properties['atlas.avatar.hatJumpMultiplier'] === 1.4, 'when both appear the hat key wins');
report = fx.evaluate(item(hat), world({ itemEffects: { multipliers: ['speed'] } }));
eff = fx.effectiveAsset(hat, report, 'hat');
check(eff.properties['atlas.avatar.hatJumpMultiplier'] === undefined && eff.properties['atlas.avatar.jumpMultiplier'] === undefined, 'a withheld multiplier loses both its generic and alias keys');
check(eff.properties['atlas.avatar.hatColor'] === '#112233' && eff.properties['atlas.item.standard'] === '0.1', 'appearance and the standard properties are kept');
check(hat.properties['atlas.avatar.speedMultiplier'] === '1.3', 'the signed asset itself is never modified');
report = fx.evaluate(item(boots), world({ itemEffects: { stats: [], multipliers: ['jump'] } }));
eff = fx.effectiveAsset(boots, report, 'shoes');
check(eff.properties['atlas.avatar.shoeJumpMultiplier'] === 1.1 && eff.properties['atlas.avatar.stat.agility'] === undefined && eff.properties['atlas.avatar.speedMultiplier'] === undefined, 'shoes: enabled multiplier becomes the shoe key, withheld stat and multiplier are removed');

console.log('STEP: legacy items are never gated');
const legacyHat = { class: 'atlas.avatar.hat.sunhat', name: 'Sun Hat', properties: { 'atlas.avatar.hatColor': '#ffcc00', 'atlas.avatar.hatSpeedMultiplier': 1.2 } };
check(fx.evaluate(item(legacyHat), world(false)).standard === false, 'a legacy item has no report whatever the world says');
check(fx.effectiveAsset(legacyHat, fx.evaluate(item(legacyHat), world(false)), 'hat') === legacyHat, 'and comes back untouched');
check(!fx.isStandard(null) && !fx.isStandard({}) && !fx.isStandard({ properties: {} }) && fx.isStandard(ring), 'only the marker makes an item standard');

console.log('STEP: capabilities');
const pick1 = standard('hand', { 'atlas.item.capabilities': ['atlas.cap.mine'], 'atlas.cap.mine.tier': '2' }, 'atlas.tool.pick');
const compass = standard('trinket', { 'atlas.item.capabilities': ['atlas.cap.compass'] }, 'atlas.tool.compass');
const lantern = standard('offhand', { 'atlas.item.capabilities': ['atlas.cap.light'], 'atlas.cap.light.radius': '7.5' }, 'atlas.tool.lantern');
const dynamite = { class: 'atlas.consumable.dynamite', name: 'Dynamite', properties: { 'atlas.item.standard': '0.1', 'atlas.item.category': 'consumable', 'atlas.item.uses': '1', 'atlas.item.capabilities': ['atlas.cap.blast'], 'atlas.cap.blast.radius': '3', 'atlas.item.specDigest': DIGEST } };
const key = { class: 'atlas.key.vault', name: 'Vault Key', properties: { 'atlas.item.standard': '0.1', 'atlas.item.category': 'key', 'atlas.item.capabilities': ['atlas.cap.unlock'], 'atlas.cap.unlock.lock': '007', 'atlas.item.specDigest': DIGEST } };
const ctx = world({ itemEffects: { capabilities: ['atlas.cap.mine', 'atlas.cap.compass', 'atlas.cap.light', 'atlas.cap.blast', 'atlas.cap.unlock'] } });
const entries = [
  { asset: pick1, slot: 'hand', assetId: 'p', source: 'equipped' }, { asset: compass, slot: 'trinket1', assetId: 'c', source: 'equipped' },
  { asset: lantern, slot: 'offhand', assetId: 'l', source: 'equipped' }, { asset: dynamite, slot: null, assetId: 'd', source: 'carried' },
  { asset: key, slot: null, assetId: 'k', source: 'carried' }
].map((e) => Object.assign(e, { report: fx.evaluate(item(e.asset, { slot: e.slot, assetId: e.assetId }), ctx) }));
const caps = fx.collectCapabilities(entries);
check(same(Object.keys(caps).sort(), ['atlas.cap.blast', 'atlas.cap.compass', 'atlas.cap.light', 'atlas.cap.mine', 'atlas.cap.unlock']), 'five of the six capabilities are provided here');
check(!('atlas.cap.dig' in caps), 'dig has no provider');
check(same(caps['atlas.cap.mine'][0].params, { tier: 2 }) && caps['atlas.cap.mine'][0].slot === 'hand' && caps['atlas.cap.mine'][0].source === 'equipped', 'mine reports its tier, slot and source');
check(same(caps['atlas.cap.light'][0].params, { radius: 7.5 }) && same(caps['atlas.cap.blast'][0].params, { radius: 3 }), 'light and blast report their radius as numbers');
check(same(caps['atlas.cap.unlock'][0].params, { lock: '007' }), 'a lock id stays the string it was signed as');
check(caps['atlas.cap.blast'][0].source === 'carried' && caps['atlas.cap.blast'][0].uses === 1, 'a consumable counts while carried, with its use count');
check(same(caps['atlas.cap.compass'][0].params, {}), 'compass takes no parameters');
const narrow = world({ itemEffects: { capabilities: ['atlas.cap.compass'] } });
const narrowCaps = fx.collectCapabilities(entries.map((e) => Object.assign({}, e, { report: fx.evaluate(item(e.asset, { slot: e.slot, assetId: e.assetId }), narrow) })));
check(same(Object.keys(narrowCaps), ['atlas.cap.compass']), 'only the capabilities the world lists are provided');
const mineReport = fx.evaluate(item(pick1), narrow);
check(withheld(mineReport)['capability:atlas.cap.mine'] === 'effect-not-enabled', 'a capability the world does not list is withheld with that reason');
const unverifiedCaps = fx.collectCapabilities(entries.map((e) => Object.assign({}, e, { report: fx.evaluate(item(e.asset, { slot: e.slot, assetId: e.assetId, verdict: 'unverified' }), ctx) })));
check(same(unverifiedCaps, {}), 'unverified items provide no capability');
check(same(fx.CAPABILITY_IDS, ['atlas.cap.compass', 'atlas.cap.mine', 'atlas.cap.dig', 'atlas.cap.light', 'atlas.cap.blast', 'atlas.cap.unlock']), 'the six capability ids are exported in the standard order');
const thirdParty = standard('trinket', { 'atlas.item.capabilities': ['example.com.cap.teleport'], 'example.com.cap.teleport.range': '50' }, 'com.example.tool.relic');
const tpReport = fx.evaluate(item(thirdParty), world({ itemEffects: { capabilities: ['example.com.cap.teleport'] } }));
check(active(tpReport).join() === 'capability:example.com.cap.teleport', 'a third-party capability applies once the world names it');
check(withheld(fx.evaluate(item(thirdParty), world({ itemEffects: { capabilities: 'all' } })))['capability:example.com.cap.teleport'] === 'effect-not-enabled', "and not through 'all'");

console.log('STEP: every reason has text for the character window');
for (const code of ['item-unverified', 'item-invalid', 'no-world', 'world-effects-off', 'class-not-accepted', 'issuer-not-trusted', 'effect-not-enabled']) check(typeof fx.REASONS[code] === 'string' && fx.REASONS[code].length > 0, 'reason text: ' + code);

console.log(failures ? '\nITEM EFFECTS CHECKS FAILED (' + failures + ')' : '\nITEM EFFECTS CHECKS PASSED');
process.exit(failures ? 1 : 0);
