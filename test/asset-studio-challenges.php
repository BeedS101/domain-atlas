<?php
require_once __DIR__.'/../issuer-php/atlas/studio/inc/challenges.php';
function t($ok,$name){if(!$ok){fwrite(STDERR,"FAIL: ".$name."\n");exit(1);}}
$base=sys_get_temp_dir().'/studio-nonce-'.bin2hex(random_bytes(8));
mkdir($base,0700);mkdir($base.'/tmp',0700);
try {
 $digest=str_repeat('a',64);$owner=str_repeat('K',64);$now=1760000000;
 $c=atlas_studio_new_challenge($base,$digest,$owner,$now);
 t(preg_match('/^[a-f0-9]{64}$/D',$c['nonce'])===1,'random nonce');
 t($c['expiresAt']===$now+120,'expiry');
 $loaded=atlas_studio_read_challenge($base,$c['nonce'],$now);
 t(is_array($loaded) && $loaded['designDigest']===$digest && $loaded['recipient']===$owner,'read stored binding');
 t(atlas_studio_read_challenge($base,'../bad',$now)===null,'reject invalid read path');
 t(!atlas_studio_consume_challenge($base,$c['nonce'],str_repeat('b',64),$owner,$now),'wrong design');
 t(!atlas_studio_consume_challenge($base,$c['nonce'],$digest,str_repeat('X',64),$now),'wrong recipient');
 t(atlas_studio_consume_challenge($base,$c['nonce'],$digest,$owner,$now),'first consume');
 t(!atlas_studio_consume_challenge($base,$c['nonce'],$digest,$owner,$now),'replay refused');
 t(atlas_studio_read_challenge($base,$c['nonce'],$now)===null,'consumed not readable');
 $expired=atlas_studio_new_challenge($base,$digest,$owner,$now);
 t(!atlas_studio_consume_challenge($base,$expired['nonce'],$digest,$owner,$now+121),'expired refused');
 t(!atlas_studio_consume_challenge($base,'../bad',$digest,$owner,$now),'path traversal refused');
 echo "Asset Studio challenge-store tests passed\n";
} finally {
 foreach (glob($base.'/tmp/*') ?: [] as $f) unlink($f);
 rmdir($base.'/tmp');rmdir($base);
}
