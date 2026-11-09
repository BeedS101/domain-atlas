<?php
declare(strict_types=1);
/** Labs 22 — signed offline event and authenticated catch-up experiment; no GOLD changes. */
ini_set('display_errors','0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
function finish22(int $s,array $v): never {http_response_code($s);echo json_encode($v,JSON_UNESCAPED_SLASHES);exit;}
if(!extension_loaded('openssl')||!extension_loaded('curl')||!extension_loaded('pdo_sqlite'))finish22(503,['ok'=>false,'error'=>'Need OpenSSL, cURL, PDO_SQLITE']);
if(empty($_SERVER['HTTPS'])||$_SERVER['HTTPS']==='off')finish22(403,['ok'=>false,'error'=>'HTTPS required']);
$host=strtolower($_SERVER['HTTP_HOST']??'');
$nodes=['evtec.co.za'=>'domain-atlas.co.za','domain-atlas.co.za'=>'evtec.co.za'];
if(!isset($nodes[$host]))finish22(400,['ok'=>false,'error'=>'Unrecognized node']);
$peer=$nodes[$host];$origin='https://'.$host;
$doc=realpath($_SERVER['DOCUMENT_ROOT']??'');
if(!$doc)finish22(503,['ok'=>false,'error'=>'Document root unavailable']);
$private=realpath(dirname($doc).'/chainblock-labs-private');
if(!$private||str_starts_with($private.'/',$doc.'/'))finish22(503,['ok'=>false,'error'=>'Private storage unavailable']);
$cfgFile=$private.'/federation20-config.php';
if(!is_file($cfgFile))finish22(503,['ok'=>false,'error'=>'Labs 20 private config not found']);
$cfg=require $cfgFile;
$mine=is_array($cfg)?base64_decode($cfg['private_pem_b64']??'',true):false;
$theirs=is_array($cfg)?base64_decode($cfg['peer_public_pem_b64']??'',true):false;
$token=is_array($cfg)?($cfg['admin_token_hex']??null):null;
if(!$mine||!$theirs||!is_string($token)||!preg_match('/^[a-f0-9]{64}$/D',$token))finish22(503,['ok'=>false,'error'=>'Invalid Labs 20 key config']);
$ownKey=openssl_pkey_get_private($mine);$peerKey=openssl_pkey_get_public($theirs);
if(!$ownKey||!$peerKey)finish22(503,['ok'=>false,'error'=>'P-256 keys unavailable']);
try{
 $db=new PDO('sqlite:'.$private.'/federation22.sqlite',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_TIMEOUT=>5]);
 $db->exec('PRAGMA busy_timeout=5000');
 $db->exec('CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY,creator TEXT NOT NULL,created INTEGER NOT NULL,kind TEXT NOT NULL,payload_hash TEXT NOT NULL,signature TEXT NOT NULL,stored_at TEXT NOT NULL)');
}catch(Throwable $e){finish22(503,['ok'=>false,'error'=>'Private events database unavailable']);}
function b64e22(string $v):string{return rtrim(strtr(base64_encode($v),'+/','-_'),'=');}
function b64d22(mixed $v):string|false {
 if(!is_string($v)||!preg_match('/^[A-Za-z0-9_-]{1,500}$/D',$v))return false;
 return base64_decode(strtr($v,'-_','+/').str_repeat('=',(4-strlen($v)%4)%4),true);
}
function eventWire22(array $e):string{return implode('|',['chainblock-labs22','event','v1',$e['creator'],$e['id'],(string)$e['created'],$e['kind'],$e['payloadHash']]);}
function requestWire22(string $from,string $to,string $nonce,int $ts):string{return implode('|',['chainblock-labs22','pull','v1',$from,$to,$nonce,(string)$ts]);}
function resultWire22(string $from,string $to,string $nonce,string $digest):string{return implode('|',['chainblock-labs22','response','v1',$from,$to,$nonce,$digest]);}
function validEvent22(array $e,string $creator,OpenSSLAsymmetricKey $key):bool {
 if(($e['creator']??null)!==$creator||!is_string($e['id']??null)||!preg_match('/^[a-f0-9]{32}$/D',$e['id'])||!is_int($e['created']??null)||$e['created']>time()+120||$e['created']<time()-604800
 ||($e['kind']??null)!=='DEMO_NOTE'||!is_string($e['payloadHash']??null)||!preg_match('/^[a-f0-9]{64}$/D',$e['payloadHash']))return false;
 $sig=b64d22($e['signature']??null);
 return $sig!==false&&openssl_verify(eventWire22($e),$sig,$key,OPENSSL_ALGO_SHA256)===1;
}
function insert22(PDO $db,array $e):int{
 $q=$db->prepare('INSERT OR IGNORE INTO events(id,creator,created,kind,payload_hash,signature,stored_at) VALUES(?,?,?,?,?,?,?)');
 $q->execute([$e['id'],$e['creator'],$e['created'],$e['kind'],$e['payloadHash'],$e['signature'],gmdate('c')]);return $q->rowCount();
}
function body22():array {
 if((int)($_SERVER['CONTENT_LENGTH']??0)>8192)finish22(413,['ok'=>false,'error'=>'Message too large']);
 $v=json_decode(file_get_contents('php://input',false,null,0,8193),true);
 if(!is_array($v))finish22(400,['ok'=>false,'error'=>'Invalid JSON']);
 return $v;
}
function signed22(string $msg,OpenSSLAsymmetricKey $key):string {
 $sig='';
 if(!openssl_sign($msg,$sig,$key,OPENSSL_ALGO_SHA256))finish22(500,['ok'=>false,'error'=>'Signing failed']);
 return b64e22($sig);
}
$action=$_GET['action']??'';
if($_SERVER['REQUEST_METHOD']==='GET'&&$action==='status') {
 $q=$db->query('SELECT id,creator,kind,payload_hash,stored_at FROM events ORDER BY rowid DESC LIMIT 30');
 finish22(200,['ok'=>true,'node'=>$host,'peer'=>$peer,'count'=>(int)$db->query('SELECT COUNT(*) FROM events')->fetchColumn(),'events'=>$q->fetchAll(PDO::FETCH_ASSOC)]);
}
if($_SERVER['REQUEST_METHOD']!=='POST')finish22(405,['ok'=>false,'error'=>'POST required']);
$m=body22();
if($action==='pull') {
 // Node-to-node request authenticated by a separate P-256 identity.
 $from=$m['from']??null;$to=$m['to']??null;$nonce=$m['nonce']??null;$ts=$m['ts']??null;$sig=b64d22($m['signature']??null);
 if($from!==$peer||$to!==$host||!is_string($nonce)||!preg_match('/^[a-f0-9]{32}$/D',$nonce)||!is_int($ts)||abs(time()-$ts)>120||$sig===false
 ||openssl_verify(requestWire22($from,$to,$nonce,$ts),$sig,$peerKey,OPENSSL_ALGO_SHA256)!==1)finish22(401,['ok'=>false,'error'=>'Unauthenticated pull request']);
 // The recipient exports ONLY events it created itself, no forwarding of unverified third-party events.
 $q=$db->prepare('SELECT id,creator,created,kind,payload_hash AS payloadHash,signature FROM events WHERE creator=? AND created>=? ORDER BY rowid DESC LIMIT 100');
 $q->execute([$host,time()-604800]);$events=$q->fetchAll(PDO::FETCH_ASSOC);
 foreach($events as &$e)$e['created']=(int)$e['created'];unset($e);
 $digest=hash('sha256',json_encode($events,JSON_UNESCAPED_SLASHES));
 finish22(200,['ok'=>true,'from'=>$host,'to'=>$peer,'nonce'=>$nonce,'events'=>$events,'digest'=>$digest,'signature'=>signed22(resultWire22($host,$peer,$nonce,$digest),$ownKey)]);
}
if(($_SERVER['HTTP_ORIGIN']??'')!==$origin)finish22(403,['ok'=>false,'error'=>'Origin mismatch']);
$given=$m['adminToken']??null;
if(!is_string($given)||!preg_match('/^[a-f0-9]{64}$/D',$given)||!hash_equals($token,$given))finish22(403,['ok'=>false,'error'=>'Incorrect Labs 20 operator token']);
if($action==='offline-create') {
 // Simulated network outage: creates a signed note, intentionally performs NO outbound HTTP request.
 $e=['creator'=>$host,'id'=>bin2hex(random_bytes(16)),'created'=>time(),'kind'=>'DEMO_NOTE','payloadHash'=>hash('sha256','labs22 offline experiment '.$host)];
 $e['signature']=signed22(eventWire22($e),$ownKey);insert22($db,$e);
 finish22(200,['ok'=>true,'eventId'=>$e['id'],'localOnly'=>true,'note'=>'Deliberately not sent to peer']);
}
if($action==='catchup') {
 // Explicit pull; never pushes or modifies the peer's database.
 $nonce=bin2hex(random_bytes(16));$ts=time();
 $request=['from'=>$host,'to'=>$peer,'nonce'=>$nonce,'ts'=>$ts,'signature'=>signed22(requestWire22($host,$peer,$nonce,$ts),$ownKey)];
 $ch=curl_init('https://'.$peer.'/chain-labs/events22.php?action=pull');
 curl_setopt_array($ch,[CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>json_encode($request),CURLOPT_HTTPHEADER=>['Content-Type: application/json'],CURLOPT_RETURNTRANSFER=>true,CURLOPT_CONNECTTIMEOUT=>5,CURLOPT_TIMEOUT=>12,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2]);
 $raw=curl_exec($ch);$http=curl_getinfo($ch,CURLINFO_RESPONSE_CODE);$err=curl_error($ch);curl_close($ch);
 if($raw===false)finish22(502,['ok'=>false,'error'=>'Peer unreachable','detail'=>substr($err,0,120)]);
 if(strlen($raw)>100000)finish22(502,['ok'=>false,'error'=>'Peer response too large']);
 $r=json_decode($raw,true);
 if($http!==200||!is_array($r)||($r['ok']??null)!==true)finish22(502,['ok'=>false,'error'=>'Peer pull failed','peerError'=>is_array($r)?($r['error']??null):null]);
 $events=$r['events']??null;$digest=$r['digest']??null;$rsig=b64d22($r['signature']??null);
 if(($r['from']??null)!==$peer||($r['to']??null)!==$host||($r['nonce']??null)!==$nonce||!is_array($events)||count($events)>100||!is_string($digest)||!preg_match('/^[a-f0-9]{64}$/D',$digest)||$rsig===false
 ||!hash_equals(hash('sha256',json_encode($events,JSON_UNESCAPED_SLASHES)),$digest)
 ||openssl_verify(resultWire22($peer,$host,$nonce,$digest),$rsig,$peerKey,OPENSSL_ALGO_SHA256)!==1)finish22(502,['ok'=>false,'error'=>'Untrusted peer response']);
 foreach($events as $e)if(!is_array($e)||!validEvent22($e,$peer,$peerKey))finish22(502,['ok'=>false,'error'=>'Peer returned invalid event']);
 $added=0;
 try{$db->exec('BEGIN IMMEDIATE');foreach($events as $e)$added+=insert22($db,$e);$db->exec('COMMIT');}
 catch(Throwable $e){try{$db->exec('ROLLBACK');}catch(Throwable $ignored){}finish22(500,['ok'=>false,'error'=>'Local catch-up could not commit']);}
 finish22(200,['ok'=>true,'peer'=>$peer,'fetched'=>count($events),'newEvents'=>$added,'warning'=>'Signed event sync, not consensus']);
}
finish22(404,['ok'=>false,'error'=>'Unknown operation']);
