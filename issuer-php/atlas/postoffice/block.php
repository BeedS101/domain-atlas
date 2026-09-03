<?php
// POST /atlas/postoffice/block — mirrors issuer-server/server.js's same
// route. Task #94 (consent/block model, "both, recipient's choice" per
// direct instruction).
//
// Adds one public key to the CALLER's OWN block list at this domain's Post
// Office — from then on, atlas/postoffice/send.php rejects any mail
// addressed to the caller from that sender, regardless of mail mode (a
// block always wins; friendsOnly only narrows who's eligible in the first
// place). Idempotent — blocking an already-blocked key is a no-op, not an
// error.
//
// Authenticated the same self-signed-envelope way
// atlas/postoffice/mailmode.php authenticates its caller: only ever
// touches the caller's OWN membership, found via
// update_postoffice_member() (lib/store.php).
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
  $set = $m['blockedSenders'] ?? [];
  if (!in_array($blockedPublicKey, $set, true) && count($set) < ATLAS_POSTOFFICE_SETTINGS_MAX_LIST) {
    $set[] = $blockedPublicKey;
  }
  $m['blockedSenders'] = $set;
});
if ($member === null) {
  send_json(400, ['error' => 'you do not hold a Global Mail membership at this domain']);
}

send_json(200, ['ok' => true, 'blockedSenders' => $member['blockedSenders'] ?? []]);
