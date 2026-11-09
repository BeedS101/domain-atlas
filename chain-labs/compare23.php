<?php
declare(strict_types=1);
/** Labs 23 read-only, signed state-commitment comparison; no ledger writes. */
ini_set('display_errors','0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
function done23(int $s,array $v): never {http_response_code($s);echo json_encode($v,JSON_UNESCAPED_SLASHES);exit;}
if(!extension_loaded('openssl')||!extension_loaded('curl')||!extension_loaded('pdo_sqlite'))done23(503,['ok'=>false,'error'=>'Missing required PHP extension']);
if(empty($_SERVER['HTTPS'])||$_SERVER['HTTPS']==='off')done23(403,['ok'=>false,'error'=>'HTTPS required']);
$host=strtolower($_SERVER['HTTP_HOST']??'');
$nodes=['evtec.co.za'=>'domain-atlas.co.za','domain-atlas.co.za'=>'evtec.co.za'];
if(!isset($nodes[$host]))done23(400,['ok'=>false,'error'=>'Unrecognized node']);
$peer=$nodes[$host];$origin='https://'.$host;
$doc=realpath($_SERVER['DOCUMENT_ROOT']??'');
$private=$doc?realpath(dirname($doc).'/chainblock-labs-private'):false;
if(!$private||str_starts_with($private.'/',$doc.'/'))done23(503,['ok'=>false,'error'=>'Private storage unavailable']);
$configFile=$private.'/federation20-config.php';
if(!is_file($configFile))done23(503,['ok'=>false,'error'=>'Missing Labs 20 node configuration']);
$c=require $configFile;
$mine=is_array($c)?base64_decode($c['private_pem_b64']??'',true):false;
$theirs=is_array($c)?base64_decode($c['peer_public_pem_b64']??'',true):false;
$admin=is_array($c)?($c['admin_token_hex']??null):null;
if(!$mine||!$theirs||!is_string($admin)||!preg_match('/^[a-f0-9]{64}$/D',$admin))done23(503,['ok'=>false,'error'=>'Invalid private configuration']);
$secret=openssl_pkey_get_private($mine);$public=openssl_pkey_get_public($theirs);
if(!$secret||!$public)done23(503,['ok'=>false,'error'=>'Node key import failed']);
try{
 $db=new PDO('sqlite:'.$private.'/federation22.sqlite',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_TIMEOUT=>5]);
 $db->exec('PRAGMA busy_timeout=5000');
}catch(Throwable $e){done23(503,['ok'=>false,'error'=>'Labs 22 event database unavailable']);}
function b64e23(string $s):string{return rtrim(strtr(base64_encode($s),'+/','-_'),'=');}
function b64d23(mixed $s):string|false {
 if(!is_string($s)||!preg_match('/^[a-zA-Z0-9_-]{1,500}$/D',$s))return false;
 return base64_decode(strtr($s,'-_','+/').str_repeat('=',(4-strlen($s)%4)%4),true);
}
function sign23(string $s,OpenSSLAsymmetricKey $key):string{
 $sig='';if(!openssl_sign($s,$sig,$key,OPENSSL_ALGO_SHA256))done23(500,['ok'=>false,'error'=>'Signing unavailable']);return b64e23($sig);
}
function eventRows23(PDO $db):array{
 $rows=$db->query('SELECT id,creator,created,kind,payload_hash,signature FROM events ORDER BY id ASC')->fetchAll(PDO::FETCH_ASSOC);
 foreach($rows as &$r)$r['created']=(int)$r['created'];unset($r);
 return $rows;
}
function fingerprint23(array $rows):string{
 return hash('sha256',json_encode($rows,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR));
}
function request23(string $from,string $to,string $nonce,int $ts):string{return implode('|',['chainblock-labs23','request',$from,$to,$nonce,(string)$ts]);}
function answer23(string $from,string $to,string $nonce,string $hash,int $count):string{return implode('|',['chainblock-labs23','answer',$from,$to,$nonce,$hash,(string)$count]);}
function read23():array{
 if((int)($_SERVER['CONTENT_LENGTH']??0)>4096)done23(413,['ok'=>false,'error'=>'Too large']);
 $data=json_decode(file_get_contents('php://input',false,null,0,4097),true);
 if(!is_array($data))done23(400,['ok'=>false,'error'=>'Invalid JSON']);return $data;
}
$action=$_GET['action']??'';
if($_SERVER['REQUEST_METHOD']==='GET'&&$action==='status'){
 $rows=eventRows23($db);
 done23(200,['ok'=>true,'node'=>$host,'count'=>count($rows),'root'=>fingerprint23($rows),'mode'=>'read-only fingerprint']);
}
if($_SERVER['REQUEST_METHOD']!=='POST')done23(405,['ok'=>false,'error'=>'POST required']);
$m=read23();
if($action==='attest'){
 $from=$m['from']??null;$to=$m['to']??null;$nonce=$m['nonce']??null;$ts=$m['ts']??null;$sig=b64d23($m['signature']??null);
 if($from!==$peer||$to!==$host||!is_string($nonce)||!preg_match('/^[a-f0-9]{32}$/D',$nonce)||!is_int($ts)||abs(time()-$ts)>120||$sig===false||openssl_verify(request23($from,$to,$nonce,$ts),$sig,$public,OPENSSL_ALGO_SHA256)!==1)
 done23(401,['ok'=>false,'error'=>'Invalid peer challenge']);
 $rows=eventRows23($db);$root=fingerprint23($rows);
 done23(200,['ok'=>true,'from'=>$host,'to'=>$peer,'nonce'=>$nonce,'count'=>count($rows),'root'=>$root,'signature'=>sign23(answer23($host,$peer,$nonce,$root,count($rows)),$secret)]);
}
if($action!=='compare')done23(404,['ok'=>false,'error'=>'Unknown action']);
if(($_SERVER['HTTP_ORIGIN']??'')!==$origin)done23(403,['ok'=>false,'error'=>'Origin mismatch']);
$provided=$m['adminToken']??null;
if(!is_string($provided)||!preg_match('/^[a-f0-9]{64}$/D',$provided)||!hash_equals($admin,$provided))done23(403,['ok'=>false,'error'=>'Incorrect operator token']);
$nonce=bin2hex(random_bytes(16));$ts=time();
$req=['from'=>$host,'to'=>$peer,'nonce'=>$nonce,'ts'=>$ts,'signature'=>sign23(request23($host,$peer,$nonce,$ts),$secret)];
$ch=curl_init('https://'.$peer.'/chain-labs/compare23.php?action=attest');
curl_setopt_array($ch,[CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>json_encode($req),CURLOPT_HTTPHEADER=>['Content-Type: application/json'],CURLOPT_RETURNTRANSFER=>true,CURLOPT_CONNECTTIMEOUT=>5,CURLOPT_TIMEOUT=>12,CURLOPT_FOLLOWLOCATION=>false,CURLOPT_SSL_VERIFYPEER=>true,CURLOPT_SSL_VERIFYHOST=>2]);
$raw=curl_exec($ch);$code=curl_getinfo($ch,CURLINFO_RESPONSE_CODE);curl_close($ch);
if($raw===false||strlen($raw)>4096)done23(502,['ok'=>false,'error'=>'Peer communication failed']);
$r=json_decode($raw,true);
if($code!==200||!is_array($r)||($r['ok']??null)!==true)done23(502,['ok'=>false,'error'=>'Peer attestation unavailable','peerError'=>is_array($r)?($r['error']??null):null]);
$remoteHash=$r['root']??null;$remoteCount=$r['count']??null;$rsig=b64d23($r['signature']??null);
if(($r['from']??null)!==$peer||($r['to']??null)!==$host||($r['nonce']??null)!==$nonce||!is_string($remoteHash)||!preg_match('/^[a-f0-9]{64}$/D',$remoteHash)||!is_int($remoteCount)||$remoteCount<0||$rsig===false||openssl_verify(answer23($peer,$host,$nonce,$remoteHash,$remoteCount),$rsig,$public,OPENSSL_ALGO_SHA256)!==1)
 done23(502,['ok'=>false,'error'=>'Peer signature invalid']);
$rows=eventRows23($db);$localHash=fingerprint23($rows);
done23(200,['ok'=>true,'node'=>$host,'peer'=>$peer,'localCount'=>count($rows),'peerCount'=>$remoteCount,'localRoot'=>$localHash,'peerRoot'=>$remoteHash,'match'=>hash_equals($localHash,$remoteHash),'signedPeerAttestation'=>true,'warning'=>'Comparison only: no consensus, financial finality or database changes']);
