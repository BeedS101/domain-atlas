<?php
// GET /atlas/capabilities — mirrors issuer-server/server.js's same route: which operations this issuer
// answers a repeated requestId for. A wallet that finds an operation here may send it again with the same
// requestId after a lost answer; an issuer that does not list it (or has no such route) creates a second
// result for a repeat, so the wallet does not repeat the request.
//
// An operation is listed only when the file that serves it is the version that implements it, so a bundle
// that was uploaded in part does not claim more than it does.
require_once __DIR__ . '/../lib/bootstrap.php';
handle_preflight();
require_get();

$has = function ($file, $needle) {
  $text = @file_get_contents(__DIR__ . '/' . $file);
  return is_string($text) && strpos($text, $needle) !== false;
};
$operations = [];
if ($has('asset/issue.php', 'atlas_commit_replacement')) $operations[] = 'issue';
if ($has('asset/issue.php', 'atlas_record_issuance')) $operations[] = 'issue-unique';
// Split, consolidate and convert are listed only when their file is the version that checks the
// owner's signed intent, so an older upload of one of them does not advertise it.
if ($has('asset/split.php', 'atlas_require_owner_intent')) $operations[] = 'split';
if ($has('asset/consolidate.php', 'atlas_require_owner_intent')) $operations[] = 'consolidate';
if ($has('convert.php', 'atlas_require_owner_intent')) $operations[] = 'convert';
if ($has('asset/purchase.php', "'purchase', [\$credential]")) $operations[] = 'purchase';
if ($has('asset/open-chest.php', 'atlas_commit_replacement')) $operations[] = 'open-chest';
if ($has('trade/claim.php', 'atlas_store_claim_outcome')) $operations[] = 'trade-claim';
if ($has('trade/claim.php', "'remainder' => \$bRemainder, 'code' => 'claim-incomplete'")) $operations[] = 'trade-claim-remainder';

send_json(200, [
  'requestIds' => [
    'version' => 1,
    'operations' => $operations,
    'retentionHours' => atlas_replay_ttl_seconds() / 3600,
  ],
]);
