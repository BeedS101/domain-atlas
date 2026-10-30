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
const ATLAS_STUDIO_RATE_MAX_FILES = 20000;

// Counts a hit for the actor and, when it has one, its group (limited at ATLAS_STUDIO_RATE_GROUP_FACTOR
// times the actor limit). False when either is over its limit; the actor is only charged if the group allows.
function atlas_studio_rate_check($root, $name, $actor, $limit, $windowSeconds, $now = null) {
  $now = $now ?? time();
  if ($actor['group'] !== null && !atlas_studio_rate_hit($root, $name.':'.$actor['group'], $limit * ATLAS_STUDIO_RATE_GROUP_FACTOR, $windowSeconds, $now)) return false;
  return atlas_studio_rate_hit($root, $name.':'.$actor['key'], $limit, $windowSeconds, $now);
}

// Sliding-window counter per key. The file's mtime is set to the moment its last hit stops mattering, so
// atlas_studio_prune_rate() can drop dead counters by mtime alone. A key that has no file yet is refused once
// the directory is full (fail closed), so flooding with fresh keys cannot grow the directory without bound.
function atlas_studio_rate_hit($root, $key, $limit, $windowSeconds, $now = null) {
  $now = $now ?? time();
  $dir = atlas_studio_storage_bucket($root, 'rate');
  atlas_studio_prune_rate($dir, $now);
  $file = $dir . '/rate-' . substr(hash('sha256', $key), 0, 40) . '.json';
  $isNew = !file_exists($file);
  if ($isNew && atlas_studio_rate_file_count($dir) >= ATLAS_STUDIO_RATE_MAX_FILES) return false;
  $handle = @fopen($file, 'c+');
  if (!$handle) throw new RuntimeException('studio-rate-unavailable');
  try {
    if (!flock($handle, LOCK_EX)) throw new RuntimeException('studio-rate-unavailable');
    @chmod($file, 0600);
    $raw = stream_get_contents($handle, 65537);
    $hits = [];
    $doc = $raw === '' || $raw === false ? null : json_decode($raw, true);
    if (is_array($doc) && isset($doc['hits']) && is_array($doc['hits'])) {
      foreach ($doc['hits'] as $t) if (is_int($t) && $t > $now - $windowSeconds) $hits[] = $t;
    }
    if (count($hits) >= $limit) return false;
    $hits[] = $now;
    atlas_studio_rewrite($handle, ['hits' => $hits], 65536, 'studio-rate-write-failed');
    @touch($file, $now + $windowSeconds);
    if ($isNew) atlas_studio_rate_file_count($dir, 1);
    return true;
  } finally {
    flock($handle, LOCK_UN);
    fclose($handle);
  }
}

// Remaining-file count kept in the prune marker so a hit does not have to list the directory.
function atlas_studio_rate_file_count($dir, $add = 0) {
  $marker = $dir . '/.prune';
  $n = 0;
  $doc = json_decode((string) @file_get_contents($marker, false, null, 0, 256), true);
  if (is_array($doc) && isset($doc['count']) && is_int($doc['count'])) $n = $doc['count'];
  if ($add && is_array($doc)) {
    $mtime = (int) @filemtime($marker); // the marker's mtime is the last prune time; adding a count must not reset it
    $doc['count'] = $n + $add;
    @file_put_contents($marker, json_encode($doc), LOCK_EX);
    @chmod($marker, 0600);
    if ($mtime > 0) @touch($marker, $mtime);
    return $n + $add;
  }
  return $n;
}

// Bounded cleanup of dead rate counters, at most once a minute (marker mtime) and at most $limit files a pass.
// A counter is dead once its mtime (set to its last hit's expiry) is in the past.
function atlas_studio_prune_rate($dir, $now, $limit = 500) {
  $marker = $dir . '/.prune';
  $m = @fopen($marker, 'c+');
  if (!$m) return 0;
  try {
    if (!flock($m, LOCK_EX | LOCK_NB)) return 0;
    @chmod($marker, 0600);
    $fresh = (int) (fstat($m)['size'] ?? 0) === 0; // a marker nobody has written yet: never pruned
    $last = (int) @filemtime($marker);
    if (!$fresh && $now - $last < 60 && $now >= $last) return 0;
    $removed = 0; $remaining = 0;
    foreach ((array) @scandir($dir) as $name) {
      if (!preg_match('/^rate-[a-f0-9]{40}\.json$/D', $name)) continue;
      $file = $dir . '/' . $name;
      if (is_link($file) || !is_file($file)) continue;
      if ($removed < $limit && (int) @filemtime($file) < $now && @unlink($file)) { $removed++; continue; }
      $remaining++;
    }
    ftruncate($m, 0); rewind($m);
    fwrite($m, json_encode(['count' => $remaining, 'at' => $now]));
    @touch($marker, $now);
    return $removed;
  } finally {
    flock($m, LOCK_UN);
    fclose($m);
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
