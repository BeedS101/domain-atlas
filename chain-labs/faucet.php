<?php
declare(strict_types=1);
/**
 * Chainblock Labs 17 — isolated, test-only GOLD faucet.
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
$mode=$_GET['action']??'';
if($_SERVER['REQUEST_METHOD']==='GET' && $mode==='status'){
 out(200,['ok'=>true,'network'=>'chainlabs17-'.$host,'asset'=>'TEST-GOLD','faucetAmount'=>50,'consensus'=>'single PHP SQLite node; NO BFT or finality','warning'=>'Experimental test units have no monetary value']);
}
if($_SERVER['REQUEST_METHOD']==='GET' && $mode==='balance'){
 $key=$_GET['publicKey']??null;
 $bytes=decodeUrl($key);
 if($bytes===false||strlen($bytes)!==65||ord($bytes[0])!==4)out(400,['ok'=>false,'error'=>'Malformed public key']);
 $stmt=$db->prepare('SELECT balance FROM accounts WHERE public_key=?');$stmt->execute([$key]);
 $value=$stmt->fetchColumn();
 out(200,['ok'=>true,'asset'=>'TEST-GOLD','balance'=>$value===false?0:(int)$value,'network'=>'chainlabs17-'.$host]);
}
if($_SERVER['REQUEST_METHOD']==='GET' && $mode==='challenge'){
 $challenge=['purpose'=>'demo-login','demo'=>'chainblock-labs-17-faucet','action'=>'claim-50-test-gold','network'=>'chainlabs17-'.$host,'origin'=>$origin,'nonce'=>bin2hex(random_bytes(32)),'at'=>gmdate('Y-m-d\TH:i:s\Z')];
 $_SESSION['faucet_challenge']=['payload'=>$challenge,'created'=>time()];
 out(200,['ok'=>true,'challenge'=>$challenge,'expirySeconds'=>120]);
}
if($_SERVER['REQUEST_METHOD']!=='POST'||$mode!=='claim')out(404,['ok'=>false,'error'=>'Unknown action']);
if(($_SERVER['HTTP_ORIGIN']??'')!==$origin)out(403,['ok'=>false,'error'=>'Origin mismatch']);
if((int)($_SERVER['CONTENT_LENGTH']??0)>8192)out(413,['ok'=>false,'error'=>'Request too large']);
$data=json_decode(file_get_contents('php://input',false,null,0,8193),true);
$pending=$_SESSION['faucet_challenge']??null;
unset($_SESSION['faucet_challenge']); // consume BEFORE signature check, including failures
if(!is_array($pending)||time()-($pending['created']??0)>120)out(400,['ok'=>false,'error'=>'Missing, used or expired challenge']);
$env=$data['envelope']??null;
if(!is_array($env)||($env['signerRole']??null)!=='raw-ecdsa')out(400,['ok'=>false,'error'=>'This Lab supports raw-ecdsa only']);
$key=$env['publicKey']??null;
$rawKey=decodeUrl($key);$rawSig=decodeUrl($env['signature']??null);
if($rawKey===false||strlen($rawKey)!==65||ord($rawKey[0])!==4||$rawSig===false||strlen($rawSig)!==64)out(400,['ok'=>false,'error'=>'Malformed signature']);
$prefix=hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200');
$pem="-----BEGIN PUBLIC KEY-----\n".chunk_split(base64_encode($prefix.$rawKey),64,"\n")."-----END PUBLIC KEY-----\n";
$pub=openssl_pkey_get_public($pem);$der=toDer($rawSig);
// The wallet signs a page's payload wrapped as {ctx, origin, payload} (SPEC.md §3.8.1), never bare.
$signed=['ctx'=>'atlas.bridge.sign/1','origin'=>$origin,'payload'=>$pending['payload']];
if($pub===false||$der===false||openssl_verify(canonical($signed),$der,$pub,OPENSSL_ALGO_SHA256)!==1)out(401,['ok'=>false,'error'=>'Wallet signature failed verification']);
try{
 $db->exec('BEGIN IMMEDIATE');
 $stmt=$db->prepare('SELECT tx_id FROM claims WHERE public_key=?');$stmt->execute([$key]);$previous=$stmt->fetchColumn();
 if($previous!==false){$db->exec('COMMIT');out(200,['ok'=>true,'alreadyClaimed'=>true,'receipt'=>$previous,'message'=>'This wallet has already claimed its faucet allocation']);}
 $tx=bin2hex(random_bytes(16));
 $stmt=$db->prepare('INSERT OR IGNORE INTO accounts(public_key,balance) VALUES(?,0)');$stmt->execute([$key]);
 $stmt=$db->prepare('UPDATE accounts SET balance=balance+50 WHERE public_key=?');$stmt->execute([$key]);
 $stmt=$db->prepare('INSERT INTO claims(public_key,claimed_at,tx_id) VALUES(?,?,?)');$stmt->execute([$key,gmdate('c'),$tx]);
 $db->exec('COMMIT');
 out(200,['ok'=>true,'claimed'=>50,'asset'=>'TEST-GOLD','receipt'=>$tx,'balance'=>50,'message'=>'Test GOLD claimed on this standalone PHP node; no validator quorum']);
}catch(Throwable $e){if($db->inTransaction())$db->rollBack();out(500,['ok'=>false,'error'=>'Faucet failed; no confirmed credit']);}
