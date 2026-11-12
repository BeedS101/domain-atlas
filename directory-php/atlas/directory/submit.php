<?php
// POST /atlas/directory/submit  { "manifest": "https://example.com/.well-known/spatial.json" }
// SPEC.md §3.3. The manifest is fetched and indexed right away, so the answer says what happened.
require_once __DIR__ . '/lib/bootstrap.php';
dir_preflight();
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') dir_send_json(405, ['error' => 'POST only']);
try {
  $cfg = dir_config();
  if (!dir_submit_allowed(dir_client_ip())) dir_send_json(429, ['error' => 'too many submissions from this address; try again later'], ['Retry-After' => '3600']);
  $raw = file_get_contents('php://input', false, null, 0, $cfg['maxRequestBytes'] + 1);
  if ($raw !== false && strlen($raw) > $cfg['maxRequestBytes']) dir_send_json(413, ['error' => 'request body is too large']);
  $body = json_decode($raw === false || $raw === '' ? '{}' : $raw, true);
  if (!is_array($body)) dir_send_json(400, ['error' => 'the request body must be JSON']);
  $url = $body['manifest'] ?? null;
  if (!is_string($url) || $url === '' || strlen($url) > 2000) dir_send_json(400, ['error' => 'manifest (URL string) is required']);
  try { dir_check_url($url); } catch (DirectoryException $e) { dir_send_json(400, ['error' => $e->getMessage()]); }
  $result = dir_submit($url);
  if (!empty($result['full'])) dir_send_json(503, ['error' => 'this directory is not accepting new manifests right now']);
  if (!$result['ok']) dir_send_json(422, ['error' => $result['error']]);
  dir_send_json(200, ['indexed' => $result['worldsIndexed'], 'manifest' => $url]);
} catch (Throwable $e) {
  error_log('directory submit: ' . $e->getMessage());
  dir_send_json(500, ['error' => 'internal error']);
}
