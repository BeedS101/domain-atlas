<?php
// POST /presence/poll/duplicate-response — mirrors presence-server/
// server.js's identical route (task #137): the EXISTING member's explicit
// answer (Leave now / Keep this session active) to a
// 'duplicate-join-request' notice it received via its own
// /presence/poll/sync signals. `id` must be the challenge's own
// existingConnId — same "prove you're really the one being asked" check
// the Node version applies — otherwise (or for an unknown/already-expired
// challenge) this is a 404, same as this bundle's other id-based routes.
// `decision` of anything other than the literal string 'keep' is treated
// as 'yield' (the newcomer wins), same default-safe handling
// presence-server.js's own WS/poll handlers give an unrecognized value.
require_once __DIR__ . '/../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$id = isset($body['id']) ? (string) $body['id'] : '';
$challengeId = isset($body['challengeId']) ? (string) $body['challengeId'] : '';
$decision = (isset($body['decision']) && $body['decision'] === 'keep') ? 'keep' : 'yield';

$found = with_presence_store_locked(function (&$doc) use ($id, $challengeId, $decision) {
  if (!isset($doc['challenges'][$challengeId]) || $doc['challenges'][$challengeId]['existingConnId'] !== $id) return false;
  presence_resolve_challenge($doc, $challengeId, $decision);
  return true;
});

if (!$found) send_json(404, ['error' => 'unknown or expired challenge']);
send_json(200, ['ok' => true]);
