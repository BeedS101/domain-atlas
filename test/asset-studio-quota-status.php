<?php
// Read-only wallet quota status with injected time: counts from the attempt ledger across the rolling 24-hour window,
// the configured (default and custom) limit, retries that are not counted twice, identities kept apart, the other
// issuer limits, and who may ask. Signature verification against real keys is covered in asset-studio-quota-http.js.
require_once __DIR__ . '/studio-test-lib.php';
require_once __DIR__ . '/../issuer-php/atlas/studio/inc/quota-status.php';
$root = studio_tmp_root();
$t0 = time(); // file mtimes are real, so injected times stay near the present
$day = 86400;
$digest = str_repeat('d', 64);
$n = function ($i) { return str_pad(dechex($i), 64, '0', STR_PAD_LEFT); };
$A = studio_raw_key(); $B = studio_raw_key();
$limits = function ($recipient, $extra = []) { return $extra + ['perRecipient' => $recipient, 'perActor' => 1000, 'global' => 1000, 'windowSeconds' => 86400]; };
$status = function ($key, $lim, $now, $actor = 'ip4:1.1.1.1', $group = null) use ($root) { return atlas_studio_quota_status($root, $key, $lim, $now, $actor, $group); };
$claim = function ($i, $key, $lim, $now, $actor = 'ip4:1.1.1.1', $group = null) use ($root, $digest, $n) { return atlas_studio_claim_attempt($root, $n($i), $digest, $key, $lim, $now, $actor, $group); };

// Nothing recorded yet: the whole share, and nothing to wait for.
$s = $status($A, $limits(3), $t0);
studio_check($s['limit'] === 3 && $s['used'] === 0 && $s['remaining'] === 3 && $s['nextSlotAt'] === null && $s['otherLimit'] === null && $s['windowSeconds'] === $day, 'an unused wallet has its full share');

// Counts follow the ledger.
studio_check($claim(1, $A, $limits(3), $t0 + 100)['ok'], 'first attempt');
$s = $status($A, $limits(3), $t0 + 200);
studio_check($s['used'] === 1 && $s['remaining'] === 2 && $s['nextSlotAt'] === $t0 + 100 + $day, 'one used: two left, the oldest leaves the window a day after it was made');
studio_check($claim(2, $A, $limits(3), $t0 + 1000)['ok'] && $claim(3, $A, $limits(3), $t0 + 5000)['ok'], 'two more attempts');
$s = $status($A, $limits(3), $t0 + 6000);
studio_check($s['used'] === 3 && $s['remaining'] === 0 && $s['nextSlotAt'] === $t0 + 100 + $day, 'exhausted: none left, available again when the oldest attempt ages out');
$r = $claim(4, $A, $limits(3), $t0 + 6000);
studio_check(!$r['ok'] && $r['error'] === 'quota-recipient', 'the claim itself refuses at the same point the status reports');

// A retry of an attempt already counted changes nothing.
studio_check($claim(2, $A, $limits(3), $t0 + 7000)['existing'] === true, 'retry of attempt 2');
$s = $status($A, $limits(3), $t0 + 7000);
studio_check($s['used'] === 3 && $s['remaining'] === 0, 'a retry is not counted twice');

// Marking an attempt minted does not change what it counts for.
studio_check(atlas_studio_mark_attempt_minted($root, $n(1), 'urn:atlas:asset:1'), 'mark minted');
studio_check($status($A, $limits(3), $t0 + 7000)['used'] === 3, 'a minted attempt still counts once');

// Another wallet has its own count; a status read never changes anyone's.
$s = $status($B, $limits(3), $t0 + 7000);
studio_check($s['used'] === 0 && $s['remaining'] === 3 && $s['nextSlotAt'] === null, 'another identity is counted separately');
$before = array_values(array_diff(scandir(atlas_studio_storage_bucket($root, 'mint-receipts')), ['.', '..']));
for ($i = 0; $i < 5; $i++) $status($A, $limits(3), $t0 + 7000 + $i);
$after = array_values(array_diff(scandir(atlas_studio_storage_bucket($root, 'mint-receipts')), ['.', '..']));
studio_check($before === $after, 'reading the status adds no attempt record');

