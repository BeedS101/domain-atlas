<?php
// POST /atlas/revoke — mirrors issuer-server/server.js's same route.
//
// Admin-gated (require_admin_auth(), above): revoking an arbitrary
// credential by id is the most consequential thing this endpoint can do
// on an operator's behalf, so this is the first route retrofitted onto
// the domain admin roster instead of trusting whoever can reach it. Wire
// shape is {payload: {id, reason}, proof} or {payload, token} — the same
// signed-payload envelope atlas/postoffice/send.php and
// atlas/trade/submit.php already use — instead of a bare, unauthenticated
// body.
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
$auth = require_admin_auth($payload, $proof, $token);
if (isset($auth['error'])) send_json(401, ['error' => $auth['error']]);
atlas_revoke($payload['id'], $payload['reason'] ?? 'issuer-request');
send_json(200, ['ok' => true]);
