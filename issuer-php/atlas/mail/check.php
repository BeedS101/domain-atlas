<?php
// POST /atlas/mail/check — mirrors issuer-server/server.js's same route.
//
// The wallet's periodic check: it asks for whatever was sent to, or happened
// to, the credentials the caller owns. The request is signed (SPEC.md §11.8,
// see authenticate_mail_request()). The wallet re-verifies each message's
// signature against this domain's published key before trusting it.
//
// Each requested mailbox is released only for a credential this domain
// signed whose owner is the authenticated identity; every other id is
// dropped silently, so a mixed request returns the caller's own mailboxes
// and nothing reveals whether an unauthorised id exists. Revoked and
// superseded credentials still authorise their own mailbox: ownership does
// not lapse, and settlement notices and replacements are filed under them.
//
// `updates` (SPEC.md §5.1.1) rides the same request: for each authorised id
// that is not simply still active, one entry naming what happened to it. A
// superseded asset's entry carries the full replacement credential. The
// class patch (re-minting a stale credential) only ever runs for a
// credential the caller has just proved they own.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys(); // ensures .well-known files exist even if this is the very first request the site ever gets, and gives us the keypair apply_class_patch_if_stale() needs

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$identityKey = authenticate_mail_request($body, 'mail-check');

$requested = $body['payload']['credentialIds'] ?? null;
$credentials = $body['credentials'] ?? null;
$validIds = is_array($requested) && count($requested) > 0 && count($requested) <= ATLAS_MAIL_CHECK_MAX_CREDENTIALS;
if ($validIds) {
  foreach ($requested as $id) {
    if (!is_string($id) || $id === '' || strlen($id) > 512) { $validIds = false; break; }
  }
}
if (!$validIds) {
  send_json(400, ['error' => 'payload.credentialIds must be 1 to ' . ATLAS_MAIL_CHECK_MAX_CREDENTIALS . ' strings']);
}
if (!is_array($credentials) || count($credentials) > ATLAS_MAIL_CHECK_MAX_CREDENTIALS) {
  send_json(400, ['error' => 'credentials must be an array of at most ' . ATLAS_MAIL_CHECK_MAX_CREDENTIALS]);
}

$requestedSet = array_flip($requested);
$authorised = [];
foreach ($credentials as $c) {
  if (!is_array($c) || !isset($c['id']) || !is_string($c['id']) || !isset($requestedSet[$c['id']]) || isset($authorised[$c['id']])) continue;
  if (!isset($c['owner']['publicKey']) || $c['owner']['publicKey'] !== $identityKey) continue;
  if (!verify_own_credential_signature($kp['publicKeyB64url'], $c, asset_payload_of($c))) continue;
  $authorised[$c['id']] = $c;
}

$messages = array_values(array_filter(read_mail()['messages'], function ($m) use ($authorised) {
  return isset($authorised[$m['credentialId']]);
}));

$assetUpdates = read_asset_updates()['updates'];
$revokedBefore = read_revocations()['revoked'];
$updates = [];
foreach ($authorised as $id => $presented) {
  $supersession = null;
  foreach ($assetUpdates as $u) { if ($u['id'] === $id) { $supersession = $u; break; } }
  if ($supersession) { $updates[] = $supersession; continue; }
  $revocation = null;
  foreach ($revokedBefore as $r) { if ($r['id'] === $id) { $revocation = $r; break; } }
  if ($revocation) { $updates[] = ['id' => $id, 'status' => 'revoked', 'reason' => $revocation['reason']]; continue; }
  // A suspended id gets its own status rather than being silently
  // indistinguishable from "still fine".
  $suspension = find_suspension($id);
  if ($suspension) { $updates[] = ['id' => $id, 'status' => 'suspended', 'reason' => $suspension['reason'], 'expiresAt' => $suspension['expiresAt'] ?? null]; continue; }
  // find_suspension() resolves any expired suspension as a side effect,
  // including revoking an expired 'finalize' entry (SPEC.md §13.4); reading
  // revocations again reports that in this same response.
  $justRevoked = null;
  foreach (read_revocations()['revoked'] as $r) { if ($r['id'] === $id) { $justRevoked = $r; break; } }
  if ($justRevoked) { $updates[] = ['id' => $id, 'status' => 'revoked', 'reason' => $justRevoked['reason']]; continue; }
  $applied = apply_class_patch_if_stale($kp['privateKey'], $kp['publicKeyB64url'], $presented);
  if ($applied) $updates[] = $applied;
}

send_json(200, ['messages' => $messages, 'updates' => $updates]);
