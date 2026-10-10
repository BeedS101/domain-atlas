<?php
// POST /atlas/clawback — mirrors issuer-server/server.js's same route.
//
// The other half of what suspend/unsuspend exists to buy time for: once a
// fraud report is actually confirmed (rather than still under
// investigation), revoke the credential wherever it currently sits and
// mint a fresh one straight to its rightful owner, in the same act. Not a
// new primitive — this is exactly transfer_unique_asset()'s mint-then-
// revoke shape, just issuer-authorized instead of the current holder's
// own signature, and aimed at a DIFFERENT owner than whoever is
// presenting it. Works for a fungible balance or a unique asset alike
// (issue_asset() doesn't care), and ignores tradeScope entirely — a
// 'bound' membership card is exactly as clawback-able as anything else,
// the same total, issuer-authoritative reach atlas/revoke.php already
// has, not the holder-initiated discipline check_presented_giftable_/
// transferable_asset() enforce for a holder's own transfer.
//
// A bound relationship credential (a Post Office or Trading Station
// membership) is also tracked in a SEPARATE roster file, keyed by
// credentialId, not just by the credential itself — so clawing one back
// re-points that SAME roster entry at the new credential id and owner
// below (reassign_postoffice_membership()/reassign_tradingstation_
// membership(), lib/store.php), rather than leaving the new owner
// invisible to is_valid_postoffice_member()/find_postoffice_membership()
// until they separately rejoined. Whatever the account already had (a
// claimed handle, mail-mode/block-list settings) is preserved, since that
// belongs to the account being returned, not to whoever most recently
// misused it; abuse-tracking (sendLog/recentSendCount/flagged) is reset
// instead, since that's a record of recent behavior under the OLD holder,
// not the account itself.
//
// Deliberately claws back exactly the quantity on the credential
// presented, no more — it does not attempt to trace or split a balance
// that's since been partially spent, split, or consolidated with
// legitimate funds. Which fraction of a mixed balance is actually tainted
// is the harder "was this really theft, and how much of it" question a
// human investigation has to answer before this endpoint is ever called;
// the asset-history audit trail (atlas_asset_history_file(), lib/
// store.php) is what that investigation walks, this endpoint just acts on
// its conclusion.
//
// Admin-gated (require_admin_auth()), same wire shape as atlas/revoke.php
// and atlas/suspend.php: {payload: {credential, toPublicKey}, proof} or
// {payload, token}. If toPublicKey currently holds a live Post Office
// membership at this domain, the fresh credential is also delivered as a
// mail gift attachment addressed to that membership — the same "absent
// counterparty" delivery atlas/trade/claim.php already uses for a poster
// who isn't live for the call — so the rightful owner's own wallet can
// pick it up on its next mail check without the operator handing it over
// by hand. Otherwise it's simply returned in the response, same as
// atlas/asset/transfer.php already leaves delivery to the caller when the
// recipient has no reachable mailbox here.
require_once __DIR__ . '/../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

$body = read_admin_json_body();

$payload = $body['payload'] ?? null;
$proof = $body['proof'] ?? null;
$token = $body['token'] ?? null;
if (!is_array($payload) || empty($payload['credential']) || empty($payload['toPublicKey'])) {
  send_json(400, ['error' => 'payload.credential and payload.toPublicKey are both required']);
}
$auth = require_admin_auth($payload, $proof, $token, '/atlas/clawback');
if (isset($auth['error'])) admin_auth_fail($auth);

$credential = $payload['credential'];
$toPublicKey = $payload['toPublicKey'];
if (!is_array($credential) || empty($credential['id']) || empty($credential['asset']) || empty($credential['owner']) || empty($credential['issuer'])) {
  send_json(400, ['error' => 'payload.credential must be a domain-atlas-asset/1.0 credential']);
}
if (($credential['issuer']['domain'] ?? null) !== atlas_domain()) {
  send_json(400, ['error' => 'credential was not issued by this domain']);
}
if ($toPublicKey === ($credential['owner']['publicKey'] ?? null)) {
  send_json(400, ['error' => "toPublicKey already matches the credential's current owner — nothing to claw back"]);
}
$busy = atlas_spend_lock($credential['id']);
if ($busy !== null) send_json(409, ['error' => $busy]);
if (is_revoked($credential['id'])) {
  send_json(400, ['error' => 'credential is already revoked — nothing to claw back']);
}
$sigOk = verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential));
if (!$sigOk) {
  send_json(400, ['error' => "credential signature does not check out against this issuer's key"]);
}

$newCredential = issue_asset($kp['privateKey'], $kp['publicKeyB64url'], $toPublicKey, $credential['asset'], $credential['quantity'], $credential['id']);
atlas_revoke($credential['id'], 'clawback');
archive_if_audited($credential, 'clawback');

$recipientMember = find_postoffice_membership($toPublicKey);
$delivered = false;
if ($recipientMember) {
  $noticePayload = [
    'id' => 'urn:atlas:mail:' . atlas_uuid(),
    'credentialId' => $recipientMember['credentialId'],
    'subject' => 'An asset was returned to you at ' . atlas_domain(),
    'body' => "A {$credential['asset']['class']} credential was clawed back from its previous holder and reissued to you by this domain's operator.",
    'attachedAsset' => $newCredential,
    'sentAt' => iso_now(),
  ];
  $noticeSignature = atlas_sign($kp['privateKey'], $noticePayload);
  append_mail(array_merge($noticePayload, ['signature' => $noticeSignature]));
  $delivered = true;
}

// Runs AFTER the mail-delivery lookup above, not before: clawing back a
// membership credential straight back to its own rightful owner already
// hands them the new credential directly in the response, the way a
// hijacked account gets reset — re-pointing the roster first would make
// the lookup above find that very entry and mail them a redundant copy
// of what they're already holding.
if ($credential['asset']['class'] === 'atlas.postoffice.membership') {
  reassign_postoffice_membership($credential['id'], $newCredential['id'], $toPublicKey);
} elseif ($credential['asset']['class'] === 'atlas.tradingstation.membership') {
  reassign_tradingstation_membership($credential['id'], $newCredential['id'], $toPublicKey);
}

send_json(200, ['status' => 'clawed-back', 'newCredential' => $newCredential, 'delivered' => $delivered]);
