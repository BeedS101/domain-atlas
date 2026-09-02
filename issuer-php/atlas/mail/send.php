<?php
// POST /atlas/mail/send — mirrors issuer-server/server.js's same route.
//
// This is the demo/admin side of the mail system: standing in for
// whatever real interface a domain operator would actually use to write
// to members (this bundle has no such interface, so a plain endpoint
// fills in for it — you'd call this from a small admin script, a cron
// job, or curl, not from the wallet). It doesn't check that credentialId
// was really issued by this server — same demo-simplification level as
// the rest of this bundle, which trusts its own caller.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$credentialId = $body['credentialId'] ?? null;
$subject = $body['subject'] ?? null;
$msgBody = $body['body'] ?? null;
if (!$credentialId || !$subject || !$msgBody) {
  send_json(400, ['error' => 'credentialId, subject, and body are required']);
}

$payload = [
  'id' => 'urn:atlas:mail:' . atlas_uuid(),
  'credentialId' => $credentialId,
  'subject' => $subject,
  'body' => $msgBody,
  'sentAt' => iso_now(),
];
$signature = atlas_sign($kp['privateKey'], $payload);
$message = array_merge($payload, ['signature' => $signature]);
append_mail($message);
send_json(200, $message);
