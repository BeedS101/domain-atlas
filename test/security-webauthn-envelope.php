<?php
// The PHP issuer's passkey assertion check (verify_envelope in issuer-php/lib/bootstrap.php) against the same cases as
// the Node test; the cases are built by test/support/webauthn-assertions.js, so both issuers face identical input.
//
// Run: php test/security-webauthn-envelope.php
$work = sys_get_temp_dir() . '/atlas-webauthn-php-' . getmypid();
mkdir($work);
$casesFile = "$work/cases.json";
exec('node ' . escapeshellarg(__DIR__ . '/support/webauthn-assertions.js') . ' ' . escapeshellarg($casesFile) . ' 2>&1', $out, $rc);
if ($rc !== 0) { echo "FATAL could not build cases\n" . implode("\n", $out) . "\n"; exit(1); }
$cases = json_decode(file_get_contents($casesFile), true);

putenv('ATLAS_DOMAIN=issuer.example');
require dirname(__DIR__) . '/issuer-php/lib/bootstrap.php';

$failures = 0; $passes = 0;
function check($name, $ok, $detail = null) {
  global $failures, $passes;
  if ($ok) { $passes++; echo "PASS $name\n"; }
  else { $failures++; echo "FAIL $name" . ($detail === null ? '' : ' :: ' . substr(json_encode($detail), 0, 240)) . "\n"; }
}

$vars = ['ATLAS_WEBAUTHN_ORIGINS', 'ATLAS_WEBAUTHN_RP_IDS', 'ATLAS_WEBAUTHN_REQUIRE_UV'];
foreach ($cases as $c) {
  foreach ($vars as $v) putenv($v);
  foreach ($c['env'] as $k => $v) putenv("$k=$v");
  try { $got = verify_envelope($c['payload'], $c['envelope']); } catch (Throwable $e) { $got = 'threw ' . $e->getMessage(); }
  check(($c['expect'] ? 'accepts: ' : 'refuses: ') . $c['name'], $got === $c['expect'], $got);
}
foreach ($vars as $v) putenv($v);
check('a missing envelope is refused without throwing', verify_envelope([], null) === false);
echo "$passes passed, $failures failed\n";
exec('rm -rf ' . escapeshellarg($work));
exit($failures ? 1 : 0);
