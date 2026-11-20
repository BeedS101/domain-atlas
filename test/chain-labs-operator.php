<?php
declare(strict_types=1);
// Operator authorization of the chain labs (chain-labs/lib/operator.php), with explicit clocks:
//   - a signed request is bound to its action, domain, method, arguments, time and nonce
//   - the roster: key scopes, revoked and unlisted keys, a roster that is not valid
//   - the nonce is recorded before the action, a repeat is answered from the record, a duplicate of an action is not repeated
//   - the audit table is a hash chain and holds no secret
//   - the token: accepted until 1 March 2027 00:00 UTC and not after, whatever is configured; never once signed requests are activated
//
//   php test/chain-labs-operator.php
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

echo "== a signed request\n";
$recipient = ledger_new_owner_key()['key'];
$req = ['coinId' => str_repeat('a', 32), 'to' => $recipient, 'amount' => '500'];
$ok = authorize('spend34/grant', signed($root, 'spend34/grant', $req, $NOW), $NOW);
t(($ok['via'] ?? '') === 'signed' && $ok['args'] === $req, 'the arguments come from the signed request', $ok);
t(refused(fn() => authorize('spend34/grant', signed($root, 'spend34/grant', $req, $NOW), $NOW, 'GET')) === 'bad-request', 'a request that is not a POST is refused');
$tweak = signed($root, 'spend34/grant', $req, $NOW);
$tweak['payload']['request']['amount'] = '5000';
t(refused(fn() => authorize('spend34/grant', $tweak, $NOW)) === 'bad-signature', 'an argument changed after signing is refused');
$tweak = signed($root, 'spend34/grant', $req, $NOW);
$tweak['payload']['request']['extra'] = 'x';
t(refused(fn() => authorize('spend34/grant', $tweak, $NOW)) === 'bad-signature', 'an argument added after signing is refused');
t(refused(fn() => authorize('spend34/accept-rollback', signed($root, 'spend34/grant', $req, $NOW), $NOW)) === 'wrong-action', 'a signature for one action is not taken for another');
t(refused(fn() => authorize('spend34/grant', signed($root, 'spend34/grant', $req, $NOW, [], ['domain' => 'b.example']), $NOW)) === 'wrong-domain', 'a signature for another domain is refused');
t(refused(fn() => authorize('spend34/grant', signed($root, 'spend34/grant', $req, $NOW), $NOW, 'POST', 'evil.example')) === 'wrong-domain', 'the host a request arrives under is not taken as the domain');
t(refused(fn() => authorize('spend34/grant', signed($root, 'spend34/grant', $req, $NOW, [], ['domain' => 'evil.example']), $NOW, 'POST', 'evil.example')) === 'wrong-domain', 'even when the request was signed for that host');
t(refused(fn() => authorize('spend34/grant', signed($root, 'spend34/grant', $req, $NOW, [], ['method' => 'GET']), $NOW)) === 'bad-request', 'a signature for another method is refused');
t(refused(fn() => authorize('spend34/grant', signed($root, 'spend34/grant', $req, $NOW, ['v' => 2]), $NOW)) === 'bad-request', 'a payload of another version is refused');
$extra = signed($root, 'spend34/grant', $req, $NOW);
$extra['payload']['unsigned'] = 1;
t(refused(fn() => authorize('spend34/grant', $extra, $NOW)) === 'bad-request', 'a payload with a field it does not define is refused');
$_SERVER['REMOTE_ADDR'] = '203.0.113.50';
$forged = signed($root, 'spend34/grant', $req, $NOW);
$forged['proof']['publicKey'] = $stranger['key'];
t(refused(fn() => authorize('spend34/grant', $forged, $NOW)) === 'not-operator', 'a key that is not on the roster is refused');
$_SERVER['REMOTE_ADDR'] = '203.0.113.9';
$empty = authorize('operator/check', signed($root, 'operator/check', [], $NOW), $NOW);
t(($empty['via'] ?? '') === 'signed' && $empty['args'] === [], 'a request with no arguments is signed and read as an empty object');

