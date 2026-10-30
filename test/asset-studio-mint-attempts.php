<?php
require_once __DIR__.'/../issuer-php/atlas/studio/inc/mint-attempts.php';
function studio_attempt_assert($yes,$what){if(!$yes)throw new RuntimeException($what);}
$base=sys_get_temp_dir().'/studio-attempt-'.bin2hex(random_bytes(8));
mkdir($base,0700);mkdir($base.'/mint-receipts',0700);
try {
  $nonce=bin2hex(random_bytes(32));$digest=str_repeat('a',64);$recipient=str_repeat('K',64);
  $first=atlas_studio_claim_attempt($base,$nonce,$digest,$recipient);
  studio_attempt_assert($first['ok'],'first claim');
  $stored=atlas_studio_read_attempt($base,$nonce);
  studio_attempt_assert($stored['state']==='pending-reconciliation' && $stored['recipient']===$recipient,'durable pending record');
  studio_attempt_assert(!atlas_studio_claim_attempt($base,$nonce,$digest,$recipient)['ok'],'same nonce never reissued');
  studio_attempt_assert(!atlas_studio_claim_attempt($base,$nonce,str_repeat('b',64),$recipient)['ok'],'changed digest cannot reuse');
  studio_attempt_assert(!atlas_studio_claim_attempt($base,$nonce,$digest,str_repeat('X',64))['ok'],'changed recipient cannot reuse');
  file_put_contents($base.'/mint-receipts/attempt-'.$nonce.'.json','{');
  studio_attempt_assert(atlas_studio_read_attempt($base,$nonce)===null,'corrupted record unreadable');
  studio_attempt_assert(!atlas_studio_claim_attempt($base,$nonce,$digest,$recipient)['ok'],'corrupted record fails closed');
  $bad=false;try{atlas_studio_attempt_path($base,'../bad');}catch(InvalidArgumentException $e){$bad=true;}
  studio_attempt_assert($bad,'path traversal rejected');
  echo "Asset Studio mint-attempt fail-closed tests passed\n";
} finally {
 foreach(glob($base.'/mint-receipts/*')?:[] as $p)unlink($p);
 rmdir($base.'/mint-receipts');rmdir($base);
}
