<?php
require_once __DIR__.'/../issuer-php/atlas/studio/inc/authorize-design.php';
function require_studio($condition,$message) { if (!$condition) throw new RuntimeException($message); }
$now=1760000000;
$design=['schema'=>'atlas.asset-studio.design/0.1','template'=>'trophy','name'=>'Achievement Trophy','description'=>'Recognition for excellence','finish'=>'gold'];
$fingerprint=atlas_studio_design_fingerprint($design);
require_studio($fingerprint['ok'],'valid design');
$challenge=['state'=>'issued','nonce'=>str_repeat('b',64),'expiresAt'=>$now+90,'designDigest'=>$fingerprint['designDigest'],'recipient'=>str_repeat('K',64)];
$proof=['signerRole'=>'raw-ecdsa','publicKey'=>$challenge['recipient'],'signedPayload'=>[
  'ctx'=>'atlas.bridge.sign/1','origin'=>'https://domain-atlas.co.za','payload'=>[
    'purpose'=>'atlas.studio.mint/1','nonce'=>$challenge['nonce'],
    'designDigest'=>$challenge['designDigest'],'recipient'=>$challenge['recipient'],'expiresAt'=>$challenge['expiresAt']
  ]
]];
$verified=0;
$verifier=function($payload,$envelope)use(&$verified){$verified++;return true;}; // Mock only: NOT cryptographic verification.
$result=atlas_studio_authorize_design_proof($design,$proof,$challenge,'https://domain-atlas.co.za',$verifier,$now);
require_studio($result['ok'] && $verified===1,'matching design reaches verifier');
$changed=$design;$changed['finish']='silver';
$verified=0;
require_studio(!atlas_studio_authorize_design_proof($changed,$proof,$challenge,'https://domain-atlas.co.za',$verifier,$now)['ok'] && $verified===0,'edited design rejected before verifier');
$changed=$design;$changed['name']='Different award';
require_studio(!atlas_studio_authorize_design_proof($changed,$proof,$challenge,'https://domain-atlas.co.za',$verifier,$now)['ok'],'edited name rejected');
$changedChallenge=$challenge;$changedChallenge['state']='consumed';
require_studio(!atlas_studio_authorize_design_proof($design,$proof,$changedChallenge,'https://domain-atlas.co.za',$verifier,$now)['ok'],'consumed challenge rejected');
require_studio(!atlas_studio_authorize_design_proof($design,$proof,$challenge,'https://domain-atlas.co.za',fn()=>false,$now)['ok'],'invalid signature rejected');
echo "Asset Studio design-proof authorization composition tests passed (mock verifier only)\n";
