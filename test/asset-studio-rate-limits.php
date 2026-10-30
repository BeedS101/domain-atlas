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

// Pruning: dead counters go, live ones stay, at most once a minute, bounded per pass
$root2 = studio_tmp_root();
$dir = atlas_studio_storage_bucket($root2, 'rate');
for ($i = 0; $i < 30; $i++) { $f = $dir . '/rate-' . substr(hash('sha256', "dead$i"), 0, 40) . '.json'; file_put_contents($f, '{"hits":[1]}'); touch($f, $now - 100); }
$liveFile = $dir . '/rate-' . substr(hash('sha256', 'alive'), 0, 40) . '.json'; file_put_contents($liveFile, '{"hits":[1]}'); touch($liveFile, $now + 500);
studio_check(atlas_studio_prune_rate($dir, $now, 10) === 10, 'a pass removes at most its limit');
studio_check(atlas_studio_prune_rate($dir, $now, 10) === 0, 'and not again within a minute');
studio_check(atlas_studio_prune_rate($dir, $now + 61, 500) === 20, 'the next pass finishes the job');
studio_check(file_exists($liveFile) && count(glob($dir . '/rate-*.json')) === 1, 'the live counter is kept');
$doc = json_decode(file_get_contents($dir . '/.prune'), true);
studio_check($doc['count'] === 1, 'remaining count recorded');

// A full directory refuses new keys but still serves existing ones
$root3 = studio_tmp_root();
$dir3 = atlas_studio_storage_bucket($root3, 'rate');
studio_check(atlas_studio_rate_hit($root3, 'known', 5, 3600, $now), 'first hit creates a counter');
file_put_contents($dir3 . '/.prune', json_encode(['count' => ATLAS_STUDIO_RATE_MAX_FILES, 'at' => $now]));
touch($dir3 . '/.prune', $now);
studio_check(!atlas_studio_rate_hit($root3, 'new-key', 5, 3600, $now), 'a new key is refused when the directory is full');
studio_check(atlas_studio_rate_hit($root3, 'known', 5, 3600, $now), 'an existing key still works');
echo "Asset Studio rate limit tests passed\n";
