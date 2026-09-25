<?php
// GET/POST /atlas/calendar (SPEC.md §12) — mirrors issuer-server/server.js's
// same route. Unlike almost everything else in this bundle, one file
// handles BOTH methods: §12 puts the read and the write at the exact same
// URL, no plural/singular naming trick like world/drop vs. world/drops was
// available here — so this dispatches on $_SERVER['REQUEST_METHOD'] itself
// instead of splitting into two files the way require_get()/require_post()
// elsewhere assume a file only ever answers one method.
//
// GET, optionally ?world={worldId} — ungated and unsigned, same plain-
// HTTPS trust boundary as the manifest and GET /atlas/trade/catalog
// (§12.1: "no new signature scheme for a field that was always going to
// be public"). No `world` param returns the domain-wide calendar; naming a
// world that never opted in (or doesn't exist) gets back an empty
// `events` array rather than an error, same "nothing to report" posture
// GET /atlas/trade/listings already takes for a station with nothing open.
//
// POST — a real, protocol-level write endpoint (§12.2), admin-gated
// (require_admin(), lib/store.php) the same way atlas/revoke.php,
// atlas/mail/send.php, and atlas/asset/reissue.php are: publishing a
// domain's or world's calendar is squarely the domain operator's own
// action, never a visitor's, and left open it meant anyone could plant or
// overwrite events shown to every visitor of this domain. Wire shape is
// {payload: {action, worldId, event, id}, proof}, the same envelope every
// other admin action here uses. `worldId` null (or omitted) addresses the
// domain-wide calendar; naming a world addresses that world's own — this
// bundle does not check that world's manifest entry actually has
// `calendar: true` before accepting an event for it (see
// atlas_calendar_file()'s own comment in lib/store.php).
require_once __DIR__ . '/../lib/bootstrap.php';
handle_preflight();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $worldId = (isset($_GET['world']) && $_GET['world'] !== '') ? $_GET['world'] : null;
  $events = read_calendar_events($worldId);
  send_json(200, ['domain' => atlas_domain(), 'worldId' => $worldId, 'events' => $events]);
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
  try {
    $requestBody = read_json_body();
  } catch (Exception $e) {
    send_json(400, ['error' => 'invalid JSON body']);
  }
  $calendarPayload = $requestBody['payload'] ?? null;
  $proof = $requestBody['proof'] ?? null;
  $authError = require_admin($calendarPayload, $proof);
  if ($authError) send_json(401, ['error' => $authError]);

  $action = $calendarPayload['action'] ?? null;
  $worldId = (isset($calendarPayload['worldId']) && $calendarPayload['worldId'] !== '') ? $calendarPayload['worldId'] : null;

  if ($action === 'add') {
    $event = $calendarPayload['event'] ?? null;
    if (!is_array($event) || empty($event['title']) || empty($event['dateTime'])) {
      send_json(400, ['error' => 'event.title and event.dateTime are required']);
    }
    $newEvent = [
      'id' => !empty($event['id']) ? $event['id'] : ('urn:atlas:calendar:' . atlas_uuid()),
      'worldId' => $worldId,
      'title' => $event['title'],
      'dateTime' => $event['dateTime'],
      'endDateTime' => $event['endDateTime'] ?? null,
      'notes' => $event['notes'] ?? '',
    ];
    add_calendar_event($newEvent);
    send_json(200, $newEvent);
  }

  if ($action === 'update') {
    $event = $calendarPayload['event'] ?? null;
    if (!is_array($event) || empty($event['id'])) send_json(400, ['error' => 'event.id is required for update']);
    $patch = [];
    foreach (['title', 'dateTime', 'endDateTime', 'notes'] as $field) {
      if (array_key_exists($field, $event)) $patch[$field] = $event[$field];
    }
    $updated = update_calendar_event($event['id'], $patch);
    if ($updated === null) send_json(404, ['error' => 'no calendar event with that id']);
    send_json(200, $updated);
  }

  if ($action === 'remove') {
    $id = $calendarPayload['id'] ?? null;
    if (!$id) send_json(400, ['error' => 'id is required for remove']);
    $removed = remove_calendar_event($id);
    if ($removed === null) send_json(404, ['error' => 'no calendar event with that id']);
    send_json(200, ['status' => 'removed', 'id' => $id]);
  }

  send_json(400, ['error' => 'action must be "add", "update", or "remove"']);
}

http_response_code(405);
cors_headers();
echo 'Method not allowed';
