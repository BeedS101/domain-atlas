<?php
// POST /presence/poll/chat-leave — body {id}. Best-effort explicit leave; a
// closed tab never reaches it and is swept as stale instead. An unknown or
// already-gone id is a silent no-op.
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
