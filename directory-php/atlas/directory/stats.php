<?php
// GET /atlas/directory/stats
require_once __DIR__ . '/lib/bootstrap.php';
dir_preflight();
try {
  dir_send_json(200, ['manifestsTracked' => dir_manifest_count(), 'worldsIndexed' => dir_world_count(), 'crawlIntervalMs' => dir_config()['crawlIntervalSeconds'] * 1000]);
} catch (Throwable $e) {
  error_log('directory stats: ' . $e->getMessage());
  dir_send_json(500, ['error' => 'internal error']);
}
