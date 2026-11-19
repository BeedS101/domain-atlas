<?php
declare(strict_types=1);
// An owner's signed transfer is bound to the coin it moves: the authority domain, the genesis digest and a real point in
// that coin's log. What this covers:
//   - a transfer signed for one coin is refused by a ledger that has the same coin id under another authority or genesis
//   - a transfer in the older form (no authority, no genesis) is refused when it is new, with its own reason
//   - baseHead must be a hash of this coin's log, no earlier than the sender's last transfer, but need not be the newest
//   - entries written in the older form before the change still verify as history, until the first bound entry
//   - the treasury's own grants and sales are signed in the bound form
//
//   php test/chain-labs-binding.php
require __DIR__ . '/../chain-labs/lib/ledger.php';

$failures = 0;
$total = 0;
function t(bool $ok, string $text, mixed $detail = null): void
{
    global $failures, $total;
    $total++;
    if (!$ok) $failures++;
    echo ($ok ? 'PASS ' : 'FAIL ') . $text . (!$ok && $detail !== null ? ' :: ' . substr(is_string($detail) ? $detail : json_encode($detail), 0, 300) : '') . "\n";
}
function refuses(callable $fn, string $reason): bool
{
    try { $fn(); } catch (LedgerError $e) { return $e->reason === $reason; } catch (Throwable $e) { return false; }
    return false;
}
function why(callable $fn): string
{
    try { $fn(); } catch (LedgerError $e) { return $e->reason . ': ' . $e->getMessage(); } catch (Throwable $e) { return get_class($e) . ': ' . $e->getMessage(); }
    return 'no error';
}

function ec_pair(): array
{
    $key = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
    openssl_pkey_export($key, $private);
    $d = openssl_pkey_get_details($key);
    return ['priv' => $private, 'pub' => $d['key'], 'x' => $d['ec']['x'], 'y' => $d['ec']['y']];
}
function owner(): array
{
    $p = ec_pair();
    return ['key' => ledger_b64u_encode("\x04" . str_pad($p['x'], 32, "\x00", STR_PAD_LEFT) . str_pad($p['y'], 32, "\x00", STR_PAD_LEFT)), 'priv' => $p['priv']];
}
function der_to_raw(string $der): string
{
    $offset = 2;
    $parts = [];
    for ($i = 0; $i < 2; $i++) {
        $len = ord($der[$offset + 1]);
        $parts[] = str_pad(ltrim(substr($der, $offset + 2, $len), "\x00"), 32, "\x00", STR_PAD_LEFT);
        $offset += 2 + $len;
    }
    return $parts[0] . $parts[1];
}
function owner_sign(array $owner, array $payload): string
{
    openssl_sign(ledger_canonical($payload), $der, openssl_pkey_get_private($owner['priv']), OPENSSL_ALGO_SHA256);
    return ledger_b64u_encode(der_to_raw($der));
}

