<?php
declare(strict_types=1);
/** Chainblock Labs 29: read-only account prototype, isolated from existing GOLD and coin registry.
 * Existing Labs 26 allocations are NOT credited to user wallets.
 */
ini_set('display_errors','0');header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');header('X-Content-Type-Options: nosniff');
function respond29(int $code,array $body):never{http_response_code($code);echo json_encode($body,JSON_UNESCAPED_SLASHES);exit;}
if(!extension_loaded('pdo_sqlite')||!extension_loaded('openssl'))respond29(503,['ok'=>false,'error'=>'OpenSSL and PDO_SQLITE required']);
if(empty($_SERVER['HTTPS'])||$_SERVER['HTTPS']==='off')respond29(403,['ok'=>false,'error'=>'HTTPS required']);
$host=strtolower($_SERVER['HTTP_HOST']??'');
if(!in_array($host,['evtec.co.za','domain-atlas.co.za'],true))respond29(400,['ok'=>false,'error'=>'Unknown host']);
$doc=realpath($_SERVER['DOCUMENT_ROOT']??'');$private=$doc?realpath(dirname($doc).'/chainblock-labs-private'):false;
if(!$private||str_starts_with($private.'/',$doc.'/'))respond29(503,['ok'=>false,'error'=>'Private storage unavailable']);
$path=$private.'/coin26.sqlite';
if(!is_file($path))respond29(503,['ok'=>false,'error'=>'Coin registry unavailable']);
try{
 $registry=new PDO('sqlite:file:'.$path.'?mode=ro',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_TIMEOUT=>5]);
 $registry->exec('PRAGMA query_only=ON');
 // Ledger29 has NO automatic minting. This table exists only for future controlled deposits.
 $ledger=new PDO('sqlite:'.$private.'/ledger29.sqlite',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_TIMEOUT=>5]);
 $ledger->exec('CREATE TABLE IF NOT EXISTS accounts (coin_id TEXT NOT NULL, owner_key TEXT NOT NULL, amount_units INTEGER NOT NULL DEFAULT 0 CHECK(amount_units>=0), PRIMARY KEY(coin_id,owner_key))');
 $ledger->exec('PRAGMA query_only=ON');
}catch(Throwable $e){respond29(503,['ok'=>false,'error'=>'Ledger storage unavailable']);}
function b64d29(mixed $v):string|false{
 if(!is_string($v)||!preg_match('/^[A-Za-z0-9_-]{1,200}$/D',$v))return false;
 return base64_decode(strtr($v,'-_','+/').str_repeat('=',(4-strlen($v)%4)%4),true);
}
function canonical29(mixed $v):string{
 if(is_array($v)){if(array_is_list($v))return '['.implode(',',array_map('canonical29',$v)).']';
  ksort($v,SORT_STRING);$arr=[];foreach($v as $k=>$a)$arr[]=json_encode((string)$k,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES).':'.canonical29($a);
  return '{'.implode(',',$arr).'}';}
 return json_encode($v,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR);
}
function rawDer29(string $sig):string|false{
 if(strlen($sig)!==64)return false;
 $make=function(string $a):string{$a=ltrim($a,"\x00");if($a==='')$a="\x00";if((ord($a[0])&128)!==0)$a="\x00".$a;return "\x02".chr(strlen($a)).$a;};
 $seq=$make(substr($sig,0,32)).$make(substr($sig,32,32));return "\x30".chr(strlen($seq)).$seq;
}
$action=$_GET['action']??'';
if($_SERVER['REQUEST_METHOD']==='GET'&&$action==='discovery')
 respond29(200,['ok'=>true,'contract'=>'chainblock-ledger29/experimental','endpoint'=>'https://'.$host.'/chain-labs/ledger29.php','operations'=>['balance'=>'https://'.$host.'/chain-labs/ledger29.php?action=balance'],'network'=>'chainblock-labs29-'.$host,'issuer'=>$host,'signedDiscovery'=>false,'warning'=>'Experimental endpoint; not yet a signed well-known document']);
