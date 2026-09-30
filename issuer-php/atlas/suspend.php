<?php
// POST /atlas/suspend — mirrors issuer-server/server.js's same route.
//
// Admin-gated (require_admin_auth(), above), same wire shape as
// atlas/revoke.php: {payload: {id, reason, expiresAt}, proof} or
// {payload, token}. A reversible pause instead of a permanent kill — see
// atlas_suspensions_file()'s own comment in lib/store.php for why this is
// a separate mechanism from revocation rather than a new status inside
// it. `expiresAt` (an ISO timestamp string) is optional — omit it for an
// indefinite suspension, or give a deadline for one that lifts itself
// without a follow-up call.
require_once __DIR__ . '/../lib/bootstrap.php';
handle_preflight();
require_post();
atlas_load_keys(); // ensures .well-known files exist even if this is the very first request the site ever gets

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$payload = $body['payload'] ?? null;
$proof = $body['proof'] ?? null;
$token = $body['token'] ?? null;
if (!is_array($payload) || empty($payload['id'])) send_json(400, ['error' => 'payload.id is required']);
$expiresAt = $payload['expiresAt'] ?? null;
if ($expiresAt !== null && !is_string($expiresAt)) {
  send_json(400, ['error' => 'payload.expiresAt, when given, must be an ISO timestamp string']);
}
$auth = require_admin_auth($payload, $proof, $token);
if (isset($auth['error'])) send_json(401, ['error' => $auth['error']]);
atlas_suspend($payload['id'], $payload['reason'] ?? 'issuer-request', $expiresAt);
send_json(200, ['ok' => true]);
