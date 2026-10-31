<?php
// Asset Studio API.
//   POST ?op=validate   design            -> validated design + canonical SHA-256 fingerprint (no state, always on)
//   GET  ?op=status                       -> { mintEnabled }
//   POST ?op=challenge  design, recipient -> short-lived single-use mint challenge + the exact request to sign
//   POST ?op=mint       design, nonce, proof -> one issuer-signed atlas.demo.studio.collectible credential
// Minting is OFF unless the private studio-config.json enables it (see inc/studio-mint.php); challenge and
// mint then answer 403. No operation here signs caller-supplied data, resets state or reads an admin token.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');

function studio_reply($code, $body) {
  http_response_code($code);
  echo isset($body['__raw']) && is_string($body['__raw']) ? $body['__raw'] : json_encode($body, JSON_UNESCAPED_SLASHES);
  exit;
}

function studio_read_json($limit) {
  if (stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') !== 0) studio_reply(415, ['ok'=>false,'error'=>'json-required']);
  if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $limit) studio_reply(413, ['ok'=>false,'error'=>'too-large']);
  $raw = file_get_contents('php://input', false, null, 0, $limit + 1);
  if ($raw === false || strlen($raw) > $limit) studio_reply(413, ['ok'=>false,'error'=>'too-large']);
  $data = json_decode($raw, true);
  if (!is_array($data)) studio_reply(400, ['ok'=>false,'error'=>'invalid-json']);
  return $data;
}

$method = $_SERVER['REQUEST_METHOD'] ?? '';
$op = isset($_GET['op']) && is_string($_GET['op']) ? $_GET['op'] : '';

if ($method === 'POST' && $op === 'validate') {
  $design = studio_read_json(4096);
  require_once __DIR__.'/inc/design-fingerprint.php';
  $result = atlas_studio_design_fingerprint($design);
  studio_reply($result['ok'] ? 200 : 400, $result);
}

if (!in_array($op, ['status', 'challenge', 'mint'], true)) studio_reply(404, ['ok'=>false,'error'=>'unknown-operation']);
if ($op === 'status' ? $method !== 'GET' : $method !== 'POST') studio_reply(405, ['ok'=>false,'error'=>'method-not-allowed']);

try {
  require_once __DIR__.'/../../lib/bootstrap.php';
  require_once __DIR__.'/inc/studio-mint.php';
  $cfg = ['enabled'=>false];
  $root = null;
  try {
    $root = atlas_studio_storage_root();
    $cfg = atlas_studio_config($root);
  } catch (RuntimeException $e) {
    $cfg = ['enabled'=>false,'reason'=>$e->getMessage()];
  }
  // The public answer never says why minting is off; the operator reads the reason in the PHP error log.
  if ($cfg['enabled'] !== true && isset($cfg['reason']) && !in_array($cfg['reason'], ['mint-not-configured', 'mint-disabled'], true)) {
    error_log('studio: minting off: ' . $cfg['reason']);
  }
  if ($op === 'status') studio_reply(200, ['ok'=>true,'mintEnabled'=>$cfg['enabled'] === true]);
  if ($cfg['enabled'] !== true) studio_reply(403, ['ok'=>false,'error'=>'minting-not-enabled']);

  // A browser sends Origin on cross-site requests; one that is not a configured page origin is refused.
  // There are no CORS headers, so other sites cannot read responses either.
  if (isset($_SERVER['HTTP_ORIGIN']) && !in_array($_SERVER['HTTP_ORIGIN'], $cfg['origins'], true)) studio_reply(403, ['ok'=>false,'error'=>'origin-not-allowed']);
  $actor = atlas_studio_actor($_SERVER['REMOTE_ADDR'] ?? null);
  if (!atlas_studio_rate_check($root, 'call', $actor, 120, 60)) studio_reply(429, ['ok'=>false,'error'=>'rate-limited']);

  $body = studio_read_json($op === 'mint' ? 16384 : 4096);
  list($status, $reply) = $op === 'mint' ? atlas_studio_mint($root, $cfg, $body, $actor) : atlas_studio_issue_challenge($root, $cfg, $body, $actor);
  studio_reply($status, $reply);
} catch (Throwable $e) {
  error_log('studio: '.get_class($e).': '.$e->getMessage());
  studio_reply($e->getCode() === 503 ? 503 : 500, ['ok'=>false,'error'=>$e->getCode() === 503 ? 'unavailable' : 'internal-error']);
}
