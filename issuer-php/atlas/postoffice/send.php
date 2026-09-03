<?php
// POST /atlas/postoffice/send — mirrors issuer-server/server.js's same
// route. Task #75/#87, SPEC.md §11.3.
//
// Distinct from ../mail/send.php in exactly the way that file's own
// comment flags as the one genuinely new server surface the Post Office
// design needed: mail/send.php trusts its own caller (the domain
// operator, calling it from a small admin script or curl); this one has
// to authenticate an arbitrary stranger instead, since anyone with a
// wallet can attempt to send here.
//
// Membership is now symmetric (task #94, per direct feedback on the first
// cut of this feature): a domain only relays mail between two people who
// BOTH hold ITS OWN Global Mail membership card. Holding the card is what
// makes this domain that person's sending relay, not just their inbox —
// the sender doesn't need to be standing in this world to send through
// it, only to have joined it at some point, the same way the recipient
// doesn't need to be standing here to receive.
// Three checks, in order:
// 1. Sender authentication — verify_envelope($payload, $proof), the same
//    self-signed-envelope check atlas/asset/trade.php already uses for
//    intents. $proof['publicKey'], once verified, IS the sender's
//    identity — no separate "from" field inside the signed payload is
//    needed for that, same reasoning trade.php's intentA/intentB already
//    rely on.
// 2. Sender membership — find_postoffice_membership($proof['publicKey'])
//    against THIS domain's own roster. This is what makes "send through
//    this Post Office" mean something: it's not an open relay for anyone
//    with a wallet, only for people this domain has already vouched for
//    by handing them a membership card.
// 3. Recipient consent — same roster, same requirement, now against
//    $payload['to']['publicKey']. Both sides have to belong to the SAME
//    Post Office for a message to move between them; a stranger to this
//    domain — sender or recipient — gets a plain rejection, not a
//    silently-dropped message.
//
// Once all three hold, this domain relays the message exactly the way
// mail/send.php sends anything else: addressed by credentialId (the
// recipient's OWN membership credential id, found via
// find_postoffice_membership()) so the wallet's existing "poll every
// domain I hold a credential from" mail-check loop picks it up with zero
// client-side changes, signed with this domain's own key so
// extension/wallet.js's verifyMailMessage() trusts it the exact same way
// it trusts domain-to-subscriber mail — the one addition there is the
// optional `from` field, so the recipient's client can show who it's
// actually from rather than implying it came from the domain itself.
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
if (!is_array($payload) || !is_array($proof)) {
  send_json(400, ['error' => 'payload and proof are required']);
}
$to = $payload['to'] ?? null;
if (!is_array($to) || empty($to['publicKey']) || empty($payload['subject']) || empty($payload['body'])) {
  send_json(400, ['error' => 'payload.to.publicKey, payload.subject, and payload.body are required']);
}

$senderOk = verify_envelope($payload, $proof);
if (!$senderOk) send_json(400, ['error' => 'sender signature does not check out']);

$senderMembership = find_postoffice_membership($proof['publicKey']);
if ($senderMembership === null) {
  send_json(400, ['error' => 'you do not hold a Global Mail membership at this domain — join its Post Office before sending through it']);
}

$membership = find_postoffice_membership($to['publicKey']);
if ($membership === null) {
  send_json(400, ['error' => 'recipient does not hold a valid Global Mail membership at this domain — nothing was sent']);
}

// Task #94 (consent/block model): the recipient's own settings on THIS
// membership can narrow who's allowed to reach them beyond "any fellow
// member" — checked here, after membership, since it's a courtesy the
// recipient controls on top of the baseline gate above, not a replacement
// for it. Block list first, then friends-only mode (a snapshot of the
// recipient's own Friends list, submitted via atlas/postoffice/mailmode.php
// — Friends itself otherwise never leaves the wallet). Same rejection
// wording either way, so a sender can't tell from the error whether they
// were blocked outright or just never added as a friend. Mirrors
// issuer-server/server.js's send handler.
$blockedSenders = $membership['blockedSenders'] ?? [];
if (in_array($proof['publicKey'], $blockedSenders, true)) {
  send_json(400, ['error' => 'recipient is not accepting mail from you right now']);
}
if (($membership['mailMode'] ?? null) === 'friendsOnly' && !in_array($proof['publicKey'], $membership['friends'] ?? [], true)) {
  send_json(400, ['error' => 'recipient is not accepting mail from you right now']);
}

$outPayload = [
  'id' => 'urn:atlas:mail:' . atlas_uuid(),
  'credentialId' => $membership['credentialId'],
  'subject' => $payload['subject'],
  'body' => $payload['body'],
  'from' => ['publicKey' => $proof['publicKey']],
  'sentAt' => iso_now(),
];
$signature = atlas_sign($kp['privateKey'], $outPayload);
$message = array_merge($outPayload, ['signature' => $signature]);
append_mail($message);
record_postoffice_send($senderMembership['credentialId']); // task #96 — abuse-detection log, see its own comment in lib/store.php
send_json(200, $message);
