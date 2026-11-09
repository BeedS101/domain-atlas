<?php
declare(strict_types=1);
// Chainblock Labs 16 — TEST-ONLY wallet challenge verifier.
// No ledger access, asset issuance, sessions granting spending power, or persistence.
ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
if (!extension_loaded('openssl')) { http_response_code(503); echo json_encode(['ok'=>false,'error'=>'PHP OpenSSL unavailable']); exit; }
ini_set('session.use_strict_mode','1');
ini_set('session.use_only_cookies','1');
session_name('CBMARKET28');
session_set_cookie_params(['lifetime'=>0,'path'=>'/chain-labs/','secure'=>true,'httponly'=>true,'samesite'=>'Strict']);
session_start();
function response(int $status,array $v): never { http_response_code($status); echo json_encode($v,JSON_UNESCAPED_SLASHES); exit; }
function decodeUrl(string $v): string|false {
    if ($v==='' || !preg_match('/^[A-Za-z0-9_-]+$/D',$v)) return false;
    return base64_decode(strtr($v,'-_','+/').str_repeat('=',(4-strlen($v)%4)%4),true);
}
function derInteger(string $v): string {
    $v=ltrim($v,"\x00"); if ($v==='') $v="\x00";
    if ((ord($v[0]) & 0x80)!==0) $v="\x00".$v;
    return "\x02".chr(strlen($v)).$v;
}
function rawSigToDer(string $raw): string|false {
    if(strlen($raw)!==64) return false;
    $seq=derInteger(substr($raw,0,32)).derInteger(substr($raw,32,32));
    return "\x30".chr(strlen($seq)).$seq;
}
function canonical(mixed $v): string {
    if (is_array($v)) {
        if(array_is_list($v)) return '['.implode(',',array_map('canonical',$v)).']';
        ksort($v,SORT_STRING);
        $parts=[]; foreach($v as $k=>$x) $parts[]=json_encode((string)$k,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE).':'.canonical($x);
        return '{'.implode(',',$parts).'}';
    }
    return json_encode($v,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
}
if ($_SERVER['REQUEST_METHOD']==='GET' && ($_GET['action']??'')==='status') {
    $logged=$_SESSION['market_identity']??null;
    response(200,['ok'=>true,'loggedIn'=>is_string($logged)&&$logged!=='','publicKey'=>is_string($logged)?$logged:null]);
}
if ($_SERVER['REQUEST_METHOD']==='GET' && ($_GET['action']??'')==='challenge') {
    $payload=['purpose'=>'demo-login','nonce'=>bin2hex(random_bytes(24)),'at'=>gmdate('Y-m-d\TH:i:s\Z'),'demo'=>'chainblock-market-28-login','origin'=>'https://'.($_SERVER['HTTP_HOST']??'')];
    $_SESSION['challenge']=['payload'=>$payload,'issued'=>time()];
    response(200,['ok'=>true,'challenge'=>$payload,'expiresInSeconds'=>120]);
}
if ($_SERVER['REQUEST_METHOD']!=='POST') response(405,['ok'=>false,'error'=>'Use GET challenge/status or POST verify/logout']);
$origin=$_SERVER['HTTP_ORIGIN']??'';
$host=$_SERVER['HTTP_HOST']??'';
if($origin!=='https://'.$host) response(403,['ok'=>false,'error'=>'Origin mismatch']);
if((int)($_SERVER['CONTENT_LENGTH']??0)>8192) response(413,['ok'=>false,'error'=>'Too large']);
$data=json_decode(file_get_contents('php://input',false,null,0,8193),true);
if(($_GET['action']??'')==='logout'){unset($_SESSION['market_identity'],$_SESSION['challenge']);response(200,['ok'=>true,'loggedIn'=>false]);}
if(($_GET['action']??'')!=='verify')response(404,['ok'=>false,'error'=>'Unknown action']);
$pending=$_SESSION['challenge']??null;
unset($_SESSION['challenge']); // single attempt regardless of verification result
if(!is_array($pending) || time()-($pending['issued']??0)>120) response(400,['ok'=>false,'error'=>'Missing or expired challenge']);
if(!is_array($data)) response(400,['ok'=>false,'error'=>'Invalid JSON']);
$env=$data['envelope']??null;
if(!is_array($env) || ($env['signerRole']??null)!=='raw-ecdsa') response(400,['ok'=>false,'error'=>'This experiment supports raw-ecdsa only']);
$key=isset($env['publicKey'])&&is_string($env['publicKey'])?decodeUrl($env['publicKey']):false;
$sig=isset($env['signature'])&&is_string($env['signature'])?decodeUrl($env['signature']):false;
if($key===false||strlen($key)!==65||ord($key[0])!==4||$sig===false||strlen($sig)!==64) response(400,['ok'=>false,'error'=>'Malformed public key or signature']);
// SPKI P-256 uncompressed point prefix: SEQUENCE(algorithm ecPublicKey + prime256v1, BIT STRING)
$prefix=hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200');
$pem="-----BEGIN PUBLIC KEY-----\n".chunk_split(base64_encode($prefix.$key),64,"\n")."-----END PUBLIC KEY-----\n";
$public=openssl_pkey_get_public($pem);
$der=rawSigToDer($sig);
if($public===false || $der===false) response(400,['ok'=>false,'error'=>'Invalid public key or signature']);
// The wallet signs a page's payload wrapped as {ctx, origin, payload} (SPEC.md §3.8.1), never bare.
$signed=['ctx'=>'atlas.bridge.sign/1','origin'=>'https://'.$host,'payload'=>$pending['payload']];
$verified=openssl_verify(canonical($signed),$der,$public,OPENSSL_ALGO_SHA256)===1;
if(!$verified) response(401,['ok'=>false,'error'=>'Signature did not verify']);
session_regenerate_id(true);
$_SESSION['market_identity']=$env['publicKey'];
response(200,['ok'=>true,'verified'=>true,'loggedIn'=>true,'publicKey'=>$env['publicKey'],'message'=>'Wallet identity verified. No payment authority or spending rights.']);
