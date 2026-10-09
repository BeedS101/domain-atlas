<?php
// POST /presence/poll/join — body {domain, world, name}. Joins the room and
// returns {id, publicId, roster}: `id` is the private connection token the
// client presents to sync and leave; `publicId` is the avatar id other
// members see. No wallet identity is accepted or stored. A full room or
// server answers 503 {reason}.
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

$result = presence_join($domain, $world, $name);
if (!$result['ok']) join_failure_response($result['reason']);
send_json(200, ['id' => $result['token'], 'publicId' => $result['publicId'], 'roster' => $result['roster']]);
