<?php
// POST /atlas/demo/reserve/consortium/request-mint — mirrors
// issuer-server/server.js's same route. reserve-bank-demo.html's own
// domain-quorum act: same ungated-to-create, worthless-without-real-
// signatures posture as atlas/demo/reserve/request-mint.php, except
// 'approverDomains' names other domains' own hostnames instead of raw
// public keys. This domain itself may be one of them — naming itself
// doesn't skip anything; it still has to co-sign through the same
// admin-gated route every other listed domain does.
require_once __DIR__ . '/../../../../lib/bootstrap.php';
handle_preflight();
require_post();
atlas_load_keys(); // ensures .well-known files exist even if this is the very first request this domain ever gets — a sibling domain's own co-sign will need to fetch this domain's published key back later

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$approverDomains = $body['approverDomains'] ?? null;
$requiredApprovals = $body['requiredApprovals'] ?? null;
$toPublicKey = $body['toPublicKey'] ?? null;
$amount = $body['amount'] ?? null;
$memo = $body['memo'] ?? null;

if (!is_array($approverDomains) || count($approverDomains) !== count(array_unique($approverDomains))) {
  send_json(400, ['error' => 'approverDomains must be an array of distinct, non-empty domain names']);
}
foreach ($approverDomains as $d) {
  if (!is_string($d) || $d === '') send_json(400, ['error' => 'approverDomains must be an array of distinct, non-empty domain names']);
}
if (count($approverDomains) < ATLAS_CONSORTIUM_MIN_DOMAINS || count($approverDomains) > ATLAS_CONSORTIUM_MAX_DOMAINS) {
  send_json(400, ['error' => 'approverDomains must list between ' . ATLAS_CONSORTIUM_MIN_DOMAINS . ' and ' . ATLAS_CONSORTIUM_MAX_DOMAINS . ' domains']);
}
if (!is_int($requiredApprovals) || $requiredApprovals < 2 || $requiredApprovals > count($approverDomains)) {
  send_json(400, ['error' => 'requiredApprovals must be an integer between 2 and the number of approver domains']);
}
if (!$toPublicKey) send_json(400, ['error' => 'toPublicKey is required']);
if (!atlas_is_positive_int($amount) || $amount > ATLAS_BANK_APPROVAL_MAX_AMOUNT) {
  send_json(400, ['error' => 'amount must be a positive integer up to ' . ATLAS_BANK_APPROVAL_MAX_AMOUNT]);
}

$request = [
  'id' => 'urn:atlas:reserve-mint-consortium:' . atlas_uuid(),
  'requestingDomain' => atlas_domain(),
  'action' => [
    'type' => 'reserve-mint',
    'toPublicKey' => $toPublicKey,
    'assetClass' => ATLAS_DEMO_RESERVE_CLASS,
    'amount' => (int) $amount,
    'memo' => is_string($memo) ? substr($memo, 0, 200) : '',
  ],
  'approverDomains' => array_values($approverDomains),
  'requiredApprovals' => (int) $requiredApprovals,
  'approvals' => [],
  'status' => 'pending',
  'executedCredentialId' => null,
  'createdAt' => iso_now(),
  'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', time() + (int) (ATLAS_CONSORTIUM_APPROVAL_TTL_MS / 1000)),
];
atlas_save_reserve_mint_consortium_request($request);
send_json(200, ['request' => $request]);
