<?php
// POST /atlas/demo/bank/request-approval — mirrors issuer-server/server.js's
// same route. bank-demo.html's K-of-N treasury-transfer walkthrough.
// Creating a request is deliberately ungated (same "harmless to hand out,
// worthless without a roster key's signature" posture atlas/admin/session/
// nonce.php already has) — it only ever records what's being proposed,
// never moves anything by itself. `approvers` names the exact public keys
// authorized to sign THIS request; see store.php's own comment on
// ATLAS_BANK_APPROVAL_* for why that's inline here rather than backed by a
// persistent roster credential.
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
  'id' => 'urn:atlas:bank-approval:' . atlas_uuid(),
  'action' => [
    'type' => 'treasury-transfer',
    'toPublicKey' => $toPublicKey,
    'assetClass' => ATLAS_DEMO_BANK_ASSET_CLASS,
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
save_bank_approval($approval);
send_json(200, ['approval' => $approval]);
