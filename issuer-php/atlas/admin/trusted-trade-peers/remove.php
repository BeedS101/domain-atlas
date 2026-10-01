<?php
// POST /atlas/admin/trusted-trade-peers/remove — mirrors issuer-server/
// server.js's same route.
//
// Admin-gated (require_admin_auth(), above), same wire shape as add.php.
// Lifts trust from a domain — a no-op (still 200, removed: false) if it
// wasn't trusted in the first place, same "nothing to lift" shape
// atlas/unsuspend.php uses. Removing this domain's own trust in a peer
// doesn't touch whatever that peer still has configured for this domain —
// see atlas_trusted_trade_peers_file()'s own comment in lib/store.php on
// why this is mutual by convention, not by enforcement.
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
$removed = atlas_remove_trusted_trade_peer($payload['domain']);
send_json(200, ['ok' => true, 'removed' => $removed, 'peers' => atlas_trusted_trade_peers()]);
