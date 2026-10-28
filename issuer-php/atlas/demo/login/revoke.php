<?php
// POST /atlas/demo/login/revoke: the owner of a demo login badge revokes it,
// for login-demo.html's "see revocation take effect" step. The owner's signed
// request (lib/demo-authority.php) is required, so nobody can revoke someone
// else's badge; revoking another holder's credential stays with the
// admin-gated atlas/revoke.php. Mirrors issuer-server/server.js.
require_once __DIR__ . '/../../../lib/bootstrap.php';
require_once __DIR__ . '/../../../lib/demo-authority.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();
try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}
$credential = $body['credential'] ?? null;
if (!is_array($credential) || !isset($credential['asset'], $credential['id'])) send_json(400, ['error' => 'credential is required']);
if (($credential['asset']['class'] ?? null) !== 'atlas.demo.login.badge') {
  send_json(400, ['error' => 'this endpoint only revokes atlas.demo.login.badge']);
}
if (($credential['issuer']['domain'] ?? null) !== atlas_domain()) send_json(400, ['error' => 'this domain did not issue this credential']);
$busy = atlas_spend_lock($credential['id']);
if ($busy !== null) send_json(409, ['error' => $busy]);
if (is_revoked($credential['id'])) send_json(400, ['error' => 'credential is already revoked']);
if (!verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential))) {
  send_json(400, ['error' => "credential signature does not check out against this issuer's key"]);
}
atlas_require_demo_request($body, $credential, 'demo-login-revoke', $credential['owner']['publicKey'] ?? null);
atlas_revoke($credential['id'], 'demo-self-serve');
send_json(200, ['ok' => true]);
