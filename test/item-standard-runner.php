<?php
// PHP half of test/item-standard.js: replays docs/item-standard-v0.1.json through
// issuer-php/lib/item-standard.php and prints the results as JSON in the same shape the Node side builds.
//   php test/item-standard-runner.php vectors     the shared vectors
//   php test/item-standard-runner.php lint-real   the shipped PHP catalog
// No server is started and nothing is written.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

$root = dirname(__DIR__);
require $root . '/issuer-php/lib/item-standard.php';

function out($data) {
  echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT | JSON_PRESERVE_ZERO_FRACTION), "\n";
  exit(0);
}

function runner_patch($base, $p) {
  $out = is_array($base) ? $base : [];
  if (!is_array($p)) return $out;
  foreach ($p as $k => $v) {
    if ($v === null) unset($out[$k]);
    else $out[$k] = $v;
  }
  return $out;
}
function runner_detail($errors) {
  $list = [];
  foreach ($errors as $e) $list[] = $e['code'] . '@' . $e['key'];
  sort($list, SORT_STRING);
  return $list;
}
function runner_item_props($vectors, $c) {
  $name = isset($c['deriveFrom']) ? $c['deriveFrom'] : (isset($c['spec']) ? $c['spec'] : null);
  $spec = ($name !== null && isset($vectors['specs'][$name])) ? $vectors['specs'][$name] : null;
  $base = (!empty($c['derive']) && $spec !== null) ? atlas_item_derive_properties($spec) : (isset($c['properties']) ? $c['properties'] : []);
  $props = runner_patch($base, isset($c['set']) ? $c['set'] : null);
  $pad = isset($c['pad']) ? (int) $c['pad'] : 0;
  for ($i = 0; $i < $pad; $i++) $props['com.example.pad' . $i] = 'x';
  return $props;
}
function runner_roller($name) {
  $n = 0;
  $tiers = ['common', 'uncommon', 'rare', 'legendary'];
  return function () use (&$n, $name, $tiers) {
    $i = $n % 4;
    $n += 1;
    $luck = $name === 'ring-bad' ? $i + 1 : min(3, $i + 1);
    return ['atlas.rarity' => $tiers[$i], 'atlas.avatar.stat.luck' => (string) $luck];
  };
}
function runner_resolve_catalog($vectors, $def) {
  $out = [];
  foreach ($def['classes'] as $cls => $e) {
    if (isset($e['itemSpec']) && is_string($e['itemSpec'])) $e['itemSpec'] = $vectors['specs'][$e['itemSpec']];
    if (isset($e['randomize'])) {
      $e['randomizeProperties'] = runner_roller($e['randomize']);
      unset($e['randomize']);
    }
    $out[$cls] = $e;
  }
  return $out;
}
function runner_legacy($legacy) {
  return count($legacy) ? $legacy : new stdClass();
}

$mode = isset($argv[1]) ? $argv[1] : 'vectors';

if ($mode === 'vectors') {
  $vectors = json_decode(file_get_contents($root . '/docs/item-standard-v0.1.json'), true);
  $res = ['digests' => [], 'specCases' => [], 'itemCases' => [], 'legacyCases' => [], 'catalogs' => new stdClass()];

  foreach ($vectors['digests'] as $d) {
    $spec = $vectors['specs'][$d['spec']];
    $res['digests'][] = ['spec' => $d['spec'], 'canonical' => atlas_item_canonical($spec), 'sha256' => atlas_item_spec_digest($spec)];
  }
  foreach ($vectors['specCases'] as $c) {
    if (array_key_exists('itemSpec', $c)) $spec = $c['itemSpec'];
    else $spec = runner_patch($vectors['specs'][$c['spec']], isset($c['specPatch']) ? $c['specPatch'] : null);
    $r = atlas_item_validate_spec($spec, isset($c['ctx']) ? $c['ctx'] : []);
    $res['specCases'][] = ['name' => $c['name'], 'ok' => $r['ok'], 'codes' => atlas_item_unique_codes($r['errors']), 'detail' => runner_detail($r['errors'])];
  }
  foreach ($vectors['itemCases'] as $c) {
    $spec = (array_key_exists('spec', $c) && $c['spec'] === null) ? null : runner_patch($vectors['specs'][$c['spec']], isset($c['specPatch']) ? $c['specPatch'] : null);
    $r = atlas_item_validate_properties($spec, runner_item_props($vectors, $c), isset($c['ctx']) ? $c['ctx'] : []);
    $res['itemCases'][] = ['name' => $c['name'], 'applies' => $r['applies'], 'codes' => atlas_item_unique_codes($r['errors']), 'detail' => runner_detail($r['errors'])];
  }
  foreach ($vectors['legacyCases'] as $c) {
    $r = atlas_item_validate_properties(null, runner_item_props($vectors, $c), isset($c['ctx']) ? $c['ctx'] : []);
    $res['legacyCases'][] = ['name' => $c['name'], 'applies' => $r['applies'], 'codes' => atlas_item_unique_codes($r['errors']), 'detail' => runner_detail($r['errors'])];
  }
  $catalogs = [];
  foreach ($vectors['catalogs'] as $name => $def) {
    $r = atlas_item_lint_catalog(runner_resolve_catalog($vectors, $def));
    $checked = $r['checked'];
    sort($checked, SORT_STRING);
    $catalogs[$name] = ['checked' => $checked, 'skipped' => $r['skipped'], 'errors' => $r['errors'], 'legacy' => runner_legacy($r['legacy'])];
  }
  $res['catalogs'] = $catalogs;
  out($res);
}

if ($mode === 'lint-real') {
  // store.php resolves its relative requires from lib/.
  chdir($root . '/issuer-php/lib');
  require $root . '/issuer-php/lib/store.php';
  $r = atlas_item_lint_catalog(ATLAS_ASSET_CATALOG);
  out(['checked' => $r['checked'], 'skipped' => $r['skipped'], 'errors' => $r['errors'], 'legacy' => runner_legacy($r['legacy'])]);
}

fwrite(STDERR, "unknown mode: $mode\n");
exit(2);