echo "\n== time\n";
t(refused(fn() => authorize('spend34/grant', signed($root, 'spend34/grant', $req, $NOW - 61), $NOW)) === 'expired-request', 'a sensitive request is refused 61 seconds after it was issued');
t(refused(fn() => authorize('spend34/grant', signed($root, 'spend34/grant', $req, $NOW), $NOW + 60)) === 'expired-request', 'and at the second it expires');
$near = authorize('spend34/grant', signed($root, 'spend34/grant', ['coinId' => str_repeat('b', 32), 'to' => $recipient, 'amount' => '1'], $NOW), $NOW + 59);
t(($near['via'] ?? '') === 'signed', 'one second before it expires it is accepted');
t(refused(fn() => authorize('spend34/grant', signed($root, 'spend34/grant', $req, $NOW + 40), $NOW)) === 'expired-request', 'a request dated more than the allowed skew ahead is refused');
t(refused(fn() => authorize('spend34/grant', signed($root, 'spend34/grant', $req, $NOW, [], ['expiresAt' => operator_iso($NOW + 61)]), $NOW)) === 'bad-lifetime', 'a sensitive request may not live longer than 60 seconds');
t(refused(fn() => authorize('spend34/integrity', signed($root, 'spend34/integrity', [], $NOW, [], ['expiresAt' => operator_iso($NOW + 121)]), $NOW)) === 'bad-lifetime', 'another may not live longer than 120');
t(refused(fn() => authorize('spend34/integrity', signed($root, 'spend34/integrity', [], $NOW, [], ['expiresAt' => operator_iso($NOW)]), $NOW)) === 'bad-lifetime', 'and none may expire when it is issued');
t(refused(fn() => authorize('spend34/integrity', signed($root, 'spend34/integrity', [], $NOW, [], ['issuedAt' => '2027-01-01 00:00:00']), $NOW)) === 'bad-request', 'a time that is not in the fixed form is refused');

echo "\n== the nonce is recorded before the action, and a repeat is not carried out again\n";
$first = signed($root, 'spend34/integrity', ['coinId' => str_repeat('c', 32)], $NOW);
$a1 = authorize('spend34/integrity', $first, $NOW);
t(($a1['via'] ?? '') === 'signed', 'a request is accepted');
t(refused(fn() => authorize('spend34/integrity', $first, $NOW)) === 'in-progress', 'the same request, before its outcome is recorded, is not carried out again and says so');
operator_finish($private, $a1, 200, ['ok' => true, 'verdict' => 'fine'], $NOW);
$again = authorize('spend34/integrity', $first, $NOW + 5);
t(isset($again['replay']) && $again['replay']['status'] === 200 && $again['replay']['body']['verdict'] === 'fine', 'once recorded, the same request is answered from the record');
$other = signed($root, 'spend34/integrity', ['coinId' => str_repeat('d', 32)], $NOW, [], ['nonce' => $first['payload']['adminAuth']['nonce']]);
t(refused(fn() => authorize('spend34/integrity', $other, $NOW)) === 'replayed-request', 'the same nonce on a different request is refused');
$grant = signed($root, 'spend34/grant', ['coinId' => str_repeat('e', 32), 'to' => $recipient, 'amount' => '7'], $NOW);
$g1 = authorize('spend34/grant', $grant, $NOW);
operator_finish($private, $g1, 201, ['ok' => true], $NOW);
t(refused(fn() => authorize('spend34/grant', signed($root, 'spend34/grant', ['coinId' => str_repeat('e', 32), 'to' => $recipient, 'amount' => '7'], $NOW + 10), $NOW + 10)) === 'duplicate-request', 'the same action signed again with a new nonce is not carried out a second time');
$rep = authorize('spend34/grant', signed($root, 'spend34/grant', ['coinId' => str_repeat('e', 32), 'to' => $recipient, 'amount' => '7'], $NOW + 10, [], ['repeat' => true]), $NOW + 10);
t(($rep['via'] ?? '') === 'signed', 'unless it is signed to be repeated');
$later = authorize('spend34/grant', signed($root, 'spend34/grant', ['coinId' => str_repeat('e', 32), 'to' => $recipient, 'amount' => '7'], $NOW + 400), $NOW + 400);
t(($later['via'] ?? '') === 'signed', 'or until the window for it has passed');

