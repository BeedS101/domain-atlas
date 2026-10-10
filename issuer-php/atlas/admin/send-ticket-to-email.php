<?php
// POST /atlas/admin/send-ticket-to-email — mirrors issuer-server/server.js's
// same route. Admin-gated. For an operator (or a company's own backend
// acting as one) that issues tickets: mints a fresh instance of a ticket
// class straight to an email address, with no wallet-held credential to
// start from. The result is the same bearer ticket transfer-to-email.php
// produces (SPEC.md §13.1): owned by a discarded key, listed in the bearer
// registry, delivered as an attachment. Delivery is checked before the mint
// is kept: a send the mail server does not accept undoes the mint. Only a
// non-fungible, non-bound class is eligible, as for any email ticket.
//
// Wire shape is {payload: {assetClass, recipientEmail, properties?}, proof}
// or {payload, token}, the envelope every admin route uses.
require_once __DIR__ . '/../../lib/bootstrap.php';
require_once __DIR__ . '/../../lib/smtp.php';
require_once __DIR__ . '/../../lib/delivery.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

$body = read_admin_json_body();

$payload = $body['payload'] ?? null;
$auth = require_admin_auth($payload, $body['proof'] ?? null, $body['token'] ?? null, '/atlas/admin/send-ticket-to-email');
if (isset($auth['error'])) admin_auth_fail($auth);

$assetClass = $payload['assetClass'] ?? null;
$recipientEmail = $payload['recipientEmail'] ?? null;
$hasProperties = is_array($payload) && array_key_exists('properties', $payload);
$properties = $payload['properties'] ?? null;

if (!is_string($recipientEmail) || !preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $recipientEmail)) {
  send_json(400, ['error' => 'recipientEmail does not look like an email address']);
}
if (!is_string($assetClass) || !isset(ATLAS_ASSET_CATALOG[$assetClass])) {
  send_json(400, ['error' => 'Unknown assetClass.']);
}
$catalogEntry = ATLAS_ASSET_CATALOG[$assetClass];
$mintGate = atlas_evaluate_mint_for_delivery(['catalogEntry' => $catalogEntry, 'transport' => 'email']);
if (!$mintGate['ok']) send_json(400, ['error' => $mintGate['message']]);
if ($hasProperties && !is_array($properties)) {
  send_json(400, ['error' => "properties, when given, must be a patch object onto the class's own base properties"]);
}

$adminEmailGate = atlas_evaluate_delivery_gate(['transport' => 'email', 'stage' => 'enabled', 'config' => ['emailConfigured' => atlas_email_delivery_configured()]]);
if (!$adminEmailGate['ok']) send_json(400, ['error' => $adminEmailGate['message']]);

// An optional client-chosen idempotency key makes a retry after a lost
// answer safe: the same key and address resume the one delivery instead of
// minting a second ticket. Without a key every request is its own delivery,
// and one left unconfirmed by a stop is rolled back.
$idempotencyKey = is_array($payload) ? ($payload['idempotencyKey'] ?? null) : null;
if (is_array($payload) && array_key_exists('idempotencyKey', $payload) && (!is_string($idempotencyKey) || strlen($idempotencyKey) < 1 || strlen($idempotencyKey) > 128)) {
  send_json(400, ['error' => 'idempotencyKey, when given, must be a string of 1 to 128 characters']);
}
$deliveryKey = $idempotencyKey ? 'admin-send:' . $idempotencyKey : null;
$answerAdminSend = function ($rec) use ($recipientEmail, $assetClass) {
  if ($rec !== null && ($rec['state'] ?? null) === 'delivered') {
    send_json(200, ['status' => 'email-sent', 'to' => $recipientEmail, 'ticketId' => $rec['mintedId'], 'assetClass' => $assetClass]);
  }
  $why = ($rec['lastError'] ?? null) ?: 'delivery was not completed';
  send_json(502, ['error' => 'could not deliver to ' . $recipientEmail . ': ' . $why]);
};
$priorSend = atlas_delivery_latest_for_key($deliveryKey);
if ($priorSend !== null && $priorSend['state'] !== 'rolled-back') {
  if (($priorSend['recipientHash'] ?? null) !== atlas_delivery_hash_recipient($recipientEmail) || ($priorSend['class'] ?? null) !== $assetClass) {
    send_json(409, ['error' => 'this idempotencyKey was already used for a different send', 'code' => 'idempotency-conflict']);
  }
  if ($priorSend['state'] === 'delivered') $answerAdminSend($priorSend);
  $resumed = atlas_delivery_run($priorSend['deliveryId'], ['waitSeconds' => 2]);
  if ($resumed['busy']) send_json(409, ['error' => 'a send with this idempotencyKey is already in progress', 'code' => 'in-progress']);
  $answerAdminSend($resumed['rec']);
}

$discardedOwnerKey = generate_discarded_owner_public_key();
$minted = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $discardedOwnerKey, $assetClass, 1, null, $hasProperties ? $properties : null);
file_export_fault_point('delivery:minted');
$began = atlas_delivery_begin(['key' => $deliveryKey, 'kind' => 'fresh-mint', 'class' => $assetClass, 'ownerPublicKey' => $auth['publicKey'] ?? null, 'minted' => $minted, 'recipient' => $recipientEmail]);
if (isset($began['existing'])) {
  // The key was taken between the check above and here. The mint was never
  // recorded or listed, so it is undone, and a send that has already
  // finished is answered as the first request was.
  atlas_revoke($minted['id'], 'issuer-request');
  $other = $began['existing'];
  if (($other['recipientHash'] ?? null) !== atlas_delivery_hash_recipient($recipientEmail) || ($other['class'] ?? null) !== $assetClass) {
    send_json(409, ['error' => 'this idempotencyKey was already used for a different send', 'code' => 'idempotency-conflict']);
  }
  if (($other['state'] ?? null) === 'delivered') $answerAdminSend($other);
  send_json(409, ['error' => 'a send with this idempotencyKey is already in progress', 'code' => 'in-progress']);
}
$outcome = atlas_delivery_run($began['rec']['deliveryId']);
$answerAdminSend($outcome['rec']);
