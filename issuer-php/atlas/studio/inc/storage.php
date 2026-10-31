<?php
if (PHP_SAPI !== 'cli' && isset($_SERVER['SCRIPT_FILENAME']) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) { http_response_code(404); exit; } // include-only
// Asset Studio private storage: challenges, mint attempts and rate-limit counters.
// The operator pre-creates the root and its bucket directories OUTSIDE the document root
// (ATLAS_STUDIO_STORAGE_ROOT); nothing here creates directories or follows symlinks.
// PHP 7.2 compatible.

function atlas_studio_storage_buckets() {
  return ['drafts', 'uploads-quarantine', 'mint-receipts', 'tmp', 'rate'];
}

// True when $inner is $outer or lies below it (both already realpath()ed, forward slashes, no trailing slash).
function atlas_studio_path_within($inner, $outer) {
  if (PHP_OS_FAMILY === 'Windows') { $inner = strtolower($inner); $outer = strtolower($outer); }
  return $inner === $outer || strpos($inner . '/', $outer . '/') === 0;
}

function atlas_studio_storage_root($configured = null, $documentRoot = null) {
  $configured = $configured ?? getenv('ATLAS_STUDIO_STORAGE_ROOT');
  $documentRoot = $documentRoot ?? ($_SERVER['DOCUMENT_ROOT'] ?? '');
  if (!is_string($configured) || $configured === '' || !is_dir($configured)) throw new RuntimeException('studio-storage-not-configured');
  if (!is_string($documentRoot) || $documentRoot === '' || !is_dir($documentRoot)) throw new RuntimeException('studio-document-root-unavailable');
  $root = realpath($configured);
  $doc = realpath($documentRoot);
  if ($root === false || $doc === false) throw new RuntimeException('studio-storage-path-unresolved');
  $root = rtrim(str_replace('\\', '/', $root), '/');
  $doc = rtrim(str_replace('\\', '/', $doc), '/');
  if (atlas_studio_path_within($root, $doc) || atlas_studio_path_within($doc, $root)) {
    throw new RuntimeException('studio-storage-must-be-separate-from-web-root');
  }
  if (!is_writable($root)) throw new RuntimeException('studio-storage-not-writable');
  return $root;
}

// Existing directories only, never user-derived paths. Rejects symlinked buckets.
function atlas_studio_storage_bucket($root, $bucket) {
  if (!in_array($bucket, atlas_studio_storage_buckets(), true)) throw new InvalidArgumentException('studio-invalid-bucket');
  $path = $root . DIRECTORY_SEPARATOR . $bucket;
  if (is_link($path) || !is_dir($path) || realpath($path) !== $path) throw new RuntimeException('studio-bucket-missing-or-unsafe');
  if (!is_writable($path)) throw new RuntimeException('studio-bucket-not-writable');
  return $path;
}

// json_encode that throws instead of returning false (JSON_THROW_ON_ERROR needs PHP 7.3).
function atlas_studio_json($value) {
  $json = json_encode($value, JSON_UNESCAPED_SLASHES);
  if (!is_string($json)) throw new RuntimeException('studio-json-encode-failed');
  return $json;
}

// Writes all of $json to an open handle, then flushes and syncs; throws $error on any failure.
function atlas_studio_write_all($handle, $json, $error) {
  $len = strlen($json);
  for ($offset = 0; $offset < $len; ) {
    $n = fwrite($handle, substr($json, $offset));
    if ($n === false || $n === 0) throw new RuntimeException($error);
    $offset += $n;
  }
  if (!fflush($handle)) throw new RuntimeException($error);
  if (function_exists('fsync') && !fsync($handle)) throw new RuntimeException($error);
}

// Makes a directory's entries durable after a create or rename (see atlas_fsync_dir() in lib/store.php for
// the limits: PHP 8.1+, POSIX, and only as strong as the storage underneath). Never throws.
function atlas_studio_fsync_dir($dir) {
  if (!function_exists('fsync') || DIRECTORY_SEPARATOR === '\\') return false;
  $h = @fopen($dir, 'r');
  if (!$h) return false;
  $done = @fsync($h) === true;
  fclose($h);
  return $done;
}

// Replaces a record atomically: a synced temporary file in the same directory renamed over the old one, then
// the directory synced. Readers see the old or the new record, never a truncated one, and a crash at any
// point leaves the old record intact. The caller holds the bucket's lock. $faultPoint is for crash tests.
function atlas_studio_replace_file($path, $record, $limit, $error, $faultPoint = null) {
  $json = atlas_studio_json($record);
  if (strlen($json) > $limit) throw new RuntimeException($error);
  $tmp = $path . '.' . bin2hex(random_bytes(6)) . '.tmp';
  $fh = @fopen($tmp, 'x');
  if (!$fh) throw new RuntimeException($error);
  try {
    @chmod($tmp, 0600);
    atlas_studio_write_all($fh, $json, $error);
    fclose($fh); $fh = null;
    if ($faultPoint !== null && function_exists('atlas_fault_point')) atlas_fault_point($faultPoint);
    if (!@rename($tmp, $path)) throw new RuntimeException($error);
  } catch (Throwable $e) {
    if ($fh) fclose($fh);
    @unlink($tmp);
    throw $e;
  }
  atlas_studio_fsync_dir(dirname($path));
}

