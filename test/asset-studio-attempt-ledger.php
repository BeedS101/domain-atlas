<?php
// Attempt ledger and challenge store with injected time: quota windows, retries that are not double
// counted, and records that fail closed.
require_once __DIR__ . '/studio-test-lib.php';
require_once __DIR__ . '/../issuer-php/atlas/studio/inc/challenges.php';
require_once __DIR__ . '/../issuer-php/atlas/studio/inc/mint-attempts.php';
$root = studio_tmp_root();
$t0 = time(); // file mtimes are real, so injected times stay near the present
$limits = ['perRecipient' => 2, 'perActor' => 100, 'global' => 3, 'windowSeconds' => 86400];
$digest = str_repeat('d', 64);
$A = studio_raw_key(); $B = studio_raw_key(); $C = studio_raw_key();
$n = function ($i) { return str_pad(dechex($i), 64, '0', STR_PAD_LEFT); };

// Attempts
$r = atlas_studio_claim_attempt($root, $n(1), $digest, $A, $limits, $t0);
studio_check($r['ok'] && !$r['existing'] && $r['state'] === 'claimed', 'first claim');
$r = atlas_studio_claim_attempt($root, $n(1), $digest, $A, $limits, $t0 + 5);
studio_check($r['ok'] && $r['existing'], 'same nonce is a retry');
studio_check(!atlas_studio_claim_attempt($root, $n(1), str_repeat('e', 64), $A, $limits, $t0)['ok'], 'same nonce, other design refused');
studio_check(!atlas_studio_claim_attempt($root, $n(1), $digest, $B, $limits, $t0)['ok'], 'same nonce, other recipient refused');
studio_check(atlas_studio_claim_attempt($root, $n(2), $digest, $A, $limits, $t0 + 10)['ok'], 'second claim for A');
$r = atlas_studio_claim_attempt($root, $n(3), $digest, $A, $limits, $t0 + 20);
studio_check(!$r['ok'] && $r['error'] === 'quota-recipient', 'per-recipient quota');
studio_check(atlas_studio_claim_attempt($root, $n(1), $digest, $A, $limits, $t0 + 30)['ok'], 'retry still works at quota');
studio_check(atlas_studio_claim_attempt($root, $n(4), $digest, $B, $limits, $t0 + 40)['ok'], 'other recipient unaffected');
$r = atlas_studio_claim_attempt($root, $n(5), $digest, $C, $limits, $t0 + 50);
studio_check(!$r['ok'] && $r['error'] === 'quota-global', 'global quota');
$r = atlas_studio_claim_attempt($root, $n(5), $digest, $C, $limits, $t0 + 86400 + 1);
studio_check($r['ok'], 'quota recovers after the window (the oldest attempts age out)');

// Minted marking
studio_check(atlas_studio_mark_attempt_minted($root, $n(1), 'urn:atlas:asset:x'), 'mark minted');
studio_check(atlas_studio_mark_attempt_minted($root, $n(1), 'urn:atlas:asset:x'), 'marking is idempotent');
studio_check(!atlas_studio_mark_attempt_minted($root, $n(1), 'urn:atlas:asset:y'), 'a different credential id is refused');
studio_check(!atlas_studio_mark_attempt_minted($root, $n(99), 'urn:atlas:asset:x'), 'unknown attempt');
$r = atlas_studio_claim_attempt($root, $n(1), $digest, $A, $limits, $t0 + 90000);
studio_check($r['ok'] && $r['state'] === 'minted' && $r['credentialId'] === 'urn:atlas:asset:x', 'minted state reported on retry');

