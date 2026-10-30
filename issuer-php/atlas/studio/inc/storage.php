<?php
// Asset Studio private storage primitives. No HTTP endpoint calls these yet.
// Require the operator to pre-create a private directory outside DOCUMENT_ROOT.
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
  $cmpRoot = PHP_OS_FAMILY === 'Windows' ? strtolower($root) : $root;
  $cmpDoc = PHP_OS_FAMILY === 'Windows' ? strtolower($doc) : $doc;
  if ($cmpRoot === $cmpDoc || str_starts_with($cmpRoot . '/', $cmpDoc . '/') || str_starts_with($cmpDoc . '/', $cmpRoot . '/')) {
    throw new RuntimeException('studio-storage-must-be-separate-from-web-root');
  }
  if (!is_writable($root)) throw new RuntimeException('studio-storage-not-writable');
  return $root;
}

// Existing directories only, never user-derived paths. Reject symlinked buckets.
function atlas_studio_storage_bucket($root, $bucket) {
  if (!in_array($bucket, ['drafts','uploads-quarantine','mint-receipts','tmp'], true)) throw new InvalidArgumentException('studio-invalid-bucket');
  $path = $root . DIRECTORY_SEPARATOR . $bucket;
  if (is_link($path) || !is_dir($path) || realpath($path) !== $path) throw new RuntimeException('studio-bucket-missing-or-unsafe');
  if (!is_writable($path)) throw new RuntimeException('studio-bucket-not-writable');
  return $path;
}

// Server-generated IDs only. No overwrite; bounded content. Not exposed via web.
function atlas_studio_store_private_json($root, $bucket, $object, $limit = 4096) {
  if (!in_array($bucket, ['drafts', 'mint-receipts'], true)) throw new InvalidArgumentException('studio-bucket-not-json');
  $dir = atlas_studio_storage_bucket($root, $bucket);
  $json = json_encode($object, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
  if (strlen($json) > $limit) throw new InvalidArgumentException('studio-record-too-large');
  $id = bin2hex(random_bytes(16));
  $file = $dir . DIRECTORY_SEPARATOR . $id . '.json';
  $handle = @fopen($file, 'x');
  if (!$handle) throw new RuntimeException('studio-private-write-failed');
  try {
    @chmod($file, 0600);
    $len = strlen($json);
    for ($offset = 0; $offset < $len; ) {
      $written = fwrite($handle, substr($json, $offset));
      if ($written === false || $written === 0) throw new RuntimeException('studio-private-write-failed');
      $offset += $written;
    }
    if (!fflush($handle)) throw new RuntimeException('studio-private-flush-failed');
  } catch (Throwable $e) {
    fclose($handle);
    @unlink($file);
    throw $e;
  }
  fclose($handle);
  return $id;
}
