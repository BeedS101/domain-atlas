<?php
// POST /atlas/demo/reserve/consortium/approve — mirrors
// issuer-server/server.js's same route. The inbound half of co-sign.php
// above, called BY a sibling domain's own server, ungated in the
// general-auth sense but gated by the attestation's own signature: trust
// comes from verifying it against that domain's freshly-fetched published
// key (fetch_domain_public_key()/verify_domain_signature()), never from
// anything the caller merely asserts — the same trust bootstrap
// atlas/trade/relay-lock.php already uses. See
// atlas_approve_reserve_mint_consortium() in lib/store.php for the actual
// find/validate/mutate/write work, held under one lock the same way
// sign_reserve_mint_approval() is.
require_once __DIR__ . '/../../../../lib/bootstrap.php';
handle_preflight();
require_post();
atlas_load_keys(); // ensures .well-known files exist even if this is the very first request this domain ever gets — a self-named approver domain needs its own published key fetchable here too

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$id = $body['id'] ?? null;
$attestation = $body['attestation'] ?? null;
$attestationSignature = $body['attestationSignature'] ?? null;
if (!$id || !$attestation || !$attestationSignature) {
  send_json(400, ['error' => 'id, attestation, and attestationSignature are all required']);
}

$result = atlas_approve_reserve_mint_consortium($id, $attestation, $attestationSignature);
if (isset($result['error'])) {
  $status = $result['status'] ?? ($result['error'] === 'no such consortium mint request (or it already expired)' ? 404 : 400);
  send_json($status, ['error' => $result['error']]);
}
send_json(200, ['request' => $result['request']]);