echo "\n== the roster and what a key may do\n";
t(refused(fn() => authorize('spend34/grant', signed($studio, 'spend34/grant', $req, $NOW + 1000), $NOW + 1000)) === 'action-not-permitted', 'a key may not take an action that is not in its list');
$sOpen = authorize('spend34/open', signed($studio, 'spend34/open', ['coinId' => str_repeat('1', 32)], $NOW + 1000), $NOW + 1000);
t(($sOpen['via'] ?? '') === 'signed', 'but takes those that are');
t(refused(fn() => authorize('spend34/grant', signed($treasury, 'spend34/open', ['coinId' => str_repeat('1', 32)], $NOW + 1000), $NOW + 1000)) === 'wrong-action', 'a treasury key signing another action for the grant route is refused');
foreach (array_keys(OPERATOR_ACTIONS) as $action) {
    if ($action === 'spend34/grant' || $action === 'operator/check') continue;
    $r = refused(fn() => authorize($action, signed($treasury, $action, [], $NOW + 2000), $NOW + 2000));
    if ($r !== 'action-not-permitted') t(false, 'a treasury key may not take ' . $action, $r);
}
t(true, 'a key with a list takes no action outside it');
t(($c = authorize('operator/check', signed($treasury, 'operator/check', [], $NOW + 2000), $NOW + 2000))['via'] === 'signed', 'every active key may prove itself with operator/check');
roster(['keys' => [['publicKey' => $root['key'], 'revoked' => true], ['publicKey' => $studio['key']]]]);
t(refused(fn() => authorize('spend34/integrity', signed($root, 'spend34/integrity', [], $NOW + 3000), $NOW + 3000)) === 'not-operator', 'a revoked key is refused at once');
t(($x = authorize('spend34/grant', signed($studio, 'spend34/grant', $req, $NOW + 3000), $NOW + 3000))['via'] === 'signed', 'a key whose actions list is absent may take every action');
roster(['keys' => [['publicKey' => $studio['key'], 'actions' => 'spend34/grant']]]);
t(refused(fn() => authorize('spend34/grant', signed($studio, 'spend34/grant', $req, $NOW + 4000), $NOW + 4000)) === 'action-not-permitted', 'an actions value that is not a list gives the key no action');
roster(['keys' => [['publicKey' => $studio['key'], 'actions' => ['spend34/nothing']]]]);
t(refused(fn() => authorize('spend34/grant', signed($studio, 'spend34/grant', $req, $NOW + 4000), $NOW + 4000)) === 'action-not-permitted', 'and neither does one that names an action there is not');
roster(['keys' => [['publicKey' => $studio['key']], ['publicKey' => $studio['key']]]]);
t(refused(fn() => authorize('spend34/integrity', signed($studio, 'spend34/integrity', [], $NOW + 5000), $NOW + 5000)) === 'operator-roster-invalid', 'a key listed twice makes the roster invalid');
roster(['domain' => 'b.example']);
t(refused(fn() => authorize('spend34/integrity', signed($root, 'spend34/integrity', [], $NOW + 5000), $NOW + 5000)) === 'wrong-domain', 'a roster written for another domain is not used');
roster();
chmod($private . '/chainlabs-operators.json', 0666);
t(refused(fn() => authorize('spend34/integrity', signed($root, 'spend34/integrity', [], $NOW + 5000), $NOW + 5000)) === 'operator-roster-unsafe', 'a roster anyone can write is not used');
chmod($private . '/chainlabs-operators.json', 0600);
unlink($private . '/chainlabs-operators.json');
t(refused(fn() => authorize('spend34/integrity', signed($root, 'spend34/integrity', [], $NOW + 5000), $NOW + 5000)) === 'operator-not-configured', 'no roster means no operator action');
roster();

echo "\n== failures are counted, and do not shut out a key on the roster\n";
$_SERVER['REMOTE_ADDR'] = '203.0.113.77';
$T = $NOW + 10000;
for ($i = 0; $i < OPERATOR_FAIL_LIMIT; $i++) refused(fn() => authorize('spend34/integrity', signed($stranger, 'spend34/integrity', [], $T), $T));
$e = null;
try { authorize('spend34/integrity', signed($stranger, 'spend34/integrity', [], $T), $T); } catch (OperatorError $x) { $e = $x; }
t($e !== null && $e->reason === 'rate-limited' && $e->status === 429 && ($e->extra['retryAfter'] ?? 0) > 0, 'after ten failures a client that is not on the roster is turned away with a time to wait');
t((authorize('spend34/integrity', signed($root, 'spend34/integrity', [], $T), $T)['via'] ?? '') === 'signed', 'a key on the roster still gets through from the same client');
t(refused(fn() => authorize('spend34/integrity', ['adminToken' => $token], $T)) === 'rate-limited', 'and a token is turned away');
t(refused(fn() => authorize('spend34/integrity', signed($stranger, 'spend34/integrity', [], $T + 301), $T + 301)) === 'not-operator', 'the count is for five minutes');

