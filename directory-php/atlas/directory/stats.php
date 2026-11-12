<?php
// GET /atlas/directory/stats
require_once __DIR__ . '/lib/bootstrap.php';
dir_preflight();
try {
  $data = dir_store_read();
  dir_send_json(200, ['manifestsTracked' => count($data['manifests']), 'worldsIndexed' => count($data['worlds']), 'crawlIntervalMs' => dir_config()['crawlIntervalSeconds'] * 1000]);
} catch (Throwable $e) {
  error_log('directory stats: ' . $e->getMessage());
  dir_send_json(500, ['error' => 'internal error']);
}
