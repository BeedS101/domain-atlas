<?php
// POST /atlas/asset/consolidate — mirrors issuer-server/server.js's same
// route. Merges several balances of the same class, from this issuer,
// owned by the same public key, into one freshly-signed balance — a client
// can't do this math itself and self-sign it, since an asset credential's
// quantity is only meaningful because the issuer's signature vouches for
// it. Old balances are revoked ('consolidated') only after the new one is
// successfully signed. Fungible only (SPEC.md §5.4/§5.4.1) —
// check_presented_asset() below rejects a fungible:false credential with
// a clear error.
require_once __DIR__ . '/../../lib/bootstrap.php';
handle_preflight();
require_post();
// Disabled: the request carries no signature from the credentials' owner, so
// anyone holding copies could merge someone else's balances. Refused until a
// signed owner authorization is verified here. Mirrors issuer-server/server.js
// (OWNER_AUTHORIZATION_REQUIRED).
send_json(403, ['error' => 'This operation needs a signature from the owner of the credential, which this issuer does not check yet, so it is disabled.', 'code' => 'owner-authorization-required']);
$kp = atlas_load_keys();

try {
  $body = read_json_body();
} catch (Exception $e) {
  send_json(400, ['error' => 'invalid JSON body']);
}

$credentials = $body['credentials'] ?? null;
if (!is_array($credentials) || count($credentials) < 2) {
  send_json(400, ['error' => 'credentials must be an array of at least two balances']);
}
if (count($credentials) > 20) {
  send_json(400, ['error' => 'too many balances in one consolidation (max 20 at a time)', 'code' => 'too-many', 'max' => 20]);
}

$ids = array_map(function ($c) { return is_array($c) ? ($c['id'] ?? null) : null; }, $credentials);
if (count(array_unique($ids)) !== count($ids)) {
  send_json(400, ['error' => 'duplicate balance in consolidation request']);
}

$requestId = atlas_parse_request_id($body);
atlas_begin_replacement($kp['publicKeyB64url'], $requestId, 'consolidate', $credentials, []);

$owner = $credentials[0]['owner']['publicKey'] ?? null;
$cls = $credentials[0]['asset']['class'] ?? null;
foreach ($credentials as $credential) {
  $problem = check_presented_asset($kp['publicKeyB64url'], $credential, $owner, $cls, 1);
  if ($problem) send_json(400, atlas_spend_problem_body($problem, $credential));
}

$total = array_reduce($credentials, function ($sum, $c) { return $sum + $c['quantity']; }, 0);
$merged = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $owner, $cls, $total, $ids, null, true);
$responseJson = atlas_commit_replacement($requestId, 'consolidate', $ids, 'consolidated', [], [$merged], $merged);
foreach ($credentials as $c) archive_if_audited($c, 'consolidated');
atlas_send_committed($responseJson);
