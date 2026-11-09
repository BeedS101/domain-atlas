<?php
declare(strict_types=1);
/** Labs 20: independent P-256 node signatures; PING only, no balances. */
ini_set('display_errors','0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
function out20(int $s,array $v): never {http_response_code($s);echo json_encode($v);exit;}
if(!extension_loaded('openssl')||!extension_loaded('pdo_sqlite')||!extension_loaded('curl'))out20(503,['ok'=>false,'error'=>'Requires OpenSSL, PDO SQLite and cURL']);
if(empty($_SERVER['HTTPS'])||$_SERVER['HTTPS']==='off')out20(403,['ok'=>false,'error'=>'HTTPS required']);
$host=strtolower($_SERVER['HTTP_HOST']??'');
$nodes=['evtec.co.za'=>'domain-atlas.co.za','domain-atlas.co.za'=>'evtec.co.za'];
if(!isset($nodes[$host]))out20(400,['ok'=>false,'error'=>'Unknown node hostname']);
$peer=$nodes[$host];$origin='https://'.$host;
$root=realpath($_SERVER['DOCUMENT_ROOT']??'');if(!$root)out20(503,['ok'=>false,'error'=>'No document root']);
$private=realpath(dirname($root).'/chainblock-labs-private');
if(!$private||str_starts_with($private.'/',$root.'/'))out20(503,['ok'=>false,'error'=>'Private data directory missing']);
$filename=$private.'/federation20-config.php';
if(!is_file($filename))out20(503,['ok'=>false,'error'=>'Private federation20-config.php missing']);
$c=require $filename;
if(!is_array($c))out20(503,['ok'=>false,'error'=>'Invalid private config']);
$mine=base64_decode($c['private_pem_b64']??'',true);
$theirs=base64_decode($c['peer_public_pem_b64']??'',true);
$admin=$c['admin_token_hex']??'';
if(!$mine||!$theirs||!is_string($admin)||!preg_match('/^[a-f0-9]{64}$/D',$admin))out20(503,['ok'=>false,'error'=>'Invalid key configuration']);
$secret=openssl_pkey_get_private($mine);$public=openssl_pkey_get_public($theirs);
if(!$secret||!$public)out20(503,['ok'=>false,'error'=>'Unable to import node keys']);
try{
 $db=new PDO('sqlite:'.$private.'/federation20.sqlite',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_TIMEOUT=>5]);
 $db->exec('PRAGMA busy_timeout=5000');
 $db->exec('CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,sender TEXT NOT NULL,at TEXT NOT NULL)');
}catch(Throwable $e){out20(503,['ok'=>false,'error'=>'Private inbox unavailable']);}
function bytes20(string $type,string $from,string $to,string $id,int $ts):string {
 return implode('|',['chainblock-labs20','v1',$type,$from,$to,$id,(string)$ts]);
}
function b6420(string $s):string{return rtrim(strtr(base64_encode($s),'+/','-_'),'=');}
function unb6420(mixed $v):string|false{
 if(!is_string($v)||!preg_match('/^[a-zA-Z0-9_-]{1,400}$/D',$v))return false;
 return base64_decode(strtr($v,'-_','+/').str_repeat('=',(4-strlen($v)%4)%4),true);
}
function read20():array{
 if((int)($_SERVER['CONTENT_LENGTH']??0)>4096)out20(413,['ok'=>false,'error'=>'Oversized message']);
 $value=json_decode(file_get_contents('php://input',false,null,0,4097),true);
 if(!is_array($value))out20(400,['ok'=>false,'error'=>'Expected JSON object']);
 return $value;
}
$action=$_GET['action']??'';
if($_SERVER['REQUEST_METHOD']==='GET'&&$action==='status')
 out20(200,['ok'=>true,'node'=>$host,'peer'=>$peer,'receivedCount'=>(int)$db->query('SELECT COUNT(*) FROM inbox')->fetchColumn(),'authentication'=>'independent P-256 signatures','testOnly'=>true]);
