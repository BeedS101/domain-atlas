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
        // Task #137's activity clock only counts a REAL change — a poll
        // member's sync tick reports its current pose every ~2s
        // regardless of whether it moved at all, and that repetition
        // shouldn't look like activity (see presence_is_member_active()/
        // PRESENCE_ACTIVITY_IDLE_MS in lib/store.php), same reasoning as
        // presence-server.js's own moveMember().
        $actuallyMoved = $room[$id]['x'] !== $x || $room[$id]['y'] !== $y || $room[$id]['z'] !== $z || $room[$id]['yaw'] !== $yaw;
        $room[$id]['x'] = $x; $room[$id]['y'] = $y; $room[$id]['z'] = $z; $room[$id]['yaw'] = $yaw;
        // A sync IS this member's current full pose, appearance included —
        // always overwrites (to null when neither key is sent), same as
        // x/y/z/yaw, not a partial patch. Matches presence-server.js's own
        // moveMember().
        $room[$id]['shirtColor'] = presence_sanitize_color($body['shirtColor'] ?? null);
        $room[$id]['pantsColor'] = presence_sanitize_color($body['pantsColor'] ?? null);
        if ($actuallyMoved) $room[$id]['lastActivityAt'] = presence_now_ms();
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
  // Task #139 — tells the client WHY, if this id turns out to be gone:
  // 'duplicate-join-lost' means auto-rejoining would just fight whoever
  // won the challenge; anything else (plain staleness, most often a
  // backgrounded tab's poll timer throttled past PRESENCE_POLL_TIMEOUT_MS)
  // is safe to silently self-heal from. See presence_resolve_challenge()'s
  // own comment on duplicateJoinLosses.
  $reason = isset($doc['duplicateJoinLosses'][$id]) ? 'duplicate-join-lost' : 'stale';
  return ['found' => false, 'reason' => $reason];
});

if (!$result['found']) send_json(404, ['error' => 'unknown or expired presence id — rejoin', 'reason' => $result['reason']]);
send_json(200, ['roster' => $result['roster'], 'signals' => $result['signals']]);
