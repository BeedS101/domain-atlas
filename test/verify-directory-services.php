<?php
// How the PHP directory reads the services a manifest advertises (directory-php/atlas/directory/lib/directory.php),
// against the same table of cases the Node directory is tested with (test/support/directory-service-vectors.json):
// which declarations count, how each service is named and ordered, and which addresses may become a link.
// Pure functions only; nothing is fetched and no database is opened.
//
//   php test/verify-directory-services.php             run the cases
//   php test/verify-directory-services.php registry    print the service list as JSON (test/verify-directory-services.js compares it with the Node one)
// With DIRECTORY_EXPECT_PHP=7.4 (or 8.1 ...) it also fails unless this is that PHP.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__ . '/../directory-php/atlas/directory/lib/bootstrap.php';

if (isset($argv[1]) && $argv[1] === 'registry') {
  echo json_encode(['types' => array_map(function ($t) { return array_filter(['key' => $t['key'], 'label' => $t['label'], 'category' => $t['category'], 'aliases' => $t['aliases'] ?: null]); }, dir_service_types()), 'categories' => dir_service_categories()]) . "\n";
  exit(0);
}

$failures = 0;
function check($label, $ok, $detail = null) {
  global $failures;
  if ($ok) { echo "PASS $label\n"; return; }
  $failures++;
  echo "FAIL $label" . ($detail !== null ? ' :: ' . substr(json_encode($detail), 0, 300) : '') . "\n";
}

$expect = getenv('DIRECTORY_EXPECT_PHP');
echo 'Directory under test: PHP ' . PHP_VERSION . ($expect ? " (expected $expect)" : '') . "\n";
if ($expect && !(PHP_VERSION === $expect || strpos(PHP_VERSION, $expect . '.') === 0)) { echo 'FAILURE: PHP version mismatch: this is ' . PHP_VERSION . ", expected $expect\n"; exit(1); }

$vectors = json_decode(file_get_contents(__DIR__ . '/support/directory-service-vectors.json'), true);
echo "--- which addresses may become a link ---\n";
foreach ($vectors['urlCases'] as $c) {
  $got = dir_safe_service_url($c['url'], $c['anchorType'], $c['anchorKey']);
  check($c['note'] . ' (' . substr(json_encode($c['url']), 0, 50) . ')', $got === $c['expect'], ['got' => $got, 'want' => $c['expect']]);
}
echo "--- which declarations advertise a service ---\n";
foreach ($vectors['declarationCases'] as $c) {
  $got = dir_read_services($c['manifest'], $c['anchorType'], $c['anchorKey']);
  check($c['note'], json_encode($got) === json_encode($c['expect']), ['got' => $got, 'want' => $c['expect']]);
}
echo "--- the service list ---\n";
$types = dir_service_types();
$keys = array_map(function ($t) { return $t['key']; }, $types);
check('every service has a label and a known category, and no key is listed twice', count($keys) === count(array_unique($keys)) && count(array_filter($types, function ($t) { return $t['label'] !== '' && in_array($t['category'], dir_service_categories(), true); })) === count($types));
echo $failures === 0 ? "\nALL DIRECTORY SERVICE READING CHECKS PASSED (php " . PHP_VERSION . ")\n" : "\n$failures DIRECTORY SERVICE READING CHECK(S) FAILED (php " . PHP_VERSION . ")\n";
exit($failures === 0 ? 0 : 1);
