<?php
declare(strict_types=1);
// Signature formats of the domain key (chain-labs/lib/sigformat.php, applied in lib/ledger.php). What this covers:
//   - format 2 messages are typed and name the coin, the position and the signer; a signature for one purpose or place is not valid for another
//   - format 1 (the bare digest or hash) still verifies what was signed before, in genesis signatures, entries, mirrors, receipts and the checker
//   - a coin's authority signatures may be format 1 only until its first format 2 signature; after that format 1 is refused
//   - a coin whose entry 0 is format 2 takes format 2 genesis signatures only
//   - evidence accepts either format, because it only shows what the authority signed
//
//   php test/chain-labs-sigformat.php
require __DIR__ . '/../chain-labs/lib/peer.php';

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
$KEYS = [];
function dom_key(string $domain): array
{
    global $KEYS;
    if (!isset($KEYS[$domain])) {
        $priv = ec_pair()['priv'];
        $KEYS[$domain] = ['domain' => $domain, 'priv' => $priv, 'pub' => openssl_pkey_get_details(openssl_pkey_get_private($priv))['key']];
    }
    return $KEYS[$domain];
}
function new_db(): PDO
{
    return ledger_open(tempnam(sys_get_temp_dir(), 'ledger-sigformat-') . '.sqlite');
}
// A single authority coin. $v2Genesis signs the genesis and entry 0 in format 2.
function world(string $domain, bool $v2 = false, ?string $coinId = null, ?array $treasury = null): array
{
    global $NOW;
    $db = new_db();
    $dom = dom_key($domain);
    if ($v2) sigformat_record_activation($db, $domain, $NOW);
    $treasury ??= owner();
    $genesis = ledger_genesis(['coinId' => $coinId, 'symbol' => 'TST', 'name' => 'Test coin', 'decimals' => 2, 'maxUnits' => '2000000', 'initialUnits' => '1000000', 'treasuryKey' => $treasury['key'],
        'mode' => 'single', 'visibility' => 'public', 'roster' => [['domain' => $domain, 'key' => $dom['pub']]], 'createdAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 3600)]);
    ledger_register($db, $genesis, $treasury['key'], null);
    ledger_add_genesis_signature($db, $genesis['coinId'], $domain, ledger_genesis_sign($genesis, $dom['priv'], $domain, $v2));
    ledger_activate($db, $genesis['coinId'], $dom['priv'], $v2);
    return ['db' => $db, 'coin' => $genesis['coinId'], 'genesis' => $genesis, 'digest' => ledger_genesis_digest($genesis), 'dom' => $dom, 'treasury' => $treasury, 'treasuryKey' => $treasury['key']];
}
// What an operator's activation does: the domain records that it signs in format 2 from now on.
function activate(array $w): void
{
    global $NOW;
    sigformat_record_activation($w['db'], $w['dom']['domain'], $NOW);
}
function seq_of(array $w, array $from): int
{
    $row = ledger_account_row($w['db'], $w['coin'], $from['key']);
    return $row ? (int) $row['seq'] : 0;
}
function authorization(array $w, array $from, string $to, string $amount): array
{
    global $NOW;
    $payload = ['type' => 'atlas.ledger.transfer', 'v' => 2, 'coinId' => $w['coin'], 'from' => $from['key'], 'to' => $to, 'amount' => $amount, 'baseSeq' => seq_of($w, $from),
        'baseHead' => ledger_head($w['db'], $w['coin'])['hash'], 'nonce' => bin2hex(random_bytes(16)), 'issuedAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 10), 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW + 300),
        'authority' => $w['genesis']['authority'], 'genesis' => $w['digest']];
    return ['payload' => $payload, 'signature' => owner_sign($from, $payload)];
}
function prepare(array $w, array $from, string $to, string $amount): array
{
    global $NOW;
    return ledger_prepare_transfer($w['db'], $w['coin'], authorization($w, $from, $to, $amount), $NOW);
}
// Commits a prepared entry with the authority signature in $format: 'legacy', 'v2', or 'auto' for what the ledger itself would sign.
function commit(array $w, array $prepared, string $format = 'auto'): array
{
    global $NOW;
    $index = (int) $prepared['public']['index'];
    $sig = match ($format) {
        'legacy' => ledger_sign($w['dom']['priv'], $prepared['hash']),
        'v2' => sigformat_sign_entry($w['dom']['priv'], $w['coin'], $index, $prepared['hash'], $w['dom']['domain']),
        default => ledger_sign_entry($w['db'], $w['coin'], $w['dom']['priv'], $index, $prepared['hash']),
    };
    return ledger_commit($w['db'], $w['coin'], $prepared, $sig, [], $NOW);
}
function send(array $w, array $from, string $to, string $amount, string $format = 'auto'): array
{
    return commit($w, prepare($w, $from, $to, $amount), $format);
}
function kinds(array $w): array
{
    $out = [];
    $rows = $w['db']->query("SELECT idx FROM ledger_log WHERE coin_id='" . $w['coin'] . "' ORDER BY idx")->fetchAll(PDO::FETCH_COLUMN);
    foreach ($rows as $i) $out[] = ledger_stored_kind($w['db'], $w['genesis'], $w['coin'], (int) $i);
    return $out;
}
// Another domain's copy of the same coin, opened the way a partner does: from entry 0 as the authority wrote it.
function mirror_of(array $w): PDO
{
    $db = new_db();
    ledger_register($db, $w['genesis'], $w['treasuryKey'], null);
    $zero = ledger_records_after($w['db'], $w['coin'], -1, 1)[0];
    ledger_mirror_genesis($db, $w['coin'], $zero);
    return $db;
}
function replay(PDO $db, array $w, int $after = 0): void
{
    foreach (ledger_records_after($w['db'], $w['coin'], $after, 500) as $record) ledger_mirror_apply($db, $w['coin'], $record);
}
function set_sig(array $w, int $index, string $signature): void
{
    $w['db']->prepare('UPDATE ledger_log SET authority_sig=? WHERE coin_id=? AND idx=?')->execute([$signature, $w['coin'], $index]);
}

$alice = owner();
$bob = owner();

echo "\n== format 2 messages are typed and name coin, position and signer\n";
$digest = hash('sha256', 'a');
$hash = hash('sha256', 'b');
$g = json_decode(sigformat_genesis_bytes('coin1', $digest, 'a.example'), true);
$e = json_decode(sigformat_entry_bytes('coin1', 3, $hash, 'a.example'), true);
t($g === ['coinId' => 'coin1', 'digest' => $digest, 'domain' => 'a.example', 'type' => 'atlas.ledger.genesis.signature', 'v' => 1], 'the genesis message is typed canonical JSON with the coin, the digest and the signer', $g);
t($e === ['coinId' => 'coin1', 'domain' => 'a.example', 'hash' => $hash, 'index' => 3, 'type' => 'atlas.ledger.entry.authority', 'v' => 1], 'the authority message is typed canonical JSON with the coin, the index, the hash and the signer', $e);
t(sigformat_genesis_bytes('coin1', $digest, 'a.example') !== sigformat_entry_bytes('coin1', 0, $digest, 'a.example'), 'a genesis message and an entry message over the same hex string differ');
t(strlen(sigformat_genesis_bytes('coin1', $digest, 'a.example')) !== 64 && sigformat_genesis_bytes('coin1', $digest, 'a.example')[0] === '{', 'no typed message can be a bare 64-character hex string');

echo "\n== a signature made for one purpose or place is not valid for another\n";
$d = dom_key('a.example');
$other = dom_key('b.example');
$sg = sigformat_sign_genesis($d['priv'], 'coin1', $digest, 'a.example');
$se = sigformat_sign_entry($d['priv'], 'coin1', 0, $digest, 'a.example');
t(sigformat_genesis_kind($d['pub'], 'coin1', $digest, 'a.example', $sg) === SIGFORMAT_V2, 'a genesis signature in format 2 reads as format 2');
t(sigformat_entry_kind($d['pub'], 'coin1', 0, $digest, 'a.example', $se) === SIGFORMAT_V2, 'an authority signature in format 2 reads as format 2');
t(sigformat_entry_kind($d['pub'], 'coin1', 0, $digest, 'a.example', $sg) === null, 'a genesis signature is not an authority signature for an entry whose hash is that digest');
t(sigformat_genesis_kind($d['pub'], 'coin1', $digest, 'a.example', $se) === null, 'and an authority signature is not a genesis signature for a genesis with that digest');
t(sigformat_genesis_kind($d['pub'], 'coin2', $digest, 'a.example', $sg) === null, 'a genesis signature does not carry to another coin id');
t(sigformat_genesis_kind($d['pub'], 'coin1', $digest, 'b.example', $sg) === null, 'nor to another signer name');
t(sigformat_entry_kind($d['pub'], 'coin1', 1, $digest, 'a.example', $se) === null, 'an authority signature does not carry to another index');
t(sigformat_entry_kind($d['pub'], 'coin2', 0, $digest, 'a.example', $se) === null, 'nor to another coin');
t(sigformat_entry_kind($d['pub'], 'coin1', 0, $digest, 'b.example', $se) === null, 'nor to another signer name');
t(sigformat_entry_kind($other['pub'], 'coin1', 0, $digest, 'a.example', $se) === null, 'a signature of another key does not verify');
$bare = ledger_sign($d['priv'], $digest);
t(sigformat_entry_kind($d['pub'], 'coin1', 0, $digest, 'a.example', $bare) === SIGFORMAT_LEGACY && sigformat_genesis_kind($d['pub'], 'coin1', $digest, 'a.example', $bare) === SIGFORMAT_LEGACY, 'the bare signature reads as format 1');
t(sigformat_entry_kind($d['pub'], 'coin1', 0, 'not a hash', 'a.example', $bare) === null, 'format 1 is read only for a 64-character lowercase hex string');
t(sigformat_entry_kind($d['pub'], 'coin1', 0, strtoupper($digest), 'a.example', ledger_sign($d['priv'], strtoupper($digest))) === null, 'not for the same digits in capitals');
t(sigformat_entry_kind($d['pub'], 'coin1', 0, $digest, 'a.example', null) === null && sigformat_entry_kind($d['pub'], 'coin1', 0, $digest, 'a.example', 'x') === null, 'a missing or malformed signature verifies in neither format');
t(sigformat_entry_allowed(SIGFORMAT_V2, SIGFORMAT_V2) && sigformat_entry_allowed(SIGFORMAT_V2, SIGFORMAT_LEGACY) && sigformat_entry_allowed(SIGFORMAT_LEGACY, SIGFORMAT_LEGACY) && sigformat_entry_allowed(SIGFORMAT_LEGACY, null), 'the ratchet allows format 2 anywhere and format 1 until the first format 2');
t(!sigformat_entry_allowed(SIGFORMAT_LEGACY, SIGFORMAT_V2) && !sigformat_entry_allowed(null, null), 'and refuses format 1 after format 2, and anything that verified in neither');

echo "\n== a coin signed entirely in format 1 still opens, runs and checks\n";
$a = world('a.example');
t(ledger_stored_kind($a['db'], $a['genesis'], $a['coin'], 0) === SIGFORMAT_LEGACY, 'entry 0 is signed in format 1 by default');
send($a, $a['treasury'], $alice['key'], '500', 'legacy');
send($a, $a['treasury'], $bob['key'], '100', 'legacy');
t(kinds($a) === [SIGFORMAT_LEGACY, SIGFORMAT_LEGACY, SIGFORMAT_LEGACY], 'every entry is signed in format 1');
t(ledger_check($a['db'], $a['coin']) === [], 'the checker passes it', ledger_check($a['db'], $a['coin']));
$auto = ledger_sign_entry($a['db'], $a['coin'], $a['dom']['priv'], 3, $hash);
t(ledger_verify($a['dom']['pub'], $hash, $auto), 'a domain that has not activated format 2 signs the next entry in format 1');

echo "\n== the first format 2 signature moves the coin on, and format 1 is refused after it\n";
activate($a);
send($a, $a['treasury'], $alice['key'], '1', 'v2');
t(kinds($a) === [SIGFORMAT_LEGACY, SIGFORMAT_LEGACY, SIGFORMAT_LEGACY, SIGFORMAT_V2], 'history may hold format 1 entries followed by a format 2 entry');
t(ledger_check($a['db'], $a['coin']) === [], 'the checker passes a coin of mixed history', ledger_check($a['db'], $a['coin']));
$next = prepare($a, $a['treasury'], $alice['key'], '2');
t(refuses(fn() => commit($a, $next, 'legacy'), 'signature-downgrade'), 'a format 1 signature on the next entry is refused as a downgrade', why(fn() => commit($a, $next, 'legacy')));
t(ledger_head($a['db'], $a['coin'])['index'] === 3, 'and nothing was written');
t(ledger_signs_v2($a['db'], $a['genesis'], $a['coin'], 4), 'the ledger now signs this coin in format 2 by itself');
send($a, $a['treasury'], $alice['key'], '2');
t(kinds($a)[4] === SIGFORMAT_V2, 'the next entry is signed in format 2 without asking');
t(refuses(fn() => commit($a, prepare($a, $a['treasury'], $alice['key'], '3'), 'legacy'), 'signature-downgrade'), 'a format 1 signature is still refused further on');
t(refuses(fn() => ledger_commit($a['db'], $a['coin'], prepare($a, $a['treasury'], $alice['key'], '3'), ledger_sign($a['dom']['priv'], $hash), [], $NOW), 'bad-authority-signature'), 'a signature over some other hash verifies in neither format');
$wrongIndex = prepare($a, $a['treasury'], $alice['key'], '3');
t(refuses(fn() => ledger_commit($a['db'], $a['coin'], $wrongIndex, sigformat_sign_entry($a['dom']['priv'], $a['coin'], 9, $wrongIndex['hash'], 'a.example'), [], $NOW), 'bad-authority-signature'), 'a format 2 signature for another index is refused');
t(refuses(fn() => ledger_commit($a['db'], $a['coin'], $wrongIndex, sigformat_sign_entry($a['dom']['priv'], $a['coin'], 5, $wrongIndex['hash'], 'b.example'), [], $NOW), 'bad-authority-signature'), 'and one that names another signer');

echo "\n== the checker finds a downgrade and a genesis in the wrong format\n";
$c = world('a.example');
send($c, $c['treasury'], $alice['key'], '10', 'legacy');
activate($c);
send($c, $c['treasury'], $alice['key'], '10', 'v2');
send($c, $c['treasury'], $alice['key'], '10');
t(ledger_check($c['db'], $c['coin']) === [], 'a mixed coin checks');
$h2 = $c['db']->query("SELECT hash FROM ledger_log WHERE coin_id='" . $c['coin'] . "' AND idx=3")->fetchColumn();
$good = $c['db']->query("SELECT authority_sig FROM ledger_log WHERE coin_id='" . $c['coin'] . "' AND idx=3")->fetchColumn();
set_sig($c, 3, ledger_sign($c['dom']['priv'], $h2));
$problems = ledger_check($c['db'], $c['coin']);
t(count($problems) === 1 && str_contains($problems[0], 'entry 3') && str_contains($problems[0], 'older format'), 'a format 1 signature after a format 2 one is reported', $problems);
set_sig($c, 3, $good);
t(ledger_check($c['db'], $c['coin']) === [], 'put back, it checks again');
set_sig($c, 3, 'AAAA');
$problems = ledger_check($c['db'], $c['coin']);
t(count($problems) === 1 && str_contains($problems[0], 'authority signature does not verify'), 'a signature in neither format is reported', $problems);
set_sig($c, 3, $good);

$v = world('a.example', true);
t(ledger_stored_kind($v['db'], $v['genesis'], $v['coin'], 0) === SIGFORMAT_V2 && ledger_check($v['db'], $v['coin']) === [], 'a coin opened in format 2 has a format 2 entry 0 and checks', ledger_check($v['db'], $v['coin']));
$zeroSigs = json_decode((string) $v['db']->query("SELECT approvals_json FROM ledger_log WHERE coin_id='" . $v['coin'] . "' AND idx=0")->fetchColumn(), true);
$v['db']->prepare('UPDATE ledger_log SET approvals_json=? WHERE coin_id=? AND idx=0')->execute([ledger_canonical([['domain' => 'a.example', 'signature' => ledger_sign($v['dom']['priv'], $v['digest'])]]), $v['coin']]);
$problems = ledger_check($v['db'], $v['coin']);
t(count($problems) === 1 && str_contains($problems[0], 'older format'), 'a format 1 genesis signature under a format 2 entry 0 is reported', $problems);
$v['db']->prepare('UPDATE ledger_log SET approvals_json=? WHERE coin_id=? AND idx=0')->execute([ledger_canonical($zeroSigs), $v['coin']]);
t(ledger_check($v['db'], $v['coin']) === [], 'put back, it checks again');

echo "\n== opening a coin: genesis signatures and entry 0\n";
$g1 = world('a.example');
t(ledger_check($g1['db'], $g1['coin']) === [], 'a coin opened in format 1 with format 1 genesis signatures checks (a coin from before)');
$treasury = owner();
$dom = dom_key('a.example');
$genesis = ledger_genesis(['symbol' => 'MIX', 'name' => 'Mix coin', 'decimals' => 2, 'maxUnits' => '2000000', 'initialUnits' => '1000', 'treasuryKey' => $treasury['key'], 'mode' => 'single', 'visibility' => 'public',
    'roster' => [['domain' => 'a.example', 'key' => $dom['pub']]], 'createdAt' => gmdate('Y-m-d\TH:i:s\Z', $NOW - 3600)]);
$db = new_db();
ledger_register($db, $genesis, $treasury['key'], null);
ledger_add_genesis_signature($db, $genesis['coinId'], 'a.example', ledger_genesis_sign($genesis, $dom['priv']));
t(refuses(fn() => ledger_activate($db, $genesis['coinId'], $dom['priv'], true), 'genesis-legacy-signature'), 'a format 2 entry 0 over a format 1 genesis signature is refused', why(fn() => ledger_activate($db, $genesis['coinId'], $dom['priv'], true)));
t(ledger_coin($db, $genesis['coinId'])['state'] === 'pending', 'and the coin stays pending');
ledger_add_genesis_signature($db, $genesis['coinId'], 'a.example', ledger_genesis_sign($genesis, $dom['priv'], 'a.example', true));
ledger_activate($db, $genesis['coinId'], $dom['priv'], true);
t(ledger_stored_kind($db, $genesis, $genesis['coinId'], 0) === SIGFORMAT_V2 && ledger_check($db, $genesis['coinId']) === [], 'signed again in format 2, it opens in format 2 and checks');
$db2 = new_db();
ledger_register($db2, $genesis, $treasury['key'], null);
t(refuses(fn() => ledger_add_genesis_signature($db2, $genesis['coinId'], 'a.example', sigformat_sign_entry($dom['priv'], $genesis['coinId'], 0, ledger_genesis_digest($genesis), 'a.example')), 'bad-signature'), 'an entry signature is not accepted as a genesis signature');
t(refuses(fn() => ledger_add_genesis_signature($db2, $genesis['coinId'], 'a.example', sigformat_sign_genesis($dom['priv'], 'other-coin', ledger_genesis_digest($genesis), 'a.example')), 'bad-signature'), 'nor a genesis signature for another coin');
ledger_add_genesis_signature($db2, $genesis['coinId'], 'a.example', ledger_genesis_sign($genesis, $dom['priv'], 'a.example', true));
ledger_add_genesis_signature($db2, $genesis['coinId'], 'a.example', ledger_genesis_sign($genesis, $dom['priv']));
t(true, 'a pending coin takes a signature in either format while it is not yet open');
t(refuses(fn() => ledger_genesis_sign($genesis, $dom['priv'], null, true), 'bad-genesis'), 'a format 2 genesis signature cannot be made without the signer name');

echo "\n== a partner's copy takes history in both formats and holds the ratchet\n";
$m = world('a.example');
send($m, $m['treasury'], $alice['key'], '40', 'legacy');
send($m, $m['treasury'], $alice['key'], '41', 'legacy');
$copy = mirror_of($m);
replay($copy, $m);
t((int) $copy->query("SELECT COUNT(*) FROM ledger_log WHERE coin_id='" . $m['coin'] . "'")->fetchColumn() === 3 && ledger_check($copy, $m['coin']) === [], 'a copy replays a coin of format 1 entries and checks it');
activate($m);
send($m, $m['treasury'], $alice['key'], '42', 'v2');
send($m, $m['treasury'], $alice['key'], '43');
replay($copy, $m, 2);
t((int) $copy->query("SELECT COUNT(*) FROM ledger_log WHERE coin_id='" . $m['coin'] . "'")->fetchColumn() === 5 && ledger_check($copy, $m['coin']) === [], 'then takes the format 2 entries that follow', ledger_check($copy, $m['coin']));
$forged = ledger_records_after($m['db'], $m['coin'], 4, 1);
$next = prepare($m, $m['treasury'], $alice['key'], '44');
$record = ['index' => 5, 'public' => $next['public'], 'private' => $next['private'], 'hash' => $next['hash'], 'authoritySignature' => ledger_sign($m['dom']['priv'], $next['hash']), 'approvals' => []];
t(refuses(fn() => ledger_mirror_apply($copy, $m['coin'], $record), 'signature-downgrade'), 'a copy refuses an entry in format 1 after format 2, as history too', why(fn() => ledger_mirror_apply($copy, $m['coin'], $record)));
$record['authoritySignature'] = sigformat_sign_entry($m['dom']['priv'], $m['coin'], 5, $next['hash'], 'a.example');
ledger_mirror_apply($copy, $m['coin'], $record);
t(ledger_head($copy, $m['coin'])['index'] === 5, 'the same entry in format 2 is taken');

$mv = world('a.example', true);
$mvCopy = mirror_of($mv);
t(ledger_stored_kind($mvCopy, $mv['genesis'], $mv['coin'], 0) === SIGFORMAT_V2, 'a copy takes a format 2 entry 0 with its format 2 genesis signatures');
$zero = ledger_records_after($mv['db'], $mv['coin'], -1, 1)[0];
$mixed = new_db();
ledger_register($mixed, $mv['genesis'], $mv['treasuryKey'], null);
$zero['approvals'] = [['domain' => 'a.example', 'signature' => ledger_sign($mv['dom']['priv'], $mv['digest'])]];
t(refuses(fn() => ledger_mirror_genesis($mixed, $mv['coin'], $zero), 'genesis-legacy-signature'), 'a copy refuses a format 2 entry 0 that carries a format 1 genesis signature', why(fn() => ledger_mirror_genesis($mixed, $mv['coin'], $zero)));
$zero2 = ledger_records_after($m['db'], $m['coin'], -1, 1)[0];
$old = new_db();
ledger_register($old, $m['genesis'], $m['treasuryKey'], null);
ledger_mirror_genesis($old, $m['coin'], $zero2);
t(ledger_stored_kind($old, $m['genesis'], $m['coin'], 0) === SIGFORMAT_LEGACY, 'while a format 1 entry 0 with format 1 genesis signatures is still taken, as a coin from before');
$zero3 = ledger_records_after($m['db'], $m['coin'], -1, 1)[0];
$zero3['authoritySignature'] = 'AAAA';
$none = new_db();
ledger_register($none, $m['genesis'], $m['treasuryKey'], null);
t(refuses(fn() => ledger_mirror_genesis($none, $m['coin'], $zero3), 'bad-authority-signature'), 'an entry 0 with a bad authority signature is refused');

echo "\n== a receipt is checked in the format it carries, and does not step around the ratchet\n";
$r = world('a.example');
send($r, $r['treasury'], $alice['key'], '5', 'legacy');
activate($r);
send($r, $r['treasury'], $alice['key'], '6', 'v2');
send($r, $r['treasury'], $alice['key'], '7');
$r1 = spend_receipt($r['db'], $r['coin'], 1);
$r2 = spend_receipt($r['db'], $r['coin'], 2);
$r3 = spend_receipt($r['db'], $r['coin'], 3);
$pub = $r['dom']['pub'];
t(spend_verify_receipt($r1, $pub), 'an old receipt in format 1 verifies as it did');
t(spend_verify_receipt($r1, $pub, null, 'a.example') && spend_verify_receipt($r1, $pub, null, 'a.example', 2), 'and with the signer named, while it is before the first format 2 entry');
t(!spend_verify_receipt($r1, $pub, null, 'a.example', 1), 'it is refused once the receiver knows format 2 began at or before its index');
t(spend_verify_receipt($r2, $pub, null, 'a.example') && spend_verify_receipt($r3, $pub, $r2['hash'], 'a.example', 2), 'a receipt in format 2 verifies with the signer named, and extends the one before it');
t(!spend_verify_receipt($r2, $pub), 'a format 2 receipt is not accepted without the signer name');
t(!spend_verify_receipt($r2, $pub, null, 'b.example'), 'nor with another signer name');
$moved = $r2;
$moved['entry']['index'] = 9;
$moved['hash'] = ledger_digest($moved['entry']);
t(!spend_verify_receipt($moved, $pub, null, 'a.example'), 'a format 2 signature moved onto an entry at another index does not verify');
$swapped = $r3;
$swapped['authoritySignature'] = $r2['authoritySignature'];
t(!spend_verify_receipt($swapped, $pub, null, 'a.example'), 'the signature of another entry does not verify');
$downgraded = $r3;
$downgraded['authoritySignature'] = ledger_sign($r['dom']['priv'], $r3['hash']);
t(spend_verify_receipt($downgraded, $pub, null, 'a.example') && !spend_verify_receipt($downgraded, $pub, null, 'a.example', 3), 'a format 1 signature on a later entry passes alone, and is refused once the receiver pinned where format 2 began');

echo "\n== evidence accepts either format\n";
$coinRow = ledger_coin($r['db'], $r['coin']);
$mk = fn(int $i) => ['public' => json_decode((string) $r['db']->query("SELECT public_json FROM ledger_log WHERE coin_id='" . $r['coin'] . "' AND idx=" . $i)->fetchColumn(), true),
    'hash' => $r['db']->query("SELECT hash FROM ledger_log WHERE coin_id='" . $r['coin'] . "' AND idx=" . $i)->fetchColumn(),
    'authoritySignature' => $r['db']->query("SELECT authority_sig FROM ledger_log WHERE coin_id='" . $r['coin'] . "' AND idx=" . $i)->fetchColumn()];
t(peer_check_entry($coinRow, $mk(1))[0] === 1 && peer_check_entry($coinRow, $mk(2))[0] === 2, 'an entry signed in format 1 and one signed in format 2 both check as evidence');
$bad = $mk(2);
$bad['authoritySignature'] = $mk(1)['authoritySignature'];
t(refuses(fn() => peer_check_entry($coinRow, $bad), 'bad-evidence'), 'another entry\'s signature does not');

echo "\n== a database restored from older state replays a mixed history in order\n";
$h = world('a.example');
send($h, $h['treasury'], $alice['key'], '1', 'legacy');
send($h, $h['treasury'], $alice['key'], '2', 'legacy');
activate($h);
send($h, $h['treasury'], $alice['key'], '3', 'v2');
send($h, $h['treasury'], $alice['key'], '4');
$restored = mirror_of($h);
replay($restored, $h);
t(ledger_check($restored, $h['coin']) === [] && ledger_head($restored, $h['coin'])['hash'] === ledger_head($h['db'], $h['coin'])['hash'], 'a copy rebuilt from the whole history reaches the same head and checks', ledger_check($restored, $h['coin']));
$partial = mirror_of($h);
$records = ledger_records_after($h['db'], $h['coin'], 0, 500);
ledger_mirror_apply($partial, $h['coin'], $records[0]);
ledger_mirror_apply($partial, $h['coin'], $records[1]);
$out = $records[3];
t(refuses(fn() => ledger_mirror_apply($partial, $h['coin'], $out), 'wrong-index'), 'an entry out of order is refused, so the ratchet is always read against the entry just before');
ledger_mirror_apply($partial, $h['coin'], $records[2]);
ledger_mirror_apply($partial, $h['coin'], $records[3]);
t(kinds(['db' => $partial, 'coin' => $h['coin'], 'genesis' => $h['genesis']]) === [SIGFORMAT_LEGACY, SIGFORMAT_LEGACY, SIGFORMAT_LEGACY, SIGFORMAT_V2, SIGFORMAT_V2], 'and in order the copy holds the same mixed history');

echo "\n";
if ($failures === 0) echo "ALL $total CHAIN-LABS SIGNATURE FORMAT CHECKS PASSED\n";
else { echo "$failures of $total checks FAILED\n"; exit(1); }