// Server-generated IDs only. No overwrite; bounded content. Not exposed via web.
function atlas_studio_store_private_json($root, $bucket, $object, $limit = 4096) {
  if (!in_array($bucket, ['drafts', 'mint-receipts'], true)) throw new InvalidArgumentException('studio-bucket-not-json');
  $dir = atlas_studio_storage_bucket($root, $bucket);
  $json = atlas_studio_json($object);
  if (strlen($json) > $limit) throw new InvalidArgumentException('studio-record-too-large');
  $id = bin2hex(random_bytes(16));
  $file = $dir . DIRECTORY_SEPARATOR . $id . '.json';
  $handle = @fopen($file, 'x');
  if (!$handle) throw new RuntimeException('studio-private-write-failed');
  try {
    @chmod($file, 0600);
    atlas_studio_write_all($handle, $json, 'studio-private-write-failed');
  } catch (Throwable $e) {
    fclose($handle);
    @unlink($file);
    throw $e;
  }
  fclose($handle);
  atlas_studio_fsync_dir($dir);
  return $id;
}

// Replaces a record in place under the caller's lock: truncate, write, sync.
function atlas_studio_rewrite($handle, $record, $limit, $error) {
  $json = atlas_studio_json($record);
  if (strlen($json) > $limit) throw new RuntimeException($error);
  if (!rewind($handle) || !ftruncate($handle, 0)) throw new RuntimeException($error);
  atlas_studio_write_all($handle, $json, $error);
}

// The party a request is rate limited as. IPv4 is the address itself. IPv6 is the /64 (what a single
// subscriber or host receives, so rotating addresses inside it gains nothing), with the /48 as a coarser
// group that is limited more loosely, so rotating across /64s inside one allocation does not help either.
// An IPv4-mapped IPv6 address counts as the IPv4 address. Anything unparseable shares one 'unknown' bucket.
// Behind a proxy REMOTE_ADDR is the proxy, so every visitor shares one actor; no forwarded header is trusted.
function atlas_studio_actor($remoteAddr) {
  $bin = is_string($remoteAddr) ? @inet_pton($remoteAddr) : false;
  if ($bin === false) return ['key'=>'unknown','group'=>null];
  if (strlen($bin) === 16 && substr($bin, 0, 12) === "\0\0\0\0\0\0\0\0\0\0\xff\xff") $bin = substr($bin, 12);
  if (strlen($bin) === 4) return ['key'=>'ip4:'.inet_ntop($bin),'group'=>null];
  return ['key'=>'ip6:'.bin2hex(substr($bin, 0, 8)),'group'=>'ip6g:'.bin2hex(substr($bin, 0, 6))];
}

const ATLAS_STUDIO_RATE_GROUP_FACTOR = 8;
// Rate counters live in a fixed table: ATLAS_STUDIO_RATE_SLOTS files, each holding at most
// ATLAS_STUDIO_RATE_SLOT_ENTRIES counters, so storage is bounded whatever addresses arrive. A test may define the
// slot count first to exercise collisions.
if (!defined('ATLAS_STUDIO_RATE_SLOTS')) define('ATLAS_STUDIO_RATE_SLOTS', 4096);
const ATLAS_STUDIO_RATE_SLOT_ENTRIES = 8;
const ATLAS_STUDIO_RATE_SLOT_MAX_BYTES = 16777216;

// Counts a hit for the actor and, when it has one, its group (limited at ATLAS_STUDIO_RATE_GROUP_FACTOR
// times the actor limit). False when either is over its limit. The actor is charged first, so a /64 that keeps
// hammering after it is limited never uses up the /48 allowance of its neighbours; the group is charged only for
// requests the actor was allowed to make. The two counters live in different slot files and are never locked
// together, so there is no lock ordering to get wrong.
function atlas_studio_rate_check($root, $name, $actor, $limit, $windowSeconds, $now = null) {
  $now = $now ?? time();
  if (!atlas_studio_rate_hit($root, $name.':'.$actor['key'], $limit, $windowSeconds, $now)) return false;
  if ($actor['group'] !== null && !atlas_studio_rate_hit($root, $name.':'.$actor['group'], $limit * ATLAS_STUDIO_RATE_GROUP_FACTOR, $windowSeconds, $now)) return false;
  return true;
}

