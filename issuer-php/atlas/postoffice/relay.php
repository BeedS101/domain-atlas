<?php
// POST /atlas/postoffice/relay — task #97 (SPEC.md §11.4, domain-to-domain
// federation). Mirrors issuer-server/server.js's own /atlas/postoffice/relay
// handler exactly. The RECEIVING half of federation: another domain (the
// RELAYING domain, having already run its OWN send.php's sender-auth +
// sender-membership checks) asks THIS domain (the recipient's HOME domain)
// to finish delivery to one of its own members.
//
// Four checks, in order, mirroring SPEC.md §11.4 exactly — each meaningless
// without the one before it, same discipline §11.3's own three-step order
// (send.php) already follows:
//   1. Sender auth (verify_envelope) — re-run independently here, not
//      trusted secondhand from the relaying domain's own say-so.
//   2. Relaying-domain authentication — stands in for §11.3 step 2 (sender
//      membership), which this domain has no way to check directly since
//      the sender isn't ITS member.
//   3. Recipient membership + consent — identical to §11.3 step 3 in
//      send.php, just keyed off the ORIGINAL sender's public key rather
//      than whoever happened to relay the message in.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$payload = $body['payload'] ?? null;
$proof = $body['proof'] ?? null;
$relayAttestation = $body['relayAttestation'] ?? null;
$relaySignature = $body['relaySignature'] ?? null;
if (!is_array($payload) || !is_array($proof) || !is_array($relayAttestation) || !is_string($relaySignature)) {
  send_json(400, ['error' => 'payload, proof, relayAttestation, and relaySignature are required']);
}
$to = $payload['to'] ?? null;
if (!is_array($to) || empty($to['publicKey']) || empty($payload['subject']) || empty($payload['body'])) {
  send_json(400, ['error' => 'payload.to.publicKey, payload.subject, and payload.body are required']);
}
if (empty($relayAttestation['relayingDomain'])) {
  send_json(400, ['error' => 'relayAttestation.relayingDomain is required']);
}
// Sanity check, defense in depth rather than a correctness requirement.
if (!empty($to['domain']) && $to['domain'] !== atlas_domain()) {
  send_json(400, ['error' => 'this message is not addressed to this domain']);
}

// Step 1 — sender authentication, independently re-verified here exactly as
// send.php does for a local sender.
$senderOk = verify_envelope($payload, $proof);
if (!$senderOk) send_json(400, ['error' => 'sender signature does not check out']);

// Task #97's operator safety valve — checked before spending a network
// round-trip fetching the relaying domain's key, since a blocked domain's
// attestation is never going to be accepted regardless of whether it's
// genuine.
if (is_domain_blocked($relayAttestation['relayingDomain'])) {
  send_json(403, ['error' => 'this domain is not accepting relayed mail from ' . $relayAttestation['relayingDomain']]);
}

// Step 2 — relaying-domain authentication (SPEC.md §11.4 step 3): fetch its
// published key and verify the attestation against it.
try {
  $relayingDomainKey = fetch_domain_public_key($relayAttestation['relayingDomain']);
} catch (Exception $e) {
  send_json(502, ['error' => 'could not verify ' . $relayAttestation['relayingDomain'] . ': ' . $e->getMessage()]);
}
$attestationOk = verify_domain_signature($relayingDomainKey, $relayAttestation, $relaySignature);
if (!$attestationOk) {
  send_json(400, ['error' => $relayAttestation['relayingDomain'] . '\'s relay attestation does not check out']);
}

// Step 3 — recipient membership + consent, byte-for-byte the same check
// send.php runs for a local send, keyed off the ORIGINAL sender's public
// key rather than the relaying domain's own identity.
$membership = find_postoffice_membership($to['publicKey']);
if ($membership === null) {
  send_json(400, ['error' => 'recipient does not hold a valid Global Mail membership at this domain — nothing was sent']);
}
$blockedSenders = $membership['blockedSenders'] ?? [];
if (in_array($proof['publicKey'], $blockedSenders, true)) {
  send_json(400, ['error' => 'recipient is not accepting mail from you right now']);
}
if (($membership['mailMode'] ?? null) === 'friendsOnly' && !in_array($proof['publicKey'], $membership['friends'] ?? [], true)) {
  send_json(400, ['error' => 'recipient is not accepting mail from you right now']);
}

// `from` gains `homeDomain` here — SPEC.md §11.4's one addition to §11.3's
// `from` shape — naming the RELAYING domain (where the sender actually
// holds membership and registered any handle), so the recipient's client
// can render the sender's real address (handle#relayingDomain) instead of
// misattributing it to whichever domain happened to deliver the message.
$from = ['publicKey' => $proof['publicKey'], 'homeDomain' => $relayAttestation['relayingDomain']];
if (!empty($relayAttestation['relayingDomainHandle'])) {
  $from['handle'] = $relayAttestation['relayingDomainHandle'];
}
$outPayload = [
  'id' => 'urn:atlas:mail:' . atlas_uuid(),
  'credentialId' => $membership['credentialId'],
  'subject' => $payload['subject'],
  'body' => $payload['body'],
  'from' => $from,
  'sentAt' => iso_now(),
];
$signature = atlas_sign($kp['privateKey'], $outPayload);
$message = array_merge($outPayload, ['signature' => $signature]);
append_mail($message);
send_json(200, $message);
