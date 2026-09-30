<?php
// GET /atlas/asset/history?id=... — mirrors issuer-server/server.js's
// same route. Ungated, same "read is open" reasoning as atlas/asset/
// class.php just above. `id` is the id to start walking the archive
// FROM, ordinarily your own current credential's own `supersedes` value
// (your current body isn't itself archived yet — only what it replaced
// is), or any already-archived id if you're inspecting a past link
// directly. An empty chain just means either nothing before this id was
// archived, or the class it belongs to never opted into `auditHistory`
// at all — see atlas_asset_history_file()'s own comment (lib/store.php)
// for the full reasoning, and atlas.demo.warranty.certificate's own
// catalog entry for the first class that opted in.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_get();

$id = $_GET['id'] ?? null;
if (!$id) send_json(400, ['error' => 'id is required']);

send_json(200, ['chain' => walk_asset_history($id)]);
