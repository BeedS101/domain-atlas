<?php
declare(strict_types=1);
/** Labs 26 — isolated experimental coin genesis studio. No wallet or ledger integration. */
ini_set('display_errors','0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
function done26(int $s,array $v): never{http_response_code($s);echo json_encode($v,JSON_UNESCAPED_SLASHES);exit;}
if(!extension_loaded('pdo_sqlite'))done26(503,['ok'=>false,'error'=>'PDO SQLite required']);
if(empty($_SERVER['HTTPS'])||$_SERVER['HTTPS']==='off')done26(403,['ok'=>false,'error'=>'HTTPS required']);
$host=strtolower($_SERVER['HTTP_HOST']??'');
if(!in_array($host,['evtec.co.za','domain-atlas.co.za'],true))done26(400,['ok'=>false,'error'=>'Unrecognized host']);
$origin='https://'.$host;
$root=realpath($_SERVER['DOCUMENT_ROOT']??'');$private=$root?realpath(dirname($root).'/chainblock-labs-private'):false;
if(!$private||str_starts_with($private.'/',$root.'/'))done26(503,['ok'=>false,'error'=>'Missing private storage']);
$config=$private.'/federation20-config.php';
if(!is_file($config))done26(503,['ok'=>false,'error'=>'Labs 20 private operator config missing']);
$c=require $config;$admin=is_array($c)?($c['admin_token_hex']??null):null;
if(!is_string($admin)||!preg_match('/^[0-9a-f]{64}$/D',$admin))done26(503,['ok'=>false,'error'=>'Invalid operator configuration']);
try{
 $db=new PDO('sqlite:'.$private.'/coin26.sqlite',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_TIMEOUT=>5]);
 $db->exec('PRAGMA busy_timeout=5000');
 $db->exec('CREATE TABLE IF NOT EXISTS coins(id TEXT PRIMARY KEY,domain TEXT NOT NULL,name TEXT NOT NULL,symbol TEXT NOT NULL,decimals INTEGER NOT NULL,max_units INTEGER NOT NULL,initial_units INTEGER NOT NULL,treasury_units INTEGER NOT NULL,description TEXT NOT NULL,created_at TEXT NOT NULL,genesis_hash TEXT NOT NULL UNIQUE,UNIQUE(domain,symbol),CHECK(initial_units<=max_units),CHECK(treasury_units=initial_units))');
}catch(Throwable $e){done26(503,['ok'=>false,'error'=>'Cannot open isolated coin registry']);}
function display26(int $units,int $decimals):string{
 if(!$decimals)return (string)$units;
 $s=str_pad((string)$units,$decimals+1,'0',STR_PAD_LEFT);
 return substr($s,0,-$decimals).'.'.substr($s,-$decimals);
}
function units26(mixed $raw,int $d):int|false{
 if(!is_string($raw)||!preg_match('/^(0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/D',$raw))return false;
 $parts=explode('.',$raw,2);$fraction=$parts[1]??'';
 if(strlen($fraction)>$d)return false;
 $u=(int)$parts[0]*(10**$d)+(int)str_pad($fraction,$d,'0');
 return $u>=0&&$u<=1000000000000?$u:false;
}
$action=$_GET['action']??'';
if($_SERVER['REQUEST_METHOD']==='GET'&&$action==='list'){
 $rows=$db->query('SELECT id,domain,name,symbol,decimals,max_units,initial_units,treasury_units,description,created_at,genesis_hash FROM coins ORDER BY rowid DESC LIMIT 40')->fetchAll(PDO::FETCH_ASSOC);
 $coins=[];
 foreach($rows as $r)$coins[]=['id'=>$r['id'],'domain'=>$r['domain'],'name'=>$r['name'],'symbol'=>$r['symbol'],'decimals'=>(int)$r['decimals'],'maxSupply'=>display26((int)$r['max_units'],(int)$r['decimals']),'initialSupply'=>display26((int)$r['initial_units'],(int)$r['decimals']),'treasurySupply'=>display26((int)$r['treasury_units'],(int)$r['decimals']),'description'=>$r['description'],'createdAt'=>$r['created_at'],'genesisHash'=>$r['genesis_hash']];
 done26(200,['ok'=>true,'node'=>$host,'coins'=>$coins,'testOnly'=>true,'notice'=>'Local unsigned demo registry; not minted into wallet balances']);
}
if($_SERVER['REQUEST_METHOD']!=='POST'||$action!=='create')done26(404,['ok'=>false,'error'=>'Unknown action']);
if(($_SERVER['HTTP_ORIGIN']??'')!==$origin)done26(403,['ok'=>false,'error'=>'Origin mismatch']);
if((int)($_SERVER['CONTENT_LENGTH']??0)>4096)done26(413,['ok'=>false,'error'=>'Request too large']);
$m=json_decode(file_get_contents('php://input',false,null,0,4097),true);
if(!is_array($m))done26(400,['ok'=>false,'error'=>'Invalid JSON']);
$t=$m['adminToken']??null;
if(!is_string($t)||!preg_match('/^[0-9a-f]{64}$/D',$t)||!hash_equals($admin,$t))done26(403,['ok'=>false,'error'=>'Incorrect operator token']);
$name=trim((string)($m['name']??''));$symbol=strtoupper(trim((string)($m['symbol']??'')));$description=trim((string)($m['description']??''));
$d=$m['decimals']??null;
if(!preg_match('/^[A-Za-z0-9][A-Za-z0-9 ._-]{1,39}$/D',$name)||!preg_match('/^[A-Z][A-Z0-9]{1,9}$/D',$symbol)||!is_int($d)||$d<0||$d>6||strlen($description)>280||preg_match('/[\x00-\x1F\x7F]/',$description))done26(400,['ok'=>false,'error'=>'Invalid name, symbol, decimals or description']);
$max=units26($m['maxSupply']??null,$d);$initial=units26($m['initialSupply']??null,$d);
if($max===false||$initial===false||$max<1||$initial>$max)done26(400,['ok'=>false,'error'=>'Supply invalid: enter nonnegative exact decimals, initial <= max, max > 0, at most 1 trillion base units']);
$id=bin2hex(random_bytes(16));$created=gmdate('Y-m-d\TH:i:s\Z');
$genesis=['type'=>'chainblock-labs26-demo-coin','version'=>1,'id'=>$id,'domain'=>$host,'name'=>$name,'symbol'=>$symbol,'decimals'=>$d,'maxUnits'=>$max,'initialUnits'=>$initial,'description'=>$description,'createdAt'=>$created];
$hash=hash('sha256',json_encode($genesis,JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR));
try{
 $q=$db->prepare('INSERT INTO coins (id,domain,name,symbol,decimals,max_units,initial_units,treasury_units,description,created_at,genesis_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
 $q->execute([$id,$host,$name,$symbol,$d,$max,$initial,$initial,$description,$created,$hash]);
}catch(PDOException $e){if(str_contains($e->getMessage(),'UNIQUE'))done26(409,['ok'=>false,'error'=>'Symbol already registered on this domain']);done26(503,['ok'=>false,'error'=>'Could not save coin']);}
done26(201,['ok'=>true,'id'=>$id,'symbol'=>$symbol,'genesisHash'=>$hash,'maxSupply'=>display26($max,$d),'initialSupply'=>display26($initial,$d),'note'=>'Created only in local demo registry. Treasury amount is recorded, not spendable by any wallet.']);
