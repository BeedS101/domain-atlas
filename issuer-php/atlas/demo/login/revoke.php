<?php
// POST /atlas/demo/login/revoke — mirrors issuer-server/server.js's same
// route. Self-serve sibling of atlas/revoke.php, hardcoded to
// atlas.demo.login.badge only — no admin auth at all. Lets
// login-demo.html's optional "see revocation take effect live" step run
// without an admin login — a genuine revoke against this domain's own
// revocation list, just narrowed to a class with nothing real at stake.
require_once __DIR__ . '/../../../lib/bootstrap.php';
handle_preflight();
require_post();
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$credential = $body['credential'] ?? null;
if (!is_array($credential) || !isset($credential['asset'])) send_json(400, ['error' => 'credential is required']);
if (($credential['asset']['class'] ?? null) !== 'atlas.demo.login.badge') {
  send_json(400, ['error' => 'this endpoint only revokes atlas.demo.login.badge']);
}
if (!isset($credential['issuer']['domain']) || $credential['issuer']['domain'] !== atlas_domain()) {
  send_json(400, ['error' => 'this domain did not issue this credential']);
}
if (is_revoked($credential['id'])) send_json(400, ['error' => 'credential is already revoked']);

$sigOk = verify_own_credential_signature($kp['publicKeyB64url'], $credential, asset_payload_of($credential));
if (!$sigOk) send_json(400, ['error' => "credential signature does not check out against this issuer's key"]);

atlas_revoke($credential['id'], 'demo-self-serve');
send_json(200, ['ok' => true]);
