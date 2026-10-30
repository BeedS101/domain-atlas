<?php
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

// Creates a challenge. Throws 'too-many-challenges' at the outstanding cap (after pruning old files).
function atlas_studio_new_challenge($root, $designDigest, $recipient, $now = null, $maxOutstanding = 500) {
  $now = $now ?? time();
  if (!is_string($designDigest) || !preg_match('/^[a-f0-9]{64}$/D', $designDigest)) throw new InvalidArgumentException('invalid-digest');
  if (!atlas_studio_recipient_ok($recipient)) throw new InvalidArgumentException('invalid-recipient');
  $dir = atlas_studio_storage_bucket($root, 'tmp');
  atlas_studio_prune($root, 'tmp', ATLAS_STUDIO_CHALLENGE_FILE_RE, ATLAS_STUDIO_CHALLENGE_RETAIN_SECONDS, $now);
  $count = 0;
  foreach ((array) @scandir($dir) as $name) if (preg_match(ATLAS_STUDIO_CHALLENGE_FILE_RE, $name)) $count++;
  if ($count >= $maxOutstanding) throw new RuntimeException('too-many-challenges');
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
  return ['nonce'=>$nonce,'expiresAt'=>$value['expiresAt']];
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

// Moves a challenge from $from to $to under an exclusive lock, only for this exact design and recipient.
// Returns false when it is not in $from, does not match, or cannot be written.
function atlas_studio_transition_challenge($root, $nonce, $from, $to, $designDigest, $recipient) {
  if (!is_string($nonce) || !preg_match('/^[a-f0-9]{64}$/D', $nonce)) return false;
  $fp = @fopen(atlas_studio_challenge_path($root, $nonce), 'r+');
  if (!$fp) return false;
  try {
    if (!flock($fp, LOCK_EX)) return false;
    $raw = stream_get_contents($fp, ATLAS_STUDIO_CHALLENGE_MAX_BYTES + 1);
    if ($raw === false || strlen($raw) > ATLAS_STUDIO_CHALLENGE_MAX_BYTES) return false;
    $c = json_decode($raw, true);
    if (!atlas_studio_challenge_valid($c, $nonce) || $c['state'] !== $from ||
        $c['designDigest'] !== $designDigest || $c['recipient'] !== $recipient) return false;
    $c['state'] = $to;
    atlas_studio_rewrite($fp, $c, ATLAS_STUDIO_CHALLENGE_MAX_BYTES, 'challenge-update-failed');
    return true;
  } finally {
    flock($fp, LOCK_UN);
    fclose($fp);
  }
}
