<?php
// GET /presence/status?domain=X&world=Y — how many people are in this world
// right now, for a world the caller is not in (Favorites, the on-page
// participant count). A count only: it names nobody and creates no room
// member. This is the one route that sends CORS headers, because a content
// script on any page calls it.
require_once __DIR__ . '/lib/bootstrap.php';
handle_preflight();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
  http_response_code(405);
  echo 'Method not allowed';
  exit;
}

$domain = presence_clean_id(isset($_GET['domain']) ? $_GET['domain'] : null);
$world = presence_clean_id(isset($_GET['world']) ? $_GET['world'] : null);
if ($domain === null || $world === null) send_json(400, ['error' => 'a valid domain and world are required'], true);

$count = with_presence_store_locked(function (&$doc) use ($domain, $world) {
  $roomKey = presence_room_key($domain, $world);
  return isset($doc['rooms'][$roomKey]) ? count($doc['rooms'][$roomKey]) : 0;
});

send_json(200, ['count' => $count], true);
