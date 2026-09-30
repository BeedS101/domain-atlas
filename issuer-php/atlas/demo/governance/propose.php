<?php
// POST /atlas/demo/governance/propose — mirrors issuer-server/server.js's
// same route. governance-demo.html's own open-enrollment assembly: any
// current member (anyone who's minted atlas.demo.governance.membership,
// checked via is_valid_governance_member()) can put something to a vote.
// deadline is a plain future ISO timestamp, the same shape a trade
// intent's own expiresAt already is — no separate "close" action ever
// flips a status; governance_status() just compares the clock to this
// value on every read.
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$payload = $body['payload'] ?? null;
$proof = $body['proof'] ?? null;
if (!$payload || !$proof) send_json(400, ['error' => 'payload and proof are required']);
if (!is_string($payload['title'] ?? null) || $payload['title'] === '') {
  send_json(400, ['error' => 'payload.title is required']);
}
$deadlineMs = isset($payload['deadline']) ? strtotime($payload['deadline']) * 1000 : false;
$nowMs = (int) round(microtime(true) * 1000);
if ($deadlineMs === false || $deadlineMs <= $nowMs) {
  send_json(400, ['error' => 'payload.deadline must be a valid timestamp in the future']);
}

$result = create_governance_proposal($payload, $proof);
if (isset($result['error'])) send_json(400, ['error' => $result['error']]);
send_json(200, [
  'proposal' => $result['proposal'],
  'tally' => governance_tally($result['proposal']),
  'status' => governance_status($result['proposal']),
]);
