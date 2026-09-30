<?php
// POST /atlas/demo/reserve/mint/sign — mirrors issuer-server/server.js's
// same route. One committee member's own signature over exactly
// {id, action} (reserve_mint_approval_payload_of()), verified the same way
// atlas/demo/bank/approval/sign.php verifies its own signatures, plus the
// same authorized-approver and idempotent-repeat-signature handling.
// Executes the mint the instant the threshold is reached, in the same
// request that pushed it over — see store.php's sign_reserve_mint_approval()
// for the actual find/validate/mutate/write work, held under one lock the
// same way sign_bank_approval() is.
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

$result = sign_reserve_mint_approval($id, $proof);
if (isset($result['error'])) {
  $status = $result['error'] === 'no such mint request (or it already expired)' ? 404 : 400;
  send_json($status, ['error' => $result['error']]);
}
send_json(200, ['approval' => $result['approval']]);
