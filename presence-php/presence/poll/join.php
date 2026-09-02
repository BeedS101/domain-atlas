<?php
// POST /presence/poll/join — mirrors presence-server/server.js's identical
// route (task #68). Creates a new member in the domain+world room and
// returns {id, roster}: this new member's own id, plus the room's current
// roster (everyone ELSE already there). Same shape the Node version's own
// /presence/poll/join route (and its WebSocket 'welcome' message) both
// use, so extension/viewer.js's pollPresence() works against this
// unmodified — nothing in the extension needs to know which backend
// answered.
require_once __DIR__ . '/../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$domain = isset($body['domain']) ? substr((string) $body['domain'], 0, PRESENCE_MAX_ID_LEN) : '';
$world = isset($body['world']) ? substr((string) $body['world'], 0, PRESENCE_MAX_ID_LEN) : '';
if ($domain === '' || $world === '') send_json(400, ['error' => 'domain and world are required']);
$name = isset($body['name']) ? substr((string) $body['name'], 0, PRESENCE_MAX_NAME_LEN) : '';
if ($name === '') $name = 'Visitor';
// Optional (task #67), same "presence never requires an identity"
// principle as presence-server.js's own addMember() — an anonymous
// visitor with no unlocked wallet sends no publicKey at all, and simply
// can't be friend-requested (there's nothing stable to add).
$publicKey = (isset($body['publicKey']) && $body['publicKey'] !== '') ? substr((string) $body['publicKey'], 0, PRESENCE_MAX_PUBLIC_KEY_LEN) : null;

$result = with_presence_store_locked(function (&$doc) use ($domain, $world, $name, $publicKey) {
  $roomKey = presence_room_key($domain, $world);
  if (!isset($doc['rooms'][$roomKey])) $doc['rooms'][$roomKey] = [];
  presence_sweep_room($doc['rooms'][$roomKey]);
  $roster = presence_roster_of($doc['rooms'][$roomKey], null);
  $connId = presence_new_id();
  // New members spawn at the origin by default and get their real position
  // on their first sync a moment later — same accepted minor rough edge
  // presence-server.js's own addMember() has, not worth extra protocol
  // complexity to avoid.
  $doc['rooms'][$roomKey][$connId] = [
    'name' => $name, 'publicKey' => $publicKey, 'x' => 0.0, 'y' => 0.0, 'z' => 0.0, 'yaw' => 0.0,
    'lastSeen' => presence_now_ms(), 'pendingSignals' => []
  ];
  return ['id' => $connId, 'roster' => $roster];
});

send_json(200, $result);
