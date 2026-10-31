<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
// Single-use Studio mint challenges in private storage ('tmp' bucket, one file per server nonce).
//
// A challenge is the issuer's half of a mint authorization: it fixes the design digest and the
// recipient key the wallet must sign for, for TTL seconds. State is 'issued' or 'completed'.
// 'completed' is advisory bookkeeping; whether a credential exists is decided only by the issuer's
// transaction journal and replay record for the request id (see studio-mint.php), so a crash between
// committing and marking cannot lose or duplicate a result.
require_once __DIR__.'/storage.php';
require_once __DIR__.'/mint-authorization.php';

const ATLAS_STUDIO_CHALLENGE_FILE_RE = '/^mint-challenge-[a-f0-9]{64}\.json$/D';
const ATLAS_STUDIO_CHALLENGE_MAX_BYTES = 4096;
const ATLAS_STUDIO_CHALLENGE_RETAIN_SECONDS = 86400;
const ATLAS_STUDIO_CHALLENGE_GRACE = 60;

function atlas_studio_challenge_path($root, $nonce) {
  if (!is_string($nonce) || !preg_match('/^[a-f0-9]{64}$/D', $nonce)) throw new InvalidArgumentException('invalid-nonce');
  return atlas_studio_storage_bucket($root, 'tmp').'/mint-challenge-'.$nonce.'.json';
}

function atlas_studio_challenge_valid($c, $nonce) {
  return is_array($c) && ($c['nonce'] ?? null) === $nonce &&
    in_array($c['state'] ?? null, ['issued','completed'], true) &&
    is_string($c['designDigest'] ?? null) && preg_match('/^[a-f0-9]{64}$/D', $c['designDigest']) === 1 &&
    is_string($c['recipient'] ?? null) && is_int($c['expiresAt'] ?? null);
}

// Creates a challenge. Throws 'too-many-challenges' when the live ones reach the cap.
//
// Pruning, counting and creating happen under one exclusive lock, so simultaneous requests cannot overshoot
// the cap. Only a LIVE challenge counts: state 'issued' and not yet expired. A completed or expired one is
// no longer outstanding. Files are kept so a retry of a committed mint can still be authorized: a challenge
// tied to an attempt record for 24 hours, one that was never claimed only until shortly after it expires.
function atlas_studio_new_challenge($root, $designDigest, $recipient, $now = null, $maxOutstanding = 500) {
  $now = $now ?? time();
  if (!is_string($designDigest) || !preg_match('/^[a-f0-9]{64}$/D', $designDigest)) throw new InvalidArgumentException('invalid-digest');
  if (!atlas_studio_recipient_ok($recipient)) throw new InvalidArgumentException('invalid-recipient');
  $dir = atlas_studio_storage_bucket($root, 'tmp');
  $lock = @fopen($dir.'/.challenge.lock', 'c');
  if (!$lock) throw new RuntimeException('challenge-lock-failed');
  @chmod($dir.'/.challenge.lock', 0600);
  try {
    if (!flock($lock, LOCK_EX)) throw new RuntimeException('challenge-lock-failed');
    atlas_studio_prune_challenges($root, $dir, $now);
    if (atlas_studio_live_challenge_count($root, $dir, $now) >= $maxOutstanding) throw new RuntimeException('too-many-challenges');
    $nonce = bin2hex(random_bytes(32));
    $path = $dir.'/mint-challenge-'.$nonce.'.json';
    $value = ['nonce'=>$nonce,'designDigest'=>$designDigest,'recipient'=>$recipient,'expiresAt'=>$now+ATLAS_STUDIO_CHALLENGE_TTL,'state'=>'issued'];
    $fp = @fopen($path, 'x');
    if (!$fp) throw new RuntimeException('challenge-create-failed');
    try {
      @chmod($path, 0600);
      atlas_studio_write_all($fp, atlas_studio_json($value), 'challenge-write-failed');
    } catch (Throwable $e) {
      fclose($fp); @unlink($path); throw $e;
    }
    fclose($fp);
    atlas_studio_fsync_dir($dir);
    return ['nonce'=>$nonce,'expiresAt'=>$value['expiresAt']];
  } finally {
    flock($lock, LOCK_UN);
    fclose($lock);
  }
}

