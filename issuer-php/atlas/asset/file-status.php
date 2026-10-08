<?php
// GET /atlas/asset/file-status?id=<credentialId> — mirrors issuer-server/
// server.js's same route (SPEC.md §13.5). Read-only: is this file's
// credential still claimable? Reveals nothing beyond what the public
// revocation list and this domain's own registry already determine for an id.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
if ($_SERVER['REQUEST_METHOD'] !== 'GET') send_json(405, ['error' => 'GET only']);

$id = $_GET['id'] ?? null;
if (!is_string($id) || $id === '') send_json(400, ['error' => 'id is required']);

$reason = revocation_reason_of($id);
$state = 'unknown';
if (file_claim_of(read_file_claims(), $id) !== null) {
  $state = 'claimed';
} elseif ($reason !== null) {
  $state = $reason === 'file-claimed' ? 'claimed' : 'revoked';
} elseif (has_bearer($id)) {
  $state = is_suspended($id) ? 'suspended' : 'claimable';
}
send_json(200, ['id' => $id, 'state' => $state, 'claimable' => $state === 'claimable']);