// Rolling window: attempts leave one at a time, exactly a day after they were made.
$s = $status($A, $limits(3), $t0 + 100 + $day - 1);
studio_check($s['used'] === 3 && $s['remaining'] === 0, 'one second before the oldest ages out it still counts');
$s = $status($A, $limits(3), $t0 + 100 + $day);
studio_check($s['used'] === 2 && $s['remaining'] === 1 && $s['nextSlotAt'] === $t0 + 1000 + $day, 'at exactly a day the oldest is gone and the next one becomes the oldest');
studio_check($claim(5, $A, $limits(3), $t0 + 100 + $day)['ok'], 'and the claim agrees: one more mint is allowed');
$s = $status($A, $limits(3), $t0 + 100 + $day);
studio_check($s['used'] === 3 && $s['remaining'] === 0 && $s['nextSlotAt'] === $t0 + 1000 + $day, 'back to none left; the next slot is the second-oldest attempt');
$s = $status($A, $limits(3), $t0 + 5000 + $day);
studio_check($s['used'] === 1 && $s['remaining'] === 2, 'a day after the third attempt only the newest remains');
$s = $status($A, $limits(3), $t0 + 100 + 2 * $day + 1);
studio_check($s['used'] === 0 && $s['remaining'] === 3 && $s['nextSlotAt'] === null, 'two days on, everything has aged out');

// The configured limit is what is reported: default-sized and custom.
foreach ([1, 3, 7, 1000] as $cfgLimit) {
  $s = $status($B, $limits($cfgLimit), $t0 + 7000);
  studio_check($s['limit'] === $cfgLimit && $s['remaining'] === $cfgLimit, "the limit reported is the configured $cfgLimit");
}
$claim(10, $B, $limits(2), $t0 + 8000);
$s = $status($B, $limits(2), $t0 + 8001);
studio_check($s['limit'] === 2 && $s['used'] === 1 && $s['remaining'] === 1, 'a custom limit of 2 with one used leaves one');
$s = $status($B, $limits(1), $t0 + 8001);
studio_check($s['limit'] === 1 && $s['remaining'] === 0, 'a limit lowered below the use leaves none, never a negative number');

