<?php
// POST /presence/poll/chat-send — body {id, text}. Validates and appends a
// message from a joined member. A rejected send answers 200 {ok:false,
// reason} with one of the fixed short reasons the client turns into a status
// line:
//   'rate-limited' — sent faster than CHAT_MIN_INTERVAL_MS.
//   'empty'        — nothing left after cleaning and trimming.
//   'muted'        — a moderator muted this visit; also carries `cause` (a
//                    fixed code), `message` (templated text) and `retryAfter`.
//   'blocked'      — the server's own profanity check (authoritative; see
//                    chat_text_contains_blocked_word() in lib/store.php).
// An unknown or expired id is 404 (the client rejoins); a session a moderator
// removed is 403 {reason:'removed'}. Sending does not
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
if (!$result['found']) unknown_session_response($id, 'chat');
if (!$result['ok']) {
  $out = ['ok' => false, 'reason' => $result['reason']];
  if ($result['reason'] === 'muted') $out += ['cause' => $result['cause'], 'message' => $result['message'], 'retryAfter' => $result['retryAfter']];
  send_json(200, $out);
}
send_json(200, ['ok' => true, 'message' => $result['message']]);
