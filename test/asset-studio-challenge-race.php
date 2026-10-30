<?php
// Many PHP processes request a challenge at the same instant against a cap of 3: exactly 3 may succeed.
// php test/asset-studio-challenge-race.php            (parent)
// STUDIO_INC overrides the inc directory under test (used to check the test against older code).
require_once __DIR__ . '/studio-test-lib.php';
$inc = getenv('STUDIO_INC') ?: __DIR__ . '/../issuer-php/atlas/studio/inc';
if (getenv('RACE_ROOT')) {
  require_once $inc . '/challenges.php';
  $root = getenv('RACE_ROOT');
  while (!is_file(getenv('RACE_GO'))) usleep(200);
  try { atlas_studio_new_challenge($root, str_repeat('d', 64), getenv('RACE_KEY'), time(), 3); echo "ok"; }
  catch (RuntimeException $e) { echo $e->getMessage(); }
  exit(0);
}
$root = studio_tmp_root();
$go = $root . '/go';
$key = studio_raw_key();
$procs = [];
for ($i = 0; $i < 12; $i++) {
  $procs[] = proc_open([PHP_BINARY, __FILE__], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null,
    array_merge($_ENV, ['PATH' => getenv('PATH'), 'RACE_ROOT' => $root, 'RACE_GO' => $go, 'RACE_KEY' => $key, 'STUDIO_INC' => $inc]));
  $pipesAll[] = $pipes;
}
usleep(600000);
touch($go);
$ok = 0; $capped = 0;
foreach ($procs as $i => $p) {
  $out = stream_get_contents($pipesAll[$i][1]);
  $err = stream_get_contents($pipesAll[$i][2]);
  proc_close($p);
  if ($out === 'ok') $ok++; elseif ($out === 'too-many-challenges') $capped++;
  else studio_check(false, "unexpected worker result: $out $err");
}
studio_check($ok === 3 && $capped === 9, "exactly 3 of 12 simultaneous requests succeed (ok=$ok capped=$capped)");
studio_check(count(glob($root . '/tmp/mint-challenge-*.json')) === 3, 'exactly 3 challenge files exist');
echo "Asset Studio challenge cap race test passed\n";
