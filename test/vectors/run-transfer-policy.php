<?php
// Runs test/vectors/transfer-policy.json through issuer-php's policy and
// prints one JSON result per case, in order, for the Node runner to compare.
// Usage: php run-transfer-policy.php <vectors.json>
require_once __DIR__ . '/../../issuer-php/lib/transfer-policy.php';
$doc = json_decode(file_get_contents($argv[1]), true);
$out = [];
foreach ($doc['cases'] as $case) {
  $in = $case['input'];
  $kind = $in['kind'] ?? 'policy';
  if ($kind === 'gate') $r = atlas_evaluate_delivery_gate($in);
  elseif ($kind === 'mint') $r = atlas_evaluate_mint_for_delivery($in);
  else $r = atlas_evaluate_transfer_policy($in);
  $out[] = $r;
}
echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