$NOW = 1800000000;
// A single authority coin. $coinId and $name let a second ledger carry the same coin id under another authority.
function world(string $domain, ?string $coinId = null, string $initial = '1000000', ?array $treasury = null): array
{
    global $NOW;
    $file = tempnam(sys_get_temp_dir(), 'ledger-binding-') . '.sqlite';
    $db = ledger_open($file);
    $dom = ['domain' => $domain, 'priv' => ec_pair()['priv']];
    $dom['pub'] = openssl_pkey_get_details(openssl_pkey_get_private($dom['priv']))['key'];
    $treasury ??= owner();
    $genesis = ledger_genesis(['coinId' => $coinId, 'symbol' => 'TST', 'name' => 'Test coin', 'decimals' => 2, 'maxUnits' => '2000000', 'initialUnits' => $initial, 'treasuryKey' => $treasury['key'],
        'mode' => 'single', 'visibility' => 'public', 'roster' => [['domain' => $domain, 'key' => $dom['pub']]], 'createdAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 3600)]);
    ledger_register($db, $genesis, $treasury['key'], null);
    ledger_add_genesis_signature($db, $genesis['coinId'], $domain, ledger_genesis_sign($genesis, $dom['priv']));
    ledger_activate($db, $genesis['coinId'], $dom['priv']);
    return ['db' => $db, 'coin' => $genesis['coinId'], 'genesis' => $genesis, 'digest' => ledger_genesis_digest($genesis), 'dom' => $dom, 'treasury' => $treasury];
}
function seq_of(array $w, array $from): int
{
    $row = ledger_account_row($w['db'], $w['coin'], $from['key']);
    return $row ? (int) $row['seq'] : 0;
}
// The bound form, or the older one ($legacy), signed by $from.
function authorization(array $w, array $from, string $to, string $amount, array $over = [], bool $legacy = false): array
{
    global $NOW;
    $payload = ['type' => 'atlas.ledger.transfer', 'v' => $legacy ? 1 : 2, 'coinId' => $w['coin'], 'from' => $from['key'], 'to' => $to, 'amount' => $amount, 'baseSeq' => seq_of($w, $from),
        'baseHead' => ledger_head($w['db'], $w['coin'])['hash'], 'nonce' => bin2hex(random_bytes(16)), 'issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 10), 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 300)];
    if (!$legacy) $payload += ['authority' => $w['genesis']['authority'], 'genesis' => $w['digest']];
    $payload = array_merge($payload, $over);
    return ['payload' => $payload, 'signature' => owner_sign($from, $payload)];
}
function commit(array $w, array $prepared): array
{
    global $NOW;
    return ledger_commit($w['db'], $w['coin'], $prepared, ledger_sign($w['dom']['priv'], $prepared['hash']), [], $NOW);
}
function send(array $w, array $from, string $to, string $amount, array $over = []): array
{
    global $NOW;
    return commit($w, ledger_prepare_transfer($w['db'], $w['coin'], authorization($w, $from, $to, $amount, $over), $NOW));
}
function grant(array $w, string $to, string $amount): array
{
    global $NOW;
    return commit($w, ledger_grant($w['db'], $w['coin'], ['key' => $w['treasury']['key'], 'private' => $w['treasury']['priv']], $to, $amount, $NOW));
}
// An entry in the older form, as a ledger before the change would have written it and a mirror would receive it.
function legacy_record(array $w, array $from, string $to, string $amount): array
{
    global $NOW;
    $auth = authorization($w, $from, $to, $amount, [], true);
    $head = ledger_head($w['db'], $w['coin']);
    $public = ['type' => 'transfer', 'coinId' => $w['coin'], 'index' => $head['index'] + 1, 'prevHash' => $head['hash'], 'executedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW), 'amount' => $amount, 'from' => $from['key'], 'to' => $to];
    $hash = ledger_digest($public);
    return ['index' => $public['index'], 'public' => $public, 'private' => ['hash' => $hash, 'from' => $from['key'], 'to' => $to, 'authorization' => $auth], 'hash' => $hash,
        'authoritySignature' => ledger_sign($w['dom']['priv'], $hash), 'approvals' => []];
}

$alice = owner();
$bob = owner();
$carol = owner();

echo "\n== a transfer signed for one coin cannot move another\n";
$a = world('a.example');
grant($a, $alice['key'], '500');
// The same coin id on another domain, with the same holder: the situation a signature must not survive.
$z = world('z.example', $a['coin']);
grant($z, $alice['key'], '500');
$other = world('a.example', $a['coin'], '999999');
grant($other, $alice['key'], '500');
t($a['coin'] === $z['coin'] && $a['coin'] === $other['coin'] && $a['digest'] !== $z['digest'] && $a['digest'] !== $other['digest'], 'three ledgers carry one coin id with different authorities and genesis digests');
t(seq_of($a, $alice) === 0 && seq_of($z, $alice) === 0, 'the holder is at the same sequence number on both');

$legacyForA = authorization($a, $alice, $bob['key'], '10', [], true);
t(refuses(fn() => ledger_prepare_transfer($z['db'], $z['coin'], $legacyForA, $NOW), 'legacy-authorization'), 'a transfer in the older form, signed for one domain, is refused by another', why(fn() => ledger_prepare_transfer($z['db'], $z['coin'], $legacyForA, $NOW)));
t(refuses(fn() => ledger_prepare_transfer($a['db'], $a['coin'], $legacyForA, $NOW), 'legacy-authorization'), 'and a new transfer in the older form is refused by the domain it was signed for too');

$forA = authorization($a, $alice, $bob['key'], '10');
t(refuses(fn() => ledger_prepare_transfer($z['db'], $z['coin'], $forA, $NOW), 'wrong-authority'), 'a bound transfer signed for a.example is refused by z.example', why(fn() => ledger_prepare_transfer($z['db'], $z['coin'], $forA, $NOW)));
t(refuses(fn() => ledger_prepare_transfer($other['db'], $other['coin'], $forA, $NOW), 'wrong-genesis'), 'the same authority with another genesis is refused', why(fn() => ledger_prepare_transfer($other['db'], $other['coin'], $forA, $NOW)));
t(balance_of($z, $alice) === 500 && balance_of($other, $alice) === 500, 'the holder\'s balance on the other ledgers is untouched');
$prepared = ledger_prepare_transfer($a['db'], $a['coin'], $forA, $NOW);
t(commit($a, $prepared)['index'] === 2 && balance_of($a, $bob) === 10, 'the same transfer is accepted by the domain and coin it was signed for');
t(refuses(fn() => ledger_prepare_transfer($a['db'], $a['coin'], $forA, $NOW), 'replayed'), 'and not a second time');

$rewritten = authorization($a, $alice, $bob['key'], '5');
$rewritten['payload']['authority'] = 'z.example';
$rewritten['payload']['genesis'] = $z['digest'];
t(refuses(fn() => ledger_prepare_transfer($z['db'], $z['coin'], $rewritten, $NOW), 'bad-signature'), 'rewriting the authority and genesis to the other ledger\'s after signing breaks the signature', why(fn() => ledger_prepare_transfer($z['db'], $z['coin'], $rewritten, $NOW)));
$onlyAuthority = authorization($a, $alice, $bob['key'], '5');
$onlyAuthority['payload']['authority'] = 'z.example';
t(refuses(fn() => ledger_prepare_transfer($z['db'], $z['coin'], $onlyAuthority, $NOW), 'wrong-genesis'), 'and rewriting only one of them still leaves the other wrong');
$wrongShape = authorization($a, $alice, $bob['key'], '5', ['extra' => 1]);
t(refuses(fn() => ledger_prepare_transfer($a['db'], $a['coin'], $wrongShape, $NOW), 'bad-authorization'), 'an unknown field is refused');
$missing = authorization($a, $alice, $bob['key'], '5');
unset($missing['payload']['genesis']);
$missing['signature'] = owner_sign($alice, $missing['payload']);
t(refuses(fn() => ledger_prepare_transfer($a['db'], $a['coin'], $missing, $NOW), 'bad-authorization'), 'a version 2 transfer without its genesis is refused');
foreach (['authority' => 7, 'genesis' => 'nothex'] as $field => $value) {
    $bad = authorization($a, $alice, $bob['key'], '5', [$field => $value]);
    t(refuses(fn() => ledger_prepare_transfer($a['db'], $a['coin'], $bad, $NOW), $field === 'authority' ? 'wrong-authority' : 'bad-authorization'), 'a malformed ' . $field . ' is refused');
}
$v3 = authorization($a, $alice, $bob['key'], '5', ['v' => 3]);
t(refuses(fn() => ledger_prepare_transfer($a['db'], $a['coin'], $v3, $NOW), 'bad-authorization'), 'a version that does not exist is refused');

function balance_of(array $w, array $o): int
{
    $row = ledger_account_row($w['db'], $w['coin'], $o['key']);
    return $row ? (int) $row['units'] : 0;
}

echo "\n== baseHead is a real point in this coin's log\n";
$b = world('b.example');
grant($b, $alice['key'], '1000');
$h1 = ledger_head($b['db'], $b['coin']);
t($h1['index'] === 1, 'the log has the genesis entry and the grant');
foreach (['a hash that is not in the log' => bin2hex(random_bytes(32)), 'all zeros' => str_repeat('0', 64), 'the genesis digest' => $b['digest']] as $label => $hash) {
    t(refuses(fn() => ledger_prepare_transfer($b['db'], $b['coin'], authorization($b, $alice, $bob['key'], '1', ['baseHead' => $hash]), $NOW), 'unknown-base'), 'refused: baseHead is ' . $label, why(fn() => ledger_prepare_transfer($b['db'], $b['coin'], authorization($b, $alice, $bob['key'], '1', ['baseHead' => $hash]), $NOW)));
}
$foreign = ledger_head($a['db'], $a['coin']);
t(refuses(fn() => ledger_prepare_transfer($b['db'], $b['coin'], authorization($b, $alice, $bob['key'], '1', ['baseHead' => $foreign['hash']]), $NOW), 'unknown-base'), 'refused: a head of another ledger');
t(ledger_prepare_transfer($b['db'], $b['coin'], authorization($b, $alice, $bob['key'], '1'), $NOW)['public']['index'] === 2, 'accepted: the current head');
$genesisEntry = $b['db']->prepare('SELECT hash FROM ledger_log WHERE coin_id=? AND idx=0');
$genesisEntry->execute([$b['coin']]);
$h0 = (string) $genesisEntry->fetchColumn();
t(ledger_prepare_transfer($b['db'], $b['coin'], authorization($b, $alice, $bob['key'], '1', ['baseHead' => $h0]), $NOW)['public']['index'] === 2, 'accepted: an older head, while the sender has not sent since (others moving the log does not stale it)');

// The sender sends once (entry 2); then entries by others (3, 4).
send($b, $alice, $bob['key'], '5');
$h2 = ledger_head($b['db'], $b['coin']);
grant($b, $carol['key'], '7');
grant($b, $carol['key'], '8');
$h4 = ledger_head($b['db'], $b['coin']);
t(seq_of($b, $alice) === 1 && $h4['index'] === 4, 'the sender has sent once and the log has moved on twice');
t(refuses(fn() => ledger_prepare_transfer($b['db'], $b['coin'], authorization($b, $alice, $bob['key'], '1', ['baseHead' => $h1['hash']]), $NOW), 'stale'), 'refused: a head from before the sender\'s last transfer', why(fn() => ledger_prepare_transfer($b['db'], $b['coin'], authorization($b, $alice, $bob['key'], '1', ['baseHead' => $h1['hash']]), $NOW)));
t(ledger_prepare_transfer($b['db'], $b['coin'], authorization($b, $alice, $bob['key'], '1', ['baseHead' => $h2['hash']]), $NOW)['public']['index'] === 5, 'accepted: the head the sender\'s own transfer produced, though the log has moved on');
t(ledger_prepare_transfer($b['db'], $b['coin'], authorization($b, $alice, $bob['key'], '1', ['baseHead' => $h4['hash']]), $NOW)['public']['index'] === 5, 'accepted: the current head');
t(refuses(fn() => ledger_prepare_transfer($b['db'], $b['coin'], authorization($b, $alice, $bob['key'], '1', ['baseSeq' => 0]), $NOW), 'stale'), 'a wrong sequence number is still refused');

echo "\n== the treasury's own grants are bound\n";
$c = world('c.example');
$grantAuth = ledger_grant_authorization($c['db'], $c['coin'], ['key' => $c['treasury']['key'], 'private' => $c['treasury']['priv']], $alice['key'], '10', $NOW);
t(($grantAuth['payload']['v'] ?? null) === 2 && ($grantAuth['payload']['authority'] ?? null) === 'c.example' && ($grantAuth['payload']['genesis'] ?? null) === $c['digest'], 'a grant is signed in the bound form', $grantAuth['payload']);
$cOther = world('d.example', $c['coin']);
t(refuses(fn() => ledger_prepare_transfer($cOther['db'], $cOther['coin'], $grantAuth, $NOW), 'wrong-authority') || refuses(fn() => ledger_prepare_transfer($cOther['db'], $cOther['coin'], $grantAuth, $NOW), 'not-treasury') || refuses(fn() => ledger_prepare_transfer($cOther['db'], $cOther['coin'], $grantAuth, $NOW), 'no-account'), 'a grant signed for one ledger does not execute on another', why(fn() => ledger_prepare_transfer($cOther['db'], $cOther['coin'], $grantAuth, $NOW)));
// Same treasury key on both: the situation where the grant would otherwise carry over.
$shared = owner();
$s1 = world('s1.example', null, '1000000', $shared);
$s2 = world('s2.example', $s1['coin'], '1000000', $shared);
$g1 = ledger_grant_authorization($s1['db'], $s1['coin'], ['key' => $shared['key'], 'private' => $shared['priv']], $alice['key'], '10', $NOW);
t(refuses(fn() => ledger_prepare_transfer($s2['db'], $s2['coin'], $g1, $NOW), 'wrong-authority'), 'a grant signed with a treasury key shared by two ledgers does not execute on the other one', why(fn() => ledger_prepare_transfer($s2['db'], $s2['coin'], $g1, $NOW)));
t(commit($s1, ledger_prepare_transfer($s1['db'], $s1['coin'], $g1, $NOW))['index'] === 1 && ledger_check($s1['db'], $s1['coin']) === [], 'and it executes on its own ledger, which the checker passes');

echo "\n== entries written in the older form\n";
$d = world('d.example');
// The coin was funded before the change: its grant is in the older form too.
$funding = legacy_record($d, $d['treasury'], $alice['key'], '1000');
t(ledger_mirror_apply($d['db'], $d['coin'], $funding)['index'] === 1, 'a grant in the older form applies as history');
$old1 = legacy_record($d, $alice, $bob['key'], '10');
t(refuses(fn() => ledger_prepare_transfer($d['db'], $d['coin'], $old1['private']['authorization'], $NOW), 'legacy-authorization'), 'a new transfer in the older form is refused');
t(ledger_mirror_apply($d['db'], $d['coin'], $old1)['index'] === 2 && balance_of($d, $bob) === 10, 'an entry in the older form still applies as history');
t(ledger_check($d['db'], $d['coin']) === [], 'the checker passes a log with an entry in the older form', ledger_check($d['db'], $d['coin']));
$old2 = legacy_record($d, $alice, $bob['key'], '10');
t(ledger_mirror_apply($d['db'], $d['coin'], $old2)['index'] === 3, 'and another one, while no bound entry has been written');
send($d, $alice, $carol['key'], '20');
t(ledger_head($d['db'], $d['coin'])['index'] === 4 && ledger_check($d['db'], $d['coin']) === [], 'a bound entry follows the older ones, and the checker passes', ledger_check($d['db'], $d['coin']));
$old3 = legacy_record($d, $alice, $bob['key'], '10');
t(refuses(fn() => ledger_mirror_apply($d['db'], $d['coin'], $old3), 'legacy-authorization'), 'after a bound entry, no entry in the older form applies, even as history', why(fn() => ledger_mirror_apply($d['db'], $d['coin'], $old3)));
t(ledger_head($d['db'], $d['coin'])['index'] === 4, 'and the log did not move');

echo "\n== the checker looks at the binding\n";
$e = world('e.example');
grant($e, $alice['key'], '1000');
send($e, $alice, $bob['key'], '3');
t(ledger_check($e['db'], $e['coin']) === [], 'a log of bound entries passes');
// Another coin's genesis digest in an entry's signed payload: re-signed by the owner, as a hostile authority could produce from an owner's signature on another coin.
$copy = $e['db'];
$row = $copy->query("SELECT private_json FROM ledger_log WHERE coin_id='" . $e['coin'] . "' AND idx=2")->fetchColumn();
$private = json_decode((string) $row, true);
$private['authorization']['payload']['genesis'] = str_repeat('a', 64);
$private['authorization']['signature'] = owner_sign($alice, $private['authorization']['payload']);
$copy->prepare('UPDATE ledger_log SET private_json=? WHERE coin_id=? AND idx=2')->execute([ledger_canonical($private), $e['coin']]);
$found = ledger_check($copy, $e['coin']);
t($found !== [] && (bool) array_filter($found, fn($p) => str_contains($p, 'genesis')), 'the checker finds an entry whose owner signature names another genesis', $found);

echo "\n== the first transfers on a newly opened coin\n";
$n = world('n.example');
$genesisEntry = ledger_head($n['db'], $n['coin']);
t($genesisEntry['index'] === 0 && $genesisEntry['hash'] !== $n['digest'], 'a newly opened coin has only its genesis entry, whose hash is not the genesis digest');
t(refuses(fn() => ledger_prepare_transfer($n['db'], $n['coin'], authorization($n, $n['treasury'], $alice['key'], '100', ['baseHead' => $n['digest']]), $NOW), 'unknown-base'), 'the genesis digest is not a base head: it is no entry of the log');
t(grant($n, $alice['key'], '100')['index'] === 1, 'the treasury\'s first grant is based on the genesis entry and goes through');
$onGenesis = authorization($n, $alice, $bob['key'], '10', ['baseHead' => $genesisEntry['hash']]);
t(ledger_prepare_transfer($n['db'], $n['coin'], $onGenesis, $NOW)['public']['index'] === 2, 'a first transfer based on the genesis entry is accepted');
t(send($n, $alice, $bob['key'], '10')['index'] === 2 && balance_of($n, $bob) === 10, 'and so is one based on the head the holder saw after being funded');
t(refuses(fn() => ledger_prepare_transfer($n['db'], $n['coin'], authorization($n, $alice, $bob['key'], '10', ['baseHead' => $genesisEntry['hash']]), $NOW), 'stale'), 'once the holder has sent, a base before that send is stale');

echo "\n";
echo $failures === 0 ? "ALL $total CHAIN-LABS BINDING CHECKS PASSED\n" : "$failures of $total FAILED\n";
exit($failures === 0 ? 0 : 1);
