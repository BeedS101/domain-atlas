<?php
declare(strict_types=1);
/** Chainblock Lab 25: read-only audit of each node's independent TEST-GOLD faucet ledger. */
ini_set('display_errors','0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
function reply25(int $status,array $body): never {http_response_code($status);echo json_encode($body,JSON_UNESCAPED_SLASHES);exit;}
if(!extension_loaded('pdo_sqlite'))reply25(503,['ok'=>false,'error'=>'PDO SQLite extension unavailable']);
if(empty($_SERVER['HTTPS'])||$_SERVER['HTTPS']==='off')reply25(403,['ok'=>false,'error'=>'HTTPS required']);
$host=strtolower($_SERVER['HTTP_HOST']??'');
require __DIR__.'/lib/hosts.php';if(!chainlabs_is_host($host))reply25(400,['ok'=>false,'error'=>'Unknown node']);
if($_SERVER['REQUEST_METHOD']!=='GET'||($_GET['action']??'')!=='audit')reply25(404,['ok'=>false,'error'=>'Unknown action']);
$root=realpath($_SERVER['DOCUMENT_ROOT']??'');
if(!$root)reply25(503,['ok'=>false,'error'=>'Document root unavailable']);
$private=realpath(dirname($root).'/chainblock-labs-private');
if(!$private||str_starts_with($private.'/',$root.'/'))reply25(503,['ok'=>false,'error'=>'Private storage unavailable']);
$file=$private.'/chainlabs17.sqlite';
if(!is_file($file)||!is_readable($file))reply25(503,['ok'=>false,'error'=>'Labs 17 database unavailable']);
try{
 // Query-only connection. Existing database only; no CREATE, UPDATE, or schema changes.
 $db=new PDO('sqlite:'.$file,null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_TIMEOUT=>5]);
 $db->exec('PRAGMA query_only=ON');
 $db->exec('PRAGMA busy_timeout=5000');
 $db->beginTransaction(); // one consistent SQLite read snapshot for every aggregation
 $get=function(string $sql)use($db):int{
  $v=$db->query($sql)->fetchColumn();
  if(!is_numeric($v)||!preg_match('/^-?[0-9]+$/D',(string)$v))throw new RuntimeException('Invalid ledger aggregation');
  return (int)$v;
 };
 $holders=$get('SELECT COUNT(*) FROM accounts');
 $claims=$get('SELECT COUNT(*) FROM claims');
 $total=$get('SELECT COALESCE(SUM(balance),0) FROM accounts');
 $negative=$get('SELECT COUNT(*) FROM accounts WHERE balance<0');
 $transfers=0;$transferVolume=0;
 $exists=$get("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='transfers'");
 if($exists>0){
   $transfers=$get('SELECT COUNT(*) FROM transfers');
   $transferVolume=$get('SELECT COALESCE(SUM(amount),0) FROM transfers');
 }
 $db->commit();
 if($claims>intdiv(PHP_INT_MAX,50))throw new RuntimeException('Count overflow');
 $issued=$claims*50; // current Labs17 rules: exactly one 50-GOLD claim per claimed wallet
 $difference=$total-$issued;
 reply25(200,['ok'=>true,'node'=>$host,'network'=>'chainlabs17-'.$host,'asset'=>'TEST-GOLD','claimedWallets'=>$claims,'accounts'=>$holders,'issuedFromFaucet'=>$issued,'balanceTotal'=>$total,'transfers'=>$transfers,'transferVolume'=>$transferVolume,'negativeBalances'=>$negative,'difference'=>$difference,'conservationPass'=>$difference===0&&$negative===0,'maxSupply'=>null,'maxSupplyConfigured'=>false,'note'=>'Standalone test ledger. Supply equals recorded faucet claims times 50; transfers should conserve total. No hard cap is configured. Not a proof against missing or forged claims, compromised SQL, or conflicting distributed state.']);
}catch(Throwable $e){reply25(503,['ok'=>false,'error'=>'Could not complete consistent local audit']);}
