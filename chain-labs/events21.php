<?php
declare(strict_types=1);
/** Labs 21: signed immutable event exchange. No balances. */
ini_set('display_errors','0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
function out21(int $s,array $v): never {http_response_code($s);echo json_encode($v);exit;}
if(!extension_loaded('openssl')||!extension_loaded('pdo_sqlite')||!extension_loaded('curl'))out21(503,['ok'=>false,'error'=>'Requires OpenSSL, PDO SQLite and cURL']);
if(empty($_SERVER['HTTPS'])||$_SERVER['HTTPS']==='off')out21(403,['ok'=>false,'error'=>'HTTPS required']);
$host=strtolower($_SERVER['HTTP_HOST']??'');
require __DIR__.'/lib/hosts.php';$nodes=chainlabs_peer_map();
if(!isset($nodes[$host]))out21(400,['ok'=>false,'error'=>'Unknown node hostname']);
$peer=$nodes[$host];$origin='https://'.$host;
$root=realpath($_SERVER['DOCUMENT_ROOT']??'');if(!$root)out21(503,['ok'=>false,'error'=>'No document root']);
$private=realpath(dirname($root).'/chainblock-labs-private');
if(!$private||str_starts_with($private.'/',$root.'/'))out21(503,['ok'=>false,'error'=>'Private data directory missing']);
$filename=$private.'/federation20-config.php';
if(!is_file($filename))out21(503,['ok'=>false,'error'=>'Private federation20-config.php missing']);
$c=require $filename;
if(!is_array($c))out21(503,['ok'=>false,'error'=>'Invalid private config']);
$mine=base64_decode($c['private_pem_b64']??'',true);
$theirs=base64_decode($c['peer_public_pem_b64']??'',true);
$admin=$c['admin_token_hex']??'';
if(!$mine||!$theirs||!is_string($admin)||!preg_match('/^[a-f0-9]{64}$/D',$admin))out21(503,['ok'=>false,'error'=>'Invalid key configuration']);
$secret=openssl_pkey_get_private($mine);$public=openssl_pkey_get_public($theirs);
if(!$secret||!$public)out21(503,['ok'=>false,'error'=>'Unable to import node keys']);
try{
 $db=new PDO('sqlite:'.$private.'/federation21.sqlite',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_TIMEOUT=>5]);
 $db->exec('PRAGMA busy_timeout=5000');
 $db->exec('CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,creator TEXT NOT NULL,kind TEXT NOT NULL,created INTEGER NOT NULL,payload_hash TEXT NOT NULL,signature TEXT NOT NULL,recorded TEXT NOT NULL)');
}catch(Throwable $e){out21(503,['ok'=>false,'error'=>'Private inbox unavailable']);}
function bytes21(string $type,string $from,string $to,string $id,int $ts):string {
 return implode('|',['chainblock-labs20','v1',$type,$from,$to,$id,(string)$ts]);
}
function b6421(string $s):string{return rtrim(strtr(base64_encode($s),'+/','-_'),'=');}
function unb6421(mixed $v):string|false{
 if(!is_string($v)||!preg_match('/^[a-zA-Z0-9_-]{1,400}$/D',$v))return false;
 return base64_decode(strtr($v,'-_','+/').str_repeat('=',(4-strlen($v)%4)%4),true);
}
function read21():array{
 if((int)($_SERVER['CONTENT_LENGTH']??0)>4096)out21(413,['ok'=>false,'error'=>'Oversized message']);
 $value=json_decode(file_get_contents('php://input',false,null,0,4097),true);
 if(!is_array($value))out21(400,['ok'=>false,'error'=>'Expected JSON object']);
 return $value;
}

