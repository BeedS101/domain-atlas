<?php
// POST /presence/poll/sync — mirrors presence-server/server.js's identical
// route. One request does three things at once (heartbeat + optional move
// + roster fetch): updates this member's lastSeen so it doesn't get swept,
// applies a new position if one was sent, and always returns the room's
// current roster (everyone else) for the client to reconcile against what
// it's currently rendering — see reconcilePollRoster() in viewer.js. There
// is no push here (unlike the Node version's WebSocket side, and unlike
// even the Node version's OWN polling routes when a WS member is also in
// the room) — this bundle has no persistent connection to push down at
// all, so every visitor simply asks again on its own next poll tick.
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

$result = with_presence_store_locked(function (&$doc) use ($id, $body) {
  foreach ($doc['rooms'] as $roomKey => &$room) {
    presence_sweep_room($room);
    if (!isset($room[$id])) continue;

    $room[$id]['lastSeen'] = presence_now_ms();
    if (array_key_exists('x', $body)) {
      $x = presence_num($body['x'] ?? null);
      $y = presence_num($body['y'] ?? null);
      $z = presence_num($body['z'] ?? null);
      $yaw = presence_num($body['yaw'] ?? null);
      $inBounds = $x !== null && $y !== null && $z !== null && $yaw !== null
        && abs($x) <= PRESENCE_MAX_COORD && abs($y) <= PRESENCE_MAX_COORD && abs($z) <= PRESENCE_MAX_COORD;
      if ($inBounds) {
        $room[$id]['x'] = $x; $room[$id]['y'] = $y; $room[$id]['z'] = $z; $room[$id]['yaw'] = $yaw;
      }
    }
    $roster = presence_roster_of($room, $id);
    // Drain any signals (friend requests etc, #67) queued for this member
    // since their last sync — this poll response IS the only "push" a
    // visitor on this bundle ever gets, same reasoning as the roster
    // itself being handed back whole every time rather than as a diff.
    $signals = isset($room[$id]['pendingSignals']) ? $room[$id]['pendingSignals'] : [];
    $room[$id]['pendingSignals'] = [];
    unset($room);
    return ['found' => true, 'roster' => $roster, 'signals' => $signals];
  }
  unset($room);
  return ['found' => false];
});

if (!$result['found']) send_json(404, ['error' => 'unknown or expired presence id — rejoin']);
send_json(200, ['roster' => $result['roster'], 'signals' => $result['signals']]);
