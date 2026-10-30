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

// Atomic replacement and directory sync (T1)
require_once __DIR__ . '/studio-test-lib.php';
$d = sys_get_temp_dir() . '/studio-replace-' . bin2hex(random_bytes(4));
mkdir($d, 0700);
$f = $d . '/rec.json';
file_put_contents($f, '{"v":1}');
atlas_studio_replace_file($f, ['v' => 2], 4096, 'x');
studio_check(json_decode(file_get_contents($f), true) === ['v' => 2], 'record replaced');
studio_check(count(glob($d . '/*.tmp')) === 0, 'no temp file left behind');
studio_check((fileperms($f) & 077) === 0, 'replacement is private');
$threw = false;
try { atlas_studio_replace_file($f, ['v' => str_repeat('x', 5000)], 100, 'too-big'); } catch (RuntimeException $e) { $threw = true; }
studio_check($threw && json_decode(file_get_contents($f), true) === ['v' => 2] && count(glob($d . '/*.tmp')) === 0, 'an oversized record is refused and the old one stays');
studio_check(atlas_studio_fsync_dir($d) === (function_exists('fsync') && DIRECTORY_SEPARATOR !== '\\'), 'directory sync is requested where the platform supports it');
studio_check(atlas_studio_fsync_dir($d . '/missing') === false, 'a missing directory is reported, not fatal');
unlink($f); rmdir($d);
echo "Asset Studio atomic replace tests passed\n";