function eventBytes(array $e):string {
 return implode('|',['chainblock-labs21','v1',$e['creator'],$e['id'],(string)$e['created'],$e['kind'],$e['payloadHash']]);
}
function eventValid(array $e,string $creator,OpenSSLAsymmetricKey $pub):bool {
 if(($e['creator']??null)!==$creator||!is_string($e['id']??null)||!preg_match('/^[a-f0-9]{32}$/D',$e['id'])
 ||!is_int($e['created']??null)||abs(time()-$e['created'])>300||($e['kind']??null)!=='DEMO_NOTE'
 ||!is_string($e['payloadHash']??null)||!preg_match('/^[a-f0-9]{64}$/D',$e['payloadHash']))return false;
 $sig=unb6421($e['signature']??null);
 return $sig!==false&&openssl_verify(eventBytes($e),$sig,$pub,OPENSSL_ALGO_SHA256)===1;
}
function storeEvent(PDO $db,array $e):bool {
 $q=$db->prepare('INSERT OR IGNORE INTO events(id,creator,kind,created,payload_hash,signature,recorded) VALUES(?,?,?,?,?,?,?)');
 $q->execute([$e['id'],$e['creator'],$e['kind'],$e['created'],$e['payloadHash'],$e['signature'],gmdate('c')]);
 return $q->rowCount()===1;
}
$action=$_GET['action']??'';
if($_SERVER['REQUEST_METHOD']==='GET'&&$action==='status') {
 $q=$db->query('SELECT id,creator,kind,payload_hash,recorded FROM events ORDER BY rowid DESC LIMIT 12');
 out21(200,['ok'=>true,'node'=>$host,'peer'=>$peer,'totalEvents'=>(int)$db->query('SELECT COUNT(*) FROM events')->fetchColumn(),'events'=>$q->fetchAll(PDO::FETCH_ASSOC),'testOnly'=>true]);
}
if($_SERVER['REQUEST_METHOD']!=='POST')out21(405,['ok'=>false,'error'=>'POST required']);
$m=read21();
if($action==='receive') {
 $e=$m['event']??null;
 if(!is_array($e)||!eventValid($e,$peer,$public))out21(401,['ok'=>false,'error'=>'Invalid peer event signature, type or timestamp']);
 if(!storeEvent($db,$e))out21(409,['ok'=>false,'error'=>'Duplicate event']);
 $ack='';$ackData='chainblock-labs21|ack|'.$host.'|'.$peer.'|'.$e['id'];
 if(!openssl_sign($ackData,$ack,$secret,OPENSSL_ALGO_SHA256))out21(500,['ok'=>false,'error'=>'Could not sign acknowledgement']);
 out21(200,['ok'=>true,'node'=>$host,'eventId'=>$e['id'],'ackSignature'=>b6421($ack)]);
}
if($action==='create') {
 if(($_SERVER['HTTP_ORIGIN']??'')!==$origin)out21(403,['ok'=>false,'error'=>'Origin mismatch']);
 $token=$m['adminToken']??null;
 if(!is_string($token)||!preg_match('/^[a-f0-9]{64}$/D',$token)||!hash_equals($admin,$token))out21(403,['ok'=>false,'error'=>'Incorrect operator token']);
 // Only a fixed, harmless event payload: no user-provided balances or transfers.
 $e=['creator'=>$host,'id'=>bin2hex(random_bytes(16)),'created'=>time(),'kind'=>'DEMO_NOTE','payloadHash'=>hash('sha256','hello from '.$host)];
 $signature='';
 if(!openssl_sign(eventBytes($e),$signature,$secret,OPENSSL_ALGO_SHA256))out21(500,['ok'=>false,'error'=>'Signing failed']);
 $e['signature']=b6421($signature);
 storeEvent($db,$e);
 $ch=curl_init('https://'.$peer.'/chain-labs/events21.php?action=receive');
 curl_setopt_array($ch,[CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>json_encode(['event'=>$e]),CURLOPT_HTTPHEADER=>['Content-Type: application/json'],CURLOPT_RETURNTRANSFER=>true,CURLOPT_CONNECTTIMEOUT=>5,CURLOPT_TIMEOUT=>12,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2]);
 $body=curl_exec($ch);$http=curl_getinfo($ch,CURLINFO_RESPONSE_CODE);$err=curl_error($ch);curl_close($ch);
 if($body===false)out21(502,['ok'=>false,'eventId'=>$e['id'],'localSaved'=>true,'error'=>'Peer unavailable; local event retained','detail'=>substr($err,0,120)]);
 $ack=json_decode($body,true);
 if($http!==200||!is_array($ack)||($ack['ok']??null)!==true)out21(502,['ok'=>false,'eventId'=>$e['id'],'localSaved'=>true,'error'=>'Peer did not record event','peerHttp'=>$http,'peerError'=>is_array($ack)?($ack['error']??null):null]);
 $ackSignature=unb6421($ack['ackSignature']??null);
 $ackData='chainblock-labs21|ack|'.$peer.'|'.$host.'|'.$e['id'];
 if(($ack['node']??null)!==$peer||($ack['eventId']??null)!==$e['id']||$ackSignature===false||openssl_verify($ackData,$ackSignature,$public,OPENSSL_ALGO_SHA256)!==1)
 out21(502,['ok'=>false,'eventId'=>$e['id'],'localSaved'=>true,'error'=>'Peer acknowledgement not verified']);
 out21(200,['ok'=>true,'eventId'=>$e['id'],'node'=>$host,'peer'=>$peer,'localSaved'=>true,'peerVerified'=>true,'warning'=>'Event replication only; no consensus']);
}
out21(404,['ok'=>false,'error'=>'Unknown action']);
