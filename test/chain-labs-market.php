<?php
declare(strict_types=1);
// The market figures of the chain labs (chain-labs/lib/market.php) on throw-away SQLite files:
//   - ratios are exact integers rounded half up, and never invent digits
//   - the 24 hour volume counts entries that carry a purchase reference and nothing else, stops at the window, and says when
//     it only saw the most recent entries
//   - what a page accepts from a domain: the authority's own statement, in shapes it can show, with a price only under an
//     available offer
//   - a coin is attached to its registry entry only by the domain that issued it
//
//   php test/chain-labs-market.php
require __DIR__ . '/../chain-labs/lib/market.php';

$failures = 0;
$total = 0;
function t(bool $ok, string $text, mixed $detail = null): void
{
    global $failures, $total;
    $total++;
    if (!$ok) $failures++;
    echo ($ok ? 'PASS ' : 'FAIL ') . $text . (!$ok && $detail !== null ? ' :: ' . substr(is_string($detail) ? $detail : json_encode($detail), 0, 300) : '') . "\n";
}

echo "== ratios\n";
t(market_ratio(1000000, 1000000, 6) === '1', 'one coin at one million units per Au costs 1');
t(market_ratio(1000000, 3, 6) === '333333.333333', 'a third is rounded to six places');
t(market_ratio(2, 3, 2) === '0.67', 'half up: 2/3 is 0.67');
t(market_ratio(1, 8, 2) === '0.13' && market_ratio(1, 16, 2) === '0.06', 'and 0.125 rounds up, 0.0625 down');
t(market_ratio(999999, 1000000, 2) === '1', 'carry into the whole part');
t(market_ratio(0, 5, 2) === '0', 'zero is 0');
t(market_ratio(1000000000000, 1, 6) === '1000000000000', 'the largest supply at a rate of one does not overflow');
t(market_ratio(1000000000000, 3, 6) === '333333333333.333333', 'nor at six places');
$threw = false;
try { market_ratio(1, 0, 2); } catch (InvalidArgumentException $e) { $threw = true; }
t($threw, 'a rate of zero is refused');

echo "\n== volume\n";
function fresh(int $entries, callable $make): PDO
{
    $db = new PDO('sqlite::memory:');
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    ledger_schema($db);
    $q = $db->prepare('INSERT INTO ledger_log(coin_id,idx,hash,prev_hash,public_json,private_json,authority_sig,approvals_json) VALUES(?,?,?,?,?,?,?,?)');
    for ($i = 0; $i < $entries; $i++) $q->execute([str_repeat('a', 32), $i, 'h' . $i, 'p', json_encode($make($i)), '{}', 's', '[]']);
    return $db;
}
$now = 1800000000;
$coin = str_repeat('a', 32);
$iso = fn(int $t) => gmdate('Y-m-d\TH:i:s\Z', $t);
$grant = fn(int $i, int $at) => ['type' => 'transfer', 'index' => $i, 'amount' => '500', 'executedAt' => $iso($at)];
$sale = fn(int $i, int $at, int $price, string $amount) => ['type' => 'transfer', 'index' => $i, 'amount' => $amount, 'executedAt' => $iso($at), 'purchase' => ['price' => $price, 'requestId' => str_repeat('b', 32)]];

$db = fresh(6, fn($i) => match ($i) {
    0 => ['type' => 'genesis', 'index' => 0, 'executedAt' => $iso($now - 90000)],
    1 => $sale(1, $now - 87000, 99, '990'),
    2 => $grant(2, $now - 3600 * 3),
    3 => $sale(3, $now - 3600 * 2, 20, '200'),
    4 => $grant(4, $now - 600),
    default => $sale(5, $now - 60, 5, '50'),
});
$v = market_volume($db, $coin, $now);
t($v['gold'] === 25 && $v['units'] === 250 && $v['purchases'] === 2 && $v['complete'] === true, 'two sales in the window count 25 Au; grants, the genesis and a sale 24 hours ago do not', $v);
$v = market_volume($db, $coin, $now + 3600 * 23);
t($v['purchases'] === 1 && $v['gold'] === 5 && $v['complete'] === true, 'the window moves with the clock: 23 hours later only the newest sale is inside it', $v);
$none = fresh(2, fn($i) => $i === 0 ? ['type' => 'genesis', 'index' => 0, 'executedAt' => $iso($now - 1000)] : $grant(1, $now - 10));
$v = market_volume($none, $coin, $now);
t($v['gold'] === 0 && $v['purchases'] === 0 && $v['complete'] === true, 'a log with no sale has a volume of 0 that is complete', $v);
$bad = fresh(4, fn($i) => match ($i) {
    0 => ['type' => 'genesis', 'index' => 0, 'executedAt' => $iso($now - 1000)],
    1 => ['type' => 'transfer', 'index' => 1, 'amount' => '10', 'executedAt' => $iso($now - 500), 'purchase' => ['price' => '5', 'requestId' => 'x']],
    2 => ['type' => 'transfer', 'index' => 2, 'amount' => '-10', 'executedAt' => $iso($now - 400), 'purchase' => ['price' => 5, 'requestId' => 'x']],
    default => ['type' => 'transfer', 'index' => 3, 'amount' => '10', 'executedAt' => 'garbage', 'purchase' => ['price' => 5, 'requestId' => 'x']],
});
$v = market_volume($bad, $coin, $now);
t($v['purchases'] === 0 && $v['gold'] === 0, 'a purchase reference with a price that is not a whole number, an amount that is not units, or no readable time counts for nothing', $v);

