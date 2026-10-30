<?php
require_once __DIR__.'/../issuer-php/atlas/studio/inc/design-fingerprint.php';
function studio_fp_check($ok,$msg){if(!$ok){fwrite(STDERR,"FAIL: ".$msg."\n");exit(1);}}
$a=['schema'=>'atlas.asset-studio.design/0.1','template'=>'trophy','name'=>'Achievement Trophy','description'=>'Awarded for excellence','finish'=>'gold'];
$b=array_reverse($a,true);
$x=atlas_studio_design_fingerprint($a);
$y=atlas_studio_design_fingerprint($b);
studio_fp_check($x['ok'] && $y['ok'],'accept designs');
studio_fp_check(preg_match('/^[a-f0-9]{64}$/D',$x['designDigest'])===1,'sha-256 hex');
studio_fp_check($x['designDigest']===$y['designDigest'],'JSON key order-independent');
$changed=$a;$changed['finish']='silver';
studio_fp_check(atlas_studio_design_fingerprint($changed)['designDigest']!==$x['designDigest'],'finish bound');
$changed=$a;$changed['description']='Different description';
studio_fp_check(atlas_studio_design_fingerprint($changed)['designDigest']!==$x['designDigest'],'description bound');
$changed=$a;$changed['quantity']=100;
studio_fp_check(!atlas_studio_design_fingerprint($changed)['ok'],'privileged fields rejected');
echo "Asset Studio design fingerprint tests passed\n";
