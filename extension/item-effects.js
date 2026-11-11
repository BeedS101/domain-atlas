// What a world lets equipped items do. Pure functions; wallet.js feeds them the equipped items and the verdict
// on each one (see AtlasWallet.verifyStandardItem), viewer.js feeds them the world. Loads in the page and in
// the service worker (global `AtlasItemEffects`) and in Node for tests.
//
// Only items that carry `atlas.item.standard` are governed here. Every other item keeps the behaviour it has
// always had and is never gated by `itemEffects`. A standard item's effects (stat bonuses, speed/jump/reach
// multipliers, capabilities) apply only when
//   1. its signed spec digest resolved to an issuer-published spec and its properties satisfy that spec,
//   2. the world accepts its class and trusts its issuer, when the world declares those filters, and
//   3. the world's `itemEffects` policy enables that particular stat, multiplier or capability.
// Appearance (colours, models) is not an effect and is never withheld.
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AtlasItemEffects = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const STAT_IDS = ['health', 'mana', 'stamina', 'agility', 'intelligence', 'strength', 'armor', 'defense', 'resistance', 'attackSpeed', 'criticalStrike', 'dexterity', 'focus', 'luck', 'charisma'];
const MULTIPLIER_KINDS = ['speed', 'jump', 'interactRange'];
const CAPABILITY_IDS = ['atlas.cap.compass', 'atlas.cap.mine', 'atlas.cap.dig', 'atlas.cap.light', 'atlas.cap.blast', 'atlas.cap.unlock'];

const MULTIPLIER_KEYS = {
  speed: 'atlas.avatar.speedMultiplier',
  jump: 'atlas.avatar.jumpMultiplier',
  interactRange: 'atlas.avatar.interactRangeMultiplier'
};
// Slot-prefixed aliases hats and shoes already use. Same effect as the generic key; the alias wins if both appear.
const MULTIPLIER_ALIASES = {
  hat: { speed: 'atlas.avatar.hatSpeedMultiplier', jump: 'atlas.avatar.hatJumpMultiplier', interactRange: 'atlas.avatar.hatInteractRangeMultiplier' },
  shoes: { speed: 'atlas.avatar.shoeSpeedMultiplier', jump: 'atlas.avatar.shoeJumpMultiplier' }
};
const STAT_PREFIX = 'atlas.avatar.stat.';
const LIST_LIMIT = 32;
// Capability parameters read as numbers; any other parameter (a lock id, say) is passed through as signed.
const NUMERIC_PARAMS = ['tier', 'radius'];
const CAPABILITY_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9_-]*)+$/;

// Why an effect is not active. The text is what the character window shows.
const REASONS = {
  'item-unverified': "Couldn't be checked against the issuer's item specification",
  'item-invalid': "Doesn't match the issuer's item specification",
  'no-world': 'Item effects apply only inside a world',
  'world-effects-off': "This world doesn't support item effects",
  'class-not-accepted': "This world doesn't accept this item class",
  'issuer-not-trusted': "This world doesn't trust this item's issuer",
  'effect-not-enabled': "This world doesn't enable this effect"
};

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function has(o, k) { return isObject(o) && Object.prototype.hasOwnProperty.call(o, k); }

function isStandard(asset) {
  const props = asset && asset.properties;
  return has(props, 'atlas.item.standard');
}

// A policy.itemEffects value as `{ stats, multipliers, capabilities }` (arrays of ids), or null when the world
// enables nothing (absent, false, or any non-object). `stats` and `multipliers` accept a list or 'all';
// capabilities are always listed explicitly. Unknown ids are dropped.
function normalizePolicy(raw) {
  if (!isObject(raw)) return null;
  const pick = (value, allowed) => {
    if (value === 'all') return allowed.slice();
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const v of value.slice(0, LIST_LIMIT)) if (typeof v === 'string' && allowed.includes(v) && !out.includes(v)) out.push(v);
    return out;
  };
  const capabilities = [];
  if (Array.isArray(raw.capabilities)) {
    for (const v of raw.capabilities.slice(0, LIST_LIMIT)) {
      if (typeof v === 'string' && v.length <= 96 && CAPABILITY_RE.test(v) && !capabilities.includes(v)) capabilities.push(v);
    }
  }
  return { stats: pick(raw.stats, STAT_IDS), multipliers: pick(raw.multipliers, MULTIPLIER_KINDS), capabilities };
}

