<?php
// Rate-limit actors, group limits, per-actor quota share and counter pruning, with injected time.
require_once __DIR__ . '/studio-test-lib.php';
require_once __DIR__ . '/../issuer-php/atlas/studio/inc/storage.php';
require_once __DIR__ . '/../issuer-php/atlas/studio/inc/mint-attempts.php';
$root = studio_tmp_root();
$now = time();

// Actors
$a = atlas_studio_actor('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
studio_check($a['key'] === atlas_studio_actor('2001:db8:1:2::1')['key'], 'addresses inside one /64 are one actor');
studio_check($a['key'] !== atlas_studio_actor('2001:db8:1:3::1')['key'], 'different /64s are different actors');
studio_check($a['group'] === atlas_studio_actor('2001:db8:1:ffff::9')['group'] && $a['group'] !== atlas_studio_actor('2001:db8:2::1')['group'], 'the /48 is the group');
studio_check(atlas_studio_actor('2001:0db8:0001:0002:0:0:0:1')['key'] === atlas_studio_actor('2001:db8:1:2::1')['key'], 'spelling does not matter');
$v4 = atlas_studio_actor('203.0.113.7');
studio_check($v4['key'] === 'ip4:203.0.113.7' && $v4['group'] === null, 'IPv4 is the address');
studio_check(atlas_studio_actor('::ffff:203.0.113.7')['key'] === $v4['key'], 'IPv4-mapped IPv6 is the IPv4 actor');
foreach ([null, '', 'not an ip', 5, ['x'], '1.2.3.4.5'] as $bad) studio_check(atlas_studio_actor($bad)['key'] === 'unknown', 'unparseable is one shared bucket');

// Rotating /64s inside one /48 is held by the group limit; IPv4 uses the plain limit.
$ok = 0;
for ($i = 0; $i < 40; $i++) if (atlas_studio_rate_check($root, 'challenge', atlas_studio_actor(sprintf('2001:db8:9:%x::1', $i)), 2, 3600, $now)) $ok++;
studio_check($ok === 2 * ATLAS_STUDIO_RATE_GROUP_FACTOR, "group limit caps rotation across /64s (got $ok)");
studio_check(atlas_studio_rate_check($root, 'challenge', atlas_studio_actor('2001:db8:7::1'), 2, 3600, $now), 'another /48 is unaffected');
$ok = 0;
for ($i = 0; $i < 5; $i++) if (atlas_studio_rate_check($root, 'challenge', $v4, 2, 3600, $now)) $ok++;
studio_check($ok === 2, 'IPv4 actor limit');
studio_check(atlas_studio_rate_check($root, 'challenge', $v4, 2, 3600, $now + 3601), 'the window slides');

// Per-actor share of the daily quota
$limits = ['perRecipient' => 50, 'perActor' => 2, 'global' => 4, 'windowSeconds' => 86400];
$n = function ($i) { return str_pad(dechex($i), 64, '0', STR_PAD_LEFT); };
$d = str_repeat('d', 64);
studio_check(atlas_studio_claim_attempt($root, $n(1), $d, studio_raw_key(), $limits, $now, 'ip4:1.1.1.1')['ok'], 'actor 1 first');
studio_check(atlas_studio_claim_attempt($root, $n(2), $d, studio_raw_key(), $limits, $now, 'ip4:1.1.1.1')['ok'], 'actor 1 second');
$r = atlas_studio_claim_attempt($root, $n(3), $d, studio_raw_key(), $limits, $now, 'ip4:1.1.1.1');
studio_check(!$r['ok'] && $r['error'] === 'quota-actor', 'actor 1 is out of its share');
studio_check(atlas_studio_claim_attempt($root, $n(4), $d, studio_raw_key(), $limits, $now, 'ip4:2.2.2.2')['ok'], 'actor 2 still has global room');
studio_check(atlas_studio_claim_attempt($root, $n(1), $d, json_decode(file_get_contents(atlas_studio_storage_bucket($root, 'mint-receipts') . '/attempt-' . $n(1) . '.json'), true)['recipient'], $limits, $now, 'ip4:1.1.1.1')['existing'], 'a retry is not charged again');
foreach (glob(atlas_studio_storage_bucket($root, 'mint-receipts') . '/attempt-*.json') as $f) studio_check(strpos(file_get_contents($f), '1.1.1.1') === false, 'ledger never stores the address');

// Counter table: a deliberately tiny table (one slot) in a child process, so every key collides.
function slot_php($body) {
  $code = 'define("ATLAS_STUDIO_RATE_SLOTS", 1); require ' . var_export(__DIR__ . '/../issuer-php/atlas/studio/inc/storage.php', true) . '; ' . $body;
  return trim((string) shell_exec(escapeshellarg(PHP_BINARY) . ' -r ' . escapeshellarg($code)));
}
$root2 = studio_tmp_root();
$r = var_export($root2, true);
$dir = atlas_studio_storage_bucket($root2, 'rate');
// Expired counters are dropped when their slot is next written, with no separate cleanup pass.
slot_php("for (\$i = 0; \$i < 5; \$i++) atlas_studio_rate_hit($r, \"old\$i\", 5, 10, $now);");
$doc = json_decode(file_get_contents($dir . '/rate-slot-0000.json'), true);
studio_check(count($doc['e']) === 5, 'five live counters share the slot');
slot_php("atlas_studio_rate_hit($r, 'fresh', 5, 10, " . ($now + 11) . ");");
$doc = json_decode(file_get_contents($dir . '/rate-slot-0000.json'), true);
studio_check(count($doc['e']) === 1, 'the expired ones are gone after the next write (' . count($doc['e']) . ' left)');
studio_check(slot_php("echo atlas_studio_rate_hit($r, 'old0', 1, 10, " . ($now + 11) . ") ? 'yes' : 'no';") === 'yes', 'an expired counter starts over');

// A slot holds at most ATLAS_STUDIO_RATE_SLOT_ENTRIES counters. A new key takes the place of the least-used one, is
// always served, and a counter that has reached its limit is the last to be pushed out.
$root3 = studio_tmp_root();
$r3 = var_export($root3, true);
$dir3 = atlas_studio_storage_bucket($root3, 'rate');
$out = slot_php("\$a = 0; for (\$i = 0; \$i < 3; \$i++) \$a += atlas_studio_rate_hit($r3, 'blocked', 3, 3600, $now) ? 1 : 0;"
  . "\$served = 0; for (\$i = 0; \$i < 200; \$i++) \$served += atlas_studio_rate_hit($r3, \"new\$i\", 3, 3600, $now) ? 1 : 0;"
  . "echo \$a, ',', \$served, ',', atlas_studio_rate_hit($r3, 'blocked', 3, 3600, $now) ? 'open' : 'limited';");
studio_check($out === '3,200,limited', "new keys are always served and the limited key stays limited (got $out)");
$doc = json_decode(file_get_contents($dir3 . '/rate-slot-0000.json'), true);
studio_check(count($doc['e']) <= ATLAS_STUDIO_RATE_SLOT_ENTRIES, 'the slot never holds more than its entry cap (' . count($doc['e']) . ')');
studio_check(count(glob($dir3 . '/rate-*.json')) === 1, 'storage is the one slot file');
echo "Asset Studio rate limit tests passed\n";
