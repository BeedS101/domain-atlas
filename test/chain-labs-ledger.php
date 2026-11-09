<?php
declare(strict_types=1);
// Ledger store of the chain labs (chain-labs/lib/ledger.php), on a throw-away SQLite file per scenario:
//   - genesis rules, signatures from every roster domain, activation, entry 0
//   - owner-signed transfers and every way one can be refused
//   - single, all-of and k-of-n coins; approvals from outside the roster, duplicates, too few
//   - a private coin's public reads never contain a key; the owner's view does
//   - conservation, balances and the checker under 400 random operations, valid and invalid
//   - the checker finds each of twelve kinds of tampering
//   - parallel commits of one index: exactly one wins
//
//   php test/chain-labs-ledger.php
require __DIR__ . '/../chain-labs/lib/ledger.php';

if (($argv[1] ?? '') === 'worker') { worker($argv); exit(0); }

$failures = 0;
$total = 0;
function t(bool $ok, string $text, mixed $detail = null): void
{
    global $failures, $total;
    $total++;
    if (!$ok) $failures++;
    echo ($ok ? 'PASS ' : 'FAIL ') . $text . (!$ok && $detail !== null ? ' :: ' . substr(is_string($detail) ? $detail : json_encode($detail), 0, 300) : '') . "\n";
}
// True when the callable throws a LedgerError with the given reason.
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

// ---------- keys ----------
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
    $point = "\x04" . str_pad($p['x'], 32, "\x00", STR_PAD_LEFT) . str_pad($p['y'], 32, "\x00", STR_PAD_LEFT);
    return ['key' => ledger_b64u_encode($point), 'priv' => $p['priv']];
}
function der_to_raw(string $der): string
{
    $offset = 2;
    $parts = [];
    for ($i = 0; $i < 2; $i++) {
        $len = ord($der[$offset + 1]);
        $int = ltrim(substr($der, $offset + 2, $len), "\x00");
        $parts[] = str_pad($int, 32, "\x00", STR_PAD_LEFT);
        $offset += 2 + $len;
    }
    return $parts[0] . $parts[1];
}
function owner_sign(array $owner, array $payload): string
{
    openssl_sign(ledger_canonical($payload), $der, openssl_pkey_get_private($owner['priv']), OPENSSL_ALGO_SHA256);
    return ledger_b64u_encode(der_to_raw($der));
}
function domains(int $n): array
{
    $out = [];
    for ($i = 0; $i < $n; $i++) { $p = ec_pair(); $out[] = ['domain' => chr(97 + $i) . '.example', 'priv' => $p['priv'], 'pub' => $p['pub']]; }
    return $out;
}

