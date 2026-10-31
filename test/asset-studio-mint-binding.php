<?php
// Proof binding rules that depend on time or on exact shapes; signature verification itself is covered
// against the live issuer in asset-studio-integration.js.
require_once __DIR__ . '/studio-test-lib.php';
require_once __DIR__ . '/../issuer-php/atlas/studio/inc/authorize-design.php';
$now = 1800000000;
$key = studio_raw_key();
$origin = 'https://a.test';
$design = STUDIO_TEST_DESIGN;
$fp = atlas_studio_design_fingerprint($design);
$summary = atlas_studio_summary($fp['design']);
$nonce = str_repeat('ab', 32);
$challenge = ['nonce' => $nonce, 'designDigest' => $fp['designDigest'], 'recipient' => $key, 'expiresAt' => $now + 100, 'state' => 'issued'];
function proof($challenge, $summary, $key, $origin) {
  return ['signerRole' => 'raw-ecdsa', 'publicKey' => $key, 'signature' => 'x', 'signedPayload' => [
    'ctx' => 'atlas.bridge.sign/1', 'origin' => $origin,
    'payload' => atlas_studio_sign_request($challenge, $summary)]];
}
$yes = function () { return true; };
$no = function () { return false; };
$boom = function () { throw new Exception('x'); };
$notBool = function () { return 1; };

$good = proof($challenge, $summary, $key, $origin);
$r = atlas_studio_authorize_design_proof($design, $good, $challenge, [$origin], $yes, $now);
studio_check($r['ok'] && $r['recipient'] === $key && $r['designDigest'] === $fp['designDigest'], 'a correct proof is accepted');
foreach ([['refusing', $no], ['throwing', $boom], ['non-boolean', $notBool], ['missing', null]] as $pair) {
  $r = atlas_studio_authorize_design_proof($design, $good, $challenge, [$origin], $pair[1], $now);
  studio_check(!$r['ok'], 'verifier result must be exactly true: ' . $pair[0]);
}

// Freshness: an expired challenge fails normally, but a retry of a completed mint skips freshness.
$stale = $challenge; $stale['expiresAt'] = $now - 1;
$r = atlas_studio_authorize_design_proof($design, proof($stale, $summary, $key, $origin), $stale, [$origin], $yes, $now);
studio_check(!$r['ok'] && $r['error'] === 'challenge-expired', 'expired challenge refused');
$r = atlas_studio_authorize_design_proof($design, proof($stale, $summary, $key, $origin), $stale, [$origin], $yes, $now, true);
studio_check($r['ok'], 'retry mode accepts the original expiry');
$far = $challenge; $far['expiresAt'] = $now + ATLAS_STUDIO_CHALLENGE_TTL + 1;
$r = atlas_studio_authorize_design_proof($design, proof($far, $summary, $key, $origin), $far, [$origin], $yes, $now);
studio_check(!$r['ok'] && $r['error'] === 'challenge-expired', 'expiry beyond the TTL refused');
$r = atlas_studio_authorize_design_proof($design, proof($far, $summary, $key, $origin), $far, [$origin], $yes, $now, true);
studio_check($r['ok'], 'retry mode does not check the TTL window (the caller does, for new credentials only)');

// Challenge state: only 'issued' for a fresh mint; 'completed' is acceptable for a retry only.
$done = $challenge; $done['state'] = 'completed';
studio_check(!atlas_studio_authorize_design_proof($design, proof($done, $summary, $key, $origin), $done, [$origin], $yes, $now)['ok'], 'completed challenge refused for a new mint');
studio_check(atlas_studio_authorize_design_proof($design, proof($done, $summary, $key, $origin), $done, [$origin], $yes, $now, true)['ok'], 'completed challenge accepted for a retry');
$odd = $challenge; $odd['state'] = 'weird';
studio_check(!atlas_studio_authorize_design_proof($design, proof($odd, $summary, $key, $origin), $odd, [$origin], $yes, $now, true)['ok'], 'unknown challenge state refused');

// Origin: exact match against the configured list only.
foreach (['https://a.test:444', 'http://a.test', 'https://A.test', 'https://a.test/', 'https://b.test', ''] as $o) {
  $r = atlas_studio_authorize_design_proof($design, proof($challenge, $summary, $key, $o), $challenge, [$origin], $yes, $now);
  studio_check(!$r['ok'] && $r['error'] === 'wrong-signing-context', 'origin refused: ' . $o);
}
studio_check(!atlas_studio_authorize_design_proof($design, $good, $challenge, [], $yes, $now)['ok'], 'no configured origins refuses everything');

// Hostile types never reach comparisons or the verifier.
$called = false;
$spy = function () use (&$called) { $called = true; return true; };
$mut = function ($f) use ($good) { $p = $good; $f($p); return $p; };
$hostile = [
  $mut(function (&$p) { $p['signedPayload']['payload']['nonce'] = [$GLOBALS['nonce']]; }),
  $mut(function (&$p) { $p['signedPayload']['payload']['expiresAt'] = (string) $GLOBALS['challenge']['expiresAt']; }),
  $mut(function (&$p) { $p['signedPayload']['payload']['expiresAt'] = (float) $GLOBALS['challenge']['expiresAt'] + 0.5; }),
  $mut(function (&$p) { $p['signedPayload']['origin'] = ['https://a.test']; }),
  $mut(function (&$p) { $p['publicKey'] = null; }),
  $mut(function (&$p) { $p['signedPayload']['extra'] = 1; }),
  $mut(function (&$p) { $p['signerRole'] = 'webauthn'; }),
  $mut(function (&$p) { $p['junk'] = 1; }),
  'proof', null, 5, [],
];
foreach ($hostile as $i => $p) {
  $r = atlas_studio_authorize_design_proof($design, $p, $challenge, [$origin], $spy, $now);
  studio_check(!$r['ok'], "hostile proof $i refused");
}
studio_check($called === false, 'the verifier is never reached by a structurally invalid proof');

// Keys: only valid P-256 spellings.
studio_check(atlas_studio_p256_key_kind($key) === 'raw', 'raw key recognised');
$spki = studio_b64u(base64_decode(strtr(preg_replace('/-----[A-Z ]+-----|\s/', '', openssl_pkey_get_details(openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']))['key']), '-_', '+/')));
studio_check(atlas_studio_p256_key_kind($spki) === 'spki', 'SPKI key recognised');
studio_check(atlas_studio_p256_key_kind(studio_b64u("\x04" . random_bytes(64))) === null, 'point not on the curve refused');
studio_check(atlas_studio_p256_key_kind($key . '=') === null && atlas_studio_p256_key_kind('') === null && atlas_studio_p256_key_kind(null) === null, 'bad spellings refused');
echo "Asset Studio mint binding tests passed\n";
