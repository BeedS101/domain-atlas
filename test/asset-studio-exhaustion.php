<?php
// Exhaustion attacks on the rate counters and the daily mint quota, with injected time.
//   R1: many distinct IPv6 networks must not fill rate storage or lock out new visitors.
//   R2: one /48 rotating /64s must not use up the global daily quota; first-time actors keep a reserve.
require_once __DIR__ . '/studio-test-lib.php';
require_once __DIR__ . '/../issuer-php/atlas/studio/inc/storage.php';
require_once __DIR__ . '/../issuer-php/atlas/studio/inc/mint-attempts.php';
$now = time();
$v6 = function ($i) { return sprintf('2001:%x:%x:1::1', 0xdb8 + ($i >> 16), $i & 0xffff); }; // a distinct /48 per $i
function rate_files($root) { return count(glob(atlas_studio_storage_bucket($root, 'rate') . '/*')); }
function rate_bytes($root) { $n = 0; foreach (glob(atlas_studio_storage_bucket($root, 'rate') . '/{.,}*', GLOB_BRACE) as $f) if (is_file($f)) $n += filesize($f); return $n; }

// ---------------------------------------------------------------- R1
$root = studio_tmp_root();
// A visitor who is at the limit stays limited; a casual one has a count.
$heavy = atlas_studio_actor('203.0.113.9');
for ($i = 0; $i < 3; $i++) studio_check(atlas_studio_rate_check($root, 'challenge', $heavy, 3, 3600, $now), 'heavy actor within limit');
studio_check(!atlas_studio_rate_check($root, 'challenge', $heavy, 3, 3600, $now), 'heavy actor is now limited');

// Sustained traffic from many distinct /48 networks, one hit each (what address rotation looks like).
$flood = 12000;
for ($i = 0; $i < $flood; $i++) atlas_studio_rate_check($root, 'challenge', atlas_studio_actor($v6($i)), 30, 3600, $now);
$refused = 0; $total = 60;
for ($i = 0; $i < $total; $i++) {
  $who = $i % 2 ? atlas_studio_actor(sprintf('198.51.100.%d', $i)) : atlas_studio_actor($v6(900000 + $i));
  if (!atlas_studio_rate_check($root, 'challenge', $who, 30, 3600, $now)) $refused++;
}
studio_check($refused === 0, "new legitimate visitors are still served after $flood rotating networks ($refused of $total refused)");
studio_check(!atlas_studio_rate_check($root, 'challenge', $heavy, 3, 3600, $now), 'the limited actor stays limited through the flood');
studio_check(rate_files($root) <= 5000, 'rate storage stays bounded (' . rate_files($root) . ' files)');
studio_check(rate_bytes($root) <= 8 * 1024 * 1024, 'and so does its size (' . rate_bytes($root) . ' bytes)');
// A flood does not make the same actor's own counter lose hits forever: it still gets limited at its limit.
$a = atlas_studio_actor($v6(777777));
$ok = 0; for ($i = 0; $i < 100; $i++) if (atlas_studio_rate_check($root, 'challenge', $a, 5, 3600, $now)) $ok++;
studio_check($ok >= 5 && $ok <= 5 + 2, "a new actor is held to its limit (allowed $ok)");

// An actor hammering past its own limit must not use up its /48 group's allowance for its neighbours.
$root2 = studio_tmp_root();
$bad = atlas_studio_actor('2001:db8:50:1::1');
for ($i = 0; $i < 500; $i++) atlas_studio_rate_check($root2, 'challenge', $bad, 3, 3600, $now);
$neighbours = 0;
for ($k = 2; $k < 8; $k++) if (atlas_studio_rate_check($root2, 'challenge', atlas_studio_actor("2001:db8:50:$k::1"), 3, 3600, $now)) $neighbours++;
studio_check($neighbours === 6, "neighbours in the same /48 are not locked out by one abusive /64 ($neighbours of 6 served)");

