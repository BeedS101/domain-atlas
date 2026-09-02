<?php
// POST /presence/poll/leave — mirrors presence-server/server.js's identical
// route. Best-effort: extension/viewer.js's disconnectPresence() calls this
// on a clean world switch or overlay close, but a closed tab or crashed
// browser will never reach it — that's what presence_sweep_room()'s
// staleness check (run on every join/sync that touches a room) is for,
// same safety net the Node version's own sweep provides. An unknown or
// already-gone id is a silent no-op, not an error, matching the Node
// route's own leave handling.
require_once __DIR__ . '/../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$id = isset($body['id']) ? (string) $body['id'] : '';

if ($id !== '') {
  with_presence_store_locked(function (&$doc) use ($id) {
    foreach ($doc['rooms'] as $roomKey => &$room) {
      if (isset($room[$id])) {
        unset($room[$id]);
        if (count($room) === 0) unset($doc['rooms'][$roomKey]);
        break;
      }
    }
    unset($room);
    return null;
  });
}

send_json(200, ['ok' => true]);
