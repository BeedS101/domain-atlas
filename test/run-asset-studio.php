<?php
// Asset Studio test runner: php test/run-asset-studio.php
// PHP unit tests (pure functions, injected time) followed by the integration suite, which starts real
// PHP issuers and signs with real keys. Any failing, skipped or missing test makes the run fail.
$unit = [
  'asset-studio-design-validator.php',
  'asset-studio-design-fingerprint.php',
  'asset-studio-storage.php',
  'asset-studio-issuance-plan.php',
  'asset-studio-mint-binding.php',
  'asset-studio-attempt-ledger.php',
  'asset-studio-challenge-race.php',
  'asset-studio-rate-limits.php',
  'asset-studio-hardening.php',
  'asset-studio-exhaustion.php',
];
$failed = [];
$passed = 0;
foreach ($unit as $name) {
  echo "\n== $name ==\n";
  $file = __DIR__ . DIRECTORY_SEPARATOR . $name;
  if (!is_file($file)) { $failed[] = "$name (missing)"; continue; }
  passthru(escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($file), $status);
  if ($status === 0) $passed++; else $failed[] = $name;
}
echo "\n== asset-studio-integration.js ==\n";
passthru('node ' . escapeshellarg(__DIR__ . DIRECTORY_SEPARATOR . 'asset-studio-integration.js'), $status);
if ($status === 0) $passed++; else $failed[] = 'asset-studio-integration.js';
$total = count($unit) + 1;
echo "\nAsset Studio: $passed/$total test files passed; " . count($failed) . " failed\n";
if ($failed) { fwrite(STDERR, 'Failed: ' . implode(', ', $failed) . "\n"); exit(1); }
