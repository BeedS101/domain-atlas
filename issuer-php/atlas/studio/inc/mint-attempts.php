<?php
// Studio mint-attempt journal, intentionally NOT wired to an issuer.
// A claimed attempt is never automatically reissued after interruption.
// No promise of atomicity with the existing issuer holdings/supply ledger.
require_once __DIR__.'/storage.php';

function atlas_studio_attempt_path($root, $nonce) {
  if (!is_string($nonce) || !preg_match('/^[a-f0-9]{64}$/D', $nonce)) throw new InvalidArgumentException('invalid-attempt-id');
  return atlas_studio_storage_bucket($root, 'mint-receipts').'/attempt-'.$nonce.'.json';
}

function atlas_studio_attempt_write($handle, $record) {
  $json=json_encode($record, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
  if (strlen($json)>4096) throw new RuntimeException('attempt-record-too-large');
  if (!rewind($handle) || !ftruncate($handle,0)) throw new RuntimeException('attempt-write-failed');
  $written=0;
  while ($written<strlen($json)) {
    $n=fwrite($handle, substr($json,$written));
    if ($n===false || $n===0) throw new RuntimeException('attempt-write-failed');
    $written+=$n;
  }
  if (!fflush($handle) || (function_exists('fsync') && !fsync($handle))) throw new RuntimeException('attempt-sync-failed');
}

// Claim one attempt under an exclusive lock, keyed by server nonce.
// Existing file: refuse reissue, even when incomplete or corrupted.
// On failed write, leave the file present so recovery requires inspection.
function atlas_studio_claim_attempt($root, $nonce, $designDigest, $recipient) {
  if (!is_string($designDigest) || !preg_match('/^[a-f0-9]{64}$/D',$designDigest) ||
      !is_string($recipient) || strlen($recipient)<20 || strlen($recipient)>2048)
    throw new InvalidArgumentException('invalid-attempt-binding');
  $path=atlas_studio_attempt_path($root,$nonce);
  $handle=@fopen($path,'x');
  if (!$handle) return ['ok'=>false,'error'=>'attempt-already-exists-or-unavailable'];
  try {
    if (!flock($handle,LOCK_EX)) throw new RuntimeException('attempt-lock-failed');
    @chmod($path,0600);
    atlas_studio_attempt_write($handle,[
      'version'=>1,'nonce'=>$nonce,'designDigest'=>$designDigest,
      'recipient'=>$recipient,'state'=>'pending-reconciliation'
    ]);
  } finally {flock($handle,LOCK_UN);fclose($handle);}
  return ['ok'=>true,'state'=>'pending-reconciliation'];
}

// Read-only for operator reconciliation. Never turn a pending attempt into
// a fresh mint on restart; issuer records must be reconciled independently.
function atlas_studio_read_attempt($root,$nonce) {
  $path=atlas_studio_attempt_path($root,$nonce);
  $handle=@fopen($path,'r');
  if (!$handle) return null;
  try {
    if (!flock($handle,LOCK_SH)) return null;
    $raw=stream_get_contents($handle,4097);
    if ($raw===false || strlen($raw)>4096) return null;
    $record=json_decode($raw,true);
    if (!is_array($record) || ($record['version']??null)!==1 ||
        ($record['nonce']??null)!==$nonce ||
        ($record['state']??null)!=='pending-reconciliation' ||
        !is_string($record['designDigest']??null) ||
        !is_string($record['recipient']??null)) return null;
    return $record;
  } finally {flock($handle,LOCK_UN);fclose($handle);}
}
