<?php
// POST /atlas/mail/check — mirrors issuer-server/server.js's same route.
//
// This is what the wallet's periodic check loop calls — give it every
// credential id you hold that this domain issued, get back whatever's
// been sent for any of them. The wallet re-verifies each message's
// signature itself against this domain's published key (the exact same
// .well-known/atlas-key.json check it already does for credentials)
// before trusting or displaying anything — this endpoint doesn't need to
// do anything special to be trustworthy beyond signing what it hands
// back, same as every other endpoint in this bundle.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys(); // ensures .well-known files exist even if this is the very first request the site ever gets, and gives us the keypair apply_class_patch_if_stale() needs

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$credentialIds = $body['credentialIds'] ?? null;
if (!is_array($credentialIds) || count($credentialIds) === 0) {
  send_json(400, ['error' => 'credentialIds must be a non-empty array']);
}

$wanted = array_flip($credentialIds);
$messages = array_values(array_filter(read_mail()['messages'], function ($m) use ($wanted) {
  return isset($wanted[$m['credentialId']]);
}));

// `updates` (SPEC.md §5.1.1, additive to the messages above — this
// endpoint is task #45's mail check-in cycle, reused as the transport for
// asset-update notices rather than standing up a second polling mechanism)
// rides the same request: for each requested id that isn't simply still
// active, one entry naming what happened to it. A superseded asset's entry
// carries the full replacement credential so the wallet can verify and
// adopt it without a second round trip — the wallet must still run that
// verification itself before trusting any of it, this endpoint being "the
// truth" no more than any other network response is. Ids that are still
// perfectly valid get no entry at all, same lean-response reasoning
// $messages above already follows. Mirrors issuer-server/server.js's
// /atlas/mail/check extension exactly.
//
// `credentials` (optional, additive — a caller that only sends
// `credentialIds` gets exactly the old behavior): the wallet's own current
// copy of whichever of those ids it still wants to ask about. Lets this
// same request also catch a class-wide patch (POST /atlas/admin/
// class-patch.php) that's moved past what a specific credential says,
// without this bundle ever keeping a registry of who holds what — see
// apply_class_patch_if_stale()'s own comment. Only consulted for an id
// that isn't already revoked or superseded; never trusted for anything
// until its own signature checks out.
$presentedCredentials = $body['credentials'] ?? null;
$presentedById = [];
if (is_array($presentedCredentials)) {
  foreach ($presentedCredentials as $c) {
    if (is_array($c) && isset($c['id'])) $presentedById[$c['id']] = $c;
  }
}

$assetUpdates = read_asset_updates()['updates'];
$revoked = read_revocations()['revoked'];
$updates = [];
foreach (array_keys($wanted) as $id) {
  $supersession = null;
  foreach ($assetUpdates as $u) { if ($u['id'] === $id) { $supersession = $u; break; } }
  if ($supersession) { $updates[] = $supersession; continue; }
  $revocation = null;
  foreach ($revoked as $r) { if ($r['id'] === $id) { $revocation = $r; break; } }
  if ($revocation) { $updates[] = ['id' => $id, 'status' => 'revoked', 'reason' => $revocation['reason']]; continue; }
  if (isset($presentedById[$id])) {
    $applied = apply_class_patch_if_stale($kp['privateKey'], $kp['publicKeyB64url'], $presentedById[$id]);
    if ($applied) $updates[] = $applied;
  }
}

send_json(200, ['messages' => $messages, 'updates' => $updates]);
