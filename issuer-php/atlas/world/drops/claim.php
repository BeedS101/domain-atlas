<?php
// POST /atlas/world/drops/claim (task #250, SPEC.md §5.5) — mirrors
// issuer-server/server.js's own /atlas/world/drops/claim handler exactly.
// Claims (picks up) one drop by id, whether it's a stranger's item or the
// caller's own earlier drop — no special "reclaiming your own" case, same
// as walking up to it in the scene and clicking it. Settled by REMOVING
// the listing before minting anything (remove_world_drop() in lib/store.php)
// — whichever concurrent claim's removal actually finds-and-deletes the
// entry wins the item, same reservation-by-removal mechanism POST
// /atlas/trade/claim already uses against atlas-pending-trades-store.json.
//
// If this domain is the credential's own issuer, it fulfills the claim
// directly (fulfill_world_drop_claim() in lib/bootstrap.php — mint+revoke,
// the same real ownership-transfer primitive trade settlement/split/
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

$envelopeOk = verify_envelope($payload, $intent['proof']);
if (!$envelopeOk) send_json(400, ['error' => 'intent signature does not check out']);
$claimantPub = $intent['proof']['publicKey'];

$won = remove_world_drop($dropId);
if ($won === null) {
  send_json(404, ['error' => 'that item is gone — already picked up, or reclaimed by whoever dropped it']);
}
$credential = $won['credential'];

if ($credential['issuer']['domain'] === atlas_domain()) {
  $received = fulfill_world_drop_claim($kp, $credential, $claimantPub);
  send_json(200, ['status' => 'claimed', 'credential' => $received]);
}

$attestation = [
  'relayingDomain' => atlas_domain(),
  'world' => $won['world'],
  'dropId' => $dropId,
  'credentialId' => $credential['id'],
  'claimantPublicKey' => $claimantPub,
];
$attestationSignature = atlas_sign($kp['privateKey'], $attestation);
try {
  $relayResult = atlas_http_post_json(
    atlas_base_url($credential['issuer']['domain']) . '/atlas/world/drops/relay-claim',
    ['credential' => $credential, 'attestation' => $attestation, 'attestationSignature' => $attestationSignature]
  );
} catch (Exception $e) {
  // The reservation above already removed the listing — same acknowledged
  // gap the Node version documents: no cross-call rollback in this demo, so
  // a network failure here can strand the item rather than restore the
  // listing.
  send_json(502, ['error' => 'could not reach ' . $credential['issuer']['domain'] . ' to complete this claim: ' . $e->getMessage()]);
}
if ($relayResult['status'] < 200 || $relayResult['status'] >= 300) {
  $reason = $relayResult['body']['error'] ?? 'unknown reason';
  send_json($relayResult['status'] ?: 502, ['error' => $credential['issuer']['domain'] . ' rejected this claim: ' . $reason]);
}
send_json(200, $relayResult['body']);
