<?php
// POST /atlas/revoke — mirrors issuer-server/server.js's same route.
require_once __DIR__ . '/../lib/bootstrap.php';
handle_preflight();
require_post();
atlas_load_keys(); // ensures .well-known files exist even if this is the very first request the site ever gets

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$id = $body['id'] ?? null;
$reason = $body['reason'] ?? 'issuer-request';
if (!$id) send_json(400, ['error' => 'id is required']);
atlas_revoke($id, $reason);
send_json(200, ['ok' => true]);
