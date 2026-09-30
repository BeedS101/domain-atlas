<?php
// GET /atlas/demo/governance/proposal?id=... — mirrors
// issuer-server/server.js's same route. Ungated, same "read is open"
// reasoning as GET /atlas/trade/listings and GET /atlas/attestation/list:
// a live, transparent tally is the whole point of this demo, not
// something only a participant can check.
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_get();

$id = $_GET['id'] ?? null;
if (!$id) send_json(400, ['error' => 'id is required']);

$proposal = find_governance_proposal($id);
if (!$proposal) send_json(404, ['error' => 'no such proposal']);

send_json(200, [
  'proposal' => $proposal,
  'tally' => governance_tally($proposal),
  'status' => governance_status($proposal),
]);