if($_SERVER['REQUEST_METHOD']!=='POST'||$action!=='balance')respond29(404,['ok'=>false,'error'=>'Unknown operation']);
if((int)($_SERVER['CONTENT_LENGTH']??0)>4096)respond29(413,['ok'=>false,'error'=>'Request too large']);
$request=json_decode(file_get_contents('php://input',false,null,0,4097),true);
$p=is_array($request)?($request['payload']??null):null;$proof=is_array($request)?($request['proof']??null):null;
if(!is_array($p)||!is_array($proof))respond29(400,['ok'=>false,'error'=>'Expected signed request']);
if(array_diff(array_keys($p),['type','v','audience','network','coin','nonce','issuedAt'])||array_diff(['type','v','audience','network','coin','nonce','issuedAt'],array_keys($p)))respond29(400,['ok'=>false,'code'=>'malformed-request','error'=>'Unexpected payload shape']);
$network='chainblock-labs29-'.$host;
if(($p['type']??null)!=='atlas.ledger.balance'||($p['v']??null)!==1||($p['audience']??null)!=='https://'.$host.'/chain-labs/ledger29.php?action=balance'
 ||($p['network']??null)!==$network||!is_string($p['coin']??null)||!preg_match('/^[A-Z][A-Z0-9]{1,9}$/D',$p['coin'])
 ||!is_string($p['nonce']??null)||!preg_match('/^[a-f0-9]{32,64}$/D',$p['nonce'])
 ||!is_string($p['issuedAt']??null)||!preg_match('/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/D',$p['issuedAt'])||abs(time()-strtotime($p['issuedAt']))>120)
 respond29(401,['ok'=>false,'error'=>'Invalid balance challenge']);
$key=$proof['publicKey']??null;$point=b64d29($key);$sig=b64d29($proof['signature']??null);
if($point!==false&&rtrim(strtr(base64_encode($point),'+/','-_'),'=')!==$key)respond29(401,['ok'=>false,'code'=>'bad-signature','error'=>'Non-canonical identity key']);
if($point===false||strlen($point)!==65||ord($point[0])!==4||$sig===false||strlen($sig)!==64)respond29(401,['ok'=>false,'code'=>'unsupported-proof','error'=>'Malformed or unsupported identity proof']);
$prefix=hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200');
$pem="-----BEGIN PUBLIC KEY-----\n".chunk_split(base64_encode($prefix.$point),64,"\n")."-----END PUBLIC KEY-----\n";
$pub=openssl_pkey_get_public($pem);$der=rawDer29($sig);
if(!$pub||$der===false||openssl_verify(canonical29($p),$der,$pub,OPENSSL_ALGO_SHA256)!==1)
 respond29(401,['ok'=>false,'code'=>'bad-signature','error'=>'Wallet signature verification failed']);
$q=$registry->prepare('SELECT id,decimals FROM coins WHERE domain=? AND symbol=?');$q->execute([$host,$p['coin']]);$coin=$q->fetch(PDO::FETCH_ASSOC);
if(!$coin)respond29(404,['ok'=>false,'code'=>'unknown-coin','error'=>'Coin not registered on this domain']);
$q=$ledger->prepare('SELECT amount_units FROM accounts WHERE coin_id=? AND owner_key=?');$q->execute([$coin['id'],$key]);$value=$q->fetchColumn();
if($value===false)respond29(404,['ok'=>false,'code'=>'no-account','error'=>'No ledger account for this wallet identity','note'=>'Coin exists but a wallet account has not been funded or provisioned']);
respond29(200,['ok'=>true,'amount'=>(string)$value,'decimals'=>(int)$coin['decimals'],'asOf'=>gmdate('Y-m-d\TH:i:s\Z'),'network'=>$network,'coin'=>$p['coin'],'ownerKey'=>$key,'verifiedRequest'=>true,'balanceProof'=>'TLS-only; signed ledger-state receipts not yet implemented','warning'=>'Labs 29 prototype; no finality']);
