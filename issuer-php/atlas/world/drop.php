<?php
// POST /atlas/world/drop (task #250, SPEC.md §5.5) — mirrors issuer-server/
// server.js's own /atlas/world/drop handler exactly. Drops a fully-signed
// credential into a world hosted by THIS domain, for any visitor to see
// (GET /atlas/world/drops, world.php) and pick up (POST
// /atlas/world/drops/claim). `world` is just whatever string the client's
// own scene/manifest calls it — this bundle has no independent notion of
// what worlds exist or their policy (policy.itemDropsAllowed/
// acceptedItemClasses/trustedIssuers are all enforced client-side only,
// same "server enforces credential facts, never manifest policy" split
// every other endpoint here already follows).
//
// `credential` need not have been issued by THIS domain — a wearable
// minted by one domain, carried into and dropped in a different domain's
// plaza, is fully supported (SPEC.md §5.5's cross-domain design): this
// domain just hosts the listing regardless of who signed the credential;
// only claiming it (see drops/claim.php) needs to know who the real issuer
// is, to relay the actual mint+revoke there if it isn't this domain.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$credential = $body['credential'] ?? null;
$world = $body['world'] ?? null;
$position = $body['position'] ?? null;
$intent = $body['intent'] ?? null;
if (!$credential || !$world || !$position || !$intent) {
  send_json(400, ['error' => 'credential, world, position, and intent are all required']);
}
if (!isset($intent['payload']) || !isset($intent['proof'])) {
  send_json(400, ['error' => 'intent must carry payload and proof']);
}
$payload = $intent['payload'];
if (($payload['credentialId'] ?? null) !== $credential['id'] || ($payload['world'] ?? null) !== $world || ($payload['action'] ?? null) !== 'drop') {
  send_json(400, ['error' => 'intent does not authorize dropping this credential into this world']);
}

// The owner's intent also names the domain hosting the drop and the drop's id: that is what lets the credential's
// issuer, reached later by a relayed claim, tell this exact drop from any other use of a copy.
if (array_key_exists('domain', $payload) && $payload['domain'] !== atlas_domain()) {
  send_json(400, ['error' => 'intent names a different domain than this one']);
}
if (array_key_exists('dropId', $payload) && (!is_string($payload['dropId']) || !preg_match(ATLAS_WORLD_DROP_ID_PATTERN, $payload['dropId']))) {
  send_json(400, ['error' => 'intent carries a malformed drop id']);
}

$envelopeOk = verify_envelope($payload, $intent['proof']);
if (!$envelopeOk) send_json(400, ['error' => 'intent signature does not check out']);
$dropperPub = $intent['proof']['publicKey'];

$problem = check_presented_transferable_asset($kp['publicKeyB64url'], $credential, $dropperPub, $credential['asset']['class'] ?? null);
if ($problem) send_json(400, ['error' => $problem]);
$foreignItem = ($credential['issuer']['domain'] ?? null) !== atlas_domain();
if ($foreignItem && (($payload['domain'] ?? null) !== atlas_domain() || !isset($payload['dropId']))) {
  send_json(400, ['error' => 'an item issued by another domain can only be dropped with an intent naming this domain and a drop id - update the wallet', 'code' => 'owner-authorization-required']);
}
if (isset($payload['dropId'])) {
  foreach (read_world_drops()['drops'] as $existing) {
    if (($existing['dropId'] ?? null) === $payload['dropId']) send_json(409, ['error' => 'that drop id is already in use']);
  }
}

$dropId = $payload['dropId'] ?? ('urn:atlas:worlddrop:' . atlas_uuid());
append_world_drop(['dropId' => $dropId, 'world' => $world, 'position' => $position, 'credential' => $credential, 'droppedBy' => $dropperPub, 'droppedAt' => iso_now(), 'dropIntent' => ['payload' => $payload, 'proof' => $intent['proof']]]);
send_json(200, ['status' => 'dropped', 'dropId' => $dropId]);
