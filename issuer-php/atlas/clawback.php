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
// Caveat: ignoring tradeScope only reaches the CREDENTIAL itself — it
// does not update a separate roster side-table a bound class's
// credential happens to gate (POSTOFFICE_MEMBERS_FILE,
// TRADINGSTATION_MEMBERS_FILE). Clawing back a Post Office or Trading
// Station membership card revokes the old one and mints a real, valid
// replacement for the new owner, but that new owner won't show up in the
// roster is_valid_postoffice_member()/find_postoffice_membership()
// actually check until they separately (re-)join — the same bookkeeping
// gap that already exists for any other path that might supersede a
// membership credential, not something new this endpoint introduces.
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

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$payload = $body['payload'] ?? null;
$proof = $body['proof'] ?? null;
$token = $body['token'] ?? null;
if (!is_array($payload) || empty($payload['credential']) || empty($payload['toPublicKey'])) {
  send_json(400, ['error' => 'payload.credential and payload.toPublicKey are both required']);
}
$auth = require_admin_auth($payload, $proof, $token);
if (isset($auth['error'])) send_json(401, ['error' => $auth['error']]);

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

send_json(200, ['status' => 'clawed-back', 'newCredential' => $newCredential, 'delivered' => $delivered]);
