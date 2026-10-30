<?php
require_once __DIR__.'/../issuer-php/atlas/studio/inc/mint-authorization.php';
function ok($yes,$name){if(!$yes){fwrite(STDERR,"FAIL: $name\n");exit(1);}}
$now=1760000000;
$c=['nonce'=>str_repeat('b',64),'expiresAt'=>$now+90,'designDigest'=>str_repeat('a',64),'recipient'=>'owner-public-key'];
$p=['purpose'=>'atlas.studio.mint/1','nonce'=>$c['nonce'],'designDigest'=>str_repeat('a',64),'recipient'=>'owner-public-key','expiresAt'=>$c['expiresAt']];
$proof=['signedPayload'=>['ctx'=>'atlas.bridge.sign/1','origin'=>'https://domain-atlas.co.za','payload'=>$p],'publicKey'=>'owner-public-key','signerRole'=>'raw-ecdsa'];
$check=fn($v,$c2=$c)=>atlas_studio_check_mint_proof($v,$c2,'https://domain-atlas.co.za',str_repeat('a',64),$now);
ok($check($proof)['ok'],'valid proof shape');
$bad=$c;$bad['recipient']='other';ok(!$check($proof,$bad)['ok'],'challenge recipient binding');
$bad=$c;$bad['designDigest']=str_repeat('f',64);ok(!$check($proof,$bad)['ok'],'challenge design binding');
foreach ([
  'wrong origin'=>['origin'=>'https://evtec.co.za'],
  'wrong ctx'=>['ctx'=>'something-else'],
] as $name=>$change){$x=$proof;$x['signedPayload']=array_merge($x['signedPayload'],$change);ok(!$check($x)['ok'],$name);}
foreach ([
 'nonce'=>'bad','designDigest'=>str_repeat('c',64),'recipient'=>'somebody-else','expiresAt'=>$now-1,'purpose'=>'atlas.other/1'
] as $name=>$value){$x=$proof;$x['signedPayload']['payload'][$name]=$value;ok(!$check($x)['ok'],$name);}
$x=$proof;$x['publicKey']='someone-else';ok(!$check($x)['ok'],'recipient binding');
$x=$proof;$x['signedPayload']['payload']['extra']='privileged';ok(!$check($x)['ok'],'no extra properties');
$x=$proof;$x['signerRole']='unknown';ok(!$check($x)['ok'],'invalid signer');
$x=$proof;$x['signedPayload']['payload']['expiresAt']=$now+301;
ok(!$check($x,['nonce'=>$c['nonce'],'expiresAt'=>$now+301])['ok'],'bounded expiry');
echo "Asset Studio mint proof preflight tests passed\n";

$called=0;
$accept=function($signed,$envelope)use(&$called,$proof){$called++;return $signed===$proof['signedPayload'] && $envelope===$proof;};
ok(atlas_studio_verify_mint_envelope($proof,$c,'https://domain-atlas.co.za',str_repeat('a',64),$accept,$now)['ok'],'verified envelope accepted');
ok($called===1,'verifier invoked');
$reject=fn($signed,$envelope)=>false;
ok(!atlas_studio_verify_mint_envelope($proof,$c,'https://domain-atlas.co.za',str_repeat('a',64),$reject,$now)['ok'],'invalid signature rejected');
$called=0;$bad=$proof;$bad['signedPayload']['origin']='https://other.example';
ok(!atlas_studio_verify_mint_envelope($bad,$c,'https://domain-atlas.co.za',str_repeat('a',64),$accept,$now)['ok'] && $called===0,'bad proof skips verifier');
