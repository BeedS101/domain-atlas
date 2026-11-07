'use strict';

// Domain Atlas Item Standard v0.1 validator (docs/item-standard-v0.1.md). Pure functions, no I/O, and nothing in
// the issuer requires this module yet. issuer-php/lib/item-standard.php implements the same rules, and
// docs/item-standard-v0.1.json holds the vectors both are tested against, so the two cannot drift.
//
// Scope: only items that claim the standard are checked (a class with an `itemSpec`, or properties carrying
// `atlas.item.standard`). Every other asset, including ones with numeric or nested properties, is outside it.

const crypto = require('crypto');

const STANDARD_VERSION = '0.1';

// Category -> what the class must be (null = either). Equipment, tool, key, credential and collectible are
// single items; material and currency stack.
const CATEGORIES = {
  equipment: { fungible: false, presentation: 'collectible' },
  tool: { fungible: false, presentation: 'collectible' },
  consumable: { fungible: null, presentation: 'collectible' },
  material: { fungible: true, presentation: 'collectible' },
  key: { fungible: false, presentation: 'collectible' },
  credential: { fungible: false, presentation: 'document' },
  collectible: { fungible: false, presentation: 'collectible' },
  currency: { fungible: true, presentation: 'collectible' }
};

// Class families an atlas.* class may use per category (credential and collectible classes keep their
// existing free-form families).
const CATEGORY_FAMILIES = {
  equipment: ['wearable', 'avatar'], tool: ['tool'], consumable: ['consumable'], material: ['material', 'element'],
  key: ['key'], currency: ['currency', 'credit']
};

// Slot kind -> property keys an item needs in that slot. hand and offhand need a model instead.
const SLOTS = {
  hat: { keys: ['atlas.avatar.hatColor'] },
  outfit: { keys: ['atlas.avatar.shirtColor', 'atlas.avatar.pantsColor'] },
  shoes: { keys: ['atlas.avatar.shoeColor'] },
  hand: { model: true },
  offhand: { model: true },
  gloves: { keys: ['atlas.avatar.color'] },
  legs: { keys: ['atlas.avatar.color'] },
  shoulders: { keys: ['atlas.avatar.color'] },
  neck: { keys: ['atlas.avatar.color'] },
  ring: {},
  trinket: {}
};
const TOOL_SLOTS = ['hand', 'offhand', 'trinket'];

const STAT_IDS = ['health', 'mana', 'stamina', 'agility', 'strength', 'focus', 'dexterity', 'defense', 'luck', 'charisma'];
const STAT_BOUNDS = [-100, 500];

// Multiplier kind -> generic property key, and the slot-prefixed aliases already used by hats and shoes.
const MULTIPLIER_KEYS = {
  speed: 'atlas.avatar.speedMultiplier',
  jump: 'atlas.avatar.jumpMultiplier',
  interactRange: 'atlas.avatar.interactRangeMultiplier'
};
const MULTIPLIER_ALIASES = {
  hat: { 'atlas.avatar.hatSpeedMultiplier': 'speed', 'atlas.avatar.hatJumpMultiplier': 'jump', 'atlas.avatar.hatInteractRangeMultiplier': 'interactRange' },
  shoes: { 'atlas.avatar.shoeSpeedMultiplier': 'speed', 'atlas.avatar.shoeJumpMultiplier': 'jump' }
};
const MULTIPLIER_BOUNDS = [0.25, 3];

// The v0.1 capability vocabulary. Parameters: int and number are ranges, id is a list of allowed values.
const CAPABILITIES = {
  'atlas.cap.compass': { categories: ['tool', 'equipment'], params: {} },
  'atlas.cap.mine': { categories: ['tool'], params: { tier: { type: 'int', min: 1, max: 5 } } },
  'atlas.cap.dig': { categories: ['tool'], params: { tier: { type: 'int', min: 1, max: 5 } } },
  'atlas.cap.light': { categories: ['tool', 'equipment'], params: { radius: { type: 'number', min: 1, max: 20 } } },
  'atlas.cap.blast': { categories: ['consumable'], params: { radius: { type: 'number', min: 1, max: 10 } } },
  'atlas.cap.unlock': { categories: ['key'], params: { lock: { type: 'id' } } }
};

