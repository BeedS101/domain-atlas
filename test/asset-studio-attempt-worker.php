<?php
// CLI worker for parallel mint-attempt claim. Never issues an asset.
if (PHP_SAPI !== 'cli' || count($argv)!==5) exit(2);
require_once __DIR__.'/../issuer-php/atlas/studio/inc/mint-attempts.php';
try {
  $r=atlas_studio_claim_attempt($argv[1],$argv[2],$argv[3],$argv[4]);
  echo $r['ok'] ? "1\n" : "0\n";
} catch (Throwable $e) {
  fwrite(STDERR,"attempt worker failed\n");
  exit(3);
}