echo "\n== the audit table\n";
$db = operator_db($private);
$chain = operator_audit_verify($db);
t($chain['ok'] === true && $chain['lines'] > 20, 'the audit table is a chain that checks', $chain);
$dump = json_encode($db->query('SELECT * FROM operator_audit')->fetchAll(PDO::FETCH_ASSOC));
t(!str_contains($dump, $token) && !str_contains($dump, $root['key']) && !str_contains($dump, $studio['key']) && !str_contains($dump, 'signerRole') && !str_contains($dump, 'BEGIN') && str_contains($dump, substr($recipient, 0, 20)), 'it holds no token, no operator key and no signature, and names the recipient and amount of a grant');
t(str_contains($dump, '"event":"accepted"') && str_contains($dump, '"event":"outcome"') && str_contains($dump, '"event":"refused"') && str_contains($dump, '"event":"replay"'), 'it holds accepted, finished, refused and repeated requests');
$db->exec("UPDATE operator_audit SET status = 999 WHERE id = (SELECT MIN(id) + 3 FROM operator_audit)");
t(operator_audit_verify($db)['ok'] === false, 'a changed line is found');
$db->exec("UPDATE operator_audit SET status = NULL WHERE id = (SELECT MIN(id) + 3 FROM operator_audit)");
$db->exec('DELETE FROM operator_audit WHERE id = (SELECT MIN(id) + 5 FROM operator_audit)');
t(operator_audit_verify($db)['ok'] === false, 'and so is a line taken out');

echo "\n== the token, until 1 March 2027 and never after\n";
$private2 = sys_get_temp_dir() . '/chainlabs-operator-test2-' . bin2hex(random_bytes(4));
mkdir($private2, 0700);
register_shutdown_function(static function () use ($private2) { foreach (glob($private2 . '/*') ?: [] as $f) @unlink($f); @rmdir($private2); });
file_put_contents($private2 . '/chainlabs-operators.json', json_encode(['domain' => $HOST, 'legacyTokenSha256' => hash('sha256', $token), 'keys' => [['publicKey' => $root['key']]]]));
$until = OPERATOR_LEGACY_UNTIL;
t($until === gmmktime(0, 0, 0, 3, 1, 2027), 'the end is 1 March 2027 00:00 UTC');
$legacy = fn(string $action, int $now, ?string $t = null) => operator_authorize($private2, $HOST, $action, 'POST', ['adminToken' => $t ?? $token, 'coinId' => str_repeat('a', 32)], $now);
$l = $legacy('spend34/grant', $until - 1);
t($l['via'] === 'legacy' && $l['args'] === ['coinId' => str_repeat('a', 32)], 'the token is accepted one second before, and is not part of the arguments');
t(refused(fn() => $legacy('spend34/grant', $until)) === 'legacy-ended' && refused(fn() => $legacy('spend34/integrity', $until)) === 'legacy-ended', 'and refused from that second, for every action');
t(refused(fn() => $legacy('spend34/integrity', $until + 86400 * 365 * 5)) === 'legacy-ended', 'whatever the date after it');
t(refused(fn() => $legacy('spend34/integrity', $until - 100, str_repeat('0', 64))) === 'bad-token', 'a wrong token is refused');
t(refused(fn() => $legacy('spend34/integrity', $until - 100, 'short')) === 'bad-token', 'so is one that is not 64 hex characters');
$audit2 = operator_db($private2)->query('SELECT COUNT(*) FROM operator_audit WHERE event = \'legacy\'')->fetchColumn();
t((int) $audit2 === 1, 'a use of the token is written to the audit table');
file_put_contents($private2 . '/chainlabs-operators.json', json_encode(['domain' => $HOST, 'keys' => [['publicKey' => $root['key']]]]));
t(refused(fn() => $legacy('spend34/integrity', $until - 100)) === 'legacy-disabled', 'a roster with no token hash accepts no token');
file_put_contents($private2 . '/chainlabs-operators.json', json_encode(['domain' => $HOST, 'legacyTokenSha256' => hash('sha256', 'unused'), 'legacyUntil' => '2099-01-01', 'keys' => [['publicKey' => $root['key']]]]));
t(refused(fn() => $legacy('spend34/integrity', $until + 1)) === 'legacy-ended', 'no setting in the roster moves the end');

echo "\n== activation: verified keys only, and no way back for a token\n";
file_put_contents($private2 . '/chainlabs-operators.json', json_encode(['domain' => $HOST, 'legacyTokenSha256' => hash('sha256', $token), 'keys' => [
    ['publicKey' => $root['key'], 'label' => 'root'], ['publicKey' => $treasury['key'], 'label' => 'treasury', 'actions' => ['spend34/grant']]]]));