const SPEC_KEYS = ['category', 'slot', 'uses', 'stats', 'multipliers', 'capabilities', 'capabilityParams'];
const ITEM_KEYS = ['standard', 'category', 'capabilities', 'uses', 'specDigest'];
const AVATAR_KEYS = ['slot', 'color', 'shirtColor', 'pantsColor', 'hatColor', 'shoeColor', 'shoeVisualScale', 'handItem'];
const COLOR_KEYS = ['atlas.avatar.color', 'atlas.avatar.shirtColor', 'atlas.avatar.pantsColor', 'atlas.avatar.hatColor', 'atlas.avatar.shoeColor'];
const RARITIES = ['common', 'uncommon', 'rare', 'legendary'];

const LIMITS = { properties: 32, key: 64, string: 256, list: 16, listItem: 64, foreign: 1024 };

const INT_RE = /^-?[0-9]{1,6}$/;
const DECIMAL_RE = /^-?[0-9]{1,6}(\.[0-9]{1,6})?$/;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PARAM_RE = /^[a-z][a-z0-9_]{0,23}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const ATLAS_CLASS_RE = /^atlas(\.[a-z][a-z0-9_]*){2,3}$/;
const FOREIGN_CLASS_RE = /^(?!atlas\.)[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9_-]*){2,}$/;
const FOREIGN_CAP_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+\.cap\.[a-z][a-z0-9_]*$/;
const PRINTABLE_RE = /^[\x20-\x7e]*$/;

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function isString(v) { return typeof v === 'string'; }
function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function uniqueCodes(errors) { return Array.from(new Set(errors.map((e) => e.code))).sort(); }

// A number from a decimal string or a finite JSON number (properties issued earlier may hold either); null
// when it is neither. intOnly rejects fractions.
function parseNumber(v, intOnly) {
  if (isString(v)) {
    if (!(intOnly ? INT_RE : DECIMAL_RE).test(v)) return null;
    return Number(v);
  }
  if (typeof v === 'number' && Number.isFinite(v)) return intOnly && Math.floor(v) !== v ? null : v;
  return null;
}

function inRange(n, min, max) { return n >= min - 1e-9 && n <= max + 1e-9; }

// {min, max} of decimal strings -> [min, max] numbers, or null when malformed, reversed or outside bounds.
function parseSpecRange(range, intOnly, bounds) {
  if (!isObject(range) || Object.keys(range).sort().join() !== 'max,min') return null;
  if (!isString(range.min) || !isString(range.max)) return null;
  const min = parseNumber(range.min, intOnly);
  const max = parseNumber(range.max, intOnly);
  if (min === null || max === null || min > max) return null;
  if (!inRange(min, bounds[0], bounds[1]) || !inRange(max, bounds[0], bounds[1])) return null;
  return [min, max];
}

function parseValuesSpec(spec) {
  if (!isObject(spec) || Object.keys(spec).join() !== 'values' || !Array.isArray(spec.values)) return null;
  if (spec.values.length < 1 || spec.values.length > LIMITS.list) return null;
  for (const v of spec.values) if (!isString(v) || !ID_RE.test(v)) return null;
  return spec.values;
}

