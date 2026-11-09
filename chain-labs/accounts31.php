<?php
declare(strict_types=1);
/** Labs 31 — authenticated account discovery, not credential issuance.
 * Read-only accounts owned by a signature-proven raw P-256 wallet identity.
 */
ini_set('display_errors','0');
header('Content-Type: application/json; charset=utf-8');header('Cache-Control: no-store');header('X-Content-Type-Options: nosniff');
function finish31(int $status,string $code,string $message,array $data=[]):never{
 http_response_code($status);echo json_encode(array_merge(['ok'=>$status<400,'code'=>$code,'message'=>$message],$data),JSON_UNESCAPED_SLASHES);exit;
}
if(!extension_loaded('pdo_sqlite')||!extension_loaded('openssl'))finish31(503,'unavailable','SQLite or OpenSSL missing');
if(empty($_SERVER['HTTPS'])||$_SERVER['HTTPS']==='off')finish31(403,'https-required','HTTPS required');
$host=strtolower($_SERVER['HTTP_HOST']??'');
if(!in_array($host,['evtec.co.za','domain-atlas.co.za'],true))finish31(400,'unknown-host','Unknown host');
if(($_SERVER['REQUEST_METHOD']??'')!=='POST'||($_GET['action']??'')!=='accounts')finish31(404,'unknown-operation','Unknown operation');
$operation='https://'.$host.'/chain-labs/accounts31.php?action=accounts';
$network='chainblock-labs29-'.$host;
$root=realpath($_SERVER['DOCUMENT_ROOT']??'');
$private=$root?realpath(dirname($root).'/chainblock-labs-private'):false;
if(!$private||str_starts_with($private.'/',$root.'/'))finish31(503,'unavailable','Private ledger directory missing');
if(!is_file($private.'/coin26.sqlite')||!is_file($private.'/ledger29.sqlite'))finish31(503,'unavailable','Ledger databases not initialized');
if((int)($_SERVER['CONTENT_LENGTH']??0)>4096)finish31(413,'malformed-request','Request too large');
$raw=file_get_contents('php://input',false,null,0,4097);
if(!is_string($raw)||strlen($raw)>4096)finish31(413,'malformed-request','Request too large');
$r=json_decode($raw,true);
if(!is_array($r)||count($r)!==2||!is_array($r['payload']??null)||!is_array($r['proof']??null))finish31(400,'malformed-request','Invalid signed request');
$p=$r['payload'];$proof=$r['proof'];
$required=['type','v','audience','network','nonce','issuedAt'];
if(count($p)!==count($required)||array_diff($required,array_keys($p))||array_diff(array_keys($p),$required)||count($proof)!==2||!isset($proof['publicKey'],$proof['signature']))finish31(400,'malformed-request','Unexpected fields');
if($p['type']!=='atlas.ledger.accounts'||$p['v']!==1)finish31(400,'malformed-request','Wrong request type');
if($p['audience']!==$operation)finish31(401,'wrong-audience','Wrong URL audience');
if($p['network']!==$network)finish31(400,'unknown-network','Wrong network');
if(!is_string($p['nonce'])||!preg_match('/^[a-f0-9]{32,64}$/D',$p['nonce']))finish31(400,'malformed-request','Invalid nonce');
$when=$p['issuedAt'];
if(!is_string($when)||!preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/D',$when)||($ts=strtotime($when))===false)finish31(400,'malformed-request','Invalid timestamp');
if(abs(time()-$ts)>120)finish31(401,'stale-request','Request expired',['serverTime'=>gmdate('Y-m-d\TH:i:s\Z')]);
function d31(mixed $s):string|false {
 if(!is_string($s)||!preg_match('/^[A-Za-z0-9_-]+$/D',$s))return false;
 $x=base64_decode(strtr($s,'-_','+/').str_repeat('=',(4-strlen($s)%4)%4),true);
 return $x!==false&&rtrim(strtr(base64_encode($x),'+/','-_'),'=')===$s?$x:false;
}
function c31(mixed $v):string{
 if(is_array($v)){if(array_is_list($v))return '['.implode(',',array_map('c31',$v)).']';
 ksort($v,SORT_STRING);$a=[];foreach($v as $k=>$i)$a[]=json_encode((string)$k,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE).':'.c31($i);return '{'.implode(',',$a).'}';}
 return json_encode($v,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
}
function der31(string $s):string{
 $part=static function(string $a):string{$a=ltrim($a,"\x00");if($a==='')$a="\x00";if(ord($a[0])&128)$a="\x00".$a;return "\x02".chr(strlen($a)).$a;};
 $s=$part(substr($s,0,32)).$part(substr($s,32,32));return "\x30".chr(strlen($s)).$s;
}
$key=$proof['publicKey'];$point=d31($key);$sig=d31($proof['signature']);
if($point===false||strlen($point)!==65||ord($point[0])!==4||$sig===false||strlen($sig)!==64)finish31(401,'unsupported-proof','Only canonical raw P-256 keys and proofs supported');
$prefix=hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200');
$pem="-----BEGIN PUBLIC KEY-----\n".chunk_split(base64_encode($prefix.$point),64,"\n")."-----END PUBLIC KEY-----\n";
$pub=openssl_pkey_get_public($pem);
if(!$pub||openssl_verify(c31($p),der31($sig),$pub,OPENSSL_ALGO_SHA256)!==1)finish31(401,'bad-signature','Wallet proof did not verify');
try{
 $reg=new PDO('sqlite:file:'.$private.'/coin26.sqlite?mode=ro',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
 $ledger=new PDO('sqlite:file:'.$private.'/ledger29.sqlite?mode=ro',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
 $reg->exec('PRAGMA query_only=ON');$ledger->exec('PRAGMA query_only=ON');
 $q=$ledger->prepare('SELECT coin_id FROM accounts WHERE owner_key=? LIMIT 201');$q->execute([$key]);
 $ids=$q->fetchAll(PDO::FETCH_COLUMN);if(count($ids)>200)finish31(429,'rate-limited','Too many accounts for experimental listing');
 $look=$reg->prepare('SELECT symbol,decimals FROM coins WHERE id=? AND domain=?');
 $accounts=[];
 foreach($ids as $coinId){
  $look->execute([$coinId,$host]);$coin=$look->fetch(PDO::FETCH_ASSOC);if(!$coin)continue;
  $data=['purpose'=>'atlas.ledger.account-id','v'=>1,'network'=>$network,'coin'=>$coin['symbol'],'owner'=>$key];
  $accounts[]=['accountId'=>'urn:atlas:ledger-account:'.hash('sha256',c31($data)),
   'network'=>$network,'coin'=>$coin['symbol'],'coinId'=>$coinId,'ownerKey'=>$key];
 }
}catch(Throwable $e){finish31(503,'unavailable','Account lookup failed');}
finish31(200,'accounts-found','Verified account ownership; unsigned descriptors only',[
 'network'=>$network,'ownerKey'=>$key,'accounts'=>$accounts,'count'=>count($accounts),
 'warning'=>'These are unsigned account locators, NOT issuer-signed ledger-account credentials. Do not import them into the wallet.'
]);
