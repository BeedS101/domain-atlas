<?php
// Asset Studio preview: NO issuance endpoint is enabled.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');
http_response_code(403);
echo json_encode(['ok'=>false,'error'=>'minting-not-enabled']);