// Concurrent processes: one key is limited exactly; many keys in a tiny table stay consistent.
$code = function ($args) { return escapeshellarg(PHP_BINARY) . ' -r ' . escapeshellarg($args); };
$lib = escapeshellarg(__DIR__ . '/../issuer-php/atlas/studio/inc/storage.php');
$root3 = studio_tmp_root();
$procs = [];
for ($w = 0; $w < 6; $w++) {
  $php = 'define("ATLAS_STUDIO_RATE_SLOTS", 1); require ' . var_export(__DIR__ . '/../issuer-php/atlas/studio/inc/storage.php', true) . ';'
    . '$ok=0; for($i=0;$i<60;$i++){ if (atlas_studio_rate_hit(' . var_export($root3, true) . ', "shared", 100, 3600, ' . $now . ')) $ok++; atlas_studio_rate_hit(' . var_export($root3, true) . ', "w' . $w . '-".($i%12), 1000, 3600, ' . $now . '); } echo $ok;';
  $procs[] = proc_open(escapeshellarg(PHP_BINARY) . ' -r ' . escapeshellarg($php), [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes[$w]);
}
$sum = 0;
foreach ($procs as $w => $p) { $sum += (int) stream_get_contents($pipes[$w][1]); proc_close($p); }
studio_check($sum === 100, "concurrent workers share exactly one limit of 100 (got $sum)");
foreach (glob(atlas_studio_storage_bucket($root3, 'rate') . '/rate-*.json') as $f) {
  $doc = json_decode(file_get_contents($f), true);
  studio_check(is_array($doc), 'every counter file is valid JSON after concurrent writes');
}

// Parallel floods from many networks through the real table: no corrupt slot, no lockout, bounded files.
$root4 = studio_tmp_root();
$procs = []; $pipes = [];
for ($w = 0; $w < 5; $w++) {
  $php = 'require ' . var_export(__DIR__ . '/../issuer-php/atlas/studio/inc/storage.php', true) . ';'
    . 'for($i=0;$i<2500;$i++){ $x=' . ($w * 2500) . '+$i; atlas_studio_rate_check(' . var_export($root4, true) . ', "challenge", atlas_studio_actor(sprintf("2001:%x:%x:1::1", 0xdb8+($x>>16), $x&0xffff)), 30, 3600, ' . $now . '); }';
  $procs[$w] = proc_open(escapeshellarg(PHP_BINARY) . ' -r ' . escapeshellarg($php), [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes[$w]);
}
foreach ($procs as $w => $p) { $err = stream_get_contents($pipes[$w][2]); proc_close($p); studio_check($err === '', 'flood worker ran cleanly: ' . $err); }
$bad = 0; foreach (glob(atlas_studio_storage_bucket($root4, 'rate') . '/rate-slot-*.json') as $f) if (!is_array(json_decode(file_get_contents($f), true))) $bad++;
studio_check($bad === 0, "no slot file is corrupt after parallel floods ($bad bad)");
studio_check(rate_files($root4) <= 4100, 'files stay bounded under parallel floods (' . rate_files($root4) . ')');
studio_check(atlas_studio_rate_check($root4, 'challenge', atlas_studio_actor('2001:db8:ffff:1::9'), 30, 3600, $now), 'a new visitor is served after the parallel flood');

// ---------------------------------------------------------------- R2
$n = function ($i) { return str_pad(dechex($i), 64, '0', STR_PAD_LEFT); };
$d = str_repeat('d', 64);
$i = 0;
$claim = function ($root, $remote, $limits) use (&$i, $n, $d, $now) {
  $actor = atlas_studio_actor($remote);
  $i++;
  return atlas_studio_claim_attempt($root, $n($i), $d, studio_raw_key(), $limits, $now, $actor['key'], $actor['group']);
};
$limits = ['perRecipient' => 50, 'perActor' => 2, 'perGroup' => 4, 'global' => 20, 'reserve' => 6, 'windowSeconds' => 86400];

// One /48 rotates through /64s, each within its own limit.
$r2 = studio_tmp_root();
$got = 0; $blockedBy = null;
for ($k = 0; $k < 12; $k++) for ($m = 0; $m < 2; $m++) {
  $r = $claim($r2, "2001:db8:aaaa:$k::1", $limits);
  if ($r['ok']) $got++; else $blockedBy = $r['error'];
}
studio_check($got === 4, "one /48 rotating /64s is held to its network quota (minted $got of 24)");
studio_check($blockedBy === 'quota-group', 'refused with quota-group, got ' . var_export($blockedBy, true));

// Seven networks use the unreserved part of the quota; established networks cannot take the reserve.
$r3 = studio_tmp_root();
$used = 0;
for ($net = 0; $net < 7; $net++) for ($m = 0; $m < 2; $m++) if ($claim($r3, "2001:db8:bb$net:1::1", $limits)['ok']) $used++;
studio_check($used === 14, "established actors can use the unreserved part of the quota (used $used, expected 14)");
$est = $claim($r3, '2001:db8:bb0:2::1', $limits); // a new /64, but its /48 has minted already
studio_check(!$est['ok'] && $est['error'] === 'quota-reserved', 'an established network is refused once only the reserve is left: ' . json_encode($est));
$est4 = $claim($r3, '192.0.2.60', $limits); $est4b = $claim($r3, '192.0.2.60', $limits);
studio_check($est4['ok'] && !$est4b['ok'] && $est4b['error'] === 'quota-reserved', 'the same holds for an IPv4 user after their first mint: ' . json_encode($est4b));
$firstTimer = $claim($r3, '2001:db8:cc00:1::1', $limits);
studio_check($firstTimer['ok'], 'a first-time network may use the reserve');
$again = $claim($r3, '2001:db8:cc00:1::1', $limits);
studio_check(!$again['ok'] && $again['error'] === 'quota-reserved', 'but once it has minted it is refused when only the reserve is left: ' . json_encode($again));
$newV6 = $claim($r3, '2001:db8:dd00:1::1', $limits);
$newV4 = $claim($r3, '198.51.100.20', $limits);
studio_check($newV6['ok'] && $newV4['ok'], 'a first-time IPv6 network and a first-time IPv4 user also get in via the reserve');
$ok = 0; for ($k = 0; $k < 6; $k++) if ($claim($r3, "2001:db8:ee0$k:1::1", $limits)['ok']) $ok++;
studio_check($ok === 2, "the reserve is finite: 6 slots, 4 used so far, so 2 more first-time actors are served (served $ok)");
$over = $claim($r3, '2001:db8:ff00:1::1', $limits);
studio_check(!$over['ok'] && $over['error'] === 'quota-global', 'the global limit still holds: ' . json_encode($over));

// Legitimate shared networks: several members of one /48 each get their share, within the network quota.
$r4 = studio_tmp_root();
$shared = 0;
foreach ([1, 2, 3, 4] as $member) if ($claim($r4, "2001:db8:abcd:$member::5", $limits)['ok']) $shared++;
studio_check($shared === 4, 'four members of one shared /48 can each mint once');
// IPv4 users have no network group: only the per-address limit applies.
$r5 = studio_tmp_root();
$v4ok = 0; for ($k = 0; $k < 5; $k++) if ($claim($r5, '192.0.2.44', $limits)['ok']) $v4ok++;
studio_check($v4ok === 2, "an IPv4 address is held to its own limit (minted $v4ok)");
// A retry of a claimed attempt is not charged again and the ledger never stores a network address.
$r6 = studio_tmp_root();
$a1 = atlas_studio_actor('2001:db8:1111:1::1');
$first = atlas_studio_claim_attempt($r6, $n(9001), $d, $rk = studio_raw_key(), $limits, $now, $a1['key'], $a1['group']);
$again = atlas_studio_claim_attempt($r6, $n(9001), $d, $rk, $limits, $now, $a1['key'], $a1['group']);
studio_check($first['ok'] && $again['ok'] && $again['existing'], 'a retry is the same attempt');
foreach (glob(atlas_studio_storage_bucket($r6, 'mint-receipts') . '/attempt-*.json') as $f) {
  $txt = file_get_contents($f);
  studio_check(strpos($txt, '2001') === false && strpos($txt, 'ip6') === false, 'the ledger stores no network address');
}
echo "Asset Studio exhaustion tests passed\n";
