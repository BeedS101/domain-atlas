<?php
// POST /presence/poll/chat-join — body {domain, world, name[, visit]}. Joins the
// domain's chat room and returns {id, senderId, messages}: `id` is the
// private connection token for sync/send/leave, `senderId` the random
// per-join id other members see on this member's messages (it is not an
// identity), `messages` the bounded recent history. No wallet identity is
// accepted or stored. Refusals use the same statuses and body as join.php.
require_once __DIR__ . '/../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$domain = presence_clean_id(isset($body['domain']) ? $body['domain'] : null);
$world = presence_clean_id(isset($body['world']) ? $body['world'] : null);
if ($domain === null || $world === null) send_json(400, ['error' => 'a valid domain and world are required', 'reason' => 'invalid']);
$name = presence_clean_name(isset($body['name']) ? $body['name'] : '');

$result = chat_join_room($domain, $world, $name, isset($_SERVER['REMOTE_ADDR']) ? $_SERVER['REMOTE_ADDR'] : '', isset($body['visit']) ? $body['visit'] : null);
if (!$result['ok']) join_failure_response($result);
send_json(200, ['id' => $result['id'], 'senderId' => $result['senderId'], 'messages' => $result['messages']]);
