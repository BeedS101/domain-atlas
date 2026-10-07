<?php
// POST /atlas/admin/visits — mirrors issuer-server/server.js's same route.
// Admin-gated (require_admin_auth(), same wire shape as every other admin
// action here: {payload, proof} or {payload, token}).
//
// The per-day, per-world counts the admin panel's Visits section
// aggregates. `today` is the server's own UTC date so the panel never has
// to trust its browser's clock or timezone.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$payload = $body['payload'] ?? [];
$proof = $body['proof'] ?? null;
$token = $body['token'] ?? null;
$auth = require_admin_auth($payload, $proof, $token);
if (isset($auth['error'])) send_json(401, ['error' => $auth['error']]);

send_json(200, [
  'today' => gmdate('Y-m-d'),
  'retentionDays' => ATLAS_VISITS_RETENTION_DAYS,
  // An empty PHP array encodes as [] rather than {}, which the panel
  // would then mis-read as a list — force an object for the no-visits-yet case.
  'days' => (object) read_visits()['days'],
]);
