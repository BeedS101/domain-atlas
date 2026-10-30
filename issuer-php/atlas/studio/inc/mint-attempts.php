<?php
// Studio mint-attempt ledger: one record per challenge nonce ('mint-receipts' bucket).
//
// It does two jobs. It is the quota ledger (attempts per recipient and overall in a window, counted and
// claimed under one lock, so concurrent requests cannot overshoot), and it records the outcome of a nonce
// ('claimed', then 'minted' with the credential id). It is NOT what decides whether a credential exists:
// that is the issuer's transaction journal and replay record, so claiming never blocks a safe retry and a
// 'claimed' record left by a crash is reconciled by asking the issuer (studio-mint.php), not guessed at.
require_once __DIR__.'/storage.php';
require_once __DIR__.'/keys.php';

const ATLAS_STUDIO_ATTEMPT_MAX_BYTES = 4096;
const ATLAS_STUDIO_ATTEMPT_FILE_RE = '/^attempt-[a-f0-9]{64}\.json$/D';
const ATLAS_STUDIO_ATTEMPT_RETAIN_SECONDS = 2592000;

function atlas_studio_attempt_path($root, $nonce) {
  if (!is_string($nonce) || !preg_match('/^[a-f0-9]{64}$/D', $nonce)) throw new InvalidArgumentException('invalid-attempt-id');
  return atlas_studio_storage_bucket($root, 'mint-receipts').'/attempt-'.$nonce.'.json';
}

function atlas_studio_attempt_valid($r, $nonce) {
  return is_array($r) && ($r['version'] ?? null) === 2 && ($r['nonce'] ?? null) === $nonce &&
    in_array($r['state'] ?? null, ['claimed','minted'], true) &&
    is_string($r['designDigest'] ?? null) && is_string($r['recipient'] ?? null) && is_int($r['createdAt'] ?? null) &&
    (($r['state'] === 'claimed') || is_string($r['credentialId'] ?? null));
}

function atlas_studio_read_attempt_file($path, $nonce) {
  $fh = @fopen($path, 'r');
  if (!$fh) return null;
  try {
    if (!flock($fh, LOCK_SH)) return null;
    $raw = stream_get_contents($fh, ATLAS_STUDIO_ATTEMPT_MAX_BYTES + 1);
    if ($raw === false || strlen($raw) > ATLAS_STUDIO_ATTEMPT_MAX_BYTES) return null;
    $r = json_decode($raw, true);
    return atlas_studio_attempt_valid($r, $nonce) ? $r : null;
  } finally {
    flock($fh, LOCK_UN);
    fclose($fh);
  }
}

function atlas_studio_read_attempt($root, $nonce) {
  return atlas_studio_read_attempt_file(atlas_studio_attempt_path($root, $nonce), $nonce);
}

// Claims (or finds) the attempt for a nonce, enforcing quotas for NEW attempts only.
// $limits: perRecipient, global, windowSeconds. An existing attempt for this exact nonce, design and
// recipient is returned as is: that is a retry and is never counted twice. An existing file that cannot
// be read, or that names a different design or recipient, fails closed.
function atlas_studio_claim_attempt($root, $nonce, $designDigest, $recipient, $limits, $now = null) {
  $now = $now ?? time();
  if (!is_string($designDigest) || !preg_match('/^[a-f0-9]{64}$/D', $designDigest) || !atlas_studio_recipient_ok($recipient))
    throw new InvalidArgumentException('invalid-attempt-binding');
  $path = atlas_studio_attempt_path($root, $nonce);
  $dir = dirname($path);
  $lock = @fopen($dir.'/.quota.lock', 'c');
  if ($lock) @chmod($dir.'/.quota.lock', 0600);
  if (!$lock || !flock($lock, LOCK_EX)) { if ($lock) fclose($lock); throw new RuntimeException('attempt-lock-failed'); }
  try {
    if (file_exists($path)) {
      $r = atlas_studio_read_attempt_file($path, $nonce);
      if ($r === null) return ['ok'=>false,'error'=>'attempt-unreadable'];
      if ($r['designDigest'] !== $designDigest || $r['recipient'] !== $recipient) return ['ok'=>false,'error'=>'attempt-binding-mismatch'];
      return ['ok'=>true,'existing'=>true,'state'=>$r['state'],'credentialId'=>$r['credentialId'] ?? null];
    }
    atlas_studio_prune($root, 'mint-receipts', ATLAS_STUDIO_ATTEMPT_FILE_RE, ATLAS_STUDIO_ATTEMPT_RETAIN_SECONDS, $now);
    $global = 0; $mine = 0;
    foreach ((array) @scandir($dir) as $name) {
      if (!preg_match('/^attempt-([a-f0-9]{64})\.json$/D', $name, $m)) continue;
      $r = atlas_studio_read_attempt_file($dir.'/'.$name, $m[1]);
      if ($r === null || $r['createdAt'] <= $now - $limits['windowSeconds']) continue;
      $global++;
      if (hash_equals($r['recipient'], $recipient)) $mine++;
    }
    if ($mine >= $limits['perRecipient']) return ['ok'=>false,'error'=>'quota-recipient'];
    if ($global >= $limits['global']) return ['ok'=>false,'error'=>'quota-global'];
    $fh = @fopen($path, 'x');
    if (!$fh) return ['ok'=>false,'error'=>'attempt-create-failed'];
    try {
      @chmod($path, 0600);
      atlas_studio_write_all($fh, atlas_studio_json([
        'version'=>2,'nonce'=>$nonce,'designDigest'=>$designDigest,'recipient'=>$recipient,'state'=>'claimed','createdAt'=>$now,
      ]), 'attempt-write-failed');
    } catch (Throwable $e) {
      fclose($fh);
      return ['ok'=>false,'error'=>'attempt-write-failed'];
    }
    fclose($fh);
    return ['ok'=>true,'existing'=>false,'state'=>'claimed','credentialId'=>null];
  } finally {
    flock($lock, LOCK_UN);
    fclose($lock);
  }
}

// Records the credential id once the issuer has committed it. Idempotent; false if the record is missing
// or names a different credential.
function atlas_studio_mark_attempt_minted($root, $nonce, $credentialId) {
  if (!is_string($credentialId) || $credentialId === '' || strlen($credentialId) > 200) return false;
  $fh = @fopen(atlas_studio_attempt_path($root, $nonce), 'r+');
  if (!$fh) return false;
  try {
    if (!flock($fh, LOCK_EX)) return false;
    $raw = stream_get_contents($fh, ATLAS_STUDIO_ATTEMPT_MAX_BYTES + 1);
    if ($raw === false || strlen($raw) > ATLAS_STUDIO_ATTEMPT_MAX_BYTES) return false;
    $r = json_decode($raw, true);
    if (!atlas_studio_attempt_valid($r, $nonce)) return false;
    if ($r['state'] === 'minted') return $r['credentialId'] === $credentialId;
    $r['state'] = 'minted';
    $r['credentialId'] = $credentialId;
    atlas_studio_rewrite($fh, $r, ATLAS_STUDIO_ATTEMPT_MAX_BYTES, 'attempt-write-failed');
    return true;
  } finally {
    flock($fh, LOCK_UN);
    fclose($fh);
  }
}
