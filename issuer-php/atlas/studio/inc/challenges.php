<?php
// Single-use Studio proof challenges. Local private storage only.
// Does not authorize issuance or verify signatures. No public route enabled.
require_once __DIR__.'/storage.php';

function atlas_studio_new_challenge($root, $designDigest, $recipient, $now = null) {
  $now = $now ?? time();
  if (!is_string($designDigest) || !preg_match('/^[a-f0-9]{64}$/D', $designDigest)) throw new InvalidArgumentException('invalid-digest');
  if (!is_string($recipient) || strlen($recipient)<20 || strlen($recipient)>2048) throw new InvalidArgumentException('invalid-recipient');
  $dir=atlas_studio_storage_bucket($root,'tmp');
  $nonce=bin2hex(random_bytes(32));
  $path=$dir.'/mint-challenge-'.$nonce.'.json';
  $value=['nonce'=>$nonce,'designDigest'=>$designDigest,'recipient'=>$recipient,'expiresAt'=>$now+120,'state'=>'issued'];
  $fp=@fopen($path,'x');
  if (!$fp) throw new RuntimeException('challenge-create-failed');
  try {
    @chmod($path,0600);
    if (fwrite($fp,json_encode($value,JSON_THROW_ON_ERROR))===false || !fflush($fp)) throw new RuntimeException('challenge-write-failed');
  } catch (Throwable $e) {
    fclose($fp);@unlink($path);throw $e;
  }
  fclose($fp);
  return ['nonce'=>$nonce,'expiresAt'=>$value['expiresAt']];
}

// Consume only AFTER cryptographic verification. Lock + update before issuing.
// A crash after consumption fails closed. Idempotent mint recovery is future work.
function atlas_studio_consume_challenge($root,$nonce,$designDigest,$recipient,$now=null) {
  $now=$now ?? time();
  if (!is_string($nonce) || !preg_match('/^[a-f0-9]{64}$/D',$nonce)) return false;
  $dir=atlas_studio_storage_bucket($root,'tmp');
  $fp=@fopen($dir.'/mint-challenge-'.$nonce.'.json','r+');
  if (!$fp) return false;
  try {
    if (!flock($fp,LOCK_EX)) return false;
    $v=json_decode(stream_get_contents($fp),true);
    if (!is_array($v) || ($v['state']??null)!=='issued' ||
        ($v['nonce']??null)!==$nonce ||
        ($v['designDigest']??null)!==$designDigest ||
        ($v['recipient']??null)!==$recipient ||
        !is_int($v['expiresAt']??null) || $v['expiresAt']<$now) return false;
    $v['state']='consumed';
    rewind($fp);
    $json=json_encode($v,JSON_THROW_ON_ERROR);
    if (!ftruncate($fp,0) || fwrite($fp,$json)!==strlen($json) || !fflush($fp)) throw new RuntimeException('challenge-consume-failed');
    return true;
  } finally {flock($fp,LOCK_UN);fclose($fp);}
}
