<?php
// POST /atlas/demo/reserve/request-mint — mirrors issuer-server/server.js's
// same route. reserve-bank-demo.html's own K-of-N committee mint, identical
// in every respect to atlas/demo/bank/request-approval.php except the
// minted class: a monetary-policy committee approving new Reserve Credits
// instead of a bank treasury approving a transfer. Same ungated-to-create,
// worthless-without-a-roster-key's-signature posture; same in-request
// approver roster trade-off (store.php's own comment on
// atlas_reserve_mint_approvals_file()).
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$approvers = $body['approvers'] ?? null;
$requiredApprovals = $body['requiredApprovals'] ?? null;
$toPublicKey = $body['toPublicKey'] ?? null;
$amount = $body['amount'] ?? null;
$memo = $body['memo'] ?? null;

if (!is_array($approvers) || count($approvers) !== count(array_unique($approvers))) {
  send_json(400, ['error' => 'approvers must be an array of distinct public keys']);
}
if (count($approvers) < ATLAS_BANK_APPROVAL_MIN_APPROVERS || count($approvers) > ATLAS_BANK_APPROVAL_MAX_APPROVERS) {
  send_json(400, ['error' => 'approvers must list between ' . ATLAS_BANK_APPROVAL_MIN_APPROVERS . ' and ' . ATLAS_BANK_APPROVAL_MAX_APPROVERS . ' keys']);
}
if (!is_int($requiredApprovals) || $requiredApprovals < 2 || $requiredApprovals > count($approvers)) {
  send_json(400, ['error' => 'requiredApprovals must be an integer between 2 and the number of approvers']);
}
if (!$toPublicKey) send_json(400, ['error' => 'toPublicKey is required']);
if (!atlas_is_positive_int($amount) || $amount > ATLAS_BANK_APPROVAL_MAX_AMOUNT) {
  send_json(400, ['error' => 'amount must be a positive integer up to ' . ATLAS_BANK_APPROVAL_MAX_AMOUNT]);
}

$approval = [
  'id' => 'urn:atlas:reserve-mint:' . atlas_uuid(),
  'action' => [
    'type' => 'reserve-mint',
    'toPublicKey' => $toPublicKey,
    'assetClass' => ATLAS_DEMO_RESERVE_CLASS,
    'amount' => (int) $amount,
    'memo' => is_string($memo) ? substr($memo, 0, 200) : '',
  ],
  'approvers' => array_values($approvers),
  'requiredApprovals' => (int) $requiredApprovals,
  'signatures' => [],
  'status' => 'pending',
  'executedCredentialId' => null,
  'createdAt' => iso_now(),
  'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', time() + (int) (ATLAS_BANK_APPROVAL_TTL_MS / 1000)),
];
save_reserve_mint_approval($approval);
send_json(200, ['approval' => $approval]);
