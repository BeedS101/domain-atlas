<?php
// Shared helpers for the Asset Studio PHP unit tests (pure functions with injected time).
function studio_check($condition, $message) { if (!$condition) { fwrite(STDERR, "FAIL: $message\n"); exit(1); } }
function studio_b64u($bin) { return rtrim(strtr(base64_encode($bin), '+/', '-_'), '='); }
// A real P-256 key in the raw 65-byte point spelling the wallet uses.
function studio_raw_key() {
  $k = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
  $d = openssl_pkey_get_details($k);
  return studio_b64u("\x04" . str_pad($d['ec']['x'], 32, "\0", STR_PAD_LEFT) . str_pad($d['ec']['y'], 32, "\0", STR_PAD_LEFT));
}
function studio_tmp_root() {
  $root = sys_get_temp_dir() . '/studio-unit-' . bin2hex(random_bytes(6));
  mkdir($root, 0700, true);
  foreach (['drafts', 'uploads-quarantine', 'mint-receipts', 'tmp', 'rate'] as $b) mkdir($root . '/' . $b, 0700);
  register_shutdown_function(function () use ($root) {
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($it as $f) { $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname()); }
    @rmdir($root);
  });
  return $root;
}
const STUDIO_TEST_DESIGN = ['schema'=>'atlas.asset-studio.design/0.1','template'=>'trophy','name'=>'First Light','description'=>'Awarded for the first walk through the lobby.','finish'=>'gold'];
