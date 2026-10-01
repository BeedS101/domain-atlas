<?php
// POST /atlas/admin/trusted-trade-peers — mirrors issuer-server/server.js's
// same route. Admin-gated (require_admin_auth(), same wire shape as every
// other admin action here: {payload, proof} or {payload, token}.
//
// Every domain this domain currently treats as a trusted cross-domain
// trading counterpart (see atlas_trusted_trade_peers_file()'s own comment
// in lib/store.php), so the admin panel can show what's already trusted
// instead of guessing from memory.
require_once __DIR__ . '/../../../lib/bootstrap.php';
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

send_json(200, ['peers' => atlas_trusted_trade_peers()]);
