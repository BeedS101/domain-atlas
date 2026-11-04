<?php
// Creator-chosen options on a Studio design: trade scope, expiry and labelled properties.
require_once __DIR__ . '/studio-test-lib.php';
require_once __DIR__ . '/../issuer-php/atlas/studio/inc/issuance-plan.php';
$base = STUDIO_TEST_DESIGN;
$owner = studio_raw_key();
$now = 1800000000;
$at = function ($secondsAhead) use ($now) { return gmdate('Y-m-d\TH:i:00\Z', $now + $secondsAhead); };
$opts = ['now' => $now, 'allowLocal' => true, 'expiryMin' => 3600, 'expiryMax' => 31536000];

// Designs without options keep the digest and summary they always had.
$plain = atlas_studio_design_fingerprint($base);
$explicit = atlas_studio_design_fingerprint($base + ['tradeScope' => 'bound', 'properties' => []]);
studio_check($plain['ok'] && $explicit['ok'] && $plain['designDigest'] === $explicit['designDigest'], 'explicit bound and empty properties normalise away');
studio_check(atlas_studio_summary($plain['design']) === 'Mint a free demo trophy (gold) named "First Light". It has no value and is bound to this wallet: it cannot be transferred or traded.', 'summary unchanged for a plain design');

// Options are validated, normalised and change the digest.
$full = $base + ['tradeScope' => 'local', 'expiresAt' => $at(86400 * 30 + 7 * 60), 'properties' => ['rarity' => ' epic ', 'edition' => '1 of 5']];
$fp = atlas_studio_design_fingerprint($full);
studio_check($fp['ok'], 'accept a full design');
studio_check($fp['design']['tradeScope'] === 'local' && $fp['design']['properties'] === ['edition' => '1 of 5', 'rarity' => 'epic'], 'normalised: scope kept, properties trimmed and sorted');
studio_check($fp['designDigest'] !== $plain['designDigest'], 'options are part of the digest');
foreach (['tradeScope', 'expiresAt', 'properties'] as $field) {
  $d = $full; unset($d[$field]);
  studio_check(atlas_studio_design_fingerprint($d)['designDigest'] !== $fp['designDigest'], "digest covers $field");
}
$swapped = $full; $swapped['properties'] = ['edition' => '1 of 5', 'rarity' => 'epic'];
studio_check(atlas_studio_design_fingerprint($swapped)['designDigest'] === $fp['designDigest'], 'property order does not change the digest');

$bad = [
  'invalid-trade-scope' => [['tradeScope' => 'global'], ['tradeScope' => 'LOCAL'], ['tradeScope' => null], ['tradeScope' => true]],
  'invalid-expiry' => [['expiresAt' => '2030-01-01'], ['expiresAt' => '2030-01-01T00:00:30Z'], ['expiresAt' => '2030-02-30T10:00:00Z'], ['expiresAt' => '2030-01-01T25:00:00Z'],
    ['expiresAt' => '2030-01-01T10:00:00+02:00'], ['expiresAt' => 1900000000], ['expiresAt' => null], ['expiresAt' => '']],
  'invalid-properties' => [['properties' => 'x'], ['properties' => ['a', 'b']], ['properties' => array_fill_keys(['a','b','c','d','e','f','g'], 'v')]],
  'invalid-property-key' => [['properties' => ['Rarity' => 'x']], ['properties' => ['1st' => 'x']], ['properties' => ['a b' => 'x']], ['properties' => ['atlas.studio.name' => 'x']], ['properties' => [str_repeat('a', 25) => 'x']], ['properties' => ['' => 'x']]],
  'invalid-property-value' => [['properties' => ['a' => '']], ['properties' => ['a' => '  ']], ['properties' => ['a' => 5]], ['properties' => ['a' => ['x']]], ['properties' => ['a' => str_repeat('x', 65)]], ['properties' => ['a' => "bad\x01"]], ['properties' => ['a' => "z\u{202E}x"]]],
  'inappropriate-property' => [['properties' => ['a' => 'Fuck this']]],
];
foreach ($bad as $error => $cases) foreach ($cases as $extra) {
  $r = atlas_studio_validate_design($base + $extra);
  studio_check(!$r['ok'] && $r['error'] === $error, 'reject ' . json_encode($extra) . ' as ' . $error . ' (got ' . ($r['error'] ?? 'ok') . ')');
}

