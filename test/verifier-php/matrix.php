<?php
// Verdict matrix for verifier-php. Credentials are signed here with a throwaway issuer key and checked with an injected
// fetch function, so every published-document failure can be produced exactly. Prints PASS/FAIL lines; exit code 1 on any failure.
//   php test/verifier-php/matrix.php <path to a verifier-php directory>
// The signing helpers below are the test's own; they do not use the code under test.

$root = isset($argv[1]) ? rtrim($argv[1], '/') : dirname(__DIR__, 2) . '/verifier-php';
require $root . '/lib/atlas-verify.php';

use function DomainAtlas\Verify\load_trust_config;
use function DomainAtlas\Verify\verify_credential_json;

ini_set('serialize_precision', '17');
$failures = 0;
function check($name, $ok, $detail = '') {
  global $failures;
  if (!$ok) $failures++;
  echo ($ok ? 'PASS ' : 'FAIL ') . $name . (!$ok && $detail !== '' ? ' :: ' . $detail : '') . "\n";
}

// ---- independent signing helpers ----
function b64u($bin) { return rtrim(strtr(base64_encode($bin), '+/', '-_'), '='); }
function t_canon($v) {
  if (is_array($v)) {
    $isList = array_keys($v) === range(0, count($v) - 1) || count($v) === 0;
    if ($isList && !($v instanceof ArrayObject)) return '[' . implode(',', array_map('t_canon', $v)) . ']';
    ksort($v, SORT_STRING);
    $parts = [];
    foreach ($v as $k => $x) $parts[] = json_encode((string) $k) . ':' . t_canon($x);
    return '{' . implode(',', $parts) . '}';
  }
  if ($v instanceof stdClass) {
    $a = (array) $v;
    if (!$a) return '{}';
    ksort($a, SORT_STRING);
    $parts = [];
    foreach ($a as $k => $x) $parts[] = json_encode((string) $k) . ':' . t_canon($x);
    return '{' . implode(',', $parts) . '}';
  }
  return json_encode($v, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
}
function new_key() {
  $res = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
  $d = openssl_pkey_get_details($res);
  return ['res' => $res, 'pub' => b64u("\x04" . str_pad($d['ec']['x'], 32, "\0", STR_PAD_LEFT) . str_pad($d['ec']['y'], 32, "\0", STR_PAD_LEFT))];
}
function der_to_raw($der) {
  $pos = 2 + (ord($der[1]) & 0x80 ? (ord($der[1]) & 0x7f) : 0);
  $out = '';
  for ($i = 0; $i < 2; $i++) {
    $len = ord($der[$pos + 1]);
    $int = substr($der, $pos + 2, $len);
    $out .= str_pad(ltrim($int, "\0"), 32, "\0", STR_PAD_LEFT);
    $pos += 2 + $len;
  }
  return $out;
}
function sign_payload($key, $payload) {
  openssl_sign(t_canon($payload), $der, $key['res'], OPENSSL_ALGO_SHA256);
  return b64u(der_to_raw($der));
}
function make_credential($key, $domain, $over = []) {
  $payload = array_merge([
    'id' => 'urn:atlas:asset:' . bin2hex(random_bytes(8)),
    'asset' => ['name' => 'Test Badge', 'class' => 'atlas.badge', 'fungible' => false, 'properties' => ['a' => 'b']],
    'owner' => ['publicKey' => 'owner-key'],
    'quantity' => 1,
    'supersedes' => null,
    'issuedAt' => '2026-03-01T00:00:00.000Z',
  ], $over);
  $cred = $payload;
  $cred['credential'] = 'domain-atlas-asset/1.0';
  $cred['issuer'] = ['domain' => $domain, 'publicKey' => $key['pub']];
  $cred['signature'] = sign_payload($key, $payload);
  return $cred;
}

// ---- scenario machinery ----
$DOMAIN = 'issuer.example';
$ORIGIN = 'https://issuer.example';
$NOW = gmmktime(12, 0, 0, 6, 1, 2026);
$GLOBALS['fetched'] = [];

$key = new_key();
$keyDoc = ['keys' => [['publicKey' => $key['pub'], 'validFrom' => '2026-01-01T00:00:00Z', 'validUntil' => null]]];
$okDoc = function ($doc) { return ['status' => 200, 'body' => is_string($doc) ? $doc : json_encode($doc), 'error' => null, 'tooLarge' => false]; };
$statusDoc = function ($code) { return ['status' => $code, 'body' => '', 'error' => null, 'tooLarge' => false]; };

function run($cred, $docs, $trustOptions = [], $extra = []) {
  global $ORIGIN, $NOW;
  $trust = load_trust_config(['trustedIssuers' => [$ORIGIN => $trustOptions]]);
  if ($trust['errors']) { return ['status' => 'CONFIG', 'code' => implode(';', $trust['errors'])]; }
  $entry = array_values($trust['issuers'])[0];
  $fetch = function ($url, $max, $plain) use ($docs) {
    $GLOBALS['fetched'][] = $url;
    $name = basename($url);
    $d = isset($docs[$name]) ? $docs[$name] : null;
    if ($d instanceof Closure) return $d();
    if ($d === null) return ['status' => 404, 'body' => '', 'error' => null, 'tooLarge' => false];
    return $d;
  };
  $json = is_string($cred) ? $cred : json_encode($cred, JSON_UNESCAPED_SLASHES);
  $domainEntry = array_key_exists('trust', $extra) ? $extra['trust'] : $entry;
  return verify_credential_json($json, $domainEntry, ['fetch' => $fetch, 'now' => isset($extra['now']) ? $extra['now'] : $NOW]);
}
function expect($name, $res, $status, $code = null) {
  $ok = $res['status'] === $status && ($code === null || $res['code'] === $code) && ($res['valid'] === ($status === 'verified'));
  check($name, $ok, 'got ' . $res['status'] . '/' . $res['code']);
}

$emptyRev = ['revoked' => []];
$emptySus = ['suspended' => []];
$good = function () use ($okDoc, $keyDoc, $emptyRev, $emptySus) {
  return ['atlas-key.json' => $okDoc($keyDoc), 'atlas-revocations.json' => $okDoc($emptyRev), 'atlas-suspensions.json' => $okDoc($emptySus)];
};
$cred = make_credential($key, $DOMAIN);

// ---- baseline ----
$r = run($cred, $good());
expect('a genuine credential verifies', $r, 'verified', 'verified');
check('every check reports pass', count(array_unique(array_values($r['checks']))) === 1 && $r['checks']['signature'] === 'pass', json_encode($r['checks']));
expect('an empty object inside the signed asset survives (signed with {} )', run(make_credential($key, $DOMAIN, ['asset' => (object) ['name' => 'x', 'meta' => new stdClass(), 'list' => []]]), $good()), 'verified');
expect('key order in the wire JSON does not matter', run(json_encode(array_reverse($cred, true)), $good()), 'verified');
expect('a fungible quantity verifies', run(make_credential($key, $DOMAIN, ['quantity' => 250, 'asset' => ['name' => 'Gold', 'class' => 'x.gold', 'fungible' => true]]), $good()), 'verified');
expect('a superseding credential verifies', run(make_credential($key, $DOMAIN, ['supersedes' => ['urn:atlas:asset:old']]), $good()), 'verified');
expect('unsigned extra fields do not change the verdict', run(array_merge($cred, ['note' => 'x']), $good()), 'verified');

// ---- the three documents: every way of being unreadable fails closed ----
$unreadable = [
  'HTTP 404' => $statusDoc(404), 'HTTP 500' => $statusDoc(500), 'HTTP 503' => $statusDoc(503), 'HTTP 403' => $statusDoc(403), 'HTTP 301' => $statusDoc(301),
  'no response (status 0)' => ['status' => 0, 'body' => '', 'error' => 'timeout', 'tooLarge' => false],
  'fetch throws' => function () { throw new RuntimeException('network down'); },
  'not JSON' => $okDoc('<html>oops</html>'),
  'JSON list, not an object' => $okDoc('[]'),
  'JSON null' => $okDoc('null'),
  'empty body' => $okDoc(''),
  'over the size cap' => ['status' => 200, 'body' => '', 'error' => null, 'tooLarge' => true],
  'fetch returns garbage' => function () { return 'nope'; },
];
foreach (['atlas-key.json' => 'key-document', 'atlas-revocations.json' => 'revocation', 'atlas-suspensions.json' => 'suspension'] as $file => $prefix) {
  foreach ($unreadable as $label => $doc) {
    $docs = $good();
    $docs[$file] = $doc;
    $res = run($cred, $docs);
    $expectedCode = $prefix === 'key-document' ? 'key-document-unavailable' : $prefix . '-unavailable';
    $isParseProblem = in_array($label, ['not JSON', 'JSON list, not an object', 'JSON null', 'empty body'], true);
    $okCode = $res['code'] === $expectedCode || ($prefix === 'key-document' && $res['code'] === 'key-document-unreadable');
    check("$file $label -> unavailable, never verified", $res['status'] === 'unavailable' && $res['valid'] === false && $okCode, 'got ' . $res['status'] . '/' . $res['code']);
  }
}

// unreadable shapes inside otherwise valid JSON
$shapes = [
  'atlas-key.json' => ['{}', '{"keys":[]}', '{"keys":"x"}', '{"keys":[1]}'],
  'atlas-revocations.json' => ['{}', '{"revoked":"x"}', '{"revoked":[1]}', '{"revoked":[{"reason":"no id"}]}', '{"revoked":[{"id":""}]}', '{"revoked":[{"id":5}]}'],
  'atlas-suspensions.json' => ['{}', '{"suspended":"x"}', '{"suspended":[1]}', '{"suspended":[{"reason":"no id"}]}', '{"suspended":[{"id":"u","expiresAt":"garbage"}]}', '{"suspended":[{"id":"u","onExpire":"explode"}]}'],
];
foreach ($shapes as $file => $bodies) {
  foreach ($bodies as $body) {
    $docs = $good();
    $docs[$file] = $okDoc($body);
    $res = run($cred, $docs);
    check("$file unreadable shape $body -> unavailable", $res['status'] === 'unavailable' && !$res['valid'], 'got ' . $res['status'] . '/' . $res['code']);
  }
}
// a malformed entry for ANOTHER credential still makes the whole list unreadable
$docs = $good();
$docs['atlas-suspensions.json'] = $okDoc(['suspended' => [['id' => 'someone-else', 'onExpire' => 'explode']]]);
expect('a bad entry for a different credential still fails closed', run($cred, $docs), 'unavailable', 'suspension-unavailable');

// the suspensions=optional relaxation is limited to HTTP 404 on that one document
$docs = $good(); unset($docs['atlas-suspensions.json']);
expect('suspensions required: 404 -> unavailable', run($cred, $docs), 'unavailable', 'suspension-unavailable');
expect('suspensions optional: 404 -> verified', run($cred, $docs, ['suspensions' => 'optional']), 'verified');
foreach (['HTTP 500', 'HTTP 403', 'not JSON', 'no response (status 0)', 'over the size cap'] as $label) {
  $d = $good(); $d['atlas-suspensions.json'] = $unreadable[$label];
  expect("suspensions optional: $label still -> unavailable", run($cred, $d, ['suspensions' => 'optional']), 'unavailable', 'suspension-unavailable');
}
$d = $good(); unset($d['atlas-revocations.json']);
expect('suspensions optional never relaxes the revocation list', run($cred, $d, ['suspensions' => 'optional']), 'unavailable', 'revocation-unavailable');
$d = $good(); unset($d['atlas-key.json']);
expect('suspensions optional never relaxes the key document', run($cred, $d, ['suspensions' => 'optional']), 'unavailable', 'key-document-unavailable');
$cfg = load_trust_config(['trustedIssuers' => [$ORIGIN => ['suspensions' => 'sometimes']]]);
check('an invalid suspensions setting is a configuration error', count($cfg['errors']) === 1 && count($cfg['issuers']) === 0);

// ---- revocation and suspension verdicts ----
$d = $good(); $d['atlas-revocations.json'] = $okDoc(['revoked' => [['id' => 'urn:other', 'revokedAt' => '2026-04-01T00:00:00Z', 'reason' => 'x'], ['id' => $cred['id'], 'revokedAt' => '2026-04-02T00:00:00Z', 'reason' => 'spent']]]);
expect('a listed credential is revoked', run($cred, $d), 'revoked', 'revoked');
$d = $good(); $d['atlas-revocations.json'] = $okDoc(['revoked' => [['id' => 'urn:other']]]);
expect('another credential being revoked does not matter', run($cred, $d), 'verified');
$d = $good(); $d['atlas-revocations.json'] = $okDoc(['revoked' => [['id' => $cred['id'], 'reason' => str_repeat("\u{e9}", 5000)]]]);
$res = run($cred, $d);
check('a long revocation reason is clipped to 200 characters, on a character boundary', $res['status'] === 'revoked' && strlen($res['reason']) < 600 && json_encode($res) !== false && substr_count($res['reason'], "\u{e9}") === 200, strlen($res['reason']));
$susp = function ($entries) use ($good, $okDoc) { $d = $good(); $d['atlas-suspensions.json'] = $okDoc(['suspended' => $entries]); return $d; };
expect('indefinitely suspended', run($cred, $susp([['id' => $cred['id'], 'reason' => 'r', 'expiresAt' => null, 'onExpire' => 'lift']])), 'suspended', 'suspended');
expect('suspended with a future deadline', run($cred, $susp([['id' => $cred['id'], 'reason' => 'r', 'expiresAt' => '2026-07-01T00:00:00Z', 'onExpire' => 'lift']])), 'suspended', 'suspended');
expect('a lifted suspension (deadline passed, lift) verifies', run($cred, $susp([['id' => $cred['id'], 'reason' => 'r', 'expiresAt' => '2026-05-01T00:00:00Z', 'onExpire' => 'lift']])), 'verified');
expect('a finalized suspension (deadline passed, finalize) is revoked', run($cred, $susp([['id' => $cred['id'], 'reason' => 'redeemed', 'expiresAt' => '2026-05-01T00:00:00Z', 'onExpire' => 'finalize']])), 'revoked', 'suspension-finalized');
expect('onExpire defaults to lift', run($cred, $susp([['id' => $cred['id'], 'expiresAt' => '2026-05-01T00:00:00Z']])), 'verified');
expect('a finalize deadline still in the future is only a suspension', run($cred, $susp([['id' => $cred['id'], 'expiresAt' => '2026-07-01T00:00:00Z', 'onExpire' => 'finalize']])), 'suspended', 'suspended');
expect('another credential being suspended does not matter', run($cred, $susp([['id' => 'urn:other', 'expiresAt' => null]])), 'verified');

// precedence: a definite negative beats an unreadable document, which beats a pass
$d = $susp([['id' => $cred['id'], 'expiresAt' => null]]); unset($d['atlas-revocations.json']);
expect('suspended outranks an unreadable revocation list', run($cred, $d), 'suspended');
$d = $good(); $d['atlas-revocations.json'] = $okDoc(['revoked' => [['id' => $cred['id']]]]); unset($d['atlas-suspensions.json']);
expect('revoked outranks an unreadable suspension list', run($cred, $d), 'revoked');
$expiring = make_credential($key, $DOMAIN, ['asset' => ['name' => 'T', 'class' => 'x.t', 'expiresAt' => '2026-05-01T00:00:00Z']]);
$d = $good(); unset($d['atlas-revocations.json']);
expect('expired outranks an unreadable revocation list', run($expiring, $d), 'expired');

// ---- expiry ----
expect('a signed expiresAt in the past -> expired', run($expiring, $good()), 'expired', 'expired');
expect('a signed expiresAt in the future verifies', run(make_credential($key, $DOMAIN, ['asset' => ['name' => 'T', 'class' => 'x.t', 'expiresAt' => '2026-07-01T00:00:00Z']]), $good()), 'verified');
expect('expiry is judged at the injected time', run($expiring, $good(), [], ['now' => gmmktime(0, 0, 0, 4, 1, 2026)]), 'verified');
foreach (['soon', 12345, true, ''] as $bad) {
  expect('an unparseable expiresAt (' . json_encode($bad) . ') is malformed, not ignored', run(make_credential($key, $DOMAIN, ['asset' => ['name' => 'T', 'expiresAt' => $bad]]), $good()), 'invalid', 'malformed-credential');
}
expect('an explicit null expiresAt means no expiry', run(make_credential($key, $DOMAIN, ['asset' => ['name' => 'T', 'expiresAt' => null]]), $good()), 'verified');

// ---- trust ----
expect('no trusted issuer configured for the credential -> untrusted', run($cred, $good(), [], ['trust' => null]), 'untrusted-issuer', 'issuer-not-configured');
expect('a credential naming another issuer is refused', run(make_credential($key, 'other.example'), $good()), 'untrusted-issuer', 'issuer-mismatch');
expect('issuer domain comparison ignores case', run(make_credential($key, 'ISSUER.example'), $good()), 'verified');
expect('a lookalike domain is refused', run(make_credential($key, 'issuer.example.evil.test'), $good()), 'untrusted-issuer', 'issuer-mismatch');
expect('a pinned key that matches verifies', run($cred, $good(), ['pinnedKeys' => [$key['pub']]]), 'verified');
$other = new_key();
expect('a pinned key that differs is refused', run($cred, $good(), ['pinnedKeys' => [$other['pub']]]), 'untrusted-issuer', 'key-not-pinned');
$cfg = load_trust_config(['trustedIssuers' => [$ORIGIN => ['pinnedKeys' => ['not-a-key']]]]);
check('a malformed pinned key is a configuration error', count($cfg['errors']) === 1);
foreach (['issuer.example', 'http://issuer.example', 'https://issuer.example/path', 'https://issuer.example?x=1', 'https://user@issuer.example', '', 'ftp://issuer.example', 'https://issuer.example#f'] as $badOrigin) {
  $cfg = load_trust_config(['trustedIssuers' => [$badOrigin]]);
  check('origin ' . json_encode($badOrigin) . ' is rejected by the configuration', count($cfg['errors']) >= 1 && count($cfg['issuers']) === 0);
}
$cfg = load_trust_config(['trustedIssuers' => ['http://localhost:8080']]);
check('plain-http localhost is refused unless allowInsecureLoopback', count($cfg['errors']) === 1);
$cfg = load_trust_config(['trustedIssuers' => ['http://localhost:8080'], 'allowInsecureLoopback' => true]);
check('plain-http localhost is allowed with allowInsecureLoopback', count($cfg['errors']) === 0 && count($cfg['issuers']) === 1);
$cfg = load_trust_config(['trustedIssuers' => ['http://issuer.example'], 'allowInsecureLoopback' => true]);
check('allowInsecureLoopback does not allow plain http to other hosts', count($cfg['errors']) === 1);
check('an empty trustedIssuers list is a configuration error', count(load_trust_config(['trustedIssuers' => []])['errors']) === 1 && count(load_trust_config([])['errors']) === 1);
$cfg = load_trust_config(['trustedIssuers' => ['https://issuer.example', 'https://ISSUER.example']]);
check('listing an issuer twice is a configuration error', count($cfg['errors']) === 1);

// ---- keys ----
$retired = new_key();
$d = $good(); $d['atlas-key.json'] = $okDoc(['keys' => [
  ['publicKey' => $key['pub'], 'validFrom' => '2026-01-01T00:00:00Z', 'validUntil' => null],
  ['publicKey' => $retired['pub'], 'validFrom' => '2025-01-01T00:00:00Z', 'validUntil' => '2026-02-01T00:00:00Z'],
]]);
expect('concurrent published keys: the credential key is found', run($cred, $d), 'verified');
expect('a credential signed by a retired key before it retired verifies', run(make_credential($retired, $DOMAIN, ['issuedAt' => '2026-01-15T00:00:00.000Z']), $d), 'verified');
expect('a credential signed by a key after it retired is refused', run(make_credential($retired, $DOMAIN, ['issuedAt' => '2026-03-01T00:00:00.000Z']), $d), 'invalid', 'key-not-valid-at-issuance');
expect('a credential signed before the key was valid is refused', run(make_credential($key, $DOMAIN, ['issuedAt' => '2025-12-31T00:00:00.000Z']), $good()), 'invalid', 'key-not-valid-at-issuance');
expect('a key the issuer never published is refused', run(make_credential($other, $DOMAIN), $good()), 'invalid', 'key-not-published');
$d = $good(); $d['atlas-key.json'] = $okDoc(['keys' => [['publicKey' => $key['pub'], 'validFrom' => 'garbage', 'validUntil' => null]]]);
expect('a key entry with an unparseable validFrom never validates', run($cred, $d), 'invalid', 'key-not-valid-at-issuance');
$d = $good(); $d['atlas-key.json'] = $okDoc(['keys' => [['publicKey' => $key['pub'], 'validFrom' => '2026-01-01T00:00:00Z', 'validUntil' => 'garbage']]]);
expect('a key entry with an unparseable validUntil never validates', run($cred, $d), 'invalid', 'key-not-valid-at-issuance');
// the credential names a key that the issuer does publish, but the signature is by another key
$forged = make_credential($other, $DOMAIN); $forged['issuer']['publicKey'] = $key['pub'];
expect('a credential naming the published key but signed by another is refused', run($forged, $good()), 'invalid', 'bad-signature');

// ---- tampering with signed fields ----
$tamper = [
  'id' => function ($c) { $c['id'] .= 'x'; return $c; },
  'owner' => function ($c) { $c['owner']['publicKey'] = 'thief'; return $c; },
  'quantity' => function ($c) { $c['quantity'] = 2; return $c; },
  'asset name' => function ($c) { $c['asset']['name'] = 'Better Badge'; return $c; },
  'asset property' => function ($c) { $c['asset']['properties']['a'] = 'c'; return $c; },
  'asset added field' => function ($c) { $c['asset']['extra'] = 1; return $c; },
  'asset removed field' => function ($c) { unset($c['asset']['fungible']); return $c; },
  'supersedes' => function ($c) { $c['supersedes'] = ['urn:x']; return $c; },
  'issuedAt' => function ($c) { $c['issuedAt'] = '2026-03-02T00:00:00.000Z'; return $c; },
];
foreach ($tamper as $label => $fn) {
  expect("tampered $label -> bad-signature", run($fn($cred), $good()), 'invalid', 'bad-signature');
}
$sigBytes = base64_decode(strtr($cred['signature'], '-_', '+/') . '==');
$flip = $sigBytes; $flip[10] = chr(ord($flip[10]) ^ 1);
$c2 = $cred; $c2['signature'] = b64u($flip);
expect('one flipped signature bit -> bad-signature', run($c2, $good()), 'invalid', 'bad-signature');
foreach (['short' => b64u(substr($sigBytes, 0, 63)), 'long' => b64u($sigBytes . "\0"), 'padded' => $cred['signature'] . '==', 'standard alphabet' => strtr($cred['signature'], '-_', '+/'), 'empty' => '', 'not a string' => 12, 'null' => null] as $label => $sig) {
  $c3 = $cred; $c3['signature'] = $sig;
  $res = run($c3, $good());
  check("signature $label is refused", $res['status'] === 'invalid' && !$res['valid'], 'got ' . $res['status'] . '/' . $res['code']);
}
// high-S twin of a valid signature is a different encoding of the same point; the issuer never emits it, but it must still verify or fail consistently
$nBytes = hex2bin('FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
$sBytes = substr($sigBytes, 32, 32);
$highS = ''; $borrow = 0;
for ($i = 31; $i >= 0; $i--) { $v = ord($nBytes[$i]) - ord($sBytes[$i]) - $borrow; $borrow = $v < 0 ? 1 : 0; $highS = chr($v & 0xff) . $highS; }
$high = b64u(substr($sigBytes, 0, 32) . $highS);
$c4 = $cred; $c4['signature'] = $high;
$res = run($c4, $good());
check('a high-S signature gets a definite verdict (verified or bad-signature)', in_array($res['code'], ['verified', 'bad-signature'], true), $res['code']);

// ---- malformed credentials ----
$mal = [
  'missing credential type' => function ($c) { unset($c['credential']); return $c; },
  'missing id' => function ($c) { unset($c['id']); return $c; },
  'empty id' => function ($c) { $c['id'] = ''; return $c; },
  'numeric id' => function ($c) { $c['id'] = 7; return $c; },
  'missing asset' => function ($c) { unset($c['asset']); return $c; },
  'asset is a list' => function ($c) { $c['asset'] = [1]; return $c; },
  'asset is a string' => function ($c) { $c['asset'] = 'x'; return $c; },
  'missing owner' => function ($c) { unset($c['owner']); return $c; },
  'owner key not a string' => function ($c) { $c['owner']['publicKey'] = 5; return $c; },
  'quantity zero' => function ($c) { $c['quantity'] = 0; return $c; },
  'quantity negative' => function ($c) { $c['quantity'] = -1; return $c; },
  'quantity fractional' => function ($c) { $c['quantity'] = 1.5; return $c; },
  'quantity as string' => function ($c) { $c['quantity'] = '1'; return $c; },
  'quantity above 2^53' => function ($c) { $c['quantity'] = 9007199254740993; return $c; },
  'missing supersedes' => function ($c) { unset($c['supersedes']); return $c; },
  'missing issuedAt' => function ($c) { unset($c['issuedAt']); return $c; },
  'issuedAt not RFC 3339' => function ($c) { $c['issuedAt'] = 'yesterday'; return $c; },
  'issuedAt date only' => function ($c) { $c['issuedAt'] = '2026-03-01'; return $c; },
  'issuedAt impossible date' => function ($c) { $c['issuedAt'] = '2026-02-30T00:00:00Z'; return $c; },
  'missing issuer' => function ($c) { unset($c['issuer']); return $c; },
  'issuer is a string' => function ($c) { $c['issuer'] = 'issuer.example'; return $c; },
  'issuer key too short' => function ($c) { $c['issuer']['publicKey'] = substr($c['issuer']['publicKey'], 0, 40); return $c; },
  'issuer key compressed point' => function ($c) { $c['issuer']['publicKey'] = b64u("\x02" . str_repeat("\1", 32)); return $c; },
  'issuer key not on curve' => function ($c) { $c['issuer']['publicKey'] = b64u("\x04" . str_repeat("\1", 64)); return $c; },
  'missing signature' => function ($c) { unset($c['signature']); return $c; },
];
foreach ($mal as $label => $fn) {
  $res = run($fn($cred), $good());
  check("malformed: $label -> invalid, never verified", in_array($res['status'], ['invalid', 'unsupported', 'untrusted-issuer'], true) && !$res['valid'], 'got ' . $res['status'] . '/' . $res['code']);
}
foreach (['not json' => 'nope', 'json list' => '[]', 'json string' => '"x"', 'json null' => 'null', 'number' => '5', 'empty' => ''] as $label => $text) {
  $res = run($text, $good());
  check("non-object input ($label) -> invalid", $res['status'] === 'invalid' && !$res['valid'], 'got ' . $res['status']);
}
$res = run(str_repeat('a', 300000), $good());
check('an oversize credential is refused before parsing', $res['status'] === 'invalid' && $res['code'] === 'malformed-credential');
$deep = '{"a":' . str_repeat('[', 100) . str_repeat(']', 100) . '}';
$res = run($deep, $good());
check('excessively nested JSON is refused', $res['status'] === 'invalid' && !$res['valid']);
$c5 = $cred; $c5['credential'] = 'domain-atlas-attestation/1.0';
expect('another credential type is unsupported, not verified', run($c5, $good()), 'unsupported', 'unsupported-credential-type');
$c5['credential'] = 'domain-atlas-asset/2.0';
expect('a future asset version is unsupported', run($c5, $good()), 'unsupported', 'unsupported-credential-type');

// ---- every request stays inside the trusted origin ----
$allowed = [];
foreach (['atlas-key.json', 'atlas-revocations.json', 'atlas-suspensions.json'] as $n_) $allowed[$ORIGIN . '/.well-known/' . $n_] = true;
$stray = array_values(array_filter(array_unique($GLOBALS['fetched']), function ($u) use ($allowed) { return !isset($allowed[$u]); }));
check('across ' . count($GLOBALS['fetched']) . ' fetches, only the three documents of the trusted origin were requested', count($stray) === 0 && count($GLOBALS['fetched']) > 100, json_encode($stray));
$hostile = make_credential($key, $DOMAIN, ['asset' => ['name' => 'x', 'model' => 'https://tracker.invalid/pixel', 'thumbnail' => 'http://169.254.169.254/latest/']]);
$GLOBALS['fetched'] = [];
run($hostile, $good());
check('URLs inside a credential are never fetched', count(array_diff($GLOBALS['fetched'], array_keys($allowed))) === 0);

check('serialize_precision is restored after every check', ini_get('serialize_precision') === '17');

echo "\n" . ($failures === 0 ? 'matrix: all checks passed' : "matrix: $failures check(s) failed") . "\n";
exit($failures === 0 ? 0 : 1);