// Canonical JSON of an itemSpec (strings, lists and objects only): sorted keys, no whitespace.
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (isObject(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

function itemSpecDigest(itemSpec) {
  return crypto.createHash('sha256').update(canonical(itemSpec), 'utf8').digest('hex');
}

// Walks one top-level itemSpec value: only printable-ASCII strings, lists and objects, nothing empty.
function specValueClean(v) {
  if (isString(v)) return PRINTABLE_RE.test(v);
  if (Array.isArray(v)) return v.length > 0 && v.every(specValueClean);
  if (isObject(v)) {
    const keys = Object.keys(v);
    return keys.length > 0 && keys.every((k) => PRINTABLE_RE.test(k) && specValueClean(v[k]));
  }
  return false;
}

// What the issuer signs for a class: the marker, the category and the slot, the capability list, the use
// count and the digest of the spec. Values the instance chooses (colours, stat rolls, capability parameters)
// come from the class's own properties.
function deriveItemProperties(itemSpec) {
  const out = { 'atlas.item.standard': STANDARD_VERSION, 'atlas.item.category': itemSpec.category };
  if (itemSpec.slot) out['atlas.avatar.slot'] = itemSpec.slot;
  if (Array.isArray(itemSpec.capabilities)) out['atlas.item.capabilities'] = itemSpec.capabilities.slice().sort();
  if (itemSpec.category === 'consumable') out['atlas.item.uses'] = isString(itemSpec.uses) ? itemSpec.uses : '1';
  out['atlas.item.specDigest'] = itemSpecDigest(itemSpec);
  return out;
}

function reverseDomain(domain) {
  return String(domain).toLowerCase().replace(/:\d+$/, '').split('.').reverse().join('.');
}

// Checks a class definition. ctx: { fungible, presentation, classId, issuerDomain } (each optional).
// Returns { ok, errors: [{ code, key }] }.
function validateItemSpec(itemSpec, ctx) {
  ctx = ctx || {};
  const errors = [];
  const err = (code, key) => errors.push({ code, key: key === undefined ? null : key });
  if (!isObject(itemSpec)) { err('itemspec-invalid', 'itemSpec'); return { ok: false, errors }; }

  for (const key of Object.keys(itemSpec)) {
    if (!SPEC_KEYS.includes(key)) err('itemspec-invalid', key);
    else if (!specValueClean(itemSpec[key])) err('itemspec-invalid', key);
  }
  const clean = (key) => has(itemSpec, key) && specValueClean(itemSpec[key]);

  const category = itemSpec.category;
  const rule = isString(category) && has(CATEGORIES, category) ? CATEGORIES[category] : null;
  if (!rule) {
    err('itemspec-category-invalid', 'category');
  } else {
    if (rule.fungible !== null && typeof ctx.fungible === 'boolean' && ctx.fungible !== rule.fungible) err('itemspec-category-fungible-mismatch', 'category');
    if (isString(ctx.presentation) && ctx.presentation !== rule.presentation) err('itemspec-presentation-mismatch', 'category');
  }

  const slot = itemSpec.slot;
  if (has(itemSpec, 'slot')) {
    if (!isString(slot) || !has(SLOTS, slot)) err('itemspec-slot-invalid', 'slot');
    else if (category === 'equipment') { /* any slot */ }
    else if (!(category === 'tool' && TOOL_SLOTS.includes(slot))) err('itemspec-slot-not-allowed', 'slot');
  } else if (category === 'equipment') {
    err('itemspec-slot-required', 'slot');
  }

  if (has(itemSpec, 'uses')) {
    const uses = isString(itemSpec.uses) && INT_RE.test(itemSpec.uses) ? Number(itemSpec.uses) : null;
    if (category !== 'consumable' || uses === null || uses < 1 || uses > 1000) err('itemspec-uses-invalid', 'uses');
  }

  const effectsAllowed = !rule || category === 'equipment' || category === 'tool';
  if (has(itemSpec, 'stats') && clean('stats') && !isObject(itemSpec.stats)) err('itemspec-invalid', 'stats');
  else if (has(itemSpec, 'stats') && clean('stats')) {
    if (!effectsAllowed) err('itemspec-effects-not-allowed', 'stats');
    for (const id of Object.keys(itemSpec.stats).sort()) {
      if (!STAT_IDS.includes(id)) err('itemspec-stat-unknown', id);
      else if (parseSpecRange(itemSpec.stats[id], true, STAT_BOUNDS) === null) err('itemspec-stat-range-invalid', id);
    }
  }
  if (has(itemSpec, 'multipliers') && clean('multipliers') && !isObject(itemSpec.multipliers)) err('itemspec-invalid', 'multipliers');
  else if (has(itemSpec, 'multipliers') && clean('multipliers')) {
    if (!effectsAllowed) err('itemspec-effects-not-allowed', 'multipliers');
    for (const kind of Object.keys(itemSpec.multipliers).sort()) {
      if (!has(MULTIPLIER_KEYS, kind)) err('itemspec-multiplier-unknown', kind);
      else if (parseSpecRange(itemSpec.multipliers[kind], false, MULTIPLIER_BOUNDS) === null) err('itemspec-multiplier-range-invalid', kind);
    }
  }

  const declared = [];
  if (has(itemSpec, 'capabilities') && clean('capabilities')) {
    if (!Array.isArray(itemSpec.capabilities) || !itemSpec.capabilities.every(isString)) {
      err('itemspec-invalid', 'capabilities');
    } else {
      if (new Set(itemSpec.capabilities).size !== itemSpec.capabilities.length) err('itemspec-invalid', 'capabilities');
      for (const id of itemSpec.capabilities) {
        const vocab = has(CAPABILITIES, id) ? CAPABILITIES[id] : null;
        const foreignOk = !vocab && FOREIGN_CAP_RE.test(id) && !id.startsWith('atlas.')
          && (!isString(ctx.issuerDomain) || id.startsWith(reverseDomain(ctx.issuerDomain) + '.cap.'));
        if (!vocab && !foreignOk) { err('itemspec-capability-unknown', id); continue; }
        declared.push(id);
        if (vocab && rule && !vocab.categories.includes(category)) err('itemspec-capability-category-mismatch', id);
      }
    }
  }
  const params = has(itemSpec, 'capabilityParams') && clean('capabilityParams') && isObject(itemSpec.capabilityParams) ? itemSpec.capabilityParams : null;
  if (has(itemSpec, 'capabilityParams') && clean('capabilityParams') && !params) err('itemspec-invalid', 'capabilityParams');
  for (const id of declared) {
    const vocab = has(CAPABILITIES, id) ? CAPABILITIES[id] : null;
    const given = params && has(params, id) ? params[id] : null;
    if (vocab) {
      const names = Object.keys(vocab.params);
      if (!names.length) { if (given !== null) err('itemspec-capability-param-invalid', id); continue; }
      if (!isObject(given) || Object.keys(given).sort().join() !== names.slice().sort().join()) { err('itemspec-capability-param-invalid', id); continue; }
      for (const name of names) {
        const def = vocab.params[name];
        const ok = def.type === 'id'
          ? parseValuesSpec(given[name]) !== null
          : parseSpecRange(given[name], def.type === 'int', [def.min, def.max]) !== null;
        if (!ok) err('itemspec-capability-param-invalid', id + '.' + name);
      }
    } else if (given !== null) {
      if (!isObject(given)) { err('itemspec-capability-param-invalid', id); continue; }
      for (const name of Object.keys(given).sort()) {
        const ok = PARAM_RE.test(name) && (parseValuesSpec(given[name]) !== null || parseSpecRange(given[name], false, [-1000000, 1000000]) !== null);
        if (!ok) err('itemspec-capability-param-invalid', id + '.' + name);
      }
    }
  }
  if (params) for (const id of Object.keys(params).sort()) if (!declared.includes(id)) err('itemspec-capability-param-invalid', id);

  if (isString(ctx.classId)) {
    const cls = ctx.classId;
    if (ATLAS_CLASS_RE.test(cls)) {
      const parts = cls.split('.');
      if (rule && CATEGORY_FAMILIES[category] && !CATEGORY_FAMILIES[category].includes(parts[1])) err('itemspec-class-family-mismatch', cls);
      if (parts[1] === 'wearable' && parts.length >= 3 && has(SLOTS, parts[2]) && itemSpec.slot !== parts[2]) err('itemspec-class-slot-mismatch', cls);
    } else if (!FOREIGN_CLASS_RE.test(cls)) {
      err('itemspec-class-name-invalid', cls);
    }
  }
  return { ok: errors.length === 0, errors };
}

// True when an item claims the standard: its class has an itemSpec or its properties carry the marker.
function claimsStandard(properties, hasItemSpec) {
  return hasItemSpec === true || (isObject(properties) && has(properties, 'atlas.item.standard'));
}

function validModelRef(model) {
  return isString(model) && model.length <= 400 && (/^https?:\/\/[^\s]+$/i.test(model) || /^\/[^\s]*$/.test(model));
}

// Checks one item's final property bag against its class's itemSpec. ctx: { model } (the asset's model URL or
// the class's model path). Returns { applies, ok, errors: [{ code, key }] }; applies is false (and ok true)
// for an item outside the standard.
function validateItemProperties(itemSpec, properties, ctx) {
  ctx = ctx || {};
  const hasSpec = isObject(itemSpec);
  if (!claimsStandard(properties, hasSpec)) return { applies: false, ok: true, errors: [] };
  const errors = [];
  const err = (code, key) => errors.push({ code, key: key === undefined ? null : key });
  if (!hasSpec) { err('item-spec-missing', 'itemSpec'); return { applies: true, ok: false, errors }; }
  if (!isObject(properties)) { err('item-property-type', '*'); return { applies: true, ok: false, errors }; }

  const keys = Object.keys(properties);
  if (keys.length > LIMITS.properties) err('item-property-limit', '*');
  for (const key of keys) {
    const v = properties[key];
    if (key.length > LIMITS.key) { err('item-property-limit', key); continue; }
    if (key.startsWith('atlas.')) {
      if (key === 'atlas.item.capabilities') {
        if (!Array.isArray(v) || v.length > LIMITS.list || !v.every((x) => isString(x) && x.length <= LIMITS.listItem)) err('item-property-type', key);
      } else if (isString(v)) {
        if (v.length > LIMITS.string) err('item-property-limit', key);
      } else if (!(typeof v === 'number' && Number.isFinite(v)) && typeof v !== 'boolean') {
        err('item-property-type', key);
      }
    } else if (JSON.stringify(v === undefined ? null : v).length > LIMITS.foreign) {
      err('item-property-limit', key);
    }
  }

  const marker = properties['atlas.item.standard'];
  if (marker === undefined) err('item-marker-missing', 'atlas.item.standard');
  else if (marker !== STANDARD_VERSION) err('item-marker-invalid', 'atlas.item.standard');
  if (properties['atlas.item.category'] !== itemSpec.category) err('item-category-mismatch', 'atlas.item.category');

  const digest = properties['atlas.item.specDigest'];
  if (digest === undefined) err('item-spec-digest-missing', 'atlas.item.specDigest');
  else if (digest !== itemSpecDigest(itemSpec)) err('item-spec-digest-mismatch', 'atlas.item.specDigest');

  const slot = properties['atlas.avatar.slot'];
  const specSlot = has(itemSpec, 'slot') ? itemSpec.slot : null;
  if (slot === undefined ? specSlot !== null : slot !== specSlot) err('item-slot-mismatch', 'atlas.avatar.slot');
  const slotRule = specSlot !== null && has(SLOTS, specSlot) ? SLOTS[specSlot] : null;
  if (slotRule) {
    for (const key of slotRule.keys || []) if (!isString(properties[key]) || !COLOR_RE.test(properties[key])) err('item-color-invalid', key);
    if (slotRule.model && !validModelRef(ctx.model)) err('item-model-required', 'model');
  }
  for (const key of COLOR_KEYS) {
    if (has(properties, key) && !(slotRule && (slotRule.keys || []).includes(key)) && !(isString(properties[key]) && COLOR_RE.test(properties[key]))) err('item-color-invalid', key);
  }

  const specStats = isObject(itemSpec.stats) ? itemSpec.stats : {};
  for (const key of keys.sort()) {
    if (!key.startsWith('atlas.avatar.stat.')) continue;
    const id = key.slice('atlas.avatar.stat.'.length);
    if (!STAT_IDS.includes(id)) { err('item-stat-unknown', key); continue; }
    if (!has(specStats, id)) { err('item-stat-not-allowed', key); continue; }
    const n = parseNumber(properties[key], true);
    if (n === null) { err('item-stat-value-invalid', key); continue; }
    const range = parseSpecRange(specStats[id], true, STAT_BOUNDS);
    if (range && !inRange(n, range[0], range[1])) err('item-stat-out-of-range', key);
  }

  const specMultipliers = isObject(itemSpec.multipliers) ? itemSpec.multipliers : {};
  const aliases = (specSlot !== null && has(MULTIPLIER_ALIASES, specSlot)) ? MULTIPLIER_ALIASES[specSlot] : {};
  for (const key of keys.sort()) {
    let kind = null;
    for (const k of Object.keys(MULTIPLIER_KEYS)) if (MULTIPLIER_KEYS[k] === key) kind = k;
    const isAlias = kind === null && has(aliases, key);
    if (isAlias) kind = aliases[key];
    const looksLikeMultiplier = kind !== null || /^atlas\.avatar\.[a-z]+(Speed|Jump|InteractRange)Multiplier$/.test(key);
    if (!looksLikeMultiplier) continue;
    if (kind === null || !has(specMultipliers, kind)) { err('item-multiplier-not-allowed', key); continue; }
    const n = parseNumber(properties[key], false);
    if (n === null) { err('item-multiplier-value-invalid', key); continue; }
    const range = parseSpecRange(specMultipliers[kind], false, MULTIPLIER_BOUNDS);
    if (range && !inRange(n, range[0], range[1])) err('item-multiplier-out-of-range', key);
  }

  const specCaps = Array.isArray(itemSpec.capabilities) ? itemSpec.capabilities : [];
  const specParams = isObject(itemSpec.capabilityParams) ? itemSpec.capabilityParams : {};
  const declaredCaps = Array.isArray(properties['atlas.item.capabilities']) ? properties['atlas.item.capabilities'] : [];
  for (const id of declaredCaps) if (!isString(id) || !specCaps.includes(id)) err('item-capability-unauthorized', isString(id) ? id : 'atlas.item.capabilities');
  const capParamKeys = new Set();
  for (const id of declaredCaps) {
    if (!isString(id) || !specCaps.includes(id)) continue;
    const vocab = has(CAPABILITIES, id) ? CAPABILITIES[id] : null;
    const given = has(specParams, id) && isObject(specParams[id]) ? specParams[id] : {};
    for (const name of Object.keys(given).sort()) {
      const key = id + '.' + name;
      capParamKeys.add(key);
      const spec = given[name];
      const value = properties[key];
      let ok = false;
      if (value !== undefined) {
        if (parseValuesSpec(spec) !== null) {
          ok = isString(value) && spec.values.includes(value);
        } else {
          const intOnly = vocab !== null && vocab.params[name] && vocab.params[name].type === 'int';
          const n = parseNumber(value, intOnly);
          const range = isObject(spec) && isString(spec.min) && isString(spec.max) ? [Number(spec.min), Number(spec.max)] : null;
          ok = n !== null && range !== null && inRange(n, range[0], range[1]);
        }
      }
      if (!ok) err('item-capability-param-invalid', key);
    }
  }

  for (const key of keys.sort()) {
    if (key.startsWith('atlas.item.') && !ITEM_KEYS.includes(key.slice('atlas.item.'.length))) err('item-reserved-key', key);
    else if (key.startsWith('atlas.cap.') && !capParamKeys.has(key)) err('item-reserved-key', key);
    else if (key.startsWith('atlas.avatar.')) {
      const rest = key.slice('atlas.avatar.'.length);
      const known = AVATAR_KEYS.includes(rest) || rest.startsWith('stat.')
        || Object.values(MULTIPLIER_KEYS).includes(key) || has(MULTIPLIER_ALIASES.hat, key) || has(MULTIPLIER_ALIASES.shoes, key);
      if (!known) err('item-reserved-key', key);
    }
  }

  const isConsumable = itemSpec.category === 'consumable';
  const uses = properties['atlas.item.uses'];
  if (isConsumable) {
    const wanted = isString(itemSpec.uses) ? itemSpec.uses : '1';
    if (uses === undefined || String(uses) !== wanted) err('item-uses-invalid', 'atlas.item.uses');
  } else if (uses !== undefined) {
    err('item-uses-invalid', 'atlas.item.uses');
  }

  if (has(properties, 'atlas.rarity') && !RARITIES.includes(properties['atlas.rarity'])) err('item-rarity-invalid', 'atlas.rarity');

  return { applies: true, ok: errors.length === 0, errors };
}

// Lints a whole catalog ({ classId: entry }). Entries with an itemSpec are checked as definitions and as the
// property bag the issuer would sign (derived properties plus the entry's own, plus `rolls` runs of its
// randomizeProperties); entries without one are outside the standard and only checked for not using its
// reserved keys. Returns { checked, skipped, errors: [{ class, code, key }], legacy: { classId: [keys] } }.
function lintCatalog(catalog, opts) {
  opts = opts || {};
  const rolls = Number.isInteger(opts.rolls) ? opts.rolls : 25;
  const out = { checked: [], skipped: 0, errors: [], legacy: {} };
  for (const cls of Object.keys(catalog).sort()) {
    const entry = catalog[cls];
    const base = isObject(entry.properties) ? entry.properties : {};
    if (!has(entry, 'itemSpec')) {
      out.skipped += 1;
      for (const key of Object.keys(base).sort()) if (/^atlas\.(item|cap)\./.test(key)) out.errors.push({ class: cls, code: 'catalog-reserved-key-without-itemspec', key });
      const legacy = Object.keys(base).filter((k) => /^atlas\.avatar\./.test(k)).sort();
      if (legacy.length) out.legacy[cls] = legacy;
      continue;
    }
    out.checked.push(cls);
    const specResult = validateItemSpec(entry.itemSpec, { fungible: !!entry.fungible, presentation: entry.presentation, classId: cls });
    for (const e of specResult.errors) out.errors.push({ class: cls, code: e.code, key: e.key });
    if (!specResult.ok) continue;
    const model = entry.model !== undefined ? entry.model : entry.modelPath;
    const bags = [Object.assign({}, deriveItemProperties(entry.itemSpec), base)];
    if (typeof entry.randomizeProperties === 'function') {
      for (let i = 0; i < rolls; i++) bags.push(Object.assign({}, bags[0], entry.randomizeProperties()));
    }
    const seen = new Set();
    for (const bag of bags) {
      for (const e of validateItemProperties(entry.itemSpec, bag, { model }).errors) {
        const id = e.code + '@' + e.key;
        if (!seen.has(id)) { seen.add(id); out.errors.push({ class: cls, code: e.code, key: e.key }); }
      }
    }
  }
  return out;
}

module.exports = {
  STANDARD_VERSION, CATEGORIES, SLOTS, STAT_IDS, CAPABILITIES, RARITIES, LIMITS,
  canonical, itemSpecDigest, deriveItemProperties, validateItemSpec, validateItemProperties, claimsStandard,
  lintCatalog, uniqueCodes
};
