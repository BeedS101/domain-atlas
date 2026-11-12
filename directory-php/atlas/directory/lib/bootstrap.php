<?php
// Domain Atlas - PHP directory (SPEC.md §3.3). PHP port of directory-server/server.js for shared
// cPanel hosting, which cannot run a long-lived Node process. Same endpoints, same rules; the
// crawl runs from a cron job (cron.php) instead of an in-process timer.
//
// Settings come from lib/atlas-directory-config.json (optional) and, for tests, the same
// environment variables the Node service reads. An environment variable wins.

ini_set('serialize_precision', '-1');

class DirectoryException extends Exception {}

function dir_config() {
  static $cfg = null;
  if ($cfg !== null) return $cfg;
  $file = [];
  $path = __DIR__ . '/atlas-directory-config.json';
  if (is_file($path)) {
    $decoded = json_decode((string) file_get_contents($path), true);
    if (is_array($decoded)) $file = $decoded;
  }
  $num = function ($env, $key, $default) use ($file) {
    $v = getenv($env);
    if ($v !== false && is_numeric($v) && (float) $v > 0) return (float) $v;
    if (isset($file[$key]) && is_numeric($file[$key]) && (float) $file[$key] > 0) return (float) $file[$key];
    return $default;
  };
  $flag = function ($env, $key) use ($file) {
    $v = getenv($env);
    if ($v !== false) return $v === '1';
    return !empty($file[$key]);
  };
  $envInterval = getenv('DIRECTORY_CRAWL_INTERVAL_MS');
  if ($envInterval !== false && is_numeric($envInterval) && (float) $envInterval > 0) $interval = max(1, (int) ceil((float) $envInterval / 1000));
  elseif (isset($file['crawlIntervalSeconds']) && is_numeric($file['crawlIntervalSeconds']) && (float) $file['crawlIntervalSeconds'] > 0) $interval = (int) $file['crawlIntervalSeconds'];
  else $interval = 21600;
  $dataDir = getenv('DIRECTORY_DATA_DIR');
  if ($dataDir === false || $dataDir === '') $dataDir = isset($file['dataDir']) && is_string($file['dataDir']) && $file['dataDir'] !== '' ? $file['dataDir'] : __DIR__;
  $blockedText = getenv('DIRECTORY_BLOCKED');
  $blockedList = $blockedText !== false ? explode(',', $blockedText) : (isset($file['blocked']) && is_array($file['blocked']) ? $file['blocked'] : []);
  $blocked = array_values(array_filter(array_map(function ($v) { return is_string($v) ? strtolower(trim($v)) : ''; }, $blockedList)));
  $cfg = [
    'crawlIntervalSeconds' => $interval,
    'maxManifests' => (int) $num('DIRECTORY_MAX_MANIFESTS', 'maxManifests', 500),
    'submitsPerHour' => (int) $num('DIRECTORY_SUBMITS_PER_HOUR', 'submitsPerHour', 20),
    'trustProxy' => $flag('DIRECTORY_TRUST_PROXY', 'trustProxy'),
    // Lifts the public-host rules so a demo or test can crawl localhost. Never for a live site.
    'allowLocal' => $flag('DIRECTORY_ALLOW_LOCAL', 'allowLocal'),
    'dataDir' => rtrim($dataDir, '/\\'),
    // Domains (or identity keys) this directory will not list. A listed site is dropped on its next crawl.
    'blocked' => $blocked,
    'fetchTimeoutSeconds' => 5,
    'maxManifestBytes' => 256 * 1024,
    'maxWorldsPerManifest' => 100,
    'maxPortalsPerWorld' => 50,
    'maxRequestBytes' => 4 * 1024,
    'staleAfterFailures' => 3,
    'dropAfterFailures' => 20,
    'defaultLimit' => 50,
    'maxLimit' => 100,
  ];
  return $cfg;
}

const DIRECTORY_WELL_KNOWN_PATH = '/.well-known/spatial.json';

function dir_cors() {
  header('Access-Control-Allow-Origin: *');
  header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
  header('Access-Control-Allow-Headers: Content-Type');
  header('X-Content-Type-Options: nosniff');
}

function dir_send_json($status, $obj, $extraHeaders = []) {
  http_response_code($status);
  header('Content-Type: application/json');
  dir_cors();
  foreach ($extraHeaders as $name => $value) header($name . ': ' . $value);
  echo json_encode($obj, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR);
  exit;
}

function dir_preflight() {
  if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    dir_cors();
    exit;
  }
}

function dir_client_ip() {
  $cfg = dir_config();
  if ($cfg['trustProxy'] && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
    $parts = explode(',', $_SERVER['HTTP_X_FORWARDED_FOR']);
    $last = trim(end($parts));
    if ($last !== '') return $last;
  }
  return $_SERVER['REMOTE_ADDR'] ?? 'unknown';
}

function dir_str($value, $max) {
  if (!is_string($value)) return null;
  return function_exists('mb_substr') ? mb_substr($value, 0, $max, 'UTF-8') : substr($value, 0, $max);
}

function dir_normalize_host($value) {
  return is_string($value) ? rtrim(strtolower(trim($value)), '.') : '';
}

require_once __DIR__ . '/store.php';
require_once __DIR__ . '/fetch.php';
require_once __DIR__ . '/crypto.php';
require_once __DIR__ . '/directory.php';
