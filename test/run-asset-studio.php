<?php
// Local-only Asset Studio test runner: php test/run-asset-studio.php
$tests=[
  'asset-studio-design-validator.php',
  'asset-studio-design-fingerprint.php',
  'asset-studio-authorize-design.php',
  'asset-studio-storage.php',
  'asset-studio-issuance-plan.php',
  'asset-studio-mint-authorization.php',
  'asset-studio-challenges.php',
  'asset-studio-challenge-concurrency.php',
  'asset-studio-mint-attempts.php',
  'asset-studio-attempt-concurrency.php',
  'asset-studio-legacy-issue-gate.php',
];
$php=PHP_BINARY;
$failed=[];
$skipped=[];
$passed=0;
foreach ($tests as $name) {
  echo "\n== $name ==\n";
  $args=escapeshellarg($php).' '.escapeshellarg(__DIR__.DIRECTORY_SEPARATOR.$name);
  passthru($args,$status);
  if ($status === 0) $passed++;
  elseif ($status === 77) $skipped[]=$name;
  else $failed[]=$name;
}
echo "\nAsset Studio: $passed/".count($tests)." tests passed; ".count($skipped)." skipped; ".count($failed)." failed\n";
if ($skipped) fwrite(STDERR,"Skipped (NOT verified): ".implode(", ",$skipped)."\n");
if ($failed || $skipped) {
  if ($failed) fwrite(STDERR,"Failed: ".implode(', ',$failed)."\n");
  exit(1);
}
echo "Note: these test isolated helpers only; real issuer signing and wallet minting are NOT tested.\n";
