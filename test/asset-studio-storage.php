<?php
require_once __DIR__ . '/../issuer-php/atlas/studio/inc/storage.php';
function assert_studio($condition, $message) { if (!$condition) throw new RuntimeException($message); }
function rejects($callback, $message) {
  try { $callback(); } catch (Throwable $e) { return; }
  throw new RuntimeException('expected rejection: ' . $message);
}
$base = sys_get_temp_dir() . '/atlas-studio-test-' . bin2hex(random_bytes(8));
mkdir($base, 0700);
mkdir($base . '/web', 0700);
mkdir($base . '/private', 0700);
foreach (['drafts','uploads-quarantine','mint-receipts','tmp'] as $name) mkdir($base . '/private/' . $name, 0700);
try {
  $root = atlas_studio_storage_root($base . '/private', $base . '/web');
  assert_studio($root === realpath($base . '/private'), 'private root');
  rejects(fn() => atlas_studio_storage_root($base . '/web', $base . '/web'), 'web root');
  rejects(fn() => atlas_studio_storage_root($base . '/web/nothere', $base . '/web'), 'missing root');
  rejects(fn() => atlas_studio_storage_root($base, $base . '/web'), 'ancestor root');
  rejects(fn() => atlas_studio_storage_bucket($root, '../web'), 'bucket traversal');
  $id=atlas_studio_store_private_json($root, 'drafts', ['name'=>'Test trophy']);
  assert_studio(preg_match('/^[a-f0-9]{32}$/', $id) === 1, 'opaque id');
  assert_studio(json_decode(file_get_contents($root.'/drafts/'.$id.'.json'), true)['name'] === 'Test trophy', 'stored content');
  rejects(fn() => atlas_studio_store_private_json($root, 'drafts', ['name'=>str_repeat('X',5000)]), 'size limit');
  rejects(fn() => atlas_studio_store_private_json($root, 'uploads-quarantine', ['a'=>1]), 'unapproved bucket');
  if (function_exists('symlink') && @symlink($base . '/web', $root . '/drafts-link')) {
    rejects(fn()=>atlas_studio_storage_bucket($root, 'drafts-link'), 'symlink bucket');
    unlink($root.'/drafts-link');
  }
  echo "Asset Studio private storage tests passed\n";
} finally {
  foreach (glob($base.'/private/drafts/*') ?: [] as $p) unlink($p);
  foreach (['drafts','uploads-quarantine','mint-receipts','tmp'] as $name) rmdir($base.'/private/'.$name);
  rmdir($base.'/private');rmdir($base.'/web');rmdir($base);
}
