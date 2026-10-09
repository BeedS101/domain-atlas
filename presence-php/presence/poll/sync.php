<?php
// POST /presence/poll/sync — body {id, x?, y?, z?, yaw?, look colours?}.
// Heartbeat + optional pose update + the room's full current roster. `id` is
// the private connection token from join. 404 when it is unknown or expired,
// which the client treats as "rejoin".
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
        $room[$id]['shirtColor'] = presence_sanitize_color($body['shirtColor'] ?? null);
        $room[$id]['pantsColor'] = presence_sanitize_color($body['pantsColor'] ?? null);
        $room[$id]['hatColor'] = presence_sanitize_color($body['hatColor'] ?? null);
        $room[$id]['shoeColor'] = presence_sanitize_color($body['shoeColor'] ?? null);
        $room[$id]['shoeScale'] = presence_sanitize_scale($body['shoeScale'] ?? null);
      }
    }
    $roster = presence_roster_of($room, $id);
    unset($room);
    return ['found' => true, 'roster' => $roster];
  }
  unset($room);
  return ['found' => false];
});

if (!$result['found']) send_json(404, ['error' => 'unknown or expired presence id — rejoin']);
send_json(200, ['roster' => $result['roster']]);
