<?php
// POST /atlas/demo/reserve/consortium/co-sign — mirrors
// issuer-server/server.js's same route. Admin-gated (require_admin_auth(),
// same shape as atlas/admin/trusted-trade-peers/add.php), called on a
// SIBLING domain's own server by that domain's own admin, after reviewing
// the pending request. Fetches the real pending request from the
// requesting domain (never trusts a caller-supplied action), checks this
// domain is actually named as an approver, signs
// {domain, requestingDomain, id, action} with THIS domain's own key, and
// relays that attestation server-to-server to the requesting domain's own
// approve.php — the exact outbound shape atlas_relay_trade_lock()/
// atlas_relay_trade_settle() already use.
require_once __DIR__ . '/../../../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$payload = $body['payload'] ?? null;
$proof = $body['proof'] ?? null;
$token = $body['token'] ?? null;
if (!is_array($payload) || empty($payload['requestingDomain']) || empty($payload['id'])) {
  send_json(400, ['error' => 'payload.requestingDomain and payload.id are both required']);
}
$auth = require_admin_auth($payload, $proof, $token);
if (isset($auth['error'])) send_json(401, ['error' => $auth['error']]);

$requestingDomain = $payload['requestingDomain'];
$id = $payload['id'];

try {
  $fetchRes = atlas_http_request('GET', atlas_base_url($requestingDomain) . '/atlas/demo/reserve/consortium/mint?id=' . rawurlencode($id));
} catch (Exception $e) {
  send_json(502, ['error' => 'could not read the pending request from ' . $requestingDomain . ': ' . $e->getMessage()]);
}
$fetched = json_decode($fetchRes['raw'], true);
if ($fetchRes['status'] !== 200 || !is_array($fetched)) {
  send_json(502, ['error' => 'could not read the pending request from ' . $requestingDomain . ': ' . (is_array($fetched) && isset($fetched['error']) ? $fetched['error'] : ('HTTP ' . $fetchRes['status']))]);
}
$request = $fetched['request'] ?? null;
if (!$request || ($request['status'] ?? null) !== 'pending') {
  send_json(400, ['error' => 'that request is not pending at ' . $requestingDomain . ' (already executed, or expired)']);
}
if (!in_array(atlas_domain(), $request['approverDomains'], true)) {
  send_json(403, ['error' => 'this domain (' . atlas_domain() . ') was not named as an approver for that request']);
}

$attestation = ['domain' => atlas_domain(), 'requestingDomain' => $requestingDomain, 'id' => $id, 'action' => $request['action']];
$attestationSignature = atlas_sign($kp['privateKey'], $attestation);
try {
  $relayRes = atlas_http_post_json(atlas_base_url($requestingDomain) . '/atlas/demo/reserve/consortium/approve', [
    'id' => $id,
    'attestation' => $attestation,
    'attestationSignature' => $attestationSignature,
  ]);
} catch (Exception $e) {
  send_json(502, ['error' => 'could not reach ' . $requestingDomain . ' to relay the co-sign: ' . $e->getMessage()]);
}
if ($relayRes['status'] !== 200) {
  send_json(400, ['error' => isset($relayRes['body']['error']) ? $relayRes['body']['error'] : ($requestingDomain . ' refused the co-sign (HTTP ' . $relayRes['status'] . ')')]);
}
send_json(200, ['ok' => true, 'request' => $relayRes['body']['request'] ?? null]);