// ---------- a coin ----------
$NOW = 1800000000;
function new_db(): array
{
    $file = tempnam(sys_get_temp_dir(), 'ledger-test-') . '.sqlite';
    return [ledger_open($file), $file];
}
// Builds, registers, signs and activates a coin. $n domains; the first is the authority.
function world(string $mode, string $visibility, int $n = 1, ?int $threshold = null, string $initial = '1000000', ?array $faucet = null): array
{
    global $NOW;
    [$db, $file] = new_db();
    $doms = domains($n);
    $treasury = owner();
    $secret = $visibility === 'private' ? bin2hex(random_bytes(32)) : null;
    $genesis = ledger_genesis(['symbol' => 'TST', 'name' => 'Test coin', 'decimals' => 2, 'maxUnits' => '2000000', 'initialUnits' => $initial, 'treasuryKey' => $treasury['key'],
        'mode' => $mode, 'visibility' => $visibility, 'roster' => array_map(fn($d) => ['domain' => $d['domain'], 'key' => $d['pub']], $doms), 'threshold' => $threshold,
        'createdAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 3600), 'refSecret' => $secret, 'faucet' => $faucet]);
    ledger_register($db, $genesis, $treasury['key'], $secret);
    foreach ($doms as $d) ledger_add_genesis_signature($db, $genesis['coinId'], $d['domain'], ledger_genesis_sign($genesis, $d['priv']));
    ledger_activate($db, $genesis['coinId'], $doms[0]['priv']);
    return ['db' => $db, 'file' => $file, 'coin' => $genesis['coinId'], 'genesis' => $genesis, 'doms' => $doms, 'treasury' => $treasury, 'secret' => $secret];
}
function authorization(array $w, array $from, string $to, string $amount, ?int $baseSeq = null, array $over = []): array
{
    global $NOW;
    if ($baseSeq === null) { $row = ledger_account_row($w['db'], $w['coin'], $from['key']); $baseSeq = $row ? (int) $row['seq'] : 0; }
    $payload = array_merge(['type' => 'atlas.ledger.transfer', 'v' => 1, 'coinId' => $w['coin'], 'from' => $from['key'], 'to' => $to, 'amount' => $amount, 'baseSeq' => $baseSeq,
        'baseHead' => ledger_head($w['db'], $w['coin'])['hash'], 'nonce' => bin2hex(random_bytes(16)), 'issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 10),
        'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 300)], $over);
    return ['payload' => $payload, 'signature' => owner_sign($from, $payload)];
}
// Prepares, has the authority and the first $approvers - 1 other domains sign, and commits.
function transfer(array $w, array $from, string $to, string $amount, ?int $approvers = null, ?int $baseSeq = null, array $over = []): array
{
    global $NOW;
    $prepared = ledger_prepare_transfer($w['db'], $w['coin'], authorization($w, $from, $to, $amount, $baseSeq, $over), $NOW);
    $approvers ??= count($w['doms']);
    return commit_prepared($w, $prepared, $approvers);
}
function commit_prepared(array $w, array $prepared, int $approvers): array
{
    global $NOW;
    $sigs = [];
    for ($i = 1; $i < $approvers; $i++) $sigs[] = ['domain' => $w['doms'][$i]['domain'], 'signature' => ledger_sign($w['doms'][$i]['priv'], ledger_approval_bytes($w['coin'], $prepared['public']['index'], $prepared['hash']))];
    return ledger_commit($w['db'], $w['coin'], $prepared, ledger_sign($w['doms'][0]['priv'], $prepared['hash']), $sigs, $NOW);
}
function balance(array $w, string $key): int
{
    $row = ledger_account_row($w['db'], $w['coin'], $key);
    return $row ? (int) $row['units'] : 0;
}

echo "\n== genesis\n";
$tk = owner();
$base = ['symbol' => 'TST', 'name' => 'Test coin', 'decimals' => 2, 'maxUnits' => '2000000', 'initialUnits' => '1000', 'treasuryKey' => $tk['key'], 'mode' => 'single', 'visibility' => 'public',
    'roster' => [['domain' => 'a.example', 'key' => ec_pair()['pub']]], 'createdAt' => '2027-01-15T00:00:00Z'];
t(ledger_genesis($base)['threshold'] === 1, 'a single public coin has a roster of one and threshold 1');
$bad = [
    'a lower-case symbol' => ['symbol' => 'tst'], 'a one-letter symbol' => ['symbol' => 'T'], 'decimals 7' => ['decimals' => 7], 'decimals as a string' => ['decimals' => '2'],
    'max 0' => ['maxUnits' => '0'], 'a leading zero' => ['initialUnits' => '007'], 'a negative amount' => ['initialUnits' => '-1'], 'a float amount' => ['initialUnits' => 1.5],
    'initial above max' => ['initialUnits' => '3000000'], 'above the unit limit' => ['maxUnits' => '1000000000001', 'initialUnits' => '1'], 'an unknown mode' => ['mode' => 'triple'],
    'an unknown visibility' => ['visibility' => 'hidden'], 'a bad treasury key' => ['treasuryKey' => 'abc'], 'an empty roster' => ['roster' => []],
    'a single coin with two domains' => ['roster' => [['domain' => 'a.example', 'key' => ec_pair()['pub']], ['domain' => 'b.example', 'key' => ec_pair()['pub']]]],
    'a bad domain name' => ['roster' => [['domain' => 'localhost', 'key' => ec_pair()['pub']]]], 'a roster key that is not a key' => ['roster' => [['domain' => 'a.example', 'key' => 'nope']]],
    'a private coin without a secret' => ['visibility' => 'private'], 'a bad coin id' => ['coinId' => 'xyz'], 'a bad date' => ['createdAt' => 'yesterday'],
];
foreach ($bad as $name => $change) t(refuses(fn() => ledger_genesis(array_merge($base, $change)), in_array($name, ['a lower-case symbol', 'a one-letter symbol', 'decimals 7', 'decimals as a string', 'max 0', 'initial above max', 'an unknown mode', 'an unknown visibility', 'a bad treasury key', 'an empty roster', 'a single coin with two domains', 'a bad domain name', 'a roster key that is not a key', 'a private coin without a secret', 'a bad coin id', 'a bad date'], true) ? 'bad-genesis' : 'bad-amount'), 'refused: ' . $name, why(fn() => ledger_genesis(array_merge($base, $change))));
$multiRoster = [['domain' => 'a.example', 'key' => ec_pair()['pub']], ['domain' => 'b.example', 'key' => ec_pair()['pub']], ['domain' => 'c.example', 'key' => ec_pair()['pub']]];
$multi = array_merge($base, ['mode' => 'multi', 'roster' => $multiRoster]);
t(ledger_genesis($multi)['threshold'] === 3, 'a multi coin defaults to every domain approving');
t(ledger_genesis(array_merge($multi, ['threshold' => 2]))['threshold'] === 2, 'a threshold of 2 of 3 is allowed');
t(refuses(fn() => ledger_genesis(array_merge($multi, ['threshold' => 1])), 'bad-genesis'), 'a threshold below 2 is refused');
t(refuses(fn() => ledger_genesis(array_merge($multi, ['threshold' => 4])), 'bad-genesis'), 'a threshold above the roster is refused');
t(refuses(fn() => ledger_genesis(array_merge($multi, ['roster' => [$multiRoster[0]]])), 'bad-genesis'), 'a multi coin needs at least two domains');
t(refuses(fn() => ledger_genesis(array_merge($multi, ['roster' => array_merge($multiRoster, array_map(fn($c) => ['domain' => $c . '.example', 'key' => ec_pair()['pub']], ['d', 'e', 'f']))])), 'bad-genesis'), 'a roster above five is refused');
t(refuses(fn() => ledger_genesis(array_merge($multi, ['roster' => [$multiRoster[0], $multiRoster[0]]])), 'bad-genesis'), 'a repeated domain is refused');
$g1 = ledger_genesis($base);
$g2 = ledger_genesis(array_merge($base, ['coinId' => $g1['coinId'], 'name' => 'Other coin']));
t(ledger_genesis_digest($g1) !== ledger_genesis_digest($g2), 'any change to the genesis changes its digest');

echo "\n== activation\n";
$w = world('single', 'public');
$head = ledger_head($w['db'], $w['coin']);
t($head['index'] === 0 && balance($w, $w['treasury']['key']) === 1000000, 'a single coin opens with the supply in the treasury at entry 0');
t(ledger_check($w['db'], $w['coin']) === [], 'a new coin passes the checker', ledger_check($w['db'], $w['coin']));
[$db, $file] = new_db();
$d3 = domains(3);
$tr = owner();
$g = ledger_genesis(['symbol' => 'TST', 'name' => 'Test coin', 'decimals' => 0, 'maxUnits' => '100', 'initialUnits' => '100', 'treasuryKey' => $tr['key'], 'mode' => 'multi', 'visibility' => 'public',
    'roster' => array_map(fn($d) => ['domain' => $d['domain'], 'key' => $d['pub']], $d3), 'createdAt' => '2027-01-15T00:00:00Z']);
ledger_register($db, $g, $tr['key'], null);
$twice = false;
try { ledger_register($db, $g, $tr['key'], null); } catch (Throwable $e) { $twice = true; }
t($twice, 'a coin id can be registered once');
t(refuses(fn() => ledger_activate($db, $g['coinId'], $d3[0]['priv']), 'genesis-unsigned'), 'a coin cannot open before any roster domain has signed');
ledger_add_genesis_signature($db, $g['coinId'], 'a.example', ledger_genesis_sign($g, $d3[0]['priv']));
ledger_add_genesis_signature($db, $g['coinId'], 'b.example', ledger_genesis_sign($g, $d3[1]['priv']));
t(refuses(fn() => ledger_activate($db, $g['coinId'], $d3[0]['priv']), 'genesis-unsigned'), 'a coin cannot open with two of three genesis signatures');
t(refuses(fn() => ledger_add_genesis_signature($db, $g['coinId'], 'c.example', ledger_genesis_sign($g, $d3[1]['priv'])), 'bad-signature'), "another domain's signature is not accepted for a domain");
t(refuses(fn() => ledger_add_genesis_signature($db, $g['coinId'], 'z.example', ledger_genesis_sign($g, $d3[1]['priv'])), 'not-in-roster'), 'a domain outside the roster cannot sign the genesis');
$other = $g;
$other['name'] = 'Changed';
t(refuses(fn() => ledger_add_genesis_signature($db, $g['coinId'], 'c.example', ledger_genesis_sign($other, $d3[2]['priv'])), 'bad-signature'), 'a signature over a different genesis is refused');
t(refuses(fn() => ledger_prepare_transfer($db, $g['coinId'], authorization(['db' => $db, 'coin' => $g['coinId']], $tr, owner()['key'], '1'), $NOW), 'not-active'), 'a pending coin cannot move funds');
ledger_add_genesis_signature($db, $g['coinId'], 'c.example', ledger_genesis_sign($g, $d3[2]['priv']));
ledger_activate($db, $g['coinId'], $d3[0]['priv']);
t(ledger_head($db, $g['coinId'])['index'] === 0 && ledger_check($db, $g['coinId']) === [], 'a coin opens once every roster domain has signed');
t(refuses(fn() => ledger_activate($db, $g['coinId'], $d3[0]['priv']), 'not-pending'), 'a coin opens only once');

echo "\n== transfers\n";
$w = world('single', 'public');
$alice = owner();
$bob = owner();
$tre = $w['treasury'];
transfer($w, $tre, $alice['key'], '1000');
t(balance($w, $alice['key']) === 1000 && balance($w, $tre['key']) === 999000, 'a transfer moves the units and opens the recipient account');
t((int) ledger_account_row($w['db'], $w['coin'], $tre['key'])['seq'] === 1, "the sender's sequence number counts its spends");
transfer($w, $alice, $bob['key'], '400');
t(balance($w, $alice['key']) === 600 && balance($w, $bob['key']) === 400, 'a second transfer between wallet accounts');
$cases = [
    'a stale sequence number' => [fn() => transfer($w, $alice, $bob['key'], '1', null, 0), 'stale'],
    'a future sequence number' => [fn() => transfer($w, $alice, $bob['key'], '1', null, 5), 'stale'],
    'more than the balance' => [fn() => transfer($w, $alice, $bob['key'], '601'), 'insufficient'],
    'an amount of zero' => [fn() => transfer($w, $alice, $bob['key'], '0'), 'bad-amount'],
    'a leading zero' => [fn() => transfer($w, $alice, $bob['key'], '01'), 'bad-amount'],
    'a negative amount' => [fn() => transfer($w, $alice, $bob['key'], '-5'), 'bad-amount'],
    'a decimal amount' => [fn() => transfer($w, $alice, $bob['key'], '1.5'), 'bad-amount'],
    'an amount above the coin' => [fn() => transfer($w, $alice, $bob['key'], '9999999999999'), 'bad-amount'],
    'a transfer to oneself' => [fn() => transfer($w, $alice, $alice['key'], '1'), 'bad-authorization'],
    'a recipient that is not a key' => [fn() => transfer($w, $alice, 'nobody', '1'), 'bad-authorization'],
    'a sender with no account' => [fn() => transfer($w, owner(), $bob['key'], '1', 0), 'no-account'],
    'an expired proposal' => [fn() => transfer($w, $alice, $bob['key'], '1', null, null, ['expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 1), 'issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 100)]), 'expired'],
    'a proposal dated in the future' => [fn() => transfer($w, $alice, $bob['key'], '1', null, null, ['issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 1000), 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 1200)]), 'not-yet-valid'],
    'a proposal that lives too long' => [fn() => transfer($w, $alice, $bob['key'], '1', null, null, ['expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 5000)]), 'bad-authorization'],
    'a short nonce' => [fn() => transfer($w, $alice, $bob['key'], '1', null, null, ['nonce' => 'abc']), 'bad-authorization'],
    'a proposal for another coin' => [fn() => transfer($w, $alice, $bob['key'], '1', null, null, ['coinId' => str_repeat('0', 32)]), 'bad-authorization'],
    'the wrong type' => [fn() => transfer($w, $alice, $bob['key'], '1', null, null, ['type' => 'atlas.ledger.balance']), 'bad-authorization'],
];
foreach ($cases as $name => [$fn, $reason]) t(refuses($fn, $reason), 'refused: ' . $name, why($fn));
$forged = authorization($w, $alice, $bob['key'], '5');
$forged['payload']['amount'] = '500';
t(refuses(fn() => ledger_prepare_transfer($w['db'], $w['coin'], $forged, $NOW), 'bad-signature'), 'refused: an amount changed after signing');
$stolen = authorization($w, $bob, $tre['key'], '5');
$stolen['payload']['from'] = $alice['key'];
t(refuses(fn() => ledger_prepare_transfer($w['db'], $w['coin'], $stolen, $NOW), 'bad-signature'), "refused: a spend signed by someone else's key", why(fn() => ledger_prepare_transfer($w['db'], $w['coin'], $stolen, $NOW)));
$extra = authorization($w, $alice, $bob['key'], '5');
$extra['payload']['note'] = 'x';
t(refuses(fn() => ledger_prepare_transfer($w['db'], $w['coin'], $extra, $NOW), 'bad-authorization'), 'refused: a payload with an extra field');
$once = authorization($w, $alice, $bob['key'], '10');
$prepared = ledger_prepare_transfer($w['db'], $w['coin'], $once, $NOW);
commit_prepared($w, $prepared, 1);
t(refuses(fn() => ledger_prepare_transfer($w['db'], $w['coin'], $once, $NOW), 'replayed'), 'refused: the same signed transfer a second time');
t(balance($w, $alice['key']) === 590, 'a refused replay moved nothing');
// A nonce used by one owner does not block another owner.
$n1 = bin2hex(random_bytes(16));
transfer($w, $alice, $bob['key'], '1', null, null, ['nonce' => $n1]);
transfer($w, $bob, $alice['key'], '1', null, null, ['nonce' => $n1]);
t(true, 'two owners may use the same nonce');
t(ledger_check($w['db'], $w['coin']) === [], 'the checker passes after these transfers', ledger_check($w['db'], $w['coin']));

echo "\n== committing a prepared entry\n";
$base2 = ledger_prepare_transfer($w['db'], $w['coin'], authorization($w, $alice, $bob['key'], '3'), $NOW);
$sig = ledger_sign($w['doms'][0]['priv'], $base2['hash']);
$tamper = function (callable $edit) use ($w, $base2, $sig, $NOW) { $p = $base2; $edit($p); return fn() => ledger_commit($w['db'], $w['coin'], $p, $sig, [], $NOW); };
t(refuses($tamper(function (&$p) { $p['public']['amount'] = '4'; }), 'bad-hash'), 'refused: a public amount changed after hashing');
t(refuses($tamper(function (&$p) { $p['public']['index'] = 7; }), 'wrong-index'), 'refused: an entry that skips ahead');
t(refuses($tamper(function (&$p) { $p['public']['prevHash'] = str_repeat('a', 64); }), 'wrong-prev'), 'refused: an entry on the wrong previous hash');
t(refuses(fn() => ledger_commit($w['db'], $w['coin'], $base2, ledger_sign($w['doms'][0]['priv'], 'something else'), [], $NOW), 'bad-authority-signature'), 'refused: an authority signature over something else');
t(refuses(fn() => ledger_commit($w['db'], $w['coin'], $base2, ledger_sign(ec_pair()['priv'], $base2['hash']), [], $NOW), 'bad-authority-signature'), 'refused: a signature by another key as the authority');
$mismatched = $base2;
$mismatched['public']['to'] = $tre['key'];
$mismatched['hash'] = ledger_digest($mismatched['public']);
$mismatched['private']['hash'] = $mismatched['hash'];
t(refuses(fn() => ledger_commit($w['db'], $w['coin'], $mismatched, ledger_sign($w['doms'][0]['priv'], $mismatched['hash']), [], $NOW), 'bad-entry'), 'refused: a public recipient that differs from the signed one');
$loose = $base2;
$loose['public']['memo'] = 'x';
t(refuses(fn() => ledger_commit($w['db'], $w['coin'], $loose, $sig, [], $NOW), 'bad-entry'), 'refused: a public form with an extra field');
t(refuses(fn() => ledger_commit($w['db'], $w['coin'], ['public' => $base2['public']], $sig, [], $NOW), 'bad-entry'), 'refused: an entry with no private form');
ledger_freeze($w['db'], $w['coin']);
t(refuses(fn() => ledger_commit($w['db'], $w['coin'], $base2, $sig, [], $NOW), 'not-active'), 'a frozen coin commits nothing');
t(refuses(fn() => ledger_prepare_transfer($w['db'], $w['coin'], authorization($w, $alice, $bob['key'], '3'), $NOW), 'not-active'), 'a frozen coin prepares nothing');

echo "\n== commit re-checks state itself\n";
// The prepared entry is built against a copy whose rows were edited, so it is valid there but not in the real store.
$rc = world('single', 'public');
$p1 = owner(); $p2 = owner();
transfer($rc, $rc['treasury'], $p1['key'], '100');
$forgeOn = function (string $sql, array $auth) use ($rc, $NOW) {
    $copy = tempnam(sys_get_temp_dir(), 'ledger-copy-') . '.sqlite';
    copy($rc['file'], $copy);
    $cdb = ledger_open($copy);
    $cdb->exec($sql);
    $prepared = ledger_prepare_transfer($cdb, $rc['coin'], $auth, $NOW);
    unlink($copy);
    return $prepared;
};
$sendNow = fn(array $prepared) => fn() => ledger_commit($rc['db'], $rc['coin'], $prepared, ledger_sign($rc['doms'][0]['priv'], $prepared['hash']), [], $NOW);
$k = $p1['key'];
$auth = authorization($rc, $p1, $p2['key'], '500');
$rich = $forgeOn("UPDATE ledger_accounts SET units=1000 WHERE account_key='$k'", $auth);
t(refuses($sendNow($rich), 'insufficient'), 'commit refuses a spend the real balance cannot cover');
$auth = authorization($rc, $p1, $p2['key'], '5', 3);
$moved = $forgeOn("UPDATE ledger_accounts SET seq=3 WHERE account_key='$k'", $auth);
t(refuses($sendNow($moved), 'stale'), 'commit refuses a spend signed for a different sequence number');
$auth = authorization($rc, $p1, $p2['key'], '5');
$used = $forgeOn("SELECT 1", $auth);
$rc['db']->prepare('INSERT INTO ledger_nonces(coin_id,owner_key,nonce) VALUES(?,?,?)')->execute([$rc['coin'], $k, $auth['payload']['nonce']]);
t(refuses($sendNow($used), 'replayed'), 'commit refuses a nonce already used');
$rc['db']->prepare('DELETE FROM ledger_nonces WHERE nonce=?')->execute([$auth['payload']['nonce']]);
$headMoved = ledger_prepare_transfer($rc['db'], $rc['coin'], authorization($rc, $p1, $p2['key'], '2'), $NOW);
transfer($rc, $p1, $p2['key'], '1');
t(refuses($sendNow($headMoved), 'wrong-index'), 'commit refuses an entry prepared before the head moved');

echo "\n== approvals\n";
foreach ([[3, null, 'all three'], [3, 2, '2 of 3'], [5, 3, '3 of 5']] as [$n, $k, $label]) {
    $m = world('multi', 'public', $n, $k);
    $a = owner();
    $need = $k ?? $n;
    $to = owner();
    t(refuses(fn() => transfer($m, $m['treasury'], $a['key'], '100', $need - 1), 'not-enough-approvals'), $label . ': one approval short is refused');
    transfer($m, $m['treasury'], $a['key'], '100', $need);
    t(balance($m, $a['key']) === 100, $label . ': exactly enough approvals commits');
    if ($need < $n) { transfer($m, $a, $to['key'], '10', $n); t(balance($m, $to['key']) === 10, $label . ': more than enough also commits'); }
    $p = ledger_prepare_transfer($m['db'], $m['coin'], authorization($m, $a, $to['key'], '1'), $NOW);
    $own = ledger_sign($m['doms'][0]['priv'], $p['hash']);
    $bytes = ledger_approval_bytes($m['coin'], $p['public']['index'], $p['hash']);
    $b = ['domain' => $m['doms'][1]['domain'], 'signature' => ledger_sign($m['doms'][1]['priv'], $bytes)];
    $outsider = ec_pair();
    t(refuses(fn() => ledger_commit($m['db'], $m['coin'], $p, $own, [$b, $b], $NOW), 'duplicate-approval'), $label . ': the same domain approving twice is refused');
    t(refuses(fn() => ledger_commit($m['db'], $m['coin'], $p, $own, [['domain' => 'z.example', 'signature' => ledger_sign($outsider['priv'], $bytes)]], $NOW), 'not-in-roster'), $label . ': an approval from outside the roster is refused');
    t(refuses(fn() => ledger_commit($m['db'], $m['coin'], $p, $own, [['domain' => $m['doms'][1]['domain'], 'signature' => ledger_sign($m['doms'][1]['priv'], 'wrong bytes')]], $NOW), 'bad-approval'), $label . ': an approval over other bytes is refused');
    t(refuses(fn() => ledger_commit($m['db'], $m['coin'], $p, $own, [['domain' => $m['doms'][1]['domain'], 'signature' => ledger_sign($m['doms'][2]['priv'], $bytes)]], $NOW), 'bad-approval'), $label . ': one domain signing as another is refused');
    $replayed = ['domain' => $m['doms'][1]['domain'], 'signature' => ledger_sign($m['doms'][1]['priv'], ledger_approval_bytes($m['coin'], $p['public']['index'] + 1, $p['hash']))];
    t(refuses(fn() => ledger_commit($m['db'], $m['coin'], $p, $own, [$replayed], $NOW), 'bad-approval'), $label . ': an approval for another index is refused');
    t(ledger_check($m['db'], $m['coin']) === [], $label . ': the checker passes', ledger_check($m['db'], $m['coin']));
}
t(refuses(fn() => ledger_commit(world('multi', 'public', 3)['db'], 'f' . str_repeat('0', 31), [], '', [], $NOW), 'unknown-coin'), 'an unknown coin is refused');

echo "\n== a private coin\n";
$p = world('single', 'private');
$o1 = owner(); $o2 = owner(); $o3 = owner();
transfer($p, $p['treasury'], $o1['key'], '5000');
transfer($p, $p['treasury'], $o2['key'], '700');
transfer($p, $o1, $o2['key'], '1200');
transfer($p, $o2, $o3['key'], '300');
$keys = [$o1['key'], $o2['key'], $o3['key'], $p['treasury']['key']];
$public = [ledger_public_coin($p['db'], $p['coin'])];
$page = ledger_public_entries($p['db'], $p['coin'], -1, 100);
$public[] = $page;
foreach ($page['entries'] as $e) foreach ([$e['entry']['from'], $e['entry']['to']] as $ref) if ($ref !== null) $public[] = ledger_public_account($p['db'], $p['coin'], $ref);
$text = json_encode($public);
t(count($page['entries']) === 5 && strlen($text) > 500, 'the public reads of a private coin return the whole history');
$leaks = array_filter($keys, fn($k) => str_contains($text, $k));
t($leaks === [], 'no account key appears anywhere in the public reads of a private coin', array_map(fn($k) => substr($k, 0, 12), $leaks));
t(!str_contains($text, $p['secret']) && !str_contains($text, substr($p['secret'], 0, 20)), 'the reference secret does not appear either');
$bits = array_map(fn($k) => ledger_b64u_decode($k), $keys);
t(array_filter($bits, fn($b) => str_contains($text, bin2hex($b))) === [] && array_filter($bits, fn($b) => str_contains($text, base64_encode($b))) === [], 'nor in hex or standard base64');
t(ledger_public_account($p['db'], $p['coin'], $o1['key']) === null, 'an account cannot be looked up by key in a private coin');
t(ledger_public_account($p['db'], $p['coin'], ledger_ref($p['secret'], $o1['key']))['units'] === '3800', 'an account is reached by its reference');
t($public[0]['genesis']['treasuryRef'] === ledger_ref($p['secret'], $p['treasury']['key']) && !isset($public[0]['genesis']['treasuryKey']), 'the genesis names the treasury by reference only');
t(isset($public[0]['genesis']['refSecretHash']) && $public[0]['genesis']['refSecretHash'] === hash('sha256', $p['secret']), 'the genesis carries a hash of the secret, not the secret');
$view = ledger_owner_view($p['db'], $p['coin'], $o3['key']);
t($view !== null && $view['units'] === '300' && count($view['entries']) === 1 && $view['entries'][0]['private']['to'] === $o3['key'], "the owner's view resolves their own entry to their key");
$view1 = ledger_owner_view($p['db'], $p['coin'], $o1['key']);
t(count($view1['entries']) === 2 && !str_contains(json_encode($view1), $o3['key']), "the owner's view holds only entries involving that key", [count($view1['entries'])]);
t(ledger_owner_view($p['db'], $p['coin'], owner()['key']) === null, 'a key with no account has no view');
$pub = world('single', 'public');
$x = owner();
transfer($pub, $pub['treasury'], $x['key'], '50');
$pubText = json_encode(ledger_public_entries($pub['db'], $pub['coin']));
t(str_contains($pubText, $x['key']) && ledger_public_account($pub['db'], $pub['coin'], $x['key'])['units'] === '50', 'a public coin shows keys and is looked up by key');
$wrongRef = authorization($p, $o1, $o2['key'], '1');
$prep = ledger_prepare_transfer($p['db'], $p['coin'], $wrongRef, $NOW);
$prep['public']['from'] = ledger_ref($p['secret'], $o3['key']);
$prep['hash'] = ledger_digest($prep['public']);
$prep['private']['hash'] = $prep['hash'];
t(refuses(fn() => ledger_commit($p['db'], $p['coin'], $prep, ledger_sign($p['doms'][0]['priv'], $prep['hash']), [], $NOW), 'bad-entry'), 'a public reference that does not match the key is refused');
t(ledger_check($p['db'], $p['coin']) === [], 'the checker passes on a private coin', ledger_check($p['db'], $p['coin']));
t(refuses(fn() => ledger_register(new_db()[0], array_merge($pub['genesis'], ['visibility' => 'private']), $pub['treasury']['key'], str_repeat('a', 64)), 'bad-genesis'), 'a genesis cannot be re-labelled as private');

echo "\n== paging\n";
$pg = world('single', 'public');
$sink = owner();
for ($i = 0; $i < 12; $i++) transfer($pg, $pg['treasury'], $sink['key'], '1');
$first = ledger_public_entries($pg['db'], $pg['coin'], -1, 5);
$second = ledger_public_entries($pg['db'], $pg['coin'], $first['next'], 5);
$third = ledger_public_entries($pg['db'], $pg['coin'], $second['next'], 5);
t(count($first['entries']) === 5 && count($second['entries']) === 5 && count($third['entries']) === 3 && $third['entries'][2]['entry']['index'] === 12, 'the log is read in pages that join up');
t(ledger_public_entries($pg['db'], $pg['coin'], 12, 5)['entries'] === [] && ledger_public_entries($pg['db'], $pg['coin'], 12, 5)['next'] === null, 'a page past the end is empty');
t(count(ledger_public_entries($pg['db'], $pg['coin'], -1, 100000)['entries']) === 13 && count(ledger_public_entries($pg['db'], $pg['coin'], -1, 0)['entries']) === 1, 'the page size is clamped');
$acct = ledger_public_account($pg['db'], $pg['coin'], $sink['key'], -1, 5);
$acct2 = ledger_public_account($pg['db'], $pg['coin'], $sink['key'], $acct['next'], 5);
t(count($acct['entries']) === 5 && count($acct2['entries']) === 5 && $acct2['entries'][0]['pos'] === 5 && $acct['units'] === '12', "an account's entries are paged by position");

echo "\n== conservation under random operations\n";
$seed = random_int(1, 1 << 30);
mt_srand($seed);
echo "seed $seed\n";
$r = world('multi', 'private', 3, 2);
$accounts = [$r['treasury']];
for ($i = 0; $i < 5; $i++) $accounts[] = owner();
$model = [$r['treasury']['key'] => 1000000];
$seqs = [$r['treasury']['key'] => 0];
foreach ($accounts as $a) { $model[$a['key']] ??= 0; $seqs[$a['key']] ??= 0; }
$ok = 0; $refused = 0; $wrong = [];
for ($i = 0; $i < 400; $i++) {
    $from = $accounts[mt_rand(0, count($accounts) - 1)];
    $to = $accounts[mt_rand(0, count($accounts) - 1)];
    $held = $model[$from['key']];
    $amount = (string) (mt_rand(0, 9) === 0 ? mt_rand(1, 2000000) : mt_rand(1, max(1, intdiv($held, 3))));
    $kind = mt_rand(0, 9);
    $seq = $seqs[$from['key']] + ($kind === 0 ? 1 : ($kind === 1 && $seqs[$from['key']] > 0 ? -1 : 0));
    $approvers = $kind === 2 ? 1 : mt_rand(2, 3);
    $valid = $kind !== 2 && $seq === $seqs[$from['key']] && $from['key'] !== $to['key'] && (int) $amount <= $held && (int) $amount >= 1;
    try {
        transfer($r, $from, $to['key'], $amount, $kind === 2 ? 1 : $approvers, $seq);
        if ($valid) { $model[$from['key']] -= (int) $amount; $model[$to['key']] += (int) $amount; $seqs[$from['key']]++; $ok++; } else { $wrong[] = ['accepted an invalid op', $i, $kind]; }
    } catch (LedgerError $e) {
        $refused++;
        if ($valid) $wrong[] = ['refused a valid op', $i, $e->reason];
    }
    $sum = (int) $r['db']->query("SELECT SUM(units) FROM ledger_accounts WHERE coin_id='" . $r['coin'] . "'")->fetchColumn();
    if ($sum !== 1000000) { $wrong[] = ['supply changed', $i, $sum]; break; }
}
t($wrong === [], 'every valid operation was accepted and every invalid one refused', array_slice($wrong, 0, 3));
t($ok > 100 && $refused > 30, 'the run mixed both kinds of operation (' . $ok . ' accepted, ' . $refused . ' refused)');
$mismatch = [];
foreach ($model as $key => $units) if (balance($r, $key) !== $units) $mismatch[] = substr($key, 0, 8);
t($mismatch === [], 'every balance equals an independent model', $mismatch);
t(ledger_check($r['db'], $r['coin']) === [], 'the checker passes after the run', ledger_check($r['db'], $r['coin']));
t(ledger_head($r['db'], $r['coin'])['index'] === $ok, 'the log holds exactly the accepted operations plus the genesis entry');

echo "\n== the checker finds tampering\n";
$src = world('multi', 'private', 3, 2);
$u = owner(); $v = owner();
transfer($src, $src['treasury'], $u['key'], '5000', 2);
transfer($src, $u, $v['key'], '1500', 3);
transfer($src, $v, $u['key'], '200', 2);
transfer($src, $u, $v['key'], '50', 2);
t(ledger_check($src['db'], $src['coin']) === [], 'the base coin for the tamper runs is consistent');
$mutations = [
    'an account balance changed' => "UPDATE ledger_accounts SET units=units+1 WHERE account_key='{U}'",
    'an account sequence number changed' => "UPDATE ledger_accounts SET seq=seq+1 WHERE account_key='{U}'",
    'an account reference changed' => "UPDATE ledger_accounts SET ref='forged' WHERE account_key='{U}'",
    'a public amount rewritten' => "UPDATE ledger_log SET public_json=REPLACE(public_json,'\"amount\":\"1500\"','\"amount\":\"1400\"') WHERE idx=2",
    'a stored hash rewritten' => "UPDATE ledger_log SET hash='" . str_repeat('0', 64) . "' WHERE idx=2",
    'a previous hash rewritten' => "UPDATE ledger_log SET prev_hash='" . str_repeat('1', 64) . "' WHERE idx=3",
    'an authority signature replaced' => "UPDATE ledger_log SET authority_sig=(SELECT authority_sig FROM ledger_log WHERE idx=1) WHERE idx=3",
    'an entry deleted from the middle' => 'DELETE FROM ledger_log WHERE idx=2',
    'an approval removed' => "UPDATE ledger_log SET approvals_json='[]' WHERE idx=2",
    'an index row removed' => 'DELETE FROM ledger_account_entries WHERE idx=4 AND ref=(SELECT ref FROM ledger_accounts WHERE account_key=\'{U}\')',
    'a nonce row added' => "INSERT INTO ledger_nonces(coin_id,owner_key,nonce) VALUES('{C}','{U}','" . str_repeat('9', 32) . "')",
    'the genesis rewritten' => "UPDATE ledger_coins SET genesis_json=REPLACE(genesis_json,'Test coin','Fake coin')",
];
foreach ($mutations as $name => $sql) {
    $copy = tempnam(sys_get_temp_dir(), 'ledger-tamper-') . '.sqlite';
    copy($src['file'], $copy);
    $db2 = ledger_open($copy);
    $db2->exec(str_replace(['{U}', '{C}'], [$u['key'], $src['coin']], $sql));
    $found = ledger_check($db2, $src['coin']);
    t($found !== [], 'the checker finds: ' . $name);
    unlink($copy);
}
// A recomputed hash chain with a forged owner authorization is still caught by its signature.
$copy = tempnam(sys_get_temp_dir(), 'ledger-tamper-') . '.sqlite';
copy($src['file'], $copy);
$db3 = ledger_open($copy);
$row = $db3->query('SELECT private_json FROM ledger_log WHERE idx=2')->fetchColumn();
$private = json_decode($row, true);
$private['authorization']['payload']['amount'] = '1499';
$db3->prepare('UPDATE ledger_log SET private_json=? WHERE idx=2')->execute([ledger_canonical($private)]);
t(ledger_check($db3, $src['coin']) !== [], 'the checker finds: an owner authorization altered after signing');

echo "\n== parallel commits\n";
$race = world('single', 'public');
$a = owner();
transfer($race, $race['treasury'], $a['key'], '100');
$cands = [];
for ($i = 0; $i < 2; $i++) {
    $prep = ledger_prepare_transfer($race['db'], $race['coin'], authorization($race, $a, owner()['key'], '10'), $NOW);
    $cands[] = ['prepared' => $prep, 'sig' => ledger_sign($race['doms'][0]['priv'], $prep['hash'])];
}
$procs = [];
$dir = sys_get_temp_dir();
foreach ($cands as $ci => $c) {
    $jsonFile = tempnam($dir, 'ledger-cand-');
    file_put_contents($jsonFile, json_encode($c));
    for ($k = 0; $k < 3; $k++) {
        $pipes = [];
        $proc = proc_open([PHP_BINARY, __FILE__, 'worker', $race['file'], $race['coin'], $jsonFile, (string) $NOW], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $procs[] = [$proc, $pipes];
    }
}
$results = [];
foreach ($procs as [$proc, $pipes]) { $results[] = trim(stream_get_contents($pipes[1])); fclose($pipes[1]); fclose($pipes[2]); proc_close($proc); }
$wins = count(array_filter($results, fn($x) => $x === 'OK'));
t($wins === 1, 'six processes committing two entries for one index: exactly one wins', $results);
t(balance($race, $a['key']) === 90 && ledger_check($race['db'], $race['coin']) === [], 'the winner moved the funds once and the store is consistent', ledger_check($race['db'], $race['coin']));

echo "\n== faucet policy in the genesis\n";
$fb = array_merge($base, ['maxUnits' => '2000000', 'initialUnits' => '1000']);
$okPolicy = ['maxAmount' => '100', 'perKeyLimit' => '250', 'cooldownSeconds' => 60];
t(ledger_genesis($fb)['faucet'] === null, 'a coin with no faucet policy has none');
t(ledger_genesis(array_merge($fb, ['faucet' => $okPolicy]))['faucet'] === $okPolicy, 'a faucet policy is kept in the genesis');
t(ledger_genesis_digest(ledger_genesis(array_merge($fb, ['coinId' => $g1['coinId'], 'faucet' => $okPolicy]))) !== ledger_genesis_digest(ledger_genesis(array_merge($fb, ['coinId' => $g1['coinId'], 'faucet' => array_merge($okPolicy, ['cooldownSeconds' => 61])]))), 'the policy is part of what the roster signs');
$badPolicies = [
    'a policy that is a list' => ['100', '250', 60], 'a missing field' => ['maxAmount' => '100', 'perKeyLimit' => '250'],
    'an extra field' => array_merge($okPolicy, ['note' => 'x']), 'a grant limit of 0' => array_merge($okPolicy, ['maxAmount' => '0']),
    'a grant above the coin' => array_merge($okPolicy, ['maxAmount' => '3000000', 'perKeyLimit' => '3000000']),
    'a key limit below the grant limit' => array_merge($okPolicy, ['perKeyLimit' => '99']), 'a key limit above the coin' => array_merge($okPolicy, ['perKeyLimit' => '2000001']),
    'a negative cool-down' => array_merge($okPolicy, ['cooldownSeconds' => -1]), 'a cool-down as text' => array_merge($okPolicy, ['cooldownSeconds' => '60']),
    'a cool-down above 30 days' => array_merge($okPolicy, ['cooldownSeconds' => 2592001]), 'amounts as numbers' => array_merge($okPolicy, ['maxAmount' => 100]),
];
foreach ($badPolicies as $name => $policy) t(refuses(fn() => ledger_genesis(array_merge($fb, ['faucet' => $policy])), 'bad-genesis') || refuses(fn() => ledger_genesis(array_merge($fb, ['faucet' => $policy])), 'bad-amount'), 'refused: ' . $name, why(fn() => ledger_genesis(array_merge($fb, ['faucet' => $policy]))));

echo "\n== treasury key and operator grants\n";
$pairA = ledger_new_owner_key();
t(ledger_valid_owner_key($pairA['key']) && openssl_pkey_get_private($pairA['private']) !== false, 'a new owner key is in the wallet format');
$payload = ['type' => 'x', 'n' => 1];
t(ledger_owner_verify(ledger_canonical($payload), $pairA['key'], ledger_owner_sign($pairA['private'], $payload)), 'a signature made with it verifies as a wallet signature');
t(!ledger_owner_verify(ledger_canonical(['type' => 'x', 'n' => 2]), $pairA['key'], ledger_owner_sign($pairA['private'], $payload)), 'it does not verify over other bytes');
$kdir = sys_get_temp_dir() . '/ledger-keys-' . bin2hex(random_bytes(4));
mkdir($kdir, 0700);
$cid = bin2hex(random_bytes(16));
$made = ledger_treasury_key_create($kdir, $cid);
$file = $kdir . '/treasury-' . $cid . '.json';
t(is_file($file) && (fileperms($file) & 0777) === 0600, 'the treasury key file is readable by its owner only');
t(ledger_treasury_key_load($kdir, $cid) === $made, 'the treasury key loads back as it was made');
t(refuses(fn() => ledger_treasury_key_create($kdir, $cid), 'key-exists'), 'a treasury key is never overwritten');
t(refuses(fn() => ledger_treasury_key_load($kdir, bin2hex(random_bytes(16))), 'bad-key-file'), 'a missing key file is refused');
t(refuses(fn() => ledger_treasury_key_load($kdir, '../etc'), 'bad-key-file') && refuses(fn() => ledger_treasury_key_create($kdir, '../x'), 'bad-key-file'), 'a coin id that is not 32 hex characters is refused');
file_put_contents($file, '{"key":"abc","private":"x"}');
t(refuses(fn() => ledger_treasury_key_load($kdir, $cid), 'bad-key-file'), 'a damaged key file is refused');

echo "\n== faucet limits on treasury spends\n";
$NOW = 1800000000;
$fw = world('single', 'public', 1, null, '10000', $okPolicy);
$fa = owner(); $fb2 = owner();
$treasuryPair = ['key' => $fw['treasury']['key'], 'private' => $fw['treasury']['priv']];
$grant = fn(string $to, string $amount) => function () use ($fw, $treasuryPair, $to, $amount) { global $NOW; return commit_prepared($fw, ledger_grant($fw['db'], $fw['coin'], $treasuryPair, $to, $amount, $NOW), 1); };
t(refuses(fn() => ledger_grant($fw['db'], $fw['coin'], ['key' => $fa['key'], 'private' => $fa['priv']], $fb2['key'], '1', $NOW), 'not-treasury'), 'a grant needs the treasury key');
$grant($fa['key'], '100')();
t(balance($fw, $fa['key']) === 100, 'an operator grant moves units out of the treasury');
t(refuses($grant($fa['key'], '10'), 'faucet-cooldown'), 'a second grant to the same key inside the cool-down is refused', why($grant($fa['key'], '10')));
$grant($fb2['key'], '40')();
t(balance($fw, $fb2['key']) === 40, 'another key is not held back by the first key\'s cool-down');
t(refuses($grant($fb2['key'], '101'), 'faucet-amount'), 'a grant above the maximum is refused', why($grant($fb2['key'], '101')));
$NOW += 61;
$grant($fa['key'], '100')();
$NOW += 61;
t(refuses($grant($fa['key'], '100'), 'faucet-limit'), 'a grant that takes a key past its limit is refused', why($grant($fa['key'], '100')));
$grant($fa['key'], '50')();
t(balance($fw, $fa['key']) === 250, 'a grant up to the limit exactly is allowed');
$NOW += 61;
t(refuses($grant($fa['key'], '1'), 'faucet-limit'), 'nothing more can be granted to a key at its limit');
transfer($fw, $fa, $fb2['key'], '240');
t(balance($fw, $fb2['key']) === 280 && balance($fw, $fa['key']) === 10, 'spends between other accounts are not limited by the faucet');
t(refuses($grant($fa['key'], '1'), 'faucet-limit'), 'passing units on does not reopen the limit');
transfer($fw, $fb2, $fw['treasury']['key'], '200');
t(balance($fw, $fw['treasury']['key']) === 10000 - 100 - 40 - 100 - 50 + 200, 'units can be returned to the treasury');
t(ledger_check($fw['db'], $fw['coin']) === [], 'the checker passes on a coin with a faucet', ledger_check($fw['db'], $fw['coin']));
$sum = (int) $fw['db']->query("SELECT COUNT(*) FROM ledger_faucet WHERE coin_id='" . $fw['coin'] . "'")->fetchColumn();
t($sum === 2, 'the faucet totals are kept per recipient key');
// Commit enforces the policy itself: the entry is prepared against a copy whose faucet rows were cleared.
$NOW += 1000;
$copy = tempnam(sys_get_temp_dir(), 'ledger-copy-') . '.sqlite';
copy($fw['file'], $copy);
$cdb = ledger_open($copy);
$cdb->exec('DELETE FROM ledger_faucet');
$forged = ledger_grant($cdb, $fw['coin'], $treasuryPair, $fa['key'], '100', $NOW);
t(refuses(fn() => commit_prepared($fw, $forged, 1), 'faucet-limit'), 'commit refuses a grant the policy does not allow');
t(refuses(fn() => ledger_grant($fw['db'], $fw['coin'], $treasuryPair, $fa['key'], '100', $NOW), 'faucet-limit'), 'preparing a grant already applies the policy');
// The checker finds a log whose signed entries break the policy.
$cdb2 = ledger_open($copy);
$w2 = array_merge($fw, ['db' => $cdb2, 'file' => $copy]);
commit_prepared($w2, $forged, 1);
t(ledger_check($cdb2, $fw['coin']) !== [], 'the checker finds a signed entry that broke the faucet policy', ledger_check($cdb2, $fw['coin']));
unlink($copy);
$tam = [
    'a faucet total changed' => "UPDATE ledger_faucet SET total=total+1",
    'a faucet row removed' => "DELETE FROM ledger_faucet WHERE rowid=(SELECT MIN(rowid) FROM ledger_faucet)",
    'a faucet last-grant time changed' => "UPDATE ledger_faucet SET last_at=last_at+5",
    'a faucet row for an account that never received a grant' => "INSERT INTO ledger_faucet(coin_id,account_key,total,last_at) VALUES('" . $fw['coin'] . "','nobody',1,1)",
];
foreach ($tam as $name => $sql) {
    $c = tempnam(sys_get_temp_dir(), 'ledger-tamper-') . '.sqlite';
    copy($fw['file'], $c);
    $d = ledger_open($c);
    $d->exec($sql);
    t(ledger_check($d, $fw['coin']) !== [], 'the checker finds: ' . $name);
    unlink($c);
}
$pf = world('single', 'private', 1, null, '1000', ['maxAmount' => '10', 'perKeyLimit' => '15', 'cooldownSeconds' => 0]);
$pk = owner();
$ptre = ['key' => $pf['treasury']['key'], 'private' => $pf['treasury']['priv']];
commit_prepared($pf, ledger_grant($pf['db'], $pf['coin'], $ptre, $pk['key'], '10', $NOW), 1);
t(refuses(fn() => commit_prepared($pf, ledger_grant($pf['db'], $pf['coin'], $ptre, $pk['key'], '10', $NOW), 1), 'faucet-limit'), 'a private coin applies the limit to the key behind the reference');
commit_prepared($pf, ledger_grant($pf['db'], $pf['coin'], $ptre, $pk['key'], '5', $NOW), 1);
t(ledger_check($pf['db'], $pf['coin']) === [] && !str_contains(json_encode(ledger_public_entries($pf['db'], $pf['coin'])), $pk['key']), 'and no key reaches the public reads');

echo "\n== the time of an entry\n";
$tw = world('single', 'public');
$tu = owner();
transfer($tw, $tw['treasury'], $tu['key'], '100');
$prep = ledger_prepare_transfer($tw['db'], $tw['coin'], authorization($tw, $tw['treasury'], $tu['key'], '1'), $NOW);
$sigT = ledger_sign($tw['doms'][0]['priv'], $prep['hash']);
$rehash = function (array $p, array $change) use ($tw) {
    $p['public'] = array_merge($p['public'], $change);
    $p['hash'] = ledger_digest($p['public']);
    $p['private']['hash'] = $p['hash'];
    return $p;
};
$late = $rehash($prep, ['executedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 4000)]);
t(refuses(fn() => ledger_commit($tw['db'], $tw['coin'], $late, ledger_sign($tw['doms'][0]['priv'], $late['hash']), [], $NOW), 'bad-time'), 'an entry dated after its proposal expired is refused');
$early = $rehash($prep, ['executedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 2000)]);
t(refuses(fn() => ledger_commit($tw['db'], $tw['coin'], $early, ledger_sign($tw['doms'][0]['priv'], $early['hash']), [], $NOW), 'clock-behind'), 'an entry dated before the entry it follows is refused');
$tw2 = world('single', 'public');
$prep2 = ledger_prepare_transfer($tw2['db'], $tw2['coin'], authorization($tw2, $tw2['treasury'], owner()['key'], '1'), $NOW);
$before = $rehash($prep2, ['executedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 3000)]);
t(refuses(fn() => ledger_commit($tw2['db'], $tw2['coin'], $before, ledger_sign($tw2['doms'][0]['priv'], $before['hash']), [], $NOW), 'bad-time'), 'an entry dated before its proposal was issued is refused');
$garbled = $rehash($prep, ['executedAt' => 'now']);
t(refuses(fn() => ledger_commit($tw['db'], $tw['coin'], $garbled, ledger_sign($tw['doms'][0]['priv'], $garbled['hash']), [], $NOW), 'bad-time'), 'an entry with an unreadable time is refused');
t(refuses(fn() => ledger_commit($tw['db'], $tw['coin'], $prep, $sigT, [], $NOW + 130), 'bad-time'), 'an entry far from the current time is refused', why(fn() => ledger_commit($tw['db'], $tw['coin'], $prep, $sigT, [], $NOW + 130)));
t(refuses(fn() => ledger_prepare_transfer($tw['db'], $tw['coin'], authorization($tw, $tw['treasury'], $tu['key'], '1', null, ['issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 500), 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 50)]), $NOW - 400), 'clock-behind'), 'a clock that runs behind the log cannot add entries');
$tw3 = world('single', 'public');
$skewed = ledger_prepare_transfer($tw3['db'], $tw3['coin'], authorization($tw3, $tw3['treasury'], owner()['key'], '1', null, ['issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 100), 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 400)]), $NOW);
$skewed = $rehash($skewed, ['executedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 30)]);
t(refuses(fn() => ledger_commit($tw3['db'], $tw3['coin'], $skewed, ledger_sign($tw3['doms'][0]['priv'], $skewed['hash']), [], $NOW), 'bad-time'), 'an entry dated well before the proposal it executes is refused');
// A forged log whose entries go backwards in time is found by the checker.
$cp = tempnam(sys_get_temp_dir(), 'ledger-copy-') . '.sqlite';
copy($tw['file'], $cp);
$cd = ledger_open($cp);
$orig = $cd->query("SELECT public_json FROM ledger_log WHERE idx=1")->fetchColumn();
$cd->prepare("UPDATE ledger_log SET public_json=REPLACE(public_json, ?, ?) WHERE idx=1")->execute([gmdate('Y-m-d\TH:i:s\Z', $NOW), gmdate('Y-m-d\TH:i:s\Z', $NOW - 3000)]);
$wc = array_merge($tw, ['db' => $cd, 'file' => $cp]);
$savedNow = $NOW;
$NOW = $savedNow - 100;
$back = ledger_prepare_transfer($cd, $tw['coin'], authorization($wc, $tw['treasury'], $tu['key'], '2'), $NOW);
commit_prepared($wc, $back, 1);
$NOW = $savedNow;
$cd->prepare("UPDATE ledger_log SET public_json=? WHERE idx=1")->execute([$orig]);
$found = ledger_check($cd, $tw['coin']);
t(count(array_filter($found, fn($x) => str_contains($x, 'clock-behind'))) === 1, 'the checker finds an entry dated before the one it follows', $found);
unlink($cp);

echo "\n== direct request\n";
$port = random_int(20000, 40000);
$server = proc_open([PHP_BINARY, '-S', '127.0.0.1:' . $port, '-t', __DIR__ . '/../chain-labs'], [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $sp);
$status = 0; $body = '';
for ($try = 0; $try < 30; $try++) {
    usleep(100000);
    $body = @file_get_contents('http://127.0.0.1:' . $port . '/lib/ledger.php', false, stream_context_create(['http' => ['ignore_errors' => true, 'timeout' => 3]]));
    if ($body !== false && isset($http_response_header[0])) { preg_match('/ (\d{3}) /', $http_response_header[0], $m); $status = (int) $m[1]; break; }
}
proc_terminate($server);
t($status === 404 && trim((string) $body) === '', 'a direct request for lib/ledger.php gets an empty 404', [$status, substr((string) $body, 0, 80)]);

echo "\n" . ($failures === 0 ? 'ALL ' . $total . ' CHAIN-LABS LEDGER CHECKS PASSED' : $failures . ' of ' . $total . ' checks FAILED') . "\n";
exit($failures === 0 ? 0 : 1);

function worker(array $argv): void
{
    [, , $file, $coin, $candFile, $now] = $argv;
    $c = json_decode((string) file_get_contents($candFile), true);
    $db = ledger_open($file);
    try {
        ledger_commit($db, $coin, $c['prepared'], $c['sig'], [], (int) $now);
        echo 'OK';
    } catch (LedgerError $e) {
        echo $e->reason;
    } catch (Throwable $e) {
        echo 'ERR ' . $e->getMessage();
    }
}
