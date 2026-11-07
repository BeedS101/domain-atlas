<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
// Domain Atlas Item Standard v0.1 validator (docs/item-standard-v0.1.md). Pure functions, no I/O, and nothing
// in the issuer requires this file yet. Mirrors issuer-server/item-standard.js rule for rule;
// docs/item-standard-v0.1.json holds the vectors both are tested against (test/item-standard.js), so the two
// cannot drift.
//
// Scope: only items that claim the standard are checked (a class with an 'itemSpec', or properties carrying
// 'atlas.item.standard'). Every other asset, including ones with numeric or nested properties, is outside it.
//
// Plain PHP 7.0 syntax on purpose: the issuer runs on shared hosting.

const ATLAS_ITEM_STANDARD_VERSION = '0.1';

// Category => what the class must be (null fungible = either).
const ATLAS_ITEM_CATEGORIES = [
  'equipment' => ['fungible' => false, 'presentation' => 'collectible'],
  'tool' => ['fungible' => false, 'presentation' => 'collectible'],
  'consumable' => ['fungible' => null, 'presentation' => 'collectible'],
  'material' => ['fungible' => true, 'presentation' => 'collectible'],
  'key' => ['fungible' => false, 'presentation' => 'collectible'],
  'credential' => ['fungible' => false, 'presentation' => 'document'],
  'collectible' => ['fungible' => false, 'presentation' => 'collectible'],
  'currency' => ['fungible' => true, 'presentation' => 'collectible'],
];

// Class families an atlas.* class may use per category (credential and collectible keep free-form families).
const ATLAS_ITEM_CATEGORY_FAMILIES = [
  'equipment' => ['wearable', 'avatar'], 'tool' => ['tool'], 'consumable' => ['consumable'],
  'material' => ['material', 'element'], 'key' => ['key'], 'currency' => ['currency', 'credit'],
];

// Slot kind => property keys an item needs in that slot; 'model' => true means an asset model is needed.
const ATLAS_ITEM_SLOTS = [
  'hat' => ['keys' => ['atlas.avatar.hatColor'], 'model' => false],
  'outfit' => ['keys' => ['atlas.avatar.shirtColor', 'atlas.avatar.pantsColor'], 'model' => false],
  'shoes' => ['keys' => ['atlas.avatar.shoeColor'], 'model' => false],
  'hand' => ['keys' => [], 'model' => true],
  'offhand' => ['keys' => [], 'model' => true],
  'gloves' => ['keys' => ['atlas.avatar.color'], 'model' => false],
  'legs' => ['keys' => ['atlas.avatar.color'], 'model' => false],
  'shoulders' => ['keys' => ['atlas.avatar.color'], 'model' => false],
  'neck' => ['keys' => ['atlas.avatar.color'], 'model' => false],
  'ring' => ['keys' => [], 'model' => false],
  'trinket' => ['keys' => [], 'model' => false],
];
const ATLAS_ITEM_TOOL_SLOTS = ['hand', 'offhand', 'trinket'];

const ATLAS_ITEM_STAT_IDS = ['health', 'mana', 'stamina', 'agility', 'strength', 'focus', 'dexterity', 'defense', 'luck', 'charisma'];
const ATLAS_ITEM_STAT_BOUNDS = [-100, 500];

const ATLAS_ITEM_MULTIPLIER_KEYS = [
  'speed' => 'atlas.avatar.speedMultiplier',
  'jump' => 'atlas.avatar.jumpMultiplier',
  'interactRange' => 'atlas.avatar.interactRangeMultiplier',
];
const ATLAS_ITEM_MULTIPLIER_ALIASES = [
  'hat' => ['atlas.avatar.hatSpeedMultiplier' => 'speed', 'atlas.avatar.hatJumpMultiplier' => 'jump', 'atlas.avatar.hatInteractRangeMultiplier' => 'interactRange'],
  'shoes' => ['atlas.avatar.shoeSpeedMultiplier' => 'speed', 'atlas.avatar.shoeJumpMultiplier' => 'jump'],
];
const ATLAS_ITEM_MULTIPLIER_BOUNDS = [0.25, 3];

// The v0.1 capability vocabulary. Parameter types: int and number are ranges, id is a list of allowed values.
const ATLAS_ITEM_CAPABILITIES = [
  'atlas.cap.compass' => ['categories' => ['tool', 'equipment'], 'params' => []],
  'atlas.cap.mine' => ['categories' => ['tool'], 'params' => ['tier' => ['type' => 'int', 'min' => 1, 'max' => 5]]],
  'atlas.cap.dig' => ['categories' => ['tool'], 'params' => ['tier' => ['type' => 'int', 'min' => 1, 'max' => 5]]],
  'atlas.cap.light' => ['categories' => ['tool', 'equipment'], 'params' => ['radius' => ['type' => 'number', 'min' => 1, 'max' => 20]]],
  'atlas.cap.blast' => ['categories' => ['consumable'], 'params' => ['radius' => ['type' => 'number', 'min' => 1, 'max' => 10]]],
  'atlas.cap.unlock' => ['categories' => ['key'], 'params' => ['lock' => ['type' => 'id']]],
];

