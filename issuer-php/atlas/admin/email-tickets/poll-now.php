<?php
// POST /atlas/admin/email-tickets/poll-now — mirrors issuer-server/
// server.js's same route (SPEC.md §13.3). Admin-gated (require_admin_
// auth(), same {payload, proof} or {payload, token} wire shape as every
// other admin endpoint) — runs exactly one inbound poll pass right now.
// This endpoint IS the inbound mechanism for this bundle: PHP has no
// background timer to run one on its own, so a real deployment points a
// cron job (or other external scheduler) at this endpoint instead; a
// test can also call it directly to read back an exact summary rather
// than waiting on a schedule.
require_once __DIR__ . '/../../../lib/bootstrap.php';
require_once __DIR__ . '/../../../lib/smtp.php';
require_once __DIR__ . '/../../../lib/imap.php';
require_once __DIR__ . '/../../../lib/mime-parse.php';
require_once __DIR__ . '/../../../lib/email-tickets.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

$body = read_admin_json_body();

$payload = $body['payload'] ?? null;
$proof = $body['proof'] ?? null;
$token = $body['token'] ?? null;
$auth = require_admin_auth($payload, $proof, $token, '/atlas/admin/email-tickets/poll-now');
if (isset($auth['error'])) admin_auth_fail($auth);

// Deliveries left part-way by a stop are finished on every pass.
require_once __DIR__ . '/../../../lib/delivery.php';
try { atlas_delivery_sweep(); } catch (Exception $e) { /* reported by the next pass */ }

$config = atlas_email_tickets_config();
if (!$config['imapHost']) {
  send_json(400, ['error' => 'this domain has not configured inbound email tickets (SPEC.md §13.3)']);
}

try {
  $summary = poll_email_tickets_once($kp, $config);
  send_json(200, ['status' => 'polled', 'summary' => $summary]);
} catch (Exception $e) {
  send_json(502, ['error' => 'poll failed: ' . $e->getMessage()]);
}
