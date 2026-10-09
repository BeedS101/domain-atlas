<?php
// POST /presence/poll/leave — body {id}. Best-effort: the client calls this
// on a clean world switch or overlay close; a closed tab never reaches it,
// and the staleness sweep in with_presence_store_locked() removes that
// member instead. An unknown or already-gone id is a silent no-op.
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
