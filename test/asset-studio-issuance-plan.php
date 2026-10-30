<?php
require_once __DIR__ . '/../issuer-php/atlas/studio/inc/issuance-plan.php';
function studio_check($condition, $message) { if (!$condition) { fwrite(STDERR,"FAIL: $message\n"); exit(1); } }
$design=['schema'=>'atlas.asset-studio.design/0.1','template'=>'trophy','name'=>'Gopher Trophy','description'=>'Playful demo prize','finish'=>'gold'];
$owner=str_repeat('K',64);
$plan=atlas_studio_issuance_plan($design,$owner);
studio_check($plan['ok'],'accept validated design');
studio_check($plan['requiredClass']==='atlas.demo.studio.collectible','fixed demo class');
studio_check($plan['requiredTradeScope']==='bound' && $plan['quantity']===1,'fixed bound collectible');
studio_check($plan['properties']['atlas.studio.name']==='Gopher Trophy','carry chosen name');
foreach (['assetClass'=>'atlas.element.gold','quantity'=>10000,'tradeScope'=>'global','issuer'=>'evtec.co.za','capabilities'=>['admin']] as $key=>$v) {
  $attempt=$design;$attempt[$key]=$v;
  studio_check(!atlas_studio_issuance_plan($attempt,$owner)['ok'],'reject '.$key);
}
studio_check(!atlas_studio_issuance_plan($design,'invalid')['ok'],'reject short recipient');
echo "Asset Studio issuance plan tests passed\n";
