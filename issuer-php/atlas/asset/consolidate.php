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
  send_json(400, ['error' => 'too many balances in one consolidation (max 20 at a time)']);
}

$ids = array_map(function ($c) { return is_array($c) ? ($c['id'] ?? null) : null; }, $credentials);
if (count(array_unique($ids)) !== count($ids)) {
  send_json(400, ['error' => 'duplicate balance in consolidation request']);
}

$owner = $credentials[0]['owner']['publicKey'] ?? null;
$cls = $credentials[0]['asset']['class'] ?? null;
foreach ($credentials as $credential) {
  $problem = check_presented_asset($kp['publicKeyB64url'], $credential, $owner, $cls, 1);
  if ($problem) send_json(400, ['error' => $problem]);
}

$total = array_reduce($credentials, function ($sum, $c) { return $sum + $c['quantity']; }, 0);
$merged = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $owner, $cls, $total, $ids);
foreach ($ids as $id) atlas_revoke($id, 'consolidated');
send_json(200, $merged);
