<?php
declare(strict_types=1);
// Spending and lookups of the chain labs (chain-labs/lib/spend.php) on throw-away SQLite files:
//   - owner proposals: stored pending, one per sender, idempotent, expiring
//   - execution by the authority of a single authority coin, receipts a wallet can verify
//   - recovery after a crash, and parallel executions of one proposal
//   - the signed holdings statement: public coins to anyone, private coins only to a key-signed challenge
//
//   php test/chain-labs-spend.php
require __DIR__ . '/../chain-labs/lib/spend.php';

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

$NOW = 1800000000;
function owner(): array { $p = ledger_new_owner_key(); return ['key' => $p['key'], 'priv' => $p['private']]; }
function domain_pair(): array
{
    $key = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
    openssl_pkey_export($key, $private);
    return ['priv' => $private, 'pub' => openssl_pkey_get_details($key)['key']];
}
// An active coin in $db. Returns its pieces; the authority signs for the first domain.
function make_coin(PDO $db, string $symbol, string $mode = 'single', string $visibility = 'public', int $n = 1, string $initial = '100000', ?array $faucet = null): array
{
    global $NOW;
    $doms = [];
    for ($i = 0; $i < $n; $i++) { $d = domain_pair(); $doms[] = ['domain' => chr(97 + $i) . '.example', 'priv' => $d['priv'], 'pub' => $d['pub']]; }
    $treasury = owner();
    $secret = $visibility === 'private' ? bin2hex(random_bytes(32)) : null;
    $genesis = ledger_genesis(['symbol' => $symbol, 'name' => 'Coin ' . $symbol, 'decimals' => 2, 'maxUnits' => '1000000', 'initialUnits' => $initial, 'treasuryKey' => $treasury['key'], 'mode' => $mode,
        'visibility' => $visibility, 'roster' => array_map(fn($d) => ['domain' => $d['domain'], 'key' => $d['pub']], $doms), 'createdAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 3600), 'refSecret' => $secret, 'faucet' => $faucet]);
    ledger_register($db, $genesis, $treasury['key'], $secret);
    foreach ($doms as $d) ledger_add_genesis_signature($db, $genesis['coinId'], $d['domain'], ledger_genesis_sign($genesis, $d['priv']));
    ledger_activate($db, $genesis['coinId'], $doms[0]['priv']);
    return ['coin' => $genesis['coinId'], 'doms' => $doms, 'treasury' => $treasury, 'secret' => $secret];
}
function auth(PDO $db, array $c, array $from, string $to, string $amount, array $over = []): array
{
    global $NOW;
    $row = ledger_account_row($db, $c['coin'], $from['key']);
    $payload = array_merge(['type' => 'atlas.ledger.transfer', 'v' => 1, 'coinId' => $c['coin'], 'from' => $from['key'], 'to' => $to, 'amount' => $amount, 'baseSeq' => $row ? (int) $row['seq'] : 0,
        'baseHead' => ledger_head($db, $c['coin'])['hash'], 'nonce' => bin2hex(random_bytes(16)), 'issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 10), 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 300)], $over);
    return ['payload' => $payload, 'signature' => ledger_owner_sign($from['priv'], $payload)];
}
function units(PDO $db, array $c, string $key): int
{
    $row = ledger_account_row($db, $c['coin'], $key);
    return $row ? (int) $row['units'] : 0;
}
function fresh(): array
{
    $file = tempnam(sys_get_temp_dir(), 'spend-test-') . '.sqlite';
    return [ledger_open($file), $file];
}
function pay(PDO $db, array $c, array $from, string $to, string $amount): array
{
    global $NOW;
    return spend_submit_and_execute($db, $c['coin'], auth($db, $c, $from, $to, $amount), $c['doms'][0]['priv'], $NOW);
}

echo "== proposals and execution\n";
[$db, $file] = fresh();
$c = make_coin($db, 'AAA');
$alice = owner(); $bob = owner(); $carol = owner();
$authPriv = $c['doms'][0]['priv'];
$authPub = $c['doms'][0]['pub'];
pay($db, $c, $c['treasury'], $alice['key'], '1000');
t(units($db, $c, $alice['key']) === 1000, 'a spend from the treasury funds the first account');
$a1 = auth($db, $c, $alice, $bob['key'], '100');
$state = spend_submit($db, $c['coin'], $a1, $NOW);
t($state['status'] === 'pending' && $state['index'] === null && units($db, $c, $alice['key']) === 1000 && units($db, $c, $bob['key']) === 0, 'a submitted proposal is stored pending and moves nothing');
$receipt = spend_execute($db, $c['coin'], $state['digest'], $authPriv, $NOW);
t(units($db, $c, $alice['key']) === 900 && units($db, $c, $bob['key']) === 100 && $receipt['entry']['index'] === 2, 'executing it moves the units and returns the receipt');
t(spend_proposal($db, $c['coin'], $state['digest'])['status'] === 'executed' && (int) spend_proposal($db, $c['coin'], $state['digest'])['executed_index'] === 2, 'the proposal is marked executed with its entry');
$prev = spend_receipt($db, $c['coin'], 1);
t(spend_verify_receipt($receipt, $authPub, $prev['hash']), 'a wallet verifies the receipt against the authority key and the previous hash');
t(!spend_verify_receipt($receipt, $authPub, str_repeat('0', 64)) && !spend_verify_receipt($receipt, domain_pair()['pub']), 'a wrong previous hash or a wrong authority key fails');
$edited = $receipt;
$edited['entry']['amount'] = '1';
t(!spend_verify_receipt($edited, $authPub), 'a receipt with an edited amount fails');
$resigned = $receipt;
$resigned['authoritySignature'] = $prev['authoritySignature'];
t(!spend_verify_receipt($resigned, $authPub), "another entry's signature does not fit");
$again = spend_execute($db, $c['coin'], $state['digest'], $authPriv, $NOW);
t($again === $receipt && units($db, $c, $alice['key']) === 900, 'executing an executed proposal returns the same receipt and moves nothing');
t(spend_submit($db, $c['coin'], $a1, $NOW)['status'] === 'executed', 'submitting the same proposal again reports it executed');
$copy = $a1;
$copy['signature'] = ledger_owner_sign($alice['priv'], $a1['payload']);
t(spend_submit($db, $c['coin'], $copy, $NOW)['status'] === 'executed' && units($db, $c, $bob['key']) === 100, 'a second signature over the same proposal is the same proposal');
$sameNonce = auth($db, $c, $alice, $carol['key'], '5', ['nonce' => $a1['payload']['nonce']]);
t(refuses(fn() => spend_submit($db, $c['coin'], $sameNonce, $NOW), 'replayed'), 'a different proposal on a used nonce is refused');

echo "\n== one proposal waiting per sender\n";
$p1 = spend_submit($db, $c['coin'], auth($db, $c, $alice, $bob['key'], '10'), $NOW);
t(refuses(fn() => spend_submit($db, $c['coin'], auth($db, $c, $alice, $carol['key'], '10'), $NOW), 'pending-exists'), 'a second proposal from a sender with one waiting is refused', why(fn() => spend_submit($db, $c['coin'], auth($db, $c, $alice, $carol['key'], '10'), $NOW)));
$q1 = spend_submit($db, $c['coin'], auth($db, $c, $bob, $carol['key'], '10'), $NOW);
t($q1['status'] === 'pending', 'another sender is not held up');
spend_execute($db, $c['coin'], $p1['digest'], $authPriv, $NOW);
spend_execute($db, $c['coin'], $q1['digest'], $authPriv, $NOW);
t(units($db, $c, $alice['key']) === 890 && units($db, $c, $bob['key']) === 100 && units($db, $c, $carol['key']) === 10, 'both execute');
$stale = auth($db, $c, $alice, $carol['key'], '1', ['baseSeq' => 1]);
t(refuses(fn() => spend_submit($db, $c['coin'], $stale, $NOW), 'stale'), 'a proposal signed against an old sequence number is refused at submission');
t(refuses(fn() => spend_submit($db, $c['coin'], auth($db, $c, $alice, $carol['key'], '999999'), $NOW), 'insufficient'), 'a proposal for more than the balance is refused at submission');
t(refuses(fn() => spend_execute($db, $c['coin'], str_repeat('a', 64), $authPriv, $NOW), 'unknown-proposal'), 'an unknown proposal is refused');
$short = auth($db, $c, $alice, $bob['key'], '1', ['issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 10), 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 20)]);
$s1 = spend_submit($db, $c['coin'], $short, $NOW);
$later = $NOW + 25;
t(refuses(fn() => spend_execute($db, $c['coin'], $s1['digest'], $authPriv, $later), 'expired'), 'a proposal past its expiry is not executed');
t(spend_proposal($db, $c['coin'], $s1['digest'])['status'] === 'expired', 'and is closed as expired');
t(refuses(fn() => spend_execute($db, $c['coin'], $s1['digest'], $authPriv, $NOW), 'closed'), 'a closed proposal stays closed');
$n2 = spend_submit($db, $c['coin'], auth($db, $c, $alice, $bob['key'], '2'), $NOW);
t($n2['status'] === 'pending', 'the sender can propose again after one closed');
spend_execute($db, $c['coin'], $n2['digest'], $authPriv, $NOW);
$s3 = spend_submit($db, $c['coin'], auth($db, $c, $alice, $bob['key'], '3', ['issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 10), 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 20)]), $NOW);
$s4 = spend_submit($db, $c['coin'], auth($db, $c, $alice, $bob['key'], '4'), $NOW + 30);
t($s4['status'] === 'pending' && spend_proposal($db, $c['coin'], $s3['digest'])['status'] === 'expired', 'an expired proposal stops blocking its sender');
spend_execute($db, $c['coin'], $s4['digest'], $authPriv, $NOW + 30);

echo "\n== a proposal that can no longer succeed\n";
$staleP = spend_submit($db, $c['coin'], auth($db, $c, $bob, $alice['key'], '5'), $NOW + 40);
// The sender's account moves through another route, so the waiting proposal is signed against an old sequence number.
$other = ledger_prepare_transfer($db, $c['coin'], auth($db, $c, $bob, $carol['key'], '1'), $NOW + 40);
ledger_commit($db, $c['coin'], $other, ledger_sign($authPriv, $other['hash']), [], $NOW + 40);
t(refuses(fn() => spend_execute($db, $c['coin'], $staleP['digest'], $authPriv, $NOW + 40), 'stale'), 'a waiting proposal whose account moved is refused');
t(spend_proposal($db, $c['coin'], $staleP['digest'])['status'] === 'rejected' && spend_proposal($db, $c['coin'], $staleP['digest'])['reason'] === 'stale', 'and is closed as rejected with the reason');

echo "\n== multi authority and frozen coins\n";
$m = make_coin($db, 'MUL', 'multi', 'public', 2);
$mp = spend_submit($db, $m['coin'], auth($db, $m, $m['treasury'], $alice['key'], '10'), $NOW);
t(refuses(fn() => spend_execute($db, $m['coin'], $mp['digest'], $m['doms'][0]['priv'], $NOW), 'needs-approvals'), 'a multi authority coin is not executed on the authority alone');
$f = make_coin($db, 'FRZ');
$fp = spend_submit($db, $f['coin'], auth($db, $f, $f['treasury'], $alice['key'], '10'), $NOW);
ledger_freeze($db, $f['coin']);
t(refuses(fn() => spend_execute($db, $f['coin'], $fp['digest'], $f['doms'][0]['priv'], $NOW), 'not-active') && spend_proposal($db, $f['coin'], $fp['digest'])['status'] === 'pending', 'a frozen coin executes nothing and the proposal stays pending');

echo "\n== recovery\n";
$r = make_coin($db, 'RCV');
$ra = owner(); $rb = owner(); $rc = owner();
pay($db, $r, $r['treasury'], $ra['key'], '500');
pay($db, $r, $r['treasury'], $rb['key'], '500');
$crash1 = spend_submit($db, $r['coin'], auth($db, $r, $ra, $rc['key'], '50'), $NOW);
$crash2 = spend_submit($db, $r['coin'], auth($db, $r, $rb, $rc['key'], '70'), $NOW);
t(units($db, $r, $rc['key']) === 0, 'two proposals wait after a crash');
$done = spend_recover($db, $r['coin'], $r['doms'][0]['priv'], $NOW);
t(count($done) === 2 && units($db, $r, $rc['key']) === 120 && units($db, $r, $ra['key']) === 450, 'recovery executes each valid pending proposal once', $done);
t(spend_recover($db, $r['coin'], $r['doms'][0]['priv'], $NOW) === [] && units($db, $r, $rc['key']) === 120, 'a second recovery has nothing to do');
$lost = spend_submit($db, $r['coin'], auth($db, $r, $ra, $rc['key'], '1', ['issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 10), 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 20)]), $NOW);
$done = spend_recover($db, $r['coin'], $r['doms'][0]['priv'], $NOW + 60);
t(($done === [] || ($done[$lost['digest']] ?? '') === 'expired') && spend_proposal($db, $r['coin'], $lost['digest'])['status'] === 'expired' && units($db, $r, $rc['key']) === 120, 'recovery expires what ran out instead of executing it');
$wait = spend_submit($db, $r['coin'], auth($db, $r, $ra, $rc['key'], '5', ['issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 70), 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 300)]), $NOW + 70);
ledger_freeze($db, $r['coin']);
$done = spend_recover($db, $r['coin'], $r['doms'][0]['priv'], $NOW + 70);
t(($done[$wait['digest']] ?? '') === 'not-active' && units($db, $r, $rc['key']) === 120, 'recovery on a frozen coin changes nothing');
$db->exec("UPDATE ledger_coins SET state='active' WHERE coin_id='" . $r['coin'] . "'");
$done = spend_recover($db, $r['coin'], $r['doms'][0]['priv'], $NOW + 70);
t(str_starts_with($done[$wait['digest']] ?? '', 'executed') && units($db, $r, $rc['key']) === 125, 'it finishes the proposal once the coin is active again', $done);

echo "\n== parallel executions\n";
[$pdb, $pfile] = fresh();
$pc = make_coin($pdb, 'PAR');
$N = 8;
$sink = owner();
$senders = [];
for ($i = 0; $i < $N; $i++) { $senders[$i] = owner(); pay($pdb, $pc, $pc['treasury'], $senders[$i]['key'], '1000'); }
$digests = [];
foreach ($senders as $i => $u) $digests[$i] = spend_submit($pdb, $pc['coin'], auth($pdb, $pc, $u, $sink['key'], (string) (100 + $i)), $NOW)['digest'];
$keyFile = tempnam(sys_get_temp_dir(), 'spend-key-');
file_put_contents($keyFile, $pc['doms'][0]['priv']);
$procs = [];
foreach (array_merge($digests, $digests) as $digest) {
    $pipes = [];
    $proc = proc_open([PHP_BINARY, __FILE__, 'worker', $pfile, $pc['coin'], $digest, $keyFile, (string) $NOW], [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
    $procs[] = [$proc, $pipes];
}
$outs = [];
foreach ($procs as [$proc, $pipes]) { $outs[] = trim(stream_get_contents($pipes[1])); fclose($pipes[1]); fclose($pipes[2]); proc_close($proc); }
$entries = (int) $pdb->query("SELECT COUNT(*) FROM ledger_log WHERE coin_id='" . $pc['coin'] . "'")->fetchColumn();
$paid = array_sum(array_map(fn($i) => 100 + $i, range(0, $N - 1)));
t($entries === 1 + 2 * $N && units($pdb, $pc, $sink['key']) === $paid, 'sixteen processes executing eight proposals: each executes exactly once', [$entries, $outs]);
t(count(array_filter($outs, fn($x) => !str_starts_with($x, 'OK '))) === 0, 'and every one of them is answered with the receipt', $outs);
t(ledger_check($pdb, $pc['coin']) === [], 'the checker passes after the parallel run', ledger_check($pdb, $pc['coin']));
t(ledger_check($db, $c['coin']) === [] && ledger_check($db, $r['coin']) === [], 'the checker passes on the coins used above', [ledger_check($db, $c['coin']), ledger_check($db, $r['coin'])]);

echo "\n== a private coin's receipts\n";
$pv = make_coin($db, 'PRV', 'single', 'private');
$x = owner(); $y = owner();
$rcpt = pay($db, $pv, $pv['treasury'], $x['key'], '700');
$rcpt2 = pay($db, $pv, $x, $y['key'], '200');
$text = json_encode([$rcpt, $rcpt2, spend_receipt($db, $pv['coin'], 0)]);
t(!str_contains($text, $x['key']) && !str_contains($text, $y['key']) && !str_contains($text, $pv['treasury']['key']) && !str_contains($text, $pv['secret']), 'a private coin receipt carries references, never a key or the secret');
t(spend_verify_receipt($rcpt2, $pv['doms'][0]['pub'], $rcpt['hash']), 'and still verifies');

echo "\n== holdings\n";
[$hdb] = fresh();
$domain = 'a.example';
$dom = domain_pair();
$pubCoin = make_coin($hdb, 'PUB');
$privCoin = make_coin($hdb, 'SEC', 'single', 'private');
$emptyCoin = make_coin($hdb, 'EMP');
$h = owner(); $other = owner();
foreach ([$pubCoin, $privCoin] as $cc) spend_submit_and_execute($hdb, $cc['coin'], auth($hdb, $cc, $cc['treasury'], $h['key'], '4200'), $cc['doms'][0]['priv'], $NOW);
spend_submit_and_execute($hdb, $pubCoin['coin'], auth($hdb, $pubCoin, $h, $other['key'], '200'), $pubCoin['doms'][0]['priv'], $NOW);
$plain = spend_holdings($hdb, $domain, $dom['priv'], $h['key'], null, $NOW);
$st = $plain['statement'];
t(spend_verify_holdings($plain, $dom['pub'], $domain, $h['key'], $NOW), 'a plain lookup is signed by the domain and verifies');
t($st['proven'] === false && count($st['coins']) === 1 && $st['coins'][0]['symbol'] === 'PUB' && $st['coins'][0]['units'] === '4000' && $st['coins'][0]['seq'] === 1, 'a plain lookup lists the public coin with balance and sequence number', $st);
t(!str_contains(json_encode($plain), 'SEC') && !str_contains(json_encode($plain), $privCoin['coin']), 'a plain lookup does not reveal that a private coin exists');
t($st['coins'][0]['headIndex'] === 2 && $st['coins'][0]['headHash'] === ledger_head($hdb, $pubCoin['coin'])['hash'] && $st['coins'][0]['mode'] === 'single' && $st['coins'][0]['visibility'] === 'public', 'it carries the log head, the mode and the visibility');
t(spend_holdings($hdb, $domain, $dom['priv'], $other['key'], null, $NOW)['statement']['coins'][0]['units'] === '200', "another key's lookup shows its own balance");
t(spend_holdings($hdb, $domain, $dom['priv'], owner()['key'], null, $NOW)['statement']['coins'] === [], 'a key with no account gets an empty list');
t(refuses(fn() => spend_holdings($hdb, $domain, $dom['priv'], 'abc', null, $NOW), 'bad-key'), 'a key that is not a wallet key is refused');
$request = function (string $challenge, array $signer, array $over = []) use ($h, $domain) {
    $payload = array_merge(['type' => 'atlas.ledger.holdings.request', 'v' => 1, 'domain' => $domain, 'key' => $h['key'], 'challenge' => $challenge], $over);
    return ['payload' => $payload, 'signature' => ledger_owner_sign($signer['priv'], $payload)];
};
$ch = spend_challenge_issue($hdb, $NOW);
$signed = spend_holdings($hdb, $domain, $dom['priv'], $h['key'], $request($ch['challenge'], $h), $NOW);
$sc = array_column($signed['statement']['coins'], 'units', 'symbol');
t($signed['statement']['proven'] === true && $sc === ['PUB' => '4000', 'SEC' => '4200'] && spend_verify_holdings($signed, $dom['pub'], $domain, $h['key'], $NOW), 'a key-signed request also lists the private coin', $signed['statement']);
t(refuses(fn() => spend_holdings($hdb, $domain, $dom['priv'], $h['key'], $request($ch['challenge'], $h), $NOW), 'bad-challenge'), 'a challenge cannot be used twice');
$ch = spend_challenge_issue($hdb, $NOW);
t(refuses(fn() => spend_holdings($hdb, $domain, $dom['priv'], $h['key'], $request($ch['challenge'], $other), $NOW), 'bad-signature'), "a request signed by another key is refused, not answered as a plain lookup");
t(spend_holdings($hdb, $domain, $dom['priv'], $h['key'], $request($ch['challenge'], $h), $NOW)['statement']['proven'] === true, 'a refused request does not use up the challenge');
$ch = spend_challenge_issue($hdb, $NOW);
t(refuses(fn() => spend_holdings($hdb, $domain, $dom['priv'], $h['key'], $request($ch['challenge'], $h), $NOW + SPEND_CHALLENGE_SECONDS + 1), 'bad-challenge'), 'an expired challenge is refused');
t(refuses(fn() => spend_holdings($hdb, $domain, $dom['priv'], $h['key'], $request(bin2hex(random_bytes(16)), $h), $NOW), 'bad-challenge'), 'a challenge the domain never issued is refused');
$ch = spend_challenge_issue($hdb, $NOW);
$cases = [
    'a request for another domain' => ['domain' => 'b.example'], 'a request about another key' => ['key' => $other['key']],
    'the wrong type' => ['type' => 'atlas.ledger.transfer'], 'the wrong version' => ['v' => 2],
];
foreach ($cases as $name => $over) t(refuses(fn() => spend_holdings($hdb, $domain, $dom['priv'], $h['key'], $request($ch['challenge'], $h, $over), $NOW), 'bad-request'), 'refused: ' . $name);
$extra = $request($ch['challenge'], $h);
$extra['payload']['note'] = 'x';
t(refuses(fn() => spend_holdings($hdb, $domain, $dom['priv'], $h['key'], $extra, $NOW), 'bad-request'), 'refused: a request with an extra field');
t(refuses(fn() => spend_holdings($hdb, $domain, $dom['priv'], $h['key'], $request('not-hex', $h), $NOW), 'bad-challenge'), 'refused: a malformed challenge');
t(refuses(fn() => spend_holdings($hdb, $domain, $dom['priv'], $h['key'], ['signature' => 'x'], $NOW), 'bad-request'), 'refused: a request with no payload');
ledger_freeze($hdb, $pubCoin['coin']);
t(spend_holdings($hdb, $domain, $dom['priv'], $h['key'], null, $NOW)['statement']['coins'][0]['state'] === 'frozen', 'a frozen coin is listed as frozen');
$ok = spend_holdings($hdb, $domain, $dom['priv'], $h['key'], null, $NOW);
$bad = $ok;
$bad['statement']['coins'][0]['units'] = '999999';
t(!spend_verify_holdings($bad, $dom['pub'], $domain, $h['key'], $NOW), 'a wallet rejects a statement whose balance was edited');
t(!spend_verify_holdings($ok, domain_pair()['pub'], $domain, $h['key'], $NOW), 'or one signed by a key other than the pinned one');
t(!spend_verify_holdings($ok, $dom['pub'], 'b.example', $h['key'], $NOW), 'or one that names another domain');
t(!spend_verify_holdings($ok, $dom['pub'], $domain, $other['key'], $NOW), 'or another key');
t(!spend_verify_holdings($ok, $dom['pub'], $domain, $h['key'], $NOW + 301) && spend_verify_holdings($ok, $dom['pub'], $domain, $h['key'], $NOW + 300), 'or one older than the allowed age');
t(!spend_verify_holdings($ok, $dom['pub'], $domain, $h['key'], $NOW - 500), 'or one dated in the future');
$hdb->prepare('DELETE FROM ledger_challenges')->execute();
$hdb->exec("INSERT INTO ledger_challenges(challenge,expires_at,used) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<" . SPEND_MAX_OPEN_CHALLENGES . ") SELECT printf('%032x', i), " . ($NOW + 1000) . ", 0 FROM n");
t(refuses(fn() => spend_challenge_issue($hdb, $NOW), 'busy'), 'challenges are capped while many are open');
t(spend_challenge_issue($hdb, $NOW + 2000)['challenge'] !== '', 'and expired ones are cleared so issuing works again');
$direct = [];
$port = random_int(20000, 40000);
$server = proc_open([PHP_BINARY, '-S', '127.0.0.1:' . $port, '-t', __DIR__ . '/../chain-labs'], [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $sp);
$status = 0; $body = '';
for ($try = 0; $try < 30; $try++) {
    usleep(100000);
    $body = @file_get_contents('http://127.0.0.1:' . $port . '/lib/spend.php', false, stream_context_create(['http' => ['ignore_errors' => true, 'timeout' => 3]]));
    if ($body !== false && isset($http_response_header[0])) { preg_match('/ (\d{3}) /', $http_response_header[0], $mm); $status = (int) $mm[1]; break; }
}
proc_terminate($server);
t($status === 404 && trim((string) $body) === '', 'a direct request for lib/spend.php gets an empty 404', [$status, substr((string) $body, 0, 80)]);

echo "\n" . ($failures === 0 ? 'ALL ' . $total . ' CHAIN-LABS SPEND CHECKS PASSED' : $failures . ' of ' . $total . ' checks FAILED') . "\n";
exit($failures === 0 ? 0 : 1);

function worker(array $argv): void
{
    [, , $file, $coin, $digest, $keyFile, $now] = $argv;
    $db = ledger_open($file);
    try {
        $receipt = spend_execute($db, $coin, $digest, (string) file_get_contents($keyFile), (int) $now);
        echo 'OK ' . $receipt['entry']['index'];
    } catch (LedgerError $e) {
        echo $e->reason;
    } catch (Throwable $e) {
        echo 'ERR ' . $e->getMessage();
    }
}
