<?php
// POST /presence/poll/chat-sync — mirrors presence-server/server.js's
// identical route. No persistent connection to push a new message down
// (this bundle is polling-only, see lib/store.php's own "in-world chat"
// header comment), so a member asks instead: "what's new since the last
// thing I saw?" Bumps this member's lastSeen (so it doesn't get swept as
// stale — see chat_sweep_domain()) and returns only the history entries
// newer than its stored cursor, advancing that cursor to match so the
// same message never comes back on a later sync.
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
if (!$result['found']) send_json(404, ['error' => 'unknown or expired chat id — rejoin']);
send_json(200, ['messages' => $result['messages']]);
