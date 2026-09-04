<?php
// POST /presence/poll/chat-join — mirrors presence-server/server.js's
// identical route (task #110, the PHP port of task #68's polling
// fallback applied to in-world chat — this bundle's counterpart to
// poll/join.php just above it for presence). Lives under poll/, not a
// separate chat/ folder, and answers /presence/poll/chat-join (not
// /presence/chat/join) specifically so it's reachable at the EXACT same
// URL extension/viewer.js's pollChat() and the Node presence-server's own
// /presence/poll/chat-join route both use — nothing in the extension
// needs to know or care which backend answered. Creates a new member in
// the domain's chat room and returns {id, messages}: this new member's
// own id, plus the domain's current chat history backlog — same shape
// the WebSocket version's own 'chat-history' message carries.
//
// publicKey is optional (matches #63/#67's "presence/chat never requires
// an identity to READ" principle) — an anonymous visitor with no
// unlocked wallet joins with none at all, and simply can't send (see
// chat-send.php's login-required check); reading chat never asks for one.
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
$publicKey = (isset($body['publicKey']) && $body['publicKey'] !== '') ? substr((string) $body['publicKey'], 0, PRESENCE_MAX_PUBLIC_KEY_LEN) : null;

$result = chat_join_room($domain, $world, $name, $publicKey);
if ($result === null) send_json(400, ['error' => 'domain and world are required']);

send_json(200, $result);
