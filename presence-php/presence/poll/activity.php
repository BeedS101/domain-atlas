<?php
// POST /presence/poll/activity — mirrors presence-server/server.js's
// identical route (task #137): an explicit "I'm still here" ping for
// activity this bundle has no other way to observe — wallet activity in
// particular (minting, trading, splitting, etc.), since
// extension/wallet.js has no visibility into presence at all to report
// as real movement or a chat send; extension/viewer.js relays it as a
// deliberate ping instead. Resets this member's PRESENCE_ACTIVITY_IDLE_MS
// clock exactly like a real move or a chat send would — see
// presence_is_member_active() in lib/store.php.
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

$found = with_presence_store_locked(function (&$doc) use ($id) {
  foreach ($doc['rooms'] as $roomKey => &$room) {
    if (isset($room[$id])) { $room[$id]['lastActivityAt'] = presence_now_ms(); unset($room); return true; }
  }
  unset($room);
  return false;
});

if (!$found) send_json(404, ['error' => 'unknown or expired presence id — rejoin']);
send_json(200, ['ok' => true]);