$many = fresh(MARKET_SCAN_MAX + 100, fn($i) => $i === 0 ? ['type' => 'genesis', 'index' => 0, 'executedAt' => $iso($now - 100000)] : $sale($i, $now - 1000, 1, '10'));
$v = market_volume($many, $coin, $now);
t($v['purchases'] === MARKET_SCAN_MAX && $v['gold'] === MARKET_SCAN_MAX && $v['complete'] === false, 'with more sales in the window than the scan reads, the figure is the most recent ones and says it is not complete', $v);
$exact = fresh(MARKET_SCAN_MAX, fn($i) => $i === 0 ? ['type' => 'genesis', 'index' => 0, 'executedAt' => $iso($now - 100000)] : $sale($i, $now - 1000, 1, '10'));
$v = market_volume($exact, $coin, $now);
t($v['purchases'] === MARKET_SCAN_MAX - 1 && $v['complete'] === true, 'a log that is exactly as long as the scan, down to its genesis, is complete', $v);
$cut = fresh(MARKET_SCAN_MAX + 100, fn($i) => $i < 101 ? ['type' => 'genesis', 'index' => $i, 'executedAt' => $iso($now - 100000)] : $sale($i, $now - 1000, 1, '10'));
$v = market_volume($cut, $coin, $now);
t($v['purchases'] === MARKET_SCAN_MAX - 1 && $v['complete'] === true, 'a long log whose window ends inside the scan is complete: it stops at the first entry older than the window', $v);

echo "\n== what a page accepts\n";
$id = str_repeat('c', 32);
$good = ['coinId' => $id, 'authority' => 'a.example', 'state' => 'active', 'mode' => 'multi', 'issuedUnits' => '10000000000', 'treasuryUnits' => '9000000000', 'circulatingUnits' => '1000000000',
    'offer' => ['available' => true, 'unavailableBecause' => null, 'smallestUnits' => '1000000', 'minPrice' => 1, 'unitsPerPrice' => 1000000],
    'price' => ['gold' => '1'], 'marketCap' => ['gold' => '1000'], 'volume24h' => ['gold' => '20', 'units' => '20000000', 'purchases' => 1, 'complete' => true]];
$c = market_clean($good, 'a.example');
t($c && $c['price']['gold'] === '1' && $c['marketCap']['gold'] === '1000' && $c['volume24h']['purchases'] === 1 && $c['offer']['available'] === true, 'an authority\'s statement in the right shapes is kept', $c);
t(market_clean($good, 'b.example') === null, 'the same statement from a domain that is not the authority is refused');
t(market_clean(array_merge($good, ['state' => 'pending']), 'a.example') === null && market_clean(array_merge($good, ['coinId' => 'x']), 'a.example') === null, 'a coin that is not active or frozen, or has no real id, is refused');
t(market_clean(array_merge($good, ['issuedUnits' => '1e9']), 'a.example') === null && market_clean(array_merge($good, ['issuedUnits' => '10000000000000']), 'a.example') === null, 'an issued supply that is not whole units, or is above the limit, is refused');
$c = market_clean(array_merge($good, ['price' => ['gold' => '1; drop']]), 'a.example');
t($c['price'] === null && $c['marketCap'] === null && $c['offer']['available'] === false, 'a price that is not a number removes the price, the market cap and the availability');
$c = market_clean(array_merge($good, ['marketCap' => ['gold' => 'lots']]), 'a.example');
t($c['price']['gold'] === '1' && $c['marketCap'] === null, 'a market cap that is not a number is dropped alone');
$unavailable = array_merge($good, ['offer' => ['available' => false, 'unavailableBecause' => 'the treasury holds less than the smallest purchase', 'smallestUnits' => '1000000', 'minPrice' => 1, 'unitsPerPrice' => 1000000]]);
$c = market_clean($unavailable, 'a.example');
t($c['price'] === null && $c['marketCap'] === null && $c['offer']['available'] === false, 'a price stated next to an offer that is not available is not shown');
$c = market_clean(array_merge($good, ['offer' => null]), 'a.example');
t($c['price'] === null && $c['marketCap'] === null && $c['offer'] === null, 'a price stated with no offer at all is not shown');
$c = market_clean(array_merge($good, ['volume24h' => ['gold' => '-1', 'units' => '1', 'purchases' => 1, 'complete' => true]]), 'a.example');
t($c['volume24h'] === null, 'a volume that is negative is dropped');
$c = market_clean(array_merge($good, ['offer' => array_merge($good['offer'], ['unavailableBecause' => str_repeat('x', 500)])]), 'a.example');
t(strlen($c['offer']['unavailableBecause']) <= 80, 'text from a domain is cut to a short length');

echo "\n== attaching to the registry\n";
$reg = [['id' => $id, 'domain' => 'a.example'], ['id' => str_repeat('d', 32), 'domain' => 'a.example'], ['id' => str_repeat('e', 32), 'domain' => 'b.example']];
$byId = [$id => market_clean($good, 'a.example'), str_repeat('e', 32) => market_clean(array_merge($good, ['coinId' => str_repeat('e', 32)]), 'a.example')];
[$out, $stated] = market_attach($reg, $byId);
t($stated === 1 && $out[0]['market'] !== null && $out[1]['market'] === null && $out[2]['market'] === null, 'a coin gets figures only from its issuing domain; one the ledger does not know has none', array_map(fn($x) => $x['market'] !== null, $out));

echo "\n== direct request\n";
t((bool) preg_match('/PHP_SAPI !== .cli. && isset\(\$_SERVER\[.SCRIPT_FILENAME.\]\) && realpath/', file_get_contents(__DIR__ . '/../chain-labs/lib/market.php')), 'lib/market.php refuses a direct request');

echo "\n" . ($failures === 0 ? "ALL $total CHAIN-LABS MARKET CHECKS PASSED" : "$failures of $total checks FAILED") . "\n";
exit($failures === 0 ? 0 : 1);
