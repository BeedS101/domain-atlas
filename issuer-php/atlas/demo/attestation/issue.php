<?php
// POST /atlas/demo/attestation/issue — mirrors issuer-server/server.js's
// same route. Self-serve sibling of a real attestation-issuing flow, which
// SPEC.md §5.11 deliberately leaves to domain-operator authentication (the
// same posture atlas/mail/send.php and lib/sign-manifest.php already take)
// — a live-site visitor to attestation-demo.html has no such login, so
// this lets THIS domain's own running instance stand in as "the
// independent reviewer" for whichever asset the page shows it, restricted
// to a short fixed set of claim texts (atlas_demo_attestation_claims())
// so a visitor can never get this domain's real signing key onto
// arbitrary text.
//
// Deliberately does NOT require the subject asset to have been issued by
// this same domain — the entire point of §5.11 is attesting to something
// the signer did not issue. Signs with atlas_load_reviewer_keys()'s SECOND,
// independent keypair, never atlas_load_keys()'s own issuing key — see that
// function's own comment in bootstrap.php — so this demo works same-origin
// on a single deployed domain instead of needing a genuinely separate
// second domain reachable somewhere else.
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_post();
$reviewerKp = atlas_load_reviewer_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$subjectAssetId = $body['subjectAssetId'] ?? null;
$subjectIssuerDomain = $body['subjectIssuerDomain'] ?? null;
$claimKey = $body['claim'] ?? null;
if (!$subjectAssetId || !$subjectIssuerDomain) {
  send_json(400, ['error' => 'subjectAssetId and subjectIssuerDomain are both required']);
}
$claims = atlas_demo_attestation_claims();
if (!is_string($claimKey) || !array_key_exists($claimKey, $claims)) {
  send_json(400, ['error' => 'claim must be one of: ' . implode(', ', array_keys($claims))]);
}

$credential = issue_attestation($reviewerKp['privateKey'], $reviewerKp['publicKeyB64url'], $subjectAssetId, $subjectIssuerDomain, $claims[$claimKey]);
send_json(200, ['attestation' => $credential]);
