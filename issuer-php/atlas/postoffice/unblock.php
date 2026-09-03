<?php
// POST /atlas/postoffice/unblock — mirrors issuer-server/server.js's same
// route, and atlas/postoffice/block.php right above, just removing instead
// of adding. Task #94 (consent/block model).
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
$blockedPublicKey = $payload['blockedPublicKey'] ?? null;
if (!is_string($blockedPublicKey) || $blockedPublicKey === '') {
  send_json(400, ['error' => 'payload.blockedPublicKey is required']);
}

$ok = verify_envelope($payload, $proof);
if (!$ok) send_json(400, ['error' => 'signature does not check out']);

$member = update_postoffice_member($proof['publicKey'], function (&$m) use ($blockedPublicKey) {
  $m['blockedSenders'] = array_values(array_filter($m['blockedSenders'] ?? [], function ($k) use ($blockedPublicKey) {
    return $k !== $blockedPublicKey;
  }));
});
if ($member === null) {
  send_json(400, ['error' => 'you do not hold a Global Mail membership at this domain']);
}

send_json(200, ['ok' => true, 'blockedSenders' => $member['blockedSenders'] ?? []]);
