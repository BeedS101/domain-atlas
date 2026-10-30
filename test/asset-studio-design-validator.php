<?php
require_once __DIR__ . '/../issuer-php/atlas/studio/inc/design-validator.php';
function check($condition,$message){if(!$condition){fwrite(STDERR,"FAIL: ".$message."\n");exit(1);}}
$valid=['schema'=>'atlas.asset-studio.design/0.1','template'=>'trophy','name'=>'Demo Trophy','description'=>'For fun only','finish'=>'gold'];
check(atlas_studio_validate_design($valid)['ok'],'valid template');
foreach (['trophy','badge','key'] as $type){$x=$valid;$x['template']=$type;check(atlas_studio_validate_design($x)['ok'],$type);}
foreach (['gold','silver','bronze'] as $finish){$x=$valid;$x['finish']=$finish;check(atlas_studio_validate_design($x)['ok'],$finish);}
foreach (['assetClass'=>'atlas.element.gold','quantity'=>1000,'capabilities'=>['admin'],'issuer'=>'evtec.co.za','modelPath'=>'https://invalid.example/a.glb','ownerPublicKey'=>'forged'] as $key=>$value){$x=$valid;$x[$key]=$value;check(!atlas_studio_validate_design($x)['ok'],'reject '.$key);}
foreach (['name'=>str_repeat('X',65),'description'=>str_repeat('X',241),'finish'=>'platinum','template'=>'currency','schema'=>'bad'] as $key=>$value){$x=$valid;$x[$key]=$value;check(!atlas_studio_validate_design($x)['ok'],'reject invalid '.$key);}
foreach (['Legendary Gopher Trophy','Prize','Explorer Badge','Portal Key'] as $name) {
  $x=$valid;$x['name']=$name;
  check(atlas_studio_validate_design($x)['ok'],'accept normal name '.$name);
}
foreach (["Bad\x01Name","Bad\x7FName"] as $name) {
  $x=$valid;$x['name']=$name;
  check(!atlas_studio_validate_design($x)['ok'],'reject control character in name');
}
echo "Asset Studio design-validator tests passed\n";
