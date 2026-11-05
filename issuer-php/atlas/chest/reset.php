<?php
// POST /atlas/chest/reset — admin-gated. {payload: {chestId, ownerPublicKey}, proof} or {payload, token}.
// Lets an owner open a chest again after the reward was lost (for example deleted from the wallet): the
// record that this key opened the chest is removed. The owner still needs a new key, and the reward
// already issued stays valid. Answers {ok, chestId, wasOpened}; a chest that was not opened is a no-op.
require_once __DIR__ . '/../../lib/bootstrap.php';
require_once __DIR__ . '/../../lib/chests.php';
handle_preflight();
require_post();
atlas_load_keys();

$body = read_admin_json_body();
$payload = $body['payload'] ?? null;
$proof = $body['proof'] ?? null;
$token = $body['token'] ?? null;
$auth = require_admin_auth($payload, $proof, $token, '/atlas/chest/reset');
if (isset($auth['error'])) admin_auth_fail($auth);

$chestId = $payload['chestId'] ?? null;
$owner = $payload['ownerPublicKey'] ?? null;
if (atlas_chest_entry($chestId) === null) send_json(404, ['error' => 'unknown chest', 'code' => 'unknown-chest']);
if (!is_string($owner) || $owner === '' || strlen($owner) > 200) send_json(400, ['error' => 'payload.ownerPublicKey is required']);

$busy = atlas_lease('chest', $chestId . "\n" . $owner);
if ($busy !== null) send_json(503, ['error' => $busy, 'code' => 'busy']);
try {
  $wasOpened = atlas_chest_reset($chestId, $owner);
} catch (Exception $e) {
  send_json($e->getCode() >= 400 && $e->getCode() < 600 ? $e->getCode() : 503, ['error' => $e->getMessage()]);
}
send_json(200, ['ok' => true, 'chestId' => $chestId, 'wasOpened' => $wasOpened]);
