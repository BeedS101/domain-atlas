<?php
// Local-only Asset Studio test runner: php test/run-asset-studio.php
$tests=[
  'asset-studio-design-validator.php',
  'asset-studio-storage.php',
  'asset-studio-issuance-plan.php',
  'asset-studio-mint-authorization.php',
  'asset-studio-challenges.php',
  'asset-studio-challenge-concurrency.php',
];
$php=PHP_BINARY;
$failed=[];
foreach ($tests as $name) {
  echo "\n== $name ==\n";
  $args=escapeshellarg($php).' '.escapeshellarg(__DIR__.DIRECTORY_SEPARATOR.$name);
  passthru($args,$status);
  if ($status !== 0) $failed[]=$name;
}
echo "\nAsset Studio: ".(count($tests)-count($failed))."/".count($tests)." tests passed\n";
if ($failed) {
  fwrite(STDERR,"Failed: ".implode(', ',$failed)."\n");
  exit(1);
}
echo "Note: these test isolated helpers only; real issuer signing and wallet minting are NOT tested.\n";
