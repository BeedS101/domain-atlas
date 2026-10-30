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
    $json=json_encode($value,JSON_THROW_ON_ERROR);
    $written=0;
    while ($written < strlen($json)) {
      $n=fwrite($fp,substr($json,$written));
      if ($n===false || $n===0) throw new RuntimeException('challenge-write-failed');
      $written+=$n;
    }
    if (!fflush($fp)) throw new RuntimeException('challenge-write-failed');
    if (function_exists('fsync') && !fsync($fp)) throw new RuntimeException('challenge-sync-failed');
  } catch (Throwable $e) {
    fclose($fp);@unlink($path);throw $e;
  }
  fclose($fp);
  return ['nonce'=>$nonce,'expiresAt'=>$value['expiresAt']];
}


// Read an issued challenge under a shared lock. The signed response must later
// be verified and consumed with the exact same digest and recipient.
function atlas_studio_read_challenge($root, $nonce, $now = null) {
  $now = $now ?? time();
  if (!is_string($nonce) || !preg_match('/^[a-f0-9]{64}$/D', $nonce)) return null;
  $dir = atlas_studio_storage_bucket($root, 'tmp');
  $fp = @fopen($dir.'/mint-challenge-'.$nonce.'.json', 'r');
  if (!$fp) return null;
  try {
    if (!flock($fp, LOCK_SH)) return null;
    $raw = stream_get_contents($fp, 4097);
    if ($raw === false || strlen($raw) > 4096) return null;
    $challenge = json_decode($raw, true);
    if (!is_array($challenge) || ($challenge['nonce'] ?? null) !== $nonce ||
        ($challenge['state'] ?? null) !== 'issued' ||
        !is_string($challenge['designDigest'] ?? null) ||
        !is_string($challenge['recipient'] ?? null) ||
        !is_int($challenge['expiresAt'] ?? null) ||
        $challenge['expiresAt'] < $now) return null;
    return $challenge;
  } finally {
    flock($fp, LOCK_UN);
    fclose($fp);
  }
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
    $raw=stream_get_contents($fp,4097);
    if ($raw===false || strlen($raw)>4096) return false;
    $v=json_decode($raw,true);
    if (!is_array($v) || ($v['state']??null)!=='issued' ||
        ($v['nonce']??null)!==$nonce ||
        ($v['designDigest']??null)!==$designDigest ||
        ($v['recipient']??null)!==$recipient ||
        !is_int($v['expiresAt']??null) || $v['expiresAt']<$now) return false;
    $v['state']='consumed';
    rewind($fp);
    $json=json_encode($v,JSON_THROW_ON_ERROR);
    if (!ftruncate($fp,0)) throw new RuntimeException('challenge-consume-failed');
    $written=0;
    while ($written < strlen($json)) {
      $n=fwrite($fp,substr($json,$written));
      if ($n===false || $n===0) throw new RuntimeException('challenge-consume-failed');
      $written+=$n;
    }
    if (!fflush($fp)) throw new RuntimeException('challenge-consume-failed');
    if (function_exists('fsync') && !fsync($fp)) throw new RuntimeException('challenge-sync-failed');
    return true;
  } finally {flock($fp,LOCK_UN);fclose($fp);}
}