const ATLAS_ITEM_SPEC_KEYS = ['category', 'slot', 'uses', 'stats', 'multipliers', 'capabilities', 'capabilityParams'];
const ATLAS_ITEM_ITEM_KEYS = ['standard', 'category', 'capabilities', 'uses', 'specDigest'];
const ATLAS_ITEM_AVATAR_KEYS = ['slot', 'color', 'shirtColor', 'pantsColor', 'hatColor', 'shoeColor', 'shoeVisualScale', 'handItem'];
const ATLAS_ITEM_COLOR_KEYS = ['atlas.avatar.color', 'atlas.avatar.shirtColor', 'atlas.avatar.pantsColor', 'atlas.avatar.hatColor', 'atlas.avatar.shoeColor'];
const ATLAS_ITEM_RARITIES = ['common', 'uncommon', 'rare', 'legendary'];

const ATLAS_ITEM_LIMIT_PROPERTIES = 32;
const ATLAS_ITEM_LIMIT_KEY = 64;
const ATLAS_ITEM_LIMIT_STRING = 256;
const ATLAS_ITEM_LIMIT_LIST = 16;
const ATLAS_ITEM_LIMIT_LIST_ITEM = 64;
const ATLAS_ITEM_LIMIT_FOREIGN = 1024;

const ATLAS_ITEM_INT_RE = '/^-?[0-9]{1,6}$/D';
const ATLAS_ITEM_DECIMAL_RE = '/^-?[0-9]{1,6}(\.[0-9]{1,6})?$/D';
const ATLAS_ITEM_ID_RE = '/^[a-z0-9][a-z0-9_-]{0,63}$/D';
const ATLAS_ITEM_PARAM_RE = '/^[a-z][a-z0-9_]{0,23}$/D';
const ATLAS_ITEM_COLOR_RE = '/^#[0-9a-fA-F]{6}$/D';
const ATLAS_ITEM_ATLAS_CLASS_RE = '/^atlas(\.[a-z][a-z0-9_]*){2,3}$/D';
const ATLAS_ITEM_FOREIGN_CLASS_RE = '/^(?!atlas\.)[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9_-]*){2,}$/D';
const ATLAS_ITEM_FOREIGN_CAP_RE = '/^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+\.cap\.[a-z][a-z0-9_]*$/D';
const ATLAS_ITEM_PRINTABLE_RE = '/^[\x20-\x7e]*$/D';

function atlas_item_is_list($v) {
  return is_array($v) && $v === array_values($v);
}
// A JSON object: a non-empty array that is not a list. (An empty array is neither; callers that care reject
// empties first.)
function atlas_item_is_object($v) {
  return is_array($v) && count($v) > 0 && !atlas_item_is_list($v);
}
function atlas_item_starts_with($s, $prefix) {
  return is_string($s) && strncmp($s, $prefix, strlen($prefix)) === 0;
}
function atlas_item_len($s) {
  return function_exists('mb_strlen') ? mb_strlen($s, 'UTF-8') : strlen($s);
}
function atlas_item_has($a, $k) {
  return is_array($a) && array_key_exists($k, $a);
}
function atlas_item_sorted($list) {
  $copy = array_values($list);
  sort($copy, SORT_STRING);
  return $copy;
}
function atlas_item_sorted_keys($a) {
  return atlas_item_sorted(array_map('strval', array_keys($a)));
}
function atlas_item_unique_codes($errors) {
  $codes = [];
  foreach ($errors as $e) $codes[$e['code']] = true;
  return atlas_item_sorted(array_keys($codes));
}

// A number from a decimal string or a finite JSON number (properties issued earlier may hold either); null
// when it is neither. $intOnly rejects fractions.
function atlas_item_parse_number($v, $intOnly) {
  if (is_string($v)) {
    if (!preg_match($intOnly ? ATLAS_ITEM_INT_RE : ATLAS_ITEM_DECIMAL_RE, $v)) return null;
    return (float) $v;
  }
  if (is_int($v)) return (float) $v;
  if (is_float($v) && is_finite($v)) {
    if ($intOnly && floor($v) !== $v) return null;
    return $v;
  }
  return null;
}

function atlas_item_in_range($n, $min, $max) {
  return $n >= $min - 1e-9 && $n <= $max + 1e-9;
}

