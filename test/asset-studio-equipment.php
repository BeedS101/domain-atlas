<?php
// Asset Studio equipment templates: necklace, gloves, shoulders, trinket and sword.
// Checks what a design may ask for (colour, stat points, always bound, never expiring), what the issuer signs from it,
// the approved models, and that the page's built-in table matches the issuer's.
require_once __DIR__ . '/studio-test-lib.php';
require_once __DIR__ . '/../issuer-php/atlas/studio/inc/issuance-plan.php';
require_once __DIR__ . '/../issuer-php/lib/item-standard.php';
$owner = studio_raw_key();
$mk = function ($template, $extra = []) {
  return $extra + ['schema' => 'atlas.asset-studio.design/0.1', 'template' => $template, 'name' => 'Piece', 'description' => 'A test piece.', 'finish' => 'gold'];
};

// The table itself: small budgets, stats the wallet knows, no Primary stat, nothing else equippable.
studio_check(array_keys(ATLAS_STUDIO_EQUIPMENT) === ['necklace', 'gloves', 'shoulders', 'trinket', 'sword'], 'five equipment templates');
foreach (ATLAS_STUDIO_EQUIPMENT as $t => $spec) {
  studio_check($spec['budget'] <= 8 && $spec['cap'] <= 4 && $spec['cap'] <= $spec['budget'], "$t has a small budget and cap");
  studio_check(count($spec['stats']) === count(array_unique($spec['stats'])), "$t lists each stat once");
  foreach ($spec['stats'] as $id) {
    studio_check(in_array($id, ATLAS_ITEM_STAT_IDS, true), "$t stat $id is a stat the wallet reads");
    studio_check(!in_array($id, ['health', 'mana', 'stamina'], true), "$t offers no Primary stat directly");
    studio_check(isset(ATLAS_STUDIO_STAT_LABELS[$id]), "$t stat $id has a label");
  }
  studio_check(in_array($spec['slot'], ['neck', 'gloves', 'shoulders', 'trinket', 'hand'], true), "$t is worn in a slot the wallet has");
}

// A valid design per template, and the digest covers colour and stats.
$necklace = $mk('necklace', ['color' => '#aa33cc', 'stats' => ['luck' => 2, 'focus' => 3]]);
$fp = atlas_studio_design_fingerprint($necklace);
studio_check($fp['ok'] && $fp['design']['stats'] === ['focus' => 3, 'luck' => 2] && $fp['design']['color'] === '#aa33cc', 'necklace design is accepted and its stats sorted');
foreach (['color' => '#aa33cd', 'stats' => ['luck' => 3, 'focus' => 2]] as $field => $value) {
  studio_check(atlas_studio_design_fingerprint(array_merge($necklace, [$field => $value]))['designDigest'] !== $fp['designDigest'], "digest covers $field");
}
studio_check(atlas_studio_design_fingerprint(array_merge($necklace, ['stats' => ['focus' => 3, 'luck' => 2]]))['designDigest'] === $fp['designDigest'], 'stat order does not change the digest');
studio_check(atlas_studio_design_fingerprint($mk('necklace', ['color' => '#aa33cc', 'stats' => []]))['designDigest'] === atlas_studio_design_fingerprint($mk('necklace', ['color' => '#aa33cc']))['designDigest'], 'empty stats normalise away');
foreach (['gloves', 'shoulders', 'trinket'] as $t) studio_check(atlas_studio_design_fingerprint($mk($t, ['color' => '#112233']))['ok'], "$t is accepted with a colour and no stats");
studio_check(atlas_studio_design_fingerprint($mk('sword', ['stats' => ['strength' => 4, 'agility' => 4]]))['ok'], 'a sword may spend its whole budget');

// What is refused.
$bad = [
  'invalid-color' => [$mk('necklace'), $mk('necklace', ['color' => '#AA33CC']), $mk('necklace', ['color' => 'purple']), $mk('necklace', ['color' => '#abc']), $mk('necklace', ['color' => 123]), $mk('necklace', ['color' => '#aa33cc00'])],
  'color-not-allowed' => [$mk('sword', ['color' => '#aa33cc'])],
  'invalid-stats' => [$mk('sword', ['stats' => 'x']), $mk('sword', ['stats' => [1, 2]])],
  'stat-not-offered' => [$mk('sword', ['stats' => ['luck' => 1]]), $mk('sword', ['stats' => ['health' => 1]]), $mk('sword', ['stats' => ['mana' => 1]]), $mk('sword', ['stats' => ['atlas' => 1]]), $mk('necklace', ['color' => '#112233', 'stats' => ['strength' => 1]])],
  'invalid-stat-points' => [$mk('sword', ['stats' => ['strength' => 5]]), $mk('sword', ['stats' => ['strength' => 0]]), $mk('sword', ['stats' => ['strength' => -1]]), $mk('sword', ['stats' => ['strength' => 1.5]]), $mk('sword', ['stats' => ['strength' => '2']]), $mk('sword', ['stats' => ['strength' => true]]), $mk('sword', ['stats' => ['strength' => null]])],
  'stat-budget-exceeded' => [$mk('sword', ['stats' => ['strength' => 4, 'agility' => 4, 'dexterity' => 1]]), $mk('necklace', ['color' => '#112233', 'stats' => ['luck' => 3, 'focus' => 3]])],
  'equipment-bound-only' => [$mk('sword', ['tradeScope' => 'local'])],
  'equipment-no-expiry' => [$mk('sword', ['expiresAt' => '2031-01-01T00:00:00Z'])],
  'option-not-allowed' => [$mk('trophy', ['color' => '#112233']), $mk('badge', ['stats' => ['luck' => 1]]), $mk('key', ['stats' => []])],
  'invalid-template' => [$mk('helmet')],
];
foreach ($bad as $error => $designs) foreach ($designs as $d) {
  $r = atlas_studio_validate_design($d);
  studio_check(!$r['ok'] && $r['error'] === $error, 'reject ' . json_encode($d) . ' as ' . $error . ' (got ' . ($r['error'] ?? 'ok') . ')');
}
studio_check(atlas_studio_validate_design($mk('sword', ['tradeScope' => 'bound']))['ok'], 'an explicit bound scope is fine');

