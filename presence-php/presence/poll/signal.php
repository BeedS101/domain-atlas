<?php
// POST /presence/poll/signal — mirrors presence-server/server.js's
// relaySignal()/'signal' WS message and its own /presence/poll/signal
// route (task #67). A tiny point-to-point message primitive for friend
// requests between two visitors simultaneously present in the same room —
// see README.md's Friends section for why this rides on presence instead
// of the mail system (mail is domain-issuer-to-subscriber only, there's no
// way to even discover a stranger's credentialId to mail them).
//
// This bundle is polling-only, so unlike the Node version there's no
// "push immediately if the target is a live WS connection" branch — every
// signal here always queues into the target member's pendingSignals,
// picked up on their next /presence/poll/sync. Simpler than the Node
// version for exactly the reason this whole bundle is simpler: no
// persistent connection to push down at all, ever.
require_once __DIR__ . '/../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$id = isset($body['id']) ? (string) $body['id'] : '';
if ($id === '') send_json(400, ['error' => 'id is required']);
$to = isset($body['to']) ? (string) $body['to'] : '';
$kind = isset($body['kind']) ? (string) $body['kind'] : '';
$publicKey = (isset($body['publicKey']) && $body['publicKey'] !== '') ? substr((string) $body['publicKey'], 0, PRESENCE_MAX_PUBLIC_KEY_LEN) : null;
$name = isset($body['name']) ? substr((string) $body['name'], 0, PRESENCE_MAX_NAME_LEN) : '';

$result = with_presence_store_locked(function (&$doc) use ($id, $to, $kind, $publicKey, $name) {
  if (!in_array($kind, PRESENCE_ALLOWED_SIGNAL_KINDS, true)) return ['found' => true, 'ok' => false];
  foreach ($doc['rooms'] as $roomKey => &$room) {
    presence_sweep_room($room);
    if (!isset($room[$id])) continue;
    // Sending a signal counts as activity, same as a sync would — a
    // visitor mid-friend-request shouldn't get swept out just because
    // they haven't happened to sync in the last few seconds.
    $room[$id]['lastSeen'] = presence_now_ms();
    // Relay only within the SAME room the sender is in — a target id in a
    // different domain+world is treated exactly like an unknown id, same
    // isolation guarantee the roster itself gives. No detail leaked back
    // about WHY a target didn't match, since that would let a client probe
    // for who's in a room by id.
    if (!isset($room[$to])) { unset($room); return ['found' => true, 'ok' => false]; }
    if (!isset($room[$to]['pendingSignals'])) $room[$to]['pendingSignals'] = [];
    $room[$to]['pendingSignals'][] = ['type' => 'signal', 'from' => $id, 'kind' => $kind, 'publicKey' => $publicKey, 'name' => $name];
    unset($room);
    return ['found' => true, 'ok' => true];
  }
  unset($room);
  return ['found' => false];
});

if (!$result['found']) send_json(404, ['error' => 'unknown or expired presence id — rejoin']);
send_json(200, ['ok' => $result['ok']]);