// {min, max} of decimal strings => [min, max] numbers, or null when malformed, reversed or outside bounds.
function atlas_item_parse_spec_range($range, $intOnly, $bounds) {
  if (!atlas_item_is_object($range) || count($range) !== 2 || !isset($range['min'], $range['max'])) return null;
  if (!is_string($range['min']) || !is_string($range['max'])) return null;
  $min = atlas_item_parse_number($range['min'], $intOnly);
  $max = atlas_item_parse_number($range['max'], $intOnly);
  if ($min === null || $max === null || $min > $max) return null;
  if (!atlas_item_in_range($min, $bounds[0], $bounds[1]) || !atlas_item_in_range($max, $bounds[0], $bounds[1])) return null;
  return [$min, $max];
}

function atlas_item_parse_values_spec($spec) {
  if (!atlas_item_is_object($spec) || count($spec) !== 1 || !isset($spec['values']) || !atlas_item_is_list($spec['values'])) return null;
  $n = count($spec['values']);
  if ($n < 1 || $n > ATLAS_ITEM_LIMIT_LIST) return null;
  foreach ($spec['values'] as $v) if (!is_string($v) || !preg_match(ATLAS_ITEM_ID_RE, $v)) return null;
  return $spec['values'];
}

// Canonical JSON of an itemSpec (strings, lists and objects only): sorted keys, no whitespace.
function atlas_item_canonical($v) {
  if (is_array($v)) {
    if (count($v) === 0) return '{}';
    if (atlas_item_is_list($v)) return '[' . implode(',', array_map('atlas_item_canonical', $v)) . ']';
    $parts = [];
    foreach (atlas_item_sorted_keys($v) as $k) {
      $key = array_key_exists($k, $v) ? $k : (int) $k;
      $parts[] = json_encode((string) $k, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . ':' . atlas_item_canonical($v[$key]);
    }
    return '{' . implode(',', $parts) . '}';
  }
  return json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}

function atlas_item_spec_digest($itemSpec) {
  return hash('sha256', atlas_item_canonical($itemSpec));
}

// Walks one top-level itemSpec value: only printable-ASCII strings, lists and objects, nothing empty.
function atlas_item_spec_value_clean($v) {
  if (is_string($v)) return preg_match(ATLAS_ITEM_PRINTABLE_RE, $v) === 1;
  if (is_array($v)) {
    if (count($v) === 0) return false;
    if (atlas_item_is_list($v)) {
      foreach ($v as $x) if (!atlas_item_spec_value_clean($x)) return false;
      return true;
    }
    foreach ($v as $k => $x) {
      if (preg_match(ATLAS_ITEM_PRINTABLE_RE, (string) $k) !== 1 || !atlas_item_spec_value_clean($x)) return false;
    }
    return true;
  }
  return false;
}

// What the issuer signs for a class: the marker, the category and the slot, the capability list, the use
// count and the digest of the spec. Values the instance chooses (colours, stat rolls, capability parameters)
// come from the class's own properties.
function atlas_item_derive_properties($itemSpec) {
  $out = ['atlas.item.standard' => ATLAS_ITEM_STANDARD_VERSION, 'atlas.item.category' => $itemSpec['category']];
  if (!empty($itemSpec['slot'])) $out['atlas.avatar.slot'] = $itemSpec['slot'];
  if (isset($itemSpec['capabilities']) && is_array($itemSpec['capabilities'])) $out['atlas.item.capabilities'] = atlas_item_sorted($itemSpec['capabilities']);
  if ($itemSpec['category'] === 'consumable') $out['atlas.item.uses'] = (isset($itemSpec['uses']) && is_string($itemSpec['uses'])) ? $itemSpec['uses'] : '1';
  $out['atlas.item.specDigest'] = atlas_item_spec_digest($itemSpec);
  return $out;
}

function atlas_item_reverse_domain($domain) {
  $d = preg_replace('/:[0-9]+$/D', '', strtolower((string) $domain));
  return implode('.', array_reverse(explode('.', $d)));
}

function atlas_item_err(&$errors, $code, $key) {
  $errors[] = ['code' => $code, 'key' => $key];
}

// Checks a class definition. $ctx: fungible, presentation, classId, issuerDomain (each optional).
// Returns ['ok' => bool, 'errors' => [['code', 'key'], ...]].
function atlas_item_validate_spec($itemSpec, $ctx = []) {
  if (!is_array($ctx)) $ctx = [];
  $errors = [];
  if (!atlas_item_is_object($itemSpec)) {
    atlas_item_err($errors, 'itemspec-invalid', 'itemSpec');
    return ['ok' => false, 'errors' => $errors];
  }

  foreach (array_keys($itemSpec) as $key) {
    $key = (string) $key;
    if (!in_array($key, ATLAS_ITEM_SPEC_KEYS, true)) atlas_item_err($errors, 'itemspec-invalid', $key);
    elseif (!atlas_item_spec_value_clean($itemSpec[$key])) atlas_item_err($errors, 'itemspec-invalid', $key);
  }
  $clean = function ($key) use ($itemSpec) {
    return array_key_exists($key, $itemSpec) && atlas_item_spec_value_clean($itemSpec[$key]);
  };

  $category = isset($itemSpec['category']) ? $itemSpec['category'] : null;
  $rule = (is_string($category) && isset(ATLAS_ITEM_CATEGORIES[$category])) ? ATLAS_ITEM_CATEGORIES[$category] : null;
  if (!$rule) {
    atlas_item_err($errors, 'itemspec-category-invalid', 'category');
  } else {
    if ($rule['fungible'] !== null && isset($ctx['fungible']) && is_bool($ctx['fungible']) && $ctx['fungible'] !== $rule['fungible']) atlas_item_err($errors, 'itemspec-category-fungible-mismatch', 'category');
    if (isset($ctx['presentation']) && is_string($ctx['presentation']) && $ctx['presentation'] !== $rule['presentation']) atlas_item_err($errors, 'itemspec-presentation-mismatch', 'category');
  }

  if (array_key_exists('slot', $itemSpec)) {
    $slot = $itemSpec['slot'];
    if (!is_string($slot) || !isset(ATLAS_ITEM_SLOTS[$slot])) atlas_item_err($errors, 'itemspec-slot-invalid', 'slot');
    elseif ($category === 'equipment') { /* any slot */ }
    elseif (!($category === 'tool' && in_array($slot, ATLAS_ITEM_TOOL_SLOTS, true))) atlas_item_err($errors, 'itemspec-slot-not-allowed', 'slot');
  } elseif ($category === 'equipment') {
    atlas_item_err($errors, 'itemspec-slot-required', 'slot');
  }

  if (array_key_exists('uses', $itemSpec)) {
    $uses = (is_string($itemSpec['uses']) && preg_match(ATLAS_ITEM_INT_RE, $itemSpec['uses'])) ? (int) $itemSpec['uses'] : null;
    if ($category !== 'consumable' || $uses === null || $uses < 1 || $uses > 1000) atlas_item_err($errors, 'itemspec-uses-invalid', 'uses');
  }

  $effectsAllowed = (!$rule || $category === 'equipment' || $category === 'tool');
  if ($clean('stats') && !atlas_item_is_object($itemSpec['stats'])) {
    atlas_item_err($errors, 'itemspec-invalid', 'stats');
  } elseif ($clean('stats')) {
    if (!$effectsAllowed) atlas_item_err($errors, 'itemspec-effects-not-allowed', 'stats');
    foreach (atlas_item_sorted_keys($itemSpec['stats']) as $id) {
      if (!in_array($id, ATLAS_ITEM_STAT_IDS, true)) atlas_item_err($errors, 'itemspec-stat-unknown', $id);
      elseif (atlas_item_parse_spec_range($itemSpec['stats'][$id], true, ATLAS_ITEM_STAT_BOUNDS) === null) atlas_item_err($errors, 'itemspec-stat-range-invalid', $id);
    }
  }
  if ($clean('multipliers') && !atlas_item_is_object($itemSpec['multipliers'])) {
    atlas_item_err($errors, 'itemspec-invalid', 'multipliers');
  } elseif ($clean('multipliers')) {
    if (!$effectsAllowed) atlas_item_err($errors, 'itemspec-effects-not-allowed', 'multipliers');
    foreach (atlas_item_sorted_keys($itemSpec['multipliers']) as $kind) {
      if (!isset(ATLAS_ITEM_MULTIPLIER_KEYS[$kind])) atlas_item_err($errors, 'itemspec-multiplier-unknown', $kind);
      elseif (atlas_item_parse_spec_range($itemSpec['multipliers'][$kind], false, ATLAS_ITEM_MULTIPLIER_BOUNDS) === null) atlas_item_err($errors, 'itemspec-multiplier-range-invalid', $kind);
    }
  }

  $declared = [];
  if ($clean('capabilities')) {
    $caps = $itemSpec['capabilities'];
    $allStrings = atlas_item_is_list($caps);
    if ($allStrings) foreach ($caps as $c) if (!is_string($c)) $allStrings = false;
    if (!$allStrings) {
      atlas_item_err($errors, 'itemspec-invalid', 'capabilities');
    } else {
      if (count(array_unique($caps)) !== count($caps)) atlas_item_err($errors, 'itemspec-invalid', 'capabilities');
      foreach ($caps as $id) {
        $vocab = isset(ATLAS_ITEM_CAPABILITIES[$id]) ? ATLAS_ITEM_CAPABILITIES[$id] : null;
        $foreignOk = !$vocab && preg_match(ATLAS_ITEM_FOREIGN_CAP_RE, $id) && !atlas_item_starts_with($id, 'atlas.')
          && (!isset($ctx['issuerDomain']) || !is_string($ctx['issuerDomain']) || atlas_item_starts_with($id, atlas_item_reverse_domain($ctx['issuerDomain']) . '.cap.'));
        if (!$vocab && !$foreignOk) { atlas_item_err($errors, 'itemspec-capability-unknown', $id); continue; }
        $declared[] = $id;
        if ($vocab && $rule && !in_array($category, $vocab['categories'], true)) atlas_item_err($errors, 'itemspec-capability-category-mismatch', $id);
      }
    }
  }
  $params = null;
  if ($clean('capabilityParams')) {
    if (atlas_item_is_object($itemSpec['capabilityParams'])) $params = $itemSpec['capabilityParams'];
    else atlas_item_err($errors, 'itemspec-invalid', 'capabilityParams');
  }
  foreach ($declared as $id) {
    $vocab = isset(ATLAS_ITEM_CAPABILITIES[$id]) ? ATLAS_ITEM_CAPABILITIES[$id] : null;
    $given = ($params !== null && array_key_exists($id, $params)) ? $params[$id] : null;
    if ($vocab) {
      $names = array_keys($vocab['params']);
      if (!count($names)) {
        if ($given !== null) atlas_item_err($errors, 'itemspec-capability-param-invalid', $id);
        continue;
      }
      if (!atlas_item_is_object($given) || atlas_item_sorted_keys($given) !== atlas_item_sorted($names)) {
        atlas_item_err($errors, 'itemspec-capability-param-invalid', $id);
        continue;
      }
      foreach ($names as $name) {
        $def = $vocab['params'][$name];
        if ($def['type'] === 'id') $ok = atlas_item_parse_values_spec($given[$name]) !== null;
        else $ok = atlas_item_parse_spec_range($given[$name], $def['type'] === 'int', [$def['min'], $def['max']]) !== null;
        if (!$ok) atlas_item_err($errors, 'itemspec-capability-param-invalid', $id . '.' . $name);
      }
    } elseif ($given !== null) {
      if (!atlas_item_is_object($given)) { atlas_item_err($errors, 'itemspec-capability-param-invalid', $id); continue; }
      foreach (atlas_item_sorted_keys($given) as $name) {
        $ok = preg_match(ATLAS_ITEM_PARAM_RE, $name)
          && (atlas_item_parse_values_spec($given[$name]) !== null || atlas_item_parse_spec_range($given[$name], false, [-1000000, 1000000]) !== null);
        if (!$ok) atlas_item_err($errors, 'itemspec-capability-param-invalid', $id . '.' . $name);
      }
    }
  }
  if ($params !== null) {
    foreach (atlas_item_sorted_keys($params) as $id) {
      if (!in_array($id, $declared, true)) atlas_item_err($errors, 'itemspec-capability-param-invalid', $id);
    }
  }

  if (isset($ctx['classId']) && is_string($ctx['classId'])) {
    $cls = $ctx['classId'];
    if (preg_match(ATLAS_ITEM_ATLAS_CLASS_RE, $cls)) {
      $parts = explode('.', $cls);
      if ($rule && isset(ATLAS_ITEM_CATEGORY_FAMILIES[$category]) && !in_array($parts[1], ATLAS_ITEM_CATEGORY_FAMILIES[$category], true)) atlas_item_err($errors, 'itemspec-class-family-mismatch', $cls);
      if ($parts[1] === 'wearable' && count($parts) >= 3 && isset(ATLAS_ITEM_SLOTS[$parts[2]]) && (!isset($itemSpec['slot']) || $itemSpec['slot'] !== $parts[2])) atlas_item_err($errors, 'itemspec-class-slot-mismatch', $cls);
    } elseif (!preg_match(ATLAS_ITEM_FOREIGN_CLASS_RE, $cls)) {
      atlas_item_err($errors, 'itemspec-class-name-invalid', $cls);
    }
  }
  return ['ok' => count($errors) === 0, 'errors' => $errors];
}

// True when an item claims the standard: its class has an itemSpec or its properties carry the marker.
function atlas_item_claims_standard($properties, $hasItemSpec) {
  return $hasItemSpec === true || (is_array($properties) && array_key_exists('atlas.item.standard', $properties));
}

function atlas_item_valid_model_ref($model) {
  return is_string($model) && strlen($model) <= 400 && (preg_match('/^https?:\/\/[^\s]+$/iD', $model) || preg_match('/^\/[^\s]*$/D', $model));
}

// Checks one item's final property bag against its class's itemSpec. $ctx: model (the asset's model URL or the
// class's model path). Returns ['applies', 'ok', 'errors']; applies is false (and ok true) for an item outside
// the standard.
function atlas_item_validate_properties($itemSpec, $properties, $ctx = []) {
  if (!is_array($ctx)) $ctx = [];
  $hasSpec = atlas_item_is_object($itemSpec);
  if (!atlas_item_claims_standard($properties, $hasSpec)) return ['applies' => false, 'ok' => true, 'errors' => []];
  $errors = [];
  if (!$hasSpec) {
    atlas_item_err($errors, 'item-spec-missing', 'itemSpec');
    return ['applies' => true, 'ok' => false, 'errors' => $errors];
  }
  if (!is_array($properties)) {
    atlas_item_err($errors, 'item-property-type', '*');
    return ['applies' => true, 'ok' => false, 'errors' => $errors];
  }

  $keys = array_map('strval', array_keys($properties));
  if (count($keys) > ATLAS_ITEM_LIMIT_PROPERTIES) atlas_item_err($errors, 'item-property-limit', '*');
  foreach ($keys as $key) {
    $v = $properties[$key];
    if (atlas_item_len($key) > ATLAS_ITEM_LIMIT_KEY) { atlas_item_err($errors, 'item-property-limit', $key); continue; }
    if (atlas_item_starts_with($key, 'atlas.')) {
      if ($key === 'atlas.item.capabilities') {
        $ok = atlas_item_is_list($v) && count($v) <= ATLAS_ITEM_LIMIT_LIST;
        if ($ok) foreach ($v as $x) if (!is_string($x) || atlas_item_len($x) > ATLAS_ITEM_LIMIT_LIST_ITEM) $ok = false;
        if (!$ok) atlas_item_err($errors, 'item-property-type', $key);
      } elseif (is_string($v)) {
        if (atlas_item_len($v) > ATLAS_ITEM_LIMIT_STRING) atlas_item_err($errors, 'item-property-limit', $key);
      } elseif (!(is_int($v) || (is_float($v) && is_finite($v)) || is_bool($v))) {
        atlas_item_err($errors, 'item-property-type', $key);
      }
    } elseif (strlen((string) json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)) > ATLAS_ITEM_LIMIT_FOREIGN) {
      atlas_item_err($errors, 'item-property-limit', $key);
    }
  }

  if (!array_key_exists('atlas.item.standard', $properties)) atlas_item_err($errors, 'item-marker-missing', 'atlas.item.standard');
  elseif ($properties['atlas.item.standard'] !== ATLAS_ITEM_STANDARD_VERSION) atlas_item_err($errors, 'item-marker-invalid', 'atlas.item.standard');
  if (!array_key_exists('atlas.item.category', $properties) || $properties['atlas.item.category'] !== $itemSpec['category']) atlas_item_err($errors, 'item-category-mismatch', 'atlas.item.category');

  if (!array_key_exists('atlas.item.specDigest', $properties)) atlas_item_err($errors, 'item-spec-digest-missing', 'atlas.item.specDigest');
  elseif ($properties['atlas.item.specDigest'] !== atlas_item_spec_digest($itemSpec)) atlas_item_err($errors, 'item-spec-digest-mismatch', 'atlas.item.specDigest');

  $specSlot = array_key_exists('slot', $itemSpec) ? $itemSpec['slot'] : null;
  if (!array_key_exists('atlas.avatar.slot', $properties)) {
    if ($specSlot !== null) atlas_item_err($errors, 'item-slot-mismatch', 'atlas.avatar.slot');
  } elseif ($properties['atlas.avatar.slot'] !== $specSlot) {
    atlas_item_err($errors, 'item-slot-mismatch', 'atlas.avatar.slot');
  }
  $slotRule = ($specSlot !== null && is_string($specSlot) && isset(ATLAS_ITEM_SLOTS[$specSlot])) ? ATLAS_ITEM_SLOTS[$specSlot] : null;
  if ($slotRule) {
    foreach ($slotRule['keys'] as $key) {
      if (!isset($properties[$key]) || !is_string($properties[$key]) || !preg_match(ATLAS_ITEM_COLOR_RE, $properties[$key])) atlas_item_err($errors, 'item-color-invalid', $key);
    }
    if ($slotRule['model'] && !atlas_item_valid_model_ref(isset($ctx['model']) ? $ctx['model'] : null)) atlas_item_err($errors, 'item-model-required', 'model');
  }
  foreach (ATLAS_ITEM_COLOR_KEYS as $key) {
    if (!array_key_exists($key, $properties)) continue;
    if ($slotRule && in_array($key, $slotRule['keys'], true)) continue;
    if (!(is_string($properties[$key]) && preg_match(ATLAS_ITEM_COLOR_RE, $properties[$key]))) atlas_item_err($errors, 'item-color-invalid', $key);
  }

  $sortedKeys = atlas_item_sorted($keys);
  $specStats = (isset($itemSpec['stats']) && atlas_item_is_object($itemSpec['stats'])) ? $itemSpec['stats'] : [];
  foreach ($sortedKeys as $key) {
    if (!atlas_item_starts_with($key, 'atlas.avatar.stat.')) continue;
    $id = substr($key, strlen('atlas.avatar.stat.'));
    if (!in_array($id, ATLAS_ITEM_STAT_IDS, true)) { atlas_item_err($errors, 'item-stat-unknown', $key); continue; }
    if (!array_key_exists($id, $specStats)) { atlas_item_err($errors, 'item-stat-not-allowed', $key); continue; }
    $n = atlas_item_parse_number($properties[$key], true);
    if ($n === null) { atlas_item_err($errors, 'item-stat-value-invalid', $key); continue; }
    $range = atlas_item_parse_spec_range($specStats[$id], true, ATLAS_ITEM_STAT_BOUNDS);
    if ($range && !atlas_item_in_range($n, $range[0], $range[1])) atlas_item_err($errors, 'item-stat-out-of-range', $key);
  }

  $specMultipliers = (isset($itemSpec['multipliers']) && atlas_item_is_object($itemSpec['multipliers'])) ? $itemSpec['multipliers'] : [];
  $aliases = ($specSlot !== null && is_string($specSlot) && isset(ATLAS_ITEM_MULTIPLIER_ALIASES[$specSlot])) ? ATLAS_ITEM_MULTIPLIER_ALIASES[$specSlot] : [];
  foreach ($sortedKeys as $key) {
    $kind = null;
    foreach (ATLAS_ITEM_MULTIPLIER_KEYS as $k => $full) if ($full === $key) $kind = $k;
    if ($kind === null && array_key_exists($key, $aliases)) $kind = $aliases[$key];
    $looks = $kind !== null || preg_match('/^atlas\.avatar\.[a-z]+(Speed|Jump|InteractRange)Multiplier$/D', $key);
    if (!$looks) continue;
    if ($kind === null || !array_key_exists($kind, $specMultipliers)) { atlas_item_err($errors, 'item-multiplier-not-allowed', $key); continue; }
    $n = atlas_item_parse_number($properties[$key], false);
    if ($n === null) { atlas_item_err($errors, 'item-multiplier-value-invalid', $key); continue; }
    $range = atlas_item_parse_spec_range($specMultipliers[$kind], false, ATLAS_ITEM_MULTIPLIER_BOUNDS);
    if ($range && !atlas_item_in_range($n, $range[0], $range[1])) atlas_item_err($errors, 'item-multiplier-out-of-range', $key);
  }

  $specCaps = (isset($itemSpec['capabilities']) && is_array($itemSpec['capabilities'])) ? $itemSpec['capabilities'] : [];
  $specParams = (isset($itemSpec['capabilityParams']) && atlas_item_is_object($itemSpec['capabilityParams'])) ? $itemSpec['capabilityParams'] : [];
  $declaredCaps = (isset($properties['atlas.item.capabilities']) && atlas_item_is_list($properties['atlas.item.capabilities'])) ? $properties['atlas.item.capabilities'] : [];
  foreach ($declaredCaps as $id) {
    if (!is_string($id) || !in_array($id, $specCaps, true)) atlas_item_err($errors, 'item-capability-unauthorized', is_string($id) ? $id : 'atlas.item.capabilities');
  }
  $capParamKeys = [];
  foreach ($declaredCaps as $id) {
    if (!is_string($id) || !in_array($id, $specCaps, true)) continue;
    $vocab = isset(ATLAS_ITEM_CAPABILITIES[$id]) ? ATLAS_ITEM_CAPABILITIES[$id] : null;
    $given = (array_key_exists($id, $specParams) && atlas_item_is_object($specParams[$id])) ? $specParams[$id] : [];
    foreach (atlas_item_sorted_keys($given) as $name) {
      $key = $id . '.' . $name;
      $capParamKeys[$key] = true;
      $spec = $given[$name];
      $ok = false;
      if (array_key_exists($key, $properties)) {
        $value = $properties[$key];
        if (atlas_item_parse_values_spec($spec) !== null) {
          $ok = is_string($value) && in_array($value, $spec['values'], true);
        } else {
          $intOnly = $vocab !== null && isset($vocab['params'][$name]) && $vocab['params'][$name]['type'] === 'int';
          $n = atlas_item_parse_number($value, $intOnly);
          $range = (atlas_item_is_object($spec) && isset($spec['min'], $spec['max']) && is_string($spec['min']) && is_string($spec['max'])) ? [(float) $spec['min'], (float) $spec['max']] : null;
          $ok = $n !== null && $range !== null && atlas_item_in_range($n, $range[0], $range[1]);
        }
      }
      if (!$ok) atlas_item_err($errors, 'item-capability-param-invalid', $key);
    }
  }

  foreach ($sortedKeys as $key) {
    if (atlas_item_starts_with($key, 'atlas.item.')) {
      if (!in_array(substr($key, strlen('atlas.item.')), ATLAS_ITEM_ITEM_KEYS, true)) atlas_item_err($errors, 'item-reserved-key', $key);
    } elseif (atlas_item_starts_with($key, 'atlas.cap.')) {
      if (!isset($capParamKeys[$key])) atlas_item_err($errors, 'item-reserved-key', $key);
    } elseif (atlas_item_starts_with($key, 'atlas.avatar.')) {
      $rest = substr($key, strlen('atlas.avatar.'));
      $known = in_array($rest, ATLAS_ITEM_AVATAR_KEYS, true) || atlas_item_starts_with($rest, 'stat.')
        || in_array($key, ATLAS_ITEM_MULTIPLIER_KEYS, true)
        || array_key_exists($key, ATLAS_ITEM_MULTIPLIER_ALIASES['hat']) || array_key_exists($key, ATLAS_ITEM_MULTIPLIER_ALIASES['shoes']);
      if (!$known) atlas_item_err($errors, 'item-reserved-key', $key);
    }
  }

  $uses = array_key_exists('atlas.item.uses', $properties) ? $properties['atlas.item.uses'] : null;
  if ($itemSpec['category'] === 'consumable') {
    $wanted = (isset($itemSpec['uses']) && is_string($itemSpec['uses'])) ? $itemSpec['uses'] : '1';
    if (!array_key_exists('atlas.item.uses', $properties) || !is_scalar($uses) || (string) $uses !== $wanted) atlas_item_err($errors, 'item-uses-invalid', 'atlas.item.uses');
  } elseif (array_key_exists('atlas.item.uses', $properties)) {
    atlas_item_err($errors, 'item-uses-invalid', 'atlas.item.uses');
  }

  if (array_key_exists('atlas.rarity', $properties) && !in_array($properties['atlas.rarity'], ATLAS_ITEM_RARITIES, true)) atlas_item_err($errors, 'item-rarity-invalid', 'atlas.rarity');

  return ['applies' => true, 'ok' => count($errors) === 0, 'errors' => $errors];
}

