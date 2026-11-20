<?php
declare(strict_types=1);
// Reproduction: invalid signatures that claim a key on the roster are counted but never turned away by the failure limit. The limit is read
// only on the path of a key that is not on the roster (operator_signed), so a client that sends bad signatures under a known operator key
// is not rate-limited, and each one costs a signature check, a row in operator_failures and an audit line.
// What must keep holding: a request with a valid signature from a roster key gets through from the same client, however many bad ones it sent.
//
//   php test/chain-labs-audit-operator-throttle.php
require __DIR__ . '/../chain-labs/lib/operator.php';

$failures = 0;
$total = 0;
function t(bool $ok, string $text, mixed $detail = null): void
{
    global $failures, $total;
    $total++;
    if (!$ok) $failures++;
    echo ($ok ? 'PASS ' : 'FAIL ') . $text . (!$ok && $detail !== null ? ' :: ' . substr(is_string($detail) ? $detail : json_encode($detail), 0, 300) : '') . "\n";
}
function refused(callable $fn): string
{
    try { $fn(); } catch (OperatorError $e) { return $e->reason; } catch (Throwable $e) { return get_class($e) . ': ' . $e->getMessage(); }
    return 'accepted';
}
$HOST = 'a.example';
$NOW = 1800000000;
$private = sys_get_temp_dir() . '/chainlabs-operator-test-' . bin2hex(random_bytes(4));
mkdir($private, 0700);
register_shutdown_function(static function () use ($private) { foreach (glob($private . '/*') ?: [] as $f) @unlink($f); @rmdir($private); });
$_SERVER['REMOTE_ADDR'] = '203.0.113.9';

$root = ledger_new_owner_key();      // may take every action
$studio = ledger_new_owner_key();    // may open and preview
$treasury = ledger_new_owner_key();  // may grant
$stranger = ledger_new_owner_key();
$token = bin2hex(random_bytes(32));
function roster(array $over = []): void
{
    global $private, $HOST, $root, $studio, $treasury, $token;
    $doc = array_merge(['domain' => $HOST, 'legacyTokenSha256' => hash('sha256', $token), 'keys' => [
        ['publicKey' => $root['key'], 'label' => 'root'],
        ['publicKey' => $studio['key'], 'label' => 'studio', 'actions' => ['spend34/open', 'coin26/preview', 'coin26/create']],
        ['publicKey' => $treasury['key'], 'label' => 'treasury', 'actions' => ['spend34/grant']],
    ]], $over);
    foreach ($doc as $k => $v) if ($v === null) unset($doc[$k]);
    file_put_contents($private . '/chainlabs-operators.json', json_encode($doc));
    chmod($private . '/chainlabs-operators.json', 0600);
}
roster();
$n = 0;
function signed(array $who, string $action, array $request, int $now, array $over = [], ?array $authOver = null): array
{
    global $HOST, $n;
    $life = operator_sensitive($action) ? 60 : 120;
    $auth = array_merge(['action' => $action, 'domain' => $HOST, 'method' => 'POST', 'issuedAt' => operator_iso($now), 'expiresAt' => operator_iso($now + $life), 'nonce' => 'nonce-' . (++$n) . '-' . bin2hex(random_bytes(8))], $authOver ?? []);
    $payload = array_merge(['type' => 'atlas.chainlabs.operator', 'v' => 1, 'adminAuth' => $auth, 'request' => $request], $over);
    $text = $payload;
    if ($text['request'] === []) $text['request'] = new stdClass();
    openssl_sign(ledger_canonical($text), $der, $who['private'], OPENSSL_ALGO_SHA256);
    $offset = 2; $raw = '';
    for ($i = 0; $i < 2; $i++) { $len = ord($der[$offset + 1]); $raw .= str_pad(ltrim(substr($der, $offset + 2, $len), "\x00"), 32, "\x00", STR_PAD_LEFT); $offset += 2 + $len; }
    return ['payload' => $payload, 'proof' => ['signerRole' => 'raw-ecdsa', 'publicKey' => $who['key'], 'signature' => ledger_b64u_encode($raw)]];
}
function authorize(string $action, array $body, int $now, string $method = 'POST', string $host = 'a.example'): array
{
    global $private;
    return operator_authorize($private, $host, $action, $method, $body, $now);
}

function failures_of(string $client): int
{
    global $private;
    return (int) operator_db($private)->query("SELECT COUNT(*) FROM operator_failures WHERE client = '" . $client . "'")->fetchColumn();
}

echo "== bad signatures under a key on the roster\n";
$_SERVER['REMOTE_ADDR'] = '203.0.113.88';
$client = operator_client();
$T = $NOW + 20000;
$codes = [];
for ($i = 0; $i < OPERATOR_FAIL_LIMIT + 40; $i++) {
    $req = signed($stranger, 'spend34/integrity', [], $T);
    $req['proof']['publicKey'] = $root['key'];
    $codes[] = refused(fn() => authorize('spend34/integrity', $req, $T));
}
t($codes[0] === 'bad-signature', 'a signature made by another key under the root key is refused as a bad signature', $codes[0]);
t(in_array('rate-limited', array_slice($codes, OPERATOR_FAIL_LIMIT), true), 'after ten of them the client is turned away with rate-limited, as for a key that is not on the roster', array_count_values($codes));
t(failures_of($client) <= OPERATOR_FAIL_LIMIT + 5, 'and the failures kept for the client do not grow with every further request', failures_of($client));

echo "\n== requests refused before the roster is looked at (no known key needed)\n";
$_SERVER['REMOTE_ADDR'] = '203.0.113.90';
$codes2 = [];
for ($i = 0; $i < OPERATOR_FAIL_LIMIT + 20; $i++) {
    $req = signed($stranger, 'spend34/integrity', [], $T);
    $codes2[] = refused(fn() => authorize('spend34/grant', $req, $T));
}
t($codes2[0] === 'wrong-action' && in_array('rate-limited', array_slice($codes2, OPERATOR_FAIL_LIMIT), true), 'a client that keeps sending requests for the wrong action, or malformed ones, is rate-limited too', array_count_values($codes2));

echo "\n== what must keep holding\n";
$good = authorize('spend34/integrity', signed($root, 'spend34/integrity', [], $T), $T);
t(($good['via'] ?? '') === 'signed', 'a request with a valid signature from a key on the roster still gets through from the same client');
$_SERVER['REMOTE_ADDR'] = '203.0.113.89';
$other = signed($stranger, 'spend34/integrity', [], $T);
$other['proof']['publicKey'] = $root['key'];
t(refused(fn() => authorize('spend34/integrity', $other, $T)) === 'bad-signature', 'another client is not limited by the first client\'s failures');
$_SERVER['REMOTE_ADDR'] = '203.0.113.88';
t(refused(fn() => authorize('spend34/integrity', ['adminToken' => 'x'], $T)) === 'rate-limited', 'a token from the limited client is turned away (unchanged)');
t(refused(fn() => authorize('spend34/integrity', signed($stranger, 'spend34/integrity', [], $T + 301), $T + 301)) === 'not-operator', 'and the count is for five minutes (unchanged)');

echo "\n" . ($failures === 0 ? 'ALL ' . $total . ' CHAIN-LABS OPERATOR THROTTLE CHECKS PASSED' : $failures . ' of ' . $total . ' checks FAILED') . "\n";
exit($failures === 0 ? 0 : 1);
