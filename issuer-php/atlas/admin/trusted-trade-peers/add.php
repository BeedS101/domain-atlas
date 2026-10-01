<?php
// POST /atlas/admin/trusted-trade-peers/add — mirrors issuer-server/
// server.js's same route.
//
// Admin-gated (require_admin_auth(), above), same wire shape as
// atlas/suspend.php: {payload: {domain}, proof} or {payload, token}.
// `domain` is taken as given — trusting it is an explicit,
// mutual-by-convention operator decision (see
// atlas_trusted_trade_peers_file()'s own comment in lib/store.php), not
// something this endpoint can verify on its own, the same way an operator
// hand-editing the old literal never had it verified either.
require_once __DIR__ . '/../../../lib/bootstrap.php';
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
if (!is_array($payload) || empty($payload['domain']) || !is_string($payload['domain'])) {
  send_json(400, ['error' => 'payload.domain is required']);
}
$auth = require_admin_auth($payload, $proof, $token);
if (isset($auth['error'])) send_json(401, ['error' => $auth['error']]);
$added = atlas_add_trusted_trade_peer($payload['domain']);
send_json(200, ['ok' => true, 'added' => $added, 'peers' => atlas_trusted_trade_peers()]);
