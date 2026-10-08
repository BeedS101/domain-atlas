<?php
// POST /atlas/postoffice/handle — mirrors issuer-server/server.js's same
// route. Handle addressing: a short name at this Post Office instead of the
// raw public key.
//
// Lets a member claim, change, or clear their OWN handle at this domain —
// self-signed the same way mailmode.php/block.php/unblock.php authenticate
// their caller, so a caller can only ever touch their own membership.
// payload.handle is either a string to claim (validated for shape,
// profanity, and per-domain uniqueness) or an empty string/null to release
// whatever handle this member currently holds. Re-submitting your OWN
// current handle succeeds as a no-op, not a "taken" conflict — the
// uniqueness check excludes the caller's own entry from the search.
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

$rawHandle = array_key_exists('handle', $payload) ? $payload['handle'] : false;
$wantsClear = $rawHandle === null || $rawHandle === '';
if (!$wantsClear) {
  if (!is_string($rawHandle) || !preg_match(ATLAS_POSTOFFICE_HANDLE_PATTERN, $rawHandle)) {
    send_json(400, ['error' => 'handle must be 2-24 characters, letters/numbers/underscore/hyphen only']);
  }
  if (atlas_handle_contains_blocked_word($rawHandle)) {
    send_json(400, ['error' => "that handle isn't allowed here — try something else"]);
  }
}

$ok = verify_envelope($payload, $proof);
if (!$ok) send_json(400, ['error' => 'signature does not check out']);

if (!$wantsClear) {
  $claim = claim_postoffice_handle($proof['publicKey'], $rawHandle);
  if (isset($claim['error'])) {
    if ($claim['error'] === 'taken') send_json(400, ['error' => 'that handle is already taken at this Post Office — try another']);
    send_json(400, ['error' => 'you do not hold a Global Mail membership at this domain']);
  }
  send_json(200, ['ok' => true, 'handle' => $claim['member']['handle'] ?? null]);
}

$member = update_postoffice_member($proof['publicKey'], function (&$m) {
  unset($m['handle']);
});
if ($member === null) {
  send_json(400, ['error' => 'you do not hold a Global Mail membership at this domain']);
}

send_json(200, ['ok' => true, 'handle' => $member['handle'] ?? null]);