// Lints a whole catalog (['classId' => entry]). Entries with an itemSpec are checked as definitions and as the
// property bag the issuer would sign (derived properties plus the entry's own, plus $rolls runs of its
// randomizeProperties); entries without one are outside the standard and only checked for not using its
// reserved keys. Returns ['checked', 'skipped', 'errors' => [['class', 'code', 'key']], 'legacy' => [class => keys]].
function atlas_item_lint_catalog($catalog, $rolls = 25) {
  $out = ['checked' => [], 'skipped' => 0, 'errors' => [], 'legacy' => []];
  foreach (atlas_item_sorted_keys($catalog) as $cls) {
    $entry = $catalog[$cls];
    $base = (isset($entry['properties']) && is_array($entry['properties'])) ? $entry['properties'] : [];
    if (!array_key_exists('itemSpec', $entry)) {
      $out['skipped'] += 1;
      foreach (atlas_item_sorted_keys($base) as $key) {
        if (preg_match('/^atlas\.(item|cap)\./D', $key)) $out['errors'][] = ['class' => $cls, 'code' => 'catalog-reserved-key-without-itemspec', 'key' => $key];
      }
      $legacy = [];
      foreach (atlas_item_sorted_keys($base) as $key) if (atlas_item_starts_with($key, 'atlas.avatar.')) $legacy[] = $key;
      if (count($legacy)) $out['legacy'][$cls] = $legacy;
      continue;
    }
    $out['checked'][] = $cls;
    $specResult = atlas_item_validate_spec($entry['itemSpec'], [
      'fungible' => !empty($entry['fungible']),
      'presentation' => isset($entry['presentation']) ? $entry['presentation'] : null,
      'classId' => $cls,
    ]);
    foreach ($specResult['errors'] as $e) $out['errors'][] = ['class' => $cls, 'code' => $e['code'], 'key' => $e['key']];
    if (!$specResult['ok']) continue;
    $model = isset($entry['model']) ? $entry['model'] : (isset($entry['modelPath']) ? $entry['modelPath'] : null);
    $first = array_merge(atlas_item_derive_properties($entry['itemSpec']), $base);
    $bags = [$first];
    if (isset($entry['randomizeProperties']) && is_callable($entry['randomizeProperties'])) {
      for ($i = 0; $i < $rolls; $i++) $bags[] = array_merge($first, call_user_func($entry['randomizeProperties']));
    }
    $seen = [];
    foreach ($bags as $bag) {
      $result = atlas_item_validate_properties($entry['itemSpec'], $bag, ['model' => $model]);
      foreach ($result['errors'] as $e) {
        $id = $e['code'] . '@' . $e['key'];
        if (!isset($seen[$id])) {
          $seen[$id] = true;
          $out['errors'][] = ['class' => $cls, 'code' => $e['code'], 'key' => $e['key']];
        }
      }
    }
  }
  return $out;
}
