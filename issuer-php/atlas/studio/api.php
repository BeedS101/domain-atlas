<?php
// Asset Studio preview: design validation only. No issuer key access or minting.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');

function studio_reply($code,$body) {
  http_response_code($code);
  echo json_encode($body, JSON_UNESCAPED_SLASHES);
  exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST' && ($_GET['op'] ?? '') === 'validate') {
  if (stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') !== 0) studio_reply(415,['ok'=>false,'error'=>'json-required']);
  if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 4096) studio_reply(413,['ok'=>false,'error'=>'too-large']);
  $raw=file_get_contents('php://input', false, null, 0, 4097);
  if ($raw===false || strlen($raw)>4096) studio_reply(413,['ok'=>false,'error'=>'too-large']);
  $design=json_decode($raw,true);
  require_once __DIR__.'/inc/design-validator.php';
  $result=atlas_studio_validate_design($design);
  studio_reply($result['ok'] ? 200 : 400, $result);
}
studio_reply(403,['ok'=>false,'error'=>'minting-not-enabled']);
