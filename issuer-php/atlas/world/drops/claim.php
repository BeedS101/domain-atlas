<?php
// POST /atlas/world/drops/claim (SPEC.md §5.5) — mirrors
// issuer-server/server.js's own /atlas/world/drops/claim handler exactly.
// Claims (picks up) one drop by id, whether it's a stranger's item or the
// caller's own earlier drop — no special "reclaiming your own" case, same
// as walking up to it in the scene and clicking it. The listing is reserved
// for the claimant (reserve_world_drop() in lib/store.php), settled through
// the replacement journal, and only then marked claimed
// (finish_world_drop()); a claimant who asks again after a lost answer is
// handed the recorded result, and a reservation nobody finishes lapses.
//
// If this domain is the credential's own issuer, it fulfills the claim
// directly (atlas_settle_world_drop_claim() in lib/bootstrap.php — mint+revoke
// through the replacement journal, the same ownership-transfer primitive trade settlement/split/
// consolidate already use). Otherwise it can't legitimately re-sign
// someone else's credential to a new owner — only the actual issuer holds
// that signing key — so it relays the claim there instead
// (drops/relay-claim.php on THAT domain), the exact same
// "sign an attestation, let the home domain verify it against my own
// published key" trust model /atlas/postoffice/relay already uses for
// federated mail (SPEC.md §11.4). This is the second use of that same
// primitive, not a new one.
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$dropId = $body['dropId'] ?? null;
$intent = $body['intent'] ?? null;
if (!$dropId || !$intent) send_json(400, ['error' => 'dropId and intent are both required']);
if (!isset($intent['payload']) || !isset($intent['proof'])) {
  send_json(400, ['error' => 'intent must carry payload and proof']);
}
$payload = $intent['payload'];
if (($payload['dropId'] ?? null) !== $dropId || ($payload['action'] ?? null) !== 'claim') {
  send_json(400, ['error' => 'intent does not authorize claiming this drop']);
}

if (array_key_exists('domain', $payload) && $payload['domain'] !== atlas_domain()) {
  send_json(400, ['error' => 'intent names a different domain than this one']);
}

$envelopeOk = verify_envelope($payload, $intent['proof']);
if (!$envelopeOk) send_json(400, ['error' => 'intent signature does not check out']);
$claimantPub = $intent['proof']['publicKey'];

$reserved = reserve_world_drop($dropId, $claimantPub);
if ($reserved['status'] === 'gone') {
  send_json(404, ['error' => 'that item is gone — already picked up, or reclaimed by whoever dropped it']);
}
if ($reserved['status'] === 'busy') {
  send_json(409, ['error' => 'someone else is picking that item up right now — try again shortly', 'code' => 'busy']);
}
atlas_fault_point('drop:reserved');
$won = $reserved['drop'];
$credential = $won['credential'];

if ($credential['issuer']['domain'] === atlas_domain()) {
  atlas_settle_world_drop_claim($kp, $credential, $claimantPub, $dropId, atlas_domain());
}

$attestation = [
  'relayingDomain' => atlas_domain(),
  'world' => $won['world'],
  'dropId' => $dropId,
  'credentialId' => $credential['id'],
  'claimantPublicKey' => $claimantPub,
];
// When this domain accepted the drop: it tells the issuer the owner's authorization was still valid at that moment,
// however long ago that was.
if (is_string($won['droppedAt'] ?? null)) $attestation['droppedAt'] = $won['droppedAt'];
$attestationSignature = atlas_sign($kp['privateKey'], $attestation);
try {
  $relayResult = atlas_peer_post_json(
    $credential['issuer']['domain'], '/atlas/world/drops/relay-claim',
    ['credential' => $credential, 'attestation' => $attestation, 'attestationSignature' => $attestationSignature,
   'dropIntent' => $won['dropIntent'] ?? null, 'claimIntent' => $intent],
    'drop'
  );
} catch (AtlasOutboundException $e) {
  // Whether the issuer acted on the claim is unknown, so the reservation stays: the same claimant asking again is
  // handed the issuer's recorded result, and the item is listed again for everyone once the reservation lapses.
  send_json(502, ['error' => 'could not reach ' . $credential['issuer']['domain'] . ' to complete this claim: ' . $e->getMessage()]);
}
$relayBody = is_array($relayResult['body'] ?? null) ? $relayResult['body'] : [];
if ($relayResult['status'] >= 200 && $relayResult['status'] < 300) {
  $delivered = $relayBody['credential'] ?? null;
  if (($relayBody['status'] ?? null) !== 'claimed' || !is_array($delivered) || ($delivered['owner']['publicKey'] ?? null) !== $claimantPub) {
    send_json(502, ['error' => $credential['issuer']['domain'] . ' gave no usable answer to this claim; ask again']);
  }
  finish_world_drop($dropId, $claimantPub);
  send_json(200, $relayBody);
}
$reason = $relayBody['error'] ?? 'unknown reason';
// A refusal that will not change (the owner never authorized it, the credential is spent) clears the listing; anything
// that may pass (busy, a conflicting claim still settling, a server error) keeps the reservation.
if (in_array($relayResult['status'], [400, 403, 404], true) && ($relayBody['code'] ?? null) !== 'busy') remove_world_drop($dropId);
send_json($relayResult['status'] ?: 502, ['error' => $credential['issuer']['domain'] . ' rejected this claim: ' . $reason]);