// The plan: what is signed. Slot, colour and stats become the properties the wallet reads; a sword is a held item.
$plan = atlas_studio_issuance_plan($necklace, $owner);
studio_check($plan['ok'] && $plan['requiredTradeScope'] === 'bound' && $plan['expiresAt'] === null, 'equipment plans are bound and never expire');
studio_check($plan['properties']['atlas.avatar.slot'] === 'neck' && $plan['properties']['atlas.avatar.color'] === '#aa33cc', 'slot and colour are signed');
studio_check($plan['properties']['atlas.avatar.stat.luck'] === 2 && $plan['properties']['atlas.avatar.stat.focus'] === 3, 'stat points are signed as integers');
studio_check($plan['summary'] === 'Mint a free demo necklace (gold) named "Piece" for the neck slot in colour #aa33cc, with Focus +3, Luck +2. It has no value and is bound to this wallet: it cannot be transferred or traded.', 'the wallet prompt names the slot, colour and stats: ' . $plan['summary']);
$swordPlan = atlas_studio_issuance_plan($mk('sword', ['finish' => 'silver', 'stats' => ['strength' => 2]]), $owner);
studio_check($swordPlan['ok'] && $swordPlan['properties']['atlas.avatar.handItem'] === 'true' && !isset($swordPlan['properties']['atlas.avatar.slot']), 'a sword is signed as a held item');
studio_check($swordPlan['model']['modelPath'] === '/assets/studio/sword-silver.glb' && $swordPlan['model']['thumbnailPath'] === '/assets/studio/sword-silver.png', 'the sword model follows the finish');
foreach (['gloves' => 'gloves', 'shoulders' => 'shoulders', 'trinket' => 'trinket'] as $t => $slot) {
  $p = atlas_studio_issuance_plan($mk($t, ['color' => '#112233']), $owner);
  studio_check($p['ok'] && $p['properties']['atlas.avatar.slot'] === $slot, "$t signs the $slot slot");
}
// A plain design still plans exactly what it did before: no equipment properties.
$old = atlas_studio_issuance_plan(STUDIO_TEST_DESIGN, $owner);
studio_check($old['ok'] && !array_filter(array_keys($old['properties']), function ($k) { return strpos($k, 'atlas.avatar.') === 0; }), 'the original templates sign no avatar properties');

// Models: one per template, the sword one per finish; nothing outside the approved list.
foreach (['necklace', 'gloves', 'shoulders', 'trinket'] as $t) {
  $m = atlas_studio_model_for_template($t, 'gold');
  studio_check($m['modelPath'] === "/assets/studio/$t.glb" && $m['thumbnailPath'] === "/assets/studio/$t.png", "$t model");
}
studio_check(atlas_studio_model_for_template('sword', null) === null && atlas_studio_model_for_template('sword', '../x') === null, 'a sword with no valid finish has no model');
studio_check(atlas_studio_model_for_template('helmet', 'gold') === null, 'an unknown template has no model');
$docroot = sys_get_temp_dir() . '/studio-eq-docroot-' . bin2hex(random_bytes(4));
mkdir($docroot . '/assets/studio', 0777, true);
$src = __DIR__ . '/../demo-domain-a/assets/studio';
foreach (glob($src . '/*') as $f) copy($f, $docroot . '/assets/studio/' . basename($f));
foreach (['necklace', 'gloves', 'shoulders', 'trinket'] as $t) studio_check(atlas_studio_model_available($docroot, atlas_studio_model_for_template($t, 'gold')), "$t files are real glTF and PNG files");
foreach (['gold', 'silver', 'bronze'] as $f) studio_check(atlas_studio_model_available($docroot, atlas_studio_model_for_template('sword', $f)), "sword-$f files are real glTF and PNG files");
studio_check(!atlas_studio_model_available($docroot, ['modelPath' => '/assets/studio/sword.glb', 'thumbnailPath' => '/assets/studio/sword.png']), 'an unlisted file name is not approved');
foreach (glob($docroot . '/assets/studio/*') as $f) unlink($f);
rmdir($docroot . '/assets/studio'); rmdir($docroot . '/assets'); rmdir($docroot);

// The page's built-in table is the issuer's table.
$js = file_get_contents(__DIR__ . '/../issuer-php/atlas/studio/studio.js');
studio_check(preg_match('/let equipment=\{(.*?)\n\};/s', $js, $m) === 1, 'studio.js has its equipment table');
preg_match_all("/(\w+):\{slot:'(\w+)',color:(true|false),budget:(\d+),cap:(\d+),stats:\[([^\]]*)\]\}/", $m[1], $rows, PREG_SET_ORDER);
$fromJs = [];
foreach ($rows as $r) $fromJs[$r[1]] = ['slot' => $r[2], 'color' => $r[3] === 'true', 'budget' => (int) $r[4], 'cap' => (int) $r[5], 'stats' => array_map(function ($x) { return trim($x, " '"); }, explode(',', $r[6]))];
studio_check($fromJs === atlas_studio_equipment_options(), 'the page offers exactly the issuer\'s table');
echo "asset-studio-equipment: all checks passed\n";