// Corrupt or oversized records fail closed.
$dir = atlas_studio_storage_bucket($root, 'mint-receipts');
file_put_contents("$dir/attempt-" . $n(7) . '.json', '{"version":2');
$r = atlas_studio_claim_attempt($root, $n(7), $digest, $A, ['perRecipient' => 50, 'perActor' => 50, 'global' => 50, 'windowSeconds' => 86400], $t0 + 90000);
studio_check(!$r['ok'] && $r['error'] === 'attempt-unreadable', 'truncated record fails closed');
file_put_contents("$dir/attempt-" . $n(8) . '.json', str_repeat('x', 9000));
$r = atlas_studio_claim_attempt($root, $n(8), $digest, $A, ['perRecipient' => 50, 'perActor' => 50, 'global' => 50, 'windowSeconds' => 86400], $t0 + 90000);
studio_check(!$r['ok'], 'oversized record fails closed');
foreach (['', 'zz', str_repeat('A', 64), 5, null, "../x"] as $bad) {
  $threw = false;
  try { atlas_studio_claim_attempt($root, $bad, $digest, $A, $limits, $t0); } catch (InvalidArgumentException $e) { $threw = true; }
  studio_check($threw, 'bad nonce rejected: ' . json_encode($bad));
}
foreach (['short', null, 5] as $bad) {
  $threw = false;
  try { atlas_studio_claim_attempt($root, $n(50), $digest, $bad, $limits, $t0); } catch (InvalidArgumentException $e) { $threw = true; }
  studio_check($threw, 'bad recipient rejected');
}

// Challenges
$c = atlas_studio_new_challenge($root, $digest, $A, $t0, 3);
studio_check(preg_match('/^[a-f0-9]{64}$/', $c['nonce']) === 1 && $c['expiresAt'] === $t0 + ATLAS_STUDIO_CHALLENGE_TTL, 'challenge issued with the fixed TTL');
$rec = atlas_studio_read_challenge($root, $c['nonce']);
studio_check($rec['state'] === 'issued' && $rec['designDigest'] === $digest && $rec['recipient'] === $A, 'challenge stored');
studio_check(atlas_studio_transition_challenge($root, $c['nonce'], 'issued', 'completed', $digest, $A), 'issued -> completed');
studio_check(!atlas_studio_transition_challenge($root, $c['nonce'], 'issued', 'completed', $digest, $A), 'not twice');
studio_check(atlas_studio_read_challenge($root, $c['nonce'])['state'] === 'completed', 'state persisted');
$d2 = atlas_studio_new_challenge($root, $digest, $A, $t0, 3);
studio_check(!atlas_studio_transition_challenge($root, $d2['nonce'], 'issued', 'completed', str_repeat('f', 64), $A), 'transition needs the same design');
studio_check(!atlas_studio_transition_challenge($root, $d2['nonce'], 'issued', 'completed', $digest, $B), 'transition needs the same recipient');
atlas_studio_new_challenge($root, $digest, $A, $t0, 3);
atlas_studio_new_challenge($root, $digest, $A, $t0, 3); // $c is completed, so three are live now
$threw = false;
try { atlas_studio_new_challenge($root, $digest, $A, $t0, 3); } catch (RuntimeException $e) { $threw = $e->getMessage() === 'too-many-challenges'; }
studio_check($threw, 'outstanding challenge cap counts live challenges only');
// An expired challenge stops counting at once.
$tmp = atlas_studio_storage_bucket($root, 'tmp');
$exp = atlas_studio_new_challenge($root, $digest, $A, $t0 - 1000, 99);
studio_check(is_array(atlas_studio_new_challenge($root, $digest, $A, $t0 + ATLAS_STUDIO_CHALLENGE_TTL + 1, 99)), 'creation after expiry works');
// Old challenges are pruned, which frees the cap.
foreach (glob("$tmp/mint-challenge-*.json") as $f) touch($f, $t0 - 1000);
studio_check(is_array(atlas_studio_new_challenge($root, $digest, $A, $t0 + ATLAS_STUDIO_CHALLENGE_RETAIN_SECONDS + 10, 3)), 'old challenges pruned');
studio_check(count(glob("$tmp/mint-challenge-*.json")) === 1, 'only the new challenge remains');
// Hostile challenge files.
$bad = str_repeat('c', 64);
file_put_contents("$tmp/mint-challenge-$bad.json", '{"nonce":"' . $bad . '"');
studio_check(atlas_studio_read_challenge($root, $bad) === null, 'truncated challenge unreadable');
file_put_contents("$tmp/mint-challenge-$bad.json", json_encode(['nonce' => str_repeat('d', 64), 'state' => 'issued', 'designDigest' => $digest, 'recipient' => $A, 'expiresAt' => 1]));
studio_check(atlas_studio_read_challenge($root, $bad) === null, 'challenge whose nonce differs from its file name is refused');
studio_check(atlas_studio_read_challenge($root, '../x') === null && atlas_studio_read_challenge($root, null) === null, 'bad nonce reads nothing');
echo "Asset Studio attempt ledger and challenge store tests passed\n";
