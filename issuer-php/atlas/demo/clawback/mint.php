<?php
// POST /atlas/demo/clawback/mint: mints a demo recovery token, or a block of
// demo bank funds ({amount}), carrying a demo authority key (lib/demo-authority.php). Only that key
// may later suspend, unsuspend or claw it back through the demo routes; the
// owner's key cannot. clawback-demo.html and reserve-bank-demo.html Act 7.
// Mirrors issuer-server/server.js.
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
$ownerPublicKey = $body['ownerPublicKey'] ?? null;
$authorityPublicKey = $body['authorityPublicKey'] ?? null;
$assetClass = $body['assetClass'] ?? ATLAS_DEMO_CLAWBACK_TOKEN_CLASS;
$amount = $body['amount'] ?? null;
if (!atlas_demo_valid_key($ownerPublicKey) || !atlas_demo_valid_key($authorityPublicKey)) {
  send_json(400, ['error' => 'ownerPublicKey and authorityPublicKey must be raw P-256 public keys']);
}
if ($authorityPublicKey === $ownerPublicKey) send_json(400, ['error' => 'the demo authority must be a different key from the owner']);
if (!in_array($assetClass, atlas_demo_suspendable_classes(), true)) {
  send_json(400, ['error' => 'this endpoint only mints: ' . implode(', ', atlas_demo_suspendable_classes())]);
}
$properties = [ATLAS_DEMO_AUTHORITY_PROPERTY => $authorityPublicKey];
if ($assetClass === ATLAS_DEMO_CLAWBACK_FUNDS_CLASS) {
  if (!atlas_is_positive_int($amount) || $amount > 1000000) send_json(400, ['error' => 'amount must be a positive integer up to 1,000,000']);
  $properties['com.example.amount'] = (int) $amount;
} elseif ($amount !== null) {
  send_json(400, ['error' => 'amount applies only to ' . ATLAS_DEMO_CLAWBACK_FUNDS_CLASS]);
}
$credential = mint_asset_by_class($kp['privateKey'], $kp['publicKeyB64url'], $ownerPublicKey, $assetClass, 1, null, $properties);
send_json(200, $credential);
