<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
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

// What the ledger stores for an actor: a short hash, not the address.
function atlas_studio_actor_id($actor) {
  return substr(hash('sha256', 'actor:'.(is_string($actor) ? $actor : 'unknown')), 0, 16);
}

function atlas_studio_attempt_path($root, $nonce) {
  if (!is_string($nonce) || !preg_match('/^[a-f0-9]{64}$/D', $nonce)) throw new InvalidArgumentException('invalid-attempt-id');
  return atlas_studio_storage_bucket($root, 'mint-receipts').'/attempt-'.$nonce.'.json';
}

function atlas_studio_attempt_valid($r, $nonce) {
  return is_array($r) && ($r['version'] ?? null) === 2 && ($r['nonce'] ?? null) === $nonce &&
    in_array($r['state'] ?? null, ['claimed','minted'], true) &&
    is_string($r['designDigest'] ?? null) && is_string($r['recipient'] ?? null) && is_int($r['createdAt'] ?? null) &&
    (!isset($r['actor']) || is_string($r['actor'])) && (!isset($r['group']) || is_string($r['group'])) && (!isset($r['recipientKey']) || is_string($r['recipientKey'])) &&
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
// $limits: perRecipient, perActor, global, windowSeconds, and optionally perGroup and reserve.
// $actor / $group are the rate-limit actor key and network group (atlas_studio_actor()['key'] / ['group'];
// group is null for IPv4). Daily shares, checked in this order for a NEW attempt:
//   perRecipient  attempts for one wallet key (either spelling);
//   perActor      attempts from one IPv4 address or IPv6 /64;
//   perGroup      attempts from one IPv6 /48, so rotating /64s inside an allocation gains nothing;
//   global        all attempts, of which the last `reserve` are kept for first-time actors: a network (or IPv4
//                 address) that already has an attempt in the window is refused with quota-reserved once only the
//                 reserve is left, so a few established or abusive networks cannot take the quota that a new
//                 visitor needs. A first-time actor may still use the reserve, up to the global limit.
// An existing attempt for this exact nonce, design and recipient is returned as is: that is a retry and is never
// counted twice. An existing file that cannot be read, or that names a different design or recipient, fails closed.
function atlas_studio_claim_attempt($root, $nonce, $designDigest, $recipient, $limits, $now = null, $actor = 'unknown', $group = null) {
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
    atlas_studio_prune($root, 'mint-receipts', '/^attempt-[a-f0-9]{64}\\.json\\.[0-9a-f]{12}\\.tmp$/D', 300, $now);
    $global = 0; $mine = 0; $byActor = 0; $byGroup = 0;
    $keyId = atlas_studio_key_fingerprint($recipient);
    $actorId = atlas_studio_actor_id($actor);
    $groupId = is_string($group) ? atlas_studio_actor_id($group) : null;
    foreach ((array) @scandir($dir) as $name) {
      if (!preg_match('/^attempt-([a-f0-9]{64})\.json$/D', $name, $m)) continue;
      $r = atlas_studio_read_attempt_file($dir.'/'.$name, $m[1]);
      if ($r === null || $r['createdAt'] <= $now - $limits['windowSeconds']) continue;
      $global++;
      $theirs = isset($r['recipientKey']) ? $r['recipientKey'] : atlas_studio_key_fingerprint($r['recipient']);
      if ($theirs !== null && hash_equals($theirs, $keyId)) $mine++;
      if (isset($r['actor']) && hash_equals($r['actor'], $actorId)) $byActor++;
      if ($groupId !== null && isset($r['group']) && hash_equals($r['group'], $groupId)) $byGroup++;
    }
    if ($mine >= $limits['perRecipient']) return ['ok'=>false,'error'=>'quota-recipient'];
    if ($byActor >= $limits['perActor']) return ['ok'=>false,'error'=>'quota-actor'];
    if ($groupId !== null && isset($limits['perGroup']) && $byGroup >= $limits['perGroup']) return ['ok'=>false,'error'=>'quota-group'];
    if ($global >= $limits['global']) return ['ok'=>false,'error'=>'quota-global'];
    $reserve = isset($limits['reserve']) ? (int) $limits['reserve'] : 0;
    $established = ($groupId !== null ? $byGroup : $byActor) > 0;
    if ($established && $global >= $limits['global'] - $reserve) return ['ok'=>false,'error'=>'quota-reserved'];
    $fh = @fopen($path, 'x');
    if (!$fh) return ['ok'=>false,'error'=>'attempt-create-failed'];
    try {
      @chmod($path, 0600);
      atlas_studio_write_all($fh, atlas_studio_json([
        'version'=>2,'nonce'=>$nonce,'designDigest'=>$designDigest,'recipient'=>$recipient,'recipientKey'=>$keyId,'actor'=>$actorId,'group'=>$groupId,'state'=>'claimed','createdAt'=>$now,
      ]), 'attempt-write-failed');
    } catch (Throwable $e) {
      fclose($fh);
      return ['ok'=>false,'error'=>'attempt-write-failed'];
    }
    fclose($fh);
    atlas_studio_fsync_dir($dir);
    return ['ok'=>true,'existing'=>false,'state'=>'claimed','credentialId'=>null];
  } finally {
    flock($lock, LOCK_UN);
    fclose($lock);
  }
}

// Records the credential id once the issuer has committed it. Idempotent; false if the record is missing
// or names a different credential. Runs under the bucket lock and replaces the record atomically.
function atlas_studio_mark_attempt_minted($root, $nonce, $credentialId) {
  if (!is_string($credentialId) || $credentialId === '' || strlen($credentialId) > 200) return false;
  $path = atlas_studio_attempt_path($root, $nonce);
  $lock = @fopen(dirname($path).'/.quota.lock', 'c');
  if (!$lock) return false;
  @chmod(dirname($path).'/.quota.lock', 0600);
  try {
    if (!flock($lock, LOCK_EX)) return false;
    $r = atlas_studio_read_attempt_file($path, $nonce);
    if ($r === null) return false;
    if ($r['state'] === 'minted') return $r['credentialId'] === $credentialId;
    $r['state'] = 'minted';
    $r['credentialId'] = $credentialId;
    atlas_studio_replace_file($path, $r, ATLAS_STUDIO_ATTEMPT_MAX_BYTES, 'attempt-write-failed', 'studio:attempt-tmp-written');
    return true;
  } catch (RuntimeException $e) {
    return false;
  } finally {
    flock($lock, LOCK_UN);
    fclose($lock);
  }
}
