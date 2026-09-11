<?php
// POST /presence/poll/join-status — mirrors presence-server/server.js's
// identical route (task #137). A new joiner whose /presence/poll/join
// came back {status:'pending', challengeId, ...} calls this to find out
// how the duplicate-join challenge eventually settled: {status:'pending'}
// again if it hasn't yet, or the same {status:'joined', id, roster} /
// {status:'denied'} shape the challenge's own resolution carries — see
// presence_resolve_challenge() in lib/store.php. A 404 here means the
// challenge id is unknown, or (having already resolved) it aged out past
// PRESENCE_CHALLENGE_RESULT_GRACE_MS — same "ask again later, or give up"
// contract the Node version's identical route gives a caller with no
// other way to be pushed the outcome.
require_once __DIR__ . '/../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$challengeId = isset($body['challengeId']) ? (string) $body['challengeId'] : '';

$result = with_presence_store_locked(function (&$doc) use ($challengeId) {
  if (!isset($doc['challenges'][$challengeId])) return ['found' => false];
  $challenge = $doc['challenges'][$challengeId];
  if (!$challenge['resolvedAt']) return ['found' => true, 'body' => ['status' => 'pending']];
  return ['found' => true, 'body' => $challenge['resolution']];
});

if (!$result['found']) send_json(404, ['error' => 'unknown or expired challenge']);
send_json(200, $result['body']);
