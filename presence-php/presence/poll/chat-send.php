<?php
// POST /presence/poll/chat-send — body {id, text}. Validates and appends a
// message from a joined member. A rejected send answers 200 {ok:false,
// reason} with one of the fixed short reasons the client turns into a status
// line:
//   'rate-limited' — sent faster than CHAT_MIN_INTERVAL_MS.
//   'empty'        — nothing left after cleaning and trimming.
//   'blocked'      — the server's own profanity check (authoritative; see
//                    chat_text_contains_blocked_word() in lib/store.php).
// An unknown or expired id is 404 (the client rejoins). Sending does not
// require a wallet identity and messages carry none: the display name is
// whatever the sender announced and is not authenticated.
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
$text = isset($body['text']) ? $body['text'] : '';

$result = chat_send_message($id, $text);
if (!$result['found']) send_json(404, ['error' => 'unknown or expired chat id — rejoin']);
if (!$result['ok']) send_json(200, ['ok' => false, 'reason' => $result['reason']]);
send_json(200, ['ok' => true, 'message' => $result['message']]);