// A per-installation secret that decides which slot a key lands in, so a visitor cannot choose addresses that
// collide with someone else's counter. Created once (link() makes the creation atomic between processes).
function atlas_studio_rate_salt($dir) {
  static $cache = [];
  if (isset($cache[$dir])) return $cache[$dir];
  $file = $dir . '/.salt';
  for ($try = 0; $try < 3; $try++) {
    $salt = @file_get_contents($file, false, null, 0, 33);
    if (is_string($salt) && strlen($salt) === 32) return $cache[$dir] = $salt;
    $tmp = $dir . '/.salt.' . bin2hex(random_bytes(6)) . '.tmp';
    if (@file_put_contents($tmp, random_bytes(32)) === 32) {
      @chmod($tmp, 0600);
      if (!@link($tmp, $file) && !file_exists($file)) @rename($tmp, $file);
      @unlink($tmp);
    }
  }
  throw new RuntimeException('studio-rate-unavailable');
}

// Sliding-window counter per key, kept in the key's slot file as { id: { exp, hits } }. `exp` is when the last
// hit stops mattering, so expired counters are dropped whenever their slot is rewritten and nothing needs a
// separate cleanup pass or a directory listing. Each slot is serialized by its own flock. When a slot already
// holds ATLAS_STUDIO_RATE_SLOT_ENTRIES live counters, a new key takes the place of the least-used one (fewest
// hits, then soonest to expire): a flood of fresh keys can only push out other low-count keys, a counter that has
// reached its limit is the last to go, and a new visitor is never refused for lack of room.
function atlas_studio_rate_hit($root, $key, $limit, $windowSeconds, $now = null) {
  $now = $now ?? time();
  $dir = atlas_studio_storage_bucket($root, 'rate');
  $h = hash_hmac('sha256', $key, atlas_studio_rate_salt($dir));
  $slot = hexdec(substr($h, 0, 8)) % ATLAS_STUDIO_RATE_SLOTS;
  $id = substr($h, 8, 24);
  $file = sprintf('%s/rate-slot-%04x.json', $dir, $slot);
  $handle = @fopen($file, 'c+');
  if (!$handle) throw new RuntimeException('studio-rate-unavailable');
  try {
    if (!flock($handle, LOCK_EX)) throw new RuntimeException('studio-rate-unavailable');
    @chmod($file, 0600);
    $raw = stream_get_contents($handle, ATLAS_STUDIO_RATE_SLOT_MAX_BYTES + 1);
    $doc = ($raw === '' || $raw === false || strlen($raw) > ATLAS_STUDIO_RATE_SLOT_MAX_BYTES) ? null : json_decode($raw, true);
    $entries = [];
    if (is_array($doc) && isset($doc['e']) && is_array($doc['e'])) {
      foreach ($doc['e'] as $eid => $e) {
        if (is_string($eid) && is_array($e) && isset($e['exp'], $e['hits']) && is_int($e['exp']) && $e['exp'] > $now && is_array($e['hits'])) $entries[$eid] = $e;
      }
    }
    $hits = [];
    if (isset($entries[$id])) foreach ($entries[$id]['hits'] as $t) if (is_int($t) && $t > $now - $windowSeconds) $hits[] = $t;
    if (count($hits) >= $limit) return false;
    $hits[] = $now;
    unset($entries[$id]);
    while (count($entries) >= ATLAS_STUDIO_RATE_SLOT_ENTRIES) {
      $victim = null; $vn = null; $ve = null;
      foreach ($entries as $eid => $e) {
        $n = count($e['hits']);
        if ($victim === null || $n < $vn || ($n === $vn && $e['exp'] < $ve)) { $victim = $eid; $vn = $n; $ve = $e['exp']; }
      }
      unset($entries[$victim]);
    }
    $entries[$id] = ['exp' => $now + $windowSeconds, 'hits' => $hits];
    atlas_studio_rewrite($handle, ['e' => $entries], ATLAS_STUDIO_RATE_SLOT_MAX_BYTES, 'studio-rate-write-failed');
    return true;
  } finally {
    flock($handle, LOCK_UN);
    fclose($handle);
  }
}

// Removes files in a bucket older than $maxAgeSeconds that match $pattern (a basename regex).
function atlas_studio_prune($root, $bucket, $pattern, $maxAgeSeconds, $now = null, $limit = 200) {
  $now = $now ?? time();
  $dir = atlas_studio_storage_bucket($root, $bucket);
  $removed = 0;
  foreach ((array) @scandir($dir) as $name) {
    if ($removed >= $limit || !preg_match($pattern, $name)) continue;
    $file = $dir . '/' . $name;
    if (is_file($file) && !is_link($file) && $now - (int) @filemtime($file) > $maxAgeSeconds && @unlink($file)) $removed++;
  }
  return $removed;
}
