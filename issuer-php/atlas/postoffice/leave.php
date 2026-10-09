<?php
// POST /atlas/postoffice/leave — mirrors issuer-server/server.js's same
// route.
//
// A member gives up one membership. The credential is revoked (which stops
// mail in both directions and releases the handle), the handle and consent
// lists are cleared, and the mailbox is emptied. Signed by the
// membership's own owner, so nobody can end another person's. Repeating it
// is harmless.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$payload = $body['payload'] ?? null;
$proof = $body['proof'] ?? null;
if (!is_array($payload) || !is_array($proof)) {
  send_json(400, ['error' => 'payload and proof are required']);
}
if (!isset($payload['credentialId']) || !is_string($payload['credentialId']) || $payload['credentialId'] === '') {
  send_json(400, ['error' => 'payload.credentialId is required']);
}
if (!verify_envelope($payload, $proof)) {
  send_json(400, ['error' => 'signature does not check out']);
}

$member = leave_postoffice_membership($payload['credentialId'], $proof['publicKey'] ?? '');
if ($member === null) {
  send_json(400, ['error' => 'you do not hold that membership at this domain']);
}
if (!is_revoked($member['credentialId'])) atlas_revoke($member['credentialId'], 'left');
$deleted = delete_mailbox($member['credentialId']);
send_json(200, ['ok' => true, 'deleted' => $deleted]);
