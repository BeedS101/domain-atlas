<?php
// POST /atlas/admin/suspensions — mirrors issuer-server/server.js's same route. Admin-gated (require_admin_auth(),
// same wire shape as every other admin action here: {payload, proof} or {payload, token}).
//
// Every credential currently suspended, newest first, so the admin panel can show what is frozen and lift one.
// Read through read_suspensions(), the same path every other check uses, so the list matches what is enforced:
// an entry whose expiry has passed is resolved first (lifted, or revoked for 'finalize'), never shown as active.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();

$body = read_admin_json_body();

$payload = $body['payload'] ?? [];
$proof = $body['proof'] ?? null;
$token = $body['token'] ?? null;
$auth = require_admin_auth($payload, $proof, $token, '/atlas/admin/suspensions');
if (isset($auth['error'])) admin_auth_fail($auth);

$limit = 500;
$all = [];
foreach (read_suspensions()['suspended'] as $s) {
  if (!is_array($s) || !isset($s['id']) || !is_string($s['id'])) continue;
  $all[] = [
    'id' => substr($s['id'], 0, 300),
    'reason' => isset($s['reason']) && is_string($s['reason']) ? substr($s['reason'], 0, 200) : '',
    'suspendedAt' => isset($s['suspendedAt']) && is_string($s['suspendedAt']) ? substr($s['suspendedAt'], 0, 40) : null,
    'expiresAt' => isset($s['expiresAt']) && is_string($s['expiresAt']) ? substr($s['expiresAt'], 0, 40) : null,
    'onExpire' => ($s['onExpire'] ?? 'lift') === 'finalize' ? 'finalize' : 'lift',
  ];
}
usort($all, function ($a, $b) { return strcmp((string) $b['suspendedAt'], (string) $a['suspendedAt']); });
send_json(200, ['now' => gmdate('Y-m-d\TH:i:s\Z'), 'total' => count($all), 'suspended' => array_slice($all, 0, $limit)]);
