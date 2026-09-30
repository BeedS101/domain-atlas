<?php
// POST /atlas/demo/governance/finalize — mirrors issuer-server/server.js's
// same route. Ungated, same shape as atlas/demo/attestation/issue.php: a
// deterministic computation over already-public data (this proposal's
// own votes, which cannot change once closed), signed with this domain's
// ordinary key — not the reviewer key, since this is the domain's own
// factual record of ITS OWN proposal's outcome, not a third party's
// opinion about something else. Callable by anyone, any number of
// times, always producing the same signed result once the deadline has
// passed — there is nothing here for a caller to forge, only to request
// the domain actually put its name to.
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$proposalId = $body['proposalId'] ?? null;
if (!$proposalId) send_json(400, ['error' => 'proposalId is required']);

$proposal = find_governance_proposal($proposalId);
if (!$proposal) send_json(404, ['error' => 'no such proposal']);
if (governance_status($proposal) === 'open') {
  send_json(400, ['error' => 'voting is still open — nothing to finalize yet']);
}

$tally = governance_tally($proposal);
$decisionPayload = [
  'id' => 'urn:atlas:governance-decision:' . atlas_uuid(),
  'proposalId' => $proposal['id'],
  'title' => $proposal['title'],
  'outcome' => $tally['yes'] > $tally['no'] ? 'passed' : 'failed',
  'yesCount' => $tally['yes'],
  'noCount' => $tally['no'],
  'totalVotes' => $tally['total'],
  'closedAt' => $proposal['deadline'],
  'issuedAt' => iso_now(),
];
$kp = atlas_load_keys();
$signature = atlas_sign($kp['privateKey'], $decisionPayload);
$decision = array_merge(
  ['credential' => 'domain-atlas-governance-decision/1.0'],
  $decisionPayload,
  ['issuer' => ['domain' => atlas_domain(), 'publicKey' => $kp['publicKeyB64url']], 'signature' => $signature]
);
send_json(200, ['decision' => $decision]);
