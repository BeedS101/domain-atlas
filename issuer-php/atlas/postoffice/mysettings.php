<?php
// POST /atlas/postoffice/mysettings — mirrors issuer-server/server.js's
// same route. Task #94 (consent/block model).
//
// Read-your-own-settings — the one Post Office roster lookup that IS safe
// to expose over HTTP despite the no-public-listing reasoning written
// above atlas_subscribers_file()/record_postoffice_send() in lib/store.php:
// it's gated by the exact same self-signed envelope as
// mailmode.php/block.php/unblock.php, so it only ever hands a caller back
// THEIR OWN entry — never anyone else's public key, activity, or settings.
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

$ok = verify_envelope($payload, $proof);
if (!$ok) send_json(400, ['error' => 'signature does not check out']);

$member = find_postoffice_membership($proof['publicKey']);
if ($member === null) {
  send_json(400, ['error' => 'you do not hold a Global Mail membership at this domain']);
}

send_json(200, [
  'ok' => true,
  'mailMode' => $member['mailMode'] ?? 'open',
  'blockedSenders' => $member['blockedSenders'] ?? [],
  'friendsCount' => count($member['friends'] ?? []),
]);
