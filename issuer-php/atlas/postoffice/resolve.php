<?php
// POST /atlas/postoffice/resolve — mirrors issuer-server/server.js's same
// route. Task #94 (handle addressing).
//
// The single-lookup step compose uses to turn "bruno" (plus whichever
// domain is already selected) into the public key atlas/postoffice/
// send.php actually needs — same "one exact answer if you already know
// what to ask for, never a dump" shape as every other narrow lookup in
// this bundle (find_postoffice_membership, mysettings.php). No sender
// authentication: resolving a handle you already know doesn't require
// proving who you are, any more than already knowing someone's raw public
// key would — the actual send is still gated by real membership/consent
// checks in send.php; this step is purely address lookup.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$handle = $body['handle'] ?? null;
if (!is_string($handle) || $handle === '') {
  send_json(400, ['error' => 'handle is required']);
}

$member = find_postoffice_member_by_handle($handle);
if ($member === null) {
  send_json(404, ['error' => 'no one at this Post Office has registered that handle']);
}

send_json(200, ['ok' => true, 'publicKey' => $member['ownerPublicKey'], 'handle' => $member['handle']]);
