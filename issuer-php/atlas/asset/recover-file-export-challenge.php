<?php
// POST /atlas/asset/recover-file-export-challenge — mirrors issuer-server/
// server.js's same route (SPEC.md §13.5.1): step one of recovering an
// interrupted export. Returns a single-use challenge for the owner to sign.
// Stateless and unauthenticated, and identical for any id, so it reveals
// nothing about whether an export exists.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}
$credentialId = $body['credentialId'] ?? null;
if (!is_string($credentialId) || $credentialId === '' || strlen($credentialId) > 512) {
  send_json(400, ['error' => 'credentialId is required']);
}

// Held so the issuer's secret is created exactly once.
$lock = atlas_bearer_lock();
send_json(200, issue_recovery_challenge($credentialId));
