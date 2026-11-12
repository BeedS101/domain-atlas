<?php
// The crawled index and the submit rate-limit state, each one JSON file under the data directory
// (lib/ by default, web-denied by lib/.htaccess; a directory outside the web root is better).
// Every write is a read-modify-write under an exclusive flock on a separate lock file, and the new
// content is written to a temporary file and renamed, so a crash never leaves a half-written file.

function dir_data_file($name) {
  $dir = dir_config()['dataDir'];
  if (!is_dir($dir)) @mkdir($dir, 0700, true);
  return $dir . '/atlas-directory-' . $name;
}

function dir_json_load($file, $default) {
  if (!is_file($file)) return $default;
  $decoded = json_decode((string) file_get_contents($file), true);
  return is_array($decoded) ? $decoded : $default;
}

function dir_json_save($file, $data) {
  $tmp = $file . '.tmp' . getmypid();
  if (file_put_contents($tmp, json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)) === false) throw new DirectoryException('the directory could not write its index');
  @chmod($tmp, 0600);
  if (!rename($tmp, $file)) { @unlink($tmp); throw new DirectoryException('the directory could not write its index'); }
}

function dir_locked($lockName, $fn) {
  $lock = fopen(dir_data_file($lockName . '.lock'), 'c');
  if (!$lock) throw new DirectoryException('the directory could not open its lock file');
  flock($lock, LOCK_EX);
  try { return $fn(); } finally { flock($lock, LOCK_UN); fclose($lock); }
}

function dir_store_read() {
  $data = dir_json_load(dir_data_file('index.json'), []);
  return ['manifests' => isset($data['manifests']) && is_array($data['manifests']) ? $data['manifests'] : [], 'worlds' => isset($data['worlds']) && is_array($data['worlds']) ? $data['worlds'] : []];
}

// $fn receives the whole store by reference and may change it; it is saved afterwards.
function dir_store_update($fn) {
  return dir_locked('index', function () use ($fn) {
    $data = dir_store_read();
    $result = $fn($data);
    dir_json_save(dir_data_file('index.json'), $data);
    return $result;
  });
}

// Submissions per client in the last hour. Clients are kept as a keyed hash, not as addresses.
function dir_submit_allowed($ip) {
  $limit = dir_config()['submitsPerHour'];
  return dir_locked('ratelimit', function () use ($ip, $limit) {
    $file = dir_data_file('ratelimit.json');
    $state = dir_json_load($file, []);
    if (empty($state['secret'])) $state['secret'] = bin2hex(random_bytes(16));
    $clients = isset($state['clients']) && is_array($state['clients']) ? $state['clients'] : [];
    $now = time();
    foreach ($clients as $key => $times) {
      $kept = array_values(array_filter((array) $times, function ($t) use ($now) { return $now - $t < 3600; }));
      if ($kept) $clients[$key] = $kept; else unset($clients[$key]);
    }
    $id = hash_hmac('sha256', (string) $ip, $state['secret']);
    $recent = isset($clients[$id]) ? $clients[$id] : [];
    $allowed = count($recent) < $limit;
    if ($allowed) $recent[] = $now;
    $clients[$id] = $recent;
    $state['clients'] = $clients;
    dir_json_save($file, $state);
    return $allowed;
  });
}
