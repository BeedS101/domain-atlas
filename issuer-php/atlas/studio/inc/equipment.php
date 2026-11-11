<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
// Asset Studio equipment templates: a necklace, gloves, shoulders, a trinket, a ring, a sword and an off-hand shield that a visitor can mint
// and then equip in a world. Pure: this file only describes what a design may ask for and checks it. It does not
// sign, store or touch the clock.
//
// An equipment design is always bound to the owner's key and never expires. The creator picks a colour (for the
// templates that show one) and spends a fixed number of stat points; the issuer, not the page, owns the table
// below, so no design can carry more than the budget or a stat the template does not offer. The wallet already
// reads the signed properties this produces (atlas.avatar.slot, atlas.avatar.color, atlas.avatar.stat.<id>,
// atlas.avatar.handItem), so nothing in the wallet needs to change to equip these items.
require_once __DIR__ . '/../../../lib/store.php';

// slot: the wallet's equipment slot ('hand' is the held-item slot and is signed as atlas.avatar.handItem).
// color: whether the creator chooses a #rrggbb colour (signed as atlas.avatar.color). A piece without a colour
// (held items and the ring, which the wallet never recolours) has one model per finish instead (perFinish).
// budget: total stat points across all stats. cap: the most points on any one stat. stats: the stats on offer.
// One point is +1 to the stat. A Secondary stat point also adds 1% to a movement factor and 5 to a Primary
// resource, so the caps and budgets are small on purpose.
const ATLAS_STUDIO_EQUIPMENT = [
  'necklace'  => ['slot' => 'neck',      'color' => true,  'budget' => 5, 'cap' => 3, 'stats' => ['intelligence', 'focus', 'resistance', 'luck', 'charisma']],
  'gloves'    => ['slot' => 'gloves',    'color' => true,  'budget' => 5, 'cap' => 3, 'stats' => ['strength', 'agility', 'dexterity', 'attackSpeed', 'criticalStrike']],
  'shoulders' => ['slot' => 'shoulders', 'color' => true,  'budget' => 6, 'cap' => 3, 'stats' => ['strength', 'armor', 'defense', 'resistance']],
  'trinket'   => ['slot' => 'trinket',   'color' => true,  'budget' => 5, 'cap' => 3, 'stats' => ['agility', 'intelligence', 'strength', 'armor', 'defense', 'resistance', 'attackSpeed', 'criticalStrike', 'dexterity', 'focus', 'luck', 'charisma']],
  'sword'     => ['slot' => 'hand',      'color' => false, 'budget' => 8, 'cap' => 4, 'stats' => ['strength', 'agility', 'dexterity', 'attackSpeed', 'criticalStrike']],
  'ring'      => ['slot' => 'ring',      'color' => false, 'budget' => 4, 'cap' => 3, 'stats' => ['intelligence', 'dexterity', 'attackSpeed', 'criticalStrike', 'focus', 'luck', 'charisma']],
  'shield'    => ['slot' => 'offhand',   'color' => false, 'budget' => 7, 'cap' => 4, 'stats' => ['strength', 'armor', 'defense', 'resistance']],
];

const ATLAS_STUDIO_STAT_LABELS = [
  'agility' => 'Agility', 'intelligence' => 'Intelligence', 'strength' => 'Strength', 'armor' => 'Armor', 'defense' => 'Defense',
  'resistance' => 'Resistance', 'attackSpeed' => 'Attack Speed', 'criticalStrike' => 'Critical Strike', 'dexterity' => 'Dexterity',
  'focus' => 'Focus', 'luck' => 'Luck', 'charisma' => 'Charisma',
];

function atlas_studio_is_equipment($template) {
  return is_string($template) && isset(ATLAS_STUDIO_EQUIPMENT[$template]);
}

// Checks the equipment-only fields of a design whose common fields are already valid and adds them, in canonical
// order, to $design. Returns an error code or null.
function atlas_studio_validate_equipment($input, &$design) {
  $spec = ATLAS_STUDIO_EQUIPMENT[$design['template']];
  if (($design['tradeScope'] ?? 'bound') !== 'bound') return 'equipment-bound-only';
  if (isset($design['expiresAt'])) return 'equipment-no-expiry';
  if ($spec['color']) {
    $c = $input['color'] ?? null;
    if (!is_string($c) || !preg_match('/^#[0-9a-f]{6}$/D', $c)) return 'invalid-color';
    $design['color'] = $c;
  } elseif (array_key_exists('color', $input)) {
    return 'color-not-allowed';
  }
  if (array_key_exists('stats', $input)) {
    $stats = $input['stats'];
    if (!is_array($stats)) return 'invalid-stats';
    if ($stats !== []) {
      if (array_keys($stats) === range(0, count($stats) - 1)) return 'invalid-stats';
      $total = 0;
      $clean = [];
      foreach ($stats as $id => $points) {
        if (!is_string($id) || !in_array($id, $spec['stats'], true)) return 'stat-not-offered';
        if (!is_int($points) || $points < 1 || $points > $spec['cap']) return 'invalid-stat-points';
        $total += $points;
        $clean[$id] = $points;
      }
      if ($total > $spec['budget']) return 'stat-budget-exceeded';
      ksort($clean, SORT_STRING);
      $design['stats'] = $clean;
    }
  }
  return null;
}

// The properties an equipment design signs into the credential, beyond the fixed atlas.studio.* ones.
function atlas_studio_equipment_properties($design) {
  $spec = ATLAS_STUDIO_EQUIPMENT[$design['template']];
  $out = [];
  if ($spec['slot'] === 'hand') $out['atlas.avatar.handItem'] = 'true';
  else $out['atlas.avatar.slot'] = $spec['slot'];
  if (isset($design['color'])) $out['atlas.avatar.color'] = $design['color'];
  foreach ($design['stats'] ?? [] as $id => $points) $out['atlas.avatar.stat.' . $id] = $points;
  return $out;
}

// What the wallet prompt adds after the template and finish: where it is worn, its colour and its stats.
function atlas_studio_equipment_summary($design) {
  $spec = ATLAS_STUDIO_EQUIPMENT[$design['template']];
  $text = ' for the ' . ($spec['slot'] === 'offhand' ? 'off hand' : $spec['slot']) . ' slot';
  if (isset($design['color'])) $text .= ' in colour ' . $design['color'];
  if (!empty($design['stats'])) {
    $parts = [];
    foreach ($design['stats'] as $id => $points) $parts[] = ATLAS_STUDIO_STAT_LABELS[$id] . ' +' . $points;
    $text .= ', with ' . implode(', ', $parts);
  }
  return $text;
}

// What api.php?op=status tells the page, so it never offers more than the issuer accepts.
function atlas_studio_equipment_options() {
  $out = [];
  foreach (ATLAS_STUDIO_EQUIPMENT as $template => $spec) {
    $out[$template] = ['slot' => $spec['slot'], 'color' => $spec['color'], 'perFinish' => !$spec['color'], 'budget' => $spec['budget'], 'cap' => $spec['cap'], 'stats' => $spec['stats']];
  }
  return $out;
}
