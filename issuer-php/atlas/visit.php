<?php
// POST /atlas/visit — mirrors issuer-server/server.js's same route.
// Public and unauthenticated by design: a wallet announces "I just entered
// this world" so the operator's admin panel can show how busy each scene
// is, 2D and 3D alike. Body is just {world}; nothing about the visitor is
// sent or stored. Accepts only a world id this domain's own manifest
// declares (declared_world_ids()), so it can't be used to invent counters.
// Counts are self-reported, not verified.
require_once __DIR__ . '/../lib/bootstrap.php';
handle_preflight();
require_post();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$world = $body['world'] ?? null;
if (!is_string($world) || !in_array($world, declared_world_ids(), true)) {
  send_json(400, ['error' => 'unknown world']);
}

record_visit($world);
send_json(200, ['recorded' => true]);
