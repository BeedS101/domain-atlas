<?php
declare(strict_types=1);
/**
 * Chainblock Labs 18 — isolated, test-only GOLD transfer.
 * Requires PHP >=8.1, OpenSSL, PDO_SQLITE. No real-value assets.
 * Private SQLite data lives ABOVE the website document root.
 */
ini_set('display_errors','0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
function out(int $status,array $value): never {http_response_code($status);echo json_encode($value,JSON_UNESCAPED_SLASHES);exit;}
if (!extension_loaded('openssl')||!extension_loaded('pdo_sqlite')) out(503,['ok'=>false,'error'=>'PHP OpenSSL and PDO_SQLITE are required']);
if (empty($_SERVER['HTTPS'])||$_SERVER['HTTPS']==='off') out(403,['ok'=>false,'error'=>'HTTPS required']);
$host=$_SERVER['HTTP_HOST']??'';
if(!preg_match('/^[a-z0-9.-]+(?::[0-9]{1,5})?$/iD',$host)) out(400,['ok'=>false,'error'=>'Invalid host']);
$origin='https://'.$host;
$root=realpath($_SERVER['DOCUMENT_ROOT']??'');
if(!$root) out(503,['ok'=>false,'error'=>'Document root unavailable']);
$privateDir=dirname($root).DIRECTORY_SEPARATOR.'chainblock-labs-private';
if(is_dir($privateDir)===false && !@mkdir($privateDir,0700,true)) out(503,['ok'=>false,'error'=>'Cannot create private storage outside public_html; ask hosting support or configure permissions']);
if(realpath($privateDir)===false || str_starts_with(realpath($privateDir).DIRECTORY_SEPARATOR,$root.DIRECTORY_SEPARATOR))out(503,['ok'=>false,'error'=>'Unsafe storage path']);
@chmod($privateDir,0700);
try{
  $db=new PDO('sqlite:'.$privateDir.'/chainlabs17.sqlite',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_TIMEOUT=>5]);
  $db->exec('PRAGMA busy_timeout=5000');
  $db->exec('CREATE TABLE IF NOT EXISTS accounts (public_key TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0))');
  $db->exec('CREATE TABLE IF NOT EXISTS claims (public_key TEXT PRIMARY KEY, claimed_at TEXT NOT NULL, tx_id TEXT NOT NULL UNIQUE)');
}catch(Throwable $e){out(503,['ok'=>false,'error'=>'Private SQLite storage unavailable; check PHP write permissions']);}
ini_set('session.use_strict_mode','1');
ini_set('session.use_only_cookies','1');
session_name('CBLAB17');
session_set_cookie_params(['lifetime'=>0,'path'=>'/chain-labs/','secure'=>true,'httponly'=>true,'samesite'=>'Strict']);
session_start();
function decodeUrl(mixed $value): string|false {
 if(!is_string($value)||$value===''||!preg_match('/^[A-Za-z0-9_-]+$/D',$value))return false;
 return base64_decode(strtr($value,'-_','+/').str_repeat('=',(4-strlen($value)%4)%4),true);
}
function derInt(string $num): string {$num=ltrim($num,"\x00");if($num==='')$num="\x00";if(ord($num[0])&128)$num="\x00".$num;return "\x02".chr(strlen($num)).$num;}
function toDer(string $sig): string|false {if(strlen($sig)!==64)return false;$body=derInt(substr($sig,0,32)).derInt(substr($sig,32,32));return "\x30".chr(strlen($body)).$body;}
function canonical(mixed $v): string {
 if(is_array($v)){if(array_is_list($v))return '['.implode(',',array_map('canonical',$v)).']';
 ksort($v,SORT_STRING);$parts=[];foreach($v as $k=>$x)$parts[]=json_encode((string)$k,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES).':'.canonical($x);
 return '{'.implode(',',$parts).'}';}
 return json_encode($v,JSON_THROW_ON_ERROR|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
}

$db->exec('CREATE TABLE IF NOT EXISTS transfers (tx_id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, amount INTEGER NOT NULL, created_at TEXT NOT NULL)');
function validKey(mixed $key): bool { $bytes=decodeUrl($key);return $bytes!==false&&strlen($bytes)===65&&ord($bytes[0])===4; }
$mode=$_GET['action']??'';
if($_SERVER['REQUEST_METHOD']==='GET'&&$mode==='history'){
 $key=$_GET['publicKey']??null;if(!validKey($key))out(400,['ok'=>false,'error'=>'Invalid public key']);
 $stmt=$db->prepare('SELECT tx_id,sender,recipient,amount,created_at FROM transfers WHERE sender=? OR recipient=? ORDER BY rowid DESC LIMIT 30');
 $stmt->execute([$key,$key]);out(200,['ok'=>true,'history'=>$stmt->fetchAll(PDO::FETCH_ASSOC)]);
}
if($_SERVER['REQUEST_METHOD']==='GET'&&$mode==='challenge'){
 $to=$_GET['to']??null;$amount=$_GET['amount']??null;
 if(!validKey($to)||!is_string($amount)||!preg_match('/^[1-9][0-9]?$/D',$amount)||(int)$amount>50)out(400,['ok'=>false,'error'=>'Recipient must be a P-256 wallet key; amount 1–50']);
 $payload=['purpose'=>'chainblock-test-transfer','demo'=>'chainblock-labs-18','network'=>'chainlabs17-'.$host,'origin'=>$origin,'asset'=>'TEST-GOLD','recipient'=>$to,'amount'=>(int)$amount,'nonce'=>bin2hex(random_bytes(32)),'at'=>gmdate('Y-m-d\TH:i:s\Z')];
 $_SESSION['transfer_challenge']=['payload'=>$payload,'created'=>time()];
 out(200,['ok'=>true,'challenge'=>$payload,'expiresInSeconds'=>120]);
}
if($_SERVER['REQUEST_METHOD']!=='POST'||$mode!=='submit')out(404,['ok'=>false,'error'=>'Unknown action']);
if(($_SERVER['HTTP_ORIGIN']??'')!==$origin)out(403,['ok'=>false,'error'=>'Origin mismatch']);
if((int)($_SERVER['CONTENT_LENGTH']??0)>8192)out(413,['ok'=>false,'error'=>'Request too large']);
$data=json_decode(file_get_contents('php://input',false,null,0,8193),true);
$pending=$_SESSION['transfer_challenge']??null;unset($_SESSION['transfer_challenge']);
if(!is_array($pending)||time()-($pending['created']??0)>120)out(400,['ok'=>false,'error'=>'Missing, used or expired challenge']);
$env=$data['envelope']??null;if(!is_array($env)||($env['signerRole']??null)!=='raw-ecdsa')out(400,['ok'=>false,'error'=>'Only raw-ecdsa supported in this lab']);
$sender=$env['publicKey']??null;$rawKey=decodeUrl($sender);$rawSig=decodeUrl($env['signature']??null);
if(!validKey($sender)||$rawSig===false||strlen($rawSig)!==64)out(400,['ok'=>false,'error'=>'Malformed wallet signature']);
$prefix=hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200');
$pem="-----BEGIN PUBLIC KEY-----\n".chunk_split(base64_encode($prefix.$rawKey),64,"\n")."-----END PUBLIC KEY-----\n";
$pub=openssl_pkey_get_public($pem);$der=toDer($rawSig);
// The wallet signs a page's payload wrapped as {ctx, origin, payload} (SPEC.md §3.8.1), never bare.
$signed=['ctx'=>'atlas.bridge.sign/1','origin'=>$origin,'payload'=>$pending['payload']];
if($pub===false||$der===false||openssl_verify(canonical($signed),$der,$pub,OPENSSL_ALGO_SHA256)!==1)out(401,['ok'=>false,'error'=>'Signature failed verification']);
$p=$pending['payload'];$to=$p['recipient'];$amount=$p['amount'];
if(hash_equals($sender,$to))out(400,['ok'=>false,'error'=>'Cannot transfer to yourself']);
try{
 $db->exec('BEGIN IMMEDIATE');
 $stmt=$db->prepare('UPDATE accounts SET balance=balance-? WHERE public_key=? AND balance>=?');
 $stmt->execute([$amount,$sender,$amount]);
 if($stmt->rowCount()!==1){$db->rollBack();out(409,['ok'=>false,'error'=>'Insufficient TEST-GOLD balance']);}
 $stmt=$db->prepare('INSERT OR IGNORE INTO accounts(public_key,balance) VALUES(?,0)');$stmt->execute([$to]);
 $stmt=$db->prepare('UPDATE accounts SET balance=balance+? WHERE public_key=?');$stmt->execute([$amount,$to]);
 $tx=bin2hex(random_bytes(16));
 $stmt=$db->prepare('INSERT INTO transfers(tx_id,sender,recipient,amount,created_at) VALUES(?,?,?,?,?)');
 $stmt->execute([$tx,$sender,$to,$amount,gmdate('c')]);
 $db->exec('COMMIT');
 out(200,['ok'=>true,'receipt'=>$tx,'amount'=>$amount,'sender'=>$sender,'recipient'=>$to,'warning'=>'Single PHP SQLite node; no BFT consensus or distributed finality']);
}catch(Throwable $e){if($db->inTransaction())$db->rollBack();out(500,['ok'=>false,'error'=>'Transfer failed; no confirmed settlement']);}