// The raw itemEffects value for a world: a manifest-level default, with the world's own value winning outright
// when present, including false or an empty object (SPEC.md section 3.4.1).
function effectivePolicy(manifest, world) {
  const policy = world && world.policy;
  if (has(policy, 'itemEffects')) return policy.itemEffects;
  return manifest ? manifest.itemEffects : undefined;
}

// Accepted classes for a world, or null when neither the world nor the manifest declares the list.
function declaredClasses(manifest, world) {
  const policy = world && world.policy;
  if (policy && Array.isArray(policy.acceptedItemClasses)) return policy.acceptedItemClasses;
  if (manifest && Array.isArray(manifest.acceptedItemClasses)) return manifest.acceptedItemClasses;
  return null;
}

function classMatches(cls, patterns) {
  return patterns.some((p) => typeof p === 'string' && (p.endsWith('.*') ? cls.startsWith(p.slice(0, -1)) : cls === p));
}

// Everything the resolver needs to know about a world. `selfDomain` is what trustedIssuers "self" means.
function worldContext(manifest, world, selfDomain) {
  const policy = (world && world.policy) || {};
  return {
    worldId: (world && world.id) || null,
    worldName: (world && world.name) || null,
    effects: normalizePolicy(effectivePolicy(manifest, world)),
    classes: declaredClasses(manifest, world),
    trustedIssuers: has(policy, 'trustedIssuers') ? policy.trustedIssuers : null,
    selfDomain: selfDomain || null
  };
}

// null when the world admits this class from this issuer, otherwise the reason. A filter the world does not
// declare adds no restriction.
function admission(ctx, cls, issuerDomain) {
  if (ctx.classes && !classMatches(String(cls || ''), ctx.classes)) return 'class-not-accepted';
  const trusted = ctx.trustedIssuers;
  if (trusted === null || trusted === undefined || trusted === 'any') return null;
  if (trusted === 'self') return issuerDomain && issuerDomain === ctx.selfDomain ? null : 'issuer-not-trusted';
  if (Array.isArray(trusted)) return trusted.includes(issuerDomain) ? null : 'issuer-not-trusted';
  return 'issuer-not-trusted';
}

function numberOf(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) ? n : null;
}

// The effects an item's properties declare, whether or not they are allowed to apply:
//   { kind: 'stat', id, value, keys }, { kind: 'multiplier', id, value, keys }, { kind: 'capability', id, params }
function declaredEffects(asset, slot) {
  const props = (asset && asset.properties) || {};
  const out = [];
  for (const key of Object.keys(props).sort()) {
    if (!key.startsWith(STAT_PREFIX)) continue;
    const id = key.slice(STAT_PREFIX.length);
    if (!STAT_IDS.includes(id)) continue;
    const n = numberOf(props[key]);
    if (n === null) continue;
    const value = Math.max(-100, Math.min(500, Math.round(n)));
    if (value !== 0) out.push({ kind: 'stat', id, value, keys: [key] });
  }
  const itemSlot = typeof props['atlas.avatar.slot'] === 'string' ? props['atlas.avatar.slot'] : slot;
  for (const kind of MULTIPLIER_KINDS) {
    const generic = MULTIPLIER_KEYS[kind];
    const alias = has(MULTIPLIER_ALIASES, itemSlot) ? MULTIPLIER_ALIASES[itemSlot][kind] : null;
    const keys = [generic, alias].filter((k) => k && has(props, k));
    if (!keys.length) continue;
    const n = numberOf(alias && has(props, alias) ? props[alias] : props[generic]);
    if (n === null) continue;
    const value = Math.min(3, Math.max(0.25, n));
    if (value !== 1) out.push({ kind: 'multiplier', id: kind, value, keys });
  }
  const caps = Array.isArray(props['atlas.item.capabilities']) ? props['atlas.item.capabilities'] : [];
  for (const id of caps) {
    if (typeof id !== 'string') continue;
    const params = {};
    for (const key of Object.keys(props).sort()) {
      if (key.startsWith(id + '.')) {
        const name = key.slice(id.length + 1);
        const n = numberOf(props[key]);
        params[name] = n !== null && NUMERIC_PARAMS.includes(name) ? n : props[key];
      }
    }
    out.push({ kind: 'capability', id, params, keys: Object.keys(params).map((n) => id + '.' + n) });
  }
  return out;
}

