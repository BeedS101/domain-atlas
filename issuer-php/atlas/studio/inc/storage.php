<?php
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
  return $id;
}

// Replaces a record in place under the caller's lock: truncate, write, sync.
function atlas_studio_rewrite($handle, $record, $limit, $error) {
  $json = atlas_studio_json($record);
  if (strlen($json) > $limit) throw new RuntimeException($error);
  if (!rewind($handle) || !ftruncate($handle, 0)) throw new RuntimeException($error);
  atlas_studio_write_all($handle, $json, $error);
}

// Sliding-window limiter: at most $limit hits per $windowSeconds for $key. The key is hashed, so
// nothing identifying is stored. Returns true when the hit is allowed (and counted).
function atlas_studio_rate_hit($root, $key, $limit, $windowSeconds, $now = null) {
  $now = $now ?? time();
  $dir = atlas_studio_storage_bucket($root, 'rate');
  $file = $dir . '/rate-' . substr(hash('sha256', $key), 0, 40) . '.json';
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
