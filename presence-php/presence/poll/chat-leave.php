<?php
// POST /presence/poll/chat-leave — mirrors presence-server/server.js's
// identical route. Best-effort: extension/viewer.js's
// disconnectChat() calls this on a clean world switch, lock/unlock
// reconnect, or overlay close, but a closed tab or crashed browser will
// never reach it — that's what chat_sweep_domain()'s staleness check
// (run on every join/sync that touches a domain) is for, same safety net
// presence's own sweep provides. An unknown or already-gone id is a
// silent no-op, not an error, matching the Node route's own leave
// handling.
require_once __DIR__ . '/../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$id = isset($body['id']) ? (string) $body['id'] : '';
chat_leave_room($id);

send_json(200, ['ok' => true]);
