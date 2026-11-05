<?php
// GET /atlas/chest/status?chestId=...&owner=<public key> — whether that key has already opened the chest, so a
// wallet can say so before asking the owner to spend a key. Reveals only a yes/no for a public key.
require_once __DIR__ . '/../../lib/bootstrap.php';
require_once __DIR__ . '/../../lib/chests.php';
handle_preflight();
require_get();

$chestId = $_GET['chestId'] ?? null;
$owner = $_GET['owner'] ?? null;
$chest = atlas_chest_entry($chestId);
if ($chest === null) send_json(404, ['error' => 'unknown chest', 'code' => 'unknown-chest']);
if (!is_string($owner) || $owner === '' || strlen($owner) > 200) send_json(400, ['error' => 'owner is required']);
try {
  $opened = atlas_chest_opened($chestId, $owner);
} catch (Exception $e) {
  send_json(503, ['error' => $e->getMessage()]);
}
send_json(200, ['chestId' => $chestId, 'name' => $chest['name'], 'rewardClass' => $chest['rewardClass'], 'opened' => $opened]);
