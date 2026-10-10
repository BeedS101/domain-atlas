<?php
// GET /atlas/admin/session/nonce — mirrors issuer-server/server.js's same
// route. Ungated: a nonce is worthless without a roster key's signature
// over it (see start.php). Issuing is bounded per client address
// (ATLAS_ADMIN_NONCE_PER_CLIENT_PER_MIN) and in total outstanding
// (ATLAS_ADMIN_NONCE_CAP); see lib/store.php.
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_get();

$retryAfter = atlas_admin_take_nonce_slot();
if ($retryAfter) {
  header('Retry-After: ' . $retryAfter);
  send_json(429, ['error' => 'too many login nonce requests; try again later', 'code' => 'rate-limited', 'retryAfter' => $retryAfter]);
}
$nonce = issue_admin_nonce();
if ($nonce === null) send_json(503, ['error' => 'too many login attempts are in progress; try again shortly', 'code' => 'busy']);
send_json(200, ['nonce' => $nonce]);
