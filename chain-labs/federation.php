<?php
declare(strict_types=1);
/** Chainblock Labs 19: standalone authenticated two-domain messaging test. No GOLD operations. */
ini_set('display_errors','0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
function reply(int $code,array $data): never {http_response_code($code);echo json_encode($data,JSON_UNESCAPED_SLASHES);exit;}
if(!extension_loaded('pdo_sqlite')||!extension_loaded('curl'))reply(503,['ok'=>false,'error'=>'PDO SQLite and cURL required']);
if(($_SERVER['HTTPS']??'')==='off'||empty($_SERVER['HTTPS']))reply(403,['ok'=>false,'error'=>'HTTPS required']);
$host=strtolower($_SERVER['HTTP_HOST']??'');
$peers=['evtec.co.za'=>'domain-atlas.co.za','domain-atlas.co.za'=>'evtec.co.za'];
if(!isset($peers[$host]))reply(400,['ok'=>false,'error'=>'Unexpected host; only the two demo domains allowed']);
$peer=$peers[$host];$origin='https://'.$host;
$doc=realpath($_SERVER['DOCUMENT_ROOT']??'');
if(!$doc)reply(503,['ok'=>false,'error'=>'Document root missing']);
$dir=dirname($doc).DIRECTORY_SEPARATOR.'chainblock-labs-private';
$dirReal=realpath($dir);
if(!$dirReal||str_starts_with($dirReal.DIRECTORY_SEPARATOR,$doc.DIRECTORY_SEPARATOR))reply(503,['ok'=>false,'error'=>'Private Labs 17 directory unavailable']);
$config=$dirReal.DIRECTORY_SEPARATOR.'federation19-config.php';
if(!is_file($config))reply(503,['ok'=>false,'error'=>'Create private federation19-config.php (see FEDERATION19.md)']);
$conf=require $config;
if(!is_array($conf))reply(503,['ok'=>false,'error'=>'Invalid private config']);
$shared=$conf['shared_key_hex']??'';
$admin=$conf['admin_token_hex']??'';
if(!is_string($shared)||!preg_match('/^[a-f0-9]{64}$/D',$shared)||!is_string($admin)||!preg_match('/^[a-f0-9]{64}$/D',$admin))reply(503,['ok'=>false,'error'=>'Expected 64-character random hexadecimal keys']);
$key=hex2bin($shared);
try{
 $db=new PDO('sqlite:'.$dirReal.DIRECTORY_SEPARATOR.'federation19.sqlite',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_TIMEOUT=>5]);
 $db->exec('PRAGMA busy_timeout=5000');
 $db->exec('CREATE TABLE IF NOT EXISTS received (message_id TEXT PRIMARY KEY, sender TEXT NOT NULL, received_at TEXT NOT NULL)');
}catch(Throwable $e){reply(503,['ok'=>false,'error'=>'Could not open private federation SQLite database']);}
function wire(string $sender,string $recipient,string $id,int $timestamp): string {return 'chainblock-labs19|v1|'.$sender.'|'.$recipient.'|'.$id.'|'.$timestamp.'|PING';}
function responseWire(string $id,string $sender,string $recipient):string{return 'chainblock-labs19|ack|'.$id.'|'.$sender.'|'.$recipient;}
function jsonBody(): array {
 if((int)($_SERVER['CONTENT_LENGTH']??0)>4096)reply(413,['ok'=>false,'error'=>'Body too large']);
 $input=file_get_contents('php://input',false,null,0,4097);
 $v=json_decode($input,true);
 if(!is_array($v))reply(400,['ok'=>false,'error'=>'JSON object required']);
 return $v;
}
$action=$_GET['action']??'';
if($_SERVER['REQUEST_METHOD']==='GET'&&$action==='status'){
 $count=(int)$db->query('SELECT COUNT(*) FROM received')->fetchColumn();
 reply(200,['ok'=>true,'node'=>$host,'peer'=>$peer,'receivedCount'=>$count,'testOnly'=>true]);
}
if($_SERVER['REQUEST_METHOD']!=='POST')reply(405,['ok'=>false,'error'=>'POST required']);
$data=jsonBody();
if($action==='receive'){
 $sender=$data['sender']??null;$recipient=$data['recipient']??null;$id=$data['id']??null;$ts=$data['timestamp']??null;$mac=$data['mac']??null;
 if($sender!==$peer||$recipient!==$host||!is_string($id)||!preg_match('/^[a-f0-9]{32}$/D',$id)||!is_int($ts)||abs(time()-$ts)>120||!is_string($mac)||!preg_match('/^[a-f0-9]{64}$/D',$mac))reply(400,['ok'=>false,'error'=>'Invalid or expired envelope']);
 if(!hash_equals(hash_hmac('sha256',wire($sender,$recipient,$id,$ts),$key),$mac))reply(401,['ok'=>false,'error'=>'Invalid node authentication']);
 try{
  $stmt=$db->prepare('INSERT INTO received(message_id,sender,received_at) VALUES(?,?,?)');
  $stmt->execute([$id,$sender,gmdate('c')]);
 }catch(PDOException $e){
  if(str_contains($e->getMessage(),'UNIQUE'))reply(409,['ok'=>false,'error'=>'Replay detected']);
  reply(500,['ok'=>false,'error'=>'Could not record message']);
 }
 reply(200,['ok'=>true,'node'=>$host,'received'=>$id,'ackMac'=>hash_hmac('sha256',responseWire($id,$host,$sender),$key)]);
}
if($action==='send'){
 if(($_SERVER['HTTP_ORIGIN']??'')!==$origin)reply(403,['ok'=>false,'error'=>'Browser origin mismatch']);
 $token=$data['adminToken']??null;
 if(!is_string($token)||!preg_match('/^[a-f0-9]{64}$/D',$token)||!hash_equals($admin,$token))reply(403,['ok'=>false,'error'=>'Operator token rejected']);
 $id=bin2hex(random_bytes(16));$ts=time();
 $envelope=['sender'=>$host,'recipient'=>$peer,'id'=>$id,'timestamp'=>$ts,'mac'=>hash_hmac('sha256',wire($host,$peer,$id,$ts),$key)];
 $url='https://'.$peer.'/chain-labs/federation.php?action=receive';
 $ch=curl_init($url);
 curl_setopt_array($ch,[CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>json_encode($envelope),CURLOPT_HTTPHEADER=>['Content-Type: application/json'],CURLOPT_RETURNTRANSFER=>true,CURLOPT_CONNECTTIMEOUT=>5,CURLOPT_TIMEOUT=>12,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2,CURLOPT_MAXREDIRS=>0]);
 $body=curl_exec($ch);$http=curl_getinfo($ch,CURLINFO_RESPONSE_CODE);$err=curl_error($ch);curl_close($ch);
 if($body===false)reply(502,['ok'=>false,'error'=>'Peer transport failed','detail'=>substr($err,0,180)]);
 $result=json_decode($body,true);
 if($http!==200||!is_array($result)||($result['ok']??false)!==true)reply(502,['ok'=>false,'error'=>'Peer did not accept test message','peerHttp'=>$http,'peerError'=>is_array($result)?($result['error']??null):null]);
 $ack=$result['ackMac']??null;
 if(($result['node']??null)!==$peer||($result['received']??null)!==$id||!is_string($ack)||!hash_equals(hash_hmac('sha256',responseWire($id,$peer,$host),$key),$ack))reply(502,['ok'=>false,'error'=>'Peer acknowledgement did not authenticate']);
 reply(200,['ok'=>true,'from'=>$host,'to'=>$peer,'messageId'=>$id,'authenticatedAck'=>true,'note'=>'Experimental HMAC federation ping; not consensus']);
}
reply(404,['ok'=>false,'error'=>'Unknown action']);