// Plan: scope, expiry and properties land in the signed body; limits are the issuer's.
$plan = atlas_studio_issuance_plan($full, $owner, $opts);
studio_check($plan['ok'] && $plan['requiredTradeScope'] === 'local' && $plan['expiresAt'] === $full['expiresAt'], 'plan carries scope and expiry');
studio_check($plan['properties']['atlas.studio.custom.rarity'] === 'epic' && $plan['properties']['atlas.studio.custom.edition'] === '1 of 5', 'custom properties are namespaced');
studio_check(strpos($plan['summary'], 'rarity "epic"') !== false && strpos($plan['summary'], 'expires ' . $full['expiresAt']) !== false && strpos($plan['summary'], 'can be given to other wallets') !== false, 'summary shows what is signed');
studio_check(strpos(atlas_studio_summary($fp['design']), 'bound') === false, 'a giftable summary never claims to be bound');
$catalog = ['class' => ATLAS_STUDIO_CLASS, 'name' => 'Studio Demo Collectible', 'fungible' => false, 'tradeScope' => 'bound', 'properties' => ['atlas.demo.noValue' => 'true']];
$asset = atlas_studio_build_asset($catalog, $plan, 'a.test');
studio_check($asset['tradeScope'] === 'local' && $asset['expiresAt'] === $full['expiresAt'] && $asset['properties']['atlas.demo.noValue'] === 'true', 'asset body: scope, expiry, fixed property kept');
$plainAsset = atlas_studio_build_asset($catalog, atlas_studio_issuance_plan($base, $owner, $opts), 'a.test');
studio_check($plainAsset['tradeScope'] === 'bound' && !isset($plainAsset['expiresAt']), 'a plain design stays bound with no expiry');
$tampered = $plan; $tampered['requiredTradeScope'] = 'global';
studio_check(atlas_studio_build_asset($catalog, $tampered, 'a.test') === null, 'build refuses a scope the plan cannot carry');

// Limits: giftable off by default at the plan, expiry window inclusive at both ends.
studio_check(atlas_studio_issuance_plan($full, $owner, ['now' => $now])['error'] === 'giftable-not-allowed', 'giftable refused unless allowed');
studio_check(atlas_studio_issuance_plan($full, $owner, ['allowLocal' => false] + $opts)['error'] === 'giftable-not-allowed', 'giftable refused when switched off');
$bound = $base + ['tradeScope' => 'bound'];
studio_check(atlas_studio_issuance_plan($bound, $owner, ['allowLocal' => false] + $opts)['ok'], 'bound is always allowed');
$exp = function ($ahead, $extra = []) use ($base, $owner, $opts, $at) { return atlas_studio_issuance_plan($base + ['expiresAt' => $at($ahead)], $owner, $extra + $opts); };
studio_check($exp(3599)['error'] === 'expiry-too-soon', 'just under the minimum is refused');
studio_check($exp(-60)['error'] === 'expiry-too-soon', 'a past expiry is refused');
studio_check($exp(3600)['ok'], 'exactly the minimum is accepted');
studio_check($exp(31536000)['ok'], 'exactly the maximum is accepted');
studio_check($exp(31536000 + 60)['error'] === 'expiry-too-far', 'beyond the maximum is refused');
studio_check($exp(86400, ['expiryMax' => 7200])['error'] === 'expiry-too-far', 'a configured maximum applies');
studio_check($exp(600, ['expiryMin' => 300])['ok'], 'a configured minimum applies');
echo "Asset Studio custom option tests passed\n";
