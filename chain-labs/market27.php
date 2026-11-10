<?php
declare(strict_types=1);
/** Labs 27 public demo catalog: read-only aggregation of the coin registries and, for coins open on a ledger, the market figures their authority publishes. */
ini_set('display_errors','0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
function answer27(int $status,array $data): never {http_response_code($status);echo json_encode($data,JSON_UNESCAPED_SLASHES|JSON_INVALID_UTF8_SUBSTITUTE);exit;}
if(empty($_SERVER['HTTPS'])||$_SERVER['HTTPS']==='off')answer27(403,['ok'=>false,'error'=>'HTTPS required']);
$host=strtolower($_SERVER['HTTP_HOST']??'');
require __DIR__.'/lib/hosts.php';require __DIR__.'/lib/market.php';$nodes=chainlabs_hosts();
if(!in_array($host,$nodes,true))answer27(400,['ok'=>false,'error'=>'Unrecognized host']);
if($_SERVER['REQUEST_METHOD']!=='GET'||($_GET['action']??'')!=='list')answer27(404,['ok'=>false,'error'=>'Unknown action']);
if(!extension_loaded('curl'))answer27(503,['ok'=>false,'error'=>'PHP cURL required']);
$coins=[];$sources=[];
foreach($nodes as $node){
 $url='https://'.$node.'/chain-labs/coin26.php?action=list';
 $ch=curl_init($url);
 curl_setopt_array($ch,[CURLOPT_RETURNTRANSFER=>true,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_CONNECTTIMEOUT=>4,CURLOPT_TIMEOUT=>8,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_HTTPHEADER=>['Accept: application/json']]);
 $raw=curl_exec($ch);$http=(int)curl_getinfo($ch,CURLINFO_RESPONSE_CODE);curl_close($ch);
 if(!is_string($raw)||strlen($raw)>100000||$http!==200){$sources[]=['node'=>$node,'available'=>false];continue;}
 $data=json_decode($raw,true);
 if(!is_array($data)||($data['ok']??null)!==true||($data['node']??null)!==$node||!is_array($data['coins']??null)||count($data['coins'])>40){$sources[]=['node'=>$node,'available'=>false];continue;}
 $accepted=0;
 foreach($data['coins'] as $c){
  if(!is_array($c)||($c['domain']??null)!==$node||!is_string($c['name']??null)||strlen($c['name'])>80||!is_string($c['symbol']??null)||!preg_match('/^[A-Z][A-Z0-9]{1,9}$/D',$c['symbol'])||!is_string($c['id']??null)||!preg_match('/^[a-f0-9]{32}$/D',$c['id'])||!is_string($c['genesisHash']??null)||!preg_match('/^[a-f0-9]{64}$/D',$c['genesisHash'])||!is_int($c['decimals']??null)||$c['decimals']<0||$c['decimals']>6)continue;
  $valid=true;foreach(['maxSupply','initialSupply','treasurySupply'] as $k)if(!is_string($c[$k]??null)||!preg_match('/^[0-9]{1,13}(?:\.[0-9]{1,6})?$/D',$c[$k]))$valid=false;
  if(!$valid)continue;
  $coins[]=['id'=>$c['id'],'domain'=>$node,'name'=>$c['name'],'symbol'=>$c['symbol'],'decimals'=>$c['decimals'],'maxSupply'=>$c['maxSupply'],'initialSupply'=>$c['initialSupply'],'treasurySupply'=>$c['treasurySupply'],'description'=>is_string($c['description']??null)?substr($c['description'],0,280):'','createdAt'=>is_string($c['createdAt']??null)?substr($c['createdAt'],0,32):'','genesisHash'=>$c['genesisHash']];
  $accepted++;
 }
 $sources[]=['node'=>$node,'available'=>true,'listed'=>$accepted];
}
// The market figures. Each domain's scanner states them for the coins it is the authority of, and a coin is taken from its
// authority only, so a multi authority coin is counted once however many domains hold its log. A figure the authority does not
// state, or states in a shape this page does not accept, is left out and the page shows a dash.
function market27_fetch(string $node): ?array{
 $ch=curl_init('https://'.$node.'/chain-labs/scan35.php?action=market');
 curl_setopt_array($ch,[CURLOPT_RETURNTRANSFER=>true,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_CONNECTTIMEOUT=>4,CURLOPT_TIMEOUT=>8,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_HTTPHEADER=>['Accept: application/json']]);
 $raw=curl_exec($ch);$http=(int)curl_getinfo($ch,CURLINFO_RESPONSE_CODE);curl_close($ch);
 if(!is_string($raw)||strlen($raw)>200000||$http!==200)return null;
 $d=json_decode($raw,true);
 return is_array($d)&&($d['ok']??null)===true&&($d['domain']??null)===$node&&is_array($d['coins']??null)&&count($d['coins'])<=40?$d:null;
}
$market=[];
foreach($nodes as $node){
 $d=market27_fetch($node);
 if($d===null)continue;
 foreach($d['coins'] as $m){
  if(!is_array($m))continue;
  $c=market_clean($m,$node);
  if($c!==null&&!isset($market[$m['coinId']]))$market[$m['coinId']]=$c;
 }
}
[$coins,$stated]=market_attach($coins,$market);
usort($coins,fn($a,$b)=>strcmp($a['symbol'],$b['symbol'])?:strcmp($a['domain'],$b['domain']));
answer27(200,['ok'=>true,'coins'=>$coins,'sources'=>$sources,'updatedAt'=>gmdate('c'),'demo'=>true,'marketDataAvailable'=>$stated>0,'unit'=>'Au','notice'=>'Demo coins of no monetary value. Supply, treasury, price, market cap and 24 hour volume are read from the ledger of each coin\'s authority domain; a figure that does not exist is not shown. Prices and totals are in demo Gold (Au).']);
