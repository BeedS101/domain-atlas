<?php
declare(strict_types=1);
/** Labs 30: signed, zero-balance account opening only. NO minting or payments. */
ini_set('display_errors','0');
header('Content-Type: application/json; charset=utf-8');header('Cache-Control: no-store');header('X-Content-Type-Options: nosniff');
function out30(int $status,string $code,string $message,array $data=[]):never {http_response_code($status);echo json_encode(array_merge(['ok'=>$status<400,'code'=>$code,'message'=>$message],$data),JSON_UNESCAPED_SLASHES);exit;}
if(($_SERVER['REQUEST_METHOD']??'')!=='POST'||($_GET['action']??'')!=='open')out30(404,'unknown-operation','Unsupported operation');
if(!extension_loaded('openssl')||!extension_loaded('pdo_sqlite'))out30(503,'unavailable','Missing OpenSSL or SQLite');
if(empty($_SERVER['HTTPS'])||$_SERVER['HTTPS']==='off')out30(403,'https-required','HTTPS required');
$host=strtolower($_SERVER['HTTP_HOST']??'');
require __DIR__.'/lib/hosts.php';if(!chainlabs_is_host($host))out30(400,'unknown-host','Unknown host');
$operation='https://'.$host.'/chain-labs/account30.php?action=open';$network='chainblock-labs29-'.$host;
$root=realpath($_SERVER['DOCUMENT_ROOT']??'');$private=$root?realpath(dirname($root).'/chainblock-labs-private'):false;
if(!$private||str_starts_with($private.'/',$root.'/')||!is_file($private.'/coin26.sqlite'))out30(503,'unavailable','Private registry unavailable');
if((int)($_SERVER['CONTENT_LENGTH']??0)>4096)out30(413,'malformed-request','Too large');
$raw=file_get_contents('php://input',false,null,0,4097);if(!is_string($raw)||strlen($raw)>4096)out30(413,'malformed-request','Too large');
$r=json_decode($raw,true);
if(!is_array($r)||count($r)!==2||!isset($r['payload'],$r['proof'])||!is_array($r['payload'])||!is_array($r['proof']))out30(400,'malformed-request','Invalid envelope');
$p=$r['payload'];$proof=$r['proof'];
$fields=['type','v','audience','network','coin','nonce','issuedAt'];
if(count($p)!==count($fields)||array_diff($fields,array_keys($p))||array_diff(array_keys($p),$fields)||count($proof)!==2||!isset($proof['publicKey'],$proof['signature']))out30(400,'malformed-request','Unexpected fields');
if($p['type']!=='atlas.ledger.account.open'||$p['v']!==1)out30(400,'malformed-request','Wrong request type');
if($p['audience']!==$operation)out30(401,'wrong-audience','Audience must be exact operation URL');
if($p['network']!==$network)out30(400,'unknown-network','Wrong network');
$symbol=$p['coin'];
if(!is_string($symbol)||!preg_match('/^[A-Z][A-Z0-9]{1,9}$/D',$symbol))out30(400,'malformed-request','Invalid coin');
$nonce=$p['nonce'];
if(!is_string($nonce)||!preg_match('/^[a-f0-9]{32,64}$/D',$nonce))out30(400,'malformed-request','Invalid nonce');
$when=$p['issuedAt'];
if(!is_string($when)||!preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/D',$when)||($ts=strtotime($when))===false)out30(400,'malformed-request','Invalid timestamp');
if(abs(time()-$ts)>120)out30(401,'stale-request','Clock outside two-minute window',['serverTime'=>gmdate('Y-m-d\TH:i:s\Z')]);
function decode30(mixed $x):string|false {if(!is_string($x)||!preg_match('/^[A-Za-z0-9_-]+$/D',$x))return false;$b=base64_decode(strtr($x,'-_','+/').str_repeat('=',(4-strlen($x)%4)%4),true);return $b!==false&&rtrim(strtr(base64_encode($b),'+/','-_'),'=')===$x?$b:false;}
function canon30(mixed $v):string {
 if(is_array($v)){if(array_is_list($v))return '['.implode(',',array_map('canon30',$v)).']';
 ksort($v,SORT_STRING);$parts=[];foreach($v as $k=>$item)$parts[]=json_encode((string)$k,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE).':'.canon30($item);return '{'.implode(',',$parts).'}';}
 return json_encode($v,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
}
function der30(string $s):string {$integer=static function(string $v):string {$v=ltrim($v,"\x00");if($v==='')$v="\x00";if(ord($v[0])&128)$v="\x00".$v;return "\x02".chr(strlen($v)).$v;};$x=$integer(substr($s,0,32)).$integer(substr($s,32,32));return "\x30".chr(strlen($x)).$x;}
$key=$proof['publicKey'];$point=decode30($key);$sig=decode30($proof['signature']);
if($point===false||strlen($point)!==65||ord($point[0])!==4||$sig===false||strlen($sig)!==64)out30(401,'unsupported-proof','Only raw P-256 wallet proofs supported');
$prefix=hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200');
$pem="-----BEGIN PUBLIC KEY-----\n".chunk_split(base64_encode($prefix.$point),64,"\n")."-----END PUBLIC KEY-----\n";
$pub=openssl_pkey_get_public($pem);
if(!$pub||openssl_verify(canon30($p),der30($sig),$pub,OPENSSL_ALGO_SHA256)!==1)out30(401,'bad-signature','Wallet signature invalid');
try {
 $reg=new PDO('sqlite:file:'.$private.'/coin26.sqlite?mode=ro',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
 $reg->exec('PRAGMA query_only=ON');
 $q=$reg->prepare('SELECT id,decimals FROM coins WHERE domain=? AND symbol=?');$q->execute([$host,$symbol]);$coin=$q->fetch(PDO::FETCH_ASSOC);
 if(!$coin)out30(404,'unknown-coin','Coin not registered on this domain');
 $db=new PDO('sqlite:'.$private.'/ledger29.sqlite',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_TIMEOUT=>5]);
 $db->exec('PRAGMA busy_timeout=5000');
 $db->exec('CREATE TABLE IF NOT EXISTS accounts (coin_id TEXT NOT NULL, owner_key TEXT NOT NULL, amount_units INTEGER NOT NULL DEFAULT 0 CHECK(amount_units>=0), PRIMARY KEY(coin_id,owner_key))');
 $db->exec('CREATE TABLE IF NOT EXISTS account30_nonces (owner_key TEXT NOT NULL, nonce TEXT NOT NULL, observed_at INTEGER NOT NULL, PRIMARY KEY(owner_key,nonce))');
 $db->exec('BEGIN IMMEDIATE');
 try{
 $db->prepare('DELETE FROM account30_nonces WHERE observed_at<?')->execute([time()-600]);
 $q=$db->prepare('INSERT OR IGNORE INTO account30_nonces(owner_key,nonce,observed_at) VALUES(?,?,?)');$q->execute([$key,$nonce,time()]);
 if($q->rowCount()!==1){$db->exec('ROLLBACK');out30(409,'replayed-request','Signed request has already been used');}
 $q=$db->prepare('INSERT OR IGNORE INTO accounts(coin_id,owner_key,amount_units) VALUES(?,?,0)');$q->execute([$coin['id'],$key]);$created=$q->rowCount()===1;
 $db->exec('COMMIT');
 }catch(Throwable $e){$db->exec('ROLLBACK');throw $e;}
}catch(Throwable $e){out30(503,'unavailable','Could not access experimental ledger storage');}
$idData=['purpose'=>'atlas.ledger.account-id','v'=>1,'network'=>$network,'coin'=>$symbol,'owner'=>$key];
$id='urn:atlas:ledger-account:'.hash('sha256',canon30($idData));
out30($created?201:200,$created?'account-opened':'account-exists',$created?'Opened empty experimental account':'Existing account unchanged',[
 'accountId'=>$id,'network'=>$network,'coin'=>$symbol,'coinId'=>$coin['id'],'ownerKey'=>$key,'created'=>$created,
 'amount'=>'0','decimals'=>(int)$coin['decimals'],
 'warning'=>'Experimental only. No minted funds, signed account credential, recovery, settlement or finality.'
]);
