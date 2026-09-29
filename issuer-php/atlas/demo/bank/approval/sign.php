<?php
// POST /atlas/demo/bank/approval/sign — mirrors issuer-server/server.js's
// same route. One approver's own signature over exactly {id, action}
// (bank_approval_payload_of()), verified the same way every other signed
// action in this codebase is (verify_envelope(), SPEC.md §6.2) plus one
// extra condition mirroring require_admin()'s own roster check: the
// signing key has to be one of THIS request's own named approvers.
// Idempotent on a repeat signature from the same key (returns the
// unchanged current state rather than erroring) since nothing about
// signing the identical payload twice should count twice toward the
// threshold. Executes the transfer — a real mint through the same
// mint_asset_by_class() every other demo class already mints through —
// the instant the threshold is reached, in the same request that pushed
// it over, so there's never a moment where a fully-approved request sits
// unexecuted.
//
// All of the actual find/validate/mutate/write work happens inside
// sign_bank_approval() (lib/store.php) under one held lock — see that
// function's own comment for why this can't be find_bank_approval() then
// save_bank_approval() as two separate steps here.
require_once __DIR__ . '/../../../../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$id = $body['id'] ?? null;
$proof = $body['proof'] ?? null;
if (!$id || !$proof) send_json(400, ['error' => 'id and proof are both required']);

$result = sign_bank_approval($id, $proof);
if (isset($result['error'])) {
  $status = $result['error'] === 'no such approval request (or it already expired)' ? 404 : 400;
  send_json($status, ['error' => $result['error']]);
}
send_json(200, ['approval' => $result['approval']]);
