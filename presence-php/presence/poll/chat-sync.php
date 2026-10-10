<?php
// POST /presence/poll/chat-sync — body {id}. Polling counterpart of the Node
// server's pushed 'chat-message': returns only the history entries newer than
// this member's stored cursor and advances the cursor. Also keeps the member
// from being swept as stale. 404 when the id is unknown or expired; 403
// {reason:'removed'} when a moderator removed the session.
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

$result = chat_sync_member($id);
if (!$result['found']) unknown_session_response($id, 'chat');
send_json(200, ['messages' => $result['messages']]);
