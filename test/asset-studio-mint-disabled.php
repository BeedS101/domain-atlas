<?php
// Release guard: do not accidentally expose Studio minting before issuer
// integration, end-to-end testing, and independent security review.
// Static assertions are supplementary; they are not an HTTP security test.
$api=file_get_contents(__DIR__.'/../issuer-php/atlas/studio/api.php');
$page=file_get_contents(__DIR__.'/../issuer-php/atlas/studio/index.html');
if (!is_string($api) || !is_string($page)) {fwrite(STDERR,"Studio sources unavailable\n");exit(1);}
$checks=[
  'mint routes return HTTP 403'=>str_contains($api,"studio_reply(403,['ok'=>false,'error'=>'minting-not-enabled'])"),
  'only validate operation is permitted'=>substr_count($api,"($_GET['op'] ?? '') === ")===1 &&
    str_contains($api,"($_GET['op'] ?? '') === 'validate'"),
  'mint button remains disabled'=>preg_match('/<button\\b[^>]*\\bid="mint"[^>]*\\bdisabled\\b/i',$page)===1,
  'API avoids loading issuer bootstrap'=>!str_contains($api,'lib/bootstrap.php'),
];
foreach($checks as $label=>$pass) {
  if (!$pass) {fwrite(STDERR,"FAIL: ".$label."\n");exit(1);}
}
echo "Studio pre-release mint-disabled guards present (static check only)\n";
