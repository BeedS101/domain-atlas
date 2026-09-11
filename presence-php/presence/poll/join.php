<?php
// POST /presence/poll/join — mirrors presence-server/server.js's identical
// route (task #68). Creates a new member in the domain+world room and
// returns {id, roster}: this new member's own id, plus the room's current
// roster (everyone ELSE already there) — UNLESS the same publicKey is
// already present in the room and was recently active (task #137), in
// which case this instead returns {status:'pending', id, challengeId,
// countdownMs} and the caller must poll /presence/poll/join-status to
// learn how the duplicate-join challenge eventually settles. Same shapes
// the Node version's own /presence/poll/join route (and its WebSocket
// 'welcome'/'join-pending' messages) both produce, so
// extension/viewer.js's pollPresence() works against this unmodified —
// nothing in the extension needs to know which backend answered.
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
// can't be friend-requested (there's nothing stable to add), and (task
// #137) never gets deduped against anyone either — see
// presence_find_member_by_public_key() in lib/store.php.
$publicKey = (isset($body['publicKey']) && $body['publicKey'] !== '') ? substr((string) $body['publicKey'], 0, PRESENCE_MAX_PUBLIC_KEY_LEN) : null;

// New members spawn at the origin by default and get their real position
// on their first sync a moment later — same accepted minor rough edge
// presence-server.js's own addMember() has, not worth extra protocol
// complexity to avoid.
$connId = presence_new_id();
$result = presence_request_join($domain, $world, $connId, $name, $publicKey);

if ($result['status'] === 'pending') {
  send_json(200, ['status' => 'pending', 'id' => $connId, 'challengeId' => $result['challengeId'], 'countdownMs' => $result['countdownMs']]);
}
send_json(200, ['id' => $connId, 'roster' => $result['roster']]);
