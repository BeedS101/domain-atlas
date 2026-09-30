<?php
// POST /atlas/demo/governance/vote — mirrors issuer-server/server.js's
// same route. One member, one vote, checked against the proposal's own
// votes array, and rejected outright once the deadline has passed — the
// same bearer-but-verified shape every other self-serve action here
// uses: holding a live membership is what authorizes this, checked by
// signature, not merely claimed. The actual find/validate/mutate/write
// sequence lives in cast_governance_vote() (lib/store.php), one exclusive
// lock held across the whole thing — see that function's own comment for
// why a bare read-then-write would race here.
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
$proposalId = $payload['proposalId'] ?? null;
if (!$proposalId) send_json(400, ['error' => 'payload.proposalId is required']);
$choice = $payload['choice'] ?? null;
if ($choice !== 'yes' && $choice !== 'no') send_json(400, ['error' => 'payload.choice must be "yes" or "no"']);

$result = cast_governance_vote($proposalId, $payload, $proof);
if (isset($result['error'])) {
  $status = ($result['error'] === 'no such proposal') ? 404 : 400;
  send_json($status, ['error' => $result['error']]);
}
send_json(200, [
  'proposal' => $result['proposal'],
  'tally' => governance_tally($result['proposal']),
  'status' => governance_status($result['proposal']),
]);
