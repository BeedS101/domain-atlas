<?php
// POST /presence/poll/chat-send — mirrors presence-server/server.js's
// identical route. Validates and appends a message from an
// already-joined member, same fixed short rejection reasons the
// WebSocket path's 'chat-error' carries and extension/viewer.js's
// chatErrorText() already knows how to turn into a status line:
//   'login-required' — this member joined with no publicKey (anonymous/
//                       locked wallet) — reading never requires one,
//                       sending always does (per the user's own spec).
//   'empty'           — nothing left after trimming.
//   'blocked'         — the SERVER's own profanity check (authoritative —
//                       see chat_text_contains_blocked_word() in
//                       lib/store.php), independent of whatever the
//                       client already checked before even sending this
//                       request, since a client can always be modified to
//                       skip its own check.
// Always a 200 with {ok:false, reason:...} for these — a validation
// rejection isn't a transport error, same reasoning presence's own
// poll/signal.php's {ok} shape uses. A genuinely unknown/expired id is
// the one case that gets a real 404, same as every other route here.
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