$T2 = $NOW + 50000;
$act = fn(array $who, int $now) => operator_authorize($private2, $HOST, 'operator/activate', 'POST', signed($who, 'operator/activate', ['confirm' => 'activate-signed-operator'], $now), $now);
$notReady = null;
try { $a = $act($root, $T2); operator_activate($private2, $HOST, $a, $a['args'], $T2); } catch (OperatorError $e) { $notReady = $e; operator_finish($private2, $a, $e->status, ['ok' => false, 'code' => $e->reason], $T2); }
t($notReady !== null && $notReady->reason === 'activation-not-ready', 'a key that has not been verified cannot activate', $notReady ? $notReady->reason : 'activated');
t(!operator_ratchet_active($private2), 'and nothing is switched');
$c1 = operator_authorize($private2, $HOST, 'operator/check', 'POST', signed($root, 'operator/check', [], $T2 + 1), $T2 + 1);
$body = operator_check($private2, $HOST, $c1, $T2 + 1);
t($body['verified'] === true && $body['ratchet'] === false && $body['key']['actions'] === 'all', 'operator/check verifies a key and reports what it may do', $body);
$notReady = null;
try { $a = $act($root, $T2 + 2); operator_activate($private2, $HOST, $a, $a['args'], $T2 + 2); } catch (OperatorError $e) { $notReady = $e; }
t($notReady === null && operator_ratchet_active($private2), 'a verified key that covers every action activates');
t(refused(fn() => $legacy('spend34/grant', $T2 + 3)) === 'signature-required' && refused(fn() => $legacy('coin26/create', $T2 + 3)) === 'signature-required', 'afterwards a token is refused for an action that changes something');
t($legacy('spend34/integrity', $T2 + 3)['via'] === 'legacy' && $legacy('coin26/preview', $T2 + 3)['via'] === 'legacy', 'and still read for the ones that only look, until the end');
file_put_contents($private2 . '/chainlabs-operators.json', json_encode(['domain' => $HOST, 'legacyTokenSha256' => hash('sha256', $token), 'legacyUntil' => '2099-01-01', 'activated' => false, 'keys' => [['publicKey' => $root['key']]]]));
t(refused(fn() => $legacy('spend34/grant', $T2 + 4)) === 'signature-required', 'no setting in the roster brings the token back for them');

$private3 = sys_get_temp_dir() . '/chainlabs-operator-test3-' . bin2hex(random_bytes(4));
mkdir($private3, 0700);
register_shutdown_function(static function () use ($private3) { foreach (glob($private3 . '/*') ?: [] as $f) @unlink($f); @rmdir($private3); });
$activator = ledger_new_owner_key();
file_put_contents($private3 . '/chainlabs-operators.json', json_encode(['domain' => $HOST, 'keys' => [
    ['publicKey' => $activator['key'], 'actions' => ['operator/activate']], ['publicKey' => $treasury['key'], 'actions' => ['spend34/grant']], ['publicKey' => $root['key']]]]));
foreach ([$activator, $treasury] as $who) { $c = operator_authorize($private3, $HOST, 'operator/check', 'POST', signed($who, 'operator/check', [], $T2), $T2); operator_check($private3, $HOST, $c, $T2); }
$a = operator_authorize($private3, $HOST, 'operator/activate', 'POST', signed($activator, 'operator/activate', ['confirm' => 'activate-signed-operator'], $T2 + 1), $T2 + 1);
$e = null;
try { operator_activate($private3, $HOST, $a, $a['args'], $T2 + 1); } catch (OperatorError $x) { $e = $x; }
t($e !== null && $e->reason === 'activation-not-ready' && in_array('spend34/accept-rollback', $e->extra['missing'] ?? [], true) && !in_array('spend34/grant', $e->extra['missing'] ?? [], true), 'activation waits until a verified key may take every action that changes something', $e ? $e->extra : null);
t(!operator_ratchet_active($private3), 'and until then nothing is switched');
$e = null;
$a = operator_authorize($private3, $HOST, 'operator/activate', 'POST', signed($activator, 'operator/activate', ['confirm' => 'yes'], $T2 + 2), $T2 + 2);
try { operator_activate($private3, $HOST, $a, $a['args'], $T2 + 2); } catch (OperatorError $x) { $e = $x; }
t($e !== null && $e->reason === 'bad-request', 'activation needs its confirmation text');
t(refused(fn() => operator_authorize($private3, $HOST, 'operator/activate', 'POST', signed($treasury, 'operator/activate', ['confirm' => 'activate-signed-operator'], $T2 + 3), $T2 + 3)) === 'action-not-permitted', 'a key without the activation action cannot activate');
$ratchetFile = operator_paths($private2)['ratchet'];
t(is_file($ratchetFile) && (fileperms($ratchetFile) & 0077) === 0, 'the activation is a file in the private folder that only its owner can read');

echo "\n" . ($failures === 0 ? 'ALL ' . $total . ' CHAIN-LABS OPERATOR CHECKS PASSED' : $failures . ' of ' . $total . ' checks FAILED') . "\n";
exit($failures === 0 ? 0 : 1);
