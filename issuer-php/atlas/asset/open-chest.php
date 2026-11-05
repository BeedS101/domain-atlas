<?php
// POST /atlas/asset/open-chest — consume one Studio key and receive the chest's reward, once per owner key
// per chest (lib/chests.php). The request carries the key credential, the chest id and a requestId, and an
// intent signed by the key's owner over exactly those. The reward is signed first, then the key is spent in
// the same atomic replacement as every other spend (lib/replacement.php), so a repeated requestId returns
// the stored result and a failed request never spends the key. Node issuer has no chests.
require_once __DIR__ . '/../../lib/bootstrap.php';
require_once __DIR__ . '/../../lib/chests.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$credential = $body['credential'] ?? null;
$chestId = $body['chestId'] ?? null;
if (!is_array($credential) || !is_string($chestId) || $chestId === '') {
  send_json(400, ['error' => 'credential and chestId are required']);
}
try {
  $requestId = atlas_parse_request_id($body);
} catch (Exception $e) {
  send_json(400, ['error' => $e->getMessage()]);
}
if ($requestId === null) send_json(400, ['error' => 'requestId is required to open a chest', 'code' => 'request-id-required']);

$signer = atlas_require_owner_intent($body, [
  'action' => 'open-chest', 'chestId' => $chestId, 'credentialId' => $credential['id'] ?? null,
  'requestId' => $requestId, 'domain' => $credential['issuer']['domain'] ?? null,
], [$credential]);
$params = ['chestId' => $chestId, 'ownerPublicKey' => $signer];
atlas_begin_replacement($kp['publicKeyB64url'], $requestId, 'open-chest', [$credential], $params);

$chest = atlas_chest_entry($chestId);
if ($chest === null) send_json(404, ['error' => 'unknown chest', 'code' => 'unknown-chest']);

$problem = check_presented_fulfillable_asset($kp['publicKeyB64url'], $credential);
if ($problem === null) $problem = atlas_chest_key_problem($kp['publicKeyB64url'], $credential, $signer);
if ($problem) send_json(400, atlas_spend_problem_body($problem, $credential));

// One request at a time per owner and chest: the check of "already opened" and the marker write are one step.
$busy = atlas_lease('chest', $chestId . "\n" . $signer);
if ($busy !== null) send_json(503, ['error' => $busy, 'code' => 'busy']);
try {
  if (atlas_chest_opened($chestId, $signer)) {
    send_json(409, ['error' => 'this wallet has already opened this chest', 'code' => 'chest-already-opened', 'chestId' => $chestId]);
  }
  $asset = atlas_asset_catalog_entry($chest['rewardClass']);
  if ($asset === null) send_json(500, ['error' => 'the chest reward is not available', 'code' => 'reward-unavailable']);
  $reward = issue_asset($kp['privateKey'], $kp['publicKeyB64url'], $signer, $asset, 1, null, true);
  atlas_fault_point('chest:signed');
  atlas_chest_marker_write($chestId, $signer, $requestId, $credential['id']);
  atlas_fault_point('chest:marked');
  $responseJson = atlas_commit_replacement(
    $requestId, 'open-chest', [$credential['id']], 'consumed', $params, [$reward],
    ['opened' => true, 'chestId' => $chestId, 'chestName' => $chest['name'], 'consumed' => $credential['id'], 'reward' => $reward]
  );
} catch (Exception $e) {
  send_json($e->getCode() >= 400 && $e->getCode() < 600 ? $e->getCode() : 503, ['error' => $e->getMessage()]);
}
archive_if_audited($credential, 'consumed');
atlas_send_committed($responseJson);
