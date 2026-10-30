<?php
// CLI-only helper for the concurrent challenge test.
if (PHP_SAPI !== 'cli' || count($argv) !== 6) exit(2);
require_once __DIR__.'/../issuer-php/atlas/studio/inc/challenges.php';
[$script,$root,$nonce,$digest,$recipient,$now]=$argv;
try {
  echo atlas_studio_consume_challenge($root,$nonce,$digest,$recipient,(int)$now) ? "1\n" : "0\n";
} catch (Throwable $e) {
  fwrite(STDERR,"challenge worker error\n");
  exit(3);
}
