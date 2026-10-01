<?php
// POST /atlas/trade/relay-settle (SPEC.md §7, v1.29) — the SETTLE half of
// a cross-domain Trading Station trade's two-phase commit, honored only
// against a balance that's currently locked for this exact trade (checked
// below via find_suspension() rather than trusting the caller's word for
// it — relay-lock.php must have succeeded first). Spends
// attestation.spendQuantity of the locked balance to
// attestation.newOwnerPublicKey and mints any leftover back to the
// balance's own original owner — see fulfill_trade_side_settlement()'s own
// comment (lib/bootstrap.php) for why that's always enough regardless of
// what the trade's other side offered. Same attestation-and-verify shape
// as relay-lock.php and atlas/world/drops/relay-claim.php.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$credential = $body['credential'] ?? null;
$attestation = $body['attestation'] ?? null;
$attestationSignature = $body['attestationSignature'] ?? null;
if (!$credential || !$attestation || !$attestationSignature) {
  send_json(400, ['error' => 'credential, attestation, and attestationSignature are all required']);
}
if (empty($credential['asset']) || empty($credential['issuer']) || $credential['issuer']['domain'] !== atlas_domain()) {
  send_json(400, ['error' => 'this domain did not issue that credential']);
}
if (($attestation['credentialId'] ?? null) !== $credential['id']) {
  send_json(400, ['error' => 'attestation does not name the credential it was sent with']);
}

$relayingDomain = $attestation['relayingDomain'] ?? null;
$tradeId = $attestation['tradeId'] ?? null;
$spendQuantity = $attestation['spendQuantity'] ?? null;
$newOwnerPublicKey = $attestation['newOwnerPublicKey'] ?? null;
if (!$relayingDomain || !$tradeId || !is_int($spendQuantity) || $spendQuantity < 1 || !$newOwnerPublicKey) {
  send_json(400, ['error' => 'attestation must carry relayingDomain, tradeId, a positive integer spendQuantity, and newOwnerPublicKey']);
}

if (!atlas_is_trusted_trade_peer($relayingDomain)) {
  send_json(403, ['error' => 'this domain does not accept trade relays from ' . $relayingDomain]);
}

if (is_revoked($credential['id'])) {
  send_json(400, ['error' => 'that balance has already been revoked']);
}
$lock = find_suspension($credential['id']);
if (!$lock || $lock['reason'] !== 'trade-lock:' . $tradeId) {
  send_json(409, ['error' => 'that balance was never locked for this trade, or its lock already expired — relay-lock it again first']);
}
if (is_expired($credential)) {
  send_json(400, ['error' => 'that balance has already expired']);
}
$isUnique = isset($credential['asset']['fungible']) && $credential['asset']['fungible'] === false;
if (!$isUnique && $spendQuantity > $credential['quantity']) {
  send_json(400, ['error' => 'spendQuantity exceeds this balance\'s own quantity']);
}

$ownSignatureOk = verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential));
if (!$ownSignatureOk) {
  send_json(400, ['error' => "credential signature does not check out against this domain's own key"]);
}

try {
  $relayingDomainKey = fetch_domain_public_key($relayingDomain);
} catch (Exception $e) {
  send_json(502, ['error' => "could not verify " . $relayingDomain . "'s own published key: " . $e->getMessage()]);
}
$attestationOk = verify_domain_signature($relayingDomainKey, $attestation, $attestationSignature);
if (!$attestationOk) {
  send_json(400, ['error' => $relayingDomain . "'s attestation signature does not check out"]);
}

// mailDeliverAttachedAsset (optional, SPEC.md §7's "mail delivery for the
// absent party" case): a credential the trade's OTHER issuer already
// minted for this balance's own original owner — bundled in here, rather
// than relayed separately, because only the domain that issued the id
// being superseded has a mail store that owner's wallet is actually
// polling (atlas/mail/check.php). Verified the same way any other
// foreign-issued credential presented to this domain is, never mailed on
// the relaying domain's word alone.
$mailDeliverAttachedAsset = $attestation['mailDeliverAttachedAsset'] ?? null;
$mailNotice = null;
if ($mailDeliverAttachedAsset !== null) {
  if (empty($mailDeliverAttachedAsset['issuer']['domain'])) {
    send_json(400, ['error' => 'mailDeliverAttachedAsset has no issuer domain']);
  }
  if ($mailDeliverAttachedAsset['issuer']['domain'] === atlas_domain()) {
    $attachedOk = verify_own_credential_signature($kp['publicKeyB64url'], $mailDeliverAttachedAsset, asset_payload_of($mailDeliverAttachedAsset))
      && !is_revoked($mailDeliverAttachedAsset['id']) && !is_expired($mailDeliverAttachedAsset);
  } else {
    $attachedOk = verify_foreign_asset_credential($mailDeliverAttachedAsset) === true;
  }
  if (!$attachedOk) {
    send_json(400, ['error' => 'mailDeliverAttachedAsset does not check out against its own issuer']);
  }
  $mailNotice = [
    'subject' => 'Listing claimed at ' . $relayingDomain,
    'body' => 'Your open listing was claimed while you were away — the other half of the trade is attached.',
    'attachedAsset' => $mailDeliverAttachedAsset,
  ];
}

$settled = fulfill_trade_side_settlement($kp, $credential, $spendQuantity, $newOwnerPublicKey, $mailNotice);
atlas_unsuspend($credential['id']);
send_json(200, ['status' => 'settled', 'received' => $settled['received'], 'remainder' => $settled['remainder']]);
