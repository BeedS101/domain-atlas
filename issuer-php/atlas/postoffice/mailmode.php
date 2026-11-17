<?php
// POST /atlas/postoffice/mailmode — mirrors issuer-server/server.js's same route.
//
// Lets a member switch their OWN Post Office membership at this domain between two modes:
//   - "open" (the default): accept mail from fellow members here and from senders relayed by other Post Offices
//     (atlas/postoffice/send.php's membership check and atlas/postoffice/relay.php's attestation check still apply).
//   - "friendsOnly": only accept mail from public keys in `payload.friends`, the allowed-sender list the wallet builds from
//     its Friends and its pending outgoing friend requests (extension/wallet.js friendsAllowlist()). Each update REPLACES the
//     list, and the wallet sends a fresh one whenever it changes, so this route is called often; a block (block.php) wins
//     over the list. Only public keys are sent.
//
// Authenticated the same self-signed-envelope way
// atlas/postoffice/send.php authenticates its sender half:
// verify_envelope($payload, $proof), then $proof['publicKey'] IS the
// caller. update_postoffice_member() (lib/store.php) means a caller can
// only ever touch THEIR OWN membership here — there's no way to name a
// different owner in the request.
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

$mode = $payload['mode'] ?? null;
if ($mode !== 'open' && $mode !== 'friendsOnly') {
  send_json(400, ['error' => 'payload.mode must be "open" or "friendsOnly"']);
}
if ($mode === 'friendsOnly' && !isset($payload['friends'])) {
  send_json(400, ['error' => 'payload.friends (an array of public keys) is required when switching to friendsOnly']);
}
$friends = $payload['friends'] ?? [];
if (!is_array($friends)) {
  send_json(400, ['error' => 'payload.friends must be an array of public keys']);
}
if (count($friends) > ATLAS_POSTOFFICE_SETTINGS_MAX_LIST) {
  send_json(400, ['error' => 'friends list too large (max ' . ATLAS_POSTOFFICE_SETTINGS_MAX_LIST . ')']);
}

$ok = verify_envelope($payload, $proof);
if (!$ok) send_json(400, ['error' => 'signature does not check out']);

$member = update_postoffice_member($proof['publicKey'], function (&$m) use ($mode, $friends) {
  $m['mailMode'] = $mode;
  // Friends only means anything in friendsOnly mode — clearing it on the
  // way back to open is a small privacy courtesy (no reason to keep a
  // snapshot around once nothing checks it), not a functional requirement.
  if ($mode === 'friendsOnly') {
    $clean = array_values(array_unique(array_filter($friends, 'is_string')));
    $m['friends'] = array_slice($clean, 0, ATLAS_POSTOFFICE_SETTINGS_MAX_LIST);
  } else {
    $m['friends'] = [];
  }
});
if ($member === null) {
  send_json(400, ['error' => 'you do not hold a Global Mail membership at this domain']);
}

send_json(200, [
  'ok' => true,
  'mailMode' => $member['mailMode'],
  'friendsCount' => count($member['friends'] ?? []),
]);