// Challenges that can still be used for a NEW mint. A file untouched for longer than the TTL cannot be live,
// so only recent files are opened.
function atlas_studio_live_challenge_count($root, $dir, $now) {
  $count = 0;
  foreach ((array) @scandir($dir) as $name) {
    if (!preg_match(ATLAS_STUDIO_CHALLENGE_FILE_RE, $name)) continue;
    $file = $dir.'/'.$name;
    if ($now - (int) @filemtime($file) > ATLAS_STUDIO_CHALLENGE_TTL + ATLAS_STUDIO_CHALLENGE_GRACE) continue;
    $c = atlas_studio_read_challenge($root, substr($name, 15, 64));
    if ($c !== null && $c['state'] === 'issued' && $c['expiresAt'] >= $now) $count++;
  }
  return $count;
}

// Removes a challenge that was never claimed shortly after it expires, and any challenge after the retention
// period. A challenge with an attempt record (a claim was made) is the only way to authorize a retry of a
// possibly committed mint, so it is kept for the full retention period.
function atlas_studio_prune_challenges($root, $dir, $now, $limit = 200) {
  $removed = 0;
  foreach ((array) @scandir($dir) as $name) {
    if ($removed < $limit && preg_match('/^mint-challenge-[a-f0-9]{64}\.json\.[0-9a-f]{12}\.tmp$/D', $name) && $now - (int) @filemtime($dir.'/'.$name) > 300 && @unlink($dir.'/'.$name)) { $removed++; continue; }
    if ($removed >= $limit || !preg_match(ATLAS_STUDIO_CHALLENGE_FILE_RE, $name)) continue;
    $file = $dir.'/'.$name;
    if (is_link($file) || !is_file($file)) continue;
    $age = $now - (int) @filemtime($file);
    if ($age > ATLAS_STUDIO_CHALLENGE_RETAIN_SECONDS) { if (@unlink($file)) $removed++; continue; }
    if ($age <= ATLAS_STUDIO_CHALLENGE_TTL + ATLAS_STUDIO_CHALLENGE_GRACE) continue;
    $nonce = substr($name, 15, 64);
    $c = atlas_studio_read_challenge($root, $nonce);
    $claimed = is_file(atlas_studio_storage_bucket($root, 'mint-receipts').'/attempt-'.$nonce.'.json');
    if (($c === null || $c['state'] === 'issued') && !$claimed && @unlink($file)) $removed++;
  }
  return $removed;
}

// The stored record for a nonce in any state, or null when absent, oversized or malformed. Read under a
// shared lock and bounded, so a truncated or hostile file fails closed. Expiry is the caller's decision.
function atlas_studio_read_challenge($root, $nonce) {
  if (!is_string($nonce) || !preg_match('/^[a-f0-9]{64}$/D', $nonce)) return null;
  $fp = @fopen(atlas_studio_challenge_path($root, $nonce), 'r');
  if (!$fp) return null;
  try {
    if (!flock($fp, LOCK_SH)) return null;
    $raw = stream_get_contents($fp, ATLAS_STUDIO_CHALLENGE_MAX_BYTES + 1);
    if ($raw === false || strlen($raw) > ATLAS_STUDIO_CHALLENGE_MAX_BYTES) return null;
    $c = json_decode($raw, true);
    return atlas_studio_challenge_valid($c, $nonce) ? $c : null;
  } finally {
    flock($fp, LOCK_UN);
    fclose($fp);
  }
}

// Moves a challenge from $from to $to under the bucket lock, only for this exact design and recipient. The new
// record replaces the old atomically (see atlas_studio_replace_file()), so a crash cannot leave a truncated
// challenge that would strand a committed mint. Returns false when it is not in $from, does not match, or
// cannot be written.
function atlas_studio_transition_challenge($root, $nonce, $from, $to, $designDigest, $recipient) {
  if (!is_string($nonce) || !preg_match('/^[a-f0-9]{64}$/D', $nonce)) return false;
  $path = atlas_studio_challenge_path($root, $nonce);
  $lock = @fopen(dirname($path).'/.challenge.lock', 'c');
  if (!$lock) return false;
  @chmod(dirname($path).'/.challenge.lock', 0600);
  try {
    if (!flock($lock, LOCK_EX)) return false;
    $c = atlas_studio_read_challenge($root, $nonce);
    if ($c === null || $c['state'] !== $from || $c['designDigest'] !== $designDigest || $c['recipient'] !== $recipient) return false;
    $c['state'] = $to;
    atlas_studio_replace_file($path, $c, ATLAS_STUDIO_CHALLENGE_MAX_BYTES, 'challenge-update-failed', 'studio:challenge-tmp-written');
    return true;
  } catch (RuntimeException $e) {
    return false;
  } finally {
    flock($lock, LOCK_UN);
    fclose($lock);
  }
}
