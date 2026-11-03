<?php
// Switches a feature OFF from the admin panel (POST /atlas/admin/site-pause). Never switches anything on:
// turning a feature on needs settings (domains, origins, folders) an operator must choose, so that stays a file edit.
//
// Only features the registry (lib/site-features.json) marks `pause: true` and whose type has a writer here can be
// paused, and each writer changes exactly one thing:
//   studio-config       "mintEnabled" -> false in the Studio private folder's studio-config.json
//   json-enabled        "enabled" -> false in the feature's JSON config file
//   private-config-php  creates a file named DISABLED in the lab's private folder
// Every other key of a JSON file is kept as it was, JSON files are replaced atomically (write next to it, then
// rename), a file that cannot be parsed is never rewritten, and nothing outside the registry's own paths is touched.
// Credentials, renamed files and mail settings have no writer at all.
require_once __DIR__ . '/site-features.php';

function atlas_sp_refuse($code, $message) { return ['ok' => false, 'code' => $code, 'error' => $message]; }

// Sets one boolean key to false in a JSON object file. Returns ['ok' => true, 'changed' => bool] or a refusal. The
// document is decoded as objects (not arrays) so an empty {} elsewhere in the file is written back as {}, not [].
function atlas_sp_json_flag_off($file, $key) {
  $raw = atlas_sf_small_file($file, 65536);
  if ($raw === null) return ['ok' => true, 'changed' => false];
  $doc = $raw === false ? null : json_decode($raw);
  if (!is_object($doc)) return atlas_sp_refuse('unreadable-config', 'the config file cannot be parsed, so it was not changed; edit it by hand');
  if (!property_exists($doc, $key) || $doc->$key !== true) return ['ok' => true, 'changed' => false];
  $doc->$key = false;
  $text = json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
  if ($text === false) return atlas_sp_refuse('write-failed', 'the config could not be re-encoded, so it was not changed');
  try { atlas_write_file_atomic($file, $text . "\n", 0600); }
  catch (Exception $e) { return atlas_sp_refuse('write-failed', 'the config file could not be written; it was not changed'); }
  return ['ok' => true, 'changed' => true];
}

// The lab's private folder, resolved the way the reader does (environment variable, then the pointer file).
function atlas_sp_lab_dir($root, $f) {
  $env = getenv($f['env']);
  $dir = ($env !== false && $env !== '') ? rtrim($env, '/\\') : atlas_sf_pointer_path($root . '/' . $f['pointer']);
  return ($dir === null || $dir === '') ? null : rtrim($dir, '/\\');
}

// Pauses one feature by registry id. $features is the registry list. Returns ['ok' => true, 'changed' => bool,
// 'state' => state after] or ['ok' => false, 'code', 'error'].
function atlas_site_pause($root, $features, $id, $host) {
  $f = null;
  foreach ($features as $x) if (isset($x['id']) && $x['id'] === $id) $f = $x;
  if ($f === null) return atlas_sp_refuse('unknown-feature', 'no such feature');
  if (!atlas_sf_pausable($f)) return atlas_sp_refuse('not-pausable', 'this feature cannot be paused from the panel; see its "how to switch" note');
  foreach ($f['needs'] as $n) if (!is_file($root . '/' . $n)) return atlas_sp_refuse('not-installed', 'this feature is not installed on this domain');
  $changed = false;
  if ($f['type'] === 'json-enabled') {
    $r = atlas_sp_json_flag_off($root . '/' . $f['file'], 'enabled');
    if (empty($r['ok'])) return $r;
    $changed = $r['changed'];
  } elseif ($f['type'] === 'studio-config') {
    list($how, $dir) = atlas_sf_studio_root($root);
    if ($dir === null || !is_dir($dir)) return atlas_sp_refuse('not-configured', 'Studio storage is not configured, so minting is already off');
    $r = atlas_sp_json_flag_off(realpath($dir) . '/studio-config.json', 'mintEnabled');
    if (empty($r['ok'])) return $r;
    $changed = $r['changed'];
  } elseif ($f['type'] === 'private-config-php') {
    $dir = atlas_sp_lab_dir($root, $f);
    if ($dir === null) return ['ok' => true, 'changed' => false, 'state' => 'off'];
    if (!is_dir($dir) || !is_writable($dir) || atlas_sf_inside($dir, $root)) return atlas_sp_refuse('unsafe-folder', 'the lab folder is missing, not writable or inside the web root, so nothing was changed');
    $marker = $dir . '/DISABLED';
    if (!is_file($marker) && !is_link($marker)) {
      $fh = @fopen($marker, 'xb');
      if ($fh === false) return atlas_sp_refuse('write-failed', 'the DISABLED file could not be created');
      fwrite($fh, "paused from the admin panel " . gmdate('Y-m-d\TH:i:s\Z') . "\n");
      fclose($fh);
      $changed = true;
    }
  }
  $after = atlas_sf_features($root, [$f], $host);
  return ['ok' => true, 'changed' => $changed, 'state' => $after[0]['state']];
}
