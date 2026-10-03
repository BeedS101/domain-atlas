<?php
// POST /atlas/asset/transfer-to-email — mirrors issuer-server/server.js's
// same route (SPEC.md §13.1's "entering the system"): atlas/asset/
// transfer.php's own sibling, targeting an email address instead of a
// recipient's public key. Verification is transfer.php's own
// (check_presented_giftable_asset), gated additionally on this domain
// actually having SMTP delivery configured right now — rejected outright
// if it doesn't. Once authorized, the presented credential is revoked
// (reason 'email-transferred') and a fresh one minted exactly as
// transfer.php already does for a wallet-to-wallet move, with one
// necessary difference: owner.publicKey on the freshly minted credential
// is a keypair generated and immediately discarded
// (generate_discarded_owner_public_key()) — there is no wallet on the
// receiving end for it to belong to. Mint-before-revoke, same ordering
// every other credential-replacing route in this bundle already uses: the
// fresh credential is minted and the outbound send attempted before the
// presented one is revoked, so a send the mail server never actually
// accepts leaves the sender exactly as they were.
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

$credential = $body['credential'] ?? null;
$recipientEmail = $body['recipientEmail'] ?? null;
$intent = $body['intent'] ?? null;
if (!$credential || !$recipientEmail || !$intent) {
  send_json(400, ['error' => 'credential, recipientEmail, and intent are all required']);
}
if (!preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $recipientEmail)) {
  send_json(400, ['error' => 'recipientEmail does not look like an email address']);
}
if (!isset($intent['payload']) || !isset($intent['proof'])) {
  send_json(400, ['error' => 'intent must carry payload and proof']);
}
$payload = $intent['payload'];
if (($payload['credentialId'] ?? null) !== $credential['id'] || ($payload['recipientEmail'] ?? null) !== $recipientEmail || ($payload['action'] ?? null) !== 'transfer-to-email') {
  send_json(400, ['error' => 'intent does not authorize transferring this credential to this address']);
}

$config = atlas_email_tickets_config();
if (!$config['smtpHost'] || !$config['fromAddress']) {
  send_json(400, ['error' => 'this domain has not configured email-delivered tickets (SPEC.md §13)']);
}

$envelopeOk = verify_envelope($payload, $intent['proof']);
if (!$envelopeOk) send_json(400, ['error' => 'intent signature does not check out']);
$senderPub = $intent['proof']['publicKey'];

$problem = check_presented_giftable_asset($kp['publicKeyB64url'], $credential, $senderPub, $credential['asset']['class'] ?? null);
if ($problem) send_json(400, ['error' => $problem]);

$discardedOwnerKey = generate_discarded_owner_public_key();
$minted = transfer_unique_asset($kp['privateKey'], $kp['publicKeyB64url'], $discardedOwnerKey, $credential);

try {
  atlas_smtp_send_mail([
    'host' => $config['smtpHost'],
    'port' => $config['smtpPort'],
    'secure' => $config['smtpSecure'],
    'user' => $config['smtpUser'],
    'pass' => $config['smtpPass'],
    'from' => $config['fromAddress'],
    'to' => $recipientEmail,
    'subject' => $minted['asset']['name'] ?? 'Your ticket',
    'textBody' => 'You have been sent "' . ($minted['asset']['name'] ?? $minted['asset']['class']) . '" from ' . atlas_domain() .
      ".\n\nThe attached file is your ticket. Keep it safe — forwarding this email, with the new holder CC'd, is how you pass it on.",
    'attachments' => [[
      'filename' => 'ticket-' . substr($minted['id'], strrpos($minted['id'], ':') + 1) . '.json',
      'contentType' => 'application/json',
      'content' => json_encode($minted, JSON_UNESCAPED_SLASHES),
    ]],
  ]);
} catch (Exception $e) {
  // Delivery check before finalizing: the sender's original credential
  // above was never touched, so a send the mail server never actually
  // accepted leaves them exactly as they were. The fresh mint nobody will
  // ever hold is undone the same way any abandoned mint always is — never
  // a real transfer, so never 'email-transferred' below.
  atlas_revoke($minted['id'], 'issuer-request');
  send_json(502, ['error' => 'could not deliver to ' . $recipientEmail . ': ' . $e->getMessage()]);
}

atlas_revoke($credential['id'], 'email-transferred');
archive_if_audited($credential, 'email-transferred');
send_json(200, ['status' => 'email-transferred', 'to' => $recipientEmail]);