// What is withheld, as a reason code, or null when the effect applies. `verdict` is the wallet's verification
// result for the item: 'verified', 'invalid' or 'unverified'.
function withheldReason(effect, verdict, admitted, ctx) {
  if (verdict === 'invalid') return 'item-invalid';
  if (verdict !== 'verified') return 'item-unverified';
  if (!ctx) return 'no-world';
  if (!ctx.effects) return 'world-effects-off';
  if (admitted) return admitted;
  const list = effect.kind === 'stat' ? ctx.effects.stats : effect.kind === 'multiplier' ? ctx.effects.multipliers : ctx.effects.capabilities;
  return list.includes(effect.id) ? null : 'effect-not-enabled';
}

// Resolves one equipped or carried item against a world.
//   item: { asset, issuerDomain, slot, assetId, verdict, verdictReason }
// A non-standard item returns { standard: false }. A standard one returns
//   { standard: true, verdict, verdictReason, admitted, effects: [{ kind, id, value|params, active, reason }] }
function evaluate(item, ctx) {
  const asset = item && item.asset;
  if (!isStandard(asset)) return { standard: false };
  const verdict = item.verdict === 'verified' || item.verdict === 'invalid' ? item.verdict : 'unverified';
  const admitted = ctx && ctx.effects ? admission(ctx, asset.class, item.issuerDomain) : null;
  const effects = declaredEffects(asset, item.slot).map((e) => {
    const reason = withheldReason(e, verdict, admitted, ctx);
    const out = { kind: e.kind, id: e.id, active: reason === null, reason, keys: e.keys };
    if (e.kind === 'capability') out.params = e.params; else out.value = e.value;
    return out;
  });
  return { standard: true, verdict, verdictReason: item.verdictReason || null, admitted, effects };
}

// A copy of the item's asset with every withheld effect removed, so the existing stat and movement arithmetic
// can run on it unchanged. A hat's or shoe's generic multiplier is folded into the slot's own alias key, which
// is the one the hat and shoe readers use. Non-standard assets are returned as they are.
function effectiveAsset(asset, report, slot) {
  if (!report || !report.standard) return asset;
  const props = { ...(asset.properties || {}) };
  for (const e of report.effects) if (!e.active) for (const key of e.keys) delete props[key];
  const itemSlot = typeof props['atlas.avatar.slot'] === 'string' ? props['atlas.avatar.slot'] : slot;
  if (has(MULTIPLIER_ALIASES, itemSlot)) {
    for (const e of report.effects) {
      if (e.kind !== 'multiplier' || !e.active) continue;
      const alias = MULTIPLIER_ALIASES[itemSlot][e.id];
      if (alias) { props[alias] = e.value; delete props[MULTIPLIER_KEYS[e.id]]; }
    }
  }
  return { ...asset, properties: props };
}

// The six-capability interface: { capabilityId: [provider] } for the capabilities that are active, each
// provider { id, assetId, slot, source, class, name, params, uses }. `items` are { asset, slot, assetId, report,
// source: 'equipped' | 'carried' }. Order is stable: equipped before carried, then slot, then asset id.
function collectCapabilities(items) {
  const out = {};
  const sorted = items.slice().sort((a, b) => {
    const rank = (x) => (x.source === 'carried' ? 1 : 0);
    return rank(a) - rank(b) || String(a.slot || '').localeCompare(String(b.slot || '')) || String(a.assetId).localeCompare(String(b.assetId));
  });
  for (const item of sorted) {
    if (!item.report || !item.report.standard) continue;
    const uses = numberOf((item.asset.properties || {})['atlas.item.uses']);
    for (const e of item.report.effects) {
      if (e.kind !== 'capability' || !e.active) continue;
      (out[e.id] = out[e.id] || []).push({
        id: e.id, assetId: item.assetId, slot: item.slot || null, source: item.source || 'equipped',
        class: item.asset.class, name: item.asset.name, params: { ...e.params }, uses
      });
    }
  }
  return out;
}

return {
  STAT_IDS, MULTIPLIER_KINDS, CAPABILITY_IDS, REASONS,
  isStandard, normalizePolicy, effectivePolicy, declaredClasses, classMatches, worldContext, admission,
  declaredEffects, evaluate, effectiveAsset, collectCapabilities
};
}));
