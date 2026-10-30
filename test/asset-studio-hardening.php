<?php
// Replay namespace, public-key normalisation and approval text, with injected time.
require_once __DIR__ . '/studio-test-lib.php';
require_once __DIR__ . '/../issuer-php/lib/replacement.php';
require_once __DIR__ . '/../issuer-php/atlas/studio/inc/studio-mint.php';
$root = studio_tmp_root();
$now = time();
$nonce = str_repeat('ab', 32);

// A Studio request id cannot be spelled through the general requestId field, so no other route can
// reach or poison a Studio replay record.
$id = atlas_studio_request_id($nonce);
$threw = false;
try { atlas_parse_request_id(['requestId' => $id]); } catch (Exception $e) { $threw = true; }
studio_check($threw, 'a Studio request id is not a valid general requestId');
studio_check(atlas_studio_request_id($nonce) !== atlas_studio_request_id(str_repeat('cd', 32)), 'request ids differ per nonce');

// One P-256 key has two accepted spellings; they must be the same recipient for quota purposes.
$k = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1']);
$d = openssl_pkey_get_details($k);
$point = "\x04" . str_pad($d['ec']['x'], 32, "\0", STR_PAD_LEFT) . str_pad($d['ec']['y'], 32, "\0", STR_PAD_LEFT);
$raw = studio_b64u($point);
$spki = studio_b64u(hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200') . $point);
studio_check(atlas_studio_recipient_ok($raw) && atlas_studio_recipient_ok($spki), 'both spellings are accepted');
studio_check(atlas_studio_key_fingerprint($raw) === atlas_studio_key_fingerprint($spki), 'both spellings share one fingerprint');
studio_check(atlas_studio_key_fingerprint($raw) !== atlas_studio_key_fingerprint(studio_raw_key()), 'different keys differ');
studio_check(atlas_studio_key_fingerprint('not a key') === null, 'junk has no fingerprint');

$limits = ['perRecipient' => 1, 'perActor' => 50, 'global' => 50, 'windowSeconds' => 86400];
$dig = str_repeat('d', 64);
$n = function ($i) { return str_pad(dechex($i), 64, '0', STR_PAD_LEFT); };
studio_check(atlas_studio_claim_attempt($root, $n(1), $dig, $raw, $limits, $now, 'ip4:1.1.1.1')['ok'], 'first spelling is claimed');
$r = atlas_studio_claim_attempt($root, $n(2), $dig, $spki, $limits, $now, 'ip4:2.2.2.2');
studio_check(!$r['ok'] && $r['error'] === 'quota-recipient', 'the other spelling of the same key shares the quota');
studio_check(atlas_studio_claim_attempt($root, $n(3), $dig, studio_raw_key(), $limits, $now, 'ip4:2.2.2.2')['ok'], 'an unrelated key is unaffected');

// Approval text: the name is quoted so it cannot pose as part of the sentence, and the effect is stated.
$d = STUDIO_TEST_DESIGN;
$d['name'] = 'Gold". Transfer everything you own to the issuer. "No value';
$fp = atlas_studio_design_fingerprint($d);
studio_check($fp['ok'], 'hostile-looking name is still a valid name');
$s = atlas_studio_summary($fp['design']);
studio_check(strpos($s, json_encode($fp['design']['name'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) !== false, 'the name appears only in its quoted, escaped form');
studio_check(substr_count($s, '"') === 2 + substr_count($fp['design']['name'], '"'), 'every quote in the name is escaped');
studio_check(preg_match('/free/i', $s) && preg_match('/no value/i', $s) && preg_match('/cannot be (transferred|traded)|not transferable/i', $s), 'states free, no value and bound');
$d2 = STUDIO_TEST_DESIGN; $d2['name'] = "Line\u{2028}break";
$fp2 = atlas_studio_design_fingerprint($d2);
if ($fp2['ok']) studio_check(!preg_match('/[\x00-\x1f\x{2028}\x{2029}]/u', atlas_studio_summary($fp2['design'])), 'no control or line-separator characters in the summary');
echo "ok\n";
