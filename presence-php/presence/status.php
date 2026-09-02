<?php
// GET /presence/status?domain=X&world=Y — mirrors presence-server/server.js's
// identical route (Favorites, #61). "How many people are in this world
// right now, and who" for a domain+world the caller ISN'T currently
// present in (a favorited domain the visitor hasn't opened), WITHOUT
// creating a room member the way join.php would.
//
// The client cross-references the returned roster's publicKey values
// against its OWN local friends list to show "N here, including 2
// friends" — this endpoint never sees or stores anyone's friends list, so
// it stays as simple as the rest of this bundle: it just reports who's
// here, full stop. Same "no admin/listing endpoint beyond this" privacy
// posture as the rest of this bundle's README.txt describes for the
// roster in general.
//
// GET, not POST — this route only ever reads, never creates or mutates
// anything, so it doesn't go through require_post() the other routes do.
require_once __DIR__ . '/lib/bootstrap.php';
handle_preflight();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
  http_response_code(405);
  cors_headers();
  echo 'Method not allowed';
  exit;
}

$domain = isset($_GET['domain']) ? substr((string) $_GET['domain'], 0, PRESENCE_MAX_ID_LEN) : '';
$world = isset($_GET['world']) ? substr((string) $_GET['world'], 0, PRESENCE_MAX_ID_LEN) : '';
if ($domain === '' || $world === '') send_json(400, ['error' => 'domain and world are required']);

$result = with_presence_store_locked(function (&$doc) use ($domain, $world) {
  $roomKey = presence_room_key($domain, $world);
  if (!isset($doc['rooms'][$roomKey])) return ['count' => 0, 'roster' => []];
  presence_sweep_room($doc['rooms'][$roomKey]);
  return ['count' => count($doc['rooms'][$roomKey]), 'roster' => presence_roster_of($doc['rooms'][$roomKey], null)];
});

send_json(200, $result);