if($_SERVER['REQUEST_METHOD']!=='POST')out20(405,['ok'=>false,'error'=>'POST required']);
$m=read20();
if($action==='receive'){
 $from=$m['from']??null;$to=$m['to']??null;$id=$m['id']??null;$ts=$m['ts']??null;$signature=unb6420($m['signature']??null);
 if($from!==$peer||$to!==$host||!is_string($id)||!preg_match('/^[a-f0-9]{32}$/D',$id)||!is_int($ts)||abs(time()-$ts)>120||$signature===false)
 out20(400,['ok'=>false,'error'=>'Malformed or expired signed message']);
 if(openssl_verify(bytes20('PING',$from,$to,$id,$ts),$signature,$public,OPENSSL_ALGO_SHA256)!==1)
 out20(401,['ok'=>false,'error'=>'Peer signature invalid']);
 try{$stmt=$db->prepare('INSERT INTO inbox(id,sender,at) VALUES(?,?,?)');$stmt->execute([$id,$from,gmdate('c')]);}
 catch(PDOException $e){out20(409,['ok'=>false,'error'=>'Duplicate or failed inbox write']);}
 $ackTs=time();$ack='';
 if(!openssl_sign(bytes20('ACK',$host,$peer,$id,$ackTs),$ack,$secret,OPENSSL_ALGO_SHA256))out20(500,['ok'=>false,'error'=>'ACK signing failed']);
 out20(200,['ok'=>true,'from'=>$host,'to'=>$peer,'id'=>$id,'ts'=>$ackTs,'signature'=>b6420($ack)]);
}
if($action==='send'){
 if(($_SERVER['HTTP_ORIGIN']??'')!==$origin)out20(403,['ok'=>false,'error'=>'Origin mismatch']);
 $token=$m['adminToken']??null;
 if(!is_string($token)||!preg_match('/^[a-f0-9]{64}$/D',$token)||!hash_equals($admin,$token))
 out20(403,['ok'=>false,'error'=>'Incorrect operator token']);
 $id=bin2hex(random_bytes(16));$ts=time();$signature='';
 if(!openssl_sign(bytes20('PING',$host,$peer,$id,$ts),$signature,$secret,OPENSSL_ALGO_SHA256))
 out20(500,['ok'=>false,'error'=>'Signing failed']);
 $payload=['from'=>$host,'to'=>$peer,'id'=>$id,'ts'=>$ts,'signature'=>b6420($signature)];
 $ch=curl_init('https://'.$peer.'/chain-labs/federation20.php?action=receive');
 curl_setopt_array($ch,[CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>json_encode($payload),CURLOPT_HTTPHEADER=>['Content-Type: application/json'],CURLOPT_RETURNTRANSFER=>true,CURLOPT_CONNECTTIMEOUT=>5,CURLOPT_TIMEOUT=>12,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2]);
 $response=curl_exec($ch);$http=curl_getinfo($ch,CURLINFO_RESPONSE_CODE);$err=curl_error($ch);curl_close($ch);
 if($response===false)out20(502,['ok'=>false,'error'=>'Peer network failure','detail'=>substr($err,0,150)]);
 $ack=json_decode($response,true);
 if($http!==200||!is_array($ack)||($ack['ok']??false)!==true)out20(502,['ok'=>false,'error'=>'Peer rejected signed ping','peerHttp'=>$http,'peerError'=>is_array($ack)?($ack['error']??'unknown'):'non-JSON response']);
 $ackSig=unb6420($ack['signature']??null);$ackTs=$ack['ts']??null;
 if(($ack['from']??null)!==$peer||($ack['to']??null)!==$host||($ack['id']??null)!==$id||!is_int($ackTs)||abs(time()-$ackTs)>120||$ackSig===false||
 openssl_verify(bytes20('ACK',$peer,$host,$id,$ackTs),$ackSig,$public,OPENSSL_ALGO_SHA256)!==1)
 out20(502,['ok'=>false,'error'=>'Peer acknowledgement signature invalid']);
 out20(200,['ok'=>true,'from'=>$host,'to'=>$peer,'id'=>$id,'verifiedAck'=>true,'warning'=>'Identity/authentication only; no consensus']);
}
out20(404,['ok'=>false,'error'=>'Unknown action']);
