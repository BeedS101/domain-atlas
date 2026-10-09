<?php
// POST /atlas/mail/delete — mirrors issuer-server/server.js's same route.
//
// The holder asks this domain to forget messages they have deleted from
// their wallet. The caller presents the credentials whose mailboxes the
// messages may sit in, and a signed list of message ids. A credential
// counts only if this domain signed it and its owner is the signer, so one
// holder can never remove another's mail. Unknown ids and ids in other
// mailboxes are skipped without error, which keeps a repeated request
// harmless.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

const ATLAS_MAIL_DELETE_MAX_IDS = 500;
const ATLAS_MAIL_DELETE_MAX_CREDENTIALS = 200;

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$credentials = $body['credentials'] ?? null;
$payload = $body['payload'] ?? null;
$proof = $body['proof'] ?? null;
if (!is_array($credentials) || !is_array($payload) || !is_array($proof)) {
  send_json(400, ['error' => 'credentials, payload, and proof are required']);
}
$messageIds = $payload['messageIds'] ?? null;
if (!is_array($messageIds) || count($messageIds) === 0) {
  send_json(400, ['error' => 'payload.messageIds must be a non-empty array']);
}
if (count($messageIds) > ATLAS_MAIL_DELETE_MAX_IDS || count($credentials) > ATLAS_MAIL_DELETE_MAX_CREDENTIALS) {
  send_json(400, ['error' => 'too many messages or credentials in one request']);
}
foreach ($messageIds as $id) {
  if (!is_string($id)) send_json(400, ['error' => 'payload.messageIds must be strings']);
}
if (!verify_envelope($payload, $proof)) {
  send_json(400, ['error' => 'proof signature does not check out']);
}

$mailboxes = [];
foreach ($credentials as $credential) {
  if (!is_array($credential) || !isset($credential['id']) || !is_string($credential['id'])) continue;
  if (!isset($credential['owner']['publicKey']) || $credential['owner']['publicKey'] !== ($proof['publicKey'] ?? null)) continue;
  if (!verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential))) continue;
  $mailboxes[] = $credential['id'];
}

$deleted = count($mailboxes) ? delete_mail_messages($messageIds, $mailboxes) : 0;
send_json(200, ['ok' => true, 'deleted' => $deleted]);
