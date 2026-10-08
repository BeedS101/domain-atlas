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
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$payload = $body['payload'] ?? null;
$auth = require_admin_auth($payload, $body['proof'] ?? null, $body['token'] ?? null);
if (isset($auth['error'])) send_json(401, ['error' => $auth['error']]);

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
if (!empty($catalogEntry['fungible'])) send_json(400, ['error' => 'only a unique (non-fungible) item can be sent as an email ticket']);
if (($catalogEntry['tradeScope'] ?? null) === 'bound') send_json(400, ['error' => 'a bound item cannot be sent as an email ticket']);
if ($hasProperties && !is_array($properties)) {
  send_json(400, ['error' => "properties, when given, must be a patch object onto the class's own base properties"]);
}

$config = atlas_email_tickets_config();
if (!$config['smtpHost'] || !$config['fromAddress']) {
  send_json(400, ['error' => 'this domain has not configured email-delivered tickets (SPEC.md §13)']);
}

$discardedOwnerKey = generate_discarded_owner_public_key();
$minted = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $discardedOwnerKey, $assetClass, 1, null, $hasProperties ? $properties : null);
register_bearer($minted['id'], $assetClass);

try {
  atlas_mail_ticket_to($minted, $recipientEmail);
} catch (Exception $e) {
  take_bearer($minted['id']);
  atlas_revoke($minted['id'], 'issuer-request');
  send_json(502, ['error' => 'could not deliver to ' . $recipientEmail . ': ' . $e->getMessage()]);
}

send_json(200, ['status' => 'email-sent', 'to' => $recipientEmail, 'ticketId' => $minted['id'], 'assetClass' => $assetClass]);