// Either spelling of the same key is one wallet.
$point = substr(atlas_studio_b64url_exact($B), 0, 65);
$spki = studio_b64u(hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200') . $point);
studio_check(atlas_studio_key_fingerprint($spki) === atlas_studio_key_fingerprint($B), 'test key spellings agree');
studio_check($status($spki, $limits(2), $t0 + 8001)['used'] === 1, 'the other spelling of the key sees the same count');

// Corrupt or foreign records are ignored, never counted for anyone.
$dir = atlas_studio_storage_bucket($root, 'mint-receipts');
file_put_contents("$dir/attempt-" . $n(77) . '.json', '{"version":2');
file_put_contents("$dir/attempt-" . $n(78) . '.json', json_encode(['version' => 2, 'nonce' => $n(79), 'state' => 'claimed', 'designDigest' => $digest, 'recipient' => $B, 'createdAt' => $t0 + 8000]));
studio_check($status($B, $limits(2), $t0 + 8001)['used'] === 1, 'unreadable and mismatched records are not counted');

// Other issuer limits: reported separately from the wallet's own share.
$root2 = studio_tmp_root();
$tight = ['perRecipient' => 3, 'perActor' => 2, 'perGroup' => 100, 'global' => 100, 'windowSeconds' => 86400];
foreach ([1, 2] as $i) atlas_studio_claim_attempt($root2, $n($i), $digest, studio_raw_key(), $tight, $t0 + $i, 'ip4:9.9.9.9');
$s = atlas_studio_quota_status($root2, $A, $tight, $t0 + 10, 'ip4:9.9.9.9', null);
studio_check($s['remaining'] === 3 && $s['otherLimit'] === 'quota-actor', 'the wallet has three left but this network is at its own limit: reported as such');
$s = atlas_studio_quota_status($root2, $A, $tight, $t0 + 10, 'ip4:8.8.8.8', null);
studio_check($s['remaining'] === 3 && $s['otherLimit'] === null, 'a different network is not affected');
$low = ['perRecipient' => 3, 'perActor' => 100, 'global' => 2, 'windowSeconds' => 86400];
$s = atlas_studio_quota_status($root2, $A, $low, $t0 + 10, 'ip4:8.8.8.8', null);
studio_check($s['otherLimit'] === 'quota-global', 'the all-visitors daily limit is reported when it is spent');
$grp = ['perRecipient' => 3, 'perActor' => 100, 'perGroup' => 2, 'global' => 100, 'windowSeconds' => 86400];
$root3 = studio_tmp_root();
foreach ([1, 2] as $i) atlas_studio_claim_attempt($root3, $n($i), $digest, studio_raw_key(), $grp, $t0 + $i, 'ip6:aaaa', 'ip6g:aaaa');
studio_check(atlas_studio_quota_status($root3, $A, $grp, $t0 + 10, 'ip6:bbbb', 'ip6g:aaaa')['otherLimit'] === 'quota-group', 'the network-range limit is reported');
$res = ['perRecipient' => 3, 'perActor' => 100, 'global' => 10, 'reserve' => 3, 'windowSeconds' => 86400];
$root4 = studio_tmp_root();
foreach (range(1, 7) as $i) atlas_studio_claim_attempt($root4, $n($i), $digest, studio_raw_key(), $res, $t0 + $i, 'ip4:5.5.5.' . $i);
studio_check(atlas_studio_quota_status($root4, $A, $res, $t0 + 10, 'ip4:5.5.5.1', null)['otherLimit'] === 'quota-reserved', 'an established network is held back once only the reserve is left');
studio_check(atlas_studio_quota_status($root4, $A, $res, $t0 + 10, 'ip4:7.7.7.7', null)['otherLimit'] === null, 'a first-time network may still use the reserve');

// Invalid keys never reach the ledger.
foreach (['', 'short', 'AAAA', null, 5] as $bad) {
  $threw = false;
  try { $status($bad, $limits(3), $t0); } catch (Throwable $e) { $threw = true; }
  studio_check($threw, 'a malformed key is refused: ' . json_encode($bad));
}

// ---- who may ask ----
$origin = 'https://a.test';
$cfg = ['origins' => [$origin], 'webauthnRpIds' => null, 'maxMintsPerRecipientPerDay' => 3, 'maxMintsPerActorPerDay' => 1000, 'maxMintsPerNetworkPerDay' => 1000, 'maxMintsPerDay' => 1000, 'newActorReserve' => 0];
$actor = ['key' => 'ip4:1.1.1.1', 'group' => null];
$yes = function () { return true; };
$no = function () { return false; };
$boom = function () { throw new Exception('x'); };
$mk = function ($key, $at, $over = []) use ($origin) {
  $payload = array_merge(atlas_studio_quota_sign_request($key, $at), $over);
  return ['signerRole' => 'raw-ecdsa', 'publicKey' => $key, 'signature' => 'x', 'signedPayload' => ['ctx' => 'atlas.bridge.sign/1', 'origin' => $over['__origin'] ?? $origin, 'payload' => array_diff_key($payload, ['__origin' => 1])]];
};
$now = $t0 + 8001;
[$code, $r] = atlas_studio_quota($root, $cfg, ['recipient' => $B, 'proof' => $mk($B, $now)], $actor, $yes, $now);
studio_check($code === 200 && $r['wallet']['used'] === 1 && $r['wallet']['remaining'] === 2 && $r['wallet']['limit'] === 3 && is_string($r['token']) && $r['now'] === $now, 'a signed request is answered, with a token');
studio_check(!array_key_exists('wallet', $r) || !isset($r['wallet']['otherLimit']), 'the wallet block carries only the wallet\'s own figures');
studio_check(strpos(json_encode($r), $A) === false && !preg_match('/attempt-|nonce|credential|recipient/i', json_encode($r)), 'no nonce, credential, key or other record detail is returned');
$token = $r['token'];

[$code, $r2] = atlas_studio_quota($root, $cfg, ['recipient' => $B, 'token' => $token], $actor, $no, $now + 60);
studio_check($code === 200 && $r2['wallet']['used'] === 1 && !isset($r2['token']), 'the token answers without a signature, and does not mint another token');
foreach ([
  ['another wallet\'s key with this token', ['recipient' => $A, 'token' => $token], $now + 60, 403, 'invalid-token'],
  ['an expired token', ['recipient' => $B, 'token' => $token], $now + ATLAS_STUDIO_QUOTA_TOKEN_TTL + 1, 403, 'invalid-token'],
  ['a tampered token', ['recipient' => $B, 'token' => substr($token, 0, -1) . (substr($token, -1) === '0' ? '1' : '0')], $now + 60, 403, 'invalid-token'],
  ['a token with a later expiry', ['recipient' => $B, 'token' => ($now + 5000) . '.' . substr($token, strpos($token, '.') + 1)], $now + 60, 403, 'invalid-token'],
  ['a token with a far-future expiry', ['recipient' => $B, 'token' => (string) ($now + 99999999) . '.' . str_repeat('a', 64)], $now + 60, 403, 'invalid-token'],
  ['a malformed token', ['recipient' => $B, 'token' => 'x'], $now, 403, 'invalid-token'],
  ['a non-string token', ['recipient' => $B, 'token' => 5], $now, 403, 'invalid-token'],
] as $c) {
  [$code, $r3] = atlas_studio_quota($root, $cfg, $c[1], $actor, $yes, $c[2]);
  studio_check($code === $c[3] && $r3['error'] === $c[4] && !isset($r3['wallet']), 'refused, no figures: ' . $c[0]);
}
studio_check(atlas_studio_quota($root, $cfg, ['recipient' => $B], $actor, $yes, $now)[0] === 400, 'neither a proof nor a token is refused');
studio_check(atlas_studio_quota($root, $cfg, ['recipient' => $B, 'token' => $token, 'proof' => $mk($B, $now)], $actor, $yes, $now)[0] === 400, 'both a proof and a token is refused');
studio_check(atlas_studio_quota($root, $cfg, ['recipient' => $B, 'extra' => 1, 'token' => $token], $actor, $yes, $now)[0] === 400, 'unknown fields are refused');
studio_check(atlas_studio_quota($root, $cfg, ['recipient' => 'nope', 'token' => $token], $actor, $yes, $now)[0] === 400, 'an invalid key is refused');
studio_check(atlas_studio_quota($root, $cfg, 'x', $actor, $yes, $now)[0] === 400, 'a non-object body is refused');

// A signed request must be exactly the read-only request, from an allowed origin, by the key asked about, and recent.
$bad = [
  ['signed by another key', ['recipient' => $B, 'proof' => $mk($A, $now) + []], 403],
  ['wrong purpose', ['recipient' => $B, 'proof' => $mk($B, $now, ['purpose' => 'atlas.studio.mint/1'])], 403],
  ['wrong summary', ['recipient' => $B, 'proof' => $mk($B, $now, ['summary' => 'Mint something'])], 403],
  ['a recipient inside the payload that differs', ['recipient' => $B, 'proof' => $mk($B, $now, ['recipient' => $A])], 403],
  ['another origin', ['recipient' => $B, 'proof' => $mk($B, $now, ['__origin' => 'https://evil.test'])], 403],
  ['too old', ['recipient' => $B, 'proof' => $mk($B, $now - ATLAS_STUDIO_QUOTA_PAST - 1)], 410],
  ['too far ahead', ['recipient' => $B, 'proof' => $mk($B, $now + ATLAS_STUDIO_QUOTA_FUTURE + 1)], 410],
  ['a string timestamp', ['recipient' => $B, 'proof' => $mk($B, $now, ['issuedAt' => (string) $now])], 403],
  ['an extra payload field', ['recipient' => $B, 'proof' => $mk($B, $now, ['mint' => true])], 403],
];
$wrongKey = $mk($B, $now); $wrongKey['publicKey'] = $A;
$bad[] = ['proof key differs from the key asked about', ['recipient' => $B, 'proof' => $wrongKey], 403];
$extraWrap = $mk($B, $now); $extraWrap['signedPayload']['extra'] = 1;
$bad[] = ['an extra wrapper field', ['recipient' => $B, 'proof' => $extraWrap], 403];
$noCtx = $mk($B, $now); $noCtx['signedPayload']['ctx'] = 'other';
$bad[] = ['another signing context', ['recipient' => $B, 'proof' => $noCtx], 403];
foreach ($bad as $c) {
  [$code, $r4] = atlas_studio_quota($root, $cfg, $c[1], $actor, $yes, $now);
  studio_check($code === $c[2] && !isset($r4['wallet']) && !isset($r4['token']), 'refused, no figures, no token: ' . $c[0] . ' (got ' . $code . ')');
}
foreach ([['a verifier that says no', $no], ['a verifier that throws', $boom], ['no verifier', null]] as $v) {
  [$code, $r5] = atlas_studio_quota($root, $cfg, ['recipient' => $B, 'proof' => $mk($B, $now)], $actor, $v[1], $now);
  studio_check($code === 403 && $r5['error'] === 'invalid-signature' && !isset($r5['wallet']), 'refused: ' . $v[0]);
}
$called = false;
$spy = function () use (&$called) { $called = true; return true; };
atlas_studio_quota($root, $cfg, ['recipient' => $B, 'proof' => $mk($A, $now)], $actor, $spy, $now);
studio_check($called === false, 'the signature verifier is not reached when the binding is wrong');
$webauthnNoFlags = $mk($B, $now); $webauthnNoFlags['signerRole'] = 'webauthn';
studio_check(atlas_studio_quota($root, $cfg, ['recipient' => $B, 'proof' => $webauthnNoFlags], $actor, $yes, $now)[0] === 403, 'a passkey proof for a raw key is refused');

// A token from one installation is not valid on another.
$otherRoot = studio_tmp_root();
studio_check(atlas_studio_quota($otherRoot, $cfg, ['recipient' => $B, 'token' => $token], $actor, $yes, $now + 60)[0] === 403, 'a token is not accepted by a different installation');

echo "ok: asset-studio-quota-status\n";
