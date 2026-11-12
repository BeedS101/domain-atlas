<?php
// GET /atlas/directory/search?q=&genre=&scale=&combat=&domain=&anchorType=&identityRequired=&limit=&offset=&groupBy=site
require_once __DIR__ . '/lib/bootstrap.php';
dir_preflight();
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'GET') dir_send_json(405, ['error' => 'GET only']);
try {
  $params = [];
  foreach (['q', 'genre', 'scale', 'combat', 'domain', 'anchorType', 'identityRequired', 'limit', 'offset', 'groupBy'] as $k) {
    if (isset($_GET[$k]) && is_string($_GET[$k])) $params[$k] = $k === 'q' ? substr($_GET[$k], 0, 200) : $_GET[$k];
  }
  dir_send_json(200, dir_search($params));
} catch (Throwable $e) {
  error_log('directory search: ' . $e->getMessage());
  dir_send_json(500, ['error' => 'internal error']);
}
